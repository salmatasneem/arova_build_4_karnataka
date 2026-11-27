import type { ReactNode } from "react";
import { motion } from "motion/react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ArovaLogo } from "./ArovaLogo.tsx";

export function ArovaLoadingScreen({
  message = "Initializing AROVA Telemetry & Security...",
}: {
  message?: string;
}) {
  return (
    <div className="min-h-screen bg-[#EEF2F2] arova-hero-mesh flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Subtle medical green ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute w-[420px] h-[420px] rounded-full bg-[#00B800]/10 blur-[110px]"
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex flex-col items-center text-center max-w-sm"
      >
        <div className="relative p-3.5 rounded-3xl bg-white border border-[#D9E0E0] shadow-[0_14px_34px_-12px_rgba(0,184,0,0.22)]">
          <ArovaLogo size={64} animated />
        </div>

        <div className="mt-5 font-arova-script text-4xl font-bold tracking-wide text-[#202525]">
          AROVA
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#008F00] mt-1">
          Wearable Early Warning System
        </p>

        {/* Animated sweeping heartbeat line */}
        <div className="w-60 h-10 mt-5 overflow-hidden">
          <svg
            viewBox="0 0 240 40"
            fill="none"
            className="w-full h-full"
            aria-hidden="true"
          >
            <path
              d="M0 22H65L76 14L86 30L98 6L109 35L120 10L131 28L140 22H240"
              stroke="url(#arovaLoaderGrad)"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="arova-ecg-sweep"
            />
            <defs>
              <linearGradient id="arovaLoaderGrad" x1="0" y1="20" x2="240" y2="20" gradientUnits="userSpaceOnUse">
                <stop stopColor="#008F00" stopOpacity="0.18" />
                <stop offset="0.5" stopColor="#00B800" />
                <stop offset="1" stopColor="#008F00" stopOpacity="0.25" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <p className="text-xs text-[#737B7B] mt-2">{message}</p>
      </motion.div>
    </div>
  );
}

export function ArovaSkeletonGrid({
  count = 4,
  columnsClass = "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
}: {
  count?: number;
  columnsClass?: string;
}) {
  return (
    <div className={`grid ${columnsClass} gap-4`} aria-busy="true" aria-label="Loading content">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-2xl border border-[#D9E0E0] bg-white p-5 space-y-4 shadow-xs"
        >
          <div className="flex items-center justify-between">
            <div className="h-3.5 w-28 rounded-full arova-shimmer" />
            <div className="h-9 w-9 rounded-xl arova-shimmer" />
          </div>
          <div className="h-8 w-24 rounded-lg arova-shimmer" />
          <div className="h-3 w-full rounded-full arova-shimmer" />
        </div>
      ))}
    </div>
  );
}

export function ArovaEmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-dashed border-[#D9E0E0] bg-white p-8 text-center flex flex-col items-center justify-center gap-3 shadow-xs"
    >
      <div className="w-12 h-12 rounded-2xl bg-[#00B800]/10 border border-[#00B800]/30 flex items-center justify-center text-[#008F00] arova-float-card-subtle">
        {icon ?? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 12H7L9.5 6L13 18L15.5 9.5L17.5 12H21"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <div className="max-w-md space-y-1">
        <h3 className="text-sm font-semibold text-[#202525]">{title}</h3>
        <p className="text-xs text-[#737B7B] leading-relaxed">{description}</p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </motion.div>
  );
}

export function ArovaErrorBanner({
  title = "Unable to complete operation",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-red-300 bg-red-50 p-4 flex flex-wrap items-start justify-between gap-3 text-red-900"
      role="alert"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="text-xs space-y-0.5 min-w-0">
          <div className="font-semibold text-red-900">{title}</div>
          <div className="text-red-800 break-words">{message}</div>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-red-100 border border-red-300 text-xs font-medium text-red-800 transition-colors cursor-pointer shrink-0"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          Retry
        </button>
      )}
    </motion.div>
  );
}
