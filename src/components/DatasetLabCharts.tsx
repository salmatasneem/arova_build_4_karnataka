import { useMemo } from "react";
import { Activity, AlertTriangle, Info, Thermometer, Waves } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AvailableModalities,
  DatasetProvenanceSummary,
  PlaybackFrameResult,
} from "../types/smartcare.ts";
import { AnimatedNumber } from "./AnimatedNumber.tsx";

function formatOffsetLabel(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(totalSec < 10 ? 1 : 0)}s`;
  const mins = Math.floor(totalSec / 60);
  const remSec = Math.floor(totalSec % 60);
  return `${mins}:${String(remSec).padStart(2, "0")}`;
}

function formatTempSiteLabel(site: string | null | undefined): string {
  switch (site) {
    case "skin_wrist":
      return "Wrist skin temperature (typically lower than oral/core body temp)";
    case "skin_chest":
      return "Chest skin temperature";
    case "axillary":
      return "Axillary temperature";
    case "core_rectal":
      return "Core rectal temperature";
    case "ambient":
      return "Ambient sensor";
    default:
      return "Sensor site unspecified";
  }
}

interface ModalityListEntry {
  key: keyof AvailableModalities;
  label: string;
}

const MODALITY_LABELS: ModalityListEntry[] = [
  { key: "heartRate", label: "Heart Rate / PPG" },
  { key: "spo2", label: "SpO₂ (Oxygen Saturation)" },
  { key: "ecg", label: "ECG Waveform" },
  { key: "imu", label: "IMU (Accel / Gyro)" },
  { key: "temperatureC", label: "Temperature" },
  { key: "respiratoryRate", label: "Respiratory Rate" },
  { key: "sleepStage", label: "Sleep Stage" },
];

const CLINICAL_TOOLTIP_STYLE = {
  backgroundColor: "#FFFFFF",
  borderColor: "#D9E0E0",
  borderRadius: "10px",
  fontSize: "12px",
  color: "#202525",
  boxShadow: "0 10px 24px rgba(8, 11, 11, 0.12)",
};

export function DatasetLabCharts({
  provenance,
  recentResults,
  lastResult,
}: {
  provenance: DatasetProvenanceSummary | null;
  recentResults: PlaybackFrameResult[];
  lastResult: PlaybackFrameResult | null;
}) {
  const modalities = provenance?.availableModalities ?? {};

  const timelineData = useMemo(
    () =>
      recentResults.map((r) => ({
        offsetLabel: formatOffsetLabel(r.relativeOffsetMs),
        frameIndex: r.frameIndex,
        heartRate: r.telemetrySnapshot.heartRate,
        spo2: r.telemetrySnapshot.spo2,
        temperatureC: r.telemetrySnapshot.temperatureC,
        respiratoryRateBpm: r.telemetrySnapshot.respiratoryRateBpm,
        accelMagnitude: Number(r.telemetrySnapshot.accelMagnitude.toFixed(3)),
        gyroMagnitude: Number(r.telemetrySnapshot.gyroMagnitude.toFixed(2)),
        anomalyScore: Number(r.analysis.anomalyScore.toFixed(4)),
        alertLevel: r.analysis.alertLevel,
        movementStatus: r.telemetrySnapshot.movementStatus,
        groundTruthLabel: r.groundTruthLabel,
        groundTruthFlag:
          r.groundTruthIsAnomalous === true
            ? 1
            : r.groundTruthIsAnomalous === false
            ? 0
            : null,
      })),
    [recentResults]
  );

  const ecgChartData = useMemo(() => {
    const samples = lastResult?.telemetrySnapshot.ecgSamples;
    if (!samples || samples.length === 0) return [];
    const sr =
      lastResult.telemetrySnapshot.ecgSamplingRate &&
      lastResult.telemetrySnapshot.ecgSamplingRate > 0
        ? lastResult.telemetrySnapshot.ecgSamplingRate
        : 200;
    const stepMs = 1000 / sr;
    return samples.map((val, idx) => ({
      timeMs: Math.round(idx * stepMs),
      amplitude: Number(val.toFixed(3)),
    }));
  }, [lastResult]);

  const unavailableModalities = useMemo(
    () => MODALITY_LABELS.filter((m) => !modalities[m.key]),
    [modalities]
  );

  if (!provenance) {
    return (
      <section className="bg-white border border-dashed border-[#D9E0E0] rounded-2xl p-6 text-center space-y-2 shadow-xs">
        <p className="text-sm font-medium text-[#202525]">
          No Dataset Recording Loaded for Sensor Visualization
        </p>
        <p className="text-xs text-[#737B7B] max-w-2xl mx-auto leading-relaxed">
          Import a verified public dataset CSV or TXT trace above. Charts render dynamically and
          strictly for the sensor modalities present in the imported recording—missing channels are
          never fabricated or backfilled.
        </p>
      </section>
    );
  }

  const latestSnap = lastResult?.telemetrySnapshot ?? null;
  const ecgFeatures = lastResult?.analysis.ecgFeatures;
  const hasPlayedFrames = timelineData.length > 0;

  return (
    <div className="space-y-4">
      {/* Modality Inventory Bar */}
      <div className="bg-white border border-[#D9E0E0] rounded-xl px-4 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 text-xs shadow-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="uppercase tracking-wider font-mono text-[#008F00] font-semibold">
            Active Sensor Channels
          </span>
          <span className="text-[#D9E0E0]">/</span>
          <span className="text-[#202525] font-mono font-medium">
            {MODALITY_LABELS.filter((m) => modalities[m.key])
              .map((m) => m.label)
              .join(" · ") || "None detected"}
          </span>
        </div>
        {unavailableModalities.length > 0 && (
          <div className="text-[#737B7B] font-mono text-[11px]">
            Unavailable (not fabricated):{" "}
            <span>{unavailableModalities.map((m) => m.label).join(" · ")}</span>
          </div>
        )}
      </div>

      {/* Live Numeric Telemetry Readout for Present Modalities Only */}
      {latestSnap && (
        <div className="arova-float-grid grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {modalities.heartRate && (
            <div className="arova-float-card arova-float-delay-1 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                Heart Rate
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#008F00] mt-1">
                <AnimatedNumber value={latestSnap.heartRate} />
                <span className="text-xs text-[#737B7B] ml-1">BPM</span>
              </div>
            </div>
          )}

          {modalities.spo2 && (
            <div className="arova-float-card arova-float-delay-2 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                SpO₂
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#00B800] mt-1">
                <AnimatedNumber value={latestSnap.spo2} decimals={1} />
                <span className="text-xs text-[#737B7B] ml-1">%</span>
              </div>
            </div>
          )}

          {modalities.temperatureC && (
            <div className="arova-float-card arova-float-delay-3 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                Temperature
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#202525] mt-1">
                <AnimatedNumber value={latestSnap.temperatureC} decimals={2} />
                <span className="text-xs text-[#737B7B] ml-1">°C</span>
              </div>
              <div className="text-[10px] font-mono text-[#737B7B] mt-0.5 truncate">
                {latestSnap.temperatureSite ?? provenance.temperatureSite ?? "site unknown"}
              </div>
            </div>
          )}

          {modalities.respiratoryRate && (
            <div className="arova-float-card arova-float-delay-4 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                Resp Rate
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#008F00] mt-1">
                <AnimatedNumber value={latestSnap.respiratoryRateBpm} decimals={1} />
                <span className="text-xs text-[#737B7B] ml-1">BrPM</span>
              </div>
            </div>
          )}

          {modalities.imu && (
            <div className="arova-float-card arova-float-delay-5 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                IMU Accel / Gyro
              </div>
              <div className="text-xl font-semibold font-mono tabular-nums text-[#202525] mt-1">
                {latestSnap.accelMagnitude.toFixed(2)}
                <span className="text-xs text-[#737B7B] ml-1">g</span>
                <span className="text-[#D9E0E0] mx-1">/</span>
                {latestSnap.gyroMagnitude.toFixed(1)}
                <span className="text-xs text-[#737B7B] ml-1">°/s</span>
              </div>
              <div className="text-[10px] font-mono text-[#737B7B] mt-0.5">
                {latestSnap.movementStatus}
                {latestSnap.possibleFallDetected ? " · fall_flag" : ""}
              </div>
            </div>
          )}

          {modalities.ecg && (
            <div className="arova-float-card arova-float-delay-6 arova-glass-card border border-[#D9E0E0] rounded-xl p-3.5">
              <div className="text-[11px] uppercase tracking-wider font-mono text-[#737B7B]">
                ECG Est. Rate
              </div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-[#008F00] mt-1">
                <AnimatedNumber value={ecgFeatures?.estimatedEcgBpm} />
                <span className="text-xs text-[#737B7B] ml-1">BPM</span>
              </div>
              <div className="text-[10px] font-mono text-[#737B7B] mt-0.5">
                {ecgFeatures
                  ? `${ecgFeatures.rPeakCount} R-peaks · ${ecgFeatures.signalQuality}`
                  : "window"}
              </div>
            </div>
          )}
        </div>
      )}

      {!hasPlayedFrames ? (
        <div className="bg-white border border-dashed border-[#D9E0E0] rounded-xl p-8 text-center text-xs text-[#737B7B]">
          Recording loaded (
          <span className="font-mono font-medium text-[#202525]">
            {provenance.originalFilename}
          </span>
          ). Press <span className="text-[#008F00] font-semibold">Start</span> or{" "}
          <span className="text-[#008F00] font-semibold">Step</span> in the playback controls
          to stream frames and plot live sensor charts.
        </div>
      ) : (
        <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Heart Rate Chart */}
          {modalities.heartRate && (
            <section className="arova-float-card-subtle arova-float-delay-1 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#00B800]" />
                  <h4 className="text-sm font-semibold text-[#202525]">Heart Rate / PPG Stream</h4>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B]">
                  BPM · {timelineData.length} frames
                </span>
              </div>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timelineData} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dlHrGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00B800" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#00B800" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                    <XAxis
                      dataKey="offsetLabel"
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={{ stroke: "#D9E0E0" }}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={CLINICAL_TOOLTIP_STYLE}
                      formatter={(val: unknown) => [
                        typeof val === "number" ? `${val.toFixed(1)} BPM` : "null (missing)",
                        "Heart Rate",
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="heartRate"
                      stroke="#00B800"
                      strokeWidth={2}
                      fill="url(#dlHrGrad)"
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* SpO2 Chart */}
          {modalities.spo2 && (
            <section className="arova-float-card-subtle arova-float-delay-2 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Waves className="w-4 h-4 text-[#008F00]" />
                  <h4 className="text-sm font-semibold text-[#202525]">Blood Oxygen (SpO₂)</h4>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B]">% saturation</span>
              </div>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timelineData} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dlSpo2Grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#008F00" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#008F00" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                    <XAxis
                      dataKey="offsetLabel"
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={{ stroke: "#D9E0E0" }}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      domain={[80, 100]}
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={CLINICAL_TOOLTIP_STYLE}
                      formatter={(val: unknown) => [
                        typeof val === "number" ? `${val.toFixed(1)}%` : "null (missing)",
                        "SpO₂",
                      ]}
                    />
                    <ReferenceLine y={90} stroke="#D97706" strokeDasharray="4 4" />
                    <Area
                      type="monotone"
                      dataKey="spo2"
                      stroke="#008F00"
                      strokeWidth={2}
                      fill="url(#dlSpo2Grad)"
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* Temperature Chart */}
          {modalities.temperatureC && (
            <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Thermometer className="w-4 h-4 text-[#059669]" />
                  <div>
                    <h4 className="text-sm font-semibold text-[#202525]">Temperature Stream</h4>
                    <p className="text-[11px] font-mono text-amber-700 mt-0.5">
                      Site: {formatTempSiteLabel(provenance.temperatureSite)}
                    </p>
                  </div>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B] shrink-0">°C</span>
              </div>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timelineData} margin={{ top: 8, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                    <XAxis
                      dataKey="offsetLabel"
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={{ stroke: "#D9E0E0" }}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={CLINICAL_TOOLTIP_STYLE}
                      formatter={(val: unknown) => [
                        typeof val === "number" ? `${val.toFixed(2)} °C` : "null (missing)",
                        "Temperature",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="temperatureC"
                      stroke="#059669"
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* Respiratory Rate Chart */}
          {modalities.respiratoryRate && (
            <section className="arova-float-card-subtle arova-float-delay-4 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Waves className="w-4 h-4 text-[#0D9488]" />
                  <h4 className="text-sm font-semibold text-[#202525]">Respiratory Rate</h4>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B]">breaths / min</span>
              </div>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timelineData} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                    <XAxis
                      dataKey="offsetLabel"
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={{ stroke: "#D9E0E0" }}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={CLINICAL_TOOLTIP_STYLE}
                      formatter={(val: unknown) => [
                        typeof val === "number" ? `${val.toFixed(1)} BrPM` : "null (missing)",
                        "Respiratory Rate",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="respiratoryRateBpm"
                      stroke="#0D9488"
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* IMU Accelerometer & Gyroscope Chart */}
          {modalities.imu && (
            <section className="arova-float-card-subtle arova-float-delay-5 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#00B800]" />
                  <h4 className="text-sm font-semibold text-[#202525]">
                    IMU Kinematics (Accel g &amp; Gyro °/s)
                  </h4>
                </div>
                {latestSnap && (
                  <span className="text-[11px] font-mono text-[#737B7B]">
                    {latestSnap.accelX !== null
                      ? `XYZ ${latestSnap.accelX.toFixed(2)}, ${latestSnap.accelY?.toFixed(2)}, ${latestSnap.accelZ?.toFixed(2)}g`
                      : `Mag ${latestSnap.accelMagnitude.toFixed(2)}g`}
                  </span>
                )}
              </div>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timelineData} margin={{ top: 8, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                    <XAxis
                      dataKey="offsetLabel"
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={{ stroke: "#D9E0E0" }}
                      tickLine={false}
                      minTickGap={20}
                    />
                    <YAxis
                      yAxisId="acc"
                      domain={[0, "auto"]}
                      tick={{ fontSize: 10, fill: "#008F00" }}
                      axisLine={false}
                      tickLine={false}
                      width={34}
                    />
                    <YAxis
                      yAxisId="gyro"
                      orientation="right"
                      domain={[0, "auto"]}
                      tick={{ fontSize: 10, fill: "#737B7B" }}
                      axisLine={false}
                      tickLine={false}
                      width={38}
                    />
                    <Tooltip contentStyle={CLINICAL_TOOLTIP_STYLE} />
                    <ReferenceLine yAxisId="acc" y={2.5} stroke="#DC2626" strokeDasharray="4 4" />
                    <Line
                      yAxisId="acc"
                      type="monotone"
                      dataKey="accelMagnitude"
                      name="Accel Mag (g)"
                      stroke="#00B800"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="gyro"
                      type="monotone"
                      dataKey="gyroMagnitude"
                      name="Gyro Mag (°/s)"
                      stroke="#202525"
                      strokeWidth={1.75}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {latestSnap?.possibleFallDetected && (
                <div className="flex items-center gap-2 text-xs text-red-900 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-600" />
                  <span>
                    Impact threshold indicator flagged on frame #{lastResult?.frameIndex} (experimental heuristic; non-clinical).
                  </span>
                </div>
              )}
            </section>
          )}

          {/* ECG Waveform Chart */}
          {modalities.ecg && (
            <section className="arova-float-card-subtle arova-float-delay-6 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#00B800]" />
                  <h4 className="text-sm font-semibold text-[#202525]">
                    ECG Window Waveform &amp; R-Peak Metrics
                  </h4>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B]">
                  {latestSnap?.ecgSamplingRate ?? provenance.samplingRateHz ?? 360} Hz ·{" "}
                  {ecgChartData.length} pts
                </span>
              </div>
              {ecgChartData.length === 0 ? (
                <div className="h-48 flex items-center justify-center border border-dashed border-[#D9E0E0] rounded-lg text-xs text-[#737B7B] bg-[#F7F9F9]">
                  No ECG sample window present on the latest frame.
                </div>
              ) : (
                <div className="h-48 w-full rounded-xl bg-[#F7FBF7] border border-[#D9E0E0] p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ecgChartData} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#DCE5DC" />
                      <XAxis
                        dataKey="timeMs"
                        tick={{ fontSize: 10, fill: "#737B7B" }}
                        tickFormatter={(v: number) => `${v}ms`}
                        axisLine={{ stroke: "#D9E0E0" }}
                        tickLine={false}
                        minTickGap={24}
                      />
                      <YAxis
                        domain={["auto", "auto"]}
                        tick={{ fontSize: 10, fill: "#737B7B" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={CLINICAL_TOOLTIP_STYLE}
                        labelFormatter={(label: unknown) => `Offset: ${String(label)} ms`}
                        formatter={(val: unknown) => [
                          typeof val === "number" ? val.toFixed(3) : String(val),
                          "ECG (mV / norm)",
                        ]}
                      />
                      <Line
                        type="monotone"
                        dataKey="amplitude"
                        stroke={latestSnap?.ecgLeadOff ? "#DC2626" : "#00B800"}
                        strokeWidth={1.65}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              {ecgFeatures && (
                <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
                  <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2">
                    <div className="text-[#737B7B]">ECG BPM</div>
                    <div className="text-[#008F00] font-semibold tabular-nums mt-0.5">
                      {ecgFeatures.estimatedEcgBpm !== null
                        ? `${ecgFeatures.estimatedEcgBpm.toFixed(1)}`
                        : "--"}
                    </div>
                  </div>
                  <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2">
                    <div className="text-[#737B7B]">R-R Mean</div>
                    <div className="text-[#202525] font-semibold tabular-nums mt-0.5">
                      {ecgFeatures.rrIntervalMeanMs !== null
                        ? `${ecgFeatures.rrIntervalMeanMs.toFixed(0)}ms`
                        : "--"}
                    </div>
                  </div>
                  <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2">
                    <div className="text-[#737B7B]">HRV (SDNN)</div>
                    <div className="text-[#202525] font-semibold tabular-nums mt-0.5">
                      {ecgFeatures.rrVariabilityMs !== null
                        ? `${ecgFeatures.rrVariabilityMs.toFixed(1)}ms`
                        : "--"}
                    </div>
                  </div>
                  <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-2">
                    <div className="text-[#737B7B]">R-Peaks</div>
                    <div className="text-[#202525] font-semibold tabular-nums mt-0.5">
                      {ecgFeatures.rPeakCount} ({ecgFeatures.signalQuality})
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Live ML Anomaly Score Timeline */}
          <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card border border-[#D9E0E0] rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-amber-600" />
                <h4 className="text-sm font-semibold text-[#202525]">
                  Isolation Forest Anomaly Score Stream
                </h4>
              </div>
              <span className="text-[11px] font-mono text-[#737B7B]">
                Lower negative scores = stronger anomaly
              </span>
            </div>
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData} margin={{ top: 8, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dlScoreGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#D97706" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="#D97706" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
                  <XAxis
                    dataKey="offsetLabel"
                    tick={{ fontSize: 10, fill: "#737B7B" }}
                    axisLine={{ stroke: "#D9E0E0" }}
                    tickLine={false}
                    minTickGap={20}
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    tick={{ fontSize: 10, fill: "#737B7B" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={CLINICAL_TOOLTIP_STYLE}
                    formatter={(val: unknown) => [
                      typeof val === "number" ? val.toFixed(4) : String(val),
                      "Anomaly Score",
                    ]}
                  />
                  <ReferenceLine y={0} stroke="#737B7B" strokeDasharray="4 4" />
                  <Area
                    type="monotone"
                    dataKey="anomalyScore"
                    stroke="#D97706"
                    strokeWidth={2}
                    fill="url(#dlScoreGrad)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
