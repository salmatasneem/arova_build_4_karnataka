import crypto from "node:crypto";
import express from "express";
import {
  buildPolicyConfigFromAlertLevels,
  classifyAnalysisWithAlertLevelsPolicy,
} from "./alertLevelConfig.ts";
import { extractEcgFeatures } from "./ecgProcessor.ts";
import {
  requireAuthenticatedFirebaseUser,
  verifyFirebaseIdToken,
  type AuthenticatedRequest,
} from "./firebaseAuth.ts";
import { analyzeTelemetry } from "./mlClient.ts";
import { sharedNotificationEngine } from "./notificationEngine.ts";
import { resolvePublicBaseUrl } from "./outboundVoice.ts";
import { recordServerAuditEvent } from "./rbacRoutes.ts";
import { sharedVoiceEscalationEngine } from "./voiceEscalationEngine.ts";
import type { EcgFeatures, EcgSignalQuality, MovementStatus, TelemetryPayload } from "./types.ts";

export interface EcgSegmentRecord {
  segmentId: string;
  deviceId: string;
  patientId: string;
  samples: number[];
  samplingRate: number;
  signalQuality: EcgSignalQuality;
  leadOff: boolean;
  timestamp: string;
  features: EcgFeatures;
  source: "esp32_hardware" | "simulator";
}

export interface SensorAvailabilityMap {
  pulseOximeter: boolean;
  temperature: boolean;
  imu: boolean;
  ecg: boolean;
  oled: boolean;
  vibrationMotor: boolean;
}

export interface DeviceVibrationCommand {
  commandId: string;
  deviceId: string;
  action: "activate" | "deactivate";
  pattern: "none" | "single_pulse" | "triple_alert";
  durationMs: number;
  reason: string;
  issuedAt: string;
  issuedByUid: string;
}

export interface RegisteredWearableDevice {
  deviceId: string;
  label: string;
  patientId: string;
  ownerUid: string;
  boardType: string;
  pulseOxChipVariant: string;
  ecgSensor: string;
  imuSensor: string;
  tempSensor: string;
  displayModule: string;
  hapticModule: string;
  firmwareVersion: string;
  samplingIntervalMs: number;
  connectionStatus: "not_connected" | "streaming" | "offline";
  lastSeenAt: string | null;
  lastDataSource: "esp32_hardware" | "simulator" | "none";
  sensorAvailability: SensorAvailabilityMap;
  maskedToken: string | null;
  tokenProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

interface InternalDeviceRecord extends RegisteredWearableDevice {
  tokenHash: string | null;
  pendingCommand: DeviceVibrationCommand | null;
}

export interface LiveHardwareSnapshot {
  deviceId: string;
  patientId: string;
  pulseOxVariant: string;
  tempSensorModel: string;
  ecgSensorModel: string;
  firmwareVersion: string;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  gyroX: number | null;
  gyroY: number | null;
  gyroZ: number | null;
  movementStatus: MovementStatus;
  possibleFallDetected: boolean;
  irSignalOk: boolean;
  fingerDetected: boolean;
  ecgSamples: number[];
  ecgSamplingRate: number;
  ecgSignalQuality: EcgSignalQuality;
  ecgLeadOff: boolean;
  ecgTimestamp: string | null;
  ecgFeatures: EcgFeatures;
  signalQuality: string;
  sensorAvailability: SensorAvailabilityMap;
  anomalyScore: number;
  alertLevel: string;
  mlEngine: string;
  explanation: string;
  batteryPct: number | null;
  oledActive: boolean;
  hapticPattern: "none" | "single_pulse" | "triple_alert";
  vibrationCommand: DeviceVibrationCommand | null;
  receivedAt: string;
  timestamp: string;
  source: "esp32_hardware" | "simulator";
}

const latestHardwareByPatient = new Map<string, LiveHardwareSnapshot>();
const ecgHistoryByPatient = new Map<string, EcgSegmentRecord[]>();
const recentHardwareEvents: LiveHardwareSnapshot[] = [];
const recentIngestKeys = new Set<string>();
const registeredDevices = new Map<string, InternalDeviceRecord>();

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function maskDeviceToken(rawToken: string): string {
  const clean = rawToken.trim();
  if (clean.length <= 8) return "••••";
  return `${clean.slice(0, 6)}••••${clean.slice(-4)}`;
}

function toPublicDevice(record: InternalDeviceRecord): RegisteredWearableDevice {
  const { tokenHash: _hash, pendingCommand: _cmd, ...pub } = record;
  return pub;
}

function trackIngestTimestampKey(patientId: string, deviceId: string, timestamp: unknown): boolean {
  if (typeof timestamp !== "string" || !timestamp.trim()) return true;
  const key = `${patientId}::${deviceId}::${timestamp.trim()}`;
  if (recentIngestKeys.has(key)) return false;
  recentIngestKeys.add(key);
  if (recentIngestKeys.size > 500) {
    const first = recentIngestKeys.values().next().value;
    if (first) recentIngestKeys.delete(first);
  }
  return true;
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const VALID_MOVEMENTS = new Set<MovementStatus>([
  "resting",
  "walking",
  "active",
  "fall_suspect",
  "inactive",
]);

const VALID_ECG_QUALITIES = new Set<EcgSignalQuality>([
  "good",
  "noisy",
  "lead_off",
  "unavailable",
]);

function extractDeviceKeyFromRequest(req: express.Request): string {
  const xKey = req.header("X-Device-Key") || req.header("x-device-key");
  if (typeof xKey === "string" && xKey.trim()) return xKey.trim();
  const authHeader = req.header("authorization") || req.header("Authorization");
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

function verifyDeviceCredential(providedKey: string, device?: InternalDeviceRecord): boolean {
  const globalToken = process.env.WEARABLE_INGEST_TOKEN?.trim();
  if (globalToken && providedKey && timingSafeCompare(providedKey, globalToken)) {
    return true;
  }
  if (device?.tokenHash && providedKey) {
    return timingSafeCompare(hashToken(providedKey), device.tokenHash);
  }
  return false;
}

export function clearWearableStoreForTests(): void {
  latestHardwareByPatient.clear();
  ecgHistoryByPatient.clear();
  recentHardwareEvents.length = 0;
  recentIngestKeys.clear();
  registeredDevices.clear();
}

export function createWearableRouter(): express.Router {
  const router = express.Router();

  router.get("/config", (_req, res) => {
    const tokenConfigured = Boolean(process.env.WEARABLE_INGEST_TOKEN?.trim());
    res.json({
      ingestEndpoint: "/api/wearable/ingest",
      deviceAuthRequired: tokenConfigured,
      perDeviceRegistrationSupported: true,
      developmentModeNote: tokenConfigured
        ? "WEARABLE_INGEST_TOKEN is configured on the server; hardware POSTs require the X-Device-Key header or a registered per-device token."
        : "WEARABLE_INGEST_TOKEN is not set (development mode). Registering a device generates an optional per-device X-Device-Key token, while simulator packets work immediately.",
      tokenSetupSteps: [
        "Register your ESP32 device in AROVA Device Management to receive a per-device X-Device-Key (or set WEARABLE_INGEST_TOKEN in Settings > Secrets).",
        "Copy Wi-Fi credentials and DEVICE_KEY into /firmware/arova_secrets.h (never commit secrets).",
        "Flash /firmware/arova_wearable_esp32.ino (or /firmware/esp32_smartcare_template.ino) to your ESP32 DevKit.",
      ],
      supportedHardware: {
        mcu: "ESP32 DevKit (Wi-Fi JSON HTTP/HTTPS POST)",
        pulseOximeter: "MAX30102 / MAX30100 Pulse Oximeter (Heart Rate & Est. SpO2)",
        ecg: "AD8232 Provisional ECG (ESP32 ADC1 + LO+/LO- Lead-Off, Batched Waveforms)",
        imu: "MPU6050 6-axis Accelerometer & Gyroscope (Triaxial X/Y/Z + Experimental Fall Indicator)",
        temperature: "Configurable Temperature Sensor (DS18B20 / TMP117 / MLX90614)",
        display: "0.96-inch SSD1306 I2C OLED (128x64)",
        haptic: "Vibration Motor via NPN Transistor/MOSFET Driver + Flyback Diode",
        power: "Rechargeable LiPo/Li-ion Battery + TP4056 / Protection & 3.3V Regulation",
      },
    });
  });

  // --- Phase 3: Authenticated Device Registry, Connection State & Vibration Alert Commands ---
  router.get("/devices", requireAuthenticatedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const patientIdFilter =
      typeof req.query.patientId === "string" ? req.query.patientId.trim() : "";

    const list = Array.from(registeredDevices.values())
      .filter((dev) => user.isAdmin || dev.ownerUid === user.uid)
      .filter((dev) => !patientIdFilter || dev.patientId === patientIdFilter)
      .map(toPublicDevice);

    res.json({ devices: list });
  });

  router.post(
    "/devices/register",
    requireAuthenticatedFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      const user = req.firebaseUser!;
      const body = req.body as Record<string, unknown>;
      const rawDeviceId =
        typeof body?.deviceId === "string"
          ? body.deviceId.trim()
          : typeof body?.device_id === "string"
          ? body.device_id.trim()
          : "";
      const rawPatientId =
        typeof body?.patientId === "string"
          ? body.patientId.trim()
          : typeof body?.patient_id === "string"
          ? body.patient_id.trim()
          : "";

      if (!rawDeviceId || !VALID_ID_REGEX.test(rawDeviceId)) {
        res.status(400).json({
          error: "Valid deviceId (1..128 alphanumeric, underscore, or hyphen characters) is required.",
        });
        return;
      }
      if (!rawPatientId || !VALID_ID_REGEX.test(rawPatientId)) {
        res.status(400).json({
          error: "Valid patientId (1..128 alphanumeric, underscore, or hyphen characters) is required.",
        });
        return;
      }

      const existing = registeredDevices.get(rawDeviceId);
      if (existing && !user.isAdmin && existing.ownerUid !== user.uid) {
        res.status(403).json({
          error: "Forbidden: this deviceId is already registered to another AROVA user.",
        });
        return;
      }

      const rotateToken = body?.rotateToken === true || !existing?.tokenHash;
      let plainDeviceKey: string | null = null;
      let nextTokenHash = existing?.tokenHash ?? null;
      let nextMaskedToken = existing?.maskedToken ?? null;

      if (rotateToken && body?.requireDeviceToken !== false) {
        plainDeviceKey = `arova_dev_${crypto.randomBytes(20).toString("hex")}`;
        nextTokenHash = hashToken(plainDeviceKey);
        nextMaskedToken = maskDeviceToken(plainDeviceKey);
      }

      const nowIso = new Date().toISOString();
      const rawInterval = Number(body?.samplingIntervalMs);
      const samplingIntervalMs =
        Number.isFinite(rawInterval) && rawInterval >= 250 && rawInterval <= 60000
          ? Math.round(rawInterval)
          : existing?.samplingIntervalMs ?? 2000;

      const ownerUid =
        user.isAdmin && typeof body?.ownerUid === "string" && VALID_ID_REGEX.test(body.ownerUid.trim())
          ? body.ownerUid.trim()
          : existing?.ownerUid ?? user.uid;

      const record: InternalDeviceRecord = {
        deviceId: rawDeviceId,
        label:
          typeof body?.label === "string" && body.label.trim()
            ? body.label.trim().slice(0, 100)
            : existing?.label ?? "AROVA ESP32 Wearable",
        patientId: rawPatientId,
        ownerUid,
        boardType:
          typeof body?.boardType === "string" && body.boardType.trim()
            ? body.boardType.trim().slice(0, 60)
            : existing?.boardType ?? "ESP32 DevKit v1 (Wi-Fi)",
        pulseOxChipVariant:
          typeof body?.pulseOxChipVariant === "string" && body.pulseOxChipVariant.trim()
            ? body.pulseOxChipVariant.trim().slice(0, 60)
            : existing?.pulseOxChipVariant ?? "MAX30102 / MAX30100",
        ecgSensor:
          typeof body?.ecgSensor === "string" && body.ecgSensor.trim()
            ? body.ecgSensor.trim().slice(0, 60)
            : existing?.ecgSensor ?? "AD8232 Provisional ECG",
        imuSensor:
          typeof body?.imuSensor === "string" && body.imuSensor.trim()
            ? body.imuSensor.trim().slice(0, 60)
            : existing?.imuSensor ?? "MPU6050 6-Axis IMU",
        tempSensor:
          typeof body?.tempSensor === "string" && body.tempSensor.trim()
            ? body.tempSensor.trim().slice(0, 60)
            : existing?.tempSensor ?? "Configurable Temperature Sensor",
        displayModule:
          typeof body?.displayModule === "string" && body.displayModule.trim()
            ? body.displayModule.trim().slice(0, 60)
            : existing?.displayModule ?? "0.96-inch SSD1306 I2C OLED (128x64)",
        hapticModule:
          typeof body?.hapticModule === "string" && body.hapticModule.trim()
            ? body.hapticModule.trim().slice(0, 60)
            : existing?.hapticModule ?? "Vibration Motor (Transistor/MOSFET Driver)",
        firmwareVersion:
          typeof body?.firmwareVersion === "string" && body.firmwareVersion.trim()
            ? body.firmwareVersion.trim().slice(0, 40)
            : existing?.firmwareVersion ?? "arova-esp32-v3.0",
        samplingIntervalMs,
        connectionStatus: existing?.connectionStatus ?? "not_connected",
        lastSeenAt: existing?.lastSeenAt ?? null,
        lastDataSource: existing?.lastDataSource ?? "none",
        sensorAvailability: existing?.sensorAvailability ?? {
          pulseOximeter: false,
          temperature: false,
          imu: false,
          ecg: false,
          oled: true,
          vibrationMotor: true,
        },
        maskedToken: nextMaskedToken,
        tokenProtected: Boolean(nextTokenHash || process.env.WEARABLE_INGEST_TOKEN?.trim()),
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
        tokenHash: nextTokenHash,
        pendingCommand: existing?.pendingCommand ?? null,
      };

      registeredDevices.set(rawDeviceId, record);

      recordServerAuditEvent({
        userId: user.uid,
        actorRole: user.isAdmin ? "admin" : "patient",
        eventType: existing ? "device_updated" : "device_registered",
        summary: `${existing ? "Updated" : "Registered"} ESP32 wearable ${rawDeviceId} for patient ${rawPatientId}.`,
        targetId: rawDeviceId,
      });

      res.status(existing ? 200 : 201).json({
        ok: true,
        device: toPublicDevice(record),
        ...(plainDeviceKey ? { deviceApiKey: plainDeviceKey } : {}),
      });
    }
  );

  router.post(
    "/devices/:deviceId/status",
    requireAuthenticatedFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      const user = req.firebaseUser!;
      const deviceId = req.params.deviceId?.trim() ?? "";
      const existing = registeredDevices.get(deviceId);
      if (!existing) {
        res.status(404).json({ error: `Device '${deviceId}' is not registered on the backend.` });
        return;
      }
      if (!user.isAdmin && existing.ownerUid !== user.uid) {
        res.status(403).json({ error: "Forbidden: unauthorized to modify this device." });
        return;
      }

      const body = req.body as { connectionStatus?: unknown };
      const status = body?.connectionStatus;
      if (status !== "not_connected" && status !== "streaming" && status !== "offline") {
        res.status(400).json({
          error: "connectionStatus must be 'not_connected', 'streaming', or 'offline'.",
        });
        return;
      }

      existing.connectionStatus = status;
      existing.updatedAt = new Date().toISOString();

      recordServerAuditEvent({
        userId: user.uid,
        actorRole: user.isAdmin ? "admin" : "patient",
        eventType: "device_connection_changed",
        summary: `Device ${deviceId} connectionStatus changed to ${status}.`,
        targetId: deviceId,
      });

      res.json({ ok: true, device: toPublicDevice(existing) });
    }
  );

  router.post(
    "/devices/:deviceId/command",
    requireAuthenticatedFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      const user = req.firebaseUser!;
      const deviceId = req.params.deviceId?.trim() ?? "";
      const existing = registeredDevices.get(deviceId);

      if (existing && !user.isAdmin && existing.ownerUid !== user.uid) {
        res.status(403).json({ error: "Forbidden: unauthorized to send haptic commands to this device." });
        return;
      }

      const body = req.body as {
        action?: unknown;
        pattern?: unknown;
        durationMs?: unknown;
        reason?: unknown;
      };
      const action = body?.action === "deactivate" ? "deactivate" : "activate";
      const rawPattern = typeof body?.pattern === "string" ? body.pattern : "single_pulse";
      const pattern: DeviceVibrationCommand["pattern"] =
        action === "deactivate"
          ? "none"
          : rawPattern === "triple_alert"
          ? "triple_alert"
          : rawPattern === "none"
          ? "none"
          : "single_pulse";
      const rawDur = Number(body?.durationMs);
      const durationMs =
        action === "deactivate"
          ? 0
          : Number.isFinite(rawDur) && rawDur >= 100 && rawDur <= 5000
          ? Math.round(rawDur)
          : pattern === "triple_alert"
          ? 940
          : 250;
      const reason =
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 160)
          : action === "deactivate"
          ? "Manual haptic deactivation"
          : "Manual wearable alert vibration test";

      const command: DeviceVibrationCommand = {
        commandId: `cmd_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        deviceId,
        action,
        pattern,
        durationMs,
        reason,
        issuedAt: new Date().toISOString(),
        issuedByUid: user.uid,
      };

      if (existing) {
        existing.pendingCommand = command;
        existing.updatedAt = command.issuedAt;
      }

      recordServerAuditEvent({
        userId: user.uid,
        actorRole: user.isAdmin ? "admin" : "patient",
        eventType: "device_haptic_command",
        summary: `Queued ${action} (${pattern}, ${durationMs}ms) command for ${deviceId}.`,
        targetId: deviceId,
      });

      res.status(201).json({ ok: true, command });
    }
  );

  router.get("/commands", async (req, res) => {
    const deviceId =
      typeof req.query.deviceId === "string"
        ? req.query.deviceId.trim()
        : typeof req.query.device_id === "string"
        ? req.query.device_id.trim()
        : "";
    if (!deviceId) {
      res.status(400).json({ error: "deviceId query parameter is required." });
      return;
    }

    const device = registeredDevices.get(deviceId);
    const providedKey = extractDeviceKeyFromRequest(req);
    let authorized = verifyDeviceCredential(providedKey, device);

    if (!authorized && providedKey) {
      const fbUser = await verifyFirebaseIdToken(providedKey).catch(() => null);
      if (fbUser && (!device || fbUser.isAdmin || device.ownerUid === fbUser.uid)) {
        authorized = true;
      }
    }

    if (!authorized) {
      res.status(401).json({ error: "Valid X-Device-Key or Firebase Bearer token required." });
      return;
    }

    const command = device?.pendingCommand ?? null;
    if (device && command) {
      device.pendingCommand = null;
    }

    res.json({
      ok: true,
      deviceId,
      command,
    });
  });

  router.get("/latest", (req, res) => {
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId.trim() : "";
    if (patientId) {
      res.json({
        snapshot: latestHardwareByPatient.get(patientId) ?? null,
        ecgHistory: ecgHistoryByPatient.get(patientId) ?? [],
      });
      return;
    }
    res.json({
      events: recentHardwareEvents.slice(0, 20),
    });
  });

  router.post("/ingest", async (req, res) => {
    try {
      const configuredToken = process.env.WEARABLE_INGEST_TOKEN?.trim();
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Normalize source (accept Phase 2 & Phase 3 aliases cleanly)
      const rawSource = typeof body?.source === "string" ? body.source.trim().toLowerCase() : "";
      const isSimulator = rawSource === "simulator" || rawSource === "simulated";

      const deviceId =
        typeof body?.deviceId === "string" && body.deviceId.trim()
          ? body.deviceId.trim().slice(0, 128)
          : typeof body?.device_id === "string" && body.device_id.trim()
          ? body.device_id.trim().slice(0, 128)
          : "";

      if (!deviceId) {
        res.status(400).json({ error: "deviceId (or device_id) is required." });
        return;
      }

      const registered = registeredDevices.get(deviceId);

      // Resolve patientId from payload or registered device ownership record
      const rawPatientId =
        typeof body?.patientId === "string" && body.patientId.trim()
          ? body.patientId.trim().slice(0, 128)
          : typeof body?.patient_id === "string" && body.patient_id.trim()
          ? body.patient_id.trim().slice(0, 128)
          : registered?.patientId ?? "";

      if (!rawPatientId) {
        res.status(400).json({
          error: "patientId is required when deviceId is not yet registered to a patient.",
        });
        return;
      }
      const patientId = rawPatientId;

      // Enforce token auth for real hardware if global token or per-device token is configured
      const requiresHardwareAuth =
        !isSimulator && (Boolean(configuredToken) || Boolean(registered?.tokenHash));
      if (requiresHardwareAuth) {
        const providedKey = extractDeviceKeyFromRequest(req);
        if (!providedKey || !verifyDeviceCredential(providedKey, registered)) {
          res.status(401).json({
            error: "Invalid or missing X-Device-Key / device Bearer token for hardware ingestion.",
          });
          return;
        }
      }

      if (!trackIngestTimestampKey(patientId, deviceId, body?.timestamp)) {
        res.status(409).json({
          error: "Duplicate telemetry packet timestamp detected for this patientId and deviceId.",
        });
        return;
      }

      const rawSensorQuality =
        typeof body?.sensor_quality === "string"
          ? body.sensor_quality.trim().toLowerCase()
          : typeof body?.sensorQuality === "string"
          ? body.sensorQuality.trim().toLowerCase()
          : "";
      const explicitPoorSensor =
        rawSensorQuality === "poor_contact" ||
        rawSensorQuality === "unavailable" ||
        rawSensorQuality === "invalid" ||
        rawSensorQuality === "error";

      const irSignalOk = body?.irSignalOk !== false && !explicitPoorSensor;
      const fingerDetected = body?.fingerDetected !== false && !explicitPoorSensor;
      const opticalInvalidAllowed = !fingerDetected || !irSignalOk;

      const rawHrInput = body?.heartRate !== undefined ? body.heartRate : body?.heart_rate_bpm;
      let heartRate: number | null = null;
      if (rawHrInput !== null && rawHrInput !== undefined) {
        const parsedHr = Number(rawHrInput);
        if (!Number.isFinite(parsedHr)) {
          res.status(400).json({ error: "heartRate / heart_rate_bpm must be a valid number or null." });
          return;
        }
        if (parsedHr === 0 && opticalInvalidAllowed) {
          heartRate = null;
        } else if (parsedHr < 20 || parsedHr > 260) {
          if (opticalInvalidAllowed) {
            heartRate = null;
          } else {
            res.status(400).json({
              error: "heartRate / heart_rate_bpm must be between 20 and 260 BPM when fingerDetected is true.",
            });
            return;
          }
        } else {
          heartRate = parsedHr;
        }
      }

      const rawSpo2Input = body?.spo2 !== undefined ? body.spo2 : body?.spo2_percent;
      let spo2: number | null = null;
      if (rawSpo2Input !== null && rawSpo2Input !== undefined) {
        const parsedSpo2 = Number(rawSpo2Input);
        if (!Number.isFinite(parsedSpo2)) {
          res.status(400).json({ error: "spo2 / spo2_percent must be a valid number or null." });
          return;
        }
        if (parsedSpo2 === 0 && opticalInvalidAllowed) {
          spo2 = null;
        } else if (parsedSpo2 < 40 || parsedSpo2 > 100) {
          if (opticalInvalidAllowed) {
            spo2 = null;
          } else {
            res.status(400).json({
              error: "spo2 / spo2_percent must be between 40 and 100% when fingerDetected is true.",
            });
            return;
          }
        } else {
          spo2 = parsedSpo2;
        }
      }

      const rawTempInput =
        body?.temperatureC !== undefined ? body.temperatureC : body?.temperature_c;
      let temperatureC: number | null = null;
      if (rawTempInput !== null && rawTempInput !== undefined) {
        const parsedTemp = Number(rawTempInput);
        if (!Number.isFinite(parsedTemp)) {
          res.status(400).json({ error: "temperatureC / temperature_c must be a valid number or null." });
          return;
        }
        // Treat common unattached DS18B20 sentinel (-127) cleanly if ever passed, otherwise enforce 20..45 C
        if (parsedTemp <= -100) {
          temperatureC = null;
        } else if (parsedTemp < 20 || parsedTemp > 45) {
          res.status(400).json({
            error: "temperatureC / temperature_c must be between 20 and 45 °C (or null when unconfirmed).",
          });
          return;
        } else {
          temperatureC = parsedTemp;
        }
      }

      const optNum = (val: unknown): number | undefined => {
        if (val === null || val === undefined) return undefined;
        const n = Number(val);
        return Number.isFinite(n) ? n : undefined;
      };

      const accelX = optNum(body?.accelX !== undefined ? body.accelX : body?.accel_x);
      const accelY = optNum(body?.accelY !== undefined ? body.accelY : body?.accel_y);
      const accelZ = optNum(body?.accelZ !== undefined ? body.accelZ : body?.accel_z);
      const gyroX = optNum(body?.gyroX !== undefined ? body.gyroX : body?.gyro_x);
      const gyroY = optNum(body?.gyroY !== undefined ? body.gyroY : body?.gyro_y);
      const gyroZ = optNum(body?.gyroZ !== undefined ? body.gyroZ : body?.gyro_z);

      const computedAccelMag =
        accelX !== undefined && accelY !== undefined && accelZ !== undefined
          ? Number(Math.sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ).toFixed(3))
          : 1.0;
      const accelMagnitude =
        body?.accelMagnitude !== undefined && Number.isFinite(Number(body.accelMagnitude))
          ? Number(body.accelMagnitude)
          : computedAccelMag;

      const computedGyroMag =
        gyroX !== undefined && gyroY !== undefined && gyroZ !== undefined
          ? Number(Math.sqrt(gyroX * gyroX + gyroY * gyroY + gyroZ * gyroZ).toFixed(2))
          : 4.0;
      const gyroMagnitude =
        body?.gyroMagnitude !== undefined && Number.isFinite(Number(body.gyroMagnitude))
          ? Number(body.gyroMagnitude)
          : computedGyroMag;

      const rawMovement = typeof body?.movementStatus === "string" ? body.movementStatus : "";
      const movementStatus: MovementStatus = VALID_MOVEMENTS.has(rawMovement as MovementStatus)
        ? (rawMovement as MovementStatus)
        : accelMagnitude >= 2.8
        ? "fall_suspect"
        : Math.abs(accelMagnitude - 1.0) > 0.35 || gyroMagnitude > 75
        ? "active"
        : Math.abs(accelMagnitude - 1.0) > 0.12 || gyroMagnitude > 20
        ? "walking"
        : "resting";

      const possibleFallDetected =
        body?.possibleFallDetected === true ||
        movementStatus === "fall_suspect" ||
        (Number.isFinite(accelMagnitude) && accelMagnitude >= 2.8);

      // Parse batched AD8232 ECG fields safely without fabricating missing samples
      const rawEcgSamples = Array.isArray(body?.ecgSamples) ? body.ecgSamples : [];
      const ecgSamples: number[] = [];
      for (let i = 0; i < Math.min(rawEcgSamples.length, 250); i++) {
        const v = Number(rawEcgSamples[i]);
        if (Number.isFinite(v) && v >= -3300 && v <= 4095) {
          ecgSamples.push(Number(v.toFixed(2)));
        }
      }

      const rawEcgRate = body?.ecgSamplingRate !== undefined ? Number(body.ecgSamplingRate) : 200;
      const ecgSamplingRate =
        Number.isFinite(rawEcgRate) && rawEcgRate >= 25 && rawEcgRate <= 1000
          ? Math.round(rawEcgRate)
          : 200;
      const ecgLeadOff = body?.ecgLeadOff === true;
      const rawEcgQuality = typeof body?.ecgSignalQuality === "string" ? body.ecgSignalQuality : undefined;
      const reportedEcgQuality: EcgSignalQuality | undefined =
        rawEcgQuality && VALID_ECG_QUALITIES.has(rawEcgQuality as EcgSignalQuality)
          ? (rawEcgQuality as EcgSignalQuality)
          : undefined;
      const ecgTimestamp =
        typeof body?.ecgTimestamp === "string" && body.ecgTimestamp.trim()
          ? body.ecgTimestamp.trim().slice(0, 60)
          : ecgSamples.length > 0 || body?.ecgLeadOff !== undefined
          ? new Date().toISOString()
          : null;

      const ecgFeatures = extractEcgFeatures({
        samples: ecgSamples,
        samplingRateHz: ecgSamplingRate,
        leadOff: ecgLeadOff,
        reportedQuality: reportedEcgQuality,
      });

      const rawBaseline = body?.baselineMeans as Record<string, unknown> | undefined;
      const baselineMeans =
        rawBaseline &&
        typeof rawBaseline.heartRate === "number" &&
        typeof rawBaseline.spo2 === "number" &&
        typeof rawBaseline.temperatureC === "number"
          ? {
              heartRate: rawBaseline.heartRate,
              spo2: rawBaseline.spo2,
              temperatureC: rawBaseline.temperatureC,
            }
          : undefined;

      const packetTimestamp =
        typeof body?.timestamp === "string" && body.timestamp.trim()
          ? body.timestamp.trim().slice(0, 60)
          : new Date().toISOString();

      const rawPolicy = body?.policyConfig as Record<string, unknown> | undefined;
      const telemetry: TelemetryPayload = {
        patientId,
        deviceId,
        timestamp: packetTimestamp,
        heartRate,
        spo2,
        temperatureC,
        movementStatus,
        accelMagnitude: Number.isFinite(accelMagnitude) ? accelMagnitude : 1.0,
        gyroMagnitude: Number.isFinite(gyroMagnitude) ? gyroMagnitude : 4.0,
        possibleFallDetected,
        irSignalOk,
        fingerDetected,
        ecgSamples,
        ecgSamplingRate,
        ecgSignalQuality: ecgFeatures.signalQuality,
        ecgLeadOff,
        ecgTimestamp: ecgTimestamp ?? undefined,
        ecgFeatures,
        source: isSimulator ? "simulator" : "esp32_hardware",
        baselineMeans,
        baselineTrained: typeof body?.baselineTrained === "boolean" ? body.baselineTrained : undefined,
        accelX,
        accelY,
        accelZ,
        gyroX,
        gyroY,
        gyroZ,
        imuSamplingRate: optNum(body?.imuSamplingRate),
        respiratoryRateBpm: optNum(body?.respiratoryRateBpm),
        policyConfig: rawPolicy
          ? {
              baselineMinSamples:
                typeof rawPolicy.baselineMinSamples === "number"
                  ? rawPolicy.baselineMinSamples
                  : undefined,
              warningPersistenceWindows:
                typeof rawPolicy.warningPersistenceWindows === "number"
                  ? rawPolicy.warningPersistenceWindows
                  : undefined,
              criticalPersistenceWindows:
                typeof rawPolicy.criticalPersistenceWindows === "number"
                  ? rawPolicy.criticalPersistenceWindows
                  : undefined,
              anomalyScoreWarningThreshold:
                typeof rawPolicy.anomalyScoreWarningThreshold === "number"
                  ? rawPolicy.anomalyScoreWarningThreshold
                  : undefined,
              anomalyScoreCriticalThreshold:
                typeof rawPolicy.anomalyScoreCriticalThreshold === "number"
                  ? rawPolicy.anomalyScoreCriticalThreshold
                  : undefined,
              zScoreWarningThreshold:
                typeof rawPolicy.zScoreWarningThreshold === "number"
                  ? rawPolicy.zScoreWarningThreshold
                  : undefined,
              zScoreCriticalThreshold:
                typeof rawPolicy.zScoreCriticalThreshold === "number"
                  ? rawPolicy.zScoreCriticalThreshold
                  : undefined,
            }
          : buildPolicyConfigFromAlertLevels(sharedVoiceEscalationEngine.getAlertLevelsPolicy()),
      };

      const analysis = await analyzeTelemetry(telemetry);
      const alertClassification = classifyAnalysisWithAlertLevelsPolicy(
        analysis,
        sharedVoiceEscalationEngine.getAlertLevelsPolicy()
      );
      const publicBaseUrl = resolvePublicBaseUrl(req) ?? undefined;
      const escalationEval = await sharedVoiceEscalationEngine
        .evaluateAnalysisEvent({
          telemetry,
          analysis,
          patientName:
            typeof body?.patientName === "string" && body.patientName.trim()
              ? body.patientName.trim().slice(0, 100)
              : undefined,
          patientOwnerUid:
            typeof body?.patientOwnerUid === "string" && body.patientOwnerUid.trim()
              ? body.patientOwnerUid.trim().slice(0, 128)
              : registered?.ownerUid,
          publicBaseUrlOverride: publicBaseUrl,
        })
        .catch(() => ({ severity: null, escalation: null, duplicateSuppressed: false }));

      const phase5Eval = await sharedNotificationEngine
        .processTelemetryEvaluation({
          telemetry,
          analysis,
          patientName:
            typeof body?.patientName === "string" && body.patientName.trim()
              ? body.patientName.trim().slice(0, 100)
              : undefined,
          patientOwnerUid:
            typeof body?.patientOwnerUid === "string" && body.patientOwnerUid.trim()
              ? body.patientOwnerUid.trim().slice(0, 128)
              : registered?.ownerUid,
          primaryCaregiverUid:
            typeof body?.primaryCaregiverUid === "string" && body.primaryCaregiverUid.trim()
              ? body.primaryCaregiverUid.trim().slice(0, 128)
              : undefined,
          secondaryCaregiverUid:
            typeof body?.secondaryCaregiverUid === "string" && body.secondaryCaregiverUid.trim()
              ? body.secondaryCaregiverUid.trim().slice(0, 128)
              : undefined,
          publicBaseUrlOverride: publicBaseUrl,
        })
        .catch(() => ({
          monitoringState: analysis.alertLevel,
          alertCreated: false,
          duplicateSuppressed: false,
          suppressedAlertId: undefined,
          alert: null,
          notifications: [],
        }));

      const hapticPattern: LiveHardwareSnapshot["hapticPattern"] =
        alertClassification.escalationPlan?.hapticPattern ??
        (analysis.alertLevel === "Critical"
          ? "triple_alert"
          : analysis.alertLevel === "Warning"
          ? "single_pulse"
          : "none");

      const receivedAt = new Date().toISOString();
      const source: "esp32_hardware" | "simulator" = isSimulator ? "simulator" : "esp32_hardware";

      const rawAvail =
        body?.sensorAvailability && typeof body.sensorAvailability === "object"
          ? (body.sensorAvailability as Record<string, unknown>)
          : null;
      const sensorAvailability: SensorAvailabilityMap = {
        pulseOximeter:
          typeof rawAvail?.pulseOximeter === "boolean"
            ? rawAvail.pulseOximeter
            : heartRate !== null || spo2 !== null || (irSignalOk && fingerDetected),
        temperature:
          typeof rawAvail?.temperature === "boolean"
            ? rawAvail.temperature
            : temperatureC !== null,
        imu:
          typeof rawAvail?.imu === "boolean"
            ? rawAvail.imu
            : accelX !== undefined || body?.accelMagnitude !== undefined,
        ecg:
          typeof rawAvail?.ecg === "boolean"
            ? rawAvail.ecg
            : ecgSamples.length > 0 && !ecgLeadOff,
        oled: typeof rawAvail?.oled === "boolean" ? rawAvail.oled : body?.oledActive !== false,
        vibrationMotor:
          typeof rawAvail?.vibrationMotor === "boolean" ? rawAvail.vibrationMotor : true,
      };

      // Consume queued manual vibration command if any, otherwise issue alert-driven command when non-none
      let deliveredCommand: DeviceVibrationCommand | null = null;
      if (registered?.pendingCommand) {
        deliveredCommand = registered.pendingCommand;
        registered.pendingCommand = null;
      } else if (hapticPattern !== "none") {
        deliveredCommand = {
          commandId: `cmd_alert_${Date.now()}`,
          deviceId,
          action: "activate",
          pattern: hapticPattern,
          durationMs: hapticPattern === "triple_alert" ? 940 : 250,
          reason: `Automatic ${analysis.alertLevel} wearable haptic alert`,
          issuedAt: receivedAt,
          issuedByUid: "arova_alert_engine",
        };
      }

      const firmwareVersion =
        typeof body?.firmwareVersion === "string" && body.firmwareVersion.trim()
          ? body.firmwareVersion.trim().slice(0, 40)
          : registered?.firmwareVersion ?? "arova-esp32-v3.0";

      // Update registered device live state
      if (registered) {
        registered.connectionStatus = "streaming";
        registered.lastSeenAt = receivedAt;
        registered.lastDataSource = source;
        registered.sensorAvailability = sensorAvailability;
        registered.firmwareVersion = firmwareVersion;
        registered.updatedAt = receivedAt;
      }

      const normalizedSignalQuality =
        rawSensorQuality === "noisy" && analysis.signalQuality === "good"
          ? "noisy"
          : explicitPoorSensor
          ? "poor_contact"
          : analysis.signalQuality;

      const snapshot: LiveHardwareSnapshot = {
        deviceId,
        patientId,
        pulseOxVariant:
          typeof body?.pulseOxVariant === "string"
            ? body.pulseOxVariant.slice(0, 48)
            : registered?.pulseOxChipVariant ?? "MAX30102 / MAX30100",
        tempSensorModel:
          typeof body?.tempSensorModel === "string"
            ? body.tempSensorModel.slice(0, 48)
            : registered?.tempSensor ?? "Configurable Temperature Sensor",
        ecgSensorModel:
          typeof body?.ecgSensorModel === "string"
            ? body.ecgSensorModel.slice(0, 48)
            : registered?.ecgSensor ?? "AD8232 (Provisional ECG)",
        firmwareVersion,
        heartRate,
        spo2,
        temperatureC,
        accelMagnitude: telemetry.accelMagnitude,
        gyroMagnitude: telemetry.gyroMagnitude,
        accelX: accelX ?? null,
        accelY: accelY ?? null,
        accelZ: accelZ ?? null,
        gyroX: gyroX ?? null,
        gyroY: gyroY ?? null,
        gyroZ: gyroZ ?? null,
        movementStatus,
        possibleFallDetected,
        irSignalOk,
        fingerDetected,
        ecgSamples,
        ecgSamplingRate,
        ecgSignalQuality: ecgFeatures.signalQuality,
        ecgLeadOff,
        ecgTimestamp,
        ecgFeatures,
        signalQuality: normalizedSignalQuality,
        sensorAvailability,
        anomalyScore: analysis.anomalyScore,
        alertLevel: analysis.alertLevel,
        mlEngine: analysis.mlEngine,
        explanation: analysis.explanation,
        batteryPct:
          typeof body?.batteryPct === "number" && Number.isFinite(body.batteryPct)
            ? Math.max(0, Math.min(100, Math.round(body.batteryPct)))
            : null,
        oledActive: body?.oledActive !== false,
        hapticPattern,
        vibrationCommand: deliveredCommand,
        receivedAt,
        timestamp: packetTimestamp,
        source,
      };

      latestHardwareByPatient.set(patientId, snapshot);
      recentHardwareEvents.unshift(snapshot);
      if (recentHardwareEvents.length > 50) recentHardwareEvents.pop();

      if (ecgSamples.length > 0 || ecgLeadOff) {
        const segment: EcgSegmentRecord = {
          segmentId: `ecg_${Date.now()}`,
          deviceId,
          patientId,
          samples: ecgSamples,
          samplingRate: ecgSamplingRate,
          signalQuality: ecgFeatures.signalQuality,
          leadOff: ecgLeadOff,
          timestamp: ecgTimestamp ?? receivedAt,
          features: ecgFeatures,
          source,
        };
        const existingSegs = ecgHistoryByPatient.get(patientId) ?? [];
        ecgHistoryByPatient.set(patientId, [segment, ...existingSegs].slice(0, 12));
      }

      res.json({
        ok: true,
        ...snapshot,
        deviceCommand: deliveredCommand,
        triggeredMetrics: analysis.triggeredMetrics,
        mlServiceConnected: analysis.mlServiceConnected,
        modelTrained: analysis.modelTrained,
        modelVersion: analysis.modelVersion,
        ecgModelTrained: analysis.ecgModelTrained,
        anomalyStatus: analysis.anomalyStatus,
        contributingFeatures: analysis.contributingFeatures,
        contributingDetails: analysis.contributingDetails,
        plainLanguageExplanations: analysis.plainLanguageExplanations ?? [],
        baselineStats: analysis.baselineStats ?? null,
        modelMetadata: analysis.modelMetadata ?? null,
        isSimulated: analysis.isSimulated ?? (source !== "esp32_hardware"),
        sensorValues: analysis.sensorValues ?? {
          heartRate,
          spo2,
          temperatureC,
          accelMagnitude: telemetry.accelMagnitude,
          gyroMagnitude: telemetry.gyroMagnitude,
          movementStatus,
        },
        persistenceCount: analysis.persistenceCount,
        persistenceRequired: analysis.persistenceRequired,
        matchedBaselineContext: analysis.matchedBaselineContext,
        windowSize: analysis.windowSize,
        baselineProgress: analysis.baselineProgress,
        voiceEscalation: escalationEval.escalation
          ? {
              escalationId: escalationEval.escalation.escalationId,
              severity: escalationEval.severity,
              escalationStatus: escalationEval.escalation.escalationStatus,
              duplicateSuppressed: escalationEval.duplicateSuppressed,
            }
          : null,
        phase5Alert: phase5Eval.alert,
        duplicateAlertSuppressed: phase5Eval.duplicateSuppressed,
        suppressedAlertId: phase5Eval.suppressedAlertId ?? null,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to process wearable telemetry payload.",
      });
    }
  });

  return router;
}
