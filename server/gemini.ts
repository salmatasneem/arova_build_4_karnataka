import { GoogleGenAI, ThinkingLevel } from "@google/genai";

let cachedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY is not configured in server secrets.");
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return cachedClient;
}

export interface AssistantContextPayload {
  role: "patient" | "caregiver" | "admin";
  patientId?: string;
  patientOwnerUid?: string;
  patientName: string;
  dataMode: "sample" | "live";
  baselineStatus: string;
  baselineSummary: string;
  baselineStats?: {
    means?: Record<string, number | undefined>;
    medians?: Record<string, number | undefined>;
    stds?: Record<string, number | undefined>;
  } | null;
  latestReading?: {
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    movementStatus: string;
    signalQuality: string;
    alertLevel: string;
    anomalyScore: number;
    source: string;
    explanation: string;
    timestamp: string;
  } | null;
  recentReadings: Array<{
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    movementStatus: string;
    alertLevel: string;
    timestamp: string;
  }>;
  recentAlerts: Array<{
    level: string;
    status: string;
    title: string;
    explanation: string;
    callEscalationStatus: string;
    anomalyScore?: number;
    relevantReadings?: {
      heartRate?: number | null;
      spo2?: number | null;
      temperatureC?: number | null;
      accelMagnitude?: number;
    };
    falseAlertReported?: boolean;
    followUpAction?: string;
    notificationStatus?: string;
    escalationStatus?: string;
    escalationHistory?: Array<{ stage: string; summary: string; timestamp: string }>;
    timestamp: string;
  }>;
}

export async function askSmartCareAssistant(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  context: AssistantContextPayload
): Promise<string> {
  const ai = getGeminiClient();

  const systemInstruction = `You are the AROVA AI Assistant inside a wearable-based early warning monitoring prototype.

CAPABILITIES:
- Explain recorded MAX30102 heart rate & SpO2, MPU6050 motion, temperature, and optional ECG readings in simple, accurate language.
- Explain Isolation Forest anomaly scores, personalized baseline comparisons (means/medians/standard deviations), and recent monitoring trends.
- Explain why a prototype Warning or Critical alert was generated, including its readings snapshot, acknowledgement status, escalation timeline, or false-alert status.
- Answer general questions about how to use AROVA features (Personal Baseline, Simulator vs Hardware Mode, Caregiver Linking, Alerts & Escalation, Dataset Lab).

STRICT SAFETY & TRANSPARENCY GUARDRAILS:
1. NEVER diagnose any disease, illness, or medical condition.
2. NEVER prescribe medication or give medical treatment instructions.
3. NEVER claim that AROVA predicts medical emergencies or guarantees clinical safety—state clearly that AROVA alerts are prototype monitoring notifications, not medical diagnoses, and advise seeking qualified medical evaluation for real health concerns.
4. ONLY cite numbers, alerts, and timestamps present in the authorized JSON context below. NEVER invent or guess missing readings; if a sensor value is null, missing, or recentReadings is empty, state transparently that the measurement is currently unavailable.
5. Be explicit about data origin: if context.dataMode is "sample" or readings have source "simulator" or "sample_demo", clearly note that the values are simulated/demonstration telemetry rather than live physical ESP32 sensor readings.
6. Tailor clarity to the user's role (${context.role}):
   - For patients: calm, everyday explanations and practical AROVA guidance.
   - For caregivers: concise trend summaries, alert causes, acknowledgement/escalation state, and follow-up context.
   - For administrators: accurate technical telemetry, baseline readiness, notification mode, and system details.`;

  const contextBlock = JSON.stringify(context, null, 2);
  const historyTranscript = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const prompt = `CURRENT MONITORED CONTEXT (JSON):
${contextBlock}

RECENT CONVERSATION:
${historyTranscript || "(none)"}

USER QUESTION:
${question}`;

  const retryDelaysMs = [500, 1200];
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const text = response.text?.trim();
      if (!text) {
        throw new Error("Gemini returned an empty response.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("429");
      if (isTransient && attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Gemini request failed.");
}
