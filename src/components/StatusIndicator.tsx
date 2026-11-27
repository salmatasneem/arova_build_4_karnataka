import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import type { AlertLevel } from "../types/smartcare.ts";

export function AlertLevelLabel({ level }: { level: AlertLevel }) {
  if (level === "Critical") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-semibold text-red-700 whitespace-nowrap shrink-0">
        <span className="relative inline-flex items-center justify-center w-2.5 h-2.5" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-red-500/65 arova-status-critical-ring" />
          <span className="relative w-2 h-2 rounded-full bg-red-600" />
        </span>
        <ShieldAlert className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
        Critical
      </span>
    );
  }
  if (level === "Warning") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-semibold text-amber-800 whitespace-nowrap shrink-0">
        <span className="relative inline-flex items-center justify-center w-2.5 h-2.5" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-amber-500/65 arova-status-warning-ring" />
          <span className="relative w-2 h-2 rounded-full bg-amber-600" />
        </span>
        <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" aria-hidden="true" />
        Warning
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs font-semibold text-[#008F00] whitespace-nowrap shrink-0">
      <span
        className="w-2 h-2 rounded-full bg-[#00B800] arova-status-normal-dot shadow-[0_0_8px_rgba(0,184,0,0.45)]"
        aria-hidden="true"
      />
      <CheckCircle2 className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
      Normal
    </span>
  );
}
