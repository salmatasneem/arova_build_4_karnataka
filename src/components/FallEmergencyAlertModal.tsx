import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Flag,
  MapPin,
  Minimize2,
  PhoneCall,
  ShieldCheck,
  Siren,
  X,
} from "lucide-react";
import { ArovaLogo } from "./ArovaLogo.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";

const BLOCKED_EMERGENCY_NUMBERS = new Set([
  "911",
  "112",
  "999",
  "100",
  "101",
  "102",
  "108",
  "000",
  "110",
  "119",
]);

function sanitizeAuthorizedTelHref(rawPhone?: string | null): string | null {
  if (!rawPhone) return null;
  const cleaned = rawPhone.trim().replace(/[^+\d]/g, "");
  if (cleaned.length < 7) return null;
  const digitsOnly = cleaned.replace(/\D/g, "");
  if (BLOCKED_EMERGENCY_NUMBERS.has(digitsOnly)) return null;
  return `tel:${cleaned}`;
}

export function FallEmergencyAlertModal() {
  const {
    activeEmergencyFallEvent,
    alerts,
    selectedPatient,
    privateContact,
    activeRole,
    isAdminUser,
    cancelFallAlertSafe,
    requestFallHelp,
    dismissEmergencyOverlay,
    acknowledgeAlert,
    reportFalseAlert,
    refreshPhase5Notifications,
  } = useSmartCare();

  const [minimized, setMinimized] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(20);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showFalseReason, setShowFalseReason] = useState(false);
  const [falseReason, setFalseReason] = useState("");
  const [locationPreviewOpen, setLocationPreviewOpen] = useState(false);
  const [zeroRefreshTriggered, setZeroRefreshTriggered] = useState(false);

  const eventId = activeEmergencyFallEvent?.eventId ?? null;

  useEffect(() => {
    setMinimized(false);
    setActionError(null);
    setShowFalseReason(false);
    setFalseReason("");
    setLocationPreviewOpen(false);
    setZeroRefreshTriggered(false);
  }, [eventId]);

  useEffect(() => {
    if (!activeEmergencyFallEvent) {
      setSecondsRemaining(0);
      return;
    }
    const updateRemaining = () => {
      const deadlineMs = new Date(activeEmergencyFallEvent.confirmationDeadlineAt).getTime();
      const diffSec = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setSecondsRemaining(diffSec);
      if (
        diffSec === 0 &&
        activeEmergencyFallEvent.status === "pending_confirmation" &&
        !zeroRefreshTriggered
      ) {
        setZeroRefreshTriggered(true);
        setTimeout(() => void refreshPhase5Notifications(), 350);
      }
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 400);
    return () => clearInterval(timer);
  }, [activeEmergencyFallEvent, zeroRefreshTriggered, refreshPhase5Notifications]);

  if (!activeEmergencyFallEvent) return null;

  const linkedAlert = alerts.find((a) => a.alertId === activeEmergencyFallEvent.alertId);
  const caregiverAttempts =
    activeEmergencyFallEvent.notificationAttempts &&
    activeEmergencyFallEvent.notificationAttempts.length > 0
      ? activeEmergencyFallEvent.notificationAttempts
      : (linkedAlert?.notificationAttempts ?? []).filter((a) => a.recipientRole === "caregiver");

  const isHelpRequested =
    activeEmergencyFallEvent.escalationTrigger === "user_help_requested" ||
    activeEmergencyFallEvent.patientAckStatus === "assistance_requested";
  const isEscalated =
    activeEmergencyFallEvent.status === "escalated" ||
    secondsRemaining === 0 ||
    Boolean(linkedAlert?.escalatedToCaregiversAt);

  const statusLabel = isHelpRequested
    ? "Assistance Requested"
    : isEscalated
    ? "UNACKNOWLEDGED"
    : "Awaiting confirmation";

  const hasValidLocation = Boolean(
    activeEmergencyFallEvent.location &&
      typeof activeEmergencyFallEvent.location.latitude === "number" &&
      typeof activeEmergencyFallEvent.location.longitude === "number" &&
      Number.isFinite(activeEmergencyFallEvent.location.latitude) &&
      Number.isFinite(activeEmergencyFallEvent.location.longitude)
  );
  const mapsUrl =
    hasValidLocation && activeEmergencyFallEvent.location
      ? `https://www.google.com/maps?q=${encodeURIComponent(
          `${activeEmergencyFallEvent.location.latitude},${activeEmergencyFallEvent.location.longitude}`
        )}`
      : null;

  const authorizedTelHref = sanitizeAuthorizedTelHref(privateContact?.phone);
  const displayPatientName =
    activeEmergencyFallEvent.patientName || selectedPatient.displayName || "Monitored Patient";
  const canCaregiverAct =
    activeRole === "caregiver" || activeRole === "admin" || isAdminUser;

  const handleSafeCancel = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await cancelFallAlertSafe(
        activeEmergencyFallEvent.eventId,
        "User pressed 'I'M SAFE' on emergency overlay."
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel fall alert.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleSendHelp = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await requestFallHelp(
        activeEmergencyFallEvent.eventId,
        "User pressed 'SEND HELP / NOT SAFE' on emergency overlay."
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not initiate caregiver notification."
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleCaregiverAck = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await acknowledgeAlert(
        activeEmergencyFallEvent.alertId,
        "Caregiver acknowledged camera fall alert.",
        isAdminUser ? "admin" : "caregiver"
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to acknowledge alert.");
    } finally {
      setActionBusy(false);
    }
  };

  const handleFalseAlert = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await reportFalseAlert(
        activeEmergencyFallEvent.alertId,
        falseReason.trim() || "Marked as false camera fall alert.",
        canCaregiverAct ? (isAdminUser ? "admin" : "caregiver") : "patient"
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to flag false alert.");
    } finally {
      setActionBusy(false);
    }
  };

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-md w-[calc(100%-2rem)] bg-[#0B1220] text-white border-2 border-red-500 arova-emergency-pulse rounded-2xl p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-red-300 uppercase tracking-wide truncate">
              ⚠ POSSIBLE FALL DETECTED
            </div>
            <div className="text-xs text-slate-200 truncate">
              {displayPatientName} ·{" "}
              {isEscalated
                ? "Caregiver notification initiated"
                : `${secondsRemaining}s remaining`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void handleSafeCancel()}
            className="px-3 py-1.5 text-xs font-bold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg cursor-pointer"
          >
            I&apos;M SAFE
          </button>
          <button
            type="button"
            onClick={() => setMinimized(false)}
            className="px-2.5 py-1.5 text-xs font-medium text-white bg-slate-800 border border-slate-600 rounded-lg hover:border-white cursor-pointer"
          >
            Expand
          </button>
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fall-emergency-alert-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#070D1A]/85 backdrop-blur-sm overflow-y-auto"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-xl bg-[#0B1220] border-2 border-red-500 arova-emergency-pulse rounded-3xl overflow-hidden text-white"
        >
          {/* Dark Navy AROVA Header */}
          <div className="bg-[#080E1B] px-5 py-4 flex items-center justify-between gap-3 border-b border-red-500/40">
            <div className="flex items-center gap-3">
              <ArovaLogo size={38} animated={false} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-arova-script text-xl font-bold tracking-wide text-white leading-none">
                    AROVA
                  </span>
                  {activeEmergencyFallEvent.detectionMode === "demo_simulation" ? (
                    <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-400/50">
                      SIMULATED DEMO
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-red-500/20 text-red-200 border border-red-400/40">
                      LIVE WEBCAM DETECTION
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-300">
                  Emergency Safety Confirmation &amp; Caregiver Escalation
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMinimized(true)}
                title="Minimize emergency overlay"
                className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
                aria-label="Minimize alert dialog"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
              {isEscalated && (
                <button
                  type="button"
                  onClick={() => dismissEmergencyOverlay(activeEmergencyFallEvent.eventId)}
                  title="Close overlay while keeping alert active in Caregiver Dashboard"
                  className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
                  aria-label="Dismiss emergency overlay"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div className="p-5 sm:p-6 space-y-5">
            {/* Red Emergency Alert Panel */}
            <div className="rounded-2xl bg-gradient-to-b from-[#991B1B] to-[#7F1D1D] border border-red-400/70 p-4 sm:p-5 space-y-4 shadow-inner">
              <div className="flex items-start gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-red-600 border border-red-300/60 text-white flex items-center justify-center shrink-0 shadow-md">
                  <AlertTriangle className="w-7 h-7" />
                </div>
                <div className="space-y-1 min-w-0">
                  <h2
                    id="fall-emergency-alert-title"
                    className="text-xl font-extrabold tracking-tight text-white leading-tight"
                  >
                    ⚠ POSSIBLE FALL DETECTED
                  </h2>
                  <p className="text-sm font-semibold text-red-100">
                    AROVA has detected a possible fall. Are you safe?
                  </p>
                  <p className="text-xs text-red-100/90 leading-relaxed">
                    A possible fall has been detected. Please confirm that you are safe.{" "}
                    <span className="text-red-200/90">({activeEmergencyFallEvent.reason})</span>
                  </p>
                </div>
              </div>

              {/* Countdown / Escalation Status Block */}
              {!isEscalated ? (
                <div className="rounded-xl bg-[#0B1220]/70 border border-red-400/50 px-4 py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold uppercase tracking-wider text-red-200 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      Automatic Caregiver Alert Countdown
                    </div>
                    <div className="text-xs text-slate-200">
                      Linked caregivers will be notified automatically if unanswered
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-3xl font-black font-mono tabular-nums text-white leading-none">
                      {secondsRemaining}
                    </div>
                    <div className="text-[10px] font-bold tracking-widest text-red-200 uppercase mt-1">
                      SECONDS REMAINING
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-[#0B1220]/80 border border-red-400/60 px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-bold text-white">
                      <Siren className="w-4 h-4 text-red-300" />
                      <span>Caregiver notification initiated</span>
                    </div>
                    <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-red-600 text-white">
                      {statusLabel}
                    </span>
                  </div>
                  {caregiverAttempts.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {caregiverAttempts.map((att) => (
                        <span
                          key={att.attemptId}
                          className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                            att.deliveryStatus === "delivered"
                              ? "bg-[#00B800]/20 border-[#00B800]/50 text-emerald-200"
                              : att.deliveryStatus === "simulated"
                              ? "bg-amber-500/20 border-amber-400/50 text-amber-200"
                              : "bg-red-900/80 border-red-400 text-red-200"
                          }`}
                        >
                          {att.channel} → {att.recipientName} [{att.deliveryStatus}]
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-200">
                      No active linked caregivers were registered on this patient profile at escalation time. Link a caregiver in Care Network to enable automated delivery.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Metadata Grid: Patient, Timestamp, Confidence, Status */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div className="p-3 rounded-xl bg-[#111B2E] border border-slate-700/80 space-y-0.5">
                <div className="text-[11px] text-slate-400">Patient Name</div>
                <div className="font-semibold text-white truncate">{displayPatientName}</div>
              </div>
              <div className="p-3 rounded-xl bg-[#111B2E] border border-slate-700/80 space-y-0.5">
                <div className="text-[11px] text-slate-400">Detection Time</div>
                <div className="font-semibold font-mono text-white">
                  {new Date(activeEmergencyFallEvent.detectedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#111B2E] border border-slate-700/80 space-y-0.5">
                <div className="text-[11px] text-slate-400">Confidence</div>
                <div className="font-semibold font-mono text-white">
                  {Math.round(activeEmergencyFallEvent.confidence * 100)}%
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[#111B2E] border border-slate-700/80 space-y-0.5">
                <div className="text-[11px] text-slate-400">Status</div>
                <div
                  className={`font-semibold ${
                    isEscalated ? "text-red-300" : "text-amber-300"
                  }`}
                >
                  {statusLabel}
                </div>
              </div>
            </div>

            {/* Location & Sensor Fusion Metadata */}
            <div className="p-3.5 rounded-2xl bg-[#111B2E] border border-slate-700/80 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <MapPin className="w-4 h-4 text-[#00B800]" />
                  <span>Location Status</span>
                </div>
                <span className="font-mono text-[11px] text-slate-300">
                  {hasValidLocation && activeEmergencyFallEvent.location
                    ? `${activeEmergencyFallEvent.location.latitude.toFixed(
                        5
                      )}, ${activeEmergencyFallEvent.location.longitude.toFixed(5)}`
                    : "Location unavailable"}
                </span>
              </div>
              {activeEmergencyFallEvent.wearableSummary && (
                <div className="text-[11px] text-slate-300 pt-1 border-t border-slate-700/70">
                  <span className="font-medium text-white">Sensor Fusion:</span>{" "}
                  {activeEmergencyFallEvent.wearableSummary}
                </div>
              )}
              {locationPreviewOpen && hasValidLocation && activeEmergencyFallEvent.location && (
                <div className="p-2.5 rounded-lg bg-[#080E1B] border border-slate-700 font-mono text-[11px] text-slate-200">
                  Latitude: {activeEmergencyFallEvent.location.latitude.toFixed(6)} · Longitude:{" "}
                  {activeEmergencyFallEvent.location.longitude.toFixed(6)}
                  {typeof activeEmergencyFallEvent.location.accuracyMeters === "number"
                    ? ` (±${Math.round(activeEmergencyFallEvent.location.accuracyMeters)}m)`
                    : ""}
                </div>
              )}
            </div>

            {actionError && (
              <div className="text-xs text-red-100 bg-red-900/60 border border-red-400 rounded-xl px-3 py-2">
                {actionError}
              </div>
            )}

            {/* Two Large Emergency Action Buttons: I'M SAFE & SEND HELP / NOT SAFE */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => void handleSafeCancel()}
                className="w-full py-4 px-4 text-sm font-extrabold tracking-wide text-white bg-[#00B800] hover:bg-[#009900] rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <ShieldCheck className="w-5 h-5" />
                <span>I&apos;M SAFE</span>
              </button>

              <button
                type="button"
                disabled={actionBusy || isEscalated}
                onClick={() => void handleSendHelp()}
                className="w-full py-4 px-4 text-sm font-extrabold tracking-wide text-white bg-red-600 hover:bg-red-700 border border-red-400/70 rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
              >
                <Siren className="w-5 h-5" />
                <span>{isEscalated ? "HELP INITIATED" : "SEND HELP / NOT SAFE"}</span>
              </button>
            </div>

            {/* Secondary Location & Phone Call Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {mapsUrl ? (
                <div className="flex gap-1.5">
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2.5 px-3 text-xs font-semibold text-white bg-[#111B2E] border border-slate-700 hover:border-[#00B800] rounded-xl flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <MapPin className="w-3.5 h-3.5 text-[#00B800]" />
                    <span>VIEW LOCATION</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <button
                    type="button"
                    onClick={() => setLocationPreviewOpen((v) => !v)}
                    className="px-2.5 py-2.5 text-[11px] font-medium text-slate-300 bg-[#111B2E] border border-slate-700 rounded-xl hover:text-white cursor-pointer"
                  >
                    Coords
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled
                  title="Browser location permission was not granted or coordinates are unavailable"
                  className="py-2.5 px-3 text-xs font-semibold text-slate-400 bg-[#111B2E] border border-slate-800 rounded-xl flex items-center justify-center gap-1.5 opacity-75 cursor-not-allowed"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>VIEW LOCATION (Unavailable)</span>
                </button>
              )}

              {authorizedTelHref ? (
                <a
                  href={authorizedTelHref}
                  className="py-2.5 px-3 text-xs font-semibold text-white bg-[#111B2E] border border-red-500/60 hover:bg-red-700/40 rounded-xl flex items-center justify-center gap-1.5 transition-colors"
                >
                  <PhoneCall className="w-3.5 h-3.5 text-red-300" />
                  <span>CALL USER</span>
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  title="Register an authorized personal phone number in Profile & Settings to enable direct tel: calls (emergency numbers blocked)"
                  className="py-2.5 px-3 text-xs font-semibold text-slate-400 bg-[#111B2E] border border-slate-800 rounded-xl flex items-center justify-center gap-1.5 opacity-75 cursor-not-allowed"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  <span>CALL USER (No Phone)</span>
                </button>
              )}
            </div>

            {/* Caregiver Ack, False Alert & Resume Monitoring Footer */}
            <div className="pt-3 border-t border-slate-800 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {canCaregiverAct && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void handleCaregiverAck()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-200 bg-[#00B800]/20 border border-[#00B800]/40 rounded-lg hover:bg-[#00B800]/30 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Acknowledge Alert</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setShowFalseReason((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-200 bg-amber-500/15 border border-amber-400/40 rounded-lg hover:bg-amber-500/25 cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>Report False Alert</span>
                  </button>
                </div>

                {isEscalated && (
                  <button
                    type="button"
                    onClick={() => dismissEmergencyOverlay(activeEmergencyFallEvent.eventId)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-600 rounded-lg hover:border-white cursor-pointer"
                  >
                    Resume Monitoring View
                  </button>
                )}
              </div>

              {showFalseReason && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={falseReason}
                    onChange={(e) => setFalseReason(e.target.value)}
                    placeholder="Reason (e.g., sitting quickly, camera obstructed)..."
                    className="flex-1 px-3 py-1.5 text-xs bg-[#111B2E] border border-slate-700 rounded-lg text-white placeholder:text-slate-400 focus:outline-none focus:border-[#00B800]"
                  />
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleFalseAlert()}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg cursor-pointer"
                  >
                    Submit
                  </button>
                </div>
              )}

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Prototype computer vision fall monitoring — not a clinical diagnosis. Caregiver
                notifications use configured delivery channels or clearly labeled simulation mode
                and never contact emergency services automatically.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
