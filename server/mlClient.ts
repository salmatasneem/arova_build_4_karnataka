import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sharedAlertDecisionEngine } from "./alertDecisionEngine.ts";
import { sharedBaselineTracker } from "./baselineTracker.ts";
import { extractEcgFeatures } from "./ecgProcessor.ts";
import { extractWindowFeatures, sharedWindowStore } from "./featureExtractor.ts";
import type {
  AlertLevel,
  AnomalyStatus,
  AvailableModalities,
  BaselineProgress,
  EcgSignalQuality,
  MlAnalysisResult,
  MlBaselineSummaryStats,
  MlDetectionConfig,
  MlEvaluationResult,
  MlGraphMeta,
  MlModelMetadata,
  MovementStatus,
  PredictionClassification,
  PredictionStage,
  SignalQuality,
  TelemetryPayload,
  TelemetrySource,
  TemperatureSite,
} from "./types.ts";

let managedMlServiceUrl: string | null = null;
let managedMlProcess: ChildProcess | null = null;

const DEFAULT_DETECTION_CONFIG: MlDetectionConfig = {
  contamination: 0.05,
  nEstimators: 150,
  retrainInterval: 10,
  baselineMinSamples: 20,
  warningPersistenceWindows: 2,
  criticalPersistenceWindows: 3,
  anomalyScoreWarning: -0.05,
  anomalyScoreCritical: -0.18,
  zScoreWarning: 2.0,
  zScoreCritical: 3.0,
};

let localConfig: MlDetectionConfig = { ...DEFAULT_DETECTION_CONFIG };
const nodeHistoryByKey = new Map<string, Array<Record<string, unknown>>>();

const SAFE_GRAPH_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.png$/;

function historyKey(patientId: string, source: TelemetrySource): string {
  return `${patientId}::${source}`;
}

function recordNodeHistory(
  patientId: string,
  source: TelemetrySource,
  entry: Record<string, unknown>
): void {
  const key = historyKey(patientId, source);
  const arr = nodeHistoryByKey.get(key) ?? [];
  arr.push(entry);
  if (arr.length > 300) arr.shift();
  nodeHistoryByKey.set(key, arr);
}

export function getNodeAnalysisHistory(
  patientId: string,
  source?: TelemetrySource,
  limit = 200
): Array<Record<string, unknown>> {
  if (source) {
    return [...(nodeHistoryByKey.get(historyKey(patientId, source)) ?? [])].slice(-limit);
  }
  const merged: Array<Record<string, unknown>> = [];
  for (const [k, items] of nodeHistoryByKey.entries()) {
    if (k.startsWith(`${patientId}::`) && !k.endsWith("::dataset_playback")) {
      merged.push(...items);
    }
  }
  merged.sort((a, b) => Number(a.timestamp_sec ?? 0) - Number(b.timestamp_sec ?? 0));
  return merged.slice(-limit);
}

export function classifyPrediction(
  payload: Pick<TelemetryPayload, "possibleFallDetected" | "movementStatus" | "accelMagnitude">,
  analysis: Pick<MlAnalysisResult, "anomalyStatus" | "alertLevel" | "triggeredMetrics">
): PredictionClassification {
  const isPoorQuality = analysis.anomalyStatus === "paused_poor_quality";
  const anomalousWindow = !isPoorQuality && analysis.anomalyStatus === "anomalous";
  const alertTriggered =
    !isPoorQuality && (analysis.alertLevel === "Warning" || analysis.alertLevel === "Critical");
  const hasFallCue =
    Boolean(payload.possibleFallDetected) ||
    payload.movementStatus === "fall_suspect" ||
    payload.accelMagnitude >= 2.8 ||
    analysis.triggeredMetrics.some((m) => /movement|fall/i.test(m));
  const potentialFallAlert = !isPoorQuality && hasFallCue;
  const confirmedFallEvent = !isPoorQuality && alertTriggered && hasFallCue;

  let stage: PredictionStage;
  if (isPoorQuality) {
    stage = "paused_poor_quality";
  } else if (confirmedFallEvent) {
    stage = "confirmed_fall_event";
  } else if (alertTriggered) {
    stage = "confirmed_physiological_alert";
  } else if (potentialFallAlert) {
    stage = "potential_fall_alert";
  } else if (anomalousWindow) {
    stage = "anomalous_sensor_window";
  } else if (analysis.anomalyStatus === "insufficient_baseline") {
    stage = "insufficient_baseline";
  } else {
    stage = "normal";
  }

  return {
    stage,
    anomalousWindow,
    potentialFallAlert,
    alertTriggered,
    confirmedFallEvent,
  };
}

function getMlServiceUrl(): string | null {
  const raw = process.env.ML_SERVICE_URL?.trim() || managedMlServiceUrl;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function pingMlHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function startManagedMlService(): Promise<boolean> {
  const envUrl = process.env.ML_SERVICE_URL?.trim();
  if (envUrl) {
    return await pingMlHealth(envUrl.replace(/\/$/, ""));
  }

  const candidateUrl = "http://127.0.0.1:18000";
  if (await pingMlHealth(candidateUrl)) {
    managedMlServiceUrl = candidateUrl;
    return true;
  }

  const mlDir = path.resolve(process.cwd(), "ml-service");
  const candidateBins = [
    path.join(mlDir, ".venv", "bin", "uvicorn"),
    "/opt/arova-ml-venv/bin/uvicorn",
  ];
  const venvUvicorn = candidateBins.find((p) => fs.existsSync(p));
  if (!venvUvicorn) {
    return false;
  }

  if (!managedMlProcess) {
    managedMlProcess = spawn(
      venvUvicorn,
      ["main:app", "--host", "127.0.0.1", "--port", "18000", "--log-level", "warning"],
      {
        cwd: mlDir,
        stdio: "ignore",
      }
    );
    managedMlProcess.once("exit", () => {
      managedMlProcess = null;
      if (managedMlServiceUrl === candidateUrl) {
        managedMlServiceUrl = null;
      }
    });
  }

  const deadline = Date.now() + 8500;
  while (Date.now() < deadline) {
    if (await pingMlHealth(candidateUrl)) {
      managedMlServiceUrl = candidateUrl;
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

export function stopManagedMlService(): void {
  if (managedMlProcess) {
    try {
      managedMlProcess.kill("SIGTERM");
    } catch {
      // Ignore already exited
    }
    managedMlProcess = null;
  }
  managedMlServiceUrl = null;
}

export async function checkMlServiceHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  urlConfigured: boolean;
  demoMode: boolean;
  engineLabel: string;
}> {
  const baseUrl = getMlServiceUrl();
  if (!baseUrl) {
    return {
      configured: false,
      reachable: false,
      urlConfigured: false,
      demoMode: true,
      engineLabel: "Demo Mode · Python Isolation Forest Not Connected",
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        configured: true,
        reachable: false,
        urlConfigured: true,
        demoMode: true,
        engineLabel: "Demo Mode · Python FastAPI Service Unreachable",
      };
    }
    return {
      configured: true,
      reachable: true,
      urlConfigured: true,
      demoMode: false,
      engineLabel: "Python FastAPI + scikit-learn Isolation Forest (Connected)",
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      urlConfigured: true,
      demoMode: true,
      engineLabel: "Demo Mode · Python FastAPI Service Unreachable",
    };
  }
}

export function validateSensorQuality(payload: TelemetryPayload): {
  signalQuality: SignalQuality;
  notes: string[];
} {
  const notes: string[] = [];
  const isDatasetPlayback = payload.source === "dataset_playback";
  const hrExpected = !isDatasetPlayback || payload.availableModalities?.heartRate !== false;
  const spo2Expected = !isDatasetPlayback || payload.availableModalities?.spo2 !== false;

  if (payload.fingerDetected === false || payload.irSignalOk === false) {
    notes.push("MAX30100 optical sensor reports no finger detected or low IR perfusion.");
  } else {
    if (hrExpected && (payload.heartRate === null || payload.heartRate === 0)) {
      notes.push("MAX30100 optical sensor reports no finger detected or low IR perfusion.");
    } else if (payload.heartRate !== null && (payload.heartRate < 30 || payload.heartRate > 230)) {
      notes.push(`Heart rate (${payload.heartRate} BPM) outside valid physiological sensor bounds.`);
    }

    if (spo2Expected && (payload.spo2 === null || payload.spo2 === 0)) {
      notes.push("MAX30100 optical sensor reports missing or invalid SpO2 optical signal.");
    } else if (payload.spo2 !== null && (payload.spo2 < 50 || payload.spo2 > 100)) {
      notes.push(`SpO2 (${payload.spo2}%) outside valid pulse oximetry bounds.`);
    }
  }

  const minTemp = isDatasetPlayback && payload.temperatureSite === "skin_wrist" ? 25 : 30;
  if (payload.temperatureC !== null && (payload.temperatureC < minTemp || payload.temperatureC > 43)) {
    notes.push(`Temperature (${payload.temperatureC} °C) suggests probe detachment or sensor fault.`);
  }

  if (notes.length > 0) {
    return { signalQuality: "poor_contact", notes };
  }
  if (payload.accelMagnitude > 2.6) {
    return {
      signalQuality: "noisy",
      notes: ["High MPU6050 movement detected; optical PPG reading may contain motion noise."],
    };
  }
  return { signalQuality: "good", notes: [] };
}

function buildPlainLanguageExplanations(params: {
  triggeredMetrics: string[];
  anomalyStatus: AnomalyStatus;
  signalQuality: SignalQuality;
  matchedContext: string;
}): string[] {
  if (params.anomalyStatus === "paused_poor_quality" || params.signalQuality === "poor_contact") {
    return [
      "Sensor contact or signal quality is insufficient; anomaly detection is paused until clean readings resume.",
    ];
  }
  if (params.anomalyStatus === "insufficient_baseline") {
    return [
      "Still learning this patient's personal baseline from clean historical readings.",
    ];
  }
  if (params.anomalyStatus !== "anomalous") {
    return [
      `Readings align with this patient's learned ${params.matchedContext} baseline.`,
    ];
  }

  const out: string[] = [];
  for (const metric of params.triggeredMetrics) {
    const low = metric.toLowerCase();
    if (low.includes("heart rate") && !low.includes("ecg")) {
      out.push("Heart-rate reading differs from this patient's learned baseline.");
    } else if (low.includes("spo2")) {
      out.push("Blood oxygen (SpO2) reading differs from this patient's learned baseline.");
    } else if (low.includes("temperature")) {
      out.push("Temperature reading differs from this patient's learned baseline.");
    } else if (low.includes("movement") || low.includes("fall")) {
      out.push("Movement pattern differs from this patient's learned baseline.");
    } else if (low.includes("ecg")) {
      out.push("AD8232 ECG rate differs from this patient's learned baseline.");
    }
  }
  if (out.length === 0) {
    out.push(
      "Combined sensor measurements form an unusual pattern compared with this patient's learned baseline."
    );
  }
  return out;
}

function mapPythonBaselineStats(
  raw: Record<string, unknown> | null | undefined,
  localProfile: ReturnType<typeof sharedBaselineTracker.getProfile>
): MlBaselineSummaryStats | null {
  if (raw && typeof raw === "object") {
    const means = raw.means as Record<string, number> | undefined;
    const medians = raw.medians as Record<string, number> | undefined;
    const stds = raw.stds as Record<string, number> | undefined;
    if (means && stds) {
      return {
        means: {
          heartRate: Number(means.heart_rate ?? means.heartRate ?? 72),
          spo2: Number(means.spo2 ?? 98),
          temperatureC: Number(means.temperature_c ?? means.temperatureC ?? 36.6),
          accelMagnitude: Number(means.accel_magnitude ?? means.accelMagnitude ?? 1),
          gyroMagnitude: Number(means.gyro_magnitude ?? means.gyroMagnitude ?? 4),
        },
        medians: {
          heartRate: Number(medians?.heart_rate ?? medians?.heartRate ?? means.heart_rate ?? 72),
          spo2: Number(medians?.spo2 ?? means.spo2 ?? 98),
          temperatureC: Number(medians?.temperature_c ?? medians?.temperatureC ?? means.temperature_c ?? 36.6),
          accelMagnitude: Number(medians?.accel_magnitude ?? medians?.accelMagnitude ?? means.accel_magnitude ?? 1),
          gyroMagnitude: Number(medians?.gyro_magnitude ?? medians?.gyroMagnitude ?? means.gyro_magnitude ?? 4),
        },
        stds: {
          heartRate: Number(stds.heart_rate ?? stds.heartRate ?? 6),
          spo2: Number(stds.spo2 ?? 1),
          temperatureC: Number(stds.temperature_c ?? stds.temperatureC ?? 0.35),
          accelMagnitude: Number(stds.accel_magnitude ?? stds.accelMagnitude ?? 0.15),
          gyroMagnitude: Number(stds.gyro_magnitude ?? stds.gyroMagnitude ?? 2),
        },
        resting: localProfile?.resting ?? null,
        active: localProfile?.active ?? null,
        sampleCount: Number(raw.sample_count ?? localProfile?.sampleCount ?? 0),
        updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : localProfile?.updatedAt ?? null,
      };
    }
  }

  if (!localProfile) return null;
  return {
    means: localProfile.means,
    medians: localProfile.medians,
    stds: localProfile.stds,
    resting: localProfile.resting,
    active: localProfile.active,
    sampleCount: localProfile.sampleCount,
    updatedAt: localProfile.updatedAt ?? localProfile.trainedAt,
  };
}

function mapPythonModelMeta(
  raw: Record<string, unknown> | null | undefined,
  localProfile: ReturnType<typeof sharedBaselineTracker.getProfile>
): MlModelMetadata | null {
  if (raw && typeof raw === "object") {
    return {
      modelVersion: typeof raw.model_version === "string" ? raw.model_version : localProfile?.modelVersion ?? null,
      trainedAt: typeof raw.trained_at === "string" ? raw.trained_at : localProfile?.trainedAt ?? null,
      updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : localProfile?.updatedAt ?? null,
      retrainCount: Number(raw.retrain_count ?? 0),
      sampleCount: Number(raw.sample_count ?? localProfile?.sampleCount ?? 0),
      contamination: Number(raw.contamination ?? localConfig.contamination),
      nEstimators: Number(raw.n_estimators ?? localConfig.nEstimators),
      retrainInterval: localConfig.retrainInterval,
    };
  }
  if (!localProfile) return null;
  return {
    modelVersion: localProfile.modelVersion,
    trainedAt: localProfile.trainedAt,
    updatedAt: localProfile.updatedAt ?? localProfile.trainedAt,
    retrainCount: 0,
    sampleCount: localProfile.sampleCount,
    contamination: localConfig.contamination,
    nEstimators: localConfig.nEstimators,
    retrainInterval: localConfig.retrainInterval,
  };
}

export async function analyzeTelemetry(payload: TelemetryPayload): Promise<MlAnalysisResult> {
  const source: TelemetrySource = payload.source ?? "simulator";
  const isSimulated = source !== "esp32_hardware";
  const timestampStr = payload.timestamp ?? new Date().toISOString();
  const parsedTs = Date.parse(timestampStr);
  const timestampMs = Number.isFinite(parsedTs) ? parsedTs : Date.now();
  const requiredSamples = Math.max(5, Math.round(payload.policyConfig?.baselineMinSamples ?? 20));
  const effectiveModalities = source === "dataset_playback" ? payload.availableModalities : undefined;

  const ecgFeatures =
    payload.ecgFeatures ??
    (Array.isArray(payload.ecgSamples) || payload.ecgLeadOff !== undefined || payload.ecgSignalQuality
      ? extractEcgFeatures({
          samples: payload.ecgSamples,
          samplingRateHz: payload.ecgSamplingRate,
          leadOff: payload.ecgLeadOff,
          reportedQuality: payload.ecgSignalQuality,
        })
      : undefined);

  const qualityCheck = validateSensorQuality(payload);
  const ecgLeadOff = Boolean(payload.ecgLeadOff || ecgFeatures?.signalQuality === "lead_off");

  const allowBaselineTraining = payload.allowBaselineTraining !== false;
  const opticalReadyForSource =
    source === "dataset_playback" || (payload.heartRate !== null && payload.spo2 !== null);

  let profile = sharedBaselineTracker.getProfile(payload.patientId, source);
  let baselineProgress = sharedBaselineTracker.getProgress(payload.patientId, source, requiredSamples);
  const baselineReady = Boolean(
    (profile && baselineProgress.status === "ready") || payload.baselineTrained === true
  );

  // Append to timestamp-ordered sliding window separated by (patientId, source)
  const window = sharedWindowStore.append(payload.patientId, source, {
    timestampMs,
    heartRate: payload.heartRate,
    spo2: payload.spo2,
    temperatureC: payload.temperatureC,
    accelMagnitude: payload.accelMagnitude,
    gyroMagnitude: payload.gyroMagnitude,
    movementStatus: payload.movementStatus,
    signalQuality: qualityCheck.signalQuality,
    ecgFeatures,
    ecgLeadOff,
  });

  const features = extractWindowFeatures({
    window,
    profile,
    fallbackBaselineMeans: payload.baselineMeans,
  });

  const maybeRecordCleanNormalBaseline = (
    resolvedStatus: AnomalyStatus,
    resolvedAlertLevel: AlertLevel
  ) => {
    const isAnomalyOrFall =
      resolvedStatus === "anomalous" ||
      resolvedAlertLevel !== "Normal" ||
      Boolean(payload.possibleFallDetected) ||
      payload.movementStatus === "fall_suspect";
    if (
      allowBaselineTraining &&
      !isAnomalyOrFall &&
      qualityCheck.signalQuality === "good" &&
      opticalReadyForSource &&
      (source === "esp32_hardware" || source === "simulator" || source === "dataset_playback")
    ) {
      const rec = sharedBaselineTracker.recordCleanSample(
        payload.patientId,
        source,
        {
          timestampMs,
          heartRate: payload.heartRate,
          spo2: payload.spo2,
          temperatureC: payload.temperatureC,
          accelMagnitude: payload.accelMagnitude,
          gyroMagnitude: payload.gyroMagnitude,
          movementStatus: payload.movementStatus,
          signalQuality: qualityCheck.signalQuality,
          ecgBpm: ecgFeatures?.estimatedEcgBpm ?? null,
          ecgRriMs: ecgFeatures?.rrIntervalMeanMs ?? null,
          ecgHrvMs: ecgFeatures?.rrVariabilityMs ?? null,
          ecgSignalQuality: ecgFeatures?.signalQuality ?? "unavailable",
          ecgLeadOff,
          temperatureSite: payload.temperatureSite,
          availableModalities: effectiveModalities,
        },
        requiredSamples
      );
      if (rec.profile) profile = rec.profile;
      baselineProgress = rec.progress;
    }
  };

  const baseUrl = getMlServiceUrl();
  if (baseUrl) {
    try {
      const sendAnalyze = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        try {
          return await fetch(`${baseUrl}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              patient_id: payload.patientId,
              source,
              timestamp: timestampStr,
              heart_rate: payload.heartRate,
              spo2: payload.spo2,
              temperature_c: payload.temperatureC,
              accel_magnitude: payload.accelMagnitude,
              gyro_magnitude: payload.gyroMagnitude,
              movement_status: payload.movementStatus,
              possible_fall_detected: Boolean(payload.possibleFallDetected),
              ir_signal_ok: payload.irSignalOk ?? true,
              finger_detected: payload.fingerDetected ?? true,
              baseline_min_samples: Math.max(20, requiredSamples),
              warning_persistence_windows: payload.policyConfig?.warningPersistenceWindows ?? 2,
              critical_persistence_windows: payload.policyConfig?.criticalPersistenceWindows ?? 3,
              anomaly_score_warning: payload.policyConfig?.anomalyScoreWarningThreshold ?? -0.05,
              available_modalities: effectiveModalities ?? null,
              temperature_site: payload.temperatureSite ?? null,
              respiratory_rate_bpm: payload.respiratoryRateBpm ?? null,
              sleep_stage: payload.sleepStage ?? null,
              allow_baseline_training: allowBaselineTraining,
              ecg_features: ecgFeatures
                ? {
                    sampling_rate_hz: ecgFeatures.samplingRateHz,
                    sample_count: ecgFeatures.sampleCount,
                    r_peak_count: ecgFeatures.rPeakCount,
                    estimated_ecg_bpm: ecgFeatures.estimatedEcgBpm,
                    rr_interval_mean_ms: ecgFeatures.rrIntervalMeanMs,
                    rr_variability_ms: ecgFeatures.rrVariabilityMs,
                    amplitude_range: ecgFeatures.amplitudeRange,
                    signal_quality: ecgFeatures.signalQuality,
                  }
                : null,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      };

      const res = await sendAnalyze();
      if (res.ok) {
        let data = (await res.json()) as {
          model_trained: boolean;
          model_version?: string | null;
          ecg_model_trained?: boolean;
          signal_quality: SignalQuality;
          anomaly_status?: AnomalyStatus;
          anomaly_score: number;
          alert_level: AlertLevel;
          triggered_metrics: string[];
          contributing_features?: string[];
          plain_language_explanations?: string[];
          persistence_count?: number;
          persistence_required?: number;
          matched_baseline_context?: string;
          window_size?: number;
          explanation: string;
          baseline_stats?: Record<string, unknown> | null;
          model_metadata?: Record<string, unknown> | null;
        };

        const effectiveIfMin = Math.max(20, requiredSamples);
        const cachedClean = sharedBaselineTracker.getSamples(payload.patientId, source);
        if (
          allowBaselineTraining &&
          !data.model_trained &&
          (source === "esp32_hardware" || source === "simulator" || source === "dataset_playback") &&
          cachedClean.length >= effectiveIfMin
        ) {
          const fitController = new AbortController();
          const fitTimer = setTimeout(() => fitController.abort(), 5000);
          try {
            const fitRes = await fetch(`${baseUrl}/baseline/fit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                patient_id: payload.patientId,
                source,
                min_samples: effectiveIfMin,
                available_modalities: effectiveModalities ?? null,
                temperature_site: payload.temperatureSite ?? null,
                samples: cachedClean.map((s) => ({
                  heart_rate: s.heartRate,
                  spo2: s.spo2,
                  temperature_c: s.temperatureC,
                  accel_magnitude: s.accelMagnitude,
                  gyro_magnitude: s.gyroMagnitude,
                  movement_status: s.movementStatus,
                  signal_quality: s.signalQuality,
                  timestamp: new Date(s.timestampMs).toISOString(),
                  ecg_bpm: s.ecgBpm ?? null,
                  ecg_rri_ms: s.ecgRriMs ?? null,
                  ecg_hrv_ms: s.ecgHrvMs ?? null,
                  ecg_signal_quality: s.ecgSignalQuality ?? "unavailable",
                  ecg_lead_off: Boolean(s.ecgLeadOff),
                })),
              }),
              signal: fitController.signal,
            });
            if (fitRes.ok) {
              const retryRes = await sendAnalyze();
              if (retryRes.ok) {
                data = (await retryRes.json()) as typeof data;
              }
            }
          } finally {
            clearTimeout(fitTimer);
          }
        }

        const resolvedAnomalyStatus: AnomalyStatus =
          data.anomaly_status ??
          (data.signal_quality === "poor_contact"
            ? "paused_poor_quality"
            : !data.model_trained
            ? "insufficient_baseline"
            : data.alert_level === "Normal"
            ? "normal"
            : "anomalous");
        const resolvedTriggered = Array.isArray(data.triggered_metrics) ? data.triggered_metrics : [];

        maybeRecordCleanNormalBaseline(resolvedAnomalyStatus, data.alert_level);

        const syncedProgress: BaselineProgress =
          data.model_trained && baselineProgress.status !== "ready"
            ? {
                ...baselineProgress,
                status: "ready",
                source,
                modelVersion: data.model_version ?? baselineProgress.modelVersion,
              }
            : {
                ...baselineProgress,
                modelVersion: data.model_version ?? baselineProgress.modelVersion,
              };

        const plainExplanations =
          Array.isArray(data.plain_language_explanations) && data.plain_language_explanations.length > 0
            ? data.plain_language_explanations
            : buildPlainLanguageExplanations({
                triggeredMetrics: resolvedTriggered,
                anomalyStatus: resolvedAnomalyStatus,
                signalQuality: data.signal_quality,
                matchedContext: data.matched_baseline_context ?? features.matchedBaselineContext,
              });

        recordNodeHistory(payload.patientId, source, {
          patient_id: payload.patientId,
          source,
          is_simulated: isSimulated,
          timestamp: timestampStr,
          timestamp_sec: timestampMs / 1000,
          heart_rate: payload.heartRate,
          spo2: payload.spo2,
          temperature_c: payload.temperatureC,
          accel_magnitude: payload.accelMagnitude,
          gyro_magnitude: payload.gyroMagnitude,
          movement_status: payload.movementStatus,
          signal_quality: data.signal_quality,
          anomaly_score: Number(data.anomaly_score),
          anomaly_status: resolvedAnomalyStatus,
          alert_level: data.alert_level,
          contributing_features: Array.isArray(data.contributing_features) ? data.contributing_features : [],
          plain_language_explanations: plainExplanations,
        });

        return {
          mlServiceConnected: true,
          mlEngine: "python_isolation_forest",
          modelTrained: Boolean(data.model_trained),
          modelVersion: data.model_version ?? profile?.modelVersion ?? null,
          ecgModelTrained: Boolean(data.ecg_model_trained),
          signalQuality: data.signal_quality,
          anomalyStatus: resolvedAnomalyStatus,
          anomalyScore: Number(data.anomaly_score),
          alertLevel: data.alert_level,
          triggeredMetrics: resolvedTriggered,
          contributingFeatures: Array.isArray(data.contributing_features) ? data.contributing_features : [],
          contributingDetails: features.contributingDetails.slice(0, 5),
          persistenceCount: Number(data.persistence_count ?? 0),
          persistenceRequired: Number(
            data.persistence_required ?? payload.policyConfig?.warningPersistenceWindows ?? 2
          ),
          matchedBaselineContext: data.matched_baseline_context ?? features.matchedBaselineContext,
          windowSize: Number(data.window_size ?? features.windowSize),
          baselineProgress: syncedProgress,
          explanation: data.explanation,
          plainLanguageExplanations: plainExplanations,
          timestamp: timestampStr,
          isSimulated,
          sensorValues: {
            heartRate: payload.heartRate,
            spo2: payload.spo2,
            temperatureC: payload.temperatureC,
            accelMagnitude: payload.accelMagnitude,
            gyroMagnitude: payload.gyroMagnitude,
            movementStatus: payload.movementStatus,
          },
          baselineStats: mapPythonBaselineStats(data.baseline_stats, profile),
          modelMetadata: mapPythonModelMeta(data.model_metadata, profile),
          ecgFeatures,
          predictionClassification: classifyPrediction(payload, {
            anomalyStatus: resolvedAnomalyStatus,
            alertLevel: data.alert_level,
            triggeredMetrics: resolvedTriggered,
          }),
        };
      }
    } catch {
      // Fall through honestly to local windowed decision engine marked as unconnected
    }
  }

  // Honest fallback when external Python FastAPI Isolation Forest service is not connected
  const decision = sharedAlertDecisionEngine.evaluate({
    patientId: payload.patientId,
    source,
    signalQuality: qualityCheck.signalQuality,
    qualityNotes: qualityCheck.notes,
    ecgLeadOff,
    heartRate: payload.heartRate,
    spo2: payload.spo2,
    temperatureC: payload.temperatureC,
    accelMagnitude: payload.accelMagnitude,
    possibleFallDetected: Boolean(payload.possibleFallDetected),
    baselineReady,
    baselineProgress,
    features,
    mlServiceConnected: false,
    policyInput: payload.policyConfig,
    availableModalities: effectiveModalities,
  });

  maybeRecordCleanNormalBaseline(decision.anomalyStatus, decision.alertLevel);

  const plainExplanations = buildPlainLanguageExplanations({
    triggeredMetrics: decision.triggeredMetrics,
    anomalyStatus: decision.anomalyStatus,
    signalQuality: qualityCheck.signalQuality,
    matchedContext: features.matchedBaselineContext,
  });

  recordNodeHistory(payload.patientId, source, {
    patient_id: payload.patientId,
    source,
    is_simulated: isSimulated,
    timestamp: timestampStr,
    timestamp_sec: timestampMs / 1000,
    heart_rate: payload.heartRate,
    spo2: payload.spo2,
    temperature_c: payload.temperatureC,
    accel_magnitude: payload.accelMagnitude,
    gyro_magnitude: payload.gyroMagnitude,
    movement_status: payload.movementStatus,
    signal_quality: qualityCheck.signalQuality,
    anomaly_score: decision.anomalyScore,
    anomaly_status: decision.anomalyStatus,
    alert_level: decision.alertLevel,
    contributing_features: decision.contributingFeatures,
    plain_language_explanations: plainExplanations,
  });

  return {
    mlServiceConnected: false,
    mlEngine: "unconnected_rule_check",
    modelTrained: Boolean(profile?.remotePythonTrained),
    modelVersion: profile?.modelVersion ?? null,
    ecgModelTrained: false,
    signalQuality: qualityCheck.signalQuality,
    anomalyStatus: decision.anomalyStatus,
    anomalyScore: decision.anomalyScore,
    alertLevel: decision.alertLevel,
    triggeredMetrics: decision.triggeredMetrics,
    contributingFeatures: decision.contributingFeatures,
    contributingDetails: features.contributingDetails.slice(0, 5),
    persistenceCount: decision.persistenceCount,
    persistenceRequired: decision.persistenceRequired,
    matchedBaselineContext: features.matchedBaselineContext,
    windowSize: features.windowSize,
    baselineProgress,
    explanation: decision.explanation,
    plainLanguageExplanations: plainExplanations,
    timestamp: timestampStr,
    isSimulated,
    sensorValues: {
      heartRate: payload.heartRate,
      spo2: payload.spo2,
      temperatureC: payload.temperatureC,
      accelMagnitude: payload.accelMagnitude,
      gyroMagnitude: payload.gyroMagnitude,
      movementStatus: payload.movementStatus,
    },
    baselineStats: mapPythonBaselineStats(null, profile),
    modelMetadata: mapPythonModelMeta(null, profile),
    ecgFeatures,
    predictionClassification: classifyPrediction(payload, {
      anomalyStatus: decision.anomalyStatus,
      alertLevel: decision.alertLevel,
      triggeredMetrics: decision.triggeredMetrics,
    }),
  };
}

export async function fitPatientBaselineRemote(
  patientId: string,
  samples: Array<{
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    accelMagnitude: number;
    gyroMagnitude: number;
    movementStatus?: MovementStatus;
    signalQuality?: SignalQuality;
    timestamp?: string;
    ecgBpm?: number | null;
    ecgRriMs?: number | null;
    ecgHrvMs?: number | null;
    ecgSignalQuality?: EcgSignalQuality;
    ecgLeadOff?: boolean;
    temperatureSite?: TemperatureSite | null;
  }>,
  options?: {
    source?: TelemetrySource;
    minSamples?: number;
    availableModalities?: AvailableModalities;
    temperatureSite?: TemperatureSite | null;
  }
): Promise<{
  mlServiceConnected: boolean;
  trained: boolean;
  baselineStatus: "not_started" | "collecting" | "ready";
  sampleCount: number;
  requiredSamples: number;
  source: TelemetrySource;
  modelVersion: string;
  restingSamples: number;
  activeSamples: number;
  ecgBaselineSamples: number;
  means: { heartRate: number; spo2: number; temperatureC: number };
  medians: { heartRate: number; spo2: number; temperatureC: number };
  stds: { heartRate: number; spo2: number; temperatureC: number };
  ecgBpmMean: number | null;
  activeHeartRateMean: number | null;
  message: string;
}> {
  const source: TelemetrySource = options?.source ?? "simulator";
  const minSamples = Math.max(5, Math.round(options?.minSamples ?? 20));
  const effectiveModalities = source === "dataset_playback" ? options?.availableModalities : undefined;

  const mappedSamples = samples.map((s) => ({
    timestampMs: s.timestamp && Number.isFinite(Date.parse(s.timestamp)) ? Date.parse(s.timestamp) : Date.now(),
    heartRate: typeof s.heartRate === "number" && Number.isFinite(s.heartRate) ? s.heartRate : null,
    spo2: typeof s.spo2 === "number" && Number.isFinite(s.spo2) ? s.spo2 : null,
    temperatureC: typeof s.temperatureC === "number" && Number.isFinite(s.temperatureC) ? s.temperatureC : null,
    accelMagnitude: s.accelMagnitude,
    gyroMagnitude: s.gyroMagnitude,
    movementStatus: s.movementStatus ?? ("resting" as MovementStatus),
    signalQuality: s.signalQuality ?? ("good" as SignalQuality),
    ecgBpm: s.ecgBpm ?? null,
    ecgRriMs: s.ecgRriMs ?? null,
    ecgHrvMs: s.ecgHrvMs ?? null,
    ecgSignalQuality: s.ecgSignalQuality ?? ("unavailable" as EcgSignalQuality),
    ecgLeadOff: Boolean(s.ecgLeadOff),
    temperatureSite: s.temperatureSite ?? options?.temperatureSite ?? null,
    availableModalities: effectiveModalities,
  }));

  let remoteTrained = false;
  let remoteConnected = false;
  let remoteModelVersion: string | null = null;

  const effectivePythonMin = Math.max(20, minSamples);
  const baseUrl = getMlServiceUrl();
  if (baseUrl && mappedSamples.length >= effectivePythonMin) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/baseline/fit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId,
          source,
          min_samples: effectivePythonMin,
          available_modalities: effectiveModalities ?? null,
          temperature_site: options?.temperatureSite ?? null,
          samples: mappedSamples.map((s) => ({
            heart_rate: s.heartRate,
            spo2: s.spo2,
            temperature_c: s.temperatureC,
            accel_magnitude: s.accelMagnitude,
            gyro_magnitude: s.gyroMagnitude,
            movement_status: s.movementStatus,
            signal_quality: s.signalQuality,
            timestamp: new Date(s.timestampMs).toISOString(),
            ecg_bpm: s.ecgBpm,
            ecg_rri_ms: s.ecgRriMs,
            ecg_hrv_ms: s.ecgHrvMs,
            ecg_signal_quality: s.ecgSignalQuality,
            ecg_lead_off: s.ecgLeadOff,
          })),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const remoteData = (await res.json()) as { trained?: boolean; model_version?: string };
        remoteConnected = true;
        remoteTrained = Boolean(remoteData.trained);
        remoteModelVersion = remoteData.model_version ?? null;
      }
    } catch {
      // Fall through honestly
    }
  }

  const profile = sharedBaselineTracker.fitBaseline(
    patientId,
    source,
    mappedSamples,
    minSamples,
    remoteTrained,
    remoteModelVersion
  );

  const baselineStatus: "not_started" | "collecting" | "ready" =
    profile.sampleCount >= minSamples ? "ready" : "collecting";

  const message = remoteTrained
    ? `Fitted personalized scikit-learn Isolation Forest (${profile.modelVersion}) on ${profile.sampleCount} quality-filtered ${source} readings.`
    : profile.sampleCount < minSamples
    ? `Collected ${profile.sampleCount}/${minSamples} quality-filtered ${source} readings (mean HR ${profile.means.heartRate.toFixed(1)} BPM, SpO2 ${profile.means.spo2.toFixed(1)}%). Collect at least ${minSamples} clean readings to complete personalized baseline learning.`
    : baseUrl && profile.sampleCount < effectivePythonMin
    ? `Computed statistical baseline on ${profile.sampleCount} ${source} readings; scikit-learn Isolation Forest requires at least ${effectivePythonMin} quality-filtered readings before fitting.`
    : `Computed personalized multi-context baseline (${profile.sampleCount} ${source} readings, resting=${profile.resting?.sampleCount ?? 0}, active=${profile.active?.sampleCount ?? 0}). Python FastAPI Isolation Forest service is not connected yet, so scikit-learn model persistence runs locally once connected.`;

  return {
    mlServiceConnected: remoteConnected,
    trained: remoteTrained,
    baselineStatus,
    sampleCount: profile.sampleCount,
    requiredSamples: minSamples,
    source,
    modelVersion: profile.modelVersion,
    restingSamples: profile.resting?.sampleCount ?? 0,
    activeSamples: profile.active?.sampleCount ?? 0,
    ecgBaselineSamples: profile.ecgBaselineSamples,
    means: {
      heartRate: Number(profile.means.heartRate.toFixed(1)),
      spo2: Number(profile.means.spo2.toFixed(1)),
      temperatureC: Number(profile.means.temperatureC.toFixed(2)),
    },
    medians: {
      heartRate: Number(profile.medians.heartRate.toFixed(1)),
      spo2: Number(profile.medians.spo2.toFixed(1)),
      temperatureC: Number(profile.medians.temperatureC.toFixed(2)),
    },
    stds: {
      heartRate: Number(profile.stds.heartRate.toFixed(2)),
      spo2: Number(profile.stds.spo2.toFixed(2)),
      temperatureC: Number(profile.stds.temperatureC.toFixed(2)),
    },
    ecgBpmMean: profile.ecgBpmMean,
    activeHeartRateMean: profile.active?.heartRateMean ?? null,
    message,
  };
}

export function getPatientBaselineStatusSummary(
  patientId: string,
  requiredSamples = 20
): {
  patientId: string;
  esp32Hardware: BaselineProgress;
  simulator: BaselineProgress;
  activeBaseline: BaselineProgress;
} {
  const hw = sharedBaselineTracker.getProgress(patientId, "esp32_hardware", requiredSamples);
  const sim = sharedBaselineTracker.getProgress(patientId, "simulator", requiredSamples);
  const activeBaseline = hw.collectedSamples > 0 ? hw : sim;
  return {
    patientId,
    esp32Hardware: hw,
    simulator: sim,
    activeBaseline,
  };
}

export async function resetPatientMlRemote(
  patientId: string,
  source?: "esp32_hardware" | "simulator" | "dataset_playback"
): Promise<{ remoteCleared: boolean }> {
  sharedBaselineTracker.resetPatient(patientId, source);
  sharedWindowStore.clear(patientId);
  sharedAlertDecisionEngine.clear(patientId);
  if (source) {
    nodeHistoryByKey.delete(historyKey(patientId, source));
  } else {
    for (const k of Array.from(nodeHistoryByKey.keys())) {
      if (k.startsWith(`${patientId}::`)) nodeHistoryByKey.delete(k);
    }
  }

  const baseUrl = getMlServiceUrl();
  if (!baseUrl) {
    return { remoteCleared: false };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/baseline/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patient_id: patientId, source: source ?? null }),
        signal: controller.signal,
      });
      return { remoteCleared: res.ok };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { remoteCleared: false };
  }
}

export async function fetchMlConfigRemote(): Promise<{
  mlServiceConnected: boolean;
  config: MlDetectionConfig;
}> {
  const baseUrl = getMlServiceUrl();
  if (baseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${baseUrl}/config`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { config?: Record<string, number> };
        if (data.config) {
          localConfig = {
            contamination: Number(data.config.contamination ?? localConfig.contamination),
            nEstimators: Number(data.config.n_estimators ?? localConfig.nEstimators),
            retrainInterval: Number(data.config.retrain_interval ?? localConfig.retrainInterval),
            baselineMinSamples: Number(data.config.baseline_min_samples ?? localConfig.baselineMinSamples),
            warningPersistenceWindows: Number(data.config.warning_persistence_windows ?? localConfig.warningPersistenceWindows),
            criticalPersistenceWindows: Number(data.config.critical_persistence_windows ?? localConfig.criticalPersistenceWindows),
            anomalyScoreWarning: Number(data.config.anomaly_score_warning ?? localConfig.anomalyScoreWarning),
            anomalyScoreCritical: Number(data.config.anomaly_score_critical ?? localConfig.anomalyScoreCritical),
            zScoreWarning: Number(data.config.z_score_warning ?? localConfig.zScoreWarning),
            zScoreCritical: Number(data.config.z_score_critical ?? localConfig.zScoreCritical),
          };
          return { mlServiceConnected: true, config: { ...localConfig } };
        }
      }
    } catch {
      // Fall back to local config
    }
  }
  return { mlServiceConnected: false, config: { ...localConfig } };
}

export async function updateMlConfigRemote(patch: Partial<MlDetectionConfig>): Promise<{
  mlServiceConnected: boolean;
  config: MlDetectionConfig;
}> {
  if (typeof patch.contamination === "number" && patch.contamination > 0 && patch.contamination < 0.5) {
    localConfig.contamination = patch.contamination;
  }
  if (typeof patch.nEstimators === "number") {
    localConfig.nEstimators = Math.max(25, Math.min(500, Math.round(patch.nEstimators)));
  }
  if (typeof patch.retrainInterval === "number") {
    localConfig.retrainInterval = Math.max(3, Math.min(100, Math.round(patch.retrainInterval)));
  }
  if (typeof patch.baselineMinSamples === "number") {
    localConfig.baselineMinSamples = Math.max(5, Math.min(5000, Math.round(patch.baselineMinSamples)));
  }
  if (typeof patch.warningPersistenceWindows === "number") {
    localConfig.warningPersistenceWindows = Math.max(1, Math.min(10, Math.round(patch.warningPersistenceWindows)));
  }
  if (typeof patch.criticalPersistenceWindows === "number") {
    localConfig.criticalPersistenceWindows = Math.max(1, Math.min(15, Math.round(patch.criticalPersistenceWindows)));
  }
  if (typeof patch.anomalyScoreWarning === "number") {
    localConfig.anomalyScoreWarning = Math.max(-1, Math.min(0.5, patch.anomalyScoreWarning));
  }
  if (typeof patch.anomalyScoreCritical === "number") {
    localConfig.anomalyScoreCritical = Math.max(-1, Math.min(0.5, patch.anomalyScoreCritical));
  }
  if (typeof patch.zScoreWarning === "number") {
    localConfig.zScoreWarning = Math.max(1, Math.min(6, patch.zScoreWarning));
  }
  if (typeof patch.zScoreCritical === "number") {
    localConfig.zScoreCritical = Math.max(1.5, Math.min(8, patch.zScoreCritical));
  }

  const baseUrl = getMlServiceUrl();
  if (baseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${baseUrl}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contamination: localConfig.contamination,
          n_estimators: localConfig.nEstimators,
          retrain_interval: localConfig.retrainInterval,
          baseline_min_samples: localConfig.baselineMinSamples,
          warning_persistence_windows: localConfig.warningPersistenceWindows,
          critical_persistence_windows: localConfig.criticalPersistenceWindows,
          anomaly_score_warning: localConfig.anomalyScoreWarning,
          anomaly_score_critical: localConfig.anomalyScoreCritical,
          z_score_warning: localConfig.zScoreWarning,
          z_score_critical: localConfig.zScoreCritical,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        return { mlServiceConnected: true, config: { ...localConfig } };
      }
    } catch {
      // Fall through cleanly
    }
  }
  return { mlServiceConnected: false, config: { ...localConfig } };
}

export async function fetchMlModelStatusRemote(
  patientId: string,
  source?: TelemetrySource
): Promise<Record<string, unknown>> {
  const baseUrl = getMlServiceUrl();
  if (baseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const qs = source ? `?source=${encodeURIComponent(source)}` : "";
      const res = await fetch(`${baseUrl}/model/status/${encodeURIComponent(patientId)}${qs}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const remote = (await res.json()) as Record<string, unknown>;
        return { mlServiceConnected: true, ...remote };
      }
    } catch {
      // Fall back to local status
    }
  }

  const summary = getPatientBaselineStatusSummary(patientId, localConfig.baselineMinSamples);
  const effSource = source ?? summary.activeBaseline.source ?? "simulator";
  const isTrackableSource =
    effSource === "esp32_hardware" || effSource === "simulator" || effSource === "dataset_playback";
  const profile = isTrackableSource ? sharedBaselineTracker.getProfile(patientId, effSource) : null;
  const sourceProgress = isTrackableSource
    ? sharedBaselineTracker.getProgress(patientId, effSource, localConfig.baselineMinSamples)
    : summary.activeBaseline;

  return {
    mlServiceConnected: false,
    patient_id: patientId,
    source: effSource,
    trained: Boolean(profile?.remotePythonTrained),
    sample_count: profile?.sampleCount ?? sourceProgress.collectedSamples,
    min_training_samples: 20,
    model_version: profile?.modelVersion ?? sourceProgress.modelVersion,
    trained_at: profile?.trainedAt ?? null,
    updated_at: profile?.updatedAt ?? profile?.trainedAt ?? null,
    means: profile?.means ?? null,
    medians: profile?.medians ?? null,
    stds: profile?.stds ?? null,
    history_count: getNodeAnalysisHistory(patientId, source).length,
    config: localConfig,
  };
}

function buildLocalEvaluationFallback(params: {
  patientId: string;
  source?: TelemetrySource;
  readings?: Array<Record<string, unknown>>;
  labels?: Array<unknown>;
}): MlEvaluationResult {
  const readings =
    params.readings ?? getNodeAnalysisHistory(params.patientId, params.source, 300);
  const total = readings.length;
  const profile =
    params.source &&
    (params.source === "esp32_hardware" || params.source === "simulator" || params.source === "dataset_playback")
      ? sharedBaselineTracker.getProfile(params.patientId, params.source)
      : sharedBaselineTracker.getProfile(params.patientId, "esp32_hardware") ??
        sharedBaselineTracker.getProfile(params.patientId, "simulator");

  let validQuality = 0;
  let noisyQuality = 0;
  let poorQuality = 0;
  let anomalous = 0;
  let insufficient = 0;
  let normal = 0;
  const scores: number[] = [];
  const normScores: number[] = [];
  const anomScores: number[] = [];

  const paired: Array<[number, number]> = [];

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const sq = String(r.signal_quality ?? r.signalQuality ?? "good");
    const ast = String(r.anomaly_status ?? r.anomalyStatus ?? "normal");
    const al = String(r.alert_level ?? r.alertLevel ?? "Normal");
    const sc = Number(r.anomaly_score ?? r.anomalyScore);
    if (sq === "good") validQuality++;
    else if (sq === "noisy") noisyQuality++;
    else if (sq === "poor_contact") poorQuality++;

    const isAnom = ast === "anomalous" || al === "Warning" || al === "Critical";
    if (isAnom) anomalous++;
    else if (ast === "insufficient_baseline") insufficient++;
    else if (sq !== "poor_contact") normal++;

    if (Number.isFinite(sc)) {
      scores.push(sc);
      if (isAnom) anomScores.push(sc);
      else if (ast !== "insufficient_baseline" && sq !== "poor_contact") normScores.push(sc);
    }

    const rawLbl =
      params.labels && params.labels.length === readings.length
        ? params.labels[i]
        : r.label ?? r.ground_truth_label ?? r.is_anomalous;
    let parsed: number | null = null;
    if (typeof rawLbl === "boolean") parsed = rawLbl ? 1 : 0;
    else if (typeof rawLbl === "number") parsed = rawLbl !== 0 ? 1 : 0;
    else if (typeof rawLbl === "string") {
      const low = rawLbl.trim().toLowerCase();
      if (["1", "true", "anomalous", "anomaly", "fall", "warning", "critical"].includes(low)) parsed = 1;
      else if (["0", "false", "normal", "adl", "baseline"].includes(low)) parsed = 0;
    }
    if (parsed !== null) {
      paired.push([parsed, isAnom ? 1 : 0]);
    }
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10000) / 10000 : null;
  const scoreMean = avg(scores);
  const normMean = avg(normScores);
  const anomMean = avg(anomScores);

  let supervised: MlEvaluationResult["supervised_metrics"] = null;
  if (paired.length > 0) {
    let tn = 0;
    let fp = 0;
    let fn = 0;
    let tp = 0;
    for (const [yt, yp] of paired) {
      if (yt === 0 && yp === 0) tn++;
      else if (yt === 0 && yp === 1) fp++;
      else if (yt === 1 && yp === 0) fn++;
      else tp++;
    }
    const acc = (tp + tn) / paired.length;
    const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
    supervised = {
      labeled_count: paired.length,
      accuracy: Math.round(acc * 10000) / 10000,
      precision: Math.round(prec * 10000) / 10000,
      recall: Math.round(rec * 10000) / 10000,
      f1_score: Math.round(f1 * 10000) / 10000,
      confusion_matrix: { tn, fp, fn, tp, matrix: [[tn, fp], [fn, tp]] },
    };
  }

  return {
    evaluated_at: new Date().toISOString(),
    labeled_data_available: paired.length > 0,
    sample_count: total,
    model_version: profile?.modelVersion ?? null,
    source: params.source ?? profile?.source ?? null,
    evaluation_note:
      paired.length > 0
        ? `Computed supervised metrics across ${paired.length} labeled readings alongside unsupervised score statistics.`
        : "Ground-truth anomaly labels are not available for these live/simulated readings. Accuracy, Precision, Recall, F1-score, and Confusion Matrix require labeled test data and are intentionally omitted; unsupervised anomaly score statistics are reported instead.",
    disclaimer: "Non-diagnostic statistical anomaly evaluation; outputs do not constitute medical diagnosis.",
    metrics_requiring_labels: ["Accuracy", "Precision", "Recall", "F1-score", "Confusion Matrix"],
    supervised_metrics: supervised,
    unsupervised_metrics: {
      valid_quality_count: validQuality,
      noisy_quality_count: noisyQuality,
      poor_quality_count: poorQuality,
      normal_count: normal,
      anomalous_count: anomalous,
      insufficient_baseline_count: insufficient,
      flagged_rate: total > 0 ? Math.round((anomalous / total) * 10000) / 10000 : 0,
      anomaly_score_mean: scoreMean,
      anomaly_score_median: scoreMean,
      anomaly_score_std: null,
      anomaly_score_min: scores.length > 0 ? Math.min(...scores) : null,
      anomaly_score_max: scores.length > 0 ? Math.max(...scores) : null,
      anomaly_score_iqr: null,
      normal_vs_anomalous_score_gap:
        normMean !== null && anomMean !== null ? Math.round((normMean - anomMean) * 10000) / 10000 : null,
      baseline_sample_count: profile?.sampleCount ?? 0,
    },
  };
}

export async function evaluateMlModelRemote(params: {
  patientId: string;
  source?: TelemetrySource;
  readings?: Array<Record<string, unknown>>;
  labels?: Array<unknown>;
}): Promise<{ mlServiceConnected: boolean; evaluation: MlEvaluationResult }> {
  const baseUrl = getMlServiceUrl();
  const fallbackReadings =
    params.readings ?? getNodeAnalysisHistory(params.patientId, params.source, 300);

  if (baseUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${baseUrl}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: params.patientId,
          source: params.source ?? null,
          readings: params.readings ?? (fallbackReadings.length > 0 ? fallbackReadings : null),
          labels: params.labels ?? null,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const evaluation = (await res.json()) as MlEvaluationResult;
        return { mlServiceConnected: true, evaluation };
      }
    } catch {
      // Fall back honestly
    }
  }

  return {
    mlServiceConnected: false,
    evaluation: buildLocalEvaluationFallback({
      ...params,
      readings: fallbackReadings,
    }),
  };
}

export async function generateMlGraphsRemote(params: {
  patientId: string;
  source?: TelemetrySource;
  readings?: Array<Record<string, unknown>>;
}): Promise<{
  ok: boolean;
  mlServiceConnected: boolean;
  graphs: MlGraphMeta[];
  message?: string;
}> {
  const baseUrl = getMlServiceUrl();
  if (!baseUrl) {
    return {
      ok: false,
      mlServiceConnected: false,
      graphs: [],
      message: "Python ML FastAPI service is not connected; Matplotlib PNG graph generation requires the Python ML backend.",
    };
  }

  const effSource = params.source ?? "simulator";
  const readings = params.readings ?? getNodeAnalysisHistory(params.patientId, effSource, 300);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(`${baseUrl}/graphs/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patient_id: params.patientId,
        source: effSource,
        readings: readings.length > 0 ? readings : null,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        ok: false,
        mlServiceConnected: true,
        graphs: [],
        message: "Failed to generate Matplotlib evaluation graphs.",
      };
    }
    const data = (await res.json()) as {
      graphs?: Array<{
        id: string;
        title?: string;
        metric?: string;
        filename: string;
        point_count?: number;
        generated_at?: string;
      }>;
    };
    const graphs: MlGraphMeta[] = (data.graphs ?? []).map((g) => ({
      ...g,
      url: `/api/ml/graphs/file/${encodeURIComponent(g.filename)}`,
    }));
    return { ok: true, mlServiceConnected: true, graphs };
  } catch (err) {
    return {
      ok: false,
      mlServiceConnected: false,
      graphs: [],
      message: err instanceof Error ? err.message : "Graph generation request failed.",
    };
  }
}

export async function listMlGraphsRemote(
  patientId: string,
  source?: TelemetrySource
): Promise<{ mlServiceConnected: boolean; graphs: MlGraphMeta[] }> {
  const baseUrl = getMlServiceUrl();
  if (!baseUrl) {
    return { mlServiceConnected: false, graphs: [] };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const qs = source ? `?source=${encodeURIComponent(source)}` : "";
    const res = await fetch(`${baseUrl}/graphs/list/${encodeURIComponent(patientId)}${qs}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { mlServiceConnected: false, graphs: [] };
    const data = (await res.json()) as {
      graphs?: Array<{ id: string; filename: string }>;
    };
    return {
      mlServiceConnected: true,
      graphs: (data.graphs ?? []).map((g) => ({
        ...g,
        url: `/api/ml/graphs/file/${encodeURIComponent(g.filename)}`,
      })),
    };
  } catch {
    return { mlServiceConnected: false, graphs: [] };
  }
}

export function resolveMlGraphFilePath(filename: string): string | null {
  if (!SAFE_GRAPH_FILENAME_RE.test(filename)) return null;
  const graphDir = path.resolve(
    process.env.SMARTCARE_GRAPH_DIR || path.join(process.cwd(), "ml-service", "graphs")
  );
  const resolved = path.resolve(graphDir, filename);
  if (!resolved.startsWith(graphDir + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}
