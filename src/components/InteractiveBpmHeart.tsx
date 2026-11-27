import { useEffect, useState, type CSSProperties } from "react";
import { Activity, Eye, HeartPulse, Pause, Play } from "lucide-react";
import { AnimatedNumber } from "./AnimatedNumber.tsx";

export interface InteractiveBpmHeartProps {
  bpm: number | null;
  baselineBpm?: number | null;
  tone?: "normal" | "warning" | "critical";
  signalQuality?: string | null;
  mlConnected?: boolean;
}

export function InteractiveBpmHeart({
  bpm,
  baselineBpm = null,
  tone = "normal",
  signalQuality = null,
  mlConnected = false,
}: InteractiveBpmHeartProps) {
  const [inspectMode, setInspectMode] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const [manualRippleKey, setManualRippleKey] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [beatPhase, setBeatPhase] = useState(false);

  const hasLiveBpm = typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0;
  const clampedBpm = hasLiveBpm ? Math.max(35, Math.min(210, Math.round(bpm))) : null;
  const cycleMs = clampedBpm ? Math.round(60_000 / clampedBpm) : 1400;
  const isAnimating = hasLiveBpm && !motionPaused;

  useEffect(() => {
    if (!isAnimating) {
      setBeatPhase(false);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const pulseTick = () => {
      setBeatPhase(true);
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => setBeatPhase(false), Math.min(220, Math.round(cycleMs * 0.28)));
    };

    pulseTick();
    const intervalId = setInterval(pulseTick, cycleMs);
    return () => {
      clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isAnimating, cycleMs]);

  const deltaFromBaseline =
    clampedBpm !== null && typeof baselineBpm === "number" && Number.isFinite(baselineBpm)
      ? Math.round(clampedBpm - baselineBpm)
      : null;

  const palette =
    tone === "critical"
      ? {
          heartFill: "#DC2626",
          accentStroke: "#FCA5A5",
          ringStroke: "#F87171",
          nodeFill: "#FCA5A5",
          statusLabel: "Critical Range",
          statusClass: "text-red-700",
          beamVia: "via-red-400",
          beamShadow: "shadow-[0_0_14px_3px_rgba(248,113,113,0.75)]",
        }
      : tone === "warning"
        ? {
            heartFill: "#D97706",
            accentStroke: "#FDE68A",
            ringStroke: "#FBBF24",
            nodeFill: "#FDE68A",
            statusLabel: "Elevated Rhythm",
            statusClass: "text-amber-700",
            beamVia: "via-amber-300",
            beamShadow: "shadow-[0_0_14px_3px_rgba(251,191,36,0.7)]",
          }
        : {
            heartFill: "#008F00",
            accentStroke: "#6BF06B",
            ringStroke: "#00B800",
            nodeFill: "#00E000",
            statusLabel: hasLiveBpm ? "Live BPM Sync" : "Standby",
            statusClass: "text-[#008F00]",
            beamVia: "via-[#00B800]",
            beamShadow: "shadow-[0_0_14px_3px_rgba(0,184,0,0.75)]",
          };

  const handleHeartTrigger = () => {
    setManualRippleKey((k) => k + 1);
    setInspectMode((prev) => !prev);
  };

  const heartStyle = {
    "--arova-bpm-cycle": `${cycleMs}ms`,
  } as CSSProperties;

  return (
    <div className="space-y-3" style={heartStyle}>
      {/* Diagnostic Header + Interactive Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="inline-flex items-center gap-2 font-semibold text-[#202525]">
          <HeartPulse
            className={`w-4 h-4 transition-transform duration-150 ${
              beatPhase ? "scale-125 text-[#008F00]" : "text-[#00B800]"
            }`}
            aria-hidden="true"
          />
          <span>AI Cardiac &amp; Vital Scan</span>
          <span className={`font-mono text-[11px] font-semibold ${palette.statusClass}`}>
            · {palette.statusLabel}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setInspectMode((v) => !v)}
            aria-pressed={inspectMode}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              inspectMode
                ? "bg-[#00B800] text-white border-[#008F00] font-semibold"
                : "bg-white text-[#202525] border-[#D9E0E0] hover:border-[#00B800] hover:text-[#008F00]"
            }`}
            title="Inspect cardiac chambers and beat interval"
          >
            <Eye className="w-3 h-3" aria-hidden="true" />
            <span>{inspectMode ? "Telemetry On" : "Inspect"}</span>
          </button>

          <button
            type="button"
            onClick={() => setMotionPaused((p) => !p)}
            disabled={!hasLiveBpm}
            aria-pressed={motionPaused}
            aria-label={motionPaused ? "Resume BPM pulse animation" : "Pause BPM pulse animation"}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white text-[#202525] border border-[#D9E0E0] hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-45 cursor-pointer whitespace-nowrap shrink-0"
          >
            {motionPaused ? (
              <Play className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Pause className="w-3 h-3" aria-hidden="true" />
            )}
            <span>{motionPaused ? "Resume" : "Pause"}</span>
          </button>
        </div>
      </div>

      {/* Interactive SVG Heart Viewport */}
      <button
        type="button"
        onClick={handleHeartTrigger}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={
          clampedBpm
            ? `Interactive heart monitor beating at ${clampedBpm} BPM (${cycleMs} ms interval). Click to toggle cardiac telemetry inspection.`
            : "Interactive heart monitor waiting for live BPM reading. Click to inspect details."
        }
        className="group relative w-full h-48 rounded-xl bg-gradient-to-b from-[#080B0B] to-[#111818] border border-[#1E2A2A] hover:border-[#00B800] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B800] overflow-hidden flex items-center justify-center cursor-pointer transition-colors text-left shadow-inner"
      >
        {/* Precision AI Coordinate Grid */}
        <svg
          className="absolute inset-0 w-full h-full opacity-35 pointer-events-none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <defs>
            <pattern id="arova-ai-grid" width="22" height="22" patternUnits="userSpaceOnUse">
              <path
                d="M 22 0 L 0 0 0 22"
                fill="none"
                stroke="#00B800"
                strokeWidth="0.65"
                strokeOpacity="0.35"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#arova-ai-grid)" />
        </svg>

        {/* Live BPM Corner Readout Badge */}
        <div className="absolute top-2.5 left-3 z-20 flex items-baseline gap-1.5 px-2.5 py-1 rounded-lg bg-[#080B0B]/90 border border-[#00B800]/35 backdrop-blur-xs">
          <span
            className={`w-2 h-2 rounded-full transition-opacity duration-100 ${
              beatPhase
                ? tone === "critical"
                  ? "bg-red-400 opacity-100"
                  : tone === "warning"
                    ? "bg-amber-300 opacity-100"
                    : "bg-[#00E000] opacity-100"
                : "bg-white/35 opacity-60"
            }`}
            aria-hidden="true"
          />
          <span className="text-lg font-bold text-white font-mono tabular-nums leading-none">
            <AnimatedNumber value={clampedBpm} />
          </span>
          <span className="text-[10px] font-mono text-[#4CE64C]">BPM</span>
        </div>

        {/* Beat Interval & ML Engine Tag */}
        <div className="absolute top-2.5 right-3 z-20 flex items-center gap-1.5 text-[10px] font-mono text-[#D9E0E0]">
          <span className="tabular-nums">{clampedBpm ? `${cycleMs} ms/beat` : "Awaiting signal"}</span>
          <span className="text-white/30" aria-hidden="true">·</span>
          <span className="text-[#4CE64C]">{mlConnected ? "ML ONLINE" : "DEMO ENGINE"}</span>
        </div>

        {/* Central Human Heart SVG Synced to Live BPM */}
        <svg
          className="relative z-10 w-68 h-40 pointer-events-none"
          viewBox="0 0 280 156"
          fill="none"
          aria-hidden="true"
        >
          {/* AI HUD Corner Scanner Brackets */}
          <path
            d="M18 26V14H32M248 14H262V26M18 130V142H32M248 142H262V130"
            stroke={palette.ringStroke}
            strokeWidth="1.4"
            strokeOpacity={hovered || inspectMode ? "0.95" : "0.65"}
            strokeLinecap="round"
          />

          {/* Concentric Calibration Rings */}
          <circle
            cx="140"
            cy="76"
            r="54"
            stroke="#008F00"
            strokeWidth="1"
            strokeDasharray="5 4"
            strokeOpacity="0.65"
          />
          <circle
            cx="140"
            cy="76"
            r="42"
            stroke="#00B800"
            strokeWidth="0.9"
            strokeOpacity="0.4"
          />

          {/* Expanding Systolic Wave Ring synced to exact BPM cycle */}
          {isAnimating && (
            <circle
              key={`wave-${manualRippleKey}-${cycleMs}`}
              cx="140"
              cy="76"
              r="42"
              stroke={palette.ringStroke}
              strokeWidth="1.8"
              className="arova-bpm-wave-ring"
            />
          )}

          {/* Neural Connectors & Matrix Vectors */}
          <path
            d="M42 40L96 58M42 114L100 94M238 40L184 58M238 114L180 94M140 16V28M140 124V136"
            stroke={palette.ringStroke}
            strokeWidth="1.1"
            strokeDasharray="3 3"
            strokeOpacity={inspectMode ? "0.95" : "0.7"}
          />

          {/* Anatomical Human Heart Synced to Live BPM */}
          <g className={isAnimating ? "arova-bpm-heart-beat" : ""}>
            <path
              d="M132 38C132 28 142 23 151 28C155 30 157 35 157 41M140 28V20M148 27V21M123 44V34"
              stroke={palette.accentStroke}
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M140 116C140 116 105 97 104 68C103.5 52 114 40 127 40C134 40 138.5 44 140 49C142 43 147.5 38 156 39C169 40 177 52 176 67C175 94 140 116 140 116Z"
              fill={palette.heartFill}
              fillOpacity={beatPhase ? "0.76" : "0.52"}
              stroke="#E8F8E8"
              strokeWidth={hovered || inspectMode ? "2.4" : "2"}
              strokeLinejoin="round"
            />
            <path
              d="M140 50C138 68 140 89 140 113M114 62C123 64 131 68 139 74M166 60C157 63 149 68 141 75"
              stroke={palette.accentStroke}
              strokeWidth={inspectMode ? "1.6" : "1.2"}
              strokeLinecap="round"
              strokeOpacity={inspectMode ? "1" : "0.85"}
            />
          </g>

          {/* Animated Visual Pulse Waveform (not a diagnostic ECG trace) */}
          <path
            d="M20 80H86L95 66L106 94L118 50L129 104L140 44L151 98L161 72L170 80H260"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={beatPhase ? "1" : "0.82"}
          />

          {inspectMode && (
            <g className="text-[8px] font-mono" fill="#B8F5B8">
              <text x="26" y="34">RA / LA Atrium</text>
              <text x="192" y="34">Aortic Arch</text>
              <text x="26" y="128">PPG Sync</text>
              <text x="192" y="128">LV Ventricle</text>
            </g>
          )}

          {/* Glowing Sensor Nodes */}
          <circle cx="42" cy="40" r="3.5" fill={palette.nodeFill} />
          <circle cx="42" cy="114" r="3.5" fill="#00B800" stroke="#FFFFFF" strokeWidth="1" />
          <circle cx="238" cy="40" r="3.5" fill="#FFFFFF" stroke="#00B800" strokeWidth="1.5" />
          <circle cx="238" cy="114" r="3.5" fill={palette.nodeFill} />
          <circle
            cx="140"
            cy="44"
            r={beatPhase ? "4.6" : "3.6"}
            fill="#FFFFFF"
            stroke={palette.heartFill}
            strokeWidth="1.6"
          />
          <circle cx="184" cy="58" r="2.8" fill={palette.accentStroke} />
          <circle cx="96" cy="58" r="2.8" fill={palette.accentStroke} />
        </svg>

        {/* Animated Glowing AI Vital Scan Beam */}
        {!motionPaused && (
          <div
            aria-hidden="true"
            className={`arova-scan-beam pointer-events-none absolute inset-x-3 top-2 h-0.5 bg-gradient-to-r from-transparent ${palette.beamVia} to-transparent ${palette.beamShadow}`}
          />
        )}

        {/* Sensor Stack Labels + Click Prompt */}
        <div className="absolute bottom-2.5 inset-x-3 z-20 flex items-center justify-between gap-2 text-[10px] font-mono text-[#D9E0E0]">
          <span>MAX30100 · PPG</span>
          <span className="text-[#4CE64C]">
            {inspectMode ? "Tap heart to close telemetry" : "Tap heart to inspect"}
          </span>
          <span>AD8232 · ECG</span>
        </div>
      </button>

      {/* Expandable Cardiac Beat Telemetry Strip when clicked/inspected */}
      {inspectMode && (
        <div className="rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] px-3.5 py-2.5 grid grid-cols-3 gap-2 text-xs shadow-xs">
          <div>
            <div className="text-[11px] text-[#737B7B]">Beat Interval (IBI)</div>
            <div className="font-mono font-semibold text-[#202525] tabular-nums">
              {clampedBpm ? `${cycleMs} ms` : "--"}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#737B7B]">vs. Baseline</div>
            <div className="font-mono font-semibold text-[#202525] tabular-nums">
              {deltaFromBaseline === null
                ? "Pending"
                : deltaFromBaseline === 0
                  ? "At baseline"
                  : `${deltaFromBaseline > 0 ? "+" : ""}${deltaFromBaseline} BPM`}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#737B7B]">Optical Signal</div>
            <div className="inline-flex items-center gap-1 font-semibold text-[#008F00] capitalize truncate">
              <Activity className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
              <span className="truncate">{signalQuality ? signalQuality.replace("_", " ") : "Nominal"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
