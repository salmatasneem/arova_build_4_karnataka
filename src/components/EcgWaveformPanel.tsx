import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Info } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EcgSegmentRecord, TelemetrySource } from "../types/smartcare.ts";

function formatSourceLabel(source: TelemetrySource): string {
  if (source === "esp32_hardware") return "ESP32 Hardware (AD8232)";
  if (source === "simulator") return "Pipeline Simulator";
  return "Sample Demo Data";
}

function formatQualityLabel(
  quality: EcgSegmentRecord["signalQuality"],
  leadOff: boolean
): { text: string; toneClass: string } {
  if (leadOff || quality === "lead_off") {
    return { text: "Lead-Off (Electrode Disconnected)", toneClass: "text-red-700" };
  }
  if (quality === "noisy") {
    return { text: "Noisy Signal", toneClass: "text-amber-700" };
  }
  if (quality === "unavailable") {
    return { text: "Signal Unavailable", toneClass: "text-[#737B7B]" };
  }
  return { text: "Good Contact", toneClass: "text-[#008F00]" };
}

export function EcgWaveformPanel({
  segments,
  compact = false,
  title = "AD8232 Single-Lead ECG Waveform",
  hideSampleLabel = false,
}: {
  segments: EcgSegmentRecord[];
  compact?: boolean;
  title?: string;
  hideSampleLabel?: boolean;
}) {
  const orderedSegments = useMemo(
    () =>
      [...segments].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [segments]
  );

  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    if (orderedSegments.length === 0) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !orderedSegments.some((s) => s.segmentId === selectedId)) {
      setSelectedId(orderedSegments[0].segmentId);
    }
  }, [orderedSegments, selectedId]);

  const activeSegment =
    orderedSegments.find((s) => s.segmentId === selectedId) ?? orderedSegments[0] ?? null;

  const chartData = useMemo(() => {
    if (!activeSegment || activeSegment.samples.length === 0) return [];
    const sr = activeSegment.samplingRate > 0 ? activeSegment.samplingRate : 200;
    const stepMs = 1000 / sr;
    return activeSegment.samples.map((val, idx) => ({
      timeMs: Math.round(idx * stepMs),
      amplitude: Number(val.toFixed(2)),
    }));
  }, [activeSegment]);

  const qualityInfo = activeSegment
    ? formatQualityLabel(activeSegment.signalQuality, activeSegment.leadOff)
    : { text: "No ECG batch", toneClass: "text-[#737B7B]" };

  return (
    <section className="arova-float-card-subtle arova-float-delay-4 arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00B800] shrink-0" />
            <h3 className="text-base font-semibold text-[#202525]">{title}</h3>
          </div>
          <p className="text-xs text-[#737B7B] mt-0.5">
            {activeSegment ? (
              <>
                {!(hideSampleLabel && activeSegment.source === "sample_demo") && (
                  <>
                    <span className="font-medium text-[#202525]">
                      {formatSourceLabel(activeSegment.source)}
                    </span>
                    <span className="mx-1.5">·</span>
                  </>
                )}
                <span className="font-mono tabular-nums">{activeSegment.samplingRate} Hz</span>
                <span className="mx-1.5">·</span>
                <span className="font-mono tabular-nums">
                  {activeSegment.samples.length} samples/batch
                </span>
                <span className="mx-1.5">·</span>
                <span className={`font-semibold ${qualityInfo.toneClass}`}>
                  {qualityInfo.text}
                </span>
              </>
            ) : (
              "Batched AD8232 ADC1 telemetry appears here once transmitted."
            )}
          </p>
        </div>

        {orderedSegments.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-[#202525] shrink-0">
            <span>Segment:</span>
            <select
              value={activeSegment?.segmentId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              className="px-2.5 py-1.5 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] font-mono text-xs focus:outline-none focus:border-[#00B800]"
            >
              {orderedSegments.map((seg, idx) => (
                <option key={seg.segmentId} value={seg.segmentId}>
                  {idx === 0 ? "Latest · " : ""}
                  {new Date(seg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}{" "}
                  ({seg.leadOff ? "lead_off" : seg.signalQuality})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {activeSegment && activeSegment.leadOff && (
        <div className="bg-red-50 border border-red-300 rounded-xl px-3.5 py-2.5 flex items-start gap-2.5 text-xs text-red-900">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-red-900">AD8232 Lead-Off Detected:</span> One or
            more ECG electrodes (RA/LA/RL) are disconnected or making poor skin contact. Waveform
            metrics are suppressed until contact is restored.
          </div>
        </div>
      )}

      {!activeSegment || chartData.length === 0 ? (
        <div
          className={`${
            compact ? "h-44" : "h-56"
          } flex items-center justify-center border border-dashed border-[#D9E0E0] rounded-xl text-xs text-[#737B7B] px-4 text-center bg-[#F7F9F9]`}
        >
          No batched ECG waveform samples recorded for this segment yet.
        </div>
      ) : (
        <div className={`${compact ? "h-48" : "h-60"} w-full rounded-xl bg-[#F7FBF7] border border-[#D9E0E0] p-2`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
                width={38}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#FFFFFF",
                  borderColor: "#D9E0E0",
                  borderRadius: "10px",
                  fontSize: "12px",
                  color: "#202525",
                }}
                labelFormatter={(label: unknown) => `Offset: ${String(label)} ms`}
                formatter={(val: unknown) => [
                  typeof val === "number" ? val.toFixed(2) : String(val),
                  "ECG ADC / Norm",
                ]}
              />
              <Line
                type="monotone"
                dataKey="amplitude"
                stroke={activeSegment.leadOff ? "#DC2626" : "#00B800"}
                strokeWidth={1.85}
                dot={false}
                isAnimationActive={true}
                animationDuration={500}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {activeSegment?.features && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 text-xs">
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-2.5">
            <div className="text-[#737B7B]">Est. ECG Rate</div>
            <div className="font-mono tabular-nums font-semibold text-[#008F00] mt-0.5">
              {activeSegment.features.estimatedEcgBpm !== null
                ? `${activeSegment.features.estimatedEcgBpm.toFixed(0)} BPM`
                : "--"}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-2.5">
            <div className="text-[#737B7B]">Mean R-R Interval</div>
            <div className="font-mono tabular-nums font-semibold text-[#202525] mt-0.5">
              {activeSegment.features.rrIntervalMeanMs !== null
                ? `${activeSegment.features.rrIntervalMeanMs.toFixed(0)} ms`
                : "--"}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-2.5">
            <div className="text-[#737B7B]">R-R Variability</div>
            <div className="font-mono tabular-nums font-semibold text-[#202525] mt-0.5">
              {activeSegment.features.rrVariabilityMs !== null
                ? `${activeSegment.features.rrVariabilityMs.toFixed(1)} ms`
                : "--"}
            </div>
          </div>
          <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-2.5">
            <div className="text-[#737B7B]">Peak-to-Peak Span</div>
            <div className="font-mono tabular-nums font-semibold text-[#202525] mt-0.5">
              {activeSegment.features.amplitudeRange.toFixed(2)} units
            </div>
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-[#D9E0E0] flex items-start gap-2 text-xs text-[#737B7B] leading-relaxed">
        <Info className="w-3.5 h-3.5 text-[#00B800] shrink-0 mt-0.5" />
        <span>
          Provisional AD8232 telemetry visualization only. Dedicated ECG anomaly detection is{" "}
          <span className="font-medium text-[#202525]">not trained or clinically validated</span>{" "}
          for cardiac disease or arrhythmia diagnosis.
        </span>
      </div>
    </section>
  );
}
