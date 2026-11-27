import { motion } from "motion/react";
import {
  Activity,
  ArrowRight,
  BellRing,
  Cpu,
  Database,
  HeartPulse,
  LogIn,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
  Waves,
} from "lucide-react";
import { ArovaBrandLockup, ArovaLogo } from "./ArovaLogo.tsx";
import type { UserRole } from "../types/smartcare.ts";

interface LandingPageProps {
  isAuthenticated: boolean;
  userDisplayName?: string | null;
  activeRole: UserRole;
  onEnterDashboard: (targetPage?: string) => void;
  onOpenAuth: (tab?: "login" | "register_patient" | "register_caregiver") => void;
}

const PARTICLES = [
  { left: "8%", top: "18%", size: 6, dur: "8.5s", delay: "0s", color: "bg-[#00B800]/25" },
  { left: "22%", top: "74%", size: 5, dur: "10.2s", delay: "-2.1s", color: "bg-[#008F00]/20" },
  { left: "48%", top: "14%", size: 4, dur: "9.4s", delay: "-4.0s", color: "bg-[#00B800]/20" },
  { left: "72%", top: "24%", size: 7, dur: "11.0s", delay: "-1.6s", color: "bg-[#00B800]/25" },
  { left: "86%", top: "68%", size: 5, dur: "8.8s", delay: "-3.4s", color: "bg-[#008F00]/20" },
  { left: "63%", top: "82%", size: 4, dur: "9.8s", delay: "-5.2s", color: "bg-[#00B800]/20" },
];

export function LandingPage({
  isAuthenticated,
  userDisplayName,
  activeRole,
  onEnterDashboard,
  onOpenAuth,
}: LandingPageProps) {
  return (
    <div className="min-h-screen bg-[#EEF2F2] text-[#202525] arova-hero-mesh relative overflow-x-hidden flex flex-col">
      {/* Subtle Ambient Medical Green Particles */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-36 -left-32 w-[520px] h-[520px] rounded-full bg-[#00B800]/6 blur-[130px]" />
        <div className="absolute top-1/4 -right-32 w-[480px] h-[480px] rounded-full bg-[#008F00]/5 blur-[130px]" />

        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className={`arova-particle absolute rounded-full blur-[1px] ${p.color}`}
            style={{
              left: p.left,
              top: p.top,
              width: `${p.size}px`,
              height: `${p.size}px`,
              ["--arova-particle-dur" as string]: p.dur,
              animationDelay: p.delay,
            }}
          />
        ))}
      </div>

      {/* Dark Black Top Header */}
      <header className="sticky top-0 z-30 border-b border-[#1E2525] bg-[#080B0B] text-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <ArovaBrandLockup variant="landing" />

          <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-[#D9E0E0]">
            <a href="#architecture" className="hover:text-[#00B800] transition-colors">
              Platform Stack
            </a>
            <a href="#workflows" className="hover:text-[#00B800] transition-colors">
              Role Workspaces
            </a>
            <button
              type="button"
              onClick={() => onEnterDashboard("dataset_lab")}
              className="hover:text-[#00B800] transition-colors cursor-pointer"
            >
              Dataset Lab
            </button>
          </nav>

          <div className="flex items-center gap-2.5">
            {!isAuthenticated ? (
              <button
                type="button"
                onClick={() => onOpenAuth("login")}
                className="arova-cta-secondary inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#2A3333] bg-[#141A1A] hover:border-[#00B800] text-xs font-semibold text-white cursor-pointer"
              >
                <LogIn className="w-3.5 h-3.5 text-[#00B800]" aria-hidden="true" />
                Sign In / Register
              </button>
            ) : (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#00B800]/15 border border-[#00B800]/45 text-xs font-medium text-white">
                <UserCheck className="w-3.5 h-3.5 text-[#00B800]" aria-hidden="true" />
                {userDisplayName || "Signed In"} · {activeRole}
              </span>
            )}

            <button
              type="button"
              onClick={() => onEnterDashboard()}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#00B800] hover:bg-[#009900] text-xs font-semibold text-white shadow-sm cursor-pointer"
            >
              <span>{isAuthenticated ? "Open Workspace" : "Launch Dashboard"}</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Hero */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-10 pb-16 space-y-16">
        <section className="relative rounded-3xl border border-[#D9E0E0] arova-glass-card p-6 sm:p-10 lg:p-12 overflow-hidden">
          {/* Animated Hero Heartbeat Line Moving Across Backdrop */}
          <svg
            aria-hidden="true"
            viewBox="0 0 1200 220"
            fill="none"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-x-0 bottom-4 w-full h-40 opacity-25"
          >
            <path
              d="M0 130H240L265 112L284 152L305 62L328 178L350 48L371 156L392 118L415 130H670L695 114L714 150L736 66L757 174L779 54L800 154L820 120L842 130H1200"
              stroke="url(#arovaHeroEcg)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="arova-ecg-sweep"
            />
            <defs>
              <linearGradient id="arovaHeroEcg" x1="0" y1="110" x2="1200" y2="110" gradientUnits="userSpaceOnUse">
                <stop stopColor="#008F00" stopOpacity="0.15" />
                <stop offset="0.35" stopColor="#00B800" />
                <stop offset="0.65" stopColor="#008F00" />
                <stop offset="1" stopColor="#00B800" stopOpacity="0.15" />
              </linearGradient>
            </defs>
          </svg>

          <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            {/* Hero Copy + CTAs */}
            <div className="lg:col-span-7 space-y-6">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="inline-flex items-center gap-3 px-3.5 py-2 rounded-2xl bg-[#EEF2F2] border border-[#D9E0E0] shadow-xs"
              >
                <ArovaLogo size={32} animated />
                <div className="text-left">
                  <div className="text-xs font-semibold text-[#008F00] tracking-wide">
                    AROVA Early Warning Platform
                  </div>
                  <div className="text-[11px] text-[#737B7B]">
                    Wearable Telemetry · Personalized Isolation Forest · Caregiver Escalation
                  </div>
                </div>
              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] text-[#202525]"
              >
                Intelligent Monitoring.{" "}
                <span className="text-[#00B800]">
                  Proactive Awareness.
                </span>{" "}
                Connected Care.
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
                className="text-sm sm:text-base text-[#737B7B] leading-relaxed max-w-2xl"
              >
                AROVA combines wearable sensor technology, AI-powered anomaly detection, and
                connected monitoring to support continuous health awareness.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-wrap items-center gap-3 pt-1"
              >
                <button
                  type="button"
                  onClick={() => onEnterDashboard()}
                  className="arova-cta-primary inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#00B800] hover:bg-[#009900] text-sm font-semibold text-white shadow-md cursor-pointer"
                >
                  <HeartPulse className="w-4 h-4" aria-hidden="true" />
                  <span>{isAuthenticated ? "Enter Monitoring Dashboard" : "Explore Live Workspace"}</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>

                {!isAuthenticated && (
                  <button
                    type="button"
                    onClick={() => onOpenAuth("register_patient")}
                    className="arova-cta-secondary inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white hover:bg-[#EEF2F2] border border-[#D9E0E0] hover:border-[#00B800] text-sm font-semibold text-[#202525] cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-[#00B800]" aria-hidden="true" />
                    <span>Sign In / Create Account</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onEnterDashboard("assistant")}
                  className="arova-cta-secondary inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-[#EEF2F2] hover:bg-[#00B800]/10 border border-[#D9E0E0] hover:border-[#00B800]/45 text-sm font-medium text-[#202525] cursor-pointer"
                >
                  <Sparkles className="w-4 h-4 text-[#00B800]" aria-hidden="true" />
                  <span>Gemini AI Assistant</span>
                </button>
              </motion.div>

              <p className="text-[11px] text-[#737B7B] flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
                <span>
                  Early-warning monitoring prototype. Not a certified medical device and does not
                  diagnose or automatically contact emergency services.
                </span>
              </p>
            </div>

            {/* Subtle Floating Med-Tech Preview Cluster */}
            <div className="lg:col-span-5 relative space-y-3">
              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="arova-float-card rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] p-4 space-y-3"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-2 font-semibold text-[#202525]">
                    <span className="w-2 h-2 rounded-full bg-[#00B800] arova-status-normal-dot" />
                    Telemetry Architecture Preview
                  </span>
                  <span className="font-mono text-[10px] text-[#737B7B]">ESP32 · MAX30100 · AD8232</span>
                </div>

                <div className="grid grid-cols-3 gap-2.5 text-center">
                  <div className="rounded-xl bg-white border border-[#D9E0E0] p-2.5">
                    <div className="text-[10px] text-[#737B7B]">Optical HR</div>
                    <div className="text-base font-mono font-bold text-[#008F00] mt-0.5">PPG</div>
                  </div>
                  <div className="rounded-xl bg-white border border-[#D9E0E0] p-2.5">
                    <div className="text-[10px] text-[#737B7B]">Oxygen</div>
                    <div className="text-base font-mono font-bold text-[#00B800] mt-0.5">SpO2</div>
                  </div>
                  <div className="rounded-xl bg-white border border-[#D9E0E0] p-2.5">
                    <div className="text-[10px] text-[#737B7B]">Motion</div>
                    <div className="text-base font-mono font-bold text-[#202525] mt-0.5">6-Axis IMU</div>
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="arova-float-card arova-float-delay-2 rounded-2xl bg-white border border-[#D9E0E0] p-4 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 flex items-center justify-center text-[#008F00] shrink-0">
                    <Waves className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#202525] truncate">
                      Personalized Baseline Engine
                    </div>
                    <div className="text-[11px] text-[#737B7B] truncate">
                      Context-aware Isolation Forest + persistence gating
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[11px] font-semibold text-[#008F00] shrink-0">
                  Phase 1–5 Ready
                </span>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: 24 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="arova-float-card arova-float-delay-3 rounded-2xl bg-white border border-[#D9E0E0] p-4 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 flex items-center justify-center text-[#008F00] shrink-0">
                    <BellRing className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#202525] truncate">
                      Patient-First Caregiver Escalation
                    </div>
                    <div className="text-[11px] text-[#737B7B] truncate">
                      In-app alerts, SMS/Email, Gemini Live voice calls
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[11px] font-semibold text-[#008F00] shrink-0">
                  RBAC Secured
                </span>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Bento Architecture Section */}
        <section id="architecture" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#008F00]">
                Clinical &amp; IoT Capabilities
              </p>
              <h2 className="text-2xl sm:text-3xl font-bold text-[#202525] mt-1">
                Built for Continuous Awareness, Not Noise
              </h2>
            </div>
            <p className="text-xs text-[#737B7B] max-w-md">
              Every module preserves strict telemetry provenance, distinguishing real ESP32 hardware
              streams from simulated or public dataset playback.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                index: "01",
                title: "ESP32 Multi-Sensor Ingest",
                desc: "Token-authenticated telemetry ingestion for MAX30100/MAX30102 PPG, DS18B20 temperature, MPU6050 IMU, and AD8232 ECG.",
                icon: Cpu,
              },
              {
                index: "02",
                title: "Personalized Anomaly Detection",
                desc: "Python Isolation Forest learns individual resting vs. active baselines and suppresses transient poor-contact artifacts.",
                icon: Activity,
              },
              {
                index: "03",
                title: "Multi-Modal Escalation",
                desc: "Patient acknowledgement countdowns escalate smoothly to linked primary/secondary caregivers across dashboard, SMS, email, and voice.",
                icon: Users,
              },
              {
                index: "04",
                title: "Research Dataset Lab",
                desc: "Replay and benchmark public recordings (SisFall, UMAFall, BIDMC, MIT-BIH, PPG-DaLiA, WESAD) with confusion-matrix evaluation.",
                icon: Database,
              },
            ].map((item, idx) => {
              const Icon = item.icon;
              return (
                <motion.div
                  key={item.index}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.2 }}
                  transition={{ duration: 0.45, delay: idx * 0.08 }}
                  className="arova-float-card-subtle rounded-2xl arova-glass-card p-5 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-[#737B7B]">
                      {item.index}
                    </span>
                    <span className="w-9 h-9 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center">
                      <Icon className="w-4 h-4" aria-hidden="true" />
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-[#202525]">{item.title}</h3>
                  <p className="text-xs text-[#737B7B] leading-relaxed">{item.desc}</p>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* Role Workspaces Launcher */}
        <section id="workflows" className="space-y-4">
          <h2 className="text-xl sm:text-2xl font-bold text-[#202525]">Role-Based Workspaces</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                label: "Patient Overview",
                role: "Patient View",
                desc: "Real-time vital cards, interactive BPM heart HUD, baseline progress, and quick Gemini guidance.",
                page: "overview",
              },
              {
                label: "Caregiver Console",
                role: "Caregiver View",
                desc: "Linked patient roster, active alert countdowns, acknowledgement controls, and voice escalation.",
                page: "caregiver",
              },
              {
                label: "Live Trends & Hardware",
                role: "Telemetry & ESP32",
                desc: "Synchronized multi-metric charts, ECG waveform monitor, device tokens, and sensor matrix.",
                page: "trends",
              },
              {
                label: "Admin & Dataset Lab",
                role: "Operations & ML",
                desc: "System RBAC, ML threshold calibration, notification policies, and public dataset playback.",
                page: "dataset_lab",
              },
            ].map((card) => (
              <button
                key={card.page}
                type="button"
                onClick={() => onEnterDashboard(card.page)}
                className="group text-left rounded-2xl arova-glass-card p-5 hover:border-[#00B800] transition-all cursor-pointer flex flex-col justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#008F00]">
                    {card.role}
                  </div>
                  <div className="text-base font-semibold text-[#202525] group-hover:text-[#008F00] transition-colors">
                    {card.label}
                  </div>
                  <p className="text-xs text-[#737B7B] leading-relaxed">{card.desc}</p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#00B800]">
                  Open View
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
