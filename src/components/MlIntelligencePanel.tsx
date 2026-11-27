import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Brain,
  CheckCircle2,
  Clock,
  Cpu,
  Image as ImageIcon,
  Info,
  RefreshCw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { AlertLevelLabel } from "./StatusIndicator.tsx";
import { AnimatedNumber } from "./AnimatedNumber.tsx";
import {
  fetchMlConfig,
  fetchMlGraphs,
  fetchMlModelStatus,
  generateMlGraphs,
  runMlEvaluation,
  saveMlConfig,
} from "../services/apiClient.ts";
import type {
  AnomalyEventRecord,
  BaselineRecord,
  MlDetectionConfig,
  MlEvaluationResult,
  MlGraphMeta,
  MlModelStatusSummary,
  PatientRecord,
  VitalReading,
} from "../types/smartcare.ts";

interface MlIntelligencePanelProps {
  patient: PatientRecord;
  readings: VitalReading[];
  latestReading: VitalReading | null;
  baselines: BaselineRecord[];
  anomalyEvents: AnomalyEventRecord[];
  mlConnected: boolean;
  isAdminUser: boolean;
  compact?: boolean;
  onNavigateTrends?: () => void;
}

function fmtStat(val: number | null | undefined, digits = 1, suffix = ""): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "--";
  return `${val.toFixed(digits)}${suffix}`;
}

export function MlIntelligencePanel({
  patient,
  readings,
  latestReading,
  baselines,
  anomalyEvents,
  mlConnected,
  isAdminUser,
  compact = false,
  onNavigateTrends,
}: MlIntelligencePanelProps) {
  const [modelStatus, setModelStatus] = useState<MlModelStatusSummary | null>(null);
  const [mlConfig, setMlConfig] = useState<MlDetectionConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<MlDetectionConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configFeedback, setConfigFeedback] = useState<string | null>(null);

  const [evaluation, setEvaluation] = useState<MlEvaluationResult | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [graphs, setGraphs] = useState<MlGraphMeta[]>([]);
  const [graphsBusy, setGraphsBusy] = useState(false);
  const [graphsError, setGraphsError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const patientBaselines = useMemo(
    () => baselines.filter((b) => b.patientId === patient.patientId),
    [baselines, patient.patientId]
  );

  const activeBaselineDoc = useMemo(() => {
    const preferredSource = latestReading?.source === "esp32_hardware" ? "esp32_hardware" : "simulator";
    return (
      patientBaselines.find((b) => b.source === preferredSource) ??
      patientBaselines[0] ??
      null
    );
  }, [patientBaselines, latestReading?.source]);

  const patientAnomalyEvents = useMemo(
    () => anomalyEvents.filter((e) => e.patientId === patient.patientId),
    [anomalyEvents, patient.patientId]
  );

  const refreshMlState = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [statusRes, cfgRes, graphsRes] = await Promise.allSettled([
        fetchMlModelStatus(patient.patientId),
        fetchMlConfig(),
        fetchMlGraphs(patient.patientId),
      ]);
      if (statusRes.status === "fulfilled") {
        setModelStatus(statusRes.value);
      }
      if (cfgRes.status === "fulfilled") {
        setMlConfig(cfgRes.value.config);
        setConfigDraft(cfgRes.value.config);
      }
      if (graphsRes.status === "fulfilled") {
        setGraphs(graphsRes.value.graphs ?? []);
      }
    } finally {
      setStatusLoading(false);
    }
  }, [patient.patientId]);

  useEffect(() => {
    void refreshMlState();
  }, [refreshMlState, readings.length]);

  const activeSourceForSamples = useMemo<"esp32_hardware" | "simulator">(() => {
    if (latestReading?.source === "esp32_hardware") return "esp32_hardware";
    const hasHw = readings.some((r) => r.source === "esp32_hardware");
    return hasHw ? "esp32_hardware" : "simulator";
  }, [latestReading?.source, readings]);

  const evaluationSamplesPayload = useMemo(
    () =>
      readings.map((r) => ({
        heartRate: r.heartRate,
        spo2: r.spo2,
        temperatureC: r.temperatureC,
        accelMagnitude: r.accelMagnitude ?? 1.0,
        gyroMagnitude: r.gyroMagnitude ?? 0.0,
        movementStatus: r.movementStatus,
        signalQuality: r.signalQuality,
        irSignalOk: r.signalQuality !== "poor_contact",
        fingerDetected: r.signalQuality !== "poor_contact",
        source: r.source,
        timestamp: r.createdAt,
        anomalyScore: r.anomalyScore,
        anomalyStatus: r.anomalyStatus,
      })),
    [readings]
  );

  const handleRunEvaluation = async () => {
    setEvalBusy(true);
    setEvalError(null);
    try {
      const res = await runMlEvaluation({
        patientId: patient.patientId,
        source: activeSourceForSamples,
        samples: evaluationSamplesPayload,
      });
      setEvaluation(res);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Failed to run model evaluation.");
    } finally {
      setEvalBusy(false);
    }
  };

  const handleGenerateGraphs = async () => {
    setGraphsBusy(true);
    setGraphsError(null);
    try {
      const res = await generateMlGraphs({
        patientId: patient.patientId,
        source: activeSourceForSamples,
        samples: evaluationSamplesPayload,
      });
      setGraphs(res.graphs);
    } catch (err) {
      setGraphsError(err instanceof Error ? err.message : "Failed to generate evaluation graphs.");
    } finally {
      setGraphsBusy(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configDraft || !isAdminUser) return;
    setConfigSaving(true);
    setConfigFeedback(null);
    try {
      const res = await saveMlConfig(configDraft);
      setMlConfig(res.config);
      setConfigDraft(res.config);
      setConfigFeedback("Isolation Forest detection configuration saved.");
    } catch (err) {
      setConfigFeedback(err instanceof Error ? err.message : "Failed to update ML config.");
    } finally {
      setConfigSaving(false);
    }
  };

  const explanations = useMemo(() => {
    if (!latestReading) return [];
    if (
      Array.isArray(latestReading.plainLanguageExplanations) &&
      latestReading.plainLanguageExplanations.length > 0
    ) {
      return latestReading.plainLanguageExplanations;
    }
    return [latestReading.explanation];
  }, [latestReading]);

  const anomalyBadge = useMemo(() => {
    const status = latestReading?.anomalyStatus;
    if (!latestReading) {
      return {
        label: "Awaiting Telemetry",
        cls: "bg-[#EEF2F2] border-[#D9E0E0] text-[#737B7B]",
      };
    }
    if (status === "paused_poor_quality") {
      return {
        label: "Paused · Poor Sensor Quality",
        cls: "bg-amber-50 border-amber-300 text-amber-800",
      };
    }
    if (status === "insufficient_baseline") {
      return {
        label: "Learning Personal Baseline",
        cls: "bg-[#00B800]/10 border-[#00B800]/30 text-[#008F00]",
      };
    }
    if (status === "anomalous" || latestReading.alertLevel !== "Normal") {
      return {
        label: `Anomalous Pattern (${latestReading.alertLevel})`,
        cls:
          latestReading.alertLevel === "Critical"
            ? "bg-red-50 border-red-300 text-red-800"
            : "bg-amber-50 border-amber-300 text-amber-800",
      };
    }
    return {
      label: "Normal Pattern",
      cls: "bg-[#00B800]/12 border-[#00B800]/35 text-[#008F00]",
    };
  }, [latestReading]);

  const baselineStatsRows = useMemo(() => {
    const fs = activeBaselineDoc?.featureStatistics;
    const mMeans = modelStatus?.means;
    const mMeds = modelStatus?.medians;
    const mStds = modelStatus?.stds;

    return [
      {
        label: "Heart Rate",
        unit: "BPM",
        mean: mMeans?.heart_rate ?? fs?.heartRateMean ?? patient.baselineHeartRateMean,
        median: mMeds?.heart_rate ?? fs?.heartRateMedian,
        std: mStds?.heart_rate ?? fs?.heartRateStd,
        current: latestReading?.heartRate ?? null,
      },
      {
        label: "Blood Oxygen (SpO₂)",
        unit: "%",
        mean: mMeans?.spo2 ?? fs?.spo2Mean ?? patient.baselineSpo2Mean,
        median: mMeds?.spo2 ?? fs?.spo2Median,
        std: mStds?.spo2 ?? fs?.spo2Std,
        current: latestReading?.spo2 ?? null,
      },
      {
        label: "Temperature",
        unit: "°C",
        mean: mMeans?.temperature_c ?? fs?.tempMean ?? patient.baselineTempMean,
        median: mMeds?.temperature_c ?? fs?.tempMedian,
        std: mStds?.temperature_c ?? fs?.tempStd,
        current: latestReading?.temperatureC ?? null,
      },
      {
        label: "Motion (MPU6050)",
        unit: "g",
        mean: mMeans?.accel_magnitude ?? fs?.accelMean,
        median: mMeds?.accel_magnitude ?? fs?.accelMedian,
        std: mStds?.accel_magnitude ?? fs?.accelStd,
        current: latestReading?.accelMagnitude ?? null,
      },
    ];
  }, [activeBaselineDoc, modelStatus, patient, latestReading]);

  const collectedSamples =
    modelStatus?.sample_count ??
    activeBaselineDoc?.featureStatistics.sampleCount ??
    patient.baselineSamplesCount ??
    0;
  const minRequiredSamples = modelStatus?.min_training_samples ?? mlConfig?.baselineMinSamples ?? 20;
  const baselineReady = Boolean(modelStatus?.trained || patient.baselineStatus === "ready");
  const baselineProgressPct = Math.min(
    100,
    Math.round((collectedSamples / Math.max(1, minRequiredSamples)) * 100)
  );
  const modelVersionLabel =
    modelStatus?.model_version ||
    activeBaselineDoc?.modelVersion ||
    latestReading?.modelVersion ||
    patient.baselineModelVersion ||
    "Not trained yet";
  const lastUpdatedIso =
    modelStatus?.updated_at ||
    modelStatus?.trained_at ||
    activeBaselineDoc?.updatedAt ||
    latestReading?.createdAt ||
    null;

  if (compact) {
    return (
      <section className="arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-[#D9E0E0]">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center shrink-0">
              <Brain className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                AI Anomaly Detection &amp; Personal Baseline
              </h3>
              <p className="text-xs text-[#737B7B]">
                {mlConnected ? "Scikit-learn Isolation Forest" : "Demo Mode Fallback"} · Model:{" "}
                <span className="font-mono text-[#202525]">{modelVersionLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-2.5 py-1 rounded-lg border text-xs font-semibold ${anomalyBadge.cls}`}>
              {anomalyBadge.label}
            </span>
            {onNavigateTrends && (
              <button
                type="button"
                onClick={onNavigateTrends}
                className="arova-cta-secondary px-3 py-1.5 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] transition-colors cursor-pointer"
              >
                Full AI Analysis
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B]">Latest Score &amp; Quality</div>
            <div className="font-mono text-sm font-semibold text-[#202525] tabular-nums">
              {latestReading ? latestReading.anomalyScore.toFixed(3) : "--"}
              <span className="font-sans text-xs font-normal text-[#737B7B] ml-2">
                ({latestReading?.signalQuality ?? "standby"})
              </span>
            </div>
            <div className="text-[11px] text-[#737B7B]">
              Origin:{" "}
              <span className="font-mono text-[#008F00] font-medium">
                {latestReading?.source === "esp32_hardware"
                  ? "ESP32 Hardware"
                  : latestReading?.source === "simulator"
                  ? "Simulator (Test)"
                  : "None"}
              </span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1.5">
            <div className="text-[#737B7B]">Learned Personal Baseline</div>
            <div className="font-mono text-sm font-semibold text-[#202525] tabular-nums">
              HR {fmtStat(baselineStatsRows[0].mean, 1)} · SpO₂ {fmtStat(baselineStatsRows[1].mean, 1)}%
            </div>
            <div className="w-full h-1.5 rounded-full bg-[#D9E0E0] overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${baselineProgressPct}%` }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="h-full bg-[#00B800] rounded-full"
              />
            </div>
            <div className="text-[11px] text-[#737B7B]">
              {collectedSamples}/{minRequiredSamples} clean samples ·{" "}
              {baselineReady ? "Model Ready" : "Collecting"}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B]">Recent Anomaly Events</div>
            <div className="font-mono text-sm font-semibold text-[#202525] tabular-nums">
              <AnimatedNumber value={patientAnomalyEvents.length} /> logged event
              {patientAnomalyEvents.length === 1 ? "" : "s"}
            </div>
            <div className="text-[11px] text-[#737B7B] truncate">
              {patientAnomalyEvents[0]?.featureSummary || "No unusual pattern events recorded."}
            </div>
          </div>
        </div>

        {explanations.length > 0 && (
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3 space-y-1 text-xs text-[#202525]">
            {explanations.slice(0, 3).map((line, i) => (
              <div key={i} className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-[#00B800] shrink-0 mt-0.5" />
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}

        <p className="text-[11px] text-[#737B7B]">
          Non-diagnostic indicator only: AROVA identifies statistical deviations from personal sensor baselines and does not provide medical diagnoses or predict diseases.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Live AI Anomaly Intelligence Status & Explanations */}
      <section className="arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-[#D9E0E0]">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center shrink-0">
              <Brain className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                Phase 4 AI/ML Anomaly Intelligence ({patient.displayName})
              </h3>
              <p className="text-xs text-[#737B7B] mt-0.5">
                {mlConnected
                  ? "Python FastAPI + Scikit-learn Isolation Forest Active"
                  : "Demo Mode Fallback (Local Statistical Baseline Engine)"}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-2.5 py-1 rounded-lg border text-xs font-semibold ${anomalyBadge.cls}`}>
              {anomalyBadge.label}
            </span>
            <button
              type="button"
              onClick={() => void refreshMlState()}
              disabled={statusLoading}
              className="arova-cta-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? "animate-spin" : ""}`} />
              Refresh AI State
            </button>
          </div>
        </div>

        {/* Status Summary Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B] flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[#00B800]" />
              Live Anomaly Score
            </div>
            <div className="text-lg font-semibold font-mono tabular-nums text-[#202525]">
              {latestReading ? latestReading.anomalyScore.toFixed(4) : "--"}
            </div>
            <div className="text-[11px] text-[#737B7B]">
              Status: <span className="font-mono text-[#008F00] font-medium">{latestReading?.anomalyStatus ?? "standby"}</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B] flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#00B800]" />
              Sensor Quality &amp; Origin
            </div>
            <div className="text-sm font-semibold text-[#202525] capitalize">
              {latestReading?.signalQuality?.replace("_", " ") ?? "No Signal"}
            </div>
            <div className="text-[11px] font-mono text-[#737B7B]">
              {latestReading?.source === "esp32_hardware"
                ? "esp32_hardware (Real)"
                : latestReading?.source === "simulator"
                ? "simulator (Test)"
                : "awaiting_packet"}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B] flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-[#008F00]" />
              Model Version
            </div>
            <div className="text-sm font-semibold font-mono text-[#202525] truncate">
              {modelVersionLabel}
            </div>
            <div className="text-[11px] text-[#737B7B]">
              {baselineReady
                ? `Trained (${collectedSamples} samples)`
                : `Collecting (${collectedSamples}/${minRequiredSamples})`}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
            <div className="text-[#737B7B] flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#00B800]" />
              Last Model Update
            </div>
            <div className="text-xs font-semibold font-mono text-[#202525]">
              {lastUpdatedIso ? new Date(lastUpdatedIso).toLocaleString() : "Pending baseline fit"}
            </div>
            <div className="text-[11px] text-[#737B7B]">
              Patient ID: <span className="font-mono text-[#202525]">{patient.patientId}</span>
            </div>
          </div>
        </div>

        {/* AI Plain-Language Explanations */}
        <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[#008F00]">
              AI Explanations &amp; Contributing Measurements
            </h4>
            {latestReading?.contributingFeatures && latestReading.contributingFeatures.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {latestReading.contributingFeatures.map((feat) => (
                  <span
                    key={feat}
                    className="px-2 py-0.5 text-[11px] font-mono bg-white border border-[#D9E0E0] rounded text-[#008F00] font-medium"
                  >
                    {feat}
                  </span>
                ))}
              </div>
            )}
          </div>

          {explanations.length === 0 ? (
            <p className="text-xs text-[#737B7B]">
              No readings analyzed for this patient yet. Send a simulator or ESP32 packet to inspect AI explanations.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs text-[#202525]">
              {explanations.map((line, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <Info className="w-3.5 h-3.5 text-[#00B800] shrink-0 mt-0.5" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-[#737B7B] pt-1 border-t border-[#D9E0E0]">
            Non-diagnostic notice: Anomaly scores measure statistical deviation from this patient&apos;s own learned baseline only. They are not a clinical diagnosis and do not predict disease.
          </p>
        </div>
      </section>

      {/* 2. Personalized Baseline Statistics (Mean, Median, Std) + Anomaly History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-base font-semibold text-[#202525]">
                Personal Baseline Statistical Profile
              </h4>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Per-patient statistics learned strictly from valid, non-anomalous readings ({collectedSamples} clean samples)
              </p>
            </div>
            <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-[#EEF2F2] border border-[#D9E0E0] text-[#008F00] font-medium">
              {modelStatus?.source || activeBaselineDoc?.source || activeSourceForSamples}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#D9E0E0] text-[#737B7B]">
                  <th className="py-2 pr-3">Measurement</th>
                  <th className="py-2 pr-3 text-right">Current</th>
                  <th className="py-2 pr-3 text-right">Mean</th>
                  <th className="py-2 pr-3 text-right">Median</th>
                  <th className="py-2 text-right">Std Dev (σ)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#D9E0E0] font-mono tabular-nums">
                {baselineStatsRows.map((row) => (
                  <tr key={row.label} className="hover:bg-[#F7F9F9] transition-colors">
                    <td className="py-2.5 pr-3 font-sans font-medium text-[#202525]">
                      {row.label}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-[#202525]">
                      {fmtStat(row.current, row.unit === "g" ? 2 : 1, ` ${row.unit}`)}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-[#008F00] font-semibold">
                      {fmtStat(row.mean, row.unit === "g" ? 2 : 1, ` ${row.unit}`)}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-[#202525]">
                      {fmtStat(row.median, row.unit === "g" ? 2 : 1, ` ${row.unit}`)}
                    </td>
                    <td className="py-2.5 text-right text-[#737B7B]">
                      {fmtStat(row.std, 2, ` ${row.unit}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!baselineReady && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-xl p-3">
              Insufficient historical baseline data ({collectedSamples}/{minRequiredSamples} clean samples). Confirmed anomalies and poor-quality packets are excluded automatically so baseline learning stays accurate.
            </div>
          )}
        </section>

        <section className="lg:col-span-5 arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h4 className="text-base font-semibold text-[#202525]">Anomaly Event History</h4>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Patient-isolated anomaly log ({patientAnomalyEvents.length} events)
              </p>
            </div>
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          </div>

          {patientAnomalyEvents.length === 0 ? (
            <div className="py-8 text-center text-xs text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-xl bg-[#F7F9F9] px-4">
              No anomalous events recorded for {patient.displayName}.
            </div>
          ) : (
            <div className="divide-y divide-[#D9E0E0] max-h-64 overflow-y-auto pr-1">
              {patientAnomalyEvents.slice(0, 12).map((evt) => (
                <div key={evt.eventId} className="py-2.5 space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AlertLevelLabel level={evt.alertLevel} />
                      <span className="font-mono text-[#202525]">
                        score {evt.anomalyScore.toFixed(3)}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-[#737B7B]">
                      {new Date(evt.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-[#202525] leading-snug">{evt.featureSummary}</p>
                  <div className="text-[11px] text-[#737B7B] font-mono flex flex-wrap gap-2">
                    <span>source: {evt.source}</span>
                    {evt.contributingFeatures && evt.contributingFeatures.length > 0 && (
                      <span>· {evt.contributingFeatures.join(", ")}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 3. Model Evaluation & Generated Matplotlib Graphs */}
      <section className="arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-[#D9E0E0]">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#00B800]" />
            <div>
              <h4 className="text-base font-semibold text-[#202525]">
                Model Evaluation &amp; Matplotlib Telemetry Graphs
              </h4>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Evaluates {evaluationSamplesPayload.length} buffered reading(s) and saves Matplotlib PNG charts on the ML backend
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleRunEvaluation()}
              disabled={evalBusy || evaluationSamplesPayload.length === 0}
              className="arova-cta-secondary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-50 cursor-pointer"
            >
              <BarChart3 className="w-3.5 h-3.5 text-[#00B800]" />
              {evalBusy ? "Evaluating..." : "Run Model Evaluation"}
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateGraphs()}
              disabled={graphsBusy || evaluationSamplesPayload.length === 0}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 cursor-pointer"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              {graphsBusy ? "Rendering PNGs..." : "Generate Matplotlib Graphs"}
            </button>
          </div>
        </div>

        {evalError && (
          <div className="text-xs text-red-900 bg-red-50 border border-red-300 rounded-xl px-3 py-2">
            {evalError}
          </div>
        )}
        {graphsError && (
          <div className="text-xs text-red-900 bg-red-50 border border-red-300 rounded-xl px-3 py-2">
            {graphsError}
          </div>
        )}

        {evaluation && (
          <div className="space-y-4 bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#202525]">
                Evaluation Summary ({evaluation.sample_count} samples ·{" "}
                {evaluation.labeled_data_available ? "Labeled Evaluation" : "Unlabeled Evaluation"})
              </span>
              <span className="font-mono text-[#737B7B]">
                {new Date(evaluation.evaluated_at).toLocaleString()}
              </span>
            </div>

            <p className="text-xs text-[#737B7B] leading-relaxed">{evaluation.evaluation_note}</p>

            {/* Unsupervised Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-white border border-[#D9E0E0] rounded-xl p-3">
                <div className="text-[#737B7B]">Valid / Poor Quality</div>
                <div className="font-mono font-semibold text-[#202525] mt-0.5">
                  {evaluation.unsupervised_metrics.valid_quality_count} valid ·{" "}
                  {evaluation.unsupervised_metrics.poor_quality_count} poor
                </div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-xl p-3">
                <div className="text-[#737B7B]">Normal vs Anomalous</div>
                <div className="font-mono font-semibold text-[#202525] mt-0.5">
                  {evaluation.unsupervised_metrics.normal_count} norm ·{" "}
                  {evaluation.unsupervised_metrics.anomalous_count} anom
                </div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-xl p-3">
                <div className="text-[#737B7B]">Mean / Median Score</div>
                <div className="font-mono font-semibold text-[#202525] mt-0.5">
                  {fmtStat(evaluation.unsupervised_metrics.anomaly_score_mean, 3)} /{" "}
                  {fmtStat(evaluation.unsupervised_metrics.anomaly_score_median, 3)}
                </div>
              </div>
              <div className="bg-white border border-[#D9E0E0] rounded-xl p-3">
                <div className="text-[#737B7B]">Score Gap / IQR</div>
                <div className="font-mono font-semibold text-[#202525] mt-0.5">
                  {fmtStat(evaluation.unsupervised_metrics.normal_vs_anomalous_score_gap, 3)} /{" "}
                  {fmtStat(evaluation.unsupervised_metrics.anomaly_score_iqr, 3)}
                </div>
              </div>
            </div>

            {/* Supervised Metrics ONLY when labeled data exists */}
            {evaluation.labeled_data_available && evaluation.supervised_metrics ? (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div className="bg-white border border-[#00B800]/30 rounded-xl p-3">
                  <div className="text-[#737B7B]">Accuracy</div>
                  <div className="font-mono font-semibold text-[#008F00]">
                    {(evaluation.supervised_metrics.accuracy * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-white border border-[#00B800]/30 rounded-xl p-3">
                  <div className="text-[#737B7B]">Precision</div>
                  <div className="font-mono font-semibold text-[#008F00]">
                    {(evaluation.supervised_metrics.precision * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-white border border-[#00B800]/30 rounded-xl p-3">
                  <div className="text-[#737B7B]">Recall</div>
                  <div className="font-mono font-semibold text-[#008F00]">
                    {(evaluation.supervised_metrics.recall * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-white border border-[#00B800]/30 rounded-xl p-3">
                  <div className="text-[#737B7B]">F1-Score</div>
                  <div className="font-mono font-semibold text-[#008F00]">
                    {(evaluation.supervised_metrics.f1_score * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="bg-white border border-[#00B800]/30 rounded-xl p-3">
                  <div className="text-[#737B7B]">Confusion Matrix</div>
                  <div className="font-mono text-[11px] text-[#202525]">
                    TP:{evaluation.supervised_metrics.confusion_matrix.tp} FP:
                    {evaluation.supervised_metrics.confusion_matrix.fp} TN:
                    {evaluation.supervised_metrics.confusion_matrix.tn} FN:
                    {evaluation.supervised_metrics.confusion_matrix.fn}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-[#737B7B] bg-white border border-[#D9E0E0] rounded-xl p-3">
                <span className="font-semibold text-[#202525]">Metrics requiring ground-truth labels:</span>{" "}
                {evaluation.metrics_requiring_labels.join(", ")}. Because live/unlabeled patient readings do not include verified ground-truth labels, AROVA omits fabricated supervised scores and reports unsupervised separation &amp; score distribution metrics above.
              </div>
            )}
          </div>
        )}

        {/* Saved Matplotlib PNG Gallery */}
        {graphs.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-xl bg-[#F7F9F9] px-4">
            Click &quot;Generate Matplotlib Graphs&quot; to render Heart Rate, SpO₂, Temperature, Motion, Baseline Comparison, Normal vs Anomalous, and Anomaly Score over Time PNGs.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {graphs.map((g) => (
              <figure
                key={g.filename}
                className="border border-[#D9E0E0] rounded-xl overflow-hidden bg-white shadow-xs"
              >
                <img
                  src={g.url}
                  alt={g.title || g.metric || g.id}
                  loading="lazy"
                  className="w-full h-auto bg-[#F8FAFA]"
                />
                <figcaption className="px-3.5 py-2.5 border-t border-[#D9E0E0] flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[#202525] truncate">
                    {g.title || g.metric || g.id}
                  </span>
                  <span className="font-mono text-[11px] text-[#737B7B] shrink-0">
                    {g.point_count ? `${g.point_count} pts` : g.filename}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      {/* 4. Configurable Detection Parameters */}
      {configDraft && (
        <section className="arova-float-card-subtle arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-[#00B800]" />
              <div>
                <h4 className="text-base font-semibold text-[#202525]">
                  Isolation Forest &amp; Baseline Configuration
                </h4>
                <p className="text-xs text-[#737B7B]">
                  {isAdminUser
                    ? "Administrator access: configure contamination, ensemble trees, and warning/critical thresholds"
                    : "Read-only posture (Administrator role required to modify global ML thresholds)"}
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSaveConfig} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Contamination</span>
                <input
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={0.25}
                  disabled={!isAdminUser}
                  value={configDraft.contamination}
                  onChange={(e) =>
                    setConfigDraft((prev) =>
                      prev ? { ...prev, contamination: Number(e.target.value) } : prev
                    )
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:opacity-55 focus:outline-none focus:border-[#00B800]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Trees (n_estimators)</span>
                <input
                  type="number"
                  min={20}
                  max={400}
                  disabled={!isAdminUser}
                  value={configDraft.nEstimators}
                  onChange={(e) =>
                    setConfigDraft((prev) =>
                      prev ? { ...prev, nEstimators: Number(e.target.value) } : prev
                    )
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:opacity-55 focus:outline-none focus:border-[#00B800]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Min Baseline Samples</span>
                <input
                  type="number"
                  min={5}
                  max={500}
                  disabled={!isAdminUser}
                  value={configDraft.baselineMinSamples}
                  onChange={(e) =>
                    setConfigDraft((prev) =>
                      prev ? { ...prev, baselineMinSamples: Number(e.target.value) } : prev
                    )
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:opacity-55 focus:outline-none focus:border-[#00B800]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Warning Score Max</span>
                <input
                  type="number"
                  step="0.01"
                  min={-0.5}
                  max={0.2}
                  disabled={!isAdminUser}
                  value={configDraft.anomalyScoreWarning}
                  onChange={(e) =>
                    setConfigDraft((prev) =>
                      prev ? { ...prev, anomalyScoreWarning: Number(e.target.value) } : prev
                    )
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:opacity-55 focus:outline-none focus:border-[#00B800]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Critical Score Max</span>
                <input
                  type="number"
                  step="0.01"
                  min={-0.6}
                  max={0.1}
                  disabled={!isAdminUser}
                  value={configDraft.anomalyScoreCritical}
                  onChange={(e) =>
                    setConfigDraft((prev) =>
                      prev ? { ...prev, anomalyScoreCritical: Number(e.target.value) } : prev
                    )
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:opacity-55 focus:outline-none focus:border-[#00B800]"
                />
              </label>
            </div>

            {isAdminUser && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {configFeedback ? (
                  <span className="text-xs text-[#008F00] font-medium">{configFeedback}</span>
                ) : (
                  <span className="text-[11px] text-[#737B7B]">
                    Persists to Node backend and active Python Isolation Forest service.
                  </span>
                )}
                <button
                  type="submit"
                  disabled={configSaving}
                  className="arova-cta-primary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  {configSaving ? "Saving..." : "Apply ML Config"}
                </button>
              </div>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
