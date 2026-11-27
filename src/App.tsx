import { useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  Activity,
  Bell,
  Bot,
  Cpu,
  Database,
  FlaskConical,
  HeartPulse,
  Home,
  Lock,
  LogIn,
  LogOut,
  Menu,
  Shield,
  ShieldAlert,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { ArovaLoadingScreen } from "./components/ArovaLoadingAndEmptyStates.tsx";
import { ArovaBrandLockup } from "./components/ArovaLogo.tsx";
import { AuthModal, type AuthModalInitialTab } from "./components/AuthModal.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { FallEmergencyAlertModal } from "./components/FallEmergencyAlertModal.tsx";
import { LandingPage } from "./components/LandingPage.tsx";
import { ProfileSettingsModal } from "./components/ProfileSettingsModal.tsx";
import { SmartCareProvider, useSmartCare } from "./context/SmartCareContext.tsx";
import { AdminConsolePage } from "./pages/AdminConsolePage.tsx";
import { AiAssistantPage } from "./pages/AiAssistantPage.tsx";
import { CaregiverDashboardPage } from "./pages/CaregiverDashboardPage.tsx";
import { DatasetLabPage } from "./pages/DatasetLabPage.tsx";
import { HardwareIntegrationPage } from "./pages/HardwareIntegrationPage.tsx";
import { PatientOverviewPage } from "./pages/PatientOverviewPage.tsx";
import { TrendsAndBaselinePage } from "./pages/TrendsAndBaselinePage.tsx";
import type { UserRole } from "./types/smartcare.ts";

type NavKey =
  | "overview"
  | "trends"
  | "caregiver"
  | "hardware"
  | "dataset_lab"
  | "admin"
  | "assistant";

interface NavItem {
  key: NavKey;
  label: string;
  icon: React.ReactNode;
  roles: UserRole[];
}

const VALID_NAV_KEYS = new Set<NavKey>([
  "overview",
  "trends",
  "caregiver",
  "hardware",
  "dataset_lab",
  "admin",
  "assistant",
]);

const NAV_ITEMS: NavItem[] = [
  {
    key: "overview",
    label: "Health Overview",
    icon: <HeartPulse className="w-4 h-4" />,
    roles: ["patient", "caregiver", "admin"],
  },
  {
    key: "trends",
    label: "Trends & Baseline",
    icon: <Activity className="w-4 h-4" />,
    roles: ["patient", "caregiver", "admin"],
  },
  {
    key: "caregiver",
    label: "Caregiver Monitor",
    icon: <Users className="w-4 h-4" />,
    roles: ["caregiver", "admin", "patient"],
  },
  {
    key: "hardware",
    label: "Hardware & ESP32",
    icon: <Cpu className="w-4 h-4" />,
    roles: ["patient", "caregiver", "admin"],
  },
  {
    key: "dataset_lab",
    label: "Dataset Lab",
    icon: <FlaskConical className="w-4 h-4" />,
    roles: ["patient", "caregiver", "admin"],
  },
  {
    key: "admin",
    label: "Admin Console",
    icon: <Shield className="w-4 h-4" />,
    roles: ["admin"],
  },
  {
    key: "assistant",
    label: "AI Assistant",
    icon: <Bot className="w-4 h-4" />,
    roles: ["patient", "caregiver", "admin"],
  },
];

function WorkspaceShell() {
  const {
    authReady,
    user,
    emailVerified,
    isAdminUser,
    assignedRole,
    activeRole,
    userProfile,
    lastAuthRedirectRole,
    clearLastAuthRedirectRole,
    setActiveRole,
    signInWithGoogle,
    signOutUser,
    authError,
    usingSampleData,
    hasFirestoreWorkspace,
    initializeFirestoreWorkspace,
    patients,
    selectedPatientId,
    setSelectedPatientId,
    selectedPatient,
    unreadNotificationCount,
  } = useSmartCare();

  const [viewMode, setViewMode] = useState<"landing" | "workspace">("landing");
  const [activePage, setActivePage] = useState<NavKey>("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [seedingWorkspace, setSeedingWorkspace] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<AuthModalInitialTab>("login");
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  const wasAuthenticatedRef = useRef(Boolean(user));

  const redirectToRoleDashboard = (role: UserRole) => {
    if (role === "caregiver") setActivePage("caregiver");
    else if (role === "admin") setActivePage("admin");
    else setActivePage("overview");
    setViewMode("workspace");
  };

  useEffect(() => {
    if (!lastAuthRedirectRole) return;
    redirectToRoleDashboard(lastAuthRedirectRole);
    clearLastAuthRedirectRole();
  }, [lastAuthRedirectRole, clearLastAuthRedirectRole]);

  useEffect(() => {
    if (user && !wasAuthenticatedRef.current) {
      setViewMode("workspace");
    }
    wasAuthenticatedRef.current = Boolean(user);
  }, [user]);

  if (!authReady) {
    return <ArovaLoadingScreen />;
  }

  const openAuthModal = (tab: AuthModalInitialTab = "login") => {
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  };

  const handleEnterDashboard = (targetPage?: string) => {
    if (targetPage && VALID_NAV_KEYS.has(targetPage as NavKey)) {
      setActivePage(targetPage as NavKey);
    } else if (effectiveRole === "caregiver") {
      setActivePage("caregiver");
    } else if (effectiveRole === "admin") {
      setActivePage("admin");
    } else {
      setActivePage("overview");
    }
    setViewMode("workspace");
  };

  const handleRoleSwitch = async (role: UserRole) => {
    await setActiveRole(role);
    if (!user || isAdminUser || role === assignedRole) {
      redirectToRoleDashboard(role);
    }
  };

  const handleCreateFirestoreWorkspace = async () => {
    setSeedingWorkspace(true);
    try {
      await initializeFirestoreWorkspace();
    } finally {
      setSeedingWorkspace(false);
    }
  };

  const effectiveRole: UserRole = user ? (isAdminUser ? activeRole : assignedRole ?? activeRole) : activeRole;
  const visibleNav = NAV_ITEMS.filter((item) => item.roles.includes(effectiveRole));
  const currentTitle =
    NAV_ITEMS.find((i) => i.key === activePage)?.label ?? "Health Overview";
  const isAdminProtectedViolation = activePage === "admin" && Boolean(user && !isAdminUser);

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#080B0B] text-white border-r border-[#1E2525] w-64 shadow-[4px_0_24px_-12px_rgba(8,11,11,0.35)]">
      <div className="px-5 py-4 border-b border-[#1E2525] flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            setViewMode("landing");
            setMobileMenuOpen(false);
          }}
          className="text-left rounded-xl focus-visible:outline-[#00B800] cursor-pointer group"
          title="Return to AROVA Landing Page"
        >
          <ArovaBrandLockup variant="sidebar" />
        </button>
      </div>

      {/* Role Switcher / Assigned RBAC Role */}
      <div className="p-4 border-b border-[#1E2525] space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-[#A3ACAC]">
          <span>{user && !isAdminUser ? "Assigned Account Role" : "Active Role View"}</span>
          {user && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-[#00B800]">
              <Lock className="w-2.5 h-2.5" />
              RBAC
            </span>
          )}
        </div>
        {user && !isAdminUser ? (
          <div className="px-3 py-2 bg-[#121717] border border-[#263030] rounded-xl flex items-center justify-between text-xs">
            <span className="font-semibold text-white capitalize">
              {assignedRole ?? activeRole}
            </span>
            <span className="text-[11px] text-[#00B800] font-mono">Verified Scope</span>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1 p-1 bg-[#121717] border border-[#242D2D] rounded-xl">
            {(["patient", "caregiver", "admin"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => void handleRoleSwitch(r)}
                className={`py-1.5 text-xs font-medium rounded-lg capitalize transition-all duration-200 whitespace-nowrap cursor-pointer ${
                  activeRole === r
                    ? "bg-[#00B800] hover:bg-[#009900] text-white font-semibold shadow-sm"
                    : "text-[#A3ACAC] hover:text-white hover:bg-[#1A2121]"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Primary Navigation">
        {visibleNav.map((item) => {
          const active = activePage === item.key;
          const showUnreadBadge =
            unreadNotificationCount > 0 &&
            ((item.key === "overview" && effectiveRole === "patient") ||
              (item.key === "caregiver" && effectiveRole !== "patient"));
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setActivePage(item.key);
                setMobileMenuOpen(false);
              }}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors duration-200 whitespace-nowrap shrink-0 cursor-pointer ${
                active
                  ? "text-white font-semibold"
                  : "text-[#B6BFBF] hover:bg-[#141A1A] hover:text-white"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="arova-sidebar-active"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="absolute inset-0 rounded-xl bg-[#00B800]/18 border border-[#00B800]/70"
                />
              )}
              <span className={`relative z-10 ${active ? "text-[#00B800]" : "text-[#8F9999]"}`}>
                {item.icon}
              </span>
              <span className="relative z-10">{item.label}</span>
              {showUnreadBadge && (
                <span className="relative z-10 ml-auto px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded-md bg-amber-500/20 text-amber-300 border border-amber-400/40">
                  {unreadNotificationCount}
                </span>
              )}
            </button>
          );
        })}

        <div className="pt-3 mt-3 border-t border-[#1E2525]">
          <button
            type="button"
            onClick={() => {
              setViewMode("landing");
              setMobileMenuOpen(false);
            }}
            className="w-full flex items-center gap-3 px-3 py-2 text-xs font-medium rounded-xl text-[#A3ACAC] hover:bg-[#141A1A] hover:text-white transition-colors cursor-pointer"
          >
            <Home className="w-4 h-4 text-[#8F9999]" />
            <span>Platform Landing View</span>
          </button>
        </div>
      </nav>

      {/* Auth & Workspace Persistence Box */}
      <div className="p-4 border-t border-[#1E2525] space-y-2.5 bg-[#0D1111]">
        {user ? (
          <div className="space-y-2">
            <div className="text-xs space-y-0.5">
              <div className="flex items-center justify-between gap-1">
                <span className="font-semibold text-white truncate">
                  {userProfile?.displayName || user.displayName || "Authenticated User"}
                </span>
                <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#00B800]/20 border border-[#00B800]/45 text-[#4CE64C] capitalize shrink-0">
                  {assignedRole ?? activeRole}
                </span>
              </div>
              <div className="text-[#A3ACAC] truncate">{user.email}</div>
              {!emailVerified && (
                <button
                  type="button"
                  onClick={() => setProfileModalOpen(true)}
                  className="inline-flex items-center gap-1 text-[11px] text-amber-300 font-medium hover:underline pt-0.5 cursor-pointer"
                >
                  <ShieldAlert className="w-3 h-3" />
                  Email verification pending
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setProfileModalOpen(true)}
              className="arova-cta-secondary w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#141A1A] border border-[#283232] rounded-xl hover:border-[#00B800] cursor-pointer"
            >
              <UserCog className="w-3.5 h-3.5 text-[#00B800]" />
              Profile &amp; Settings
            </button>

            {!hasFirestoreWorkspace && (assignedRole ?? activeRole) === "patient" && (
              <button
                type="button"
                onClick={() => void handleCreateFirestoreWorkspace()}
                disabled={seedingWorkspace}
                className="arova-cta-primary w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 cursor-pointer"
              >
                <Database className="w-3.5 h-3.5" />
                {seedingWorkspace ? "Creating..." : "Create My Firestore Profile"}
              </button>
            )}

            <button
              type="button"
              onClick={() => void signOutUser()}
              className="arova-cta-secondary w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-[#D9E0E0] bg-[#121717] border border-[#263030] rounded-xl hover:bg-[#1A2121] hover:text-white cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => openAuthModal("login")}
              className="arova-cta-primary w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              Sign In / Register
            </button>
            <button
              type="button"
              onClick={() => void signInWithGoogle().catch(() => {})}
              className="arova-cta-secondary w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white bg-[#141A1A] border border-[#283232] rounded-xl hover:border-[#00B800] cursor-pointer"
            >
              Continue with Google
            </button>
            <p className="text-xs text-[#9AA4A4] leading-snug">
              Sign in as Patient, Caregiver, or Admin to persist AROVA health data in Firebase Firestore.
            </p>
          </div>
        )}
        {authError && <p className="text-xs text-red-400 leading-snug">{authError}</p>}
      </div>
    </div>
  );

  return (
    <>
      <AnimatePresence mode="wait">
        {viewMode === "landing" ? (
          <motion.div
            key="landing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
          >
            <LandingPage
              isAuthenticated={Boolean(user)}
              userDisplayName={userProfile?.displayName || user?.displayName}
              activeRole={effectiveRole}
              onEnterDashboard={handleEnterDashboard}
              onOpenAuth={(tab) => openAuthModal(tab ?? "login")}
            />
          </motion.div>
        ) : (
          <motion.div
            key="workspace"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26 }}
            className="min-h-screen bg-[#EEF2F2] text-[#202525] flex"
          >
            {/* Desktop Sidebar */}
            <aside className="hidden lg:block shrink-0">{sidebarContent}</aside>

            {/* Mobile Drawer */}
            <AnimatePresence>
              {mobileMenuOpen && (
                <div className="fixed inset-0 z-50 lg:hidden flex">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 bg-[#080B0B]/60 backdrop-blur-xs"
                    onClick={() => setMobileMenuOpen(false)}
                  />
                  <motion.div
                    initial={{ x: -272 }}
                    animate={{ x: 0 }}
                    exit={{ x: -272 }}
                    transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                    className="relative z-10 flex h-full"
                  >
                    {sidebarContent}
                    <button
                      type="button"
                      onClick={() => setMobileMenuOpen(false)}
                      className="ml-2 mt-3 h-9 w-9 rounded-xl bg-[#080B0B] border border-[#283232] flex items-center justify-center text-white shadow-lg cursor-pointer"
                      aria-label="Close navigation"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 arova-hero-mesh">
              {/* Top Bar Contract: Dark Black #080B0B Navigation Header */}
              <header className="sticky top-0 z-30 bg-[#080B0B] text-white border-b border-[#1E2525] px-4 sm:px-6 py-3.5 flex items-center justify-between gap-6 shadow-sm">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(true)}
                    className="lg:hidden p-2 rounded-lg text-[#D9E0E0] hover:bg-[#161C1C] hover:text-[#00B800] cursor-pointer"
                    aria-label="Open navigation"
                  >
                    <Menu className="w-5 h-5" />
                  </button>
                  <div className="text-sm text-[#A3ACAC] truncate">
                    <span className="font-semibold text-[#00B800]">AROVA</span>
                    <span className="mx-2 text-[#455050]">/</span>
                    <span className="font-medium text-white capitalize">{effectiveRole}</span>
                    <span className="mx-2 text-[#455050]">/</span>
                    <span className="text-[#D9E0E0]">{currentTitle}</span>
                    {(activePage === "dataset_lab" || !usingSampleData) && (
                      <>
                        <span className="hidden sm:inline mx-2 text-[#455050]">·</span>
                        <span className="hidden sm:inline text-xs text-[#A3ACAC]">
                          {activePage === "dataset_lab"
                            ? "Public Research Dataset Mode (Non-Clinical)"
                            : "Firestore Persistence"}
                        </span>
                      </>
                    )}
                    {activePage !== "overview" && activePage !== "dataset_lab" && usingSampleData && (
                      <>
                        <span className="hidden sm:inline mx-2 text-[#455050]">·</span>
                        <span className="hidden sm:inline text-xs text-amber-300">
                          Sample Demo Data
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setActivePage(effectiveRole === "patient" ? "overview" : "caregiver")
                    }
                    title={
                      unreadNotificationCount > 0
                        ? `${unreadNotificationCount} unread monitoring notification(s)`
                        : "No unread notifications"
                    }
                    className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                      unreadNotificationCount > 0
                        ? "bg-amber-500/20 border-amber-400/50 text-amber-200 hover:bg-amber-500/30"
                        : "bg-[#141A1A] border-[#283232] text-[#D9E0E0] hover:border-[#00B800] hover:text-white"
                    }`}
                  >
                    <Bell className="w-3.5 h-3.5" />
                    {unreadNotificationCount > 0 && (
                      <span className="font-mono font-semibold tabular-nums">
                        {unreadNotificationCount}
                      </span>
                    )}
                  </button>
                  {activePage === "dataset_lab" ? (
                    <span className="px-3 py-1.5 text-xs font-mono font-medium text-[#4CE64C] bg-[#00B800]/15 border border-[#00B800]/40 rounded-lg">
                      source: dataset_playback
                    </span>
                  ) : patients.length === 0 ? (
                    <span className="px-3 py-1.5 text-xs font-medium text-[#A3ACAC] bg-[#141A1A] border border-[#283232] rounded-lg">
                      No Linked Patients
                    </span>
                  ) : activePage === "overview" && usingSampleData ? null : (
                    <select
                      aria-label="Select monitored patient"
                      value={selectedPatientId}
                      onChange={(e) => setSelectedPatientId(e.target.value)}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-[#141A1A] border border-[#283232] rounded-lg max-w-[200px] truncate focus:outline-none focus:border-[#00B800]"
                    >
                      {patients.map((p) => (
                        <option key={p.patientId} value={p.patientId} className="bg-[#141A1A] text-white">
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </header>

              {/* Page Viewport */}
              <div className="flex-1">
                <main className="p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
                  {activePage !== "dataset_lab" && activePage !== "overview" && (
                    <div className="mb-6 pb-3 border-b border-[#D9E0E0] flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
                      <div>
                        <h1 className="text-2xl font-semibold tracking-tight text-[#202525]">
                          {currentTitle}
                        </h1>
                        <p className="text-sm text-[#737B7B] mt-1">
                          {patients.length === 0
                            ? "Authenticated Firestore Workspace · Awaiting linked patient assignments"
                            : `Monitoring ${selectedPatient.displayName}${
                                selectedPatient.ageGroup ? ` · ${selectedPatient.ageGroup}` : ""
                              }`}
                        </p>
                      </div>
                      {!user && (
                        <button
                          type="button"
                          onClick={() => openAuthModal("login")}
                          className="arova-cta-secondary self-start sm:self-auto px-3.5 py-1.5 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                        >
                          Sign In for Live Persistence
                        </button>
                      )}
                    </div>
                  )}

                  {isAdminProtectedViolation ? (
                    <div className="arova-glass-card border-red-300 rounded-2xl p-8 max-w-xl mx-auto text-center space-y-4">
                      <ShieldAlert className="w-10 h-10 text-red-600 mx-auto" />
                      <h2 className="text-lg font-semibold text-[#202525]">
                        Administrator Authorization Required
                      </h2>
                      <p className="text-sm text-[#737B7B]">
                        Your account is scoped to the{" "}
                        <span className="font-semibold capitalize text-[#008F00]">
                          {assignedRole ?? activeRole}
                        </span>{" "}
                        role and cannot access the AROVA Admin Console.
                      </p>
                      <button
                        type="button"
                        onClick={() => redirectToRoleDashboard(assignedRole ?? "patient")}
                        className="arova-cta-primary px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl cursor-pointer"
                      >
                        Return to My Dashboard
                      </button>
                    </div>
                  ) : (
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={activePage}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {activePage === "overview" && (
                          <PatientOverviewPage onNavigate={(p) => setActivePage(p as NavKey)} />
                        )}
                        {activePage === "trends" && <TrendsAndBaselinePage />}
                        {activePage === "caregiver" && <CaregiverDashboardPage />}
                        {activePage === "hardware" && <HardwareIntegrationPage />}
                        {activePage === "dataset_lab" && <DatasetLabPage />}
                        {activePage === "admin" && <AdminConsolePage />}
                        {activePage === "assistant" && <AiAssistantPage />}
                      </motion.div>
                    </AnimatePresence>
                  )}
                </main>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AuthModal
        open={authModalOpen}
        initialTab={authModalTab}
        onClose={() => setAuthModalOpen(false)}
        onSuccessRedirect={redirectToRoleDashboard}
      />

      <ProfileSettingsModal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
      />

      <FallEmergencyAlertModal />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <SmartCareProvider>
          <WorkspaceShell />
        </SmartCareProvider>
      </MotionConfig>
    </ErrorBoundary>
  );
}
