import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  OutboundCallApiError,
  fetchOutboundVoiceCallStatus,
  initiateOutboundVoiceCall,
  terminateOutboundVoiceCall,
} from "../services/apiClient.ts";
import { BrowserVoiceTestPanel } from "./BrowserVoiceTestPanel.tsx";

export type AiOutboundCallStatus =
  | "ready"
  | "initiating"
  | "calling"
  | "connected"
  | "ended"
  | "failed";

interface AiOutboundCallModalProps {
  open: boolean;
  onClose: () => void;
  twilioConfigured?: boolean;
  missingEnvVars?: string[];
  telemetrySummary?: string;
}

interface CountryCodeOption {
  iso: string;
  label: string;
  dialCode: string;
  placeholder: string;
}

const COUNTRY_CODES: CountryCodeOption[] = [
  { iso: "US", label: "United States / Canada", dialCode: "+1", placeholder: "415 555 0199" },
  { iso: "IN", label: "India", dialCode: "+91", placeholder: "98765 43210" },
  { iso: "GB", label: "United Kingdom", dialCode: "+44", placeholder: "7700 900123" },
  { iso: "AU", label: "Australia", dialCode: "+61", placeholder: "412 345 678" },
  { iso: "SG", label: "Singapore", dialCode: "+65", placeholder: "8123 4567" },
  { iso: "AE", label: "United Arab Emirates", dialCode: "+971", placeholder: "50 123 4567" },
  { iso: "DE", label: "Germany", dialCode: "+49", placeholder: "151 23456789" },
  { iso: "FR", label: "France", dialCode: "+33", placeholder: "6 12 34 56 78" },
  { iso: "JP", label: "Japan", dialCode: "+81", placeholder: "90 1234 5678" },
  { iso: "BR", label: "Brazil", dialCode: "+55", placeholder: "11 91234 5678" },
];

const CALL_STATUS_META: Array<{
  key: AiOutboundCallStatus;
  label: string;
}> = [
  { key: "ready", label: "Ready to call" },
  { key: "initiating", label: "Initiating call" },
  { key: "calling", label: "Calling" },
  { key: "connected", label: "Connected" },
  { key: "ended", label: "Call ended" },
  { key: "failed", label: "Call failed" },
];

const VOICE_BAR_HEIGHTS = [14, 24, 34, 20, 38, 28, 18, 32, 22, 14];

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function AiOutboundCallModal({
  open,
  onClose,
  twilioConfigured = false,
  missingEnvVars = [],
  telemetrySummary = "",
}: AiOutboundCallModalProps) {
  const [countryCode, setCountryCode] = useState<string>("+1");
  const [phoneInput, setPhoneInput] = useState<string>("");
  const [status, setStatus] = useState<AiOutboundCallStatus>("ready");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [missingConfigVars, setMissingConfigVars] = useState<string[]>(missingEnvVars);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number>(0);
  const [modalMode, setModalMode] = useState<"browser" | "phone">(
    twilioConfigured ? "phone" : "browser"
  );

  const isCallInFlight =
    status === "initiating" || status === "calling" || status === "connected";

  useEffect(() => {
    setMissingConfigVars(missingEnvVars);
  }, [missingEnvVars]);

  useEffect(() => {
    if (open && !twilioConfigured && !isCallInFlight) {
      setModalMode("browser");
    }
  }, [open, twilioConfigured, isCallInFlight]);

  const selectedCountry = useMemo(
    () => COUNTRY_CODES.find((c) => c.dialCode === countryCode) ?? COUNTRY_CODES[0],
    [countryCode]
  );

  const cleanNationalDigits = useMemo(
    () => phoneInput.replace(/\D/g, "").replace(/^0+/, ""),
    [phoneInput]
  );
  const e164Preview = useMemo(
    () => `${countryCode}${cleanNationalDigits}`,
    [countryCode, cleanNationalDigits]
  );

  useEffect(() => {
    if (status !== "connected") return;
    const timer = setInterval(() => {
      setDurationSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (!open || !activeCallId || !isCallInFlight) return;
    let active = true;

    const syncStatus = async () => {
      try {
        const latest = await fetchOutboundVoiceCallStatus(activeCallId);
        if (!active) return;
        setStatus(latest.status);
        if (typeof latest.durationSec === "number" && latest.durationSec > 0) {
          setDurationSeconds((prev) => Math.max(prev, latest.durationSec));
        }
        if (latest.errorMessage) {
          setStatusMessage(latest.errorMessage);
        } else if (latest.status === "ended") {
          setStatusMessage("Call completed.");
        }
      } catch {
        // Keep current state across transient network blips
      }
    };

    const interval = setInterval(() => void syncStatus(), 1500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [open, activeCallId, isCallInFlight]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const validatePhone = (): boolean => {
    const totalDigits = e164Preview.replace(/\D/g, "").length;
    if (!cleanNationalDigits) {
      setValidationError("Enter a mobile number to place an AI outbound call.");
      return false;
    }
    if (
      !/^\+[1-9]\d{7,14}$/.test(e164Preview) ||
      cleanNationalDigits.length < 6 ||
      totalDigits < 8 ||
      totalDigits > 15
    ) {
      setValidationError("Enter a valid mobile number (8–15 digits including country code).");
      return false;
    }
    setValidationError(null);
    return true;
  };

  const handleStartCall = async () => {
    if (isCallInFlight) return;
    if (!validatePhone()) return;
    if (!twilioConfigured) {
      const missingText =
        missingConfigVars.length > 0 ? ` (${missingConfigVars.join(", ")})` : "";
      setValidationError(
        `Twilio phone calling secrets are not configured in Settings > Secrets yet${missingText}. Use Browser Voice Test to speak with Arova AI right now.`
      );
      return;
    }

    setStatus("initiating");
    setDurationSeconds(0);
    setStatusMessage(null);
    setActiveCallId(null);

    try {
      const result = await initiateOutboundVoiceCall(e164Preview);
      setActiveCallId(result.callId);
      setStatus(result.status);
      setStatusMessage(
        result.status === "calling"
          ? `Ringing ${result.maskedPhone ?? e164Preview} via Twilio Programmable Voice...`
          : `Twilio call queued for ${result.maskedPhone ?? e164Preview}.`
      );
    } catch (err) {
      setStatus("failed");
      if (err instanceof OutboundCallApiError) {
        if (err.missingEnvVars && err.missingEnvVars.length > 0) {
          setMissingConfigVars(err.missingEnvVars);
        }
        setStatusMessage(err.message);
      } else {
        setStatusMessage(
          err instanceof Error
            ? err.message
            : "Unable to initiate outbound call with the voice backend."
        );
      }
    }
  };

  const handleEndCall = async () => {
    if (!isCallInFlight || !activeCallId) return;
    try {
      const terminated = await terminateOutboundVoiceCall(activeCallId);
      setStatus(terminated.status);
      if (typeof terminated.durationSec === "number") {
        setDurationSeconds(terminated.durationSec);
      }
      setStatusMessage("Call terminated via Twilio.");
    } catch (err) {
      setStatus("failed");
      setStatusMessage(
        err instanceof Error ? err.message : "Failed to terminate call cleanly."
      );
    }
  };

  const handleReset = () => {
    if (isCallInFlight) return;
    setStatus("ready");
    setDurationSeconds(0);
    setStatusMessage(null);
    setValidationError(null);
    setActiveCallId(null);
  };

  const currentStatusLabel =
    CALL_STATUS_META.find((s) => s.key === status)?.label ?? "Ready to call";

  const statusBadgeClass =
    status === "connected"
      ? "bg-[#00B800] text-white border-[#008F00]"
      : status === "initiating" || status === "calling"
      ? "bg-[#00B800]/12 text-[#008F00] border-[#00B800]/35"
      : status === "failed"
      ? "bg-red-50 text-red-800 border-red-300"
      : status === "ended"
      ? "bg-[#EEF2F2] text-[#737B7B] border-[#D9E0E0]"
      : "bg-white text-[#202525] border-[#D9E0E0]";

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="arova-ai-call-title"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-[#080B0B]/60 backdrop-blur-xs"
          />

          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 w-full max-w-xl rounded-3xl bg-white border border-[#D9E0E0] shadow-2xl overflow-hidden"
          >
            {/* Dark Black Modal Header */}
            <div className="bg-[#080B0B] px-6 py-5 text-white flex items-start justify-between gap-4 border-b border-[#1E2525]">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#00B800]">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#00B800]" aria-hidden="true" />
                  <span>AROVA Voice Bridge</span>
                </div>
                <h2
                  id="arova-ai-call-title"
                  className="text-xl font-bold tracking-tight text-white"
                >
                  AI Outbound Telephone Call
                </h2>
                <p className="text-xs text-[#A3ACAC]">
                  Real-time two-way voice conversation powered by Gemini Live &amp; Twilio Media Streams
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                aria-label="Close calling interface"
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4 max-h-[82vh] overflow-y-auto bg-white">
              {!twilioConfigured && (
                <div className="flex items-start justify-between gap-3 rounded-xl bg-amber-50 border border-amber-300 px-3.5 py-2.5 text-xs text-amber-900">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="space-y-0.5">
                      <div className="font-semibold text-amber-900">
                        Twilio phone dialing is not configured yet. Browser Voice Test works live right now without Twilio.
                      </div>
                      {missingConfigVars.length > 0 && (
                        <div className="text-[11px] font-mono text-amber-800">
                          Twilio secrets needed for PSTN calls: {missingConfigVars.join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Mode Switcher */}
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#EEF2F2] border border-[#D9E0E0]">
                <button
                  type="button"
                  onClick={() => setModalMode("browser")}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    modalMode === "browser"
                      ? "bg-[#00B800] text-white shadow-xs"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  Browser Voice Test (Gemini Live)
                </button>
                <button
                  type="button"
                  onClick={() => setModalMode("phone")}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    modalMode === "phone"
                      ? "bg-[#00B800] text-white shadow-xs"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  Phone Call (Twilio)
                </button>
              </div>

              {modalMode === "browser" ? (
                <BrowserVoiceTestPanel
                  mode="assistant"
                  telemetrySummary={telemetrySummary}
                  compact
                />
              ) : (
                <>
                  {/* Live Voice Activity Panel */}
                  <div className="rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border ${statusBadgeClass}`}
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${
                              status === "connected"
                                ? "bg-white animate-pulse"
                                : status === "initiating" || status === "calling"
                                ? "bg-[#00B800] animate-ping"
                                : status === "failed"
                                ? "bg-red-600"
                                : "bg-[#00B800]"
                            }`}
                            aria-hidden="true"
                          />
                          <span>{currentStatusLabel}</span>
                        </span>
                      </div>

                      <div
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white border border-[#D9E0E0] text-xs font-mono font-semibold text-[#202525] tabular-nums"
                        aria-label="Call duration"
                      >
                        <Clock className="w-3.5 h-3.5 text-[#00B800]" aria-hidden="true" />
                        <span>{formatDuration(durationSeconds)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 py-2">
                      <div className="relative flex items-center justify-center shrink-0">
                        {(status === "initiating" ||
                          status === "calling" ||
                          status === "connected") && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-2xl bg-[#00B800]/25 animate-ping"
                          />
                        )}
                        <div
                          className={`relative w-12 h-12 rounded-2xl flex items-center justify-center border transition-colors ${
                            status === "connected"
                              ? "bg-[#00B800] border-[#008F00] text-white shadow-sm"
                              : status === "failed"
                              ? "bg-red-50 border-red-300 text-red-600"
                              : "bg-white border-[#D9E0E0] text-[#008F00]"
                          }`}
                        >
                          {status === "failed" ? (
                            <MicOff className="w-5 h-5" aria-hidden="true" />
                          ) : (
                            <Mic className="w-5 h-5" aria-hidden="true" />
                          )}
                        </div>
                      </div>

                      <div className="flex-1 space-y-1.5 min-w-0">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-[#202525]">
                            {status === "connected"
                              ? "Gemini Live Two-Way Voice Active"
                              : status === "calling"
                              ? "Ringing Mobile Handset..."
                              : status === "initiating"
                              ? "Connecting to Twilio API..."
                              : status === "failed"
                              ? "Voice Call Not Completed"
                              : status === "ended"
                              ? "Voice Session Closed"
                              : "Microphone & AI Voice Standby"}
                          </span>
                          <span className="text-[11px] font-mono text-[#737B7B]">
                            {twilioConfigured ? "Twilio Ready" : "Credentials Needed"}
                          </span>
                        </div>

                        <div
                          className="h-10 rounded-xl bg-white border border-[#D9E0E0] px-3 flex items-center justify-between gap-1.5"
                          aria-hidden="true"
                        >
                          {VOICE_BAR_HEIGHTS.map((heightPx, idx) => {
                            const isLiveWave = status === "connected";
                            const isSoftPulse =
                              status === "initiating" || status === "calling";
                            return (
                              <span
                                key={idx}
                                className={`flex-1 rounded-full transition-colors ${
                                  status === "failed"
                                    ? "bg-red-400"
                                    : isLiveWave
                                    ? "arova-voice-bar bg-[#00B800]"
                                    : isSoftPulse
                                    ? "arova-voice-bar bg-[#00B800]/70"
                                    : "bg-[#D9E0E0]"
                                }`}
                                style={{
                                  height: isLiveWave
                                    ? `${heightPx}px`
                                    : isSoftPulse
                                    ? `${Math.max(8, Math.round(heightPx * 0.55))}px`
                                    : "6px",
                                  animationDelay: `${idx * 95}ms`,
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* All 6 Calling Status Indicators */}
                    <div
                      className="pt-2 border-t border-[#D9E0E0] grid grid-cols-2 sm:grid-cols-3 gap-2"
                      aria-label="Calling status indicators"
                    >
                      {CALL_STATUS_META.map((item) => {
                        const isActive = status === item.key;
                        const activeClasses =
                          item.key === "failed"
                            ? "bg-red-50 border-red-300 text-red-800 font-semibold"
                            : item.key === "connected"
                            ? "bg-[#00B800] border-[#008F00] text-white font-semibold"
                            : "bg-[#00B800]/12 border-[#00B800]/35 text-[#008F00] font-semibold";
                        return (
                          <div
                            key={item.key}
                            className={`px-2.5 py-1.5 rounded-lg border text-[11px] flex items-center gap-1.5 transition-colors ${
                              isActive
                                ? activeClasses
                                : "bg-white border-[#D9E0E0] text-[#737B7B]"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                isActive
                                  ? item.key === "failed"
                                    ? "bg-red-600"
                                    : item.key === "connected"
                                    ? "bg-white"
                                    : "bg-[#00B800]"
                                  : "bg-[#D9E0E0]"
                              }`}
                              aria-hidden="true"
                            />
                            <span className="truncate">{item.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mobile Phone Number Input */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleStartCall();
                    }}
                    className="space-y-3"
                  >
                    <div className="space-y-2">
                      <label
                        htmlFor="arova-outbound-phone"
                        className="block text-xs font-semibold text-[#202525]"
                      >
                        Registered Mobile Number
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2.5">
                        <select
                          aria-label="Country code"
                          value={countryCode}
                          disabled={isCallInFlight}
                          onChange={(e) => {
                            setCountryCode(e.target.value);
                            if (validationError) setValidationError(null);
                          }}
                          className="sm:w-48 px-3 py-2.5 text-sm font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-xl focus:outline-none focus:border-[#00B800] disabled:opacity-60"
                        >
                          {COUNTRY_CODES.map((c) => (
                            <option key={c.iso} value={c.dialCode}>
                              {c.iso} ({c.dialCode}) · {c.label}
                            </option>
                          ))}
                        </select>

                        <input
                          id="arova-outbound-phone"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel-national"
                          disabled={isCallInFlight}
                          value={phoneInput}
                          onChange={(e) => {
                            setPhoneInput(e.target.value);
                            if (validationError) setValidationError(null);
                            if (status === "failed" || status === "ended") {
                              setStatus("ready");
                              setStatusMessage(null);
                            }
                          }}
                          placeholder={selectedCountry.placeholder}
                          className="flex-1 px-3.5 py-2.5 text-sm font-mono text-[#202525] bg-white border border-[#D9E0E0] rounded-xl focus:outline-none focus:border-[#00B800] placeholder:text-[#737B7B] disabled:opacity-60"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#737B7B]">
                      <span>
                        Formatted E.164 target:{" "}
                        <span className="font-mono font-semibold text-[#008F00]">
                          {cleanNationalDigits ? e164Preview : `${countryCode}...`}
                        </span>
                      </span>
                      {!twilioConfigured && missingConfigVars.length > 0 && (
                        <span className="font-mono text-amber-700">
                          Missing: {missingConfigVars.join(", ")}
                        </span>
                      )}
                    </div>

                    {validationError && (
                      <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-900">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" aria-hidden="true" />
                        <span>{validationError}</span>
                      </div>
                    )}

                    {statusMessage && (
                      <div
                        className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs border ${
                          status === "failed"
                            ? "bg-red-50 border-red-300 text-red-900"
                            : "bg-[#00B800]/10 border-[#00B800]/30 text-[#008F00]"
                        }`}
                      >
                        {status === "failed" ? (
                          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#00B800]" aria-hidden="true" />
                        )}
                        <span>{statusMessage}</span>
                      </div>
                    )}

                    <div className="pt-2 border-t border-[#D9E0E0] flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <button
                          type="submit"
                          disabled={isCallInFlight}
                          className="arova-cta-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl shadow-xs disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <PhoneCall className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span>{isCallInFlight ? "Calling..." : "Send Call"}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleEndCall()}
                          disabled={!isCallInFlight || !activeCallId}
                          className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl border transition-colors whitespace-nowrap shrink-0 ${
                            isCallInFlight && activeCallId
                              ? "bg-red-600 hover:bg-red-700 text-white border-red-500 cursor-pointer"
                              : "bg-[#EEF2F2] text-[#737B7B] border-[#D9E0E0] cursor-not-allowed"
                          }`}
                        >
                          <PhoneOff className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span>End Call</span>
                        </button>

                        {!twilioConfigured && (
                          <button
                            type="button"
                            onClick={() => setModalMode("browser")}
                            className="arova-cta-secondary inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Mic className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
                            <span>Use Browser Voice</span>
                          </button>
                        )}
                      </div>

                      {(status === "ended" || status === "failed") && (
                        <button
                          type="button"
                          onClick={handleReset}
                          className="arova-cta-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Reset</span>
                        </button>
                      )}
                    </div>
                  </form>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
