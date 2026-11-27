import { useEffect, useState } from "react";
import {
  Activity,
  Check,
  Copy,
  KeyRound,
  Play,
  Power,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  Vibrate,
  Wifi,
  WifiOff,
} from "lucide-react";
import { EcgWaveformPanel } from "../components/EcgWaveformPanel.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import { fetchLatestHardwareEvents } from "../services/apiClient.ts";
import type { SimSensorErrorMode } from "../types/smartcare.ts";

export function HardwareIntegrationPage() {
  const {
    user,
    devices,
    readings,
    selectedPatient,
    saveDeviceConfig,
    integrations,
    liveHardwareSnapshot,
    ecgSegments,
    registeredBackendDevices,
    registerDeviceWithBackend,
    setDeviceConnectionState,
    triggerDeviceVibrationCommand,
    simRunning,
    simMode,
    simDeviceConnected,
    simSensorError,
    simIntervalMs,
    simLastPacketSummary,
    startSimulation,
    stopSimulation,
    setSimMode,
    setSimIntervalMs,
    setSimSensorError,
    generateNormalReading,
    generateUnusualReading,
    disconnectSimulatedDevice,
    reconnectSimulatedDevice,
  } = useSmartCare();

  const activeDevice = devices.find((d) => d.patientId === selectedPatient.patientId) ?? devices[0];
  const backendDevice = registeredBackendDevices.find(
    (d) => d.deviceId === (activeDevice?.deviceId ?? "") || d.patientId === selectedPatient.patientId
  );

  const [deviceId, setDeviceId] = useState(activeDevice?.deviceId ?? "esp32-arova-01");
  const [label, setLabel] = useState(activeDevice?.label ?? "AROVA ESP32 Wearable");
  const [pulseOxVariant, setPulseOxVariant] = useState(
    activeDevice?.pulseOxChipVariant ?? "MAX30102 (Default)"
  );
  const [ecgSensor, setEcgSensor] = useState(
    activeDevice?.ecgSensor ?? "AD8232 Single-Lead ECG (Provisional)"
  );
  const [tempSensor, setTempSensor] = useState(
    activeDevice?.tempSensor ?? "Configurable (Model Pending Confirmation)"
  );
  const [samplingMs, setSamplingMs] = useState(activeDevice?.samplingIntervalMs ?? 2000);
  const [firmwareVer, setFirmwareVer] = useState(activeDevice?.firmwareVersion ?? "arova-esp32-v3.0");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [generatedDeviceKey, setGeneratedDeviceKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [registeringDevice, setRegisteringDevice] = useState(false);
  const [deviceActionMessage, setDeviceActionMessage] = useState<string | null>(null);

  const [vibDurationMs, setVibDurationMs] = useState(350);
  const [vibFeedback, setVibFeedback] = useState<string | null>(null);
  const [sendingVib, setSendingVib] = useState(false);

  const [liveEvents, setLiveEvents] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    if (!activeDevice) return;
    setDeviceId(activeDevice.deviceId);
    setLabel(activeDevice.label);
    setPulseOxVariant(activeDevice.pulseOxChipVariant || "MAX30102 (Default)");
    setEcgSensor(activeDevice.ecgSensor ?? "AD8232 Single-Lead ECG (Provisional)");
    setTempSensor(activeDevice.tempSensor);
    setSamplingMs(activeDevice.samplingIntervalMs);
    setFirmwareVer(activeDevice.firmwareVersion);
    setSaveMessage(null);
  }, [activeDevice]);

  const loadEvents = async () => {
    try {
      const data = await fetchLatestHardwareEvents();
      setLiveEvents(data.events ?? []);
    } catch {
      // Ignore transient poll error
    }
  };

  useEffect(() => {
    void loadEvents();
  }, [liveHardwareSnapshot?.readingId, selectedPatient.patientId, readings.length]);

  const handleSaveDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMessage(null);
    try {
      await saveDeviceConfig({
        deviceId,
        label,
        pulseOxChipVariant: pulseOxVariant,
        ecgSensor,
        tempSensor,
        samplingIntervalMs: samplingMs,
        firmwareVersion: firmwareVer,
      });
      setSaveMessage("Device hardware configuration saved.");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Failed to save configuration.");
    }
  };

  const handleRegisterBackend = async (rotateToken: boolean) => {
    if (!user) {
      setDeviceActionMessage("Sign in to register a device and generate an authenticated X-Device-Key.");
      return;
    }
    setRegisteringDevice(true);
    setDeviceActionMessage(null);
    try {
      const res = await registerDeviceWithBackend({
        deviceId,
        label,
        pulseOxChipVariant: pulseOxVariant,
        ecgSensor,
        tempSensor,
        samplingIntervalMs: samplingMs,
        firmwareVersion: firmwareVer,
        rotateToken,
      });
      if (res.deviceApiKey) {
        setGeneratedDeviceKey(res.deviceApiKey);
      }
      setDeviceActionMessage(
        `Registered '${res.device.deviceId}' on backend gateway for ${selectedPatient.displayName}.`
      );
    } catch (err) {
      setDeviceActionMessage(err instanceof Error ? err.message : "Backend device registration failed.");
    } finally {
      setRegisteringDevice(false);
    }
  };

  const handleCopyKey = async () => {
    if (!generatedDeviceKey) return;
    try {
      await navigator.clipboard.writeText(generatedDeviceKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 1800);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  const handleHapticCommand = async (
    action: "activate" | "deactivate",
    pattern: "none" | "single_pulse" | "triple_alert"
  ) => {
    if (!user) {
      setVibFeedback("Sign in to dispatch authenticated wearable vibration commands.");
      return;
    }
    setSendingVib(true);
    setVibFeedback(null);
    try {
      const cmd = await triggerDeviceVibrationCommand(deviceId, {
        action,
        pattern,
        durationMs: action === "deactivate" ? 0 : vibDurationMs,
        reason: `Dashboard ${action} (${pattern}) test command`,
      });
      setVibFeedback(
        `Queued '${cmd.action}' (${cmd.pattern}, ${cmd.durationMs}ms · ID ${cmd.commandId}) for next ESP32 ingest/command poll.`
      );
    } catch (err) {
      setVibFeedback(err instanceof Error ? err.message : "Failed to dispatch vibration command.");
    } finally {
      setSendingVib(false);
    }
  };

  const latestReading = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;
  const effectiveStatus = liveHardwareSnapshot
    ? "streaming"
    : backendDevice?.connectionStatus ?? activeDevice?.connectionStatus ?? "not_connected";
  const effectiveLastSeen =
    liveHardwareSnapshot?.createdAt ??
    backendDevice?.lastSeenAt ??
    activeDevice?.lastSeenAt ??
    latestReading?.createdAt ??
    null;
  const effectiveSource = liveHardwareSnapshot
    ? "esp32_hardware"
    : backendDevice?.lastDataSource && backendDevice.lastDataSource !== "none"
    ? backendDevice.lastDataSource
    : activeDevice?.lastDataSource && activeDevice.lastDataSource !== "none"
    ? activeDevice.lastDataSource
    : latestReading?.source ?? "none";

  const sensorAvail =
    liveHardwareSnapshot?.sensorAvailability ??
    backendDevice?.sensorAvailability ??
    activeDevice?.sensorAvailability ?? {
      pulseOximeter: typeof latestReading?.heartRate === "number",
      temperature: typeof latestReading?.temperatureC === "number",
      imu: Boolean(latestReading),
      ecg: Boolean(
        latestReading?.ecgSamples &&
          latestReading.ecgSamples.length > 0 &&
          !latestReading.ecgLeadOff
      ),
      oled: true,
      vibrationMotor: true,
    };

  const liveHrText =
    latestReading && typeof latestReading.heartRate === "number"
      ? `${Math.round(latestReading.heartRate)} BPM`
      : "-- BPM";
  const liveSpo2Text =
    latestReading && typeof latestReading.spo2 === "number"
      ? `${latestReading.spo2.toFixed(1)}%`
      : "--%";
  const liveTempText =
    latestReading && typeof latestReading.temperatureC === "number"
      ? `${latestReading.temperatureC.toFixed(1)} °C`
      : "Unavailable (null)";

  return (
    <div className="space-y-6">
      {/* 1. Live Hardware Telemetry Status & Confirmed Stack Summary */}
      <section className="arova-float-card-subtle arova-float-delay-1 arova-glass-card rounded-2xl p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-[#202525]">
              {liveHardwareSnapshot
                ? "Hardware Telemetry Status: ESP32 Streaming Live"
                : effectiveStatus === "offline"
                ? "Hardware Telemetry Status: Device Offline"
                : "Hardware Telemetry Status: Not Connected"}
            </h2>
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-mono font-medium px-2.5 py-0.5 rounded-lg border ${
                liveHardwareSnapshot
                  ? "text-[#008F00] bg-[#00B800]/12 border-[#00B800]/35"
                  : effectiveStatus === "offline"
                  ? "text-red-800 bg-red-50 border-red-300"
                  : "text-[#737B7B] bg-[#F7F9F9] border-[#D9E0E0]"
              }`}
            >
              {liveHardwareSnapshot && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#00B800] arova-status-normal-dot" />
              )}
              {liveHardwareSnapshot ? "Real Hardware Live" : effectiveStatus}
            </span>
          </div>
          <p className="text-xs text-[#737B7B] leading-relaxed">
            {liveHardwareSnapshot ? (
              <>
                Receiving live ESP32 packets for{" "}
                <span className="font-mono font-semibold text-[#202525]">
                  {selectedPatient.displayName}
                </span>
                :{" "}
                <span className="font-mono text-[#008F00] tabular-nums">
                  {liveHrText} · {liveSpo2Text} · {liveTempText} · IMU{" "}
                  {liveHardwareSnapshot.accelMagnitude?.toFixed(2) ?? "1.00"} g
                </span>{" "}
                (last packet {new Date(liveHardwareSnapshot.createdAt).toLocaleTimeString()}).
              </>
            ) : (
              <>
                No physical ESP32 board is currently streaming live packets. Flash{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  /firmware/arova_wearable_esp32.ino
                </code>{" "}
                (with{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  arova_secrets.h
                </code>
                ) so real MAX30102/MAX30100, MPU6050 triaxial IMU, temperature, and vibration alerts
                run over{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  /api/wearable/ingest
                </code>{" "}
                — or use Simulation Mode below to test the full pipeline without hardware.
              </>
            )}
          </p>
        </div>

        <div className="space-y-2 lg:border-l lg:border-[#D9E0E0] lg:pl-5">
          <h2 className="text-base font-semibold text-[#202525]">AROVA Wearable Sensor Stack</h2>
          <p className="text-xs text-[#737B7B] leading-relaxed">
            <span className="font-semibold text-[#202525]">ESP32 DevKit</span> ·{" "}
            <span className="font-semibold text-[#202525]">MAX30102 / MAX30100</span> pulse oximeter ·{" "}
            <span className="font-semibold text-[#202525]">MPU6050</span> 6-axis IMU (triaxial X/Y/Z) ·{" "}
            <span className="font-semibold text-[#202525]">DS18B20 / TMP117 / MLX90614</span> temperature ·{" "}
            <span className="font-semibold text-[#202525]">0.96&quot; SSD1306 OLED</span> (AROVA UI) ·{" "}
            <span className="font-semibold text-[#202525]">Transistor/MOSFET vibration motor</span> ·{" "}
            provisional <span className="font-semibold text-[#202525]">AD8232 ECG</span> · battery-isolated power.
          </p>
        </div>
      </section>

      {/* 2. Phase 3 Device Management & Live Sensor Availability Matrix */}
      <section className="arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-[#D9E0E0]">
          <div>
            <h3 className="text-base font-semibold text-[#202525]">
              Device Management &amp; Hardware Authentication
            </h3>
            <p className="text-xs text-[#737B7B] mt-0.5">
              Assigned wearable status, per-device{" "}
              <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                X-Device-Key
              </code>{" "}
              registration, sensor health, and remote connect/offline controls
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={registeringDevice}
              onClick={() => handleRegisterBackend(false)}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {backendDevice ? "Sync / Rotate Key" : "Register & Generate X-Device-Key"}
            </button>
            {backendDevice && (
              <button
                type="button"
                disabled={registeringDevice}
                onClick={() => handleRegisterBackend(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] cursor-pointer transition-colors"
              >
                Rotate Key
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                setDeviceConnectionState(
                  deviceId,
                  effectiveStatus === "streaming" ? "offline" : "not_connected"
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] cursor-pointer transition-colors"
            >
              {effectiveStatus === "streaming" ? (
                <>
                  <WifiOff className="w-3.5 h-3.5" />
                  Mark Offline
                </>
              ) : (
                <>
                  <Wifi className="w-3.5 h-3.5" />
                  Reset Link State
                </>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Device Name</div>
            <div className="font-semibold text-[#202525] mt-0.5 truncate">
              {activeDevice?.label ?? label}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Device ID</div>
            <div className="font-mono font-semibold text-[#008F00] mt-0.5 truncate">{deviceId}</div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Assigned Patient</div>
            <div className="font-semibold text-[#202525] mt-0.5 truncate">
              {selectedPatient.displayName}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Connection Status</div>
            <div className="font-mono font-semibold text-[#008F00] mt-0.5">{effectiveStatus}</div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Last Seen &amp; Source</div>
            <div className="font-mono text-[#202525] mt-0.5 truncate">
              {effectiveLastSeen
                ? new Date(effectiveLastSeen).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "Never"}{" "}
              · {effectiveSource}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
            <div className="text-[#737B7B]">Firmware &amp; Auth</div>
            <div className="font-mono text-[#202525] mt-0.5 truncate">
              {firmwareVer} · {backendDevice?.maskedToken ?? "No per-device key"}
            </div>
          </div>
        </div>

        {/* Sensor Availability Matrix + Latest Reading Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-1">
          <div className="border border-[#D9E0E0] bg-[#F7F9F9] rounded-xl p-3.5 space-y-2">
            <div className="text-xs font-semibold text-[#202525]">On-Device Sensor Availability</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              {[
                { label: "Pulse Oximeter", ok: sensorAvail.pulseOximeter },
                { label: "Temperature", ok: sensorAvail.temperature },
                { label: "MPU6050 IMU", ok: sensorAvail.imu },
                { label: "AD8232 ECG", ok: sensorAvail.ecg },
                { label: "SSD1306 OLED", ok: sensorAvail.oled },
                { label: "Vibration Motor", ok: sensorAvail.vibrationMotor },
              ].map((s) => (
                <div
                  key={s.label}
                  className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between ${
                    s.ok
                      ? "bg-[#00B800]/10 border-[#00B800]/30 text-[#008F00]"
                      : "bg-white border-[#D9E0E0] text-[#737B7B]"
                  }`}
                >
                  <span>{s.label}</span>
                  <span className="font-mono font-semibold">{s.ok ? "OK" : "N/A"}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-[#D9E0E0] bg-[#F7F9F9] rounded-xl p-3.5 space-y-2">
            <div className="text-xs font-semibold text-[#202525]">
              Latest Received Telemetry Summary
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-white border border-[#D9E0E0] rounded-lg p-2">
                <div className="text-[#737B7B] font-sans">Heart Rate</div>
                <div className="text-[#008F00] font-semibold mt-0.5 tabular-nums">{liveHrText}</div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-lg p-2">
                <div className="text-[#737B7B] font-sans">Est. SpO₂</div>
                <div className="text-[#008F00] font-semibold mt-0.5 tabular-nums">{liveSpo2Text}</div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-lg p-2">
                <div className="text-[#737B7B] font-sans">Temperature</div>
                <div className="text-[#202525] font-semibold mt-0.5 tabular-nums">
                  {liveTempText}
                </div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-lg p-2">
                <div className="text-[#737B7B] font-sans">Accel (X/Y/Z)</div>
                <div className="text-[#202525] font-semibold mt-0.5 truncate tabular-nums">
                  {latestReading &&
                  typeof latestReading.accelX === "number" &&
                  typeof latestReading.accelY === "number" &&
                  typeof latestReading.accelZ === "number"
                    ? `${latestReading.accelX.toFixed(1)},${latestReading.accelY.toFixed(
                        1
                      )},${latestReading.accelZ.toFixed(1)}`
                    : latestReading?.accelMagnitude
                    ? `${latestReading.accelMagnitude.toFixed(2)} g`
                    : "--"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {generatedDeviceKey && (
          <div className="bg-[#00B800]/10 border border-[#00B800]/30 rounded-xl p-3.5 space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[#008F00]">
                Per-Device API Key Generated (copy now into /firmware/arova_secrets.h as SECRET_DEVICE_KEY)
              </span>
              <button
                type="button"
                onClick={handleCopyKey}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-[#00B800]/35 rounded-md font-medium text-[#008F00] hover:bg-[#F7F9F9] cursor-pointer"
              >
                {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey ? "Copied" : "Copy Key"}
              </button>
            </div>
            <code className="block font-mono bg-[#080B0B] border border-[#1E2525] rounded px-2.5 py-1.5 text-[#B8F5B8] break-all">
              {generatedDeviceKey}
            </code>
          </div>
        )}

        {deviceActionMessage && (
          <p className="text-xs text-[#008F00] font-medium">{deviceActionMessage}</p>
        )}
      </section>

      {/* 3. Simulation Mode (Test Only) + Vibration Alert Motor Control */}
      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-semibold text-[#202525]">Wearable Simulation Mode</h3>
                <span className="px-2 py-0.5 text-[11px] font-semibold bg-amber-50 border border-amber-300 text-amber-800 rounded">
                  TEST ONLY · NOT REAL HARDWARE
                </span>
              </div>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Simulates real-time ESP32 telemetry (
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  source: &quot;simulator&quot;
                </code>
                ) through backend + Firestore + dashboard
              </p>
            </div>
            <Activity className="w-4 h-4 text-[#00B800] shrink-0" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Stream Mode</span>
              <select
                value={simMode}
                onChange={(e) => setSimMode(e.target.value as "normal" | "unusual")}
                className="w-full px-2.5 py-1.5 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="normal">Normal Resting Pattern</option>
                <option value="unusual">Unusual / Critical Pattern</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Sensor Error Injection</span>
              <select
                value={simSensorError}
                onChange={(e) => setSimSensorError(e.target.value as SimSensorErrorMode)}
                className="w-full px-2.5 py-1.5 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="none">None (All Sensors Healthy)</option>
                <option value="poor_contact">PulseOx Poor Contact (null)</option>
                <option value="temp_disconnected">Temp Disconnected (null)</option>
                <option value="ecg_lead_off">AD8232 Lead-Off</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Stream Interval</span>
              <select
                value={simIntervalMs}
                onChange={(e) => setSimIntervalMs(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] font-mono focus:outline-none focus:border-[#00B800]"
              >
                <option value={1500}>1500 ms</option>
                <option value={2500}>2500 ms</option>
                <option value={5000}>5000 ms</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            {!simRunning ? (
              <button
                type="button"
                onClick={() => startSimulation(simMode)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg cursor-pointer transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                Start Simulation
              </button>
            ) : (
              <button
                type="button"
                onClick={stopSimulation}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 cursor-pointer transition-colors"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Simulation
              </button>
            )}

            <button
              type="button"
              onClick={() => void generateNormalReading()}
              className="px-3 py-2 text-xs font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] cursor-pointer transition-colors"
            >
              Generate Normal
            </button>
            <button
              type="button"
              onClick={() => void generateUnusualReading()}
              className="px-3 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 cursor-pointer transition-colors"
            >
              Generate Unusual
            </button>
            {simDeviceConnected ? (
              <button
                type="button"
                onClick={() => void disconnectSimulatedDevice()}
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] cursor-pointer transition-colors"
              >
                <Power className="w-3.5 h-3.5" />
                Disconnect Simulated Device
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void reconnectSimulatedDevice()}
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-[#008F00] bg-[#00B800]/10 border border-[#00B800]/30 rounded-lg hover:bg-[#00B800]/20 cursor-pointer transition-colors"
              >
                <Wifi className="w-3.5 h-3.5" />
                Reconnect Simulated Device
              </button>
            )}
          </div>

          <div className="text-xs bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg px-3 py-2 text-[#202525]">
            {simLastPacketSummary ??
              `Simulated device is ${simDeviceConnected ? "ready" : "disconnected"} (${
                simRunning ? "streaming" : "stopped"
              }).`}
          </div>
        </section>

        {/* Task 8: Vibration Motor Alert Control */}
        <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                Vibration Motor Alert Control (GPIO 25 · MOSFET/NPN)
              </h3>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Queues backend haptic alert commands delivered in{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  /api/wearable/ingest
                </code>{" "}
                &amp;{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  /api/wearable/commands
                </code>
              </p>
            </div>
            <Vibrate className="w-4 h-4 text-[#00B800] shrink-0" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Pulse Duration (ms)</span>
              <input
                type="number"
                min={100}
                max={5000}
                step={50}
                value={vibDurationMs}
                onChange={(e) => setVibDurationMs(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2.5 text-[#737B7B] leading-relaxed">
              Driver hardware: Logic-level MOSFET / NPN transistor + 1k gate resistor + 1N5819
              flyback diode (non-blocking{" "}
              <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                millis()
              </code>{" "}
              PWM).
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sendingVib}
              onClick={() => void handleHapticCommand("activate", "single_pulse")}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
            >
              Activate Single Pulse
            </button>
            <button
              type="button"
              disabled={sendingVib}
              onClick={() => void handleHapticCommand("activate", "triple_alert")}
              className="px-3.5 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 disabled:opacity-50 cursor-pointer transition-colors"
            >
              Activate Triple Emergency Alert
            </button>
            <button
              type="button"
              disabled={sendingVib}
              onClick={() => void handleHapticCommand("deactivate", "none")}
              className="px-3.5 py-2 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-50 cursor-pointer transition-colors"
            >
              Deactivate Motor
            </button>
          </div>

          {vibFeedback && (
            <p className="text-xs text-[#202525] bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2.5 leading-relaxed">
              {vibFeedback}
            </p>
          )}
        </section>
      </div>

      {/* 4. Live / Historical AD8232 ECG Stream Inspector */}
      <EcgWaveformPanel
        segments={ecgSegments}
        compact
        title="AD8232 Batched ECG Stream Inspector"
      />

      {/* 5. Configurable Sensor Mapping Form + Phase 3 JSON Contract */}
      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleSaveDevice}
          className="arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4"
        >
          <div>
            <h3 className="text-base font-semibold text-[#202525]">Hardware Profile Configuration</h3>
            <p className="text-xs text-[#737B7B] mt-0.5">
              Select MAX30102 (default) or MAX30100 pulse oximeter, AD8232 ECG posture, and
              physical temperature sensor
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Device ID</span>
              <input
                type="text"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Display Label</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Pulse Oximeter</span>
              <select
                value={pulseOxVariant}
                onChange={(e) => setPulseOxVariant(e.target.value)}
                className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="MAX30102 (Default)">MAX30102 (Default)</option>
                <option value="MAX30100 (OXullo)">MAX30100 (OXullo)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">ECG Module (Provisional)</span>
              <select
                value={ecgSensor}
                onChange={(e) => setEcgSensor(e.target.value)}
                className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="AD8232 Single-Lead ECG (Provisional)">
                  AD8232 Single-Lead ECG (Provisional)
                </option>
                <option value="AD8232 Disabled / Unconnected">
                  AD8232 Disabled / Unconnected
                </option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Temperature Sensor</span>
              <select
                value={tempSensor}
                onChange={(e) => setTempSensor(e.target.value)}
                className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="DS18B20 Digital Probe">DS18B20 Digital Probe</option>
                <option value="TMP117 High-Accuracy I2C">TMP117 High-Accuracy I2C</option>
                <option value="MLX90614 IR Sensor">MLX90614 IR Sensor</option>
                <option value="Configurable (Model Pending Confirmation)">
                  Configurable (Model Pending Confirmation)
                </option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Batch Upload Interval (ms)</span>
              <input
                type="number"
                min={500}
                max={60000}
                value={samplingMs}
                onChange={(e) => setSamplingMs(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-[#737B7B] block">Firmware Tag</span>
              <input
                type="text"
                value={firmwareVer}
                onChange={(e) => setFirmwareVer(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            {saveMessage ? (
              <span className="text-xs text-[#008F00] font-medium">{saveMessage}</span>
            ) : (
              <span className="text-xs text-[#737B7B]">
                ESP32 DevKit · MPU6050 · 0.96&quot; SSD1306 · Transistor Vibration · Battery Power
              </span>
            )}
            <button
              type="submit"
              className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              Save Hardware Config
            </button>
          </div>
        </form>

        {/* ESP32 JSON Contract & Ingestion Inspector */}
        <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                ESP32 Wi-Fi JSON Contract (Phase 3)
              </h3>
              <p className="text-xs text-[#737B7B] mt-0.5">
                POST /api/wearable/ingest · Supports snake_case Phase 3 &amp; camelCase Phase 2 +{" "}
                <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                  X-Device-Key
                </code>
              </p>
            </div>
            <button
              type="button"
              onClick={loadEvents}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh Buffer
            </button>
          </div>

          <pre className="bg-[#080B0B] border border-[#1E2525] text-[#B8F5B8] rounded-xl p-3.5 text-xs font-mono overflow-x-auto leading-relaxed">
{`{
  "device_id": "${deviceId}",
  "patient_id": "${selectedPatient.patientId}",
  "timestamp": "2026-11-27T12:00:00Z",
  "heart_rate_bpm": 74.0,
  "spo2_percent": 98.0,
  "temperature_c": 36.7,
  "accel_x": 0.02,
  "accel_y": -0.01,
  "accel_z": 0.99,
  "movementStatus": "resting",
  "sensor_quality": "good",
  "source": "real"
}`}
          </pre>

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[#202525]">
              Recent Server Ingest Buffer ({liveEvents.length})
            </h4>
            {liveEvents.length === 0 ? (
              <p className="text-xs text-[#737B7B]">
                No packets received in server memory yet. Start Simulation Mode or POST from an
                ESP32 board.
              </p>
            ) : (
              <div className="max-h-36 overflow-y-auto divide-y divide-[#EEF2F2] border border-[#D9E0E0] bg-[#F7F9F9] rounded-lg">
                {liveEvents.slice(0, 5).map((ev, idx) => (
                  <div key={idx} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                    <span className="font-mono text-[#202525]">
                      {String(ev.deviceId)} ·{" "}
                      {typeof ev.heartRate === "number" ? `${ev.heartRate} BPM` : "-- BPM"} ·{" "}
                      {typeof ev.spo2 === "number" ? `${ev.spo2}%` : "--%"} ·{" "}
                      {typeof ev.temperatureC === "number" ? `${ev.temperatureC}°C` : "--°C"}
                    </span>
                    <span className="font-mono text-[#008F00]">
                      {String(ev.source)} · {String(ev.alertLevel)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* 6. Proposed ESP32 Pinout, Libraries & Electrical Safety Precautions */}
      <section className="arova-float-card-subtle arova-float-delay-4 arova-glass-card rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[#202525]">
              Proposed ESP32 DevKit Wiring, Verified Arduino Libraries &amp; Safety Precautions
            </h3>
            <p className="text-xs text-[#737B7B] mt-0.5">
              See{" "}
              <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                /HARDWARE_GUIDE.md
              </code>{" "}
              and{" "}
              <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
                /firmware/arova_wearable_esp32.ino
              </code>{" "}
              — confirm physical pins before soldering
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#D9E0E0] text-[#737B7B]">
                  <th className="py-2 pr-3">Module</th>
                  <th className="py-2 pr-3">Proposed ESP32 Pins</th>
                  <th className="py-2">Verified Library / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F2] text-[#737B7B]">
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">MAX30102 / MAX30100</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    SDA GPIO 21 · SCL GPIO 22 (0x57)
                  </td>
                  <td className="py-2">
                    SparkFun{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      MAX3010x
                    </code>{" "}
                    (MAX30102) or OXullo{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      MAX30100lib
                    </code>
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">MPU6050 IMU</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    SDA GPIO 21 · SCL GPIO 22 (0x68)
                  </td>
                  <td className="py-2">
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      Adafruit_MPU6050
                    </code>{" "}
                    +{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      Adafruit_Sensor
                    </code>{" "}
                    (accel_x/y/z)
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">0.96&quot; SSD1306 OLED</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    SDA GPIO 21 · SCL GPIO 22 (0x3C)
                  </td>
                  <td className="py-2">
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      Adafruit_SSD1306
                    </code>{" "}
                    +{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      Adafruit_GFX
                    </code>{" "}
                    (AROVA UI)
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">Temperature Probe</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    GPIO 4 (DS18B20) or I2C 0x48 / 0x5A
                  </td>
                  <td className="py-2">
                    Rejects{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      -127
                    </code>
                    /
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      85
                    </code>{" "}
                    sentinels as JSON{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      null
                    </code>
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">Vibration Motor</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    GPIO 25 via Transistor / MOSFET
                  </td>
                  <td className="py-2">
                    Non-blocking{" "}
                    <code className="font-mono text-[#202525] bg-[#EEF2F2] px-1 py-0.5 rounded">
                      millis()
                    </code>{" "}
                    + 1N5819 flyback diode
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-medium text-[#202525]">AD8232 ECG (Prov.)</td>
                  <td className="py-2 pr-3 font-mono text-[#008F00]">
                    OUT GPIO 34 (ADC1) · LO+ 32 · LO- 33
                  </td>
                  <td className="py-2">
                    Battery-isolated only; never use ADC2 when Wi-Fi is active
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-2 text-xs text-amber-900 leading-relaxed">
            <div className="flex items-center gap-2 font-semibold text-amber-950">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Critical Hardware &amp; Electrical Safety Precautions</span>
            </div>
            <ul className="list-disc list-inside space-y-1.5 text-amber-900">
              <li>
                <span className="font-semibold text-amber-950">Battery-Isolated Operation:</span>{" "}
                Operate AD8232/wearable on an isolated LiPo/Li-ion battery during body contact;
                disconnect mains USB/chargers before attaching electrodes.
              </li>
              <li>
                <span className="font-semibold text-amber-950">3.3V Logic Only:</span> ESP32 GPIOs are
                3.3V-only (never apply 5V to SDA/SCL or ADC pins). Verify breakout pull-ups if
                MAX30100/MAX30102 fails I²C scan.
              </li>
              <li>
                <span className="font-semibold text-amber-950">Transistor Motor Driver:</span> Never
                drive a vibration motor directly from an ESP32 GPIO; always use an NPN/MOSFET driver
                with base/gate resistor and flyback diode.
              </li>
              <li>
                <span className="font-semibold text-amber-950">Wi-Fi 2.4 GHz Only:</span> ESP32 DevKit
                does not support 5 GHz Wi-Fi SSIDs. Configure 2.4 GHz credentials in{" "}
                <code className="font-mono text-[#008F00] bg-white px-1 py-0.5 rounded border border-amber-200">
                  /firmware/arova_secrets.h
                </code>
                .
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* 7. Quick Integration & Setup Checklist */}
      <section className="arova-float-card-subtle arova-float-delay-5 arova-glass-card rounded-2xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-[#202525]">
              ESP32 Connection &amp; Troubleshooting Checklist
            </h3>
            <p className="text-xs text-[#737B7B] mt-0.5">
              Gateway auth status:{" "}
              <span className="font-mono text-[#008F00] font-medium">
                {integrations?.wearableIngest.tokenProtected
                  ? "Global WEARABLE_INGEST_TOKEN + per-device X-Device-Key active"
                  : backendDevice?.tokenProtected
                  ? `Per-device X-Device-Key active (${backendDevice.maskedToken})`
                  : "Development mode (register device above for per-device X-Device-Key)"}
              </span>
            </p>
          </div>
        </div>

        <ol className="list-decimal list-inside space-y-1.5 text-xs text-[#202525] leading-relaxed">
          <li>
            Click <strong className="text-[#202525]">Register &amp; Generate X-Device-Key</strong> above
            and copy the generated device key.
          </li>
          <li>
            Copy{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              /firmware/arova_secrets.example.h
            </code>{" "}
            to{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              /firmware/arova_secrets.h
            </code>{" "}
            and enter your 2.4 GHz Wi-Fi SSID, password, backend{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              /api/wearable/ingest
            </code>{" "}
            URL, and{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              SECRET_DEVICE_KEY
            </code>
            .
          </li>
          <li>
            Flash{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              /firmware/arova_wearable_esp32.ino
            </code>{" "}
            at 115200 baud via Arduino IDE / PlatformIO and confirm the SSD1306 OLED displays{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              AROVA LIVE
            </code>
            .
          </li>
          <li>
            Keep Firebase Admin secrets off the ESP32 — the firmware authenticates exclusively to the
            Node backend, which updates Firestore and the live Patient Dashboard. Full guide in{" "}
            <code className="font-mono text-[#008F00] bg-[#EEF2F2] px-1 py-0.5 rounded">
              /HARDWARE_GUIDE.md
            </code>
            .
          </li>
        </ol>
      </section>
    </div>
  );
}
