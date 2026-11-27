import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Info, PhoneCall, Send, Sparkles } from "lucide-react";
import { AiOutboundCallModal } from "../components/AiOutboundCallModal.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import { askGeminiAssistant } from "../services/apiClient.ts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const QUICK_PROMPTS = [
  "Why was the latest prototype alert triggered, and what is its escalation status?",
  "Explain the latest alert using the recorded readings.",
  "Summarize recent health trends in plain language for a caregiver.",
  "How do personal baseline learning and sensor quality checks work?",
  "What is the difference between sample demo mode and live ESP32 hardware?",
];

export function AiAssistantPage() {
  const {
    activeRole,
    selectedPatient,
    readings,
    alerts,
    usingSampleData,
    liveHardwareSnapshot,
    integrations,
  } = useSmartCare();
  const [callModalOpen, setCallModalOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hello. I am the AROVA Health Assistant. I can explain recorded wearable readings, baseline comparisons, and alert triggers in plain language. I do not diagnose medical conditions or declare medical emergencies.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendQuestion = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setErrorMsg(null);

    const latest = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;

    try {
      const answer = await askGeminiAssistant({
        question: trimmed,
        history: messages,
        context: {
          role: activeRole,
          patientId: selectedPatient.patientId,
          patientOwnerUid: selectedPatient.ownerUid,
          patientName: selectedPatient.displayName,
          dataMode: usingSampleData ? "sample" : selectedPatient.dataMode,
          baselineStatus: selectedPatient.baselineStatus,
          baselineSummary: `Samples: ${selectedPatient.baselineSamplesCount}, Mean HR: ${
            selectedPatient.baselineHeartRateMean ?? "n/a"
          } BPM, Mean SpO2: ${selectedPatient.baselineSpo2Mean ?? "n/a"}%, Mean Temp: ${
            selectedPatient.baselineTempMean ?? "n/a"
          } C`,
          baselineStats: {
            heartRateMean: selectedPatient.baselineHeartRateMean,
            spo2Mean: selectedPatient.baselineSpo2Mean,
            tempMean: selectedPatient.baselineTempMean,
            sampleCount: selectedPatient.baselineSamplesCount,
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
          recentReadings: readings.slice(-8).map((r) => ({
            heartRate: r.heartRate,
            spo2: r.spo2,
            temperatureC: r.temperatureC,
            movementStatus: r.movementStatus,
            alertLevel: r.alertLevel,
            timestamp: r.createdAt,
          })),
          recentAlerts: alerts
            .filter((a) => a.patientId === selectedPatient.patientId)
            .slice(0, 5)
            .map((a) => ({
              level: a.level,
              status: a.status,
              title: a.title,
              explanation: a.explanation,
              anomalyScore: a.anomalyScore,
              relevantReadings: a.relevantReadings
                ? {
                    heartRate: a.relevantReadings.heartRate,
                    spo2: a.relevantReadings.spo2,
                    temperatureC: a.relevantReadings.temperatureC,
                    movementStatus: a.relevantReadings.movementStatus,
                    signalQuality: a.relevantReadings.signalQuality,
                  }
                : undefined,
              falseAlertReported: a.falseAlertReported,
              followUpAction: a.followUpAction,
              notificationStatus: a.notificationStatus,
              escalationStatus: a.escalationStatus,
              escalationHistory: a.escalationHistory?.map((h) => ({
                stage: h.stage,
                summary: h.summary,
                timestamp: h.timestamp,
              })),
              callEscalationStatus: a.callEscalationStatus,
              timestamp: a.createdAt,
            })),
        },
      });

      setMessages((prev) => [...prev, { role: "assistant", content: answer }]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not reach Gemini assistant.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="max-w-4xl space-y-4 arova-float-grid"
    >
      <div className="arova-float-card-subtle arova-float-delay-1 arova-glass-card border-[#D9E0E0] rounded-2xl px-4 py-3 flex items-start gap-3 text-xs text-[#737B7B]">
        <Info className="w-4 h-4 text-[#00B800] shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-[#202525]">Safety &amp; Clinical Boundary:</span>{" "}
          This assistant summarizes recorded AROVA telemetry for informational clarity. It never
          diagnoses medical conditions or replaces a clinician or emergency services.
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
        className="arova-glass-card rounded-2xl flex flex-col h-[580px] overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-[#1E2525] bg-[#080B0B] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-8 h-8 rounded-xl bg-[#00B800]/15 border border-[#00B800]/40 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-[#00B800] arova-status-normal-dot" />
            </span>
            <h2 className="text-sm font-semibold text-white truncate">
              AROVA Assistant · Context: {selectedPatient.displayName}
            </h2>
          </div>
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setCallModalOpen(true)}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg cursor-pointer whitespace-nowrap transition-colors"
            >
              <PhoneCall className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Call Me with AI</span>
            </button>
            <span className="text-xs text-[#D9E0E0] font-mono hidden sm:inline px-2 py-1 rounded bg-[#141A1A] border border-[#283232]">
              {usingSampleData ? "local_mode" : selectedPatient.dataMode}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-white">
          <AnimatePresence initial={false}>
            {messages.map((msg, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-[#00B800] text-white shadow-sm"
                      : "bg-[#F7F9F9] border border-[#D9E0E0] text-[#202525]"
                  }`}
                >
                  {msg.content}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {loading && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] w-fit text-xs text-[#737B7B]"
            >
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
              <span>Analyzing recorded readings with Gemini...</span>
            </motion.div>
          )}

          {errorMsg && (
            <div className="text-xs text-red-800 bg-red-50 border border-red-300 rounded-xl px-3.5 py-2.5">
              {errorMsg}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="px-5 py-2.5 border-t border-[#D9E0E0] bg-[#F7F9F9] flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void sendQuestion(q)}
              disabled={loading}
              className="px-2.5 py-1 text-xs bg-white hover:border-[#00B800] hover:text-[#008F00] text-[#202525] border border-[#D9E0E0] rounded-lg transition-colors text-left cursor-pointer disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendQuestion(input);
          }}
          className="p-4 border-t border-[#D9E0E0] bg-[#EEF2F2] flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about recent trends, alert explanations, or system behavior..."
            className="flex-1 px-3.5 py-2.5 text-sm text-[#202525] bg-white border border-[#D9E0E0] rounded-xl focus:outline-none focus:border-[#00B800] placeholder:text-[#737B7B]"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <Send className="w-4 h-4" />
            Ask
          </button>
        </form>
      </motion.div>

      <AiOutboundCallModal
        open={callModalOpen}
        onClose={() => setCallModalOpen(false)}
        twilioConfigured={Boolean(integrations?.outboundTwilio?.configured)}
        missingEnvVars={integrations?.outboundTwilio?.missingEnvVars ?? []}
        telemetrySummary={(() => {
          const latest = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;
          if (!latest) return `Baseline status: ${selectedPatient.baselineStatus}.`;
          return `Heart Rate: ${latest.heartRate ?? "unavailable"} BPM, SpO2: ${
            latest.spo2 ?? "unavailable"
          }%, Temperature: ${latest.temperatureC ?? "unavailable"} C, Movement: ${
            latest.movementStatus
          }, Alert Level: ${latest.alertLevel}, Baseline: ${selectedPatient.baselineStatus}.`;
        })()}
      />
    </motion.div>
  );
}
