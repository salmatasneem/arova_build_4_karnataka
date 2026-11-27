import type { ExtractedWindowFeatures } from "./featureExtractor.ts";
import type {
  AlertLevel,
  AlertPolicyConfig,
  AlertSource,
  AnomalyStatus,
  AvailableModalities,
  BaselineProgress,
  SignalQuality,
  TelemetrySource,
} from "./types.ts";

export interface ResolvedAlertPolicy {
  baselineMinSamples: number;
  warningPersistenceWindows: number;
  criticalPersistenceWindows: number;
  anomalyScoreWarningThreshold: number;
  anomalyScoreCriticalThreshold: number;
  zScoreWarningThreshold: number;
  zScoreCriticalThreshold: number;
}

export function resolveAlertPolicy(input?: AlertPolicyConfig): ResolvedAlertPolicy {
  return {
    baselineMinSamples: Math.max(5, Math.min(5000, Math.round(input?.baselineMinSamples ?? 20))),
    warningPersistenceWindows: Math.max(1, Math.min(10, Math.round(input?.warningPersistenceWindows ?? 2))),
    criticalPersistenceWindows: Math.max(1, Math.min(15, Math.round(input?.criticalPersistenceWindows ?? 3))),
    anomalyScoreWarningThreshold: input?.anomalyScoreWarningThreshold ?? -0.05,
    anomalyScoreCriticalThreshold: input?.anomalyScoreCriticalThreshold ?? -0.18,
    zScoreWarningThreshold: input?.zScoreWarningThreshold ?? 2.0,
    zScoreCriticalThreshold: input?.zScoreCriticalThreshold ?? 3.0,
  };
}

export interface AlertDecisionOutput {
  anomalyStatus: AnomalyStatus;
  alertLevel: AlertLevel;
  anomalyScore: number;
  triggeredMetrics: string[];
  contributingFeatures: string[];
  persistenceCount: number;
  persistenceRequired: number;
  explanation: string;
  prototypeNotice?: string;
  relevantReadings?: {
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    accelMagnitude: number;
  };
}

export interface OngoingAlertSuppressionEntry {
  alertId: string;
  level: "Warning" | "Critical";
  metricsKey: string;
  createdAtMs: number;
  lastSeenMs: number;
  suppressedCount: number;
  resolvedOrAcked: boolean;
}

export const PROTOTYPE_ALERT_NOTICE =
  "Prototype monitoring notification — not a medical diagnosis. Seek qualified clinical care for health concerns.";

export class ServerAlertDecisionEngine {
  private readonly streaks = new Map<string, boolean[]>();
  private readonly activeEventKeys = new Map<string, OngoingAlertSuppressionEntry>();

  private key(patientId: string, source: AlertSource): string {
    return `${patientId}::${source}`;
  }

  private pushStreak(patientId: string, source: AlertSource, isAnomalous: boolean): number {
    const k = this.key(patientId, source);
    const arr = this.streaks.get(k) ?? [];
    arr.push(isAnomalous);
    if (arr.length > 12) arr.shift();
    this.streaks.set(k, arr);

    let streak = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]) streak++;
      else break;
    }
    return streak;
  }

  public clear(patientId?: string): void {
    if (!patientId) {
      this.streaks.clear();
      this.activeEventKeys.clear();
      return;
    }
    for (const k of this.streaks.keys()) {
      if (k.startsWith(`${patientId}::`)) {
        this.streaks.delete(k);
      }
    }
    for (const k of this.activeEventKeys.keys()) {
      if (k.startsWith(`${patientId}::`)) {
        this.activeEventKeys.delete(k);
      }
    }
  }

  public markAlertCleared(patientId: string, source?: AlertSource, alertId?: string): void {
    for (const [k, entry] of this.activeEventKeys.entries()) {
      const matchesPatient = k.startsWith(`${patientId}::`);
      const matchesSource = !source || k === this.key(patientId, source);
      const matchesAlert = !alertId || entry.alertId === alertId;
      if (matchesPatient && matchesSource && matchesAlert) {
        entry.resolvedOrAcked = true;
        this.activeEventKeys.set(k, entry);
      }
    }
  }

  public checkAndTrackDuplicateAlert(params: {
    patientId: string;
    source: AlertSource;
    level: "Warning" | "Critical";
    triggeredMetrics: string[];
    newAlertId: string;
    duplicateWindowSec?: number;
    nowMs?: number;
  }): {
    shouldEmitAlert: boolean;
    duplicateSuppressed: boolean;
    existingAlertId?: string;
    suppressedCount: number;
  } {
    const nowMs = params.nowMs ?? Date.now();
    const windowMs = Math.max(0, Math.min(3600, params.duplicateWindowSec ?? 120)) * 1000;
    const k = this.key(params.patientId, params.source);
    const metricsKey =
      params.triggeredMetrics.length > 0
        ? [...params.triggeredMetrics].sort().join("|")
        : "general_anomaly";

    const existing = this.activeEventKeys.get(k);
    if (existing && !existing.resolvedOrAcked && windowMs > 0) {
      const withinWindow = nowMs - existing.createdAtMs <= windowMs;
      const isEscalationFromWarningToCritical =
        existing.level === "Warning" && params.level === "Critical";

      if (withinWindow && !isEscalationFromWarningToCritical) {
        existing.lastSeenMs = nowMs;
        existing.suppressedCount += 1;
        this.activeEventKeys.set(k, existing);
        return {
          shouldEmitAlert: false,
          duplicateSuppressed: true,
          existingAlertId: existing.alertId,
          suppressedCount: existing.suppressedCount,
        };
      }
    }

    this.activeEventKeys.set(k, {
      alertId: params.newAlertId,
      level: params.level,
      metricsKey,
      createdAtMs: nowMs,
      lastSeenMs: nowMs,
      suppressedCount: 0,
      resolvedOrAcked: false,
    });

    return {
      shouldEmitAlert: true,
      duplicateSuppressed: false,
      suppressedCount: 0,
    };
  }

  public evaluate(params: {
    patientId: string;
    source: TelemetrySource;
    signalQuality: SignalQuality;
    qualityNotes: string[];
    ecgLeadOff: boolean;
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    accelMagnitude: number;
    possibleFallDetected: boolean;
    baselineReady: boolean;
    baselineProgress: BaselineProgress;
    features: ExtractedWindowFeatures;
    remotePythonScore?: number | null;
    remotePythonModelTrained?: boolean;
    mlServiceConnected: boolean;
    policyInput?: AlertPolicyConfig;
    availableModalities?: AvailableModalities;
  }): AlertDecisionOutput {
    const policy = resolveAlertPolicy(params.policyInput);
    const ecgNote = params.ecgLeadOff ? " AD8232 ECG electrodes report lead-off." : "";
    const isDatasetPlayback = params.source === "dataset_playback";
    const hrExpected = !isDatasetPlayback || params.availableModalities?.heartRate !== false;
    const spo2Expected = !isDatasetPlayback || params.availableModalities?.spo2 !== false;

    const relevantReadings = {
      heartRate: params.heartRate,
      spo2: params.spo2,
      temperatureC: params.temperatureC,
      accelMagnitude: params.accelMagnitude,
    };

    // Stage 1: Sensor Quality Gate (strictly unchanged for esp32_hardware and simulator)
    if (
      params.signalQuality === "poor_contact" ||
      (hrExpected && params.heartRate === null) ||
      (spo2Expected && params.spo2 === null)
    ) {
      return {
        anomalyStatus: "paused_poor_quality",
        alertLevel: "Normal",
        anomalyScore: 0,
        triggeredMetrics: [],
        contributingFeatures: [],
        persistenceCount: 0,
        persistenceRequired: policy.warningPersistenceWindows,
        explanation: `${params.qualityNotes.join(" ")}${ecgNote} Anomaly scoring paused until optical sensor contact stabilizes.`.trim(),
        prototypeNotice: PROTOTYPE_ALERT_NOTICE,
        relevantReadings,
      };
    }

    const acuteCritical =
      (params.spo2 !== null && params.spo2 <= 88) ||
      (params.heartRate !== null && (params.heartRate >= 145 || params.heartRate <= 38)) ||
      (params.temperatureC !== null && (params.temperatureC >= 39.5 || params.temperatureC <= 34.5));

    const fallFlag =
      params.possibleFallDetected ||
      params.features.movementContext === "fall_suspect" ||
      params.accelMagnitude >= 2.8;

    // Stage 2: Baseline Readiness Gate
    if (!params.baselineReady) {
      this.pushStreak(params.patientId, params.source, false);
      const collected = params.baselineProgress.collectedSamples;
      const required = params.baselineProgress.requiredSamples;

      if (
        acuteCritical ||
        (fallFlag &&
          ((params.heartRate !== null && params.heartRate >= 120) ||
            (params.spo2 !== null && params.spo2 <= 92)))
      ) {
        const acuteMetrics: string[] = [];
        if (params.spo2 !== null && params.spo2 <= 92) acuteMetrics.push("SpO2");
        if (params.heartRate !== null && (params.heartRate >= 120 || params.heartRate <= 38)) {
          acuteMetrics.push("Heart Rate");
        }
        if (fallFlag) acuteMetrics.push("Movement (Experimental Fall Indicator)");
        if (params.temperatureC !== null && (params.temperatureC >= 39.5 || params.temperatureC <= 34.5)) {
          acuteMetrics.push("Temperature");
        }
        return {
          anomalyStatus: "insufficient_baseline",
          alertLevel: "Critical",
          anomalyScore: params.remotePythonScore ?? -0.25,
          triggeredMetrics: acuteMetrics,
          contributingFeatures: acuteMetrics.map((m) => `${m} (acute safety guardrail)`),
          persistenceCount: 1,
          persistenceRequired: 1,
          explanation: `Insufficient personal baseline (${collected}/${required} clean samples), but acute safety threshold triggered (${acuteMetrics.join(", ")}).${ecgNote}`.trim(),
          prototypeNotice: PROTOTYPE_ALERT_NOTICE,
          relevantReadings,
        };
      }

      return {
        anomalyStatus: "insufficient_baseline",
        alertLevel: "Normal",
        anomalyScore: 0,
        triggeredMetrics: [],
        contributingFeatures: [],
        persistenceCount: 0,
        persistenceRequired: policy.warningPersistenceWindows,
        explanation: `Insufficient personal baseline data (${collected}/${required} clean ${params.source} samples). Personalized anomaly scoring activates automatically after baseline learning completes.${ecgNote}`.trim(),
        prototypeNotice: PROTOTYPE_ALERT_NOTICE,
        relevantReadings,
      };
    }

    // Stage 3: Personalized Deviation & Anomaly Scoring Evaluation
    const { features } = params;
    const triggered: string[] = [];
    const reasons: string[] = [];
    const contributing: string[] = [];

    if (
      params.heartRate !== null &&
      (Math.abs(features.hrZScore) >= policy.zScoreWarningThreshold ||
        params.heartRate >= 125 ||
        params.heartRate <= 45)
    ) {
      triggered.push("Heart Rate");
      reasons.push(
        `heart rate ${Math.round(params.heartRate)} BPM (z=${features.hrZScore >= 0 ? "+" : ""}${features.hrZScore}, ${features.matchedBaselineContext} context)`
      );
      contributing.push(`Heart Rate (${features.hrZScore >= 0 ? "+" : ""}${features.hrZScore}σ)`);
    }

    if (
      params.spo2 !== null &&
      (features.spo2ZScore <= -policy.zScoreWarningThreshold || params.spo2 <= 93)
    ) {
      triggered.push("SpO2");
      reasons.push(
        `SpO2 ${params.spo2.toFixed(1)}% (z=${features.spo2ZScore >= 0 ? "+" : ""}${features.spo2ZScore}, window min ${features.spo2Min?.toFixed(1) ?? params.spo2.toFixed(1)}%)`
      );
      contributing.push(`SpO2 (${features.spo2ZScore >= 0 ? "+" : ""}${features.spo2ZScore}σ)`);
    }

    if (
      params.temperatureC !== null &&
      (Math.abs(features.tempZScore) >= policy.zScoreWarningThreshold ||
        params.temperatureC >= 38.0 ||
        params.temperatureC <= 35.3 ||
        features.tempSlopeCPerMin >= 0.08)
    ) {
      triggered.push("Temperature");
      const slopeNote =
        Math.abs(features.tempSlopeCPerMin) >= 0.03
          ? `, trend ${features.tempSlopeCPerMin >= 0 ? "+" : ""}${features.tempSlopeCPerMin.toFixed(2)}°C/min`
          : "";
      reasons.push(
        `temperature ${params.temperatureC.toFixed(1)} °C (z=${features.tempZScore >= 0 ? "+" : ""}${features.tempZScore}${slopeNote})`
      );
      contributing.push(`Temperature (${features.tempZScore >= 0 ? "+" : ""}${features.tempZScore}σ)`);
    }

    if (fallFlag || Math.abs(features.accelZScore) >= 2.8) {
      triggered.push("Movement (Experimental Fall Indicator)");
      reasons.push(`IMU acceleration ${params.accelMagnitude.toFixed(2)} g (z=${features.accelZScore >= 0 ? "+" : ""}${features.accelZScore})`);
      contributing.push(`Movement (${params.accelMagnitude.toFixed(2)}g)`);
    }

    if (features.ecgAvailable && Math.abs(features.ecgZScore) >= policy.zScoreWarningThreshold) {
      triggered.push("AD8232 ECG Rate");
      reasons.push(`ECG-derived rate deviated (z=${features.ecgZScore >= 0 ? "+" : ""}${features.ecgZScore}, non-diagnostic)`);
      contributing.push(`ECG Rate (${features.ecgZScore >= 0 ? "+" : ""}${features.ecgZScore}σ)`);
    }

    // Compute multivariate score (use Python Isolation Forest score when connected; otherwise personalized z-score index)
    const compositeZ =
      Math.max(0, Math.abs(features.hrZScore) - 0.5) * 0.045 +
      Math.max(0, -features.spo2ZScore - 0.5) * 0.065 +
      Math.max(0, Math.abs(features.tempZScore) - 0.5) * 0.05 +
      (fallFlag ? 0.16 : 0);

    const score =
      params.mlServiceConnected && typeof params.remotePythonScore === "number"
        ? params.remotePythonScore
        : Number((0.16 - compositeZ).toFixed(4));

    const scoreOutlier = score <= policy.anomalyScoreWarningThreshold;
    const noisyDampening =
      params.signalQuality === "noisy" && !acuteCritical && triggered.length <= 1 && !fallFlag;

    const rawAnomalous =
      (scoreOutlier || triggered.length >= 1) &&
      !(noisyDampening && score > policy.anomalyScoreCriticalThreshold);

    const streak = this.pushStreak(params.patientId, params.source, rawAnomalous);
    const engineSuffix = params.mlServiceConnected
      ? ""
      : " (Demo Mode: Python Isolation Forest not connected; personalized windowed baseline check applied).";
    const tempNote = params.temperatureC === null ? " Temperature sensor pending (null)." : "";

    if (!rawAnomalous) {
      return {
        anomalyStatus: "normal",
        alertLevel: "Normal",
        anomalyScore: score,
        triggeredMetrics: [],
        contributingFeatures: [],
        persistenceCount: 0,
        persistenceRequired: policy.warningPersistenceWindows,
        explanation: `Readings align with ${params.features.matchedBaselineContext} personal baseline (score ${score.toFixed(3)}, window=${features.windowSize}).${tempNote}${ecgNote}${engineSuffix}`.trim(),
        prototypeNotice: PROTOTYPE_ALERT_NOTICE,
        relevantReadings,
      };
    }

    // Stage 4: Multi-Window Persistence & Severity Classification
    const sustainedWarning = streak >= policy.warningPersistenceWindows;

    const severeMultiSignal =
      sustainedWarning &&
      triggered.length >= 2 &&
      (score <= policy.anomalyScoreCriticalThreshold ||
        Math.abs(features.hrZScore) >= policy.zScoreCriticalThreshold ||
        features.spo2ZScore <= -policy.zScoreCriticalThreshold);

    const sustainedCritical =
      streak >= policy.criticalPersistenceWindows &&
      (score <= policy.anomalyScoreCriticalThreshold || triggered.length >= 2);

    let alertLevel: AlertLevel;
    let explanation: string;

    if (acuteCritical || (fallFlag && triggered.length >= 2) || sustainedCritical || severeMultiSignal) {
      alertLevel = "Critical";
      explanation = `Critical alert (score ${score.toFixed(3)}, persistence ${streak}/${policy.criticalPersistenceWindows} windows): ${reasons.join(", ") || "severe multi-feature deviation"}.${tempNote}${ecgNote}${engineSuffix}`.trim();
    } else if (sustainedWarning) {
      alertLevel = "Warning";
      explanation = `Warning confirmed across ${streak} consecutive windows (score ${score.toFixed(3)}): ${reasons.join(", ") || "sustained deviation from personal baseline"}.${tempNote}${ecgNote}${engineSuffix}`.trim();
    } else {
      alertLevel = "Normal";
      explanation = `Transient deviation detected (${reasons.join(", ") || "single-window outlier"}; score ${score.toFixed(3)}) — awaiting multi-window persistence (${streak}/${policy.warningPersistenceWindows}) before emitting alert.${tempNote}${ecgNote}${engineSuffix}`.trim();
    }

    return {
      anomalyStatus: "anomalous",
      alertLevel,
      anomalyScore: score,
      triggeredMetrics: triggered,
      contributingFeatures: contributing.slice(0, 6),
      persistenceCount: streak,
      persistenceRequired: policy.warningPersistenceWindows,
      explanation,
      prototypeNotice: PROTOTYPE_ALERT_NOTICE,
      relevantReadings,
    };
  }
}

export const sharedAlertDecisionEngine = new ServerAlertDecisionEngine();

