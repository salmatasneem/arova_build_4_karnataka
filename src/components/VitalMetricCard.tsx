import type { ReactNode } from "react";
import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import { AnimatedNumber } from "./AnimatedNumber.tsx";

interface VitalMetricCardProps {
  label: string;
  value: string;
  unit?: string;
  baselineText: string;
  statusNote: string;
  tone: "normal" | "warning" | "critical";
  icon: ReactNode;
  accentVariant?: "primary" | "deep" | "emerald" | "forest";
  floatDelayClass?: string;
  entranceIndex?: number;
}

export function VitalMetricCard({
  label,
  value,
  unit,
  baselineText,
  statusNote,
  tone,
  icon,
  accentVariant = "primary",
  floatDelayClass = "arova-float-delay-1",
  entranceIndex = 0,
}: VitalMetricCardProps) {
  const iconContainerClass =
    tone === "critical"
      ? "bg-red-50 border-red-300 text-red-600 shadow-xs"
      : tone === "warning"
      ? "bg-amber-50 border-amber-300 text-amber-600 shadow-xs"
      : accentVariant === "deep"
      ? "bg-[#008F00]/12 border-[#008F00]/30 text-[#008F00]"
      : accentVariant === "emerald"
      ? "bg-[#00B800]/12 border-[#00B800]/35 text-[#008F00]"
      : accentVariant === "forest"
      ? "bg-[#008F00]/10 border-[#008F00]/25 text-[#008F00]"
      : "bg-[#00B800]/14 border-[#00B800]/35 text-[#00B800]";

  const toneText =
    tone === "critical"
      ? "text-red-700"
      : tone === "warning"
      ? "text-amber-700"
      : "text-[#008F00]";

  const cardBorderClass =
    tone === "critical"
      ? "border-red-300 hover:border-red-500 shadow-[0_8px_24px_-12px_rgba(220,38,38,0.22)]"
      : tone === "warning"
      ? "border-amber-300 hover:border-amber-500"
      : "border-[#D9E0E0] hover:border-[#00B800]";

  const footerBgClass =
    tone === "critical"
      ? "bg-red-50 border-red-200"
      : tone === "warning"
      ? "bg-amber-50 border-amber-200"
      : "bg-[#F7F9F9] border-[#D9E0E0]";

  const StatusIcon =
    tone === "critical"
      ? ShieldAlert
      : tone === "warning"
      ? AlertCircle
      : CheckCircle2;

  // Detect strictly numeric strings (e.g. "76", "98", "36.7") so sensor readings animate smoothly
  // without altering string statuses ("resting", "--", "walking")
  const trimmedValue = value.trim();
  const isStrictNumeric = /^-?\d+(?:\.\d+)?$/.test(trimmedValue);
  const parsedNumber = isStrictNumeric ? Number(trimmedValue) : null;
  const decimalPlaces = isStrictNumeric && trimmedValue.includes(".")
    ? trimmedValue.split(".")[1].length
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{
        duration: 0.48,
        delay: entranceIndex * 0.07,
        ease: [0.16, 1, 0.3, 1],
      }}
      className="h-full"
    >
      <div
        className={`arova-float-card ${floatDelayClass} h-full arova-glass-card border ${cardBorderClass} rounded-2xl overflow-hidden flex flex-col justify-between`}
      >
        <div className="p-5 pb-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <span className="text-[13px] font-semibold tracking-tight text-[#737B7B] leading-snug">
              {label}
            </span>
            <span
              className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${iconContainerClass}`}
              aria-hidden="true"
            >
              {icon}
            </span>
          </div>

          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-3xl sm:text-[34px] leading-none font-bold tracking-tight text-[#202525] font-mono tabular-nums capitalize truncate">
              {isStrictNumeric && parsedNumber !== null ? (
                <AnimatedNumber value={parsedNumber} decimals={decimalPlaces} />
              ) : (
                value
              )}
            </span>
            {unit && (
              <span className="text-sm font-semibold text-[#008F00] font-mono shrink-0">
                {unit}
              </span>
            )}
          </div>
        </div>

        <div
          className={`px-5 py-3 border-t ${footerBgClass} flex items-center justify-between gap-2 text-xs`}
        >
          <span className="text-[#737B7B] font-medium truncate">{baselineText}</span>
          <span
            className={`inline-flex items-center gap-1.5 font-semibold whitespace-nowrap shrink-0 ${toneText}`}
          >
            <StatusIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{statusNote}</span>
          </span>
        </div>
      </div>
    </motion.div>
  );
}
