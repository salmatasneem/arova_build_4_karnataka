import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CheckCircle2, Copy, MailCheck, RefreshCw, Save, ShieldAlert, UserCog, X } from "lucide-react";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import type { SupportedVoiceLanguage } from "../types/smartcare.ts";

export function ProfileSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    user,
    emailVerified,
    assignedRole,
    activeRole,
    userProfile,
    privateContact,
    selectedPatient,
    updateProfileSettings,
    resendVerificationEmail,
    refreshCurrentUser,
  } = useSmartCare();

  const [displayName, setDisplayName] = useState("");
  const [ageGroup, setAgeGroup] = useState("");
  const [phone, setPhone] = useState("");
  const [emergencyNotes, setEmergencyNotes] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<SupportedVoiceLanguage>("en");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [emergencyAlertsEnabled, setEmergencyAlertsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUid, setCopiedUid] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(userProfile?.displayName || user.displayName || "");
    setAgeGroup(
      userProfile?.profileSettings?.ageGroup ||
        selectedPatient?.ageGroup ||
        "Adult · Personalized Baseline"
    );
    setPhone(privateContact?.phone || "");
    setEmergencyNotes(privateContact?.emergencyNotes || "");
    setPreferredLanguage(userProfile?.profileSettings?.preferredLanguage || "en");
    setNotificationsEnabled(userProfile?.profileSettings?.notificationsEnabled ?? true);
    setEmergencyAlertsEnabled(userProfile?.profileSettings?.emergencyAlertsEnabled ?? true);
    setStatusMsg(null);
    setErrorMsg(null);
  }, [open, user, userProfile, privateContact, selectedPatient]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      await updateProfileSettings({
        displayName,
        ageGroup: assignedRole === "patient" ? ageGroup : undefined,
        phone,
        emergencyNotes,
        preferredLanguage,
        notificationsEnabled,
        emergencyAlertsEnabled,
      });
      setStatusMsg("Profile and monitoring settings saved to Firestore.");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save profile settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleCopyUid = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Ignore clipboard failures cleanly
    }
  };

  const handleResendVerification = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await resendVerificationEmail();
      setStatusMsg("Verification link sent to your email address.");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not send verification email.");
    }
  };

  const handleRefreshVerification = async () => {
    setErrorMsg(null);
    const verified = await refreshCurrentUser();
    setStatusMsg(
      verified
        ? "Email verification confirmed!"
        : "Email still shows unverified. Check your inbox and spam folder."
    );
  };

  return (
    <AnimatePresence>
      {open && user && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="arova-profile-title"
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
            className="relative z-10 w-full max-w-lg bg-white border border-[#D9E0E0] rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
          >
            <div className="px-6 py-4 bg-[#080B0B] text-white border-b border-[#1E2525] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <UserCog className="w-4 h-4 text-[#00B800]" />
                <div>
                  <h2 id="arova-profile-title" className="text-base font-semibold text-white">
                    Account Profile &amp; Preferences
                  </h2>
                  <p className="text-xs text-[#A3ACAC]">
                    Role: <span className="capitalize font-semibold text-[#00B800]">{assignedRole ?? activeRole}</span> ·{" "}
                    {user.email}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg text-[#A3ACAC] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Close profile modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 text-xs overflow-y-auto">
              {/* UID Share Box */}
              <div className="p-3 rounded-xl bg-[#EEF2F2] border border-[#D9E0E0] space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#202525]">Your AROVA User ID (UID)</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyUid()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-[#008F00] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] cursor-pointer"
                  >
                    {copiedUid ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copiedUid ? "Copied" : "Copy UID"}
                  </button>
                </div>
                <div className="font-mono text-[11px] text-[#737B7B] break-all">{user.uid}</div>
                {assignedRole === "caregiver" && (
                  <p className="text-[11px] text-[#737B7B]">
                    Share this Caregiver UID with an Administrator or Patient to authorize access to their monitoring dashboard.
                  </p>
                )}
              </div>

              {/* Email Verification Banner */}
              {!emailVerified && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 space-y-2">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-900">
                    <ShieldAlert className="w-4 h-4 text-amber-600" />
                    Email verification pending
                  </div>
                  <p className="leading-relaxed">
                    Verify your email to enable protected voice escalation APIs and administrator verification.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleResendVerification()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium bg-white border border-amber-300 text-amber-900 rounded-lg hover:bg-amber-100 cursor-pointer"
                    >
                      <MailCheck className="w-3.5 h-3.5" />
                      Resend Verification Email
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRefreshVerification()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh Status
                    </button>
                  </div>
                </div>
              )}

              {errorMsg && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-300 text-red-900">
                  {errorMsg}
                </div>
              )}
              {statusMsg && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-[#00B800]/10 border border-[#00B800]/35 text-[#008F00]">
                  <CheckCircle2 className="w-4 h-4 text-[#00B800] shrink-0" />
                  <span>{statusMsg}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="font-medium text-[#202525]">Display Name</span>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] focus:outline-none focus:border-[#00B800]"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="font-medium text-[#202525]">Voice Alert Language</span>
                  <select
                    value={preferredLanguage}
                    onChange={(e) => setPreferredLanguage(e.target.value as SupportedVoiceLanguage)}
                    className="w-full px-3 py-2 border border-[#D9E0E0] rounded-xl bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
                  >
                    <option value="en">English (en)</option>
                    <option value="hi">Hindi (hi)</option>
                    <option value="kn">Kannada (kn)</option>
                  </select>
                </label>
              </div>

              {assignedRole === "patient" && (
                <label className="block space-y-1">
                  <span className="font-medium text-[#202525]">Patient Monitoring Group</span>
                  <input
                    type="text"
                    value={ageGroup}
                    onChange={(e) => setAgeGroup(e.target.value)}
                    placeholder="e.g., Adult · Personalized Baseline"
                    className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] focus:outline-none focus:border-[#00B800]"
                  />
                </label>
              )}

              <label className="block space-y-1">
                <span className="font-medium text-[#202525]">Private Contact Phone (E.164 optional)</span>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 9876543210"
                  className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-xl font-mono text-[#202525] focus:outline-none focus:border-[#00B800]"
                />
              </label>

              <label className="block space-y-1">
                <span className="font-medium text-[#202525]">Private Emergency &amp; Caregiver Notes</span>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={emergencyNotes}
                  onChange={(e) => setEmergencyNotes(e.target.value)}
                  placeholder="Optional emergency context stored privately under /users/{uid}/private..."
                  className="w-full px-3 py-2 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
                />
              </label>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notificationsEnabled}
                    onChange={(e) => setNotificationsEnabled(e.target.checked)}
                    className="rounded border-[#D9E0E0] accent-[#00B800]"
                  />
                  <span className="text-[#202525] font-medium">Enable dashboard anomaly notifications</span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={emergencyAlertsEnabled}
                    onChange={(e) => setEmergencyAlertsEnabled(e.target.checked)}
                    className="rounded border-[#D9E0E0] accent-[#00B800]"
                  />
                  <span className="text-[#202525] font-medium">
                    Allow Critical-level caregiver escalation workflows
                  </span>
                </label>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-[#D9E0E0]">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving..." : "Save Profile"}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
