import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PatientRecord, VitalReading } from "../types/smartcare.ts";

type MetricKey = "heartRate" | "spo2" | "temperatureC" | "accelMagnitude" | "anomalyScore";

const METRIC_META: Record<
  MetricKey,
  {
    label: string;
    unit: string;
    color: string;
    fillStart: string;
    fillEnd: string;
    domain: [number | "auto", number | "auto"];
  }
> = {
  heartRate: {
    label: "Heart Rate",
    unit: "BPM",
    color: "#00B800",
    fillStart: "rgba(0, 184, 0, 0.28)",
    fillEnd: "rgba(0, 184, 0, 0.02)",
    domain: [45, 150],
  },
  spo2: {
    label: "Blood Oxygen (SpO₂)",
    unit: "%",
    color: "#008F00",
    fillStart: "rgba(0, 143, 0, 0.25)",
    fillEnd: "rgba(0, 143, 0, 0.02)",
    domain: [85, 100],
  },
  temperatureC: {
    label: "Temperature",
    unit: "°C",
    color: "#059669",
    fillStart: "rgba(5, 150, 105, 0.24)",
    fillEnd: "rgba(5, 150, 105, 0.02)",
    domain: [35, 40],
  },
  accelMagnitude: {
    label: "Motion / Activity",
    unit: "g",
    color: "#0D9488",
    fillStart: "rgba(13, 148, 136, 0.24)",
    fillEnd: "rgba(13, 148, 136, 0.02)",
    domain: [0, 4],
  },
  anomalyScore: {
    label: "Anomaly Score",
    unit: "score",
    color: "#DC2626",
    fillStart: "rgba(220, 38, 38, 0.22)",
    fillEnd: "rgba(220, 38, 38, 0.02)",
    domain: [-0.5, 0.4],
  },
};

export function TelemetryCharts({
  readings,
  patient,
}: {
  readings: VitalReading[];
  patient: PatientRecord;
}) {
  const [metric, setMetric] = useState<MetricKey>("heartRate");

  const chartData = useMemo(
    () =>
      readings.map((r) => ({
        time: new Date(r.createdAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        heartRate: typeof r.heartRate === "number" ? r.heartRate : null,
        spo2: typeof r.spo2 === "number" ? r.spo2 : null,
        temperatureC: typeof r.temperatureC === "number" ? r.temperatureC : null,
        accelMagnitude: typeof r.accelMagnitude === "number" ? Number(r.accelMagnitude.toFixed(2)) : null,
        anomalyScore: r.anomalyScore,
        alertLevel: r.alertLevel,
        isAnomalous: r.alertLevel !== "Normal" || r.anomalyStatus === "anomalous",
      })),
    [readings]
  );

  const validMetricCount = useMemo(
    () =>
      chartData.filter((d) => typeof d[metric] === "number" && Number.isFinite(d[metric])).length,
    [chartData, metric]
  );

  const anomalousCount = useMemo(
    () => chartData.filter((d) => d.isAnomalous).length,
    [chartData]
  );

  const meta = METRIC_META[metric];
  const baselineVal =
    metric === "heartRate"
      ? patient.baselineHeartRateMean
      : metric === "spo2"
      ? patient.baselineSpo2Mean
      : metric === "temperatureC"
      ? patient.baselineTempMean
      : metric === "accelMagnitude"
      ? 1.0
      : 0;

  return (
    <div className="arova-float-card-subtle arova-float-delay-2 arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#00B800] arova-status-normal-dot" aria-hidden="true" />
            <h3 className="text-base font-semibold text-[#202525]">
              Historical Vital &amp; Anomaly Trends
            </h3>
          </div>
          <p className="text-xs text-[#737B7B] mt-0.5">
            {validMetricCount}/{readings.length} valid points · {anomalousCount} anomalous marker(s) · Dashed line indicates personal baseline reference
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#EEF2F2] border border-[#D9E0E0] rounded-xl self-start sm:self-auto overflow-x-auto max-w-full">
          {(Object.keys(METRIC_META) as MetricKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMetric(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                metric === key
                  ? "bg-[#00B800] text-white font-semibold shadow-xs"
                  : "text-[#737B7B] hover:text-[#202525]"
              }`}
            >
              {METRIC_META[key].label}
            </button>
          ))}
        </div>
      </div>

      {chartData.length === 0 || validMetricCount === 0 ? (
        <div className="h-64 flex items-center justify-center border border-dashed border-[#D9E0E0] rounded-xl text-sm text-[#737B7B] px-4 text-center bg-[#F7F9F9]">
          {chartData.length === 0
            ? "No vital readings recorded yet. Send a simulator or ESP32 packet to visualize trends."
            : `No valid ${meta.label.toLowerCase()} measurements recorded yet (sensor disconnected or model pending).`}
        </div>
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`arovaGrad-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={meta.fillStart} />
                  <stop offset="95%" stopColor={meta.fillEnd} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5EBEB" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: "#737B7B" }}
                axisLine={{ stroke: "#D9E0E0" }}
                tickLine={false}
              />
              <YAxis
                domain={meta.domain}
                tick={{ fontSize: 11, fill: "#737B7B" }}
                axisLine={false}
                tickLine={false}
                width={42}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#FFFFFF",
                  borderColor: "#D9E0E0",
                  borderRadius: "12px",
                  fontSize: "12px",
                  color: "#202525",
                  boxShadow: "0 10px 24px rgba(8, 11, 11, 0.12)",
                }}
                formatter={(val: unknown) => [
                  typeof val === "number" ? `${val} ${meta.unit}` : "Unavailable",
                  meta.label,
                ]}
              />
              {typeof baselineVal === "number" && (
                <ReferenceLine
                  y={baselineVal}
                  stroke="#737B7B"
                  strokeDasharray="4 4"
                  label={{
                    value: `Baseline (${baselineVal})`,
                    position: "insideTopRight",
                    fill: "#202525",
                    fontSize: 11,
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey={metric}
                stroke={meta.color}
                strokeWidth={2.2}
                fill={`url(#arovaGrad-${metric})`}
                connectNulls={false}
                isAnimationActive={true}
                animationDuration={550}
                dot={(dotProps: {
                  cx?: number;
                  cy?: number;
                  payload?: { isAnomalous?: boolean; alertLevel?: string };
                  index?: number;
                }) => {
                  const { cx, cy, payload, index } = dotProps;
                  if (typeof cx !== "number" || typeof cy !== "number") return <g key={index} />;
                  if (payload?.isAnomalous) {
                    const fill = payload.alertLevel === "Critical" ? "#DC2626" : "#D97706";
                    return (
                      <circle
                        key={`anom-${index}`}
                        cx={cx}
                        cy={cy}
                        r={4.5}
                        fill={fill}
                        stroke="#FFFFFF"
                        strokeWidth={1.5}
                      />
                    );
                  }
                  return <g key={`norm-${index}`} />;
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
