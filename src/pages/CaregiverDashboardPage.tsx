import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Bell,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Flag,
  MapPin,
  PhoneCall,
  PhoneForwarded,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Users,
  Video,
} from "lucide-react";
import { ArovaEmptyState } from "../components/ArovaLoadingAndEmptyStates.tsx";
import { EcgWaveformPanel } from "../components/EcgWaveformPanel.tsx";
import { MlIntelligencePanel } from "../components/MlIntelligencePanel.tsx";
import { AlertLevelLabel } from "../components/StatusIndicator.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import {
  advanceVoiceOutcome,
  fetchVoiceEscalations,
  resolveVoiceEscalation,
  triggerVoiceEscalation,
} from "../services/apiClient.ts";
import type { VoiceEscalationEvent } from "../types/smartcare.ts";

export function CaregiverDashboardPage() {
  const {
    user,
    userProfile,
    assignedRole,
    patients,
    selectedPatientId,
    setSelectedPatientId,
    selectedPatient,
    readings,
    alerts,
    notifications,
    notificationProviders,
    notificationConfig,
    integrations,
    systemSettings,
    acknowledgeAlert,
    reportFalseAlert,
    resolveAlert,
    markNotificationRead,
    updateAlertEscalation,
    liveHardwareSnapshot,
    ecgSegments,
    baselines,
    anomalyEvents,
    isAdminUser,
    fallEvents,
    cancelFallAlertSafe,
    privateContact,
  } = useSmartCare();

  const [followUpNotes, setFollowUpNotes] = useState<Record<string, string>>({});
  const [countdownByAlert, setCountdownByAlert] = useState<Record<string, number>>({});
  const [escalationBusyId, setEscalationBusyId] = useState<string | null>(null);
  const [escalationError, setEscalationError] = useState<string | null>(null);
  const [voiceEscalations, setVoiceEscalations] = useState<VoiceEscalationEvent[]>([]);
  const [resolvingVoiceId, setResolvingVoiceId] = useState<string | null>(null);
  const [copiedUid, setCopiedUid] = useState(false);

  const handleCopyUid = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Non-fatal clipboard failure
    }
  };

  const loadPatientVoiceEscalations = useCallback(async () => {
    if (!user) {
      setVoiceEscalations([]);
      return;
    }
    try {
      const list = await fetchVoiceEscalations(selectedPatientId);
      setVoiceEscalations(list.filter((e) => e.emergencyActive && e.escalationStatus !== "resolved"));
    } catch {
      // Keep non-blocking on Caregiver Dashboard
    }
  }, [user, selectedPatientId]);

  useEffect(() => {
    void loadPatientVoiceEscalations();
    if (!user) return;
    const timer = setInterval(() => {
      void loadPatientVoiceEscalations();
    }, 5000);
    return () => clearInterval(timer);
  }, [user, loadPatientVoiceEscalations]);

  const handleResolveVoiceEsc = async (escalationId: string) => {
    setResolvingVoiceId(escalationId);
    try {
      await resolveVoiceEscalation(escalationId, followUpNotes[escalationId]);
      await loadPatientVoiceEscalations();
    } catch (err) {
      setEscalationError(err instanceof Error ? err.message : "Could not resolve voice escalation.");
    } finally {
      setResolvingVoiceId(null);
    }
  };

  const latest = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;
  const patientAlerts = alerts.filter((a) => a.patientId === selectedPatientId);
  const patientFallEvents = fallEvents.filter((e) => e.patientId === selectedPatientId);
  const activeAlerts = patientAlerts.filter((a) => a.status !== "resolved");
  const resolvedAlerts = patientAlerts.filter((a) => a.status === "resolved");
  const caregiverNotifications = notifications.filter(
    (n) => n.patientId === selectedPatientId && n.recipientRole === "caregiver"
  );
  const unreadCaregiverNotifications = caregiverNotifications.filter((n) => !n.read);

  // Countdown timer for active calling_primary dry-run or live escalation
  useEffect(() => {
    const calling = patientAlerts.filter((a) => a.callEscalationStatus === "calling_primary");
    if (calling.length === 0) return;

    const interval = setInterval(() => {
      setCountdownByAlert((prev) => {
        const next = { ...prev };
        for (const a of calling) {
          const cur = next[a.alertId] ?? systemSettings.escalationTimeoutSec;
          if (cur > 1) {
            next[a.alertId] = cur - 1;
          } else if (cur === 1) {
            next[a.alertId] = 0;
            void advanceVoiceOutcome(a.alertId, "primary_no_answer_escalate")
              .then((updated) => updateAlertEscalation(a.alertId, updated.status, updated.log))
              .catch(() => {});
          }
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [patientAlerts, systemSettings.escalationTimeoutSec, updateAlertEscalation]);

  const handleStartEscalation = async (alertId: string, summary: string, dryRun: boolean) => {
    setEscalationBusyId(alertId);
    setEscalationError(null);
    try {
      const result = await triggerVoiceEscalation({
        alertId,
        patientId: selectedPatient.patientId,
        patientName: selectedPatient.displayName,
        summary,
        primaryCaregiverName: selectedPatient.primaryCaregiverName || "Primary Caregiver",
        secondaryCaregiverName: selectedPatient.secondaryCaregiverName || "Secondary Caregiver",
        timeoutSec: systemSettings.escalationTimeoutSec,
        dryRun,
      });
      if (result.status === "calling_primary") {
        setCountdownByAlert((prev) => ({
          ...prev,
          [alertId]: result.timeoutSec,
        }));
      }
      await updateAlertEscalation(alertId, result.status, result.log);
    } catch (err) {
      setEscalationError(err instanceof Error ? err.message : "Failed to initiate escalation.");
    } finally {
      setEscalationBusyId(null);
    }
  };

  const handleAdvanceOutcome = async (
    alertId: string,
    action: "primary_answered" | "primary_no_answer_escalate" | "secondary_acknowledged"
  ) => {
    setEscalationBusyId(alertId);
    setEscalationError(null);
    try {
      const updated = await advanceVoiceOutcome(alertId, action);
      await updateAlertEscalation(alertId, updated.status, updated.log);
    } catch (err) {
      setEscalationError(err instanceof Error ? err.message : "Failed to update call outcome.");
    } finally {
      setEscalationBusyId(null);
    }
  };

  const latestHrText =
    latest && typeof latest.heartRate === "number" ? `${Math.round(latest.heartRate)} BPM` : "-- BPM";
  const latestSpo2Text =
    latest && typeof latest.spo2 === "number" ? `${latest.spo2.toFixed(1)}%` : "--%";
  const latestTempText =
    latest && typeof latest.temperatureC === "number"
      ? `${latest.temperatureC.toFixed(1)} °C`
      : "Temp pending";
  const fallSuspect = Boolean(
    latest?.possibleFallDetected || latest?.movementStatus === "fall_suspect"
  );

  return (
    <div className="space-y-6">
      {user && (
        <section className="arova-glass-card rounded-2xl px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <Users className="w-4 h-4 text-[#00B800] shrink-0" />
            <div>
              <span className="font-semibold text-[#202525]">
                {userProfile?.displayName || user.displayName || "Authenticated Caregiver"}
              </span>
              <span className="mx-2 text-[#D9E0E0]">·</span>
              <span className="capitalize text-[#737B7B]">{assignedRole ?? "caregiver"} access</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-[#202525] bg-[#EEF2F2] px-2.5 py-1 rounded-lg border border-[#D9E0E0]">
              UID: {user.uid}
            </span>
            <button
              type="button"
              onClick={() => void handleCopyUid()}
              className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] cursor-pointer transition-colors"
            >
              {copiedUid ? <Check className="w-3 h-3 text-[#00B800]" /> : <Copy className="w-3 h-3 text-[#00B800]" />}
              {copiedUid ? "Copied" : "Copy UID"}
            </button>
          </div>
        </section>
      )}

      {patients.length === 0 ? (
        <ArovaEmptyState
          title="No Linked Patients Assigned Yet"
          description="For privacy and strict RBAC enforcement, caregivers only see patients explicitly linked to their Caregiver UID. Share your UID above with a Patient or Administrator to link your account."
          icon={<Users className="w-5 h-5" />}
        />
      ) : (
        <>
          {/* Linked Patients Roster */}
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-[#202525]">Linked Patients Under Care</h2>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Select a patient to inspect current vitals, AD8232 ECG status, alerts, and emergency escalation workflow
              </p>
            </div>

            <div className="arova-float-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {patients.map((pt, idx) => {
                const isSelected = pt.patientId === selectedPatientId;
                const ptActiveCount = alerts.filter(
                  (a) => a.patientId === pt.patientId && a.status === "active"
                ).length;
                const delayClass = `arova-float-delay-${(idx % 6) + 1}`;

                return (
                  <motion.button
                    key={pt.patientId}
                    type="button"
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: idx * 0.05 }}
                    onClick={() => setSelectedPatientId(pt.patientId)}
                    className={`arova-float-card ${delayClass} arova-glass-card text-left rounded-2xl p-4 border transition-all cursor-pointer ${
                      isSelected
                        ? "border-[#00B800] ring-2 ring-[#00B800]/25 bg-white"
                        : "border-[#D9E0E0] hover:border-[#00B800]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#202525]">{pt.displayName}</span>
                      <span
                        className={`text-xs font-semibold font-mono tabular-nums px-2 py-0.5 rounded-md border ${
                          ptActiveCount > 0
                            ? "text-red-800 bg-red-50 border-red-300"
                            : "text-[#008F00] bg-[#00B800]/12 border-[#00B800]/30"
                        }`}
                      >
                        {ptActiveCount} active alert{ptActiveCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="text-xs text-[#737B7B] mt-1.5">
                      {pt.ageGroup || "Monitored patient"} · Baseline {pt.baselineStatus}
                    </div>
                    <div className="text-xs text-[#737B7B] mt-3 pt-3 border-t border-[#EEF2F2] flex items-center justify-between gap-2">
                      <span>Primary: {pt.primaryCaregiverName || "Unassigned"}</span>
                      <span className="font-mono text-[#008F00] font-medium">{pt.dataMode}</span>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </section>

          {fallSuspect && (
            <div className="bg-red-50 border border-red-300 rounded-xl px-4 py-3 text-xs text-red-800">
              <span className="font-semibold text-red-900">
                Possible Fall Indicator (Experimental IMU):
              </span>{" "}
              Selected patient&apos;s latest MPU6050 reading flagged an impact spike (
              {latest?.accelMagnitude?.toFixed(2) ?? "high"} g). Experimental heuristic — verify
              patient condition directly.
            </div>
          )}

          {voiceEscalations.length > 0 && (
            <section className="space-y-2.5">
              {voiceEscalations.map((esc) => (
                <div
                  key={esc.escalationId}
                  className={`rounded-xl border px-4 py-3 text-xs space-y-2 ${
                    esc.humanFollowUpRequired
                      ? "bg-red-50 border-red-300 text-red-900"
                      : "bg-white border-[#00B800]/40 text-[#202525] shadow-xs"
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold">
                      <ShieldAlert
                        className={`w-4 h-4 ${
                          esc.humanFollowUpRequired ? "text-red-600" : "text-[#00B800]"
                        }`}
                      />
                      <span>
                        Arova AI Voice Escalation ({esc.severity}) ·{" "}
                        <span className="font-mono">{esc.escalationStatus}</span>
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-[#737B7B]">
                      {esc.readingSummary} · Caregiver: {esc.currentCaregiverName || "Pending"} ·
                      Response: {esc.caregiverResponse}
                    </span>
                  </div>
                  <p className="opacity-95">{esc.followUpAction}</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={followUpNotes[esc.escalationId] ?? ""}
                      onChange={(e) =>
                        setFollowUpNotes((prev) => ({
                          ...prev,
                          [esc.escalationId]: e.target.value,
                        }))
                      }
                      placeholder="Confirm patient safety check before resolving emergency..."
                      className="flex-1 px-3 py-1.5 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                    />
                    <button
                      type="button"
                      disabled={resolvingVoiceId === esc.escalationId}
                      onClick={() => void handleResolveVoiceEsc(esc.escalationId)}
                      className="px-3 py-1.5 font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 whitespace-nowrap cursor-pointer transition-colors"
                    >
                      {resolvingVoiceId === esc.escalationId
                        ? "Resolving..."
                        : "Verify Safety & Resolve Emergency"}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Linked-Patient In-App Notifications */}
          {caregiverNotifications.length > 0 && (
            <section className="arova-glass-card rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#00B800]" />
                  <h3 className="text-sm font-semibold text-[#202525]">
                    Caregiver Alert Notifications
                  </h3>
                  {unreadCaregiverNotifications.length > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-amber-50 text-amber-800 border border-amber-300">
                      {unreadCaregiverNotifications.length} unread
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-[#737B7B]">
                  Only actively linked &amp; consented caregivers receive notifications
                </span>
              </div>
              <div className="divide-y divide-[#EEF2F2]">
                {caregiverNotifications.slice(0, 4).map((notif) => (
                  <div
                    key={notif.notificationId}
                    className={`py-2.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs ${
                      notif.read ? "opacity-75" : ""
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <AlertLevelLabel level={notif.severity} />
                        <span className="font-semibold text-[#202525]">{notif.title}</span>
                        {notif.isSimulated && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-amber-50 text-amber-800 border border-amber-300">
                            Simulated ({notif.deliveryStatus})
                          </span>
                        )}
                        {!notif.read && (
                          <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#00B800]/12 text-[#008F00] border border-[#00B800]/30 font-semibold">
                            Unread
                          </span>
                        )}
                      </div>
                      <p className="text-[#737B7B]">{notif.message}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[11px] text-[#737B7B]">
                        {new Date(notif.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {!notif.read && (
                        <button
                          type="button"
                          onClick={() => void markNotificationRead(notif.notificationId)}
                          className="px-2.5 py-1 text-[11px] font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                        >
                          Mark Read
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Camera-Based Fall Alerts & Escalations */}
          <section className="arova-glass-card rounded-2xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-[#00B800]" />
                <div>
                  <h3 className="text-base font-semibold text-[#202525]">
                    Camera-Based Fall Alerts &amp; Escalations
                  </h3>
                  <p className="text-xs text-[#737B7B]">
                    Review fall pose events, location availability, patient safety cancellations, and false alerts
                  </p>
                </div>
              </div>
              <span className="font-mono text-xs text-[#737B7B]">
                {patientFallEvents.length} event(s)
              </span>
            </div>

            {patientFallEvents.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-xl bg-[#F7F9F9]">
                No webcam fall detection events recorded for {selectedPatient.displayName}.
              </div>
            ) : (
              <div className="space-y-3">
                {patientFallEvents.slice(0, 6).map((evt) => {
                  const hasLoc = Boolean(
                    evt.location &&
                      Number.isFinite(evt.location.latitude) &&
                      Number.isFinite(evt.location.longitude)
                  );
                  const mapsUrl =
                    hasLoc && evt.location
                      ? `https://www.google.com/maps?q=${encodeURIComponent(
                          `${evt.location.latitude},${evt.location.longitude}`
                        )}`
                      : null;
                  const sanitizedPhone = privateContact?.phone
                    ? privateContact.phone.trim().replace(/[^+\d]/g, "")
                    : "";
                  const validTel =
                    sanitizedPhone.length >= 7 &&
                    !["911", "112", "999", "108", "100"].includes(
                      sanitizedPhone.replace(/\D/g, "")
                    )
                      ? `tel:${sanitizedPhone}`
                      : null;
                  const fallNote = followUpNotes[evt.eventId] ?? evt.followUpNotes ?? "";
                  const linkedAlert = alerts.find((a) => a.alertId === evt.alertId);
                  const cgAttempts =
                    evt.notificationAttempts && evt.notificationAttempts.length > 0
                      ? evt.notificationAttempts
                      : (linkedAlert?.notificationAttempts ?? []).filter(
                          (a) => a.recipientRole === "caregiver"
                        );

                  return (
                    <div
                      key={evt.eventId}
                      className={`p-4 rounded-xl border space-y-2.5 text-xs ${
                        evt.status === "escalated" || evt.status === "pending_confirmation"
                          ? "bg-red-50 border-red-300"
                          : "bg-[#F7F9F9] border-[#D9E0E0]"
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`px-2 py-0.5 text-[11px] font-bold rounded ${
                              evt.state === "Possible Fall"
                                ? "bg-red-600 text-white"
                                : "bg-amber-500 text-white"
                            }`}
                          >
                            {evt.state === "Possible Fall" ? "⚠ POSSIBLE FALL" : evt.state}
                          </span>
                          <span className="font-semibold text-[#202525]">{evt.patientName}</span>
                          <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-white border border-[#D9E0E0] text-[#202525]">
                            status: {evt.status}
                          </span>
                          {evt.patientAckStatus && (
                            <span
                              className={`px-2 py-0.5 text-[10px] font-mono font-semibold rounded border ${
                                evt.patientAckStatus === "assistance_requested" ||
                                evt.patientAckStatus === "unacknowledged"
                                  ? "bg-red-100 border-red-300 text-red-800"
                                  : "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                              }`}
                            >
                              {evt.patientAckStatus === "assistance_requested"
                                ? "Assistance Requested"
                                : evt.patientAckStatus === "unacknowledged"
                                ? "UNACKNOWLEDGED"
                                : evt.patientAckStatus.replace("_", " ")}
                            </span>
                          )}
                          <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-white border border-[#D9E0E0] text-[#008F00]">
                            fusion: {evt.sensorFusionStatus}
                          </span>
                          {evt.detectionMode === "demo_simulation" && (
                            <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-amber-50 border border-amber-300 text-amber-800">
                              SIMULATED DEMO
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-[#737B7B]">
                          {new Date(evt.detectedAt).toLocaleString()}
                        </span>
                      </div>

                      <p className="text-[#202525] leading-relaxed">{evt.reason}</p>

                      {cgAttempts.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {cgAttempts.map((att) => (
                            <span
                              key={att.attemptId}
                              className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                                att.deliveryStatus === "delivered"
                                  ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                                  : att.deliveryStatus === "simulated"
                                  ? "bg-amber-50 border-amber-300 text-amber-800"
                                  : "bg-red-50 border-red-300 text-red-800"
                              }`}
                            >
                              {att.channel} → {att.recipientName} [{att.deliveryStatus}]
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#737B7B]">
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-[#00B800]" />
                            {hasLoc && evt.location
                              ? `${evt.location.latitude.toFixed(4)}, ${evt.location.longitude.toFixed(4)}`
                              : "Location unavailable"}
                          </span>
                          {mapsUrl && (
                            <a
                              href={mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-2 py-1 font-semibold text-[#008F00] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800]"
                            >
                              VIEW LOCATION
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {validTel ? (
                            <a
                              href={validTel}
                              className="inline-flex items-center gap-1 px-2 py-1 font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md"
                            >
                              <PhoneCall className="w-3 h-3" />
                              CALL USER
                            </a>
                          ) : (
                            <span className="font-mono text-[10px]">
                              CALL USER unavailable (no registered phone)
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2 pt-1">
                        <input
                          type="text"
                          value={fallNote}
                          onChange={(e) =>
                            setFollowUpNotes((prev) => ({
                              ...prev,
                              [evt.eventId]: e.target.value,
                            }))
                          }
                          placeholder="Add caregiver follow-up notes (e.g., called patient, confirmed safe)..."
                          className="flex-1 px-3 py-1.5 text-xs bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          {(evt.status === "pending_confirmation" || evt.status === "escalated") && (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  void acknowledgeAlert(
                                    evt.alertId,
                                    fallNote || "Caregiver acknowledged camera fall alert.",
                                    isAdminUser ? "admin" : "caregiver"
                                  )
                                }
                                className="px-2.5 py-1.5 text-[11px] font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-md cursor-pointer"
                              >
                                Acknowledge
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void cancelFallAlertSafe(
                                    evt.eventId,
                                    fallNote || "Verified patient safe."
                                  )
                                }
                                className="px-2.5 py-1.5 text-[11px] font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800] cursor-pointer"
                              >
                                Mark Safe
                              </button>
                            </>
                          )}
                          {evt.status !== "resolved" &&
                            evt.status !== "false_alert" &&
                            evt.status !== "cancelled_safe" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void resolveAlert(
                                    evt.alertId,
                                    fallNote || "Caregiver completed follow-up and marked resolved.",
                                    isAdminUser ? "admin" : "caregiver"
                                  )
                                }
                                className="px-2.5 py-1.5 text-[11px] font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                              >
                                Mark Resolved
                              </button>
                            )}
                          {evt.status !== "false_alert" && evt.status !== "cancelled_safe" && (
                            <button
                              type="button"
                              onClick={() =>
                                void reportFalseAlert(
                                  evt.alertId,
                                  fallNote || "Caregiver marked camera fall event as false alert.",
                                  isAdminUser ? "admin" : "caregiver"
                                )
                              }
                              className="px-2.5 py-1.5 text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-md hover:bg-amber-100 cursor-pointer"
                            >
                              False Alert
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Selected Patient Snapshot + Voice Integration Status */}
          <section className="arova-float-grid grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-[#202525]">
                    Active &amp; Acknowledged Alerts
                  </h3>
                  <p className="text-xs text-[#737B7B] mt-0.5">
                    Prototype monitoring alerts — acknowledge, record follow-up notes, flag false
                    alerts, and review escalation delivery status
                  </p>
                </div>
                {latest && (
                  <div className="text-xs text-[#202525] font-mono tabular-nums text-right">
                    <div>
                      Latest: {latestHrText} · {latestSpo2Text} · {latestTempText}
                    </div>
                    <div className="text-[#737B7B] mt-0.5">
                      ML: {latest.anomalyStatus ?? latest.alertLevel} · score{" "}
                      {latest.anomalyScore.toFixed(3)}
                      {latest.contributingFeatures && latest.contributingFeatures.length > 0
                        ? ` · ${latest.contributingFeatures.slice(0, 2).join(", ")}`
                        : ""}
                    </div>
                  </div>
                )}
              </div>

              {escalationError && (
                <div className="text-xs text-red-800 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
                  {escalationError}
                </div>
              )}

              {activeAlerts.length === 0 ? (
                <div className="py-10 text-center text-sm text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-xl bg-[#F7F9F9]">
                  No active alerts require caregiver follow-up right now.
                </div>
              ) : (
                <div className="space-y-4">
                  {activeAlerts.map((alert) => {
                    const noteVal = followUpNotes[alert.alertId] ?? alert.followUpAction ?? "";
                    const secondsLeft = countdownByAlert[alert.alertId];

                    return (
                      <div
                        key={alert.alertId}
                        className={`border rounded-xl p-4 space-y-3 bg-[#F7F9F9] ${
                          alert.level === "Critical"
                            ? "border-red-300"
                            : alert.level === "Warning"
                            ? "border-amber-300"
                            : "border-[#D9E0E0]"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <AlertLevelLabel level={alert.level} />
                            <span className="text-sm font-semibold text-[#202525]">{alert.title}</span>
                            {alert.patientAcknowledged && (
                              <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00]">
                                Patient Acked
                              </span>
                            )}
                            {alert.falseAlertReported && (
                              <span className="px-2 py-0.5 text-[10px] font-medium rounded bg-amber-50 border border-amber-300 text-amber-800">
                                False Alert Reported
                              </span>
                            )}
                            {(alert.suppressedOccurrences ?? 0) > 0 && (
                              <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-white border border-[#D9E0E0] text-[#737B7B]">
                                +{alert.suppressedOccurrences} duplicate suppressed
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-[#737B7B] font-mono tabular-nums">
                            {alert.status} · {alert.source} ·{" "}
                            {new Date(alert.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>

                        <p className="text-xs text-[#202525] leading-relaxed">{alert.explanation}</p>

                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          {alert.relevantReadingsSummary && (
                            <span className="font-mono text-[#008F00] bg-white border border-[#D9E0E0] rounded-md px-2 py-1 font-medium">
                              {alert.relevantReadingsSummary}
                            </span>
                          )}
                          {typeof alert.anomalyScore === "number" && (
                            <span className="font-mono text-[#202525] bg-white border border-[#D9E0E0] rounded-md px-2 py-1">
                              Score: {alert.anomalyScore.toFixed(3)}
                            </span>
                          )}
                          {alert.escalationStatus && (
                            <span className="font-mono text-[#737B7B] bg-white border border-[#D9E0E0] rounded-md px-2 py-1">
                              Workflow: {alert.escalationStatus}
                            </span>
                          )}
                        </div>

                        <p className="text-[11px] text-[#737B7B] italic">
                          {alert.prototypeNotice ||
                            "Prototype monitoring alert only — not a medical diagnosis. Please verify directly."}
                        </p>

                        {((alert.escalationHistory && alert.escalationHistory.length > 0) ||
                          (alert.notificationAttempts && alert.notificationAttempts.length > 0)) && (
                          <div className="bg-white border border-[#D9E0E0] rounded-lg p-3 space-y-2 text-[11px]">
                            {alert.escalationHistory && alert.escalationHistory.length > 0 && (
                              <div className="space-y-1">
                                <div className="font-semibold text-[#202525] flex items-center gap-1.5">
                                  <Clock className="w-3.5 h-3.5 text-[#00B800]" />
                                  Escalation Timeline
                                </div>
                                <ul className="space-y-0.5 text-[#737B7B] font-mono">
                                  {alert.escalationHistory.slice(-4).map((step) => (
                                    <li key={step.stepId}>
                                      {new Date(step.timestamp).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        second: "2-digit",
                                      })}{" "}
                                      · {step.summary}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {alert.notificationAttempts && alert.notificationAttempts.length > 0 && (
                              <div className="space-y-1 pt-1.5 border-t border-[#EEF2F2]">
                                <div className="font-semibold text-[#202525]">
                                  Notification Delivery Attempts
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {alert.notificationAttempts.map((att) => (
                                    <span
                                      key={att.attemptId}
                                      className={`px-2 py-0.5 rounded border font-mono ${
                                        att.deliveryStatus === "delivered"
                                          ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                                          : att.deliveryStatus === "simulated"
                                          ? "bg-amber-50 border-amber-300 text-amber-800"
                                          : "bg-red-50 border-red-300 text-red-800"
                                      }`}
                                    >
                                      {att.channel} → {att.recipientRole} [{att.deliveryStatus}]
                                      {att.targetMasked ? ` (${att.targetMasked})` : ""}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Caregiver Escalation Controls for Critical Alerts */}
                        {alert.level === "Critical" && (
                          <div className="bg-white border border-[#D9E0E0] rounded-lg p-3.5 space-y-2.5">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                              <div className="flex items-center gap-2 text-xs font-semibold text-[#202525]">
                                <PhoneCall className="w-4 h-4 text-[#00B800]" />
                                <span>
                                  Voice Escalation Status:{" "}
                                  <span className="font-mono text-[#008F00]">
                                    {alert.callEscalationStatus}
                                  </span>
                                </span>
                                {typeof secondsLeft === "number" &&
                                  alert.callEscalationStatus === "calling_primary" && (
                                    <span className="font-mono tabular-nums text-amber-700">
                                      ({secondsLeft}s before secondary escalation)
                                    </span>
                                  )}
                              </div>

                              <div className="flex flex-wrap gap-2">
                                {(alert.callEscalationStatus === "not_triggered" ||
                                  alert.callEscalationStatus === "provider_unconfigured") && (
                                  <>
                                    {integrations?.voiceCalling.configured && (
                                      <button
                                        type="button"
                                        disabled={escalationBusyId === alert.alertId}
                                        onClick={() =>
                                          handleStartEscalation(
                                            alert.alertId,
                                            alert.explanation,
                                            false
                                          )
                                        }
                                        className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                                      >
                                        Dispatch Live Call
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={escalationBusyId === alert.alertId}
                                      onClick={() =>
                                        handleStartEscalation(alert.alertId, alert.explanation, true)
                                      }
                                      className="px-3 py-1.5 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-50 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                                    >
                                      Run Workflow Dry-Run
                                    </button>
                                  </>
                                )}

                                {alert.callEscalationStatus === "calling_primary" && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={escalationBusyId === alert.alertId}
                                      onClick={() =>
                                        handleAdvanceOutcome(alert.alertId, "primary_answered")
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#008F00] bg-[#00B800]/12 border border-[#00B800]/35 rounded-lg hover:bg-[#00B800]/20 cursor-pointer"
                                    >
                                      <UserCheck className="w-3.5 h-3.5" />
                                      Primary Answered
                                    </button>
                                    <button
                                      type="button"
                                      disabled={escalationBusyId === alert.alertId}
                                      onClick={() =>
                                        handleAdvanceOutcome(
                                          alert.alertId,
                                          "primary_no_answer_escalate"
                                        )
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 cursor-pointer"
                                    >
                                      <PhoneForwarded className="w-3.5 h-3.5" />
                                      Timeout → Escalate Secondary
                                    </button>
                                  </>
                                )}

                                {alert.callEscalationStatus === "escalated_secondary" && (
                                  <button
                                    type="button"
                                    disabled={escalationBusyId === alert.alertId}
                                    onClick={() =>
                                      handleAdvanceOutcome(alert.alertId, "secondary_acknowledged")
                                    }
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#008F00] bg-[#00B800]/12 border border-[#00B800]/35 rounded-lg hover:bg-[#00B800]/20 cursor-pointer"
                                  >
                                    <Check className="w-3.5 h-3.5" />
                                    Secondary Answered
                                  </button>
                                )}
                              </div>
                            </div>

                            {alert.callLog.length > 0 && (
                              <ul className="space-y-1 text-xs text-[#737B7B] font-mono border-t border-[#EEF2F2] pt-2">
                                {alert.callLog.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        {/* Follow-up Action Form */}
                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                          <input
                            type="text"
                            value={noteVal}
                            onChange={(e) =>
                              setFollowUpNotes((prev) => ({
                                ...prev,
                                [alert.alertId]: e.target.value,
                              }))
                            }
                            placeholder="Record caregiver follow-up action (e.g., spoke with patient, checked pulse)..."
                            className="flex-1 px-3 py-2 text-xs bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                          />
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            {alert.status === "active" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void acknowledgeAlert(
                                    alert.alertId,
                                    noteVal,
                                    isAdminUser ? "admin" : "caregiver"
                                  )
                                }
                                className="px-3 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg whitespace-nowrap transition-colors cursor-pointer"
                              >
                                Acknowledge
                              </button>
                            )}
                            {!alert.falseAlertReported && (
                              <button
                                type="button"
                                onClick={() =>
                                  void reportFalseAlert(
                                    alert.alertId,
                                    noteVal || "Caregiver marked alert as false alert.",
                                    isAdminUser ? "admin" : "caregiver"
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 whitespace-nowrap transition-colors cursor-pointer"
                              >
                                <Flag className="w-3 h-3" />
                                False Alert
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void resolveAlert(
                                  alert.alertId,
                                  noteVal,
                                  isAdminUser ? "admin" : "caregiver"
                                )
                              }
                              className="px-3 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] whitespace-nowrap transition-colors cursor-pointer"
                            >
                              Resolve Alert
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Emergency Contact & Escalation Configuration Panel */}
            <aside className="arova-float-card-subtle arova-float-delay-4 arova-glass-card rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#00B800]" />
                <h3 className="text-base font-semibold text-[#202525]">Emergency Escalation Chain</h3>
              </div>

              <div className="space-y-3 text-xs">
                <div className="p-3 bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg space-y-1">
                  <div className="text-[#737B7B]">Step 1 · Primary Caregiver</div>
                  <div className="text-sm font-semibold text-[#202525]">
                    {selectedPatient.primaryCaregiverName || "Not Assigned"}
                  </div>
                  <div className="text-[#737B7B]">
                    Timeout window: {systemSettings.escalationTimeoutSec} seconds
                  </div>
                </div>

                <div className="p-3 bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg space-y-1">
                  <div className="text-[#737B7B]">Step 2 · Secondary Escalation</div>
                  <div className="text-sm font-semibold text-[#202525]">
                    {selectedPatient.secondaryCaregiverName || "Not Assigned"}
                  </div>
                  <div className="text-[#737B7B]">
                    Triggered automatically if primary caregiver does not acknowledge
                  </div>
                </div>

                <div className="pt-3 border-t border-[#EEF2F2] space-y-2">
                  <div className="text-[#202525] font-medium">
                    External Notification Channels (Patient Ack Wait:{" "}
                    {notificationConfig?.patientAckTimeoutSec ?? 60}s)
                  </div>
                  <div className="space-y-1 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[#737B7B]">SMS (Exotel / Twilio)</span>
                      <span className="font-mono text-[#008F00] font-medium">
                        {notificationProviders?.sms.configured ? "Live" : "Simulation Mode"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#737B7B]">Email (Resend / Webhook)</span>
                      <span className="font-mono text-[#008F00] font-medium">
                        {notificationProviders?.email.configured ? "Live" : "Simulation Mode"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#737B7B]">Voice Call Escalation</span>
                      <span className="font-mono text-[#008F00] font-medium">
                        {integrations?.voiceCalling.configured
                          ? integrations.voiceCalling.providerName
                          : "Simulation Mode"}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-[#737B7B] leading-relaxed">
                    Unconfigured external channels log simulated attempts clearly and never claim real
                    delivery or contact emergency services.
                  </p>
                </div>
              </div>

              {resolvedAlerts.length > 0 && (
                <div className="pt-3 border-t border-[#EEF2F2] space-y-2">
                  <h4 className="text-xs font-semibold text-[#202525]">Resolved History</h4>
                  <div className="space-y-2">
                    {resolvedAlerts.slice(0, 3).map((ra) => (
                      <div key={ra.alertId} className="text-xs text-[#737B7B]">
                        <div className="font-medium text-[#202525]">{ra.title}</div>
                        <div>{ra.followUpAction || "Resolved"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </section>

          <MlIntelligencePanel
            compact
            patient={selectedPatient}
            readings={readings}
            latestReading={latest}
            baselines={baselines}
            anomalyEvents={anomalyEvents}
            mlConnected={Boolean(integrations?.mlService.reachable)}
            isAdminUser={isAdminUser}
          />

          <EcgWaveformPanel
            segments={ecgSegments}
            compact
            title={`AD8232 ECG Monitor · ${selectedPatient.displayName}`}
          />
        </>
      )}
    </div>
  );
}
