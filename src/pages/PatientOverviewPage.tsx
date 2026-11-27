import { useRef, useState } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import {
  Activity,
  ArrowRight,
  Bell,
  Bot,
  Check,
  Cpu,
  Flag,
  HeartPulse,
  PhoneCall,
  Send,
  ShieldCheck,
  Sparkles,
  Thermometer,
  Users,
  Waves,
  Wifi,
  WifiOff,
} from "lucide-react";
import { AiOutboundCallModal } from "../components/AiOutboundCallModal.tsx";
import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import { ArovaBrandLockup } from "../components/ArovaLogo.tsx";
import { CameraFallDetectionPanel } from "../components/CameraFallDetectionPanel.tsx";
import { EcgWaveformPanel } from "../components/EcgWaveformPanel.tsx";
import { InteractiveBpmHeart } from "../components/InteractiveBpmHeart.tsx";
import { MlIntelligencePanel } from "../components/MlIntelligencePanel.tsx";
import { AlertLevelLabel } from "../components/StatusIndicator.tsx";
import { TelemetryCharts } from "../components/TelemetryCharts.tsx";
import { VitalMetricCard } from "../components/VitalMetricCard.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import { askGeminiAssistant } from "../services/apiClient.ts";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export function PatientOverviewPage({
  onNavigate,
}: {
  onNavigate: (page: string) => void;
}) {
  const [callModalOpen, setCallModalOpen] = useState(false);
  const [falseAlertTargetId, setFalseAlertTargetId] = useState<string | null>(null);
  const [falseAlertReason, setFalseAlertReason] = useState("");
  const [alertActionBusyId, setAlertActionBusyId] = useState<string | null>(null);
  const [quickQuestion, setQuickQuestion] = useState("");
  const [quickAnswer, setQuickAnswer] = useState<string | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);

  const heroRef = useRef<HTMLElement | null>(null);
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const cardiacParallaxY = useTransform(scrollYProgress, [0, 1], [0, -28]);
  const cardiacParallaxSlowY = useTransform(scrollYProgress, [0, 1], [0, 22]);

  const {
    activeRole,
    selectedPatient,
    readings,
    alerts,
    notifications,
    devices,
    integrations,
    usingSampleData,
    systemSettings,
    liveHardwareSnapshot,
    ecgSegments,
    baselineStatusSummary,
    baselines,
    anomalyEvents,
    isAdminUser,
    simRunning,
    simDeviceConnected,
    acknowledgeAlert,
    reportFalseAlert,
    markNotificationRead,
  } = useSmartCare();

  const latest = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;
  const patientDevices = devices.filter((d) => d.patientId === selectedPatient.patientId);
  const activeDevice = patientDevices[0] ?? devices[0];
  const patientAlerts = alerts.filter((a) => a.patientId === selectedPatient.patientId);
  const patientUnreadNotifications = notifications.filter(
    (n) => n.patientId === selectedPatient.patientId && n.recipientRole === "patient" && !n.read
  );

  const isHardwareLive = Boolean(liveHardwareSnapshot);
  const isSimStream = !isHardwareLive && (simRunning || latest?.source === "simulator");
  const isDeviceOffline =
    !isHardwareLive &&
    (!simDeviceConnected ||
      activeDevice?.connectionStatus === "offline" ||
      activeDevice?.connectionStatus === "not_connected");
  const mlConnected = Boolean(integrations?.mlService.reachable);

  const hrValue = latest && typeof latest.heartRate === "number" ? latest.heartRate : null;
  const spo2Value = latest && typeof latest.spo2 === "number" ? latest.spo2 : null;
  const tempValue = latest && typeof latest.temperatureC === "number" ? latest.temperatureC : null;
  const fallSuspect = Boolean(
    latest?.possibleFallDetected || latest?.movementStatus === "fall_suspect"
  );

  const hrTone =
    hrValue === null
      ? "normal"
      : hrValue >= 130 || hrValue <= 42
      ? "critical"
      : hrValue >= 105 || hrValue <= 50
      ? "warning"
      : "normal";

  const spo2Tone =
    spo2Value === null
      ? "normal"
      : spo2Value <= 90
      ? "critical"
      : spo2Value <= 94
      ? "warning"
      : "normal";

  const tempTone =
    tempValue === null
      ? "normal"
      : tempValue >= 39.0 || tempValue <= 35.0
      ? "critical"
      : tempValue >= 37.8 || tempValue <= 35.5
      ? "warning"
      : "normal";

  const moveTone = !latest
    ? "normal"
    : fallSuspect
    ? "critical"
    : latest.movementStatus === "inactive"
    ? "warning"
    : "normal";

  const latestEcgSegment = ecgSegments[0] ?? null;
  const ecgStatusLabel =
    latest?.ecgLeadOff || latestEcgSegment?.leadOff
      ? "AD8232 Lead-Off"
      : latest?.ecgSignalQuality === "good" || latestEcgSegment?.signalQuality === "good"
      ? "AD8232 Signal Good"
      : latest?.ecgSignalQuality === "noisy" || latestEcgSegment?.signalQuality === "noisy"
      ? "AD8232 Noisy"
      : "AD8232 Provisional";

  const collectedSamples =
    baselineStatusSummary?.activeBaseline.collectedSamples || selectedPatient.baselineSamplesCount;
  const requiredSamples = Math.max(1, systemSettings.baselineMinSamples);
  const baselinePct = Math.min(100, Math.round((collectedSamples / requiredSamples) * 100));
  const baselineState =
    baselineStatusSummary?.activeBaseline.status ?? selectedPatient.baselineStatus;
  const baselineStateLabel =
    baselineState === "ready"
      ? "Baseline Ready"
      : baselineState === "collecting"
      ? "Collecting Baseline"
      : "Not Started";

  const monitoringStatusText = isHardwareLive
    ? "ESP32 Streaming Live"
    : simRunning && simDeviceConnected
    ? "Simulator Stream Active"
    : isSimStream
    ? "Simulated Data · Standby"
    : "Hardware Disconnected";

  const dataSourceBadgeText = isHardwareLive
    ? "Real Hardware · ESP32"
    : latest?.source === "simulator" || simRunning
    ? "Simulated Telemetry (Test)"
    : "No Live Telemetry";

  const sensorQualityText = latest
    ? latest.signalQuality === "good"
      ? "Signal Good"
      : latest.signalQuality === "noisy"
      ? "Signal Noisy"
      : "Poor Contact / Invalid"
    : "Sensors Standby";

  const visiblePatientName =
    selectedPatient.dataMode === "sample"
      ? ""
      : selectedPatient.displayName
          .replace(/\s*\([^)]*sample[^)]*\)/gi, "")
          .replace(/elena\s+rostova/gi, "")
          .trim();

  const cleanAlertText = (text: string) =>
    text
      .replace(/\s*\([^)]*sample[^)]*\)/gi, "")
      .replace(/\bsample\b[:\s-]*/gi, "")
      .replace(/elena\s+rostova/gi, "")
      .trim();

  const cleanDeviceLabel = (label: string) =>
    label.replace(/\s*\([^)]*sample[^)]*\)/gi, "").trim();

  const handlePatientAcknowledge = async (alertId: string) => {
    setAlertActionBusyId(alertId);
    try {
      await acknowledgeAlert(alertId, "Acknowledged by patient from Health Overview.", "patient");
    } finally {
      setAlertActionBusyId(null);
    }
  };

  const handlePatientFalseAlertSubmit = async (alertId: string) => {
    setAlertActionBusyId(alertId);
    try {
      await reportFalseAlert(
        alertId,
        falseAlertReason.trim() || "Patient reported reading as false alert.",
        "patient"
      );
      setFalseAlertTargetId(null);
      setFalseAlertReason("");
    } finally {
      setAlertActionBusyId(null);
    }
  };

  const handleAskQuickAssistant = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || quickLoading) return;
    setQuickLoading(true);
    setQuickError(null);
    setQuickQuestion(clean);
    try {
      const answer = await askGeminiAssistant({
        question: clean,
        history: [],
        context: {
          role: activeRole,
          patientId: selectedPatient.patientId,
          patientOwnerUid: selectedPatient.ownerUid,
          patientName: selectedPatient.displayName,
          dataMode: usingSampleData ? "sample" : selectedPatient.dataMode,
          baselineStatus: selectedPatient.baselineStatus,
          baselineSummary: `Samples: ${collectedSamples}/${requiredSamples}, Mean HR: ${
            selectedPatient.baselineHeartRateMean ?? "n/a"
          } BPM, Mean SpO2: ${selectedPatient.baselineSpo2Mean ?? "n/a"}%, Mean Temp: ${
            selectedPatient.baselineTempMean ?? "n/a"
          } C`,
          baselineStats: {
            heartRateMean: selectedPatient.baselineHeartRateMean,
            spo2Mean: selectedPatient.baselineSpo2Mean,
            tempMean: selectedPatient.baselineTempMean,
            sampleCount: collectedSamples,
          },
          latestReading: latest
            ? {
                heartRate: latest.heartRate,
                spo2: latest.spo2,
                temperatureC: latest.temperatureC,
                movementStatus: latest.movementStatus,
                signalQuality: latest.signalQuality,
                alertLevel: latest.alertLevel,
                anomalyScore: latest.anomalyScore,
                source: latest.source,
                explanation: latest.explanation,
                timestamp: latest.createdAt,
              }
            : null,
          recentReadings: readings.slice(-6).map((r) => ({
            heartRate: r.heartRate,
            spo2: r.spo2,
            temperatureC: r.temperatureC,
            movementStatus: r.movementStatus,
            alertLevel: r.alertLevel,
            timestamp: r.createdAt,
          })),
          recentAlerts: patientAlerts.slice(0, 4).map((a) => ({
            level: a.level,
            status: a.status,
            title: a.title,
            explanation: a.explanation,
            anomalyScore: a.anomalyScore,
            falseAlertReported: a.falseAlertReported,
            followUpAction: a.followUpAction,
            notificationStatus: a.notificationStatus,
            escalationStatus: a.escalationStatus,
            callEscalationStatus: a.callEscalationStatus,
            timestamp: a.createdAt,
          })),
        },
      });
      setQuickAnswer(answer);
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : "Could not reach AROVA Assistant.");
    } finally {
      setQuickLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* 1. Medical Green & Clean White AI Cardiac Healthcare Hero Section */}
      <section
        ref={heroRef}
        aria-label="AROVA Intelligent Healthcare Overview"
        className="arova-glass-card relative overflow-hidden rounded-3xl bg-white border border-[#D9E0E0] shadow-sm px-6 py-7 sm:px-9 sm:py-10 text-[#202525]"
      >
        {/* Subtle luminous medical green atmospheric glows */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-16 w-80 h-80 rounded-full bg-[#00B800]/8 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-28 -left-16 w-80 h-80 rounded-full bg-[#008F00]/6 blur-3xl"
        />

        {/* Sweeping Hero ECG Trace Backdrop */}
        <svg
          aria-hidden="true"
          viewBox="0 0 1200 180"
          fill="none"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-x-0 bottom-0 w-full h-32 opacity-25"
        >
          <path
            d="M0 110H220L244 96L262 128L282 54L304 146L326 42L346 132L366 100H680L704 94L724 128L745 58L766 144L788 46L810 130L830 100H1200"
            stroke="url(#arovaOverviewHeroEcg)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="arova-ecg-sweep"
          />
          <defs>
            <linearGradient
              id="arovaOverviewHeroEcg"
              x1="0"
              y1="90"
              x2="1200"
              y2="90"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#00B800" stopOpacity="0.15" />
              <stop offset="0.4" stopColor="#00B800" />
              <stop offset="0.7" stopColor="#008F00" />
              <stop offset="1" stopColor="#009900" stopOpacity="0.2" />
            </linearGradient>
          </defs>
        </svg>

        {/* Parallax + Gently Floating AI Cardiac & Vital Scan Wireframe Motifs */}
        <motion.div
          aria-hidden="true"
          style={{ y: cardiacParallaxY }}
          className="pointer-events-none absolute -top-6 right-10 opacity-15 hidden sm:block"
        >
          <svg
            className="arova-cardiac-float w-48 h-48 text-[#00B800]"
            viewBox="0 0 180 180"
            fill="none"
          >
            <circle
              cx="90"
              cy="90"
              r="72"
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray="6 6"
            />
            <circle
              cx="90"
              cy="90"
              r="52"
              stroke="#008F00"
              strokeWidth="0.9"
              strokeOpacity="0.55"
            />
            <path
              d="M90 132C90 132 50 106 50 74C50 58 62 47 75 47C83 47 88 52 90 57C92 52 97 47 105 47C118 47 130 58 130 74C130 106 90 132 90 132Z"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="currentColor"
              fillOpacity="0.08"
            />
            <path
              d="M36 90H66L74 74L84 106L94 64L103 96L110 90H144"
              stroke="#008F00"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>

        <motion.div
          aria-hidden="true"
          style={{ y: cardiacParallaxSlowY }}
          className="pointer-events-none absolute -bottom-10 left-1/3 opacity-15 hidden md:block"
        >
          <svg
            className="arova-cardiac-float-slow w-40 h-40 text-[#00B800]"
            viewBox="0 0 160 160"
            fill="none"
          >
            <circle
              cx="80"
              cy="80"
              r="60"
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray="4 6"
            />
            <path
              d="M80 116C80 116 48 95 48 70C48 57 57 48 68 48C74 48 78 52 80 56C82 52 86 48 92 48C103 48 112 57 112 70C112 95 80 116 80 116Z"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="currentColor"
              fillOpacity="0.08"
            />
          </svg>
        </motion.div>

        {/* Hero Main Two-Column Layout */}
        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
          {/* Left Column: Opening Sequence Copy + CTAs */}
          <div className="lg:col-span-7 space-y-6">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.04, ease: EASE_OUT }}
              className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-[#D9E0E0]"
            >
              <ArovaBrandLockup variant="hero" />

              <div className="inline-flex items-center gap-2 text-xs text-[#202525] font-medium px-3 py-1.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0]">
                <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                  <span
                    className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
                      isHardwareLive
                        ? "bg-[#00B800] arova-status-normal-dot"
                        : simRunning
                        ? "bg-[#00B800] animate-ping"
                        : "bg-[#737B7B]"
                    }`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                      isHardwareLive
                        ? "bg-[#00B800]"
                        : simRunning
                        ? "bg-[#00B800]"
                        : "bg-[#737B7B]"
                    }`}
                  />
                </span>
                <span>
                  {!usingSampleData ? "Connected Workspace · " : ""}
                  {isHardwareLive
                    ? "Real ESP32 Live"
                    : simRunning
                    ? "Simulator Active"
                    : "ESP32 Disconnected / Ready"}
                </span>
              </div>
            </motion.div>

            <div className="space-y-4 max-w-2xl">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.1, ease: EASE_OUT }}
                className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#008F00]"
              >
                <ShieldCheck className="w-4 h-4 text-[#00B800] shrink-0" aria-hidden="true" />
                <span>Personalized AI Health Monitoring</span>
              </motion.div>

              <motion.h1
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.52, delay: 0.16, ease: EASE_OUT }}
                className="text-3xl sm:text-4xl lg:text-[42px] font-bold tracking-tight text-[#202525] leading-[1.14]"
              >
                {visiblePatientName
                  ? `Welcome, ${visiblePatientName}`
                  : "Intelligent Monitoring. Proactive Care."}
              </motion.h1>

              <motion.p
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.24, ease: EASE_OUT }}
                className="text-sm sm:text-base text-[#737B7B] leading-relaxed max-w-xl"
              >
                Continuous wearable vital telemetry paired with personalized Isolation Forest
                anomaly scoring, AD8232 ECG tracking, and timely caregiver escalation.
              </motion.p>

              {(selectedPatient.ageGroup ||
                selectedPatient.primaryCaregiverName ||
                selectedPatient.dataMode !== "sample") && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.45, delay: 0.3 }}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs sm:text-sm text-[#008F00] font-medium"
                >
                  {selectedPatient.ageGroup && <span>{selectedPatient.ageGroup}</span>}
                  {selectedPatient.ageGroup && selectedPatient.primaryCaregiverName && (
                    <span className="text-[#737B7B]" aria-hidden="true">
                      ·
                    </span>
                  )}
                  {selectedPatient.primaryCaregiverName && (
                    <span>Caregiver: {selectedPatient.primaryCaregiverName}</span>
                  )}
                  {selectedPatient.dataMode !== "sample" && (
                    <>
                      {(selectedPatient.ageGroup || selectedPatient.primaryCaregiverName) && (
                        <span className="text-[#737B7B]" aria-hidden="true">
                          ·
                        </span>
                      )}
                      <span>Live Patient Profile</span>
                    </>
                  )}
                </motion.div>
              )}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.48, delay: 0.3, ease: EASE_OUT }}
              className="flex flex-wrap items-center gap-3 pt-1"
            >
              <button
                type="button"
                onClick={() => onNavigate("trends")}
                className="arova-cta-primary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl shadow-sm cursor-pointer whitespace-nowrap shrink-0 transition-colors"
              >
                <Activity className="w-4 h-4 text-white shrink-0" aria-hidden="true" />
                <span>Explore Trends &amp; Baseline</span>
                <ArrowRight className="w-4 h-4 text-white shrink-0" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={() => setCallModalOpen(true)}
                className="arova-cta-secondary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold text-[#202525] bg-white hover:border-[#00B800] hover:text-[#008F00] border border-[#D9E0E0] rounded-xl cursor-pointer whitespace-nowrap shrink-0 transition-colors"
              >
                <PhoneCall className="w-4 h-4 text-[#00B800] shrink-0" aria-hidden="true" />
                <span>Call Me with AI</span>
              </button>

              <button
                type="button"
                onClick={() => onNavigate("assistant")}
                className="arova-cta-secondary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold text-[#202525] bg-white hover:border-[#00B800] hover:text-[#008F00] border border-[#D9E0E0] rounded-xl cursor-pointer whitespace-nowrap shrink-0 transition-colors"
              >
                <Bot className="w-4 h-4 text-[#00B800] shrink-0" aria-hidden="true" />
                <span>Open AI Assistant</span>
              </button>
            </motion.div>
          </div>

          {/* Right Column: Human Heart in AI Elementary & Vital Scan Showcase */}
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.58, delay: 0.24, ease: EASE_OUT }}
            className="lg:col-span-5 arova-float-grid"
          >
            <div className="arova-float-card-subtle arova-float-delay-2 relative rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] p-5 shadow-sm space-y-4">
              {/* Interactive Live-BPM Synced SVG Heart & Vital Scan */}
              <InteractiveBpmHeart
                bpm={hrValue}
                baselineBpm={selectedPatient.baselineHeartRateMean ?? null}
                tone={hrTone}
                signalQuality={latest?.signalQuality ?? null}
                mlConnected={mlConnected}
              />

              {/* Real-Time Telemetry Posture Readouts */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="rounded-xl bg-white border border-[#D9E0E0] px-3 py-2.5 space-y-1">
                  <div className="text-[11px] font-medium text-[#737B7B]">Monitoring</div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#202525] truncate">
                    {isHardwareLive ? (
                      <Wifi className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
                    ) : (
                      <Activity className="w-3.5 h-3.5 text-[#00B800] shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{monitoringStatusText}</span>
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-[#D9E0E0] px-3 py-2.5 space-y-1">
                  <div className="text-[11px] font-medium text-[#737B7B]">Alert State</div>
                  <div>
                    <AlertLevelLabel level={latest?.alertLevel ?? "Normal"} />
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-[#D9E0E0] px-3 py-2.5 space-y-1">
                  <div className="text-[11px] font-medium text-[#737B7B]">Baseline</div>
                  <div className="text-xs font-semibold text-[#008F00] font-mono tabular-nums truncate">
                    <AnimatedNumber value={collectedSamples} />/{requiredSamples} · {baselineStateLabel}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* 2. Health Overview Section Heading */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.25 }}
        transition={{ duration: 0.42, ease: EASE_OUT }}
        className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 pb-3 border-b border-[#D9E0E0]"
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-[#202525]">Health Overview</h2>
          <p className="text-sm text-[#737B7B] mt-0.5">
            Live vital-sign readings, personalized baseline progress, and sensor telemetry
          </p>
        </div>
        {latest?.createdAt && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#737B7B] font-mono tabular-nums whitespace-nowrap">
            <span
              className={`px-2.5 py-0.5 rounded-lg border font-sans font-medium ${
                isHardwareLive
                  ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                  : latest.source === "simulator"
                  ? "bg-amber-50 border-amber-300 text-amber-800"
                  : "bg-white border-[#D9E0E0] text-[#202525]"
              }`}
            >
              {dataSourceBadgeText}
            </span>
            <span className="px-2.5 py-0.5 rounded-lg border border-[#D9E0E0] bg-white font-sans text-[#202525]">
              {sensorQualityText}
            </span>
            <span>
              Last packet:{" "}
              {new Date(latest.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          </div>
        )}
      </motion.div>

      {fallSuspect && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-red-50 border border-red-300 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-red-800"
        >
          <div>
            <span className="font-semibold text-red-900">
              Possible Fall Indicator (Experimental IMU)
            </span>
            <span className="mx-2 text-red-500">·</span>
            <span>
              MPU6050 recorded an impact/orientation spike (
              {latest?.accelMagnitude?.toFixed(2) ?? "high"} g). Experimental heuristic only — verify
              patient status directly.
            </span>
          </div>
        </motion.div>
      )}

      {/* 3. Primary Vital Metric Cards (Staggered Entrance + Floating Rhythm) */}
      <section
        aria-label="Current Vital Readings"
        className="arova-float-grid grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
      >
        <VitalMetricCard
          label="Heart Rate (PulseOx)"
          value={hrValue !== null ? String(Math.round(hrValue)) : "--"}
          unit={hrValue !== null ? "BPM" : undefined}
          baselineText={
            selectedPatient.baselineHeartRateMean
              ? `Baseline ${selectedPatient.baselineHeartRateMean.toFixed(0)} BPM`
              : "Baseline pending"
          }
          statusNote={
            hrValue === null
              ? latest?.signalQuality === "poor_contact"
                ? "Poor contact / no finger"
                : "Sensor unavailable"
              : hrTone === "normal"
              ? "Within range"
              : hrTone === "warning"
              ? "Elevated"
              : "Critical range"
          }
          tone={hrTone}
          accentVariant="primary"
          floatDelayClass="arova-float-delay-1"
          entranceIndex={0}
          icon={<HeartPulse className="w-5 h-5" />}
        />

        <VitalMetricCard
          label="Est. SpO₂ (PulseOx)"
          value={spo2Value !== null ? spo2Value.toFixed(1) : "--"}
          unit={spo2Value !== null ? "%" : undefined}
          baselineText={
            selectedPatient.baselineSpo2Mean
              ? `Baseline ${selectedPatient.baselineSpo2Mean.toFixed(1)}%`
              : "Baseline pending"
          }
          statusNote={
            spo2Value === null
              ? latest?.signalQuality === "poor_contact"
                ? "No finger / invalid"
                : "Sensor unavailable"
              : spo2Tone === "normal"
              ? "Normal O₂"
              : spo2Tone === "warning"
              ? "Dip detected"
              : "Low SpO₂"
          }
          tone={spo2Tone}
          accentVariant="deep"
          floatDelayClass="arova-float-delay-2"
          entranceIndex={1}
          icon={<Waves className="w-5 h-5" />}
        />

        <VitalMetricCard
          label="Skin Temperature"
          value={tempValue !== null ? tempValue.toFixed(1) : "--"}
          unit={tempValue !== null ? "°C" : undefined}
          baselineText={
            selectedPatient.baselineTempMean
              ? `Baseline ${selectedPatient.baselineTempMean.toFixed(1)} °C`
              : "Probe configurable"
          }
          statusNote={
            tempValue === null
              ? "Sensor unavailable / null"
              : tempTone === "normal"
              ? "Nominal"
              : tempTone === "warning"
              ? "Elevated"
              : "High fever"
          }
          tone={tempTone}
          accentVariant="emerald"
          floatDelayClass="arova-float-delay-3"
          entranceIndex={2}
          icon={<Thermometer className="w-5 h-5" />}
        />

        <VitalMetricCard
          label="Movement & Activity"
          value={latest ? latest.movementStatus.replace("_", " ") : "--"}
          baselineText={
            latest &&
            typeof latest.accelX === "number" &&
            typeof latest.accelY === "number" &&
            typeof latest.accelZ === "number"
              ? `IMU ${latest.accelMagnitude?.toFixed(2) ?? "1.00"} g · X:${latest.accelX.toFixed(
                  2
                )} Y:${latest.accelY.toFixed(2)} Z:${latest.accelZ.toFixed(2)}`
              : latest?.accelMagnitude
              ? `IMU ${latest.accelMagnitude.toFixed(2)} g · ${ecgStatusLabel}`
              : `MPU6050 ready · ${ecgStatusLabel}`
          }
          statusNote={
            fallSuspect
              ? "Possible fall (exp. IMU)"
              : moveTone === "warning"
              ? "Prolonged stillness"
              : "Expected motion"
          }
          tone={moveTone}
          accentVariant="forest"
          floatDelayClass="arova-float-delay-4"
          entranceIndex={3}
          icon={<Activity className="w-5 h-5" />}
        />
      </section>

      {/* 4. Operational Posture Panels */}
      <section
        aria-label="Monitoring Architecture Status"
        className="arova-float-grid grid grid-cols-1 md:grid-cols-3 gap-4"
      >
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 0.46, delay: 0, ease: EASE_OUT }}
          className="h-full"
        >
          <div className="arova-float-card arova-float-delay-2 arova-glass-card h-full rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-[#737B7B]">Wearable Sensor Link</span>
              <span
                className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${
                  isHardwareLive
                    ? "bg-[#00B800]/12 border-[#00B800]/35 text-[#008F00]"
                    : "bg-[#F7F9F9] border-[#D9E0E0] text-[#737B7B]"
                }`}
                aria-hidden="true"
              >
                {isHardwareLive ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              </span>
            </div>
            <p className="text-base font-semibold text-[#202525]">
              {isHardwareLive
                ? "ESP32 Hardware Streaming Live"
                : simRunning && simDeviceConnected
                ? "Simulated Device Streaming (Test)"
                : isDeviceOffline
                ? "ESP32 Hardware Disconnected"
                : "ESP32 Hardware Standby"}
            </p>
            <p className="text-xs text-[#737B7B] leading-relaxed">
              {activeDevice
                ? `${activeDevice.boardType} · ${activeDevice.pulseOxChipVariant} · ${activeDevice.tempSensor}`
                : "No wearable node assigned yet."}
            </p>
            <div className="text-[11px] font-mono text-[#737B7B] flex items-center justify-between gap-2 pt-2 border-t border-[#D9E0E0]">
              <span>Source: {isHardwareLive ? "esp32_hardware" : latest?.source ?? "none"}</span>
              <span>Quality: {latest?.signalQuality ?? "n/a"}</span>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 0.46, delay: 0.08, ease: EASE_OUT }}
          className="h-full"
        >
          <div className="arova-float-card arova-float-delay-5 arova-glass-card h-full rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#737B7B]">Personal Baseline Learning</span>
              <span className="font-mono tabular-nums text-[#008F00] font-semibold">
                <AnimatedNumber value={collectedSamples} />/{requiredSamples} samples
              </span>
            </div>
            <p className="text-base font-semibold text-[#202525] capitalize">{baselineStateLabel}</p>
            <div
              className="w-full h-2 rounded-full bg-[#EEF2F2] border border-[#D9E0E0] overflow-hidden"
              aria-hidden="true"
            >
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${baselinePct}%` }}
                transition={{ duration: 0.7, ease: EASE_OUT }}
                className="h-full rounded-full bg-[#00B800]"
              />
            </div>
            <p className="text-xs text-[#737B7B] leading-relaxed">
              {selectedPatient.baselineSource
                ? `Source: ${selectedPatient.baselineSource} (${
                    selectedPatient.baselineModelVersion || "local baseline"
                  }). `
                : "Tracks clean quality-filtered resting & active patterns separately per source. "}
              {selectedPatient.baselineActiveHrMean
                ? `Active HR ${selectedPatient.baselineActiveHrMean.toFixed(0)} BPM.`
                : ""}
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 0.46, delay: 0.16, ease: EASE_OUT }}
          className="h-full"
        >
          <div className="arova-float-card arova-float-delay-3 arova-glass-card h-full rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#737B7B]">AI Monitoring Engine</span>
              <div className="flex items-center gap-2">
                {latest && (
                  <span className="font-mono tabular-nums text-[#008F00] font-semibold">
                    score <AnimatedNumber value={latest.anomalyScore} decimals={3} />
                  </span>
                )}
                <span
                  className="w-8 h-8 rounded-lg bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center shrink-0"
                  aria-hidden="true"
                >
                  <Cpu className="w-4 h-4" />
                </span>
              </div>
            </div>
            <p className="text-base font-semibold text-[#202525]">
              {mlConnected ? "Isolation Forest Connected" : "Demo Mode (ML Service Not Connected)"}
            </p>
            <p className="text-xs text-[#737B7B] leading-relaxed">
              {latest?.anomalyStatus === "insufficient_baseline"
                ? "Insufficient personal baseline data — collecting clean readings before ML anomaly scoring."
                : latest?.anomalyStatus === "paused_poor_quality"
                ? "Anomaly scoring paused due to poor sensor contact or detached optical probe."
                : latest?.contributingFeatures && latest.contributingFeatures.length > 0
                ? `State: ${latest.anomalyStatus ?? "evaluated"} (${latest.alertLevel}) · Drivers: ${latest.contributingFeatures.join(", ")}.`
                : mlConnected
                ? "FastAPI scikit-learn Isolation Forest evaluating multi-feature vitals (dedicated ECG model not trained)."
                : "Running in development Demo Mode with windowed baseline & persistence checks until optional ML_SERVICE_URL is linked."}
            </p>
          </div>
        </motion.div>
      </section>

      <MlIntelligencePanel
        compact
        patient={selectedPatient}
        readings={readings}
        latestReading={latest}
        baselines={baselines}
        anomalyEvents={anomalyEvents}
        mlConnected={mlConnected}
        isAdminUser={isAdminUser}
        onNavigateTrends={() => onNavigate("trends")}
      />

      <CameraFallDetectionPanel />

      {/* 5. Main Chart + Alerts & Care Team Split */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.08 }}
        transition={{ duration: 0.52, ease: EASE_OUT }}
        className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
      >
        <div className="lg:col-span-8 space-y-6">
          <TelemetryCharts readings={readings} patient={selectedPatient} />
          <EcgWaveformPanel segments={ecgSegments} hideSampleLabel />
        </div>

        <div className="lg:col-span-4 space-y-6 arova-float-grid">
          {/* Recent Warnings & Alerts */}
          <div className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#D9E0E0]">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-[#202525]">Recent Warnings &amp; Alerts</h3>
                  {patientUnreadNotifications.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-amber-50 text-amber-800 border border-amber-300">
                      <Bell className="w-3 h-3 text-amber-600" />
                      {patientUnreadNotifications.length} unread
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#737B7B] mt-0.5">
                  Prototype monitoring notifications (not medical diagnoses)
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("assistant")}
                className="text-xs font-semibold text-[#008F00] hover:text-[#00B800] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Full Chat
              </button>
            </div>

            {patientAlerts.length === 0 ? (
              <div className="py-8 text-center text-sm text-[#737B7B] border border-dashed border-[#D9E0E0] rounded-xl bg-[#F7F9F9]">
                No active warnings or critical alerts for this patient.
              </div>
            ) : (
              <div className="divide-y divide-[#EEF2F2]">
                {patientAlerts.slice(0, 4).map((alert) => {
                  const unreadNotif = patientUnreadNotifications.find(
                    (n) => n.alertId === alert.alertId
                  );
                  const canPatientAck =
                    alert.status === "active" && !alert.patientAcknowledged && !alert.falseAlertReported;
                  const canReportFalse =
                    alert.status !== "resolved" && !alert.falseAlertReported;

                  return (
                    <div key={alert.alertId} className="py-3.5 first:pt-0 last:pb-0 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <AlertLevelLabel level={alert.level} />
                          {unreadNotif && (
                            <span className="text-[10px] font-mono font-semibold text-amber-800 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded">
                              unread
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-[#737B7B] font-mono tabular-nums">
                          {new Date(alert.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-[#202525]">
                        {cleanAlertText(alert.title)}
                      </p>
                      <p className="text-xs text-[#737B7B] leading-relaxed">
                        {cleanAlertText(alert.explanation)}
                      </p>
                      {alert.relevantReadingsSummary && (
                        <div className="text-[11px] font-mono text-[#008F00] bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg px-2.5 py-1">
                          {alert.relevantReadingsSummary}
                          {typeof alert.anomalyScore === "number"
                            ? ` · score ${alert.anomalyScore.toFixed(3)}`
                            : ""}
                        </div>
                      )}
                      <div className="text-[11px] text-[#737B7B] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>Status: {alert.status}</span>
                        {alert.patientAcknowledged && (
                          <span className="text-[#008F00] font-medium">
                            · Patient Acknowledged
                          </span>
                        )}
                        {alert.falseAlertReported && (
                          <span className="text-amber-700 font-medium">· Flagged False Alert</span>
                        )}
                        {alert.escalationStatus && (
                          <span className="font-mono">· {alert.escalationStatus}</span>
                        )}
                      </div>

                      {(canPatientAck || canReportFalse || unreadNotif) && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {canPatientAck && (
                            <button
                              type="button"
                              disabled={alertActionBusyId === alert.alertId}
                              onClick={() => void handlePatientAcknowledge(alert.alertId)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-md disabled:opacity-50 cursor-pointer transition-colors"
                            >
                              <Check className="w-3 h-3" />
                              Acknowledge Alert
                            </button>
                          )}
                          {canReportFalse && (
                            <button
                              type="button"
                              disabled={alertActionBusyId === alert.alertId}
                              onClick={() =>
                                setFalseAlertTargetId((prev) =>
                                  prev === alert.alertId ? null : alert.alertId
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-[#202525] bg-white border border-[#D9E0E0] rounded-md hover:border-[#00B800] hover:text-[#008F00] cursor-pointer transition-colors"
                            >
                              <Flag className="w-3 h-3" />
                              Report False Alert
                            </button>
                          )}
                          {unreadNotif && (
                            <button
                              type="button"
                              onClick={() => void markNotificationRead(unreadNotif.notificationId)}
                              className="px-2 py-1 text-[11px] text-[#008F00] hover:text-[#00B800] underline cursor-pointer"
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      )}

                      {falseAlertTargetId === alert.alertId && (
                        <div className="flex items-center gap-1.5 pt-1">
                          <input
                            type="text"
                            value={falseAlertReason}
                            onChange={(e) => setFalseAlertReason(e.target.value)}
                            placeholder="Reason (e.g., sensor moved, normal walk)..."
                            className="flex-1 px-2.5 py-1 text-xs bg-white text-[#202525] border border-[#D9E0E0] rounded-md focus:outline-none focus:border-[#00B800] placeholder:text-[#737B7B]"
                          />
                          <button
                            type="button"
                            disabled={alertActionBusyId === alert.alertId}
                            onClick={() => void handlePatientFalseAlertSubmit(alert.alertId)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-white bg-amber-600 rounded-md hover:bg-amber-700 cursor-pointer"
                          >
                            Submit
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Care Team & Assigned Wearable Card */}
          <div className="arova-float-card-subtle arova-float-delay-5 arova-glass-card rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-[#D9E0E0]">
              <div className="flex items-center gap-2">
                <span
                  className="w-8 h-8 rounded-lg bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center shrink-0"
                  aria-hidden="true"
                >
                  <Users className="w-4 h-4" />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-[#202525]">Care Support &amp; Device</h3>
                  <p className="text-xs text-[#737B7B]">Assigned escalation contacts &amp; node</p>
                </div>
              </div>
            </div>

            <dl className="space-y-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#737B7B]">Primary Caregiver</dt>
                <dd className="font-medium text-[#202525] text-right">
                  {selectedPatient.primaryCaregiverName || "Not assigned"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#737B7B]">Secondary Caregiver</dt>
                <dd className="font-medium text-[#202525] text-right">
                  {selectedPatient.secondaryCaregiverName || "Not assigned"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 pt-2 border-t border-[#D9E0E0]">
                <dt className="text-[#737B7B]">Wearable Node</dt>
                <dd className="font-medium text-[#202525] text-right">
                  {activeDevice ? cleanDeviceLabel(activeDevice.label) : "Unassigned"}
                </dd>
              </div>
              {activeDevice && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[#737B7B]">Sampling &amp; Firmware</dt>
                  <dd className="font-mono tabular-nums text-[#008F00] font-medium text-right">
                    {activeDevice.samplingIntervalMs} ms · {activeDevice.firmwareVersion}
                  </dd>
                </div>
              )}
            </dl>

            <div className="pt-2 border-t border-[#D9E0E0] grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onNavigate("caregiver")}
                className="arova-cta-secondary inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-[#008F00] bg-[#00B800]/10 border border-[#00B800]/30 rounded-lg hover:bg-[#00B800]/18 whitespace-nowrap cursor-pointer transition-colors"
              >
                <span>Caregiver View</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate("hardware")}
                className="arova-cta-secondary inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-lg hover:border-[#00B800] hover:text-[#008F00] whitespace-nowrap cursor-pointer transition-colors"
              >
                <span>Device Setup</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Ask AROVA Assistant Inline Quick Card */}
          <div className="arova-float-card-subtle arova-float-delay-6 arova-glass-card rounded-2xl p-5 sm:p-6 space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#D9E0E0]">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#00B800] shrink-0 arova-status-normal-dot" />
                <div>
                  <h3 className="text-sm font-semibold text-[#202525]">Ask AROVA Assistant</h3>
                  <p className="text-[11px] text-[#737B7B]">
                    Grounded in recorded telemetry only (non-diagnostic)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate("assistant")}
                className="text-xs font-semibold text-[#008F00] hover:underline whitespace-nowrap cursor-pointer"
              >
                Open →
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={quickLoading}
                onClick={() =>
                  void handleAskQuickAssistant("Explain my latest recorded readings in simple terms.")
                }
                className="px-2.5 py-1 text-[11px] bg-[#F7F9F9] hover:border-[#00B800] hover:text-[#008F00] text-[#202525] border border-[#D9E0E0] rounded-md cursor-pointer transition-colors"
              >
                Explain latest readings
              </button>
              <button
                type="button"
                disabled={quickLoading}
                onClick={() =>
                  void handleAskQuickAssistant("Why was the latest prototype alert generated?")
                }
                className="px-2.5 py-1 text-[11px] bg-[#F7F9F9] hover:border-[#00B800] hover:text-[#008F00] text-[#202525] border border-[#D9E0E0] rounded-md cursor-pointer transition-colors"
              >
                Why did alert trigger?
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleAskQuickAssistant(quickQuestion);
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={quickQuestion}
                onChange={(e) => setQuickQuestion(e.target.value)}
                placeholder="Ask about readings or alerts..."
                className="flex-1 px-2.5 py-1.5 text-xs bg-white text-[#202525] border border-[#D9E0E0] rounded-lg focus:outline-none focus:border-[#00B800] placeholder:text-[#737B7B]"
              />
              <button
                type="submit"
                disabled={quickLoading || !quickQuestion.trim()}
                aria-label="Ask AROVA Assistant"
                className="p-2 text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>

            {quickLoading && (
              <div className="flex items-center gap-2 text-xs text-[#737B7B]">
                <div className="flex items-center gap-1" aria-hidden="true">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#00B800] arova-typing-dot"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#008F00] arova-typing-dot"
                    style={{ animationDelay: "160ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#009900] arova-typing-dot"
                    style={{ animationDelay: "320ms" }}
                  />
                </div>
                <span>Reviewing recorded readings with Gemini...</span>
              </div>
            )}
            {quickError && (
              <p className="text-xs text-red-800 bg-red-50 border border-red-300 rounded-lg px-2.5 py-1.5">
                {quickError}
              </p>
            )}
            {quickAnswer && !quickLoading && (
              <div className="text-xs text-[#202525] bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                {quickAnswer}
              </div>
            )}
          </div>
        </div>
      </motion.div>

      <AiOutboundCallModal
        open={callModalOpen}
        onClose={() => setCallModalOpen(false)}
        twilioConfigured={Boolean(integrations?.outboundTwilio?.configured)}
        missingEnvVars={integrations?.outboundTwilio?.missingEnvVars ?? []}
        telemetrySummary={
          latest
            ? `Heart Rate: ${hrValue !== null ? `${Math.round(hrValue)} BPM` : "unavailable"}, SpO2: ${
                spo2Value !== null ? `${spo2Value.toFixed(1)}%` : "unavailable"
              }, Temperature: ${
                tempValue !== null ? `${tempValue.toFixed(1)} C` : "unavailable"
              }, Movement: ${latest.movementStatus}, Alert Level: ${latest.alertLevel}, Baseline: ${baselineStateLabel} (${collectedSamples}/${requiredSamples}).`
            : `Baseline: ${baselineStateLabel} (${collectedSamples}/${requiredSamples}).`
        }
      />
    </div>
  );
}
