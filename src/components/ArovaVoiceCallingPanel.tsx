import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Eye,
  Languages,
  LogIn,
  PauseCircle,
  PhoneCall,
  PlayCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import {
  deleteVoiceCaregiverContact,
  fetchVoiceAuditLogs,
  fetchVoiceCallHistory,
  fetchVoiceCaregiverContacts,
  fetchVoiceEscalations,
  fetchVoiceRetrySettings,
  OutboundCallApiError,
  resolveVoiceEscalation,
  saveVoiceCaregiverContact,
  saveVoiceRetrySettings,
  triggerAdminVoiceTestCall,
  updateVoiceCaregiverContact,
} from "../services/apiClient.ts";
import type {
  ArovaCallStatus,
  CaregiverPriority,
  CaregiverVoiceContact,
  SupportedVoiceLanguage,
  VoiceAuditLogEntry,
  VoiceCallHistoryEntry,
  VoiceEscalationEvent,
  VoiceRetryPolicyConfig,
} from "../types/smartcare.ts";
import { BrowserVoiceTestPanel } from "./BrowserVoiceTestPanel.tsx";

const LANGUAGE_LABELS: Record<SupportedVoiceLanguage, string> = {
  en: "English",
  kn: "Kannada",
  hi: "Hindi",
};

const ACTIVE_CALL_STATUSES = new Set<ArovaCallStatus>(["Initiated", "Ringing", "Answered"]);
const ACTIVE_ESCALATION_STATUSES = new Set([
  "calling_primary",
  "retrying",
  "escalated_secondary",
  "acknowledged",
  "human_follow_up_required",
]);

function formatDuration(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "Answered":
    case "Completed":
    case "acknowledged":
    case "resolved":
      return "bg-[#00B800]/12 text-[#008F00] border-[#00B800]/35";
    case "Initiated":
    case "Ringing":
    case "calling_primary":
    case "retrying":
      return "bg-amber-50 text-amber-800 border-amber-300";
    case "Failed":
    case "Unanswered":
    case "Busy":
    case "human_follow_up_required":
    case "fallback_notified":
    case "escalated_secondary":
      return "bg-red-50 text-red-800 border-red-300";
    default:
      return "bg-[#EEF2F2] text-[#202525] border-[#D9E0E0]";
  }
}

export function ArovaVoiceCallingPanel() {
  const {
    user,
    isAdminUser,
    signInWithGoogle,
    patients,
    selectedPatient,
    integrations,
    refreshIntegrations,
  } = useSmartCare();

  const [contacts, setContacts] = useState<CaregiverVoiceContact[]>([]);
  const [history, setHistory] = useState<VoiceCallHistoryEntry[]>([]);
  const [escalations, setEscalations] = useState<VoiceEscalationEvent[]>([]);
  const [auditLogs, setAuditLogs] = useState<VoiceAuditLogEntry[]>([]);
  const [retryPolicy, setRetryPolicy] = useState<VoiceRetryPolicyConfig | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [formPatientId, setFormPatientId] = useState<string>(selectedPatient.patientId);
  const [caregiverName, setCaregiverName] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [priority, setPriority] = useState<CaregiverPriority>("primary");
  const [preferredLanguage, setPreferredLanguage] = useState<SupportedVoiceLanguage>("en");
  const [explicitCallConsent, setExplicitCallConsent] = useState(false);
  const [authorizedForPatientIdentity, setAuthorizedForPatientIdentity] = useState(true);
  const [authorizedForHealthReadings, setAuthorizedForHealthReadings] = useState(true);
  const [contactBusy, setContactBusy] = useState(false);
  const [contactFeedback, setContactFeedback] = useState<string | null>(null);

  const [testContactId, setTestContactId] = useState("");
  const [testLanguage, setTestLanguage] = useState<SupportedVoiceLanguage>("en");
  const [testParameter, setTestParameter] = useState("Heart Rate");
  const [testReadingValue, setTestReadingValue] = useState("118");
  const [testReadingUnit, setTestReadingUnit] = useState("BPM");
  const [testBusy, setTestBusy] = useState(false);
  const [testResultMsg, setTestResultMsg] = useState<string | null>(null);
  const [testErrorMsg, setTestErrorMsg] = useState<string | null>(null);
  const [testChannel, setTestChannel] = useState<"browser" | "twilio">("browser");
  const [browserAuthIdentity, setBrowserAuthIdentity] = useState(true);
  const [browserAuthReadings, setBrowserAuthReadings] = useState(true);

  const [retryIntervalSec, setRetryIntervalSec] = useState(30);
  const [maxCallAttempts, setMaxCallAttempts] = useState(2);
  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  const [resolveNoteById, setResolveNoteById] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [selectedCallDetail, setSelectedCallDetail] = useState<VoiceCallHistoryEntry | null>(null);

  useEffect(() => {
    setFormPatientId(selectedPatient.patientId);
  }, [selectedPatient.patientId]);

  const loadAllVoiceData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [cList, hList, eList, rPolicy, aLogs] = await Promise.all([
        fetchVoiceCaregiverContacts(),
        fetchVoiceCallHistory(),
        fetchVoiceEscalations(),
        fetchVoiceRetrySettings(),
        fetchVoiceAuditLogs(),
      ]);
      setContacts(cList);
      setHistory(hList);
      setEscalations(eList);
      setRetryPolicy(rPolicy);
      setRetryIntervalSec(rPolicy.retryIntervalSec);
      setMaxCallAttempts(rPolicy.maxCallAttempts);
      setFallbackEnabled(rPolicy.fallbackNotificationEnabled);
      setAuditLogs(aLogs);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Unable to load Arova AI emergency voice data."
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      void loadAllVoiceData();
    } else {
      setContacts([]);
      setHistory([]);
      setEscalations([]);
      setAuditLogs([]);
      setRetryPolicy(null);
    }
  }, [user, loadAllVoiceData]);

  const consentedContacts = useMemo(
    () => contacts.filter((c) => c.explicitCallConsent && c.status === "active"),
    [contacts]
  );

  useEffect(() => {
    if (!testContactId && consentedContacts.length > 0) {
      setTestContactId(consentedContacts[0].contactId);
      setTestLanguage(consentedContacts[0].preferredLanguage);
    } else if (
      testContactId &&
      !consentedContacts.some((c) => c.contactId === testContactId)
    ) {
      setTestContactId(consentedContacts[0]?.contactId ?? "");
    }
  }, [consentedContacts, testContactId]);

  const hasActiveWorkflow = useMemo(() => {
    const activeCall = history.some((h) => ACTIVE_CALL_STATUSES.has(h.callStatus));
    const activeEsc = escalations.some(
      (e) => e.emergencyActive && ACTIVE_ESCALATION_STATUSES.has(e.escalationStatus)
    );
    return activeCall || activeEsc;
  }, [history, escalations]);

  useEffect(() => {
    if (!user || !hasActiveWorkflow) return;
    const timer = setInterval(() => {
      void loadAllVoiceData();
    }, 4000);
    return () => clearInterval(timer);
  }, [user, hasActiveWorkflow, loadAllVoiceData]);

  const resetContactForm = () => {
    setEditingContactId(null);
    setCaregiverName("");
    setPhoneInput("");
    setPriority("primary");
    setPreferredLanguage("en");
    setExplicitCallConsent(false);
    setAuthorizedForPatientIdentity(true);
    setAuthorizedForHealthReadings(true);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    setContactBusy(true);
    setContactFeedback(null);
    try {
      const targetPatient =
        patients.find((p) => p.patientId === formPatientId) ?? selectedPatient;
      if (editingContactId) {
        const patch: Parameters<typeof updateVoiceCaregiverContact>[1] = {
          caregiverName: caregiverName.trim(),
          priority,
          preferredLanguage,
          explicitCallConsent,
          authorizedForPatientIdentity,
          authorizedForHealthReadings,
        };
        if (phoneInput.trim()) {
          patch.phoneNumber = phoneInput.trim();
        }
        await updateVoiceCaregiverContact(editingContactId, patch);
        setContactFeedback("Caregiver voice contact updated.");
      } else {
        await saveVoiceCaregiverContact({
          patientId: targetPatient.patientId,
          patientOwnerUid: targetPatient.ownerUid,
          caregiverName: caregiverName.trim(),
          phoneNumber: phoneInput.trim(),
          priority,
          preferredLanguage,
          explicitCallConsent,
          authorizedForPatientIdentity,
          authorizedForHealthReadings,
          status: "active",
        });
        setContactFeedback("Registered caregiver contact saved (phone number masked).");
      }
      resetContactForm();
      await loadAllVoiceData();
    } catch (err) {
      setContactFeedback(
        err instanceof Error ? err.message : "Failed to save caregiver contact."
      );
    } finally {
      setContactBusy(false);
    }
  };

  const handleEditContact = (c: CaregiverVoiceContact) => {
    setEditingContactId(c.contactId);
    setFormPatientId(c.patientId);
    setCaregiverName(c.caregiverName);
    setPhoneInput("");
    setPriority(c.priority);
    setPreferredLanguage(c.preferredLanguage);
    setExplicitCallConsent(c.explicitCallConsent);
    setAuthorizedForPatientIdentity(c.authorizedForPatientIdentity);
    setAuthorizedForHealthReadings(c.authorizedForHealthReadings);
    setContactFeedback(
      `Editing ${c.caregiverName} (${c.maskedPhone}). Leave phone blank to keep existing number.`
    );
  };

  const handleToggleContactStatus = async (c: CaregiverVoiceContact) => {
    setContactFeedback(null);
    try {
      await updateVoiceCaregiverContact(c.contactId, {
        status: c.status === "active" ? "paused" : "active",
      });
      await loadAllVoiceData();
    } catch (err) {
      setContactFeedback(err instanceof Error ? err.message : "Could not update status.");
    }
  };

  const handleDeleteContact = async (c: CaregiverVoiceContact) => {
    setContactFeedback(null);
    try {
      await deleteVoiceCaregiverContact(c.contactId);
      if (editingContactId === c.contactId) resetContactForm();
      await loadAllVoiceData();
    } catch (err) {
      setContactFeedback(err instanceof Error ? err.message : "Could not delete contact.");
    }
  };

  const handleTriggerTestCall = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestBusy(true);
    setTestResultMsg(null);
    setTestErrorMsg(null);
    try {
      const targetContact = contacts.find((c) => c.contactId === testContactId);
      const patient =
        patients.find((p) => p.patientId === targetContact?.patientId) ?? selectedPatient;
      const call = await triggerAdminVoiceTestCall({
        contactId: testContactId,
        patientName: patient.displayName,
        parameter: testParameter,
        readingValue: testReadingValue,
        readingUnit: testReadingUnit,
        language: testLanguage,
      });
      setTestResultMsg(
        `Real Twilio outbound test call initiated (${call.callStatus}) to ${call.caregiverName} (${call.maskedPhone}) in ${LANGUAGE_LABELS[call.selectedLanguage]}.`
      );
      await loadAllVoiceData();
    } catch (err) {
      if (err instanceof OutboundCallApiError && err.missingEnvVars?.length) {
        setTestErrorMsg(
          `${err.message} Required server configuration: ${err.missingEnvVars.join(", ")}.`
        );
      } else {
        setTestErrorMsg(err instanceof Error ? err.message : "Failed to initiate test call.");
      }
      await loadAllVoiceData();
    } finally {
      setTestBusy(false);
    }
  };

  const handleSaveRetrySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setRetryBusy(true);
    setRetryMsg(null);
    try {
      const updated = await saveVoiceRetrySettings({
        retryIntervalSec,
        maxCallAttempts,
        fallbackNotificationEnabled: fallbackEnabled,
      });
      setRetryPolicy(updated);
      setRetryMsg(
        `Retry policy updated: every ${updated.retryIntervalSec}s, up to ${updated.maxCallAttempts} attempts.`
      );
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : "Failed to save retry policy.");
    } finally {
      setRetryBusy(false);
    }
  };

  const handleResolveEscalation = async (escalationId: string) => {
    setResolvingId(escalationId);
    try {
      await resolveVoiceEscalation(escalationId, resolveNoteById[escalationId]);
      await loadAllVoiceData();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not resolve escalation.");
    } finally {
      setResolvingId(null);
    }
  };

  const activeHighOrMediumEscalations = escalations.filter((e) => e.emergencyActive);
  const urgentHumanFollowUps = escalations.filter(
    (e) => e.emergencyActive && e.humanFollowUpRequired
  );
  const twilioReady = Boolean(integrations?.outboundTwilio?.configured);
  const missingTwilioVars = integrations?.outboundTwilio?.missingEnvVars ?? [];

  const detailEscalation = selectedCallDetail?.escalationId
    ? escalations.find((e) => e.escalationId === selectedCallDetail.escalationId) ?? null
    : null;
  const detailAudits = selectedCallDetail
    ? auditLogs.filter(
        (a) =>
          a.callId === selectedCallDetail.callId ||
          (selectedCallDetail.escalationId && a.escalationId === selectedCallDetail.escalationId)
      )
    : [];

  return (
    <section className="arova-float-card-subtle arova-float-delay-2 arova-glass-card border border-[#D9E0E0] rounded-2xl p-5 sm:p-6 space-y-6">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-[#D9E0E0] pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <PhoneCall className="w-5 h-5 text-[#00B800]" />
            <h2 className="text-lg font-semibold text-[#202525]">
              Arova AI – Emergency Voice Calling
            </h2>
          </div>
          <p className="text-xs text-[#737B7B]">
            Multilingual (English, Kannada, Hindi) Twilio + Gemini Live caregiver notification,
            consent &amp; authorization controls, retry escalation, and audit history
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {user && (
            <button
              type="button"
              onClick={() => {
                void refreshIntegrations();
                void loadAllVoiceData();
              }}
              disabled={loading}
              className="arova-cta-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-[#00B800] ${loading ? "animate-spin" : ""}`} />
              Refresh Voice State
            </button>
          )}
        </div>
      </div>

      {/* Twilio Readiness Banner */}
      <div
        className={`rounded-xl border px-4 py-3 text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 ${
          twilioReady
            ? "bg-[#00B800]/10 border-[#00B800]/35 text-[#202525]"
            : "bg-amber-50 border-amber-300 text-amber-900"
        }`}
      >
        <div className="flex items-start gap-2.5">
          {twilioReady ? (
            <CheckCircle2 className="w-4 h-4 text-[#00B800] shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          )}
          <div className="space-y-0.5">
            <div className="font-semibold text-[#202525]">
              {twilioReady
                ? "Twilio Programmable Voice & Gemini Live Media Stream Ready"
                : "Phone calling is not configured yet. You can still test the AI voice assistant in your browser."}
            </div>
            <div className={twilioReady ? "text-[#202525]" : "text-amber-800"}>
              {twilioReady
                ? "Real outbound calls can ring registered consented caregiver phones with bidirectional English, Kannada, or Hindi Gemini Live audio."
                : `Outbound phone calling stays ready for future setup when you add server environment variable(s): ${
                    missingTwilioVars.length > 0
                      ? missingTwilioVars.join(", ")
                      : "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, GEMINI_API_KEY, APP_URL"
                  }.`}
            </div>
          </div>
        </div>
        <div className="text-[11px] font-mono shrink-0 text-[#737B7B]">
          No call audio recorded · Structured response logging only
        </div>
      </div>

      {/* Unauthenticated Gate */}
      {!user ? (
        <div className="border border-dashed border-[#D9E0E0] rounded-xl p-6 text-center space-y-3 bg-[#F7F9F9]">
          <ShieldCheck className="w-7 h-7 text-[#00B800] mx-auto" />
          <div className="space-y-1 max-w-md mx-auto">
            <h3 className="text-sm font-semibold text-[#202525]">
              Sign In Required for Caregiver Voice Controls
            </h3>
            <p className="text-xs text-[#737B7B]">
              Caregiver phone numbers, consent flags, Admin Test Calls, and call history are
              protected by verified Firebase authentication and role-based access control.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="arova-cta-primary inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl cursor-pointer transition-colors"
          >
            <LogIn className="w-4 h-4" />
            Sign In with Google
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {loadError && (
            <div className="bg-red-50 border border-red-300 text-red-800 rounded-xl px-4 py-2.5 text-xs">
              {loadError}
            </div>
          )}

          {/* Urgent Fallback Banner */}
          {urgentHumanFollowUps.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded-xl p-4 flex items-start gap-3 text-xs text-red-800">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-red-900">
                  Human Follow-Up Required ({urgentHumanFollowUps.length} active alert
                  {urgentHumanFollowUps.length === 1 ? "" : "s"})
                </div>
                <p>
                  All configured caregivers were unavailable or exhausted for an active High
                  severity event. Verify patient safety immediately and resolve manually below.
                </p>
              </div>
            </div>
          )}

          {/* Row 1 */}
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
            <div className="xl:col-span-3 border border-[#D9E0E0] rounded-2xl p-4 space-y-4 bg-[#F7F9F9]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-[#00B800]" />
                  <h3 className="text-sm font-semibold text-[#202525]">
                    Manage Caregiver Contacts
                  </h3>
                </div>
                <span className="text-[11px] text-[#737B7B]">
                  Phone numbers masked on display
                </span>
              </div>

              <form onSubmit={handleSaveContact} className="space-y-3 text-xs bg-white border border-[#D9E0E0] rounded-xl p-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                  <label className="space-y-1">
                    <span className="text-[#737B7B] font-medium">Patient</span>
                    <select
                      value={formPatientId}
                      onChange={(e) => setFormPatientId(e.target.value)}
                      disabled={Boolean(editingContactId)}
                      className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                    >
                      {patients.map((p) => (
                        <option key={p.patientId} value={p.patientId}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-[#737B7B] font-medium">Caregiver Name</span>
                    <input
                      type="text"
                      required
                      value={caregiverName}
                      onChange={(e) => setCaregiverName(e.target.value)}
                      placeholder="Full Name"
                      className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-[#737B7B] font-medium">
                      Phone (E.164){editingContactId ? " (Optional)" : ""}
                    </span>
                    <input
                      type="tel"
                      required={!editingContactId}
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="+919876543210"
                      className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-[#737B7B] font-medium">Priority</span>
                      <select
                        value={priority}
                        onChange={(e) => setPriority(e.target.value as CaregiverPriority)}
                        className="w-full px-2 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                      >
                        <option value="primary">Primary</option>
                        <option value="secondary">Secondary</option>
                        <option value="alternate">Alternate</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[#737B7B] font-medium">Language</span>
                      <select
                        value={preferredLanguage}
                        onChange={(e) =>
                          setPreferredLanguage(e.target.value as SupportedVoiceLanguage)
                        }
                        className="w-full px-2 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                      >
                        <option value="en">English</option>
                        <option value="kn">Kannada</option>
                        <option value="hi">Hindi</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                  <label className="flex items-start gap-2 p-2 rounded-lg border border-[#D9E0E0] bg-[#F7F9F9] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={explicitCallConsent}
                      onChange={(e) => setExplicitCallConsent(e.target.checked)}
                      className="mt-0.5 accent-[#00B800]"
                    />
                    <span className="text-[11px] text-[#737B7B]">
                      <strong className="block text-[#202525]">Explicit Call Consent</strong>
                      Required to place automated AI calls
                    </span>
                  </label>

                  <label className="flex items-start gap-2 p-2 rounded-lg border border-[#D9E0E0] bg-[#F7F9F9] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={authorizedForPatientIdentity}
                      onChange={(e) => setAuthorizedForPatientIdentity(e.target.checked)}
                      className="mt-0.5 accent-[#00B800]"
                    />
                    <span className="text-[11px] text-[#737B7B]">
                      <strong className="block text-[#202525]">Share Patient Name</strong>
                      Authorize disclosing identity on call
                    </span>
                  </label>

                  <label className="flex items-start gap-2 p-2 rounded-lg border border-[#D9E0E0] bg-[#F7F9F9] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={authorizedForHealthReadings}
                      onChange={(e) => setAuthorizedForHealthReadings(e.target.checked)}
                      className="mt-0.5 accent-[#00B800]"
                    />
                    <span className="text-[11px] text-[#737B7B]">
                      <strong className="block text-[#202525]">Share Health Readings</strong>
                      Authorize abnormal reading summary
                    </span>
                  </label>
                </div>

                <div className="flex items-center justify-end gap-2">
                  {editingContactId && (
                    <button
                      type="button"
                      onClick={resetContactForm}
                      className="px-3 py-1.5 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] cursor-pointer"
                    >
                      Cancel Edit
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={contactBusy}
                    className="arova-cta-primary inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {editingContactId ? "Update Caregiver" : "Register Caregiver"}
                  </button>
                </div>
                {contactFeedback && (
                  <p className="text-xs text-[#008F00] font-medium">{contactFeedback}</p>
                )}
              </form>

              {/* Caregiver List */}
              <div className="space-y-2">
                {contacts.length === 0 ? (
                  <div className="text-xs text-[#737B7B] text-center py-5 border border-dashed border-[#D9E0E0] rounded-lg bg-white">
                    No caregiver contacts registered yet for automated Arova AI voice calling.
                  </div>
                ) : (
                  contacts.map((c) => (
                    <div
                      key={c.contactId}
                      className="bg-white border border-[#D9E0E0] rounded-xl p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-[#202525]">{c.caregiverName}</span>
                          <span className="font-mono text-[#737B7B]">{c.maskedPhone}</span>
                          <span className="px-2 py-0.5 rounded border text-[11px] capitalize bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00] font-medium">
                            {c.priority}
                          </span>
                          <span className="px-2 py-0.5 rounded border text-[11px] bg-[#EEF2F2] border-[#D9E0E0] text-[#202525]">
                            {LANGUAGE_LABELS[c.preferredLanguage]}
                          </span>
                          {c.status === "paused" && (
                            <span className="px-2 py-0.5 rounded border text-[11px] bg-amber-50 border-amber-300 text-amber-800">
                              Paused
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-3 text-[11px] text-[#737B7B]">
                          <span>
                            Consent:{" "}
                            <strong
                              className={
                                c.explicitCallConsent ? "text-[#008F00]" : "text-red-700"
                              }
                            >
                              {c.explicitCallConsent ? "Granted" : "Not Granted"}
                            </strong>
                          </span>
                          <span>
                            Patient Name:{" "}
                            {c.authorizedForPatientIdentity ? "Authorized" : "Restricted"}
                          </span>
                          <span>
                            Readings:{" "}
                            {c.authorizedForHealthReadings ? "Authorized" : "Restricted"}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleEditContact(c)}
                          className="px-2.5 py-1 text-[11px] font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleContactStatus(c)}
                          title={c.status === "active" ? "Pause calls" : "Resume calls"}
                          className="p-1.5 text-[#737B7B] hover:text-[#008F00] border border-[#D9E0E0] rounded-lg bg-white cursor-pointer"
                        >
                          {c.status === "active" ? (
                            <PauseCircle className="w-3.5 h-3.5" />
                          ) : (
                            <PlayCircle className="w-3.5 h-3.5 text-[#00B800]" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteContact(c)}
                          title="Delete contact"
                          className="p-1.5 text-red-600 hover:bg-red-50 border border-[#D9E0E0] rounded-lg bg-white cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Right Column */}
            <div className="xl:col-span-2 space-y-5">
              <div className="border border-[#D9E0E0] rounded-2xl p-4 space-y-3 bg-[#F7F9F9]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Languages className="w-4 h-4 text-[#00B800]" />
                    <h3 className="text-sm font-semibold text-[#202525]">Test AI Voice Assistant</h3>
                  </div>
                  <span className="text-[11px] text-[#737B7B]">
                    {testChannel === "browser"
                      ? "Browser Test Ready"
                      : isAdminUser
                        ? "Admin Authorized"
                        : "Admin Required"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#EEF2F2] border border-[#D9E0E0] text-xs">
                  <button
                    type="button"
                    onClick={() => setTestChannel("browser")}
                    className={`py-1.5 px-2.5 rounded-lg font-semibold transition-all cursor-pointer ${
                      testChannel === "browser"
                        ? "bg-[#00B800] text-white"
                        : "text-[#737B7B] hover:text-[#202525]"
                    }`}
                  >
                    Browser Voice Test
                  </button>
                  <button
                    type="button"
                    onClick={() => setTestChannel("twilio")}
                    className={`py-1.5 px-2.5 rounded-lg font-semibold transition-all cursor-pointer ${
                      testChannel === "twilio"
                        ? "bg-[#00B800] text-white"
                        : "text-[#737B7B] hover:text-[#202525]"
                    }`}
                  >
                    Phone Call (Twilio)
                  </button>
                </div>

                {testChannel === "browser" ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <label className="block space-y-1">
                        <span className="text-[#737B7B] font-medium">Test Parameter</span>
                        <input
                          type="text"
                          value={testParameter}
                          onChange={(e) => setTestParameter(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] focus:outline-none focus:border-[#00B800]"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Value</span>
                          <input
                            type="text"
                            value={testReadingValue}
                            onChange={(e) => setTestReadingValue(e.target.value)}
                            className="w-full px-2 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Unit</span>
                          <input
                            type="text"
                            value={testReadingUnit}
                            onChange={(e) => setTestReadingUnit(e.target.value)}
                            className="w-full px-2 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3 text-[11px] text-[#202525]">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={browserAuthIdentity}
                          onChange={(e) => setBrowserAuthIdentity(e.target.checked)}
                          className="accent-[#00B800]"
                        />
                        <span>Share Patient Name</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={browserAuthReadings}
                          onChange={(e) => setBrowserAuthReadings(e.target.checked)}
                          className="accent-[#00B800]"
                        />
                        <span>Share Health Readings</span>
                      </label>
                    </div>

                    <BrowserVoiceTestPanel
                      mode="caregiver_alert"
                      defaultLanguage={testLanguage}
                      patientName={selectedPatient.displayName}
                      caregiverName={
                        consentedContacts.find((c) => c.contactId === testContactId)
                          ?.caregiverName || "Caregiver Tester"
                      }
                      parameter={testParameter}
                      readingValue={testReadingValue}
                      readingUnit={testReadingUnit}
                      authorizedForPatientIdentity={browserAuthIdentity}
                      authorizedForHealthReadings={browserAuthReadings}
                      compact
                    />
                  </div>
                ) : (
                  <form onSubmit={handleTriggerTestCall} className="space-y-3">
                    {!twilioReady && (
                      <div className="text-xs bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-3 py-2">
                        Phone calling is not configured yet. You can still test the AI voice
                        assistant in your browser.
                      </div>
                    )}

                    <div className="space-y-2.5 text-xs">
                      <label className="block space-y-1">
                        <span className="text-[#737B7B] font-medium">
                          Registered Consented Caregiver
                        </span>
                        <select
                          value={testContactId}
                          onChange={(e) => {
                            const id = e.target.value;
                            setTestContactId(id);
                            const match = consentedContacts.find((c) => c.contactId === id);
                            if (match) setTestLanguage(match.preferredLanguage);
                          }}
                          disabled={consentedContacts.length === 0}
                          className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                        >
                          {consentedContacts.length === 0 ? (
                            <option value="">No active consented caregiver registered</option>
                          ) : (
                            consentedContacts.map((c) => (
                              <option key={c.contactId} value={c.contactId}>
                                {c.caregiverName} ({c.priority} · {c.maskedPhone})
                              </option>
                            ))
                          )}
                        </select>
                      </label>

                      <div className="grid grid-cols-2 gap-2">
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Voice Language</span>
                          <select
                            value={testLanguage}
                            onChange={(e) =>
                              setTestLanguage(e.target.value as SupportedVoiceLanguage)
                            }
                            className="w-full px-2.5 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                          >
                            <option value="en">English</option>
                            <option value="kn">Kannada</option>
                            <option value="hi">Hindi</option>
                          </select>
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Test Parameter</span>
                          <input
                            type="text"
                            value={testParameter}
                            onChange={(e) => setTestParameter(e.target.value)}
                            className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] focus:outline-none focus:border-[#00B800]"
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Reading Value</span>
                          <input
                            type="text"
                            value={testReadingValue}
                            onChange={(e) => setTestReadingValue(e.target.value)}
                            className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-[#737B7B] font-medium">Unit</span>
                          <input
                            type="text"
                            value={testReadingUnit}
                            onChange={(e) => setTestReadingUnit(e.target.value)}
                            className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                          />
                        </label>
                      </div>
                    </div>

                    {twilioReady ? (
                      <button
                        type="submit"
                        disabled={!isAdminUser || !testContactId || testBusy}
                        className="arova-cta-primary w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        {testBusy ? "Dialing Real Twilio Call..." : "Start Real Test AI Call"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setTestChannel("browser")}
                        className="arova-cta-primary w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg cursor-pointer transition-colors"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        Switch to Browser Voice Test (No Twilio Required)
                      </button>
                    )}

                    {!isAdminUser && (
                      <p className="text-[11px] text-[#737B7B]">
                        Only verified Admin accounts can initiate Admin Test AI Calls.
                      </p>
                    )}
                    {testResultMsg && (
                      <div className="text-xs bg-[#00B800]/10 border border-[#00B800]/35 text-[#008F00] rounded-lg px-3 py-2 font-medium">
                        {testResultMsg}
                      </div>
                    )}
                    {testErrorMsg && (
                      <div className="text-xs bg-red-50 border border-red-300 text-red-800 rounded-lg px-3 py-2">
                        {testErrorMsg}
                      </div>
                    )}
                  </form>
                )}
              </div>

              {/* Configure Retry Settings */}
              <form
                onSubmit={handleSaveRetrySettings}
                className="border border-[#D9E0E0] rounded-2xl p-4 space-y-3 bg-[#F7F9F9]"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[#202525]">
                    Configure Retry Settings
                  </h3>
                  {retryPolicy && (
                    <span className="text-[11px] text-[#008F00] font-mono font-semibold">
                      {retryPolicy.retryIntervalSec}s × {retryPolicy.maxCallAttempts}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <label className="block space-y-1">
                    <span className="text-[#737B7B] font-medium">Retry Interval (sec)</span>
                    <input
                      type="number"
                      min={10}
                      max={600}
                      value={retryIntervalSec}
                      onChange={(e) => setRetryIntervalSec(Number(e.target.value))}
                      className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-[#737B7B] font-medium">Max Call Attempts</span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={maxCallAttempts}
                      onChange={(e) => setMaxCallAttempts(Number(e.target.value))}
                      className="w-full px-2.5 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2 text-xs text-[#202525] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fallbackEnabled}
                    onChange={(e) => setFallbackEnabled(e.target.checked)}
                    className="accent-[#00B800]"
                  />
                  <span>
                    Trigger dashboard fallback alert &amp; Human Follow-Up Required if all
                    caregivers are unreachable
                  </span>
                </label>

                <button
                  type="submit"
                  disabled={!isAdminUser || retryBusy}
                  className="arova-cta-primary inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Retry Settings
                </button>
                {retryMsg && (
                  <p className="text-xs text-[#008F00] font-medium">{retryMsg}</p>
                )}
              </form>
            </div>
          </div>

          {/* Row 2: View Escalation Status */}
          <div className="border border-[#D9E0E0] rounded-2xl p-4 space-y-3 bg-[#F7F9F9]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-[#00B800]" />
                <h3 className="text-sm font-semibold text-[#202525]">
                  View Escalation Status ({activeHighOrMediumEscalations.length} active)
                </h3>
              </div>
              <span className="text-[11px] text-[#737B7B]">
                Answering a call records caregiver intent — emergency stays active until human
                safety confirmation
              </span>
            </div>

            {escalations.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-lg bg-white">
                No automated ML anomaly escalations recorded yet.
              </div>
            ) : (
              <div className="space-y-3">
                {escalations.slice(0, 10).map((esc) => (
                  <div
                    key={esc.escalationId}
                    className={`border rounded-xl p-3.5 space-y-2.5 text-xs ${
                      esc.humanFollowUpRequired
                        ? "border-red-300 bg-red-50"
                        : "border-[#D9E0E0] bg-white"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded border font-semibold text-[11px] ${
                            esc.severity === "High"
                              ? "bg-red-50 text-red-800 border-red-300"
                              : esc.severity === "Medium"
                                ? "bg-amber-50 text-amber-800 border-amber-300"
                                : "bg-[#EEF2F2] text-[#202525] border-[#D9E0E0]"
                          }`}
                        >
                          {esc.severity} Severity
                        </span>
                        <span className="font-semibold text-[#202525]">{esc.patientName}</span>
                        <span className="font-mono text-[#737B7B]">{esc.readingSummary}</span>
                        <span
                          className={`px-2 py-0.5 rounded border font-mono text-[11px] ${statusBadgeClass(
                            esc.escalationStatus
                          )}`}
                        >
                          {esc.escalationStatus}
                        </span>
                      </div>
                      <span className="text-[11px] text-[#737B7B] font-mono">
                        Attempt {esc.attemptForCurrentCaregiver}/{esc.maxAttempts} ·{" "}
                        {formatTimestamp(esc.updatedAt)}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-[#737B7B]">
                      <div>
                        Caregiver:{" "}
                        <strong className="text-[#202525]">
                          {esc.currentCaregiverName || "None"}
                        </strong>{" "}
                        {esc.currentCaregiverPriority ? `(${esc.currentCaregiverPriority})` : ""}
                      </div>
                      <div>
                        Caregiver Response:{" "}
                        <strong className="text-[#202525]">{esc.caregiverResponse}</strong>
                      </div>
                      <div>
                        Fallback:{" "}
                        <strong className="text-[#202525]">
                          {esc.fallbackTriggered ? "Triggered" : "Standby"}
                        </strong>
                      </div>
                    </div>

                    <p className="text-xs text-[#202525]">{esc.followUpAction}</p>

                    {esc.emergencyActive && esc.escalationStatus !== "resolved" && (
                      <div className="flex flex-col sm:flex-row gap-2 pt-1">
                        <input
                          type="text"
                          value={resolveNoteById[esc.escalationId] ?? ""}
                          onChange={(e) =>
                            setResolveNoteById((prev) => ({
                              ...prev,
                              [esc.escalationId]: e.target.value,
                            }))
                          }
                          placeholder="Safety confirmation note before resolving emergency..."
                          className="flex-1 px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                        />
                        <button
                          type="button"
                          disabled={resolvingId === esc.escalationId}
                          onClick={() => void handleResolveEscalation(esc.escalationId)}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 whitespace-nowrap cursor-pointer transition-colors"
                        >
                          {resolvingId === esc.escalationId
                            ? "Resolving..."
                            : "Verify Safety & Resolve Emergency"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Row 3: View Call History */}
          <div className="border border-[#D9E0E0] rounded-2xl p-4 space-y-3 bg-[#F7F9F9]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-[#00B800]" />
                <h3 className="text-sm font-semibold text-[#202525]">
                  View Call History ({history.length})
                </h3>
              </div>
              <span className="text-[11px] text-[#737B7B]">
                All 14 required clinical/operational audit columns
              </span>
            </div>

            {history.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-lg bg-white">
                No outbound voice calls placed yet.
              </div>
            ) : (
              <div className="overflow-x-auto bg-white border border-[#D9E0E0] rounded-xl p-2">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#D9E0E0] text-[#737B7B] whitespace-nowrap">
                      <th className="py-2 pr-3">Patient Name</th>
                      <th className="py-2 pr-3">Alert Severity</th>
                      <th className="py-2 pr-3">Reason for Calling</th>
                      <th className="py-2 pr-3">Relevant Reading</th>
                      <th className="py-2 pr-3">Caregiver Contacted</th>
                      <th className="py-2 pr-3">Priority</th>
                      <th className="py-2 pr-3">Call Status</th>
                      <th className="py-2 pr-3">Language</th>
                      <th className="py-2 pr-3">Caregiver Response</th>
                      <th className="py-2 pr-3">Timestamp</th>
                      <th className="py-2 pr-3">Duration</th>
                      <th className="py-2 pr-3">Retry Count</th>
                      <th className="py-2 pr-3">Escalation Status</th>
                      <th className="py-2 pr-3">Follow-Up Action</th>
                      <th className="py-2">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EEF2F2]">
                    {history.map((item) => (
                      <tr key={item.callId} className="align-top hover:bg-[#F7F9F9] transition-colors">
                        <td className="py-2.5 pr-3 font-medium text-[#202525] whitespace-nowrap">
                          {item.patientName}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-medium ${
                              item.alertSeverity === "High"
                                ? "bg-red-50 text-red-800 border-red-300"
                                : item.alertSeverity === "Medium"
                                  ? "bg-amber-50 text-amber-800 border-amber-300"
                                  : "bg-[#00B800]/12 text-[#008F00] border-[#00B800]/30"
                            }`}
                          >
                            {item.alertSeverity}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-[#202525] min-w-[180px] max-w-[240px]">
                          {item.reasonForCalling}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-[#008F00] font-medium whitespace-nowrap">
                          {item.relevantReading}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">
                          <div className="font-medium text-[#202525]">{item.caregiverName}</div>
                          <div className="font-mono text-[11px] text-[#737B7B]">
                            {item.maskedPhone}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 capitalize text-[#737B7B] whitespace-nowrap">
                          {item.caregiverPriority}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded border font-mono text-[11px] ${statusBadgeClass(
                              item.callStatus
                            )}`}
                          >
                            {item.callStatus}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-[#202525] whitespace-nowrap">
                          {LANGUAGE_LABELS[item.selectedLanguage]}
                        </td>
                        <td className="py-2.5 pr-3 font-medium text-[#202525] whitespace-nowrap">
                          {item.caregiverResponse}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-[#737B7B] whitespace-nowrap">
                          {formatTimestamp(item.startedAt)}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-[#202525] whitespace-nowrap">
                          {formatDuration(item.durationSec)}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-[#202525]">
                          {item.retryCount}
                        </td>
                        <td className="py-2.5 pr-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded border font-mono text-[11px] ${statusBadgeClass(
                              item.escalationStatus
                            )}`}
                          >
                            {item.escalationStatus}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-[#737B7B] min-w-[180px] max-w-[260px]">
                          {item.followUpAction}
                        </td>
                        <td className="py-2.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setSelectedCallDetail(item)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                          >
                            <Eye className="w-3 h-3 text-[#00B800]" />
                            View Alert Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* View Alert Details Modal */}
      {selectedCallDetail && (
        <div
          className="fixed inset-0 z-50 bg-[#080B0B]/60 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Alert and Call Details"
        >
          <div className="bg-white border border-[#D9E0E0] rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between gap-2 bg-[#080B0B] text-white px-5 py-4 border-b border-[#1E2525] sticky top-0 z-10">
              <div>
                <h4 className="text-base font-semibold text-white">
                  Alert &amp; Outbound Call Details
                </h4>
                <p className="text-xs font-mono text-[#A3ACAC]">
                  Call ID: {selectedCallDetail.callId}
                  {selectedCallDetail.callSid ? ` · Twilio SID: ${selectedCallDetail.callSid}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCallDetail(null)}
                className="p-1.5 rounded-lg border border-[#283232] bg-[#141A1A] text-[#D9E0E0] hover:text-white hover:border-[#00B800] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
                  <div className="text-[#737B7B]">Patient &amp; Trigger</div>
                  <div className="font-semibold text-[#202525]">
                    {selectedCallDetail.patientName} ({selectedCallDetail.alertSeverity})
                  </div>
                  <div className="font-mono text-[#008F00] font-medium">
                    {selectedCallDetail.relevantReading}
                  </div>
                  <p className="text-[#202525]">{selectedCallDetail.reasonForCalling}</p>
                </div>

                <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-1">
                  <div className="text-[#737B7B]">Caregiver &amp; Call Outcome</div>
                  <div className="font-semibold text-[#202525]">
                    {selectedCallDetail.caregiverName} ({selectedCallDetail.caregiverPriority})
                  </div>
                  <div className="font-mono text-[#737B7B]">{selectedCallDetail.maskedPhone}</div>
                  <div className="text-[#202525]">
                    Status: <strong className="text-[#202525]">{selectedCallDetail.callStatus}</strong> · Language:{" "}
                    <strong className="text-[#202525]">{LANGUAGE_LABELS[selectedCallDetail.selectedLanguage]}</strong> ·
                    Duration: <strong className="text-[#202525]">{formatDuration(selectedCallDetail.durationSec)}</strong>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl border border-[#D9E0E0] bg-[#F7F9F9] text-xs space-y-1">
                <div className="font-semibold text-[#202525]">
                  Structured Response: {selectedCallDetail.caregiverResponse}
                </div>
                {selectedCallDetail.responseSummary && (
                  <p className="text-[#737B7B]">{selectedCallDetail.responseSummary}</p>
                )}
                <p className="text-[#202525]">
                  <strong className="text-[#202525]">Follow-up Action:</strong> {selectedCallDetail.followUpAction}
                </p>
                {selectedCallDetail.errorMessage && (
                  <p className="text-red-700 font-medium">
                    Provider Error: {selectedCallDetail.errorMessage}
                  </p>
                )}
              </div>

              {detailEscalation && (
                <div className="p-3 rounded-xl border border-[#D9E0E0] bg-[#F7F9F9] text-xs space-y-1">
                  <div className="font-semibold text-[#202525]">
                    Linked Escalation ({detailEscalation.escalationId})
                  </div>
                  <div className="text-[#737B7B]">
                    Workflow State: <span className="font-mono text-[#008F00] font-medium">{detailEscalation.escalationStatus}</span>{" "}
                    · Emergency Active: <strong className="text-[#202525]">{detailEscalation.emergencyActive ? "Yes" : "No"}</strong>
                  </div>
                </div>
              )}

              <div className="space-y-2 text-xs">
                <div className="font-semibold text-[#202525]">Audit Trail</div>
                {detailAudits.length === 0 ? (
                  <p className="text-[#737B7B]">No matching audit entries recorded.</p>
                ) : (
                  <div className="divide-y divide-[#EEF2F2] border border-[#D9E0E0] rounded-xl bg-[#F7F9F9]">
                    {detailAudits.map((a) => (
                      <div key={a.auditId} className="p-2.5 flex items-start justify-between gap-2">
                        <div>
                          <span className="font-mono text-[11px] text-[#008F00] font-medium">
                            {a.eventType}
                          </span>
                          <p className="text-[#202525] mt-0.5">{a.summary}</p>
                        </div>
                        <span className="font-mono text-[11px] text-[#737B7B] shrink-0">
                          {formatTimestamp(a.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
