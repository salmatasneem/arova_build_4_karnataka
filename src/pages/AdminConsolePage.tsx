import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Brain,
  Clock,
  Cpu,
  Database,
  Link2,
  Mail,
  MessageSquare,
  PhoneCall,
  Save,
  Settings2,
  ShieldCheck,
  Users,
  Video,
} from "lucide-react";
import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import { ArovaVoiceCallingPanel } from "../components/ArovaVoiceCallingPanel.tsx";
import { AlertLevelLabel } from "../components/StatusIndicator.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import { fetchMlConfig, saveMlConfig } from "../services/apiClient.ts";
import type {
  AccountStatus,
  MlDetectionConfig,
  NotificationEscalationConfig,
  UserRole,
} from "../types/smartcare.ts";

export function AdminConsolePage() {
  const {
    patients,
    selectedPatient,
    devices,
    alerts,
    careLinks,
    registeredUsers,
    auditLogs,
    integrations,
    systemSettings,
    isAdminUser,
    firestoreConnected,
    user,
    notificationConfig,
    notificationProviders,
    adminAlertStats,
    fallDetectionStats,
    fallEvents,
    notificationErrorLogs,
    addCareLink,
    updateCareLinkStatus,
    adminUpdateUserAccount,
    adminUpdateDevice,
    updateSystemSettings,
    updateNotificationConfig,
    refreshIntegrations,
    refreshPhase5Notifications,
  } = useSmartCare();

  const [targetPatientId, setTargetPatientId] = useState(selectedPatient.patientId);
  const [relationship, setRelationship] = useState("Family / Caregiver");
  const [userActionMsg, setUserActionMsg] = useState<string | null>(null);
  const [deviceActionMsg, setDeviceActionMsg] = useState<string | null>(null);

  const [caregiverName, setCaregiverName] = useState("");
  const [caregiverUid, setCaregiverUid] = useState("");
  const [priority, setPriority] = useState<"primary" | "secondary">("primary");
  const [linkStatusMsg, setLinkStatusMsg] = useState<string | null>(null);

  const [timeoutSec, setTimeoutSec] = useState(systemSettings.escalationTimeoutSec);
  const [minSamples, setMinSamples] = useState(systemSettings.baselineMinSamples);
  const [samplingMs, setSamplingMs] = useState(systemSettings.samplingDefaultMs);
  const [warnPersistence, setWarnPersistence] = useState(systemSettings.warningPersistenceWindows ?? 2);
  const [critPersistence, setCritPersistence] = useState(systemSettings.criticalPersistenceWindows ?? 3);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [mlConfig, setMlConfig] = useState<MlDetectionConfig | null>(null);
  const [mlConfigMsg, setMlConfigMsg] = useState<string | null>(null);
  const [mlConfigSaving, setMlConfigSaving] = useState(false);

  const [escConfig, setEscConfig] = useState<
    Omit<NotificationEscalationConfig, "updatedAt" | "updatedByUid">
  >({
    patientAckTimeoutSec: notificationConfig?.patientAckTimeoutSec ?? 60,
    duplicateAlertWindowSec: notificationConfig?.duplicateAlertWindowSec ?? 120,
    caregiverEscalationEnabled: notificationConfig?.caregiverEscalationEnabled ?? true,
    escalateOnWarning: notificationConfig?.escalateOnWarning ?? false,
    smsEnabled: notificationConfig?.smsEnabled ?? true,
    emailEnabled: notificationConfig?.emailEnabled ?? true,
    voiceEnabled: notificationConfig?.voiceEnabled ?? true,
  });
  const [escConfigMsg, setEscConfigMsg] = useState<string | null>(null);
  const [escConfigSaving, setEscConfigSaving] = useState(false);

  useEffect(() => {
    void fetchMlConfig()
      .then((res) => setMlConfig(res.config))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!notificationConfig) return;
    setEscConfig({
      patientAckTimeoutSec: notificationConfig.patientAckTimeoutSec,
      duplicateAlertWindowSec: notificationConfig.duplicateAlertWindowSec,
      caregiverEscalationEnabled: notificationConfig.caregiverEscalationEnabled,
      escalateOnWarning: notificationConfig.escalateOnWarning,
      smsEnabled: notificationConfig.smsEnabled,
      emailEnabled: notificationConfig.emailEnabled,
      voiceEnabled: notificationConfig.voiceEnabled,
    });
  }, [notificationConfig]);

  useEffect(() => {
    setTimeoutSec(systemSettings.escalationTimeoutSec);
    setMinSamples(systemSettings.baselineMinSamples);
    setSamplingMs(systemSettings.samplingDefaultMs);
    setWarnPersistence(systemSettings.warningPersistenceWindows ?? 2);
    setCritPersistence(systemSettings.criticalPersistenceWindows ?? 3);
  }, [
    systemSettings.escalationTimeoutSec,
    systemSettings.baselineMinSamples,
    systemSettings.samplingDefaultMs,
    systemSettings.warningPersistenceWindows,
    systemSettings.criticalPersistenceWindows,
  ]);

  useEffect(() => {
    if (selectedPatient?.patientId && selectedPatient.patientId !== "unassigned_patient") {
      setTargetPatientId(selectedPatient.patientId);
    }
  }, [selectedPatient?.patientId]);

  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caregiverName.trim() || !caregiverUid.trim()) return;
    setLinkStatusMsg(null);
    try {
      await addCareLink({
        patientId: targetPatientId,
        caregiverName,
        caregiverUid,
        priority,
        relationship,
      });
      setCaregiverName("");
      setCaregiverUid("");
      setLinkStatusMsg("Caregiver relationship saved and synced.");
    } catch (err) {
      setLinkStatusMsg(err instanceof Error ? err.message : "Could not create caregiver link.");
    }
  };

  const handleUserRoleOrStatus = async (
    targetUid: string,
    patch: { role?: UserRole; accountStatus?: AccountStatus }
  ) => {
    setUserActionMsg(null);
    try {
      await adminUpdateUserAccount(targetUid, patch);
      setUserActionMsg(`Updated user ${targetUid.slice(0, 10)}... in Firestore.`);
    } catch (err) {
      setUserActionMsg(err instanceof Error ? err.message : "Could not update user account.");
    }
  };

  const handleDeviceStatusChange = async (
    deviceId: string,
    connectionStatus: "not_connected" | "streaming" | "offline"
  ) => {
    setDeviceActionMsg(null);
    try {
      await adminUpdateDevice(deviceId, { connectionStatus });
      setDeviceActionMsg(`Device ${deviceId} status updated to ${connectionStatus}.`);
    } catch (err) {
      setDeviceActionMsg(err instanceof Error ? err.message : "Could not update device status.");
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsMsg(null);
    try {
      await updateSystemSettings({
        escalationTimeoutSec: timeoutSec,
        baselineMinSamples: minSamples,
        samplingDefaultMs: samplingMs,
        warningPersistenceWindows: warnPersistence,
        criticalPersistenceWindows: critPersistence,
      });
      setSettingsMsg(
        isAdminUser
          ? "Global system settings saved to Firestore."
          : "Updated in local preview state (sign in with verified admin account to persist globally)."
      );
    } catch (err) {
      setSettingsMsg(err instanceof Error ? err.message : "Failed to save settings.");
    }
  };

  const handleSaveMlConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mlConfig) return;
    setMlConfigSaving(true);
    setMlConfigMsg(null);
    try {
      const res = await saveMlConfig(mlConfig);
      setMlConfig(res.config);
      setMlConfigMsg("Global Isolation Forest thresholds updated across Node & Python ML services.");
    } catch (err) {
      setMlConfigMsg(err instanceof Error ? err.message : "Failed to update ML configuration.");
    } finally {
      setMlConfigSaving(false);
    }
  };

  const handleSaveEscalationConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setEscConfigSaving(true);
    setEscConfigMsg(null);
    try {
      await updateNotificationConfig(escConfig);
      setEscConfigMsg("Alert escalation timing and notification channel policy updated.");
    } catch (err) {
      setEscConfigMsg(
        err instanceof Error ? err.message : "Failed to save escalation workflow configuration."
      );
    } finally {
      setEscConfigSaving(false);
    }
  };

  const patientAccountCount = registeredUsers.filter((u) => u.role === "patient").length;
  const caregiverAccountCount = registeredUsers.filter((u) => u.role === "caregiver").length;
  const streamingDevicesCount = devices.filter((d) => d.connectionStatus === "streaming").length;
  const activeAlertCount =
    adminAlertStats?.activeAlerts ?? alerts.filter((a) => a.status === "active").length;
  const ackAlertCount =
    adminAlertStats?.acknowledgedAlerts ?? alerts.filter((a) => a.status === "acknowledged").length;
  const falseAlertCount =
    adminAlertStats?.falseAlerts ?? alerts.filter((a) => a.falseAlertReported).length;
  const criticalAlertCount =
    adminAlertStats?.criticalAlerts ?? alerts.filter((a) => a.level === "Critical").length;

  return (
    <div className="space-y-6">
      {/* Phase 2 & 5 Admin System Statistics */}
      <section className="arova-float-grid grid grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
        <div className="arova-float-card arova-float-delay-1 arova-glass-card rounded-2xl p-4 space-y-1">
          <div className="text-[#737B7B]">Total Accounts</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-[#202525]">
            <AnimatedNumber value={registeredUsers.length} />
          </div>
          <div className="text-[11px] text-[#737B7B]">
            {patientAccountCount} patients · {caregiverAccountCount} caregivers
          </div>
        </div>
        <div className="arova-float-card arova-float-delay-2 arova-glass-card rounded-2xl p-4 space-y-1">
          <div className="text-[#737B7B]">Monitored Profiles</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-[#008F00]">
            <AnimatedNumber value={patients.length} />
          </div>
          <div className="text-[11px] text-[#737B7B]">
            {careLinks.filter((l) => l.status === "active").length} active care link(s)
          </div>
        </div>
        <div className="arova-float-card arova-float-delay-3 arova-glass-card rounded-2xl p-4 space-y-1">
          <div className="text-[#737B7B]">Registered Devices</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-[#00B800]">
            <AnimatedNumber value={devices.length} />
          </div>
          <div className="text-[11px] text-[#737B7B]">{streamingDevicesCount} streaming</div>
        </div>
        <div className="arova-float-card arova-float-delay-4 arova-glass-card rounded-2xl p-4 space-y-1">
          <div className="text-[#737B7B]">Alert Statistics</div>
          <div className="text-2xl font-semibold font-mono tabular-nums text-[#202525]">
            <AnimatedNumber value={adminAlertStats?.totalAlerts ?? alerts.length} />
          </div>
          <div className="text-[11px] text-[#737B7B]">
            {activeAlertCount} active · {ackAlertCount} ack · {falseAlertCount} false ·{" "}
            {criticalAlertCount} crit
          </div>
        </div>
        <div className="arova-float-card arova-float-delay-5 arova-glass-card rounded-2xl p-4 space-y-1 col-span-2 lg:col-span-1">
          <div className="text-[#737B7B] flex items-center gap-1">
            <Database className="w-3.5 h-3.5 text-[#00B800]" />
            Firebase Auth &amp; DB
          </div>
          <div
            className={`text-sm font-semibold ${
              firestoreConnected && integrations?.firebase?.configured
                ? "text-[#008F00]"
                : "text-amber-700"
            }`}
          >
            {firestoreConnected && integrations?.firebase?.configured ? "Connected" : "Checking"}
          </div>
          <div className="font-mono text-[11px] text-[#737B7B] truncate">
            {integrations?.firebase?.projectId || "glossy-pod-wvrbg"}
          </div>
        </div>
      </section>

      {/* Architecture Integration Health */}
      <section className="arova-float-card-subtle arova-float-delay-1 arova-glass-card rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#202525]">
              System Integration &amp; Service Posture
            </h2>
            <p className="text-xs text-[#737B7B] mt-0.5">
              Live backend readiness reported from server environment configuration
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshIntegrations()}
            className="px-3 py-1.5 text-xs font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] transition-colors cursor-pointer"
          >
            Re-check Services
          </button>
        </div>

        <div className="arova-float-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div className="arova-float-card arova-float-delay-1 p-3.5 bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl space-y-1">
            <div className="text-[#737B7B]">Gemini AI Assistant</div>
            <div className="text-sm font-semibold text-[#202525]">
              {integrations?.gemini.configured ? "Connected (Server-Side)" : "API Key Pending"}
            </div>
            <div className="font-mono text-[#008F00]">
              {integrations?.gemini.model || "gemini-4-hydrogen"}
            </div>
          </div>

          <div className="arova-float-card arova-float-delay-2 p-3.5 bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl space-y-1">
            <div className="text-[#737B7B]">Python Isolation Forest</div>
            <div className="text-sm font-semibold text-[#202525]">
              {integrations?.mlService.reachable ? "Connected" : "Demo Mode (Optional)"}
            </div>
            <div className="text-[#737B7B]">
              {integrations?.mlService.reachable
                ? "FastAPI scikit-learn active"
                : "ML_SERVICE_URL optional in dev"}
            </div>
          </div>

          <div className="arova-float-card arova-float-delay-3 p-3.5 bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl space-y-1">
            <div className="text-[#737B7B]">ESP32 Ingestion API</div>
            <div className="text-sm font-semibold text-[#202525]">Endpoint Ready</div>
            <div className="font-mono text-[#008F00]">
              {integrations?.wearableIngest.tokenProtected
                ? "X-Device-Key Enforced"
                : "Dev Mode (Token Optional)"}
            </div>
          </div>

          <div className="arova-float-card arova-float-delay-4 p-3.5 bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl space-y-1">
            <div className="text-[#737B7B]">Caregiver Voice Provider</div>
            <div className="text-sm font-semibold text-[#202525]">
              {integrations?.voiceCalling.configured
                ? integrations.voiceCalling.providerName
                : "Not Configured (Optional)"}
            </div>
            <div className="text-[#737B7B]">
              Timeout: {integrations?.voiceCalling.timeoutSec ?? systemSettings.escalationTimeoutSec}
              s {integrations?.voiceCalling.usingDefaultTimeout ? "(Dev Default)" : ""}
            </div>
          </div>
        </div>
      </section>

      {/* Arova AI – Emergency Voice Calling */}
      <ArovaVoiceCallingPanel />

      {/* Users & Caregiver Links + Global Settings */}
      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-[#00B800]" />
            <h3 className="text-base font-semibold text-[#202525]">
              Caregiver–Patient Relationships
            </h3>
          </div>

          <form onSubmit={handleAddLink} className="space-y-2.5 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <select
                value={targetPatientId}
                onChange={(e) => setTargetPatientId(e.target.value)}
                aria-label="Target patient for caregiver link"
                className="px-3 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                {patients.length === 0 ? (
                  <option value="">No registered patients yet</option>
                ) : (
                  patients.map((pt) => (
                    <option key={pt.patientId} value={pt.patientId}>
                      Patient: {pt.displayName}
                    </option>
                  ))
                )}
              </select>
              <input
                type="text"
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
                placeholder="Relationship (e.g., Daughter, Nurse)"
                className="px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <input
                type="text"
                value={caregiverName}
                onChange={(e) => setCaregiverName(e.target.value)}
                placeholder="Caregiver Name"
                className="px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
              <input
                type="text"
                value={caregiverUid}
                onChange={(e) => setCaregiverUid(e.target.value)}
                placeholder="Caregiver UID"
                className="px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
              <div className="flex gap-2">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as "primary" | "secondary")}
                  className="flex-1 px-2 py-2 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                >
                  <option value="primary">Primary</option>
                  <option value="secondary">Secondary</option>
                </select>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 px-3 py-2 font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Link
                </button>
              </div>
            </div>
          </form>
          {linkStatusMsg && <p className="text-xs text-[#008F00] font-medium">{linkStatusMsg}</p>}

          <div className="divide-y divide-[#EEF2F2] border border-[#D9E0E0] bg-[#F7F9F9] rounded-xl">
            {careLinks.length === 0 ? (
              <div className="px-3.5 py-4 text-xs text-[#737B7B]">
                No caregiver-patient links recorded yet.
              </div>
            ) : (
              careLinks.map((link) => (
                <div
                  key={link.linkId}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-semibold text-[#202525]">{link.caregiverName}</span>
                    <span className="mx-1.5 text-[#737B7B]">→</span>
                    <span className="text-[#202525]">{link.patientName}</span>
                    {link.relationship && (
                      <span className="ml-1.5 text-[#737B7B]">({link.relationship})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[#737B7B]">
                      {link.priority} · {link.status}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void updateCareLinkStatus(
                          link.linkId,
                          link.status === "active" ? "revoked" : "active"
                        )
                      }
                      className="px-2 py-1 text-[11px] font-medium bg-white border border-[#D9E0E0] text-[#008F00] rounded-md hover:border-[#00B800] transition-colors cursor-pointer"
                    >
                      {link.status === "active" ? "Revoke" : "Activate"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="pt-2 text-xs text-[#737B7B]">
            Active patient roster: {patients.length} profile(s) · Active target:{" "}
            {selectedPatient.displayName}
          </div>
        </section>

        <form
          onSubmit={handleSaveSettings}
          className="arova-float-card-subtle arova-float-delay-4 arova-glass-card rounded-2xl p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-[#00B800]" />
            <h3 className="text-base font-semibold text-[#202525]">Application Monitoring Settings</h3>
          </div>

          <div className="space-y-3 text-xs">
            <label className="block space-y-1">
              <span className="text-[#737B7B] font-medium">
                Caregiver Escalation Timeout (seconds)
              </span>
              <input
                type="number"
                min={10}
                max={600}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[#737B7B] font-medium">
                Minimum Baseline Samples for Isolation Forest
              </span>
              <input
                type="number"
                min={5}
                max={5000}
                value={minSamples}
                onChange={(e) => setMinSamples(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[#737B7B] font-medium">
                Default ESP32 Sampling Cadence (ms)
              </span>
              <input
                type="number"
                min={500}
                max={60000}
                value={samplingMs}
                onChange={(e) => setSamplingMs(Number(e.target.value))}
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[#737B7B] font-medium">Warning Persistence (Windows)</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={warnPersistence}
                  onChange={(e) => setWarnPersistence(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[#737B7B] font-medium">Critical Persistence (Windows)</span>
                <input
                  type="number"
                  min={1}
                  max={15}
                  value={critPersistence}
                  onChange={(e) => setCritPersistence(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] focus:outline-none focus:border-[#00B800]"
                />
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#737B7B]">
              {user
                ? isAdminUser
                  ? "Verified Admin Account"
                  : "Standard User (Preview Settings)"
                : "Sign in as Admin to persist globally"}
            </span>
            <button
              type="submit"
              className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              Save Settings
            </button>
          </div>
          {settingsMsg && <p className="text-xs text-[#008F00] font-medium">{settingsMsg}</p>}
        </form>
      </div>

      {/* Phase 4: AI/ML Isolation Forest Configuration */}
      {mlConfig && (
        <form
          onSubmit={handleSaveMlConfig}
          className="arova-float-card-subtle arova-float-delay-2 arova-glass-card rounded-2xl p-5 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-[#00B800]" />
              <div>
                <h3 className="text-base font-semibold text-[#202525]">
                  AI/ML Isolation Forest Detection Configuration
                </h3>
                <p className="text-xs text-[#737B7B]">
                  Controls anomaly contamination, ensemble tree depth, incremental retraining
                  cadence, and personalized deviation thresholds
                </p>
              </div>
            </div>
            <span className="font-mono text-xs text-[#008F00]">
              {integrations?.mlService.reachable ? "Python FastAPI Linked" : "Demo Mode Fallback"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Contamination</span>
              <input
                type="number"
                step="0.01"
                min={0.01}
                max={0.25}
                disabled={!isAdminUser}
                value={mlConfig.contamination}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, contamination: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Estimators</span>
              <input
                type="number"
                min={20}
                max={400}
                disabled={!isAdminUser}
                value={mlConfig.nEstimators}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, nEstimators: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Retrain Interval</span>
              <input
                type="number"
                min={1}
                max={100}
                disabled={!isAdminUser}
                value={mlConfig.retrainInterval}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, retrainInterval: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Warn Score Max</span>
              <input
                type="number"
                step="0.01"
                min={-0.5}
                max={0.2}
                disabled={!isAdminUser}
                value={mlConfig.anomalyScoreWarning}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, anomalyScoreWarning: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Crit Score Max</span>
              <input
                type="number"
                step="0.01"
                min={-0.6}
                max={0.1}
                disabled={!isAdminUser}
                value={mlConfig.anomalyScoreCritical}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, anomalyScoreCritical: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Warn Z-Score</span>
              <input
                type="number"
                step="0.1"
                min={1}
                max={6}
                disabled={!isAdminUser}
                value={mlConfig.zScoreWarning}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, zScoreWarning: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Crit Z-Score</span>
              <input
                type="number"
                step="0.1"
                min={1.5}
                max={8}
                disabled={!isAdminUser}
                value={mlConfig.zScoreCritical}
                onChange={(e) =>
                  setMlConfig((prev) =>
                    prev ? { ...prev, zScoreCritical: Number(e.target.value) } : prev
                  )
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-[#737B7B]">
              {mlConfigMsg ||
                (isAdminUser
                  ? "Verified Admin Account can update live ML parameters."
                  : "Sign in as Admin to modify global ML detection parameters.")}
            </span>
            {isAdminUser && (
              <button
                type="submit"
                disabled={mlConfigSaving}
                className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                {mlConfigSaving ? "Applying..." : "Save ML Configuration"}
              </button>
            )}
          </div>
        </form>
      )}

      {/* Phase 5: Notification Channels, Escalation Timing & Delivery Error Logs */}
      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#00B800]" />
              <h3 className="text-base font-semibold text-[#202525]">
                External Notification Channels &amp; Simulation Mode
              </h3>
            </div>
            <button
              type="button"
              onClick={() => void refreshPhase5Notifications()}
              className="px-2.5 py-1 text-[11px] font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800] transition-colors cursor-pointer"
            >
              Refresh Status
            </button>
          </div>

          <div className="space-y-2.5 text-xs">
            {[
              {
                key: "sms",
                label: "SMS Dispatch",
                icon: <MessageSquare className="w-3.5 h-3.5 text-[#00B800]" />,
                data: notificationProviders?.sms ?? integrations?.notifications?.sms,
              },
              {
                key: "email",
                label: "Email Dispatch",
                icon: <Mail className="w-3.5 h-3.5 text-[#00B800]" />,
                data: notificationProviders?.email ?? integrations?.notifications?.email,
              },
              {
                key: "voice",
                label: "Voice Call Dispatch",
                icon: <PhoneCall className="w-3.5 h-3.5 text-[#00B800]" />,
                data: notificationProviders?.voice ?? integrations?.notifications?.voice,
              },
            ].map((ch) => (
              <div
                key={ch.key}
                className="p-3 rounded-xl border border-[#D9E0E0] bg-[#F7F9F9] space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-semibold text-[#202525]">
                    {ch.icon}
                    <span>{ch.label}</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                      ch.data?.configured
                        ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                        : "bg-amber-50 border-amber-300 text-amber-800"
                    }`}
                  >
                    {ch.data?.configured ? `Live · ${ch.data.providerName}` : "Simulation Mode"}
                  </span>
                </div>
                <p className="text-[11px] text-[#737B7B] leading-relaxed">
                  {ch.data?.setupSummary ||
                    "Running in simulation mode until backend server environment credentials are configured."}
                </p>
              </div>
            ))}
          </div>

          <div className="text-[11px] text-[#737B7B] bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-3 leading-relaxed">
            <span className="font-semibold text-[#202525]">Emergency Calling Guardrail:</span>{" "}
            {notificationProviders?.emergencyServicesGuardrail ||
              "AROVA blocks automated notifications or voice calls to emergency services (911, 112, 999, 108, etc.) and labels all simulated deliveries explicitly."}
          </div>
        </section>

        <form
          onSubmit={handleSaveEscalationConfig}
          className="arova-float-card-subtle arova-float-delay-4 arova-glass-card rounded-2xl p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#00B800]" />
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                Alert Escalation Workflow &amp; Duplicate Suppression
              </h3>
              <p className="text-xs text-[#737B7B]">
                Configures patient acknowledgement wait window before caregiver escalation
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] font-medium block">
                Patient Ack Wait Timeout (sec)
              </span>
              <input
                type="number"
                min={1}
                max={3600}
                disabled={!isAdminUser}
                value={escConfig.patientAckTimeoutSec}
                onChange={(e) =>
                  setEscConfig((prev) => ({
                    ...prev,
                    patientAckTimeoutSec: Number(e.target.value),
                  }))
                }
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] font-medium block">
                Duplicate Suppression Window (sec)
              </span>
              <input
                type="number"
                min={0}
                max={3600}
                disabled={!isAdminUser}
                value={escConfig.duplicateAlertWindowSec}
                onChange={(e) =>
                  setEscConfig((prev) => ({
                    ...prev,
                    duplicateAlertWindowSec: Number(e.target.value),
                  }))
                }
                className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525] disabled:bg-[#EEF2F2] disabled:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
            {[
              { key: "caregiverEscalationEnabled", label: "Auto-Escalate Critical" },
              { key: "escalateOnWarning", label: "Notify Caregiver on Warning" },
              { key: "smsEnabled", label: "SMS Channel" },
              { key: "emailEnabled", label: "Email Channel" },
              { key: "voiceEnabled", label: "Voice Channel" },
            ].map((toggle) => (
              <label
                key={toggle.key}
                className="flex items-center gap-2 p-2 rounded-lg border border-[#D9E0E0] bg-[#F7F9F9] cursor-pointer"
              >
                <input
                  type="checkbox"
                  disabled={!isAdminUser}
                  checked={Boolean(escConfig[toggle.key as keyof typeof escConfig])}
                  onChange={(e) =>
                    setEscConfig((prev) => ({
                      ...prev,
                      [toggle.key]: e.target.checked,
                    }))
                  }
                  className="accent-[#00B800]"
                />
                <span className="text-[#202525]">{toggle.label}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[#737B7B]">
              {escConfigMsg ||
                (isAdminUser
                  ? `Suppressed duplicates tracked: ${adminAlertStats?.suppressedDuplicates ?? 0}`
                  : "Sign in as Admin to modify escalation timing")}
            </span>
            {isAdminUser && (
              <button
                type="submit"
                disabled={escConfigSaving}
                className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                {escConfigSaving ? "Saving..." : "Save Escalation Policy"}
              </button>
            )}
          </div>

          <div className="pt-3 border-t border-[#D9E0E0] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#202525] flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                Notification &amp; Escalation Error Logs
              </span>
              <span className="font-mono text-[#737B7B]">
                {notificationErrorLogs.length} failure(s)
              </span>
            </div>
            {notificationErrorLogs.length === 0 ? (
              <p className="text-[11px] text-[#737B7B]">
                No notification delivery failures recorded.
              </p>
            ) : (
              <div className="max-h-32 overflow-y-auto divide-y divide-[#EEF2F2] border border-[#D9E0E0] bg-[#F7F9F9] rounded-lg px-3 py-1 text-[11px]">
                {notificationErrorLogs.slice(0, 10).map((errLog) => (
                  <div key={errLog.errorId} className="py-1.5 space-y-0.5">
                    <div className="flex items-center justify-between font-mono text-red-700">
                      <span>
                        {errLog.channel} · {errLog.provider}
                      </span>
                      <span>{new Date(errLog.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-[#737B7B]">{errLog.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>
      </div>

      {/* Wearable Devices & System Alert History */}
      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#00B800]" />
              <h3 className="text-base font-semibold text-[#202525]">Wearable Device Fleet</h3>
            </div>
            {deviceActionMsg && (
              <span className="text-[11px] text-[#008F00] font-medium">{deviceActionMsg}</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#D9E0E0] text-[#737B7B]">
                  <th className="py-2 pr-3">Device ID</th>
                  <th className="py-2 pr-3">Pulse Ox</th>
                  <th className="py-2 pr-3">Cadence</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F2]">
                {devices.map((d) => (
                  <tr key={d.deviceId} className="hover:bg-[#F7F9F9] transition-colors">
                    <td className="py-2.5 pr-3 font-mono text-[#202525]">{d.deviceId}</td>
                    <td className="py-2.5 pr-3 text-[#737B7B]">{d.pulseOxChipVariant}</td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums text-[#737B7B]">
                      {d.samplingIntervalMs}ms
                    </td>
                    <td className="py-2.5">
                      <select
                        aria-label={`Status for device ${d.deviceId}`}
                        value={d.connectionStatus}
                        onChange={(e) =>
                          void handleDeviceStatusChange(
                            d.deviceId,
                            e.target.value as "not_connected" | "streaming" | "offline"
                          )
                        }
                        className="px-2 py-1 border border-[#D9E0E0] rounded-md bg-white font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                      >
                        <option value="not_connected">not_connected</option>
                        <option value="streaming">streaming</option>
                        <option value="offline">offline</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="arova-float-card-subtle arova-float-delay-5 arova-glass-card rounded-2xl p-5 space-y-3">
          <h3 className="text-base font-semibold text-[#202525]">System Alert Audit Log</h3>
          <div className="divide-y divide-[#EEF2F2]">
            {alerts.length === 0 ? (
              <p className="py-4 text-xs text-[#737B7B]">No alerts logged yet.</p>
            ) : (
              alerts.slice(0, 5).map((a) => (
                <div
                  key={a.alertId}
                  className="py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <AlertLevelLabel level={a.level} />
                      <span className="font-medium text-[#202525]">{a.title}</span>
                    </div>
                    <div className="text-[#737B7B]">
                      Status: {a.status} · Escalation: {a.callEscalationStatus}
                    </div>
                  </div>
                  <span className="font-mono text-[#008F00] shrink-0">{a.source}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Camera Fall Detection Oversight & Reliability */}
      <section className="arova-float-card-subtle arova-float-delay-5 arova-glass-card rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-[#00B800]" />
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                Camera Fall Detection Oversight &amp; Reliability
              </h3>
              <p className="text-xs text-[#737B7B]">
                Live webcam connection posture, fall alert counts, sensor disagreements, and camera permission logs
              </p>
            </div>
          </div>
          <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-[#F7F9F9] border border-[#D9E0E0] text-[#008F00]">
            Camera Status: {fallDetectionStats?.latestCameraStatus ?? "standby"}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">Total Fall Events</div>
            <div className="text-xl font-semibold font-mono text-[#202525]">
              {fallDetectionStats?.totalFallEvents ?? fallEvents.length}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">Active / Escalated</div>
            <div className="text-xl font-semibold font-mono text-red-700">
              {fallDetectionStats?.activeFallEvents ??
                fallEvents.filter(
                  (e) => e.status === "pending_confirmation" || e.status === "escalated"
                ).length}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">Cancelled Safe</div>
            <div className="text-xl font-semibold font-mono text-[#008F00]">
              {fallDetectionStats?.cancelledSafeCount ??
                fallEvents.filter((e) => e.status === "cancelled_safe").length}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">False Fall Alerts</div>
            <div className="text-xl font-semibold font-mono text-amber-700">
              {fallDetectionStats?.falseFallAlerts ??
                fallEvents.filter((e) => e.status === "false_alert").length}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">Sensor Disagreements</div>
            <div className="text-xl font-semibold font-mono text-[#202525]">
              {fallDetectionStats?.sensorDisagreementCount ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
            <div className="text-[#737B7B]">Camera Error Logs</div>
            <div className="text-xl font-semibold font-mono text-[#202525]">
              {fallDetectionStats?.cameraErrorsCount ?? 0}
            </div>
          </div>
        </div>

        {(fallDetectionStats?.recentCameraErrors.length ?? 0) > 0 && (
          <div className="divide-y divide-[#EEF2F2] border border-[#D9E0E0] bg-[#F7F9F9] rounded-xl px-3.5 py-2 text-xs max-h-36 overflow-y-auto">
            {fallDetectionStats!.recentCameraErrors.map((cerr) => (
              <div key={cerr.errorId} className="py-1.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-red-700 font-semibold">{cerr.cameraStatus}</span>
                  <span className="mx-1.5 text-[#737B7B]">·</span>
                  <span className="text-[#202525]">{cerr.message}</span>
                </div>
                <span className="font-mono text-[11px] text-[#737B7B] shrink-0">
                  {new Date(cerr.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Registered Users Roster & RBAC Management */}
      <section className="arova-float-card-subtle arova-float-delay-6 arova-glass-card rounded-2xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#00B800]" />
            <h3 className="text-base font-semibold text-[#202525]">Registered Accounts &amp; Roles</h3>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {userActionMsg && <span className="text-[#008F00] font-medium">{userActionMsg}</span>}
            <span className="text-[#737B7B]">{registeredUsers.length} account(s)</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#D9E0E0] text-[#737B7B]">
                <th className="py-2 pr-4">Display Name</th>
                <th className="py-2 pr-4">User ID</th>
                <th className="py-2 pr-4">Assigned Role</th>
                <th className="py-2">Account Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF2F2]">
              {registeredUsers.map((u) => (
                <tr key={u.uid} className="hover:bg-[#F7F9F9] transition-colors">
                  <td className="py-2.5 pr-4 font-medium text-[#202525]">{u.displayName}</td>
                  <td className="py-2.5 pr-4 font-mono text-[#737B7B]">{u.uid}</td>
                  <td className="py-2.5 pr-4">
                    {isAdminUser ? (
                      <select
                        aria-label={`Role for ${u.displayName}`}
                        value={u.role}
                        onChange={(e) =>
                          void handleUserRoleOrStatus(u.uid, { role: e.target.value as UserRole })
                        }
                        className="px-2 py-1 border border-[#D9E0E0] rounded-md bg-white capitalize text-[#202525] focus:outline-none focus:border-[#00B800]"
                      >
                        <option value="patient">patient</option>
                        <option value="caregiver">caregiver</option>
                        <option value="admin">admin</option>
                      </select>
                    ) : (
                      <span className="capitalize text-[#202525]">{u.role}</span>
                    )}
                  </td>
                  <td className="py-2.5">
                    {isAdminUser ? (
                      <select
                        aria-label={`Status for ${u.displayName}`}
                        value={u.accountStatus ?? "active"}
                        onChange={(e) =>
                          void handleUserRoleOrStatus(u.uid, {
                            accountStatus: e.target.value as AccountStatus,
                          })
                        }
                        className="px-2 py-1 border border-[#D9E0E0] rounded-md bg-white capitalize text-[#202525] focus:outline-none focus:border-[#00B800]"
                      >
                        <option value="active">active</option>
                        <option value="suspended">suspended</option>
                      </select>
                    ) : (
                      <span className="capitalize text-[#737B7B]">{u.accountStatus ?? "active"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* System Activity Audit Feed */}
      <section className="arova-float-card-subtle arova-float-delay-6 arova-glass-card rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00B800]" />
            <h3 className="text-base font-semibold text-[#202525]">
              System Activity &amp; RBAC Audit Logs
            </h3>
          </div>
          <span className="text-xs text-[#737B7B]">{auditLogs.length} recent event(s)</span>
        </div>
        {auditLogs.length === 0 ? (
          <p className="text-xs text-[#737B7B] py-3">
            No audit events recorded yet. Authentication, profile, linking, device, and alert updates
            appear here automatically.
          </p>
        ) : (
          <div className="divide-y divide-[#EEF2F2] max-h-64 overflow-y-auto">
            {auditLogs.slice(0, 20).map((log) => (
              <div
                key={log.logId}
                className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-[#00B800]/12 border border-[#00B800]/30 font-mono text-[10px] text-[#008F00]">
                      {log.eventType}
                    </span>
                    <span className="font-medium text-[#202525]">{log.summary}</span>
                  </div>
                  <div className="text-[11px] text-[#737B7B] font-mono">
                    Actor: {log.userId} ({log.actorRole})
                  </div>
                </div>
                <span className="text-[11px] font-mono text-[#737B7B] shrink-0">
                  {new Date(log.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
