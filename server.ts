import "dotenv/config";
import http from "node:http";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNotificationProvidersStatus } from "./server/notificationProviders.ts";
import { createNotificationRouter } from "./server/notificationRoutes.ts";
import {
  buildPolicyConfigFromAlertLevels,
  getDefaultAlertLevelsPolicy,
} from "./server/alertLevelConfig.ts";
import { sharedBaselineTracker } from "./server/baselineTracker.ts";
import { sharedWindowStore } from "./server/featureExtractor.ts";
import {
  analyzeTelemetry,
  checkMlServiceHealth,
  evaluateMlModelRemote,
  fetchMlConfigRemote,
  fetchMlModelStatusRemote,
  fitPatientBaselineRemote,
  generateMlGraphsRemote,
  getPatientBaselineStatusSummary,
  listMlGraphsRemote,
  resetPatientMlRemote,
  resolveMlGraphFilePath,
  startManagedMlService,
  stopManagedMlService,
  updateMlConfigRemote,
} from "./server/mlClient.ts";
import {
  DatasetValidationError,
  getSupportedAdapterSpecs,
  isSupportedAdapterDatasetId,
  parseDatasetFile,
} from "./server/datasets/adapters/index.ts";
import { getDatasetCatalog, getDatasetCatalogEntry } from "./server/datasets/catalog.ts";
import { sharedPlaybackEngine } from "./server/datasets/playbackEngine.ts";
import { createWearableRouter } from "./server/esp32Ingest.ts";
import {
  advanceEscalationOutcome,
  getEscalationState,
  getVoiceProviderConfig,
  initiateCaregiverEscalation,
} from "./server/voiceClient.ts";
import {
  applyTwilioWebhookUpdate,
  buildOutboundAnswerTwimlXml,
  checkOutboundRateLimit,
  createStreamToken,
  getOutboundTwilioConfig,
  initiateTwilioOutboundCall,
  refreshOutboundCallRecord,
  registerCallStatusListener,
  resolvePublicBaseUrl,
  terminateTwilioOutboundCall,
  validateE164PhoneNumber,
  verifyTwilioSignature,
  type SupportedVoiceLanguage,
} from "./server/outboundVoice.ts";
import {
  attachTwilioMediaStreamServer,
  closeActiveVoiceBridge,
  registerCaregiverResponseListener,
} from "./server/geminiLiveBridge.ts";
import {
  getFirebaseServerSummary,
  requireAdminFirebaseUser,
  requireVerifiedFirebaseUser,
  type AuthenticatedRequest,
} from "./server/firebaseAuth.ts";
import { createRbacRouter } from "./server/rbacRoutes.ts";
import {
  sharedVoiceEscalationEngine,
  toPublicCaregiverContact,
  type CaregiverPriority,
} from "./server/voiceEscalationEngine.ts";
import type { TelemetryPayload, TelemetrySource } from "./server/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/datasets", express.json({ limit: "10mb" }));
  app.use("/api/voice/outbound", express.urlencoded({ extended: false }));
  app.use(express.json({ limit: "1mb" }));

  // Connect real-time Twilio webhook & Gemini Live classification streams to Escalation Engine
  registerCallStatusListener((record) => {
    void sharedVoiceEscalationEngine.handleOutboundCallStatusUpdate(record);
  });
  registerCaregiverResponseListener((callId, result, isFinal) => {
    void sharedVoiceEscalationEngine.handleCaregiverResponseUpdate(callId, result, isFinal);
  });

  // --- Integration & Health Endpoints ---
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/system/integrations", async (req, res) => {
    const mlHealth = await checkMlServiceHealth();
    const voiceConfig = getVoiceProviderConfig();
    const outboundTwilio = getOutboundTwilioConfig(req);
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
    );

    res.json({
      gemini: {
        configured: geminiConfigured,
        model: "gemini-4-hydrogen",
      },
      mlService: mlHealth,
      voiceCalling: {
        ...voiceConfig,
        configured: voiceConfig.configured || outboundTwilio.configured,
        providerName: outboundTwilio.configured
          ? "Twilio Programmable Voice + Gemini Live"
          : voiceConfig.providerName,
      },
      outboundTwilio: {
        configured: outboundTwilio.configured,
        missingEnvVars: outboundTwilio.missingEnvVars,
        publicBaseUrlConfigured: outboundTwilio.publicBaseUrlConfigured,
        statusMessage: outboundTwilio.configured
          ? "Twilio Programmable Voice is ready."
          : "Phone calling is not configured yet. You can still test the AI voice assistant in your browser.",
      },
      browserVoice: {
        configured: geminiConfigured,
        model: "gemini-3.8-live",
        streamPath: "/api/voice/browser/stream",
      },
      wearableIngest: {
        endpoint: "/api/wearable/ingest",
        tokenProtected: Boolean(process.env.WEARABLE_INGEST_TOKEN?.trim()),
      },
      notifications: getNotificationProvidersStatus(),
      firebase: getFirebaseServerSummary(),
    });
  });

  app.use("/api", createRbacRouter());
  app.use("/api", createNotificationRouter());

  app.get("/api/system/alert-levels", (_req, res) => {
    res.json({
      policy: sharedVoiceEscalationEngine.getAlertLevelsPolicy(),
      defaults: getDefaultAlertLevelsPolicy(),
    });
  });

  app.put("/api/system/alert-levels", requireAdminFirebaseUser, (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const policy = sharedVoiceEscalationEngine.updateAlertLevelsPolicy(req.body, user.uid);
      res.json({ ok: true, policy });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to update alert levels configuration.",
      });
    }
  });

  app.post("/api/system/alert-levels/reset", requireAdminFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const policy = sharedVoiceEscalationEngine.resetAlertLevelsPolicy(user.uid);
    res.json({ ok: true, policy });
  });

  // --- ESP32 Wearable Ingestion ---
  app.use("/api/wearable", createWearableRouter());

  // --- Verified Public Dataset Catalog (Read-Only Stage 1 Metadata) ---
  app.get("/api/datasets/catalog", (_req, res) => {
    res.json({
      stage: 1,
      integratedLocally: false,
      datasets: getDatasetCatalog(),
    });
  });

  app.get("/api/datasets/catalog/:id", (req, res) => {
    const entry = getDatasetCatalogEntry(req.params.id);
    if (!entry) {
      res.status(404).json({ error: `Dataset '${req.params.id}' was not found in the catalog.` });
      return;
    }
    res.json({ stage: 1, dataset: entry });
  });

  // --- Stage 2: Dataset File Import Adapters & Playback Engine ---
  app.get("/api/datasets/adapters", (_req, res) => {
    res.json({
      stage: 2,
      adapters: getSupportedAdapterSpecs(),
    });
  });

  app.post("/api/datasets/import", async (req, res) => {
    try {
      const body = req.body as {
        datasetId?: unknown;
        filename?: unknown;
        content?: unknown;
        participantId?: unknown;
        recordId?: unknown;
        windowMs?: unknown;
        autoLoadPlayback?: unknown;
        speed?: unknown;
        prefitBaselineCount?: unknown;
        minBaselineSamples?: unknown;
      };

      const rawDatasetId = typeof body?.datasetId === "string" ? body.datasetId.trim() : "";
      const filename = typeof body?.filename === "string" ? body.filename.trim() : "";
      const content = typeof body?.content === "string" ? body.content : "";

      if (!rawDatasetId) {
        res.status(400).json({ error: "datasetId is required." });
        return;
      }
      if (!isSupportedAdapterDatasetId(rawDatasetId)) {
        res.status(400).json({
          error: `Unsupported dataset adapter '${rawDatasetId}'. Supported CSV/TXT adapters: ${getSupportedAdapterSpecs().map((s) => s.datasetId).join(", ")}.`,
        });
        return;
      }
      if (!filename || !content) {
        res.status(400).json({ error: "filename and UTF-8 CSV/TXT content are required." });
        return;
      }

      const recording = parseDatasetFile({
        datasetId: rawDatasetId,
        filename,
        content,
        participantId: typeof body.participantId === "string" ? body.participantId : undefined,
        recordId: typeof body.recordId === "string" ? body.recordId : undefined,
        windowMs: typeof body.windowMs === "number" && Number.isFinite(body.windowMs) ? body.windowMs : undefined,
      });

      const shouldLoad = body.autoLoadPlayback !== false;
      const playback = shouldLoad
        ? await sharedPlaybackEngine.loadRecording(recording, {
            speed: typeof body.speed === "number" && Number.isFinite(body.speed) ? body.speed : 1,
            prefitBaselineCount:
              typeof body.prefitBaselineCount === "number" && Number.isFinite(body.prefitBaselineCount)
                ? body.prefitBaselineCount
                : 0,
            minBaselineSamples:
              typeof body.minBaselineSamples === "number" && Number.isFinite(body.minBaselineSamples)
                ? body.minBaselineSamples
                : 20,
          })
        : sharedPlaybackEngine.getStatus();

      const firstFrame = recording.frames[0];
      const lastFrame = recording.frames[recording.frames.length - 1];
      const durationMs =
        firstFrame && lastFrame
          ? Math.max(0, lastFrame.relativeOffsetMs - firstFrame.relativeOffsetMs)
          : 0;

      res.json({
        ok: true,
        recording: {
          datasetId: recording.datasetId,
          datasetName: recording.datasetName,
          sourcePlatform: recording.sourcePlatform,
          participantId: recording.participantId,
          recordId: recording.recordId,
          originalFilename: recording.originalFilename,
          samplingRateHz: recording.samplingRateHz,
          startTimestampIso: firstFrame ? firstFrame.timestampIso : null,
          endTimestampIso: lastFrame ? lastFrame.timestampIso : null,
          durationMs,
          availableModalities: recording.availableModalities,
          temperatureSite: recording.temperatureSite,
          hasGroundTruthLabels: recording.hasGroundTruthLabels,
          labelGranularity:
            recording.labelGranularity ?? (recording.hasGroundTruthLabels ? "sample_level" : "none"),
          allFramesAnomalous:
            recording.frames.length > 0 &&
            recording.frames.every((f) => f.groundTruthIsAnomalous === true),
          labeledFrameCount: recording.labeledFrameCount,
          totalFrames: recording.frames.length,
          cohortNote: recording.cohortNote,
          includesElderly: recording.includesElderly,
          allParticipantsElderly: recording.allParticipantsElderly,
          provenanceNote: recording.provenanceNote,
          warnings: recording.warnings,
        },
        playback,
      });
    } catch (err) {
      if (err instanceof DatasetValidationError) {
        res.status(400).json({ error: err.message, code: err.code, details: err.details });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : "Dataset import failed." });
    }
  });

  app.get("/api/datasets/playback/status", (_req, res) => {
    res.json(sharedPlaybackEngine.getStatus());
  });

  app.post("/api/datasets/playback/start", (_req, res) => {
    try {
      res.json(sharedPlaybackEngine.start());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot start playback." });
    }
  });

  app.post("/api/datasets/playback/pause", (_req, res) => {
    try {
      res.json(sharedPlaybackEngine.pause());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot pause playback." });
    }
  });

  app.post("/api/datasets/playback/resume", (_req, res) => {
    try {
      res.json(sharedPlaybackEngine.resume());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot resume playback." });
    }
  });

  app.post("/api/datasets/playback/step", async (_req, res) => {
    try {
      const outcome = await sharedPlaybackEngine.step();
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot step playback." });
    }
  });

  app.post("/api/datasets/playback/reset", async (_req, res) => {
    try {
      const snapshot = await sharedPlaybackEngine.reset();
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot reset playback." });
    }
  });

  app.post("/api/datasets/playback/speed", (req, res) => {
    try {
      const body = req.body as { speed?: unknown };
      if (typeof body?.speed !== "number" || !Number.isFinite(body.speed) || body.speed <= 0) {
        res.status(400).json({ error: "speed must be a positive number." });
        return;
      }
      res.json(sharedPlaybackEngine.setSpeed(body.speed));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Cannot update playback speed." });
    }
  });

  // --- ML Anomaly Detection & Baseline Fitting ---
  app.post("/api/ml/analyze", async (req, res) => {
    try {
      const body = req.body as Partial<TelemetryPayload>;
      if (!body?.patientId) {
        res.status(400).json({ error: "patientId is required." });
        return;
      }

      const heartRate =
        body.heartRate === null || body.heartRate === undefined
          ? null
          : typeof body.heartRate === "number" && Number.isFinite(body.heartRate)
          ? body.heartRate
          : NaN;
      const spo2 =
        body.spo2 === null || body.spo2 === undefined
          ? null
          : typeof body.spo2 === "number" && Number.isFinite(body.spo2)
          ? body.spo2
          : NaN;
      const temperatureC =
        body.temperatureC === null || body.temperatureC === undefined
          ? null
          : typeof body.temperatureC === "number" && Number.isFinite(body.temperatureC)
          ? body.temperatureC
          : NaN;

      if (Number.isNaN(heartRate) || Number.isNaN(spo2) || Number.isNaN(temperatureC)) {
        res.status(400).json({ error: "heartRate, spo2, and temperatureC must be numeric or null." });
        return;
      }

      const allowedSources = new Set<TelemetrySource>([
        "sample_demo",
        "simulator",
        "esp32_hardware",
        "dataset_playback",
      ]);
      const source: TelemetrySource =
        typeof body.source === "string" && allowedSources.has(body.source as TelemetrySource)
          ? (body.source as TelemetrySource)
          : "simulator";

      const result = await analyzeTelemetry({
        patientId: body.patientId,
        deviceId: body.deviceId,
        timestamp: typeof body.timestamp === "string" ? body.timestamp : undefined,
        heartRate,
        spo2,
        temperatureC,
        movementStatus: body.movementStatus ?? "resting",
        accelMagnitude: typeof body.accelMagnitude === "number" ? body.accelMagnitude : 1.0,
        gyroMagnitude: typeof body.gyroMagnitude === "number" ? body.gyroMagnitude : 4.0,
        possibleFallDetected: Boolean(body.possibleFallDetected),
        irSignalOk: body.irSignalOk ?? true,
        fingerDetected: body.fingerDetected ?? true,
        ecgSamples: Array.isArray(body.ecgSamples) ? body.ecgSamples : undefined,
        ecgSamplingRate: typeof body.ecgSamplingRate === "number" ? body.ecgSamplingRate : undefined,
        ecgSignalQuality: body.ecgSignalQuality,
        ecgLeadOff: typeof body.ecgLeadOff === "boolean" ? body.ecgLeadOff : undefined,
        ecgTimestamp: typeof body.ecgTimestamp === "string" ? body.ecgTimestamp : undefined,
        source,
        baselineMeans: body.baselineMeans,
        baselineTrained: body.baselineTrained,
        policyConfig:
          body.policyConfig ??
          buildPolicyConfigFromAlertLevels(sharedVoiceEscalationEngine.getAlertLevelsPolicy()),
        accelX: typeof body.accelX === "number" ? body.accelX : undefined,
        accelY: typeof body.accelY === "number" ? body.accelY : undefined,
        accelZ: typeof body.accelZ === "number" ? body.accelZ : undefined,
        gyroX: typeof body.gyroX === "number" ? body.gyroX : undefined,
        gyroY: typeof body.gyroY === "number" ? body.gyroY : undefined,
        gyroZ: typeof body.gyroZ === "number" ? body.gyroZ : undefined,
        imuSamplingRate: typeof body.imuSamplingRate === "number" ? body.imuSamplingRate : undefined,
        fallMetrics: body.fallMetrics,
        respiratoryRateBpm: typeof body.respiratoryRateBpm === "number" ? body.respiratoryRateBpm : undefined,
        temperatureSite: body.temperatureSite,
        sleepStage: body.sleepStage,
        availableModalities: body.availableModalities,
        datasetContext: body.datasetContext,
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "ML analysis failed." });
    }
  });

  app.get("/api/ml/baseline/status/:patientId", (req, res) => {
    const minSamplesRaw = Number(req.query.minSamples);
    const required = Number.isFinite(minSamplesRaw) && minSamplesRaw >= 5 ? Math.round(minSamplesRaw) : 20;
    res.json(getPatientBaselineStatusSummary(req.params.patientId, required));
  });

  app.post("/api/ml/baseline/reset", async (req, res) => {
    const body = req.body as {
      patientId?: string;
      source?: "esp32_hardware" | "simulator" | "dataset_playback";
    };
    if (!body?.patientId) {
      res.status(400).json({ error: "patientId is required." });
      return;
    }
    const { remoteCleared } = await resetPatientMlRemote(body.patientId, body.source);
    res.json({ ok: true, patientId: body.patientId, remoteCleared });
  });

  app.post("/api/ml/baseline/fit", async (req, res) => {
    try {
      const body = req.body as {
        patientId?: string;
        source?: TelemetryPayload["source"];
        minSamples?: number;
        availableModalities?: TelemetryPayload["availableModalities"];
        temperatureSite?: TelemetryPayload["temperatureSite"];
        samples?: Array<{
          heartRate: number | null;
          spo2: number | null;
          temperatureC: number | null;
          accelMagnitude?: number;
          gyroMagnitude?: number;
          movementStatus?: TelemetryPayload["movementStatus"];
          signalQuality?: "good" | "noisy" | "poor_contact";
          timestamp?: string;
          ecgBpm?: number | null;
          ecgSignalQuality?: TelemetryPayload["ecgSignalQuality"];
          ecgLeadOff?: boolean;
          temperatureSite?: TelemetryPayload["temperatureSite"];
        }>;
      };
      if (!body?.patientId || !Array.isArray(body.samples)) {
        res.status(400).json({ error: "patientId and samples array are required." });
        return;
      }
      const normalized = body.samples.map((s) => ({
        heartRate: s.heartRate === null || s.heartRate === undefined ? null : Number(s.heartRate),
        spo2: s.spo2 === null || s.spo2 === undefined ? null : Number(s.spo2),
        temperatureC:
          s.temperatureC === null || s.temperatureC === undefined ? null : Number(s.temperatureC),
        accelMagnitude: typeof s.accelMagnitude === "number" ? s.accelMagnitude : 1.0,
        gyroMagnitude: typeof s.gyroMagnitude === "number" ? s.gyroMagnitude : 4.0,
        movementStatus: s.movementStatus,
        signalQuality: s.signalQuality,
        timestamp: s.timestamp,
        ecgBpm: typeof s.ecgBpm === "number" ? s.ecgBpm : null,
        ecgSignalQuality: s.ecgSignalQuality,
        ecgLeadOff: Boolean(s.ecgLeadOff),
        temperatureSite: s.temperatureSite ?? body.temperatureSite ?? null,
      }));
      const result = await fitPatientBaselineRemote(body.patientId, normalized, {
        source: body.source ?? "simulator",
        minSamples: typeof body.minSamples === "number" ? body.minSamples : 20,
        availableModalities: body.availableModalities,
        temperatureSite: body.temperatureSite ?? null,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Baseline fitting failed." });
    }
  });

  app.get("/api/ml/model/status/:patientId", async (req, res) => {
    const rawSource = typeof req.query.source === "string" ? req.query.source.trim() : undefined;
    const allowed = new Set(["esp32_hardware", "simulator", "dataset_playback"]);
    const source = rawSource && allowed.has(rawSource) ? (rawSource as TelemetrySource) : undefined;
    const status = await fetchMlModelStatusRemote(req.params.patientId, source);
    res.json(status);
  });

  app.get("/api/ml/config", async (_req, res) => {
    const cfg = await fetchMlConfigRemote();
    res.json({ ok: true, ...cfg });
  });

  app.put("/api/ml/config", requireAdminFirebaseUser, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = await updateMlConfigRemote({
        contamination: typeof body.contamination === "number" ? body.contamination : undefined,
        nEstimators: typeof body.nEstimators === "number" ? body.nEstimators : undefined,
        retrainInterval: typeof body.retrainInterval === "number" ? body.retrainInterval : undefined,
        baselineMinSamples: typeof body.baselineMinSamples === "number" ? body.baselineMinSamples : undefined,
        warningPersistenceWindows:
          typeof body.warningPersistenceWindows === "number" ? body.warningPersistenceWindows : undefined,
        criticalPersistenceWindows:
          typeof body.criticalPersistenceWindows === "number" ? body.criticalPersistenceWindows : undefined,
        anomalyScoreWarning: typeof body.anomalyScoreWarning === "number" ? body.anomalyScoreWarning : undefined,
        anomalyScoreCritical: typeof body.anomalyScoreCritical === "number" ? body.anomalyScoreCritical : undefined,
        zScoreWarning: typeof body.zScoreWarning === "number" ? body.zScoreWarning : undefined,
        zScoreCritical: typeof body.zScoreCritical === "number" ? body.zScoreCritical : undefined,
      });
      res.json({ ok: true, updatedBy: user.uid, ...updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update ML config." });
    }
  });

  app.post("/api/ml/evaluate", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        patientId?: unknown;
        source?: unknown;
        readings?: unknown;
        samples?: unknown;
        labels?: unknown;
      };
      const patientId = typeof body.patientId === "string" ? body.patientId.trim() : "";
      if (!patientId) {
        res.status(400).json({ error: "patientId is required." });
        return;
      }
      const allowed = new Set(["esp32_hardware", "simulator", "dataset_playback"]);
      const source =
        typeof body.source === "string" && allowed.has(body.source)
          ? (body.source as TelemetrySource)
          : undefined;
      const rawReadings = Array.isArray(body.readings)
        ? (body.readings as Array<Record<string, unknown>>)
        : Array.isArray(body.samples)
        ? (body.samples as Array<Record<string, unknown>>)
        : undefined;
      const result = await evaluateMlModelRemote({
        patientId,
        source,
        readings: rawReadings,
        labels: Array.isArray(body.labels) ? body.labels : undefined,
      });
      res.json({
        ok: true,
        mlServiceConnected: result.mlServiceConnected,
        ...result.evaluation,
        evaluation: result.evaluation,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Model evaluation failed." });
    }
  });

  app.post("/api/ml/graphs/generate", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        patientId?: unknown;
        source?: unknown;
        readings?: unknown;
        samples?: unknown;
      };
      const patientId = typeof body.patientId === "string" ? body.patientId.trim() : "";
      if (!patientId) {
        res.status(400).json({ error: "patientId is required." });
        return;
      }
      const allowed = new Set(["esp32_hardware", "simulator", "dataset_playback"]);
      const source =
        typeof body.source === "string" && allowed.has(body.source)
          ? (body.source as TelemetrySource)
          : "simulator";
      const rawReadings = Array.isArray(body.readings)
        ? (body.readings as Array<Record<string, unknown>>)
        : Array.isArray(body.samples)
        ? (body.samples as Array<Record<string, unknown>>)
        : undefined;
      const result = await generateMlGraphsRemote({
        patientId,
        source,
        readings: rawReadings,
      });
      if (!result.ok) {
        res.status(503).json({
          error: result.message || "Python ML service is unavailable for graph rendering.",
          ...result,
        });
        return;
      }
      res.json({
        ok: true,
        patient_id: patientId,
        source,
        sample_count: rawReadings?.length ?? 0,
        ml_service_connected: result.mlServiceConnected,
        graphs: result.graphs,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Graph generation failed." });
    }
  });

  app.get("/api/ml/graphs/file/:filename", (req, res) => {
    const filename = req.params.filename ?? "";
    if (!/^[a-zA-Z0-9_.-]+\.png$/.test(filename) || filename.includes("..")) {
      res.status(400).json({ error: "Invalid graph filename." });
      return;
    }
    const resolved = resolveMlGraphFilePath(filename);
    if (!resolved) {
      res.status(404).json({ error: "Graph image not found." });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(resolved);
  });

  app.get("/api/ml/graphs/:patientId", async (req, res) => {
    const rawSource = typeof req.query.source === "string" ? req.query.source.trim() : undefined;
    const allowed = new Set(["esp32_hardware", "simulator", "dataset_playback"]);
    const source = rawSource && allowed.has(rawSource) ? (rawSource as TelemetrySource) : undefined;
    const result = await listMlGraphsRemote(req.params.patientId, source);
    res.json({ ok: true, ...result });
  });

  // --- Caregiver Automated Voice Calling & Escalation ---
  app.post("/api/voice/escalate", async (req, res) => {
    try {
      const body = req.body as {
        alertId?: string;
        patientId?: string;
        patientName?: string;
        summary?: string;
        primaryCaregiverName?: string;
        secondaryCaregiverName?: string;
        timeoutSec?: number;
        dryRun?: boolean;
      };

      if (!body?.alertId || !body?.patientId || !body?.patientName) {
        res.status(400).json({ error: "alertId, patientId, and patientName are required." });
        return;
      }

      const state = await initiateCaregiverEscalation({
        alertId: body.alertId,
        patientId: body.patientId,
        patientName: body.patientName,
        summary: body.summary || "Critical wearable anomaly alert",
        primaryCaregiverName: body.primaryCaregiverName || "Primary Caregiver",
        secondaryCaregiverName: body.secondaryCaregiverName || "Secondary Caregiver",
        timeoutSec: typeof body.timeoutSec === "number" ? body.timeoutSec : undefined,
        dryRun: Boolean(body.dryRun),
      });

      res.json(state);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Voice escalation dispatch failed." });
    }
  });

  app.post("/api/voice/outcome", (req, res) => {
    const body = req.body as {
      alertId?: string;
      action?: "primary_answered" | "primary_no_answer_escalate" | "secondary_acknowledged";
    };
    if (!body?.alertId || !body?.action) {
      res.status(400).json({ error: "alertId and action are required." });
      return;
    }
    const updated = advanceEscalationOutcome(body.alertId, body.action);
    if (!updated) {
      res.status(404).json({ error: "Escalation workflow session not found for alertId." });
      return;
    }
    res.json(updated);
  });

  app.get("/api/voice/status/:alertId", (req, res) => {
    const state = getEscalationState(req.params.alertId);
    res.json({ state });
  });

  // --- Twilio Programmable Voice: Secure Outbound Calling API ---
  app.get("/api/voice/outbound/config", (req, res) => {
    const cfg = getOutboundTwilioConfig(req);
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
    );
    res.json({
      configured: cfg.configured,
      missingEnvVars: cfg.missingEnvVars,
      publicBaseUrlConfigured: cfg.publicBaseUrlConfigured,
      browserVoiceConfigured: geminiConfigured,
      statusMessage: cfg.configured
        ? "Twilio Programmable Voice is configured."
        : "Phone calling is not configured yet. You can still test the AI voice assistant in your browser.",
    });
  });

  app.post("/api/voice/outbound/initiate", async (req, res) => {
    try {
      const clientIp = req.ip || "unknown";
      const limitCheck = checkOutboundRateLimit(clientIp);
      if (!limitCheck.allowed) {
        res.status(429).json({
          ok: false,
          status: "failed",
          error: `Too many outbound call attempts. Try again in ${limitCheck.retryAfterSec}s.`,
        });
        return;
      }

      const body = req.body as { phoneNumber?: unknown; e164Number?: unknown };
      const validation = validateE164PhoneNumber(body?.e164Number ?? body?.phoneNumber);
      if (!validation.valid || !validation.normalized) {
        res.status(400).json({
          ok: false,
          status: "failed",
          error: validation.error || "Invalid phone number.",
        });
        return;
      }

      const cfg = getOutboundTwilioConfig(req);
      if (!cfg.configured) {
        res.status(503).json({
          ok: false,
          configured: false,
          status: "failed",
          missingEnvVars: cfg.missingEnvVars,
          error:
            "Phone calling is not configured yet. You can still test the AI voice assistant in your browser.",
        });
        return;
      }

      const record = await initiateTwilioOutboundCall({
        toE164: validation.normalized,
        req,
      });

      res.status(201).json({
        ok: true,
        configured: true,
        callId: record.callId,
        status: record.status,
        twilioStatus: record.twilioStatus,
        maskedPhone: record.maskedPhone,
        durationSec: record.durationSec,
        startedAt: record.startedAt,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        status: "failed",
        error: err instanceof Error ? err.message : "Failed to initiate outbound Twilio call.",
      });
    }
  });

  app.get("/api/voice/outbound/status/:callId", async (req, res) => {
    const callId = req.params.callId?.trim() || "";
    if (!UUID_V4_REGEX.test(callId)) {
      res.status(400).json({ error: "Invalid callId format." });
      return;
    }

    const record = await refreshOutboundCallRecord(callId);
    if (!record) {
      res.status(404).json({ error: "Outbound call session not found." });
      return;
    }

    res.json({
      callId: record.callId,
      status: record.status,
      twilioStatus: record.twilioStatus,
      maskedPhone: record.maskedPhone,
      durationSec: record.durationSec,
      errorMessage: record.errorMessage,
      startedAt: record.startedAt,
      connectedAt: record.connectedAt,
      endedAt: record.endedAt,
      updatedAt: record.updatedAt,
    });
  });

  app.post("/api/voice/outbound/terminate", async (req, res) => {
    try {
      const body = req.body as { callId?: unknown };
      const callId = typeof body?.callId === "string" ? body.callId.trim() : "";
      if (!UUID_V4_REGEX.test(callId)) {
        res.status(400).json({ error: "A valid callId is required." });
        return;
      }

      closeActiveVoiceBridge(callId);
      const updated = await terminateTwilioOutboundCall(callId);
      if (!updated) {
        res.status(404).json({ error: "Outbound call session not found." });
        return;
      }

      res.json({
        ok: true,
        callId: updated.callId,
        status: updated.status,
        twilioStatus: updated.twilioStatus,
        durationSec: updated.durationSec,
        endedAt: updated.endedAt,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to terminate outbound call.",
      });
    }
  });

  app.post("/api/voice/outbound/twiml", (req, res) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
    const baseUrl = resolvePublicBaseUrl(req);
    const fullUrl = baseUrl ? `${baseUrl}${req.originalUrl}` : "";
    const sig = req.get("x-twilio-signature");

    if (
      !authToken ||
      !baseUrl ||
      !fullUrl ||
      !verifyTwilioSignature({
        authToken,
        signatureHeader: sig,
        fullUrl,
        bodyParams: (req.body ?? {}) as Record<string, unknown>,
      })
    ) {
      res.status(403).type("text/plain").send("Forbidden: invalid Twilio signature.");
      return;
    }

    const callId = typeof req.query.callId === "string" ? req.query.callId.trim() : "";
    if (!UUID_V4_REGEX.test(callId)) {
      res.status(400).type("text/plain").send("Bad Request: missing or invalid callId.");
      return;
    }

    const body = (req.body ?? {}) as { CallSid?: string; CallStatus?: string };
    applyTwilioWebhookUpdate({
      callIdHint: callId,
      callSid: typeof body.CallSid === "string" ? body.CallSid : undefined,
      callStatus: typeof body.CallStatus === "string" ? body.CallStatus : "in-progress",
    });

    const wssBase = baseUrl.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
    const wssStreamUrl = `${wssBase}/api/voice/outbound/stream`;
    const streamToken = createStreamToken(callId);

    res
      .status(200)
      .type("application/xml")
      .send(buildOutboundAnswerTwimlXml({ wssStreamUrl, callId, streamToken }));
  });

  app.post("/api/voice/outbound/status", (req, res) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
    const baseUrl = resolvePublicBaseUrl(req);
    const fullUrl = baseUrl ? `${baseUrl}${req.originalUrl}` : "";
    const sig = req.get("x-twilio-signature");

    if (
      !authToken ||
      !fullUrl ||
      !verifyTwilioSignature({
        authToken,
        signatureHeader: sig,
        fullUrl,
        bodyParams: (req.body ?? {}) as Record<string, unknown>,
      })
    ) {
      res.status(403).type("text/plain").send("Forbidden: invalid Twilio signature.");
      return;
    }

    const callId = typeof req.query.callId === "string" ? req.query.callId : undefined;
    const body = (req.body ?? {}) as {
      CallSid?: string;
      CallStatus?: string;
      CallDuration?: string;
    };
    const parsedDuration = body.CallDuration ? Number(body.CallDuration) : undefined;

    applyTwilioWebhookUpdate({
      callIdHint: callId,
      callSid: typeof body.CallSid === "string" ? body.CallSid : undefined,
      callStatus: typeof body.CallStatus === "string" ? body.CallStatus : undefined,
      callDurationSec: Number.isFinite(parsedDuration) ? parsedDuration : undefined,
    });

    res.status(204).send();
  });

  // --- Arova AI Voice Calling: Authenticated Caregiver Contacts, Test Call, Retries, History & Audit ---
  app.get("/api/voice/contacts", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId.trim() : undefined;
    const contacts = sharedVoiceEscalationEngine.listCaregiverContacts({
      patientId: patientId || undefined,
      callerUid: user.uid,
      isAdmin: user.isAdmin,
    });
    res.json({ contacts });
  });

  app.post("/api/voice/contacts", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const body = req.body as {
        contactId?: unknown;
        patientId?: unknown;
        patientOwnerUid?: unknown;
        caregiverUid?: unknown;
        caregiverName?: unknown;
        phoneNumber?: unknown;
        priority?: unknown;
        priorityRank?: unknown;
        preferredLanguage?: unknown;
        explicitCallConsent?: unknown;
        authorizedForPatientIdentity?: unknown;
        authorizedForHealthReadings?: unknown;
        status?: unknown;
      };

      const patientId = typeof body?.patientId === "string" ? body.patientId.trim() : "";
      const caregiverName = typeof body?.caregiverName === "string" ? body.caregiverName.trim() : "";
      const rawPhone = typeof body?.phoneNumber === "string" ? body.phoneNumber : "";
      if (!patientId || !caregiverName || !rawPhone) {
        res.status(400).json({ error: "patientId, caregiverName, and phoneNumber are required." });
        return;
      }

      const ownerUid =
        user.isAdmin && typeof body?.patientOwnerUid === "string" && body.patientOwnerUid.trim()
          ? body.patientOwnerUid.trim()
          : user.uid;

      const rawPriority = typeof body?.priority === "string" ? body.priority : "primary";
      const priority: CaregiverPriority =
        rawPriority === "secondary" || rawPriority === "alternate" ? rawPriority : "primary";
      const rawLang = typeof body?.preferredLanguage === "string" ? body.preferredLanguage : "en";
      const preferredLanguage: SupportedVoiceLanguage =
        rawLang === "kn" || rawLang === "hi" ? rawLang : "en";

      const contact = sharedVoiceEscalationEngine.upsertCaregiverContact(
        {
          contactId: typeof body?.contactId === "string" ? body.contactId.trim() : undefined,
          patientId,
          patientOwnerUid: ownerUid,
          caregiverUid: typeof body?.caregiverUid === "string" ? body.caregiverUid.trim() : undefined,
          caregiverName,
          e164Phone: rawPhone,
          priority,
          priorityRank:
            typeof body?.priorityRank === "number" && Number.isFinite(body.priorityRank)
              ? body.priorityRank
              : undefined,
          preferredLanguage,
          explicitCallConsent: body?.explicitCallConsent === true,
          authorizedForPatientIdentity: body?.authorizedForPatientIdentity === true,
          authorizedForHealthReadings: body?.authorizedForHealthReadings === true,
          status: body?.status === "paused" ? "paused" : "active",
        },
        user.uid
      );

      res.status(201).json({ contact });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to save caregiver contact.",
      });
    }
  });

  app.patch("/api/voice/contacts/:contactId", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const existing = sharedVoiceEscalationEngine.getCaregiverContact(req.params.contactId);
      if (!existing) {
        res.status(404).json({ error: "Caregiver contact not found." });
        return;
      }
      if (!user.isAdmin && existing.patientOwnerUid !== user.uid) {
        res.status(403).json({ error: "Forbidden: unauthorized to modify this caregiver contact." });
        return;
      }

      const body = req.body as {
        caregiverName?: unknown;
        phoneNumber?: unknown;
        priority?: unknown;
        priorityRank?: unknown;
        preferredLanguage?: unknown;
        explicitCallConsent?: unknown;
        authorizedForPatientIdentity?: unknown;
        authorizedForHealthReadings?: unknown;
        status?: unknown;
      };

      const priority: CaregiverPriority =
        body?.priority === "primary" || body?.priority === "secondary" || body?.priority === "alternate"
          ? body.priority
          : existing.priority;
      const preferredLanguage: SupportedVoiceLanguage =
        body?.preferredLanguage === "en" || body?.preferredLanguage === "kn" || body?.preferredLanguage === "hi"
          ? body.preferredLanguage
          : existing.preferredLanguage;

      const updated = sharedVoiceEscalationEngine.upsertCaregiverContact(
        {
          contactId: existing.contactId,
          patientId: existing.patientId,
          patientOwnerUid: existing.patientOwnerUid,
          caregiverUid: existing.caregiverUid,
          caregiverName:
            typeof body?.caregiverName === "string" && body.caregiverName.trim()
              ? body.caregiverName.trim()
              : existing.caregiverName,
          e164Phone:
            typeof body?.phoneNumber === "string" && body.phoneNumber.trim()
              ? body.phoneNumber.trim()
              : existing.e164Phone,
          priority,
          priorityRank:
            typeof body?.priorityRank === "number" && Number.isFinite(body.priorityRank)
              ? body.priorityRank
              : existing.priorityRank,
          preferredLanguage,
          explicitCallConsent:
            typeof body?.explicitCallConsent === "boolean"
              ? body.explicitCallConsent
              : existing.explicitCallConsent,
          authorizedForPatientIdentity:
            typeof body?.authorizedForPatientIdentity === "boolean"
              ? body.authorizedForPatientIdentity
              : existing.authorizedForPatientIdentity,
          authorizedForHealthReadings:
            typeof body?.authorizedForHealthReadings === "boolean"
              ? body.authorizedForHealthReadings
              : existing.authorizedForHealthReadings,
          status:
            body?.status === "paused" || body?.status === "active"
              ? body.status
              : existing.status,
        },
        user.uid
      );
      res.json({ contact: updated });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to update caregiver contact.",
      });
    }
  });

  app.delete("/api/voice/contacts/:contactId", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const deleted = sharedVoiceEscalationEngine.deleteCaregiverContact(
        req.params.contactId,
        user.uid,
        user.isAdmin
      );
      if (!deleted) {
        res.status(404).json({ error: "Caregiver contact not found." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : "Failed to delete caregiver contact.",
      });
    }
  });

  app.get("/api/voice/settings/retry", requireVerifiedFirebaseUser, (_req, res) => {
    res.json({ settings: sharedVoiceEscalationEngine.getRetryPolicy() });
  });

  app.put("/api/voice/settings/retry", requireAdminFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const body = req.body as {
      retryIntervalSec?: unknown;
      maxCallAttempts?: unknown;
      fallbackNotificationEnabled?: unknown;
    };
    const settings = sharedVoiceEscalationEngine.updateRetryPolicy(
      {
        retryIntervalSec:
          typeof body?.retryIntervalSec === "number" ? body.retryIntervalSec : undefined,
        maxCallAttempts:
          typeof body?.maxCallAttempts === "number" ? body.maxCallAttempts : undefined,
        fallbackNotificationEnabled:
          typeof body?.fallbackNotificationEnabled === "boolean"
            ? body.fallbackNotificationEnabled
            : undefined,
      },
      user.uid
    );
    res.json({ settings });
  });

  app.post("/api/voice/admin/test-call", requireAdminFirebaseUser, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.firebaseUser!;
      const limitCheck = checkOutboundRateLimit(`admin:${user.uid}`);
      if (!limitCheck.allowed) {
        res.status(429).json({
          ok: false,
          error: `Rate limit reached. Retry in ${limitCheck.retryAfterSec}s.`,
        });
        return;
      }

      const body = req.body as {
        contactId?: unknown;
        patientName?: unknown;
        parameter?: unknown;
        readingValue?: unknown;
        readingUnit?: unknown;
        language?: unknown;
        reasonForCalling?: unknown;
      };
      const contactId = typeof body?.contactId === "string" ? body.contactId.trim() : "";
      if (!contactId) {
        res.status(400).json({ ok: false, error: "Registered caregiver contactId is required." });
        return;
      }

      const contact = sharedVoiceEscalationEngine.getCaregiverContact(contactId);
      if (!contact) {
        res.status(404).json({ ok: false, error: "Caregiver contact not found." });
        return;
      }
      if (!contact.explicitCallConsent) {
        res.status(400).json({
          ok: false,
          error: `Caregiver ${contact.caregiverName} has not granted explicit automated-call consent.`,
        });
        return;
      }

      const cfg = getOutboundTwilioConfig(req);
      if (!cfg.configured) {
        res.status(503).json({
          ok: false,
          configured: false,
          missingEnvVars: cfg.missingEnvVars,
          error:
            "Phone calling is not configured yet. You can still test the AI voice assistant in your browser.",
        });
        return;
      }

      const lang: SupportedVoiceLanguage | undefined =
        body?.language === "en" || body?.language === "kn" || body?.language === "hi"
          ? body.language
          : undefined;

      const entry = await sharedVoiceEscalationEngine.triggerAdminTestCall({
        contactId,
        patientName: typeof body?.patientName === "string" ? body.patientName.trim() : undefined,
        parameter: typeof body?.parameter === "string" ? body.parameter.trim() : undefined,
        readingValue: typeof body?.readingValue === "string" ? body.readingValue.trim() : undefined,
        readingUnit: typeof body?.readingUnit === "string" ? body.readingUnit.trim() : undefined,
        language: lang,
        reasonForCalling:
          typeof body?.reasonForCalling === "string" ? body.reasonForCalling.trim() : undefined,
        actorUid: user.uid,
        req,
      });

      res.status(201).json({
        ok: true,
        call: entry,
        caregiver: toPublicCaregiverContact(contact),
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to initiate admin test call.",
      });
    }
  });

  app.get("/api/voice/history", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId.trim() : undefined;
    const history = sharedVoiceEscalationEngine.listCallHistory({
      patientId: patientId || undefined,
      callerUid: user.uid,
      isAdmin: user.isAdmin,
    });
    res.json({ history });
  });

  app.get("/api/voice/escalations", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const patientId = typeof req.query.patientId === "string" ? req.query.patientId.trim() : undefined;
    const escalations = sharedVoiceEscalationEngine.listEscalations({
      patientId: patientId || undefined,
      callerUid: user.uid,
      isAdmin: user.isAdmin,
    });
    res.json({ escalations });
  });

  app.post(
    "/api/voice/escalations/:escalationId/resolve",
    requireVerifiedFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      try {
        const user = req.firebaseUser!;
        const body = req.body as { followUpNote?: unknown };
        const escalation = sharedVoiceEscalationEngine.resolveEscalationByHuman({
          escalationId: req.params.escalationId,
          actorUid: user.uid,
          isAdmin: user.isAdmin,
          followUpNote: typeof body?.followUpNote === "string" ? body.followUpNote : undefined,
        });
        res.json({ ok: true, escalation });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to resolve escalation.";
        const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.get("/api/voice/audit", requireVerifiedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const logs = sharedVoiceEscalationEngine.getAuditLogs({
      patientOwnerUid: user.uid,
      isAdmin: user.isAdmin,
    });
    res.json({ logs });
  });

  // --- Vite Middleware (Dev) or Static Dist (Prod) ---
  if (process.env.NODE_ENV === "production") {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const httpServer = http.createServer(app);
  attachTwilioMediaStreamServer(httpServer);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`AROVA server listening on http://0.0.0.0:${PORT}`);
    void startManagedMlService().then((started) => {
      if (started) {
        console.log("AROVA Python FastAPI Isolation Forest service connected.");
      }
    });
  });

  const shutdown = () => {
    stopManagedMlService();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
