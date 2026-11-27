import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle2, KeyRound, Lock, Mail, ShieldCheck, UserPlus, X } from "lucide-react";
import { useSmartCare } from "../context/SmartCareContext.tsx";

export type AuthModalInitialTab = "login" | "register_patient" | "register_caregiver" | "reset";

export function AuthModal({
  open,
  initialTab = "login",
  onClose,
  onSuccessRedirect,
}: {
  open: boolean;
  initialTab?: AuthModalInitialTab;
  onClose: () => void;
  onSuccessRedirect?: (role: "patient" | "caregiver" | "admin") => void;
}) {
  const {
    signInWithEmail,
    registerWithEmail,
    signInWithGoogle,
    sendPasswordReset,
    authLoading,
    authError,
    clearAuthError,
  } = useSmartCare();

  const [tab, setTab] = useState<AuthModalInitialTab>(initialTab);
  const [name, setName] = useState("");
  const [ageGroup, setAgeGroup] = useState("Adult · Personalized Baseline");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localMsg, setLocalMsg] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const switchTab = (next: AuthModalInitialTab) => {
    setTab(next);
    setLocalMsg(null);
    setLocalErr(null);
    clearAuthError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalMsg(null);
    setLocalErr(null);
    clearAuthError();

    try {
      if (tab === "reset") {
        if (!email.trim()) {
          setLocalErr("Enter the email address associated with your AROVA account.");
          return;
        }
        await sendPasswordReset(email);
        setLocalMsg("Password reset instructions have been sent to your email.");
        return;
      }

      if (tab === "login") {
        const assigned = await signInWithEmail(email, password);
        onSuccessRedirect?.(assigned);
        onClose();
        return;
      }

      const role = tab === "register_caregiver" ? "caregiver" : "patient";
      const assigned = await registerWithEmail({
        name,
        email,
        password,
        role,
        ageGroup: role === "patient" ? ageGroup : undefined,
      });
      onSuccessRedirect?.(assigned);
      onClose();
    } catch (err) {
      setLocalErr(err instanceof Error ? err.message : "Authentication failed.");
    }
  };

  const handleGoogle = async () => {
    setLocalMsg(null);
    setLocalErr(null);
    clearAuthError();
    try {
      await signInWithGoogle();
      onClose();
    } catch (err) {
      setLocalErr(err instanceof Error ? err.message : "Google sign-in failed.");
    }
  };

  const displayedError = localErr || authError;

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="arova-auth-title"
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
            className="relative z-10 w-full max-w-md bg-white border border-[#D9E0E0] rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Dark Black Modal Header */}
            <div className="px-6 py-4 bg-[#080B0B] text-white border-b border-[#1E2525] flex items-center justify-between gap-3">
              <div>
                <h2 id="arova-auth-title" className="text-base font-semibold text-white">
                  AROVA Account Access
                </h2>
                <p className="text-xs text-[#00B800] mt-0.5">
                  Wearable-Based Early Warning System · Firebase Auth
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg text-[#A3ACAC] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                aria-label="Close authentication modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Mode Tabs */}
            <div className="px-6 pt-4">
              <div className="grid grid-cols-3 gap-1 p-1 bg-[#EEF2F2] border border-[#D9E0E0] rounded-xl text-xs">
                <button
                  type="button"
                  onClick={() => switchTab("login")}
                  className={`py-2 px-2 rounded-lg font-medium transition-all cursor-pointer ${
                    tab === "login" || tab === "reset"
                      ? "bg-[#00B800] text-white font-semibold shadow-xs"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => switchTab("register_patient")}
                  className={`py-2 px-2 rounded-lg font-medium transition-all cursor-pointer ${
                    tab === "register_patient"
                      ? "bg-[#00B800] text-white font-semibold shadow-xs"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  Patient Signup
                </button>
                <button
                  type="button"
                  onClick={() => switchTab("register_caregiver")}
                  className={`py-2 px-2 rounded-lg font-medium transition-all cursor-pointer ${
                    tab === "register_caregiver"
                      ? "bg-[#00B800] text-white font-semibold shadow-xs"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  Caregiver Signup
                </button>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
              {displayedError && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-300 text-red-900">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                  <span className="leading-relaxed">{displayedError}</span>
                </div>
              )}

              {localMsg && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-[#00B800]/10 border border-[#00B800]/35 text-[#008F00]">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#00B800]" />
                  <span className="leading-relaxed">{localMsg}</span>
                </div>
              )}

              {(tab === "register_patient" || tab === "register_caregiver") && (
                <>
                  <label className="block space-y-1">
                    <span className="font-medium text-[#202525]">Full Name</span>
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={tab === "register_caregiver" ? "e.g., Priya Nair" : "e.g., Aarav Sharma"}
                      className="w-full px-3 py-2.5 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800] transition-colors"
                    />
                  </label>

                  {tab === "register_patient" && (
                    <label className="block space-y-1">
                      <span className="font-medium text-[#202525]">Monitoring Profile Group</span>
                      <select
                        value={ageGroup}
                        onChange={(e) => setAgeGroup(e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#D9E0E0] rounded-xl bg-white text-[#202525] focus:outline-none focus:border-[#00B800] transition-colors"
                      >
                        <option value="Adult · Personalized Baseline">Adult · Personalized Baseline</option>
                        <option value="Senior (65+) · Home Care">Senior (65+) · Home Care</option>
                        <option value="Post-Recovery Monitoring">Post-Recovery Monitoring</option>
                        <option value="Cardiac & SpO2 Wellness">Cardiac &amp; SpO2 Wellness</option>
                      </select>
                    </label>
                  )}
                </>
              )}

              <label className="block space-y-1">
                <span className="font-medium text-[#202525] flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-[#00B800]" />
                  Email Address
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-3 py-2.5 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800] transition-colors"
                />
              </label>

              {tab !== "reset" && (
                <label className="block space-y-1">
                  <span className="font-medium text-[#202525] flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-[#00B800]" />
                    Password
                  </span>
                  <input
                    type="password"
                    required
                    minLength={6}
                    autoComplete={tab === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                    className="w-full px-3 py-2.5 bg-white border border-[#D9E0E0] rounded-xl text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800] transition-colors"
                  />
                </label>
              )}

              {tab === "login" && (
                <div className="flex items-center justify-between text-[11px] text-[#737B7B]">
                  <span>Patients, Caregivers &amp; verified Admins sign in here</span>
                  <button
                    type="button"
                    onClick={() => switchTab("reset")}
                    className="font-semibold text-[#008F00] hover:underline cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {tab === "register_caregiver" && (
                <div className="p-2.5 rounded-xl bg-[#EEF2F2] border border-[#D9E0E0] text-[11px] text-[#202525] flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#00B800] shrink-0 mt-0.5" />
                  <span>
                    Caregiver accounts can only access patients explicitly linked to their Caregiver UID.
                    Administrator roles cannot be self-assigned.
                  </span>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="arova-cta-primary w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 cursor-pointer"
              >
                {tab === "reset" ? (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    {authLoading ? "Sending..." : "Send Password Reset Email"}
                  </>
                ) : tab === "login" ? (
                  <>
                    <Lock className="w-3.5 h-3.5" />
                    {authLoading ? "Signing In..." : "Sign In to AROVA"}
                  </>
                ) : (
                  <>
                    <UserPlus className="w-3.5 h-3.5" />
                    {authLoading
                      ? "Creating Account..."
                      : tab === "register_caregiver"
                      ? "Register as Caregiver"
                      : "Register as Patient"}
                  </>
                )}
              </button>

              {tab === "reset" && (
                <button
                  type="button"
                  onClick={() => switchTab("login")}
                  className="w-full py-2 text-center font-medium text-[#008F00] hover:underline cursor-pointer"
                >
                  Back to Sign In
                </button>
              )}

              {tab !== "reset" && (
                <>
                  <div className="relative py-1 flex items-center">
                    <div className="flex-grow border-t border-[#D9E0E0]" />
                    <span className="mx-3 text-[11px] text-[#737B7B]">or continue with</span>
                    <div className="flex-grow border-t border-[#D9E0E0]" />
                  </div>

                  <button
                    type="button"
                    disabled={authLoading}
                    onClick={() => void handleGoogle()}
                    className="arova-cta-secondary w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] disabled:opacity-50 cursor-pointer"
                  >
                    Sign in with Google
                  </button>
                </>
              )}
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
