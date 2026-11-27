import type { Server as HttpServer } from "node:http";
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  Type,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { WebSocket, WebSocketServer } from "ws";
import { TwilioGeminiAudioConverter } from "./audioCodec.ts";
import {
  applyTwilioWebhookUpdate,
  getOutboundCallContext,
  hasStoredOutboundCall,
  markOutboundCallFailure,
  verifyStreamToken,
  type CaregiverResponseCategory,
  type SupportedVoiceLanguage,
  type VoiceCallContext,
} from "./outboundVoice.ts";

const GEMINI_LIVE_MODEL = "gemini-3.8-live";
const GEMINI_CLASSIFIER_MODEL = "gemini-4-hydrogen";
const STREAM_PATH = "/api/voice/outbound/stream";
export const BROWSER_STREAM_PATH = "/api/voice/browser/stream";

export interface CaregiverClassificationResult {
  caregiverResponse: CaregiverResponseCategory;
  selectedLanguage: SupportedVoiceLanguage;
  followUpAction: string;
  responseSummary: string;
}

type CaregiverResponseListener = (
  callId: string,
  result: CaregiverClassificationResult,
  isFinal: boolean
) => void;

const responseListeners = new Set<CaregiverResponseListener>();

export function registerCaregiverResponseListener(
  listener: CaregiverResponseListener
): () => void {
  responseListeners.add(listener);
  return () => {
    responseListeners.delete(listener);
  };
}

function notifyCaregiverResponse(
  callId: string,
  result: CaregiverClassificationResult,
  isFinal: boolean
): void {
  for (const listener of responseListeners) {
    try {
      listener(callId, result, isFinal);
    } catch (err) {
      console.error("Caregiver response listener error:", err);
    }
  }
}

export const CAREGIVER_RESPONSE_CATEGORIES: CaregiverResponseCategory[] = [
  "Will check immediately",
  "Already checking on the patient",
  "Patient is safe",
  "Unable to assist",
  "Not available",
  "Requests another contact",
  "Needs emergency assistance",
  "Unclear response",
];

function languageDisplayName(lang: SupportedVoiceLanguage): string {
  switch (lang) {
    case "kn":
      return "Kannada";
    case "hi":
      return "Hindi";
    default:
      return "English";
  }
}

export function buildArovaVoiceSystemInstruction(context?: VoiceCallContext | null): string {
  if (!context || context.callType === "direct_outbound") {
    const telemetryBlock = context?.telemetrySummary
      ? `\nCURRENT WEARABLE TELEMETRY CONTEXT (use when the user asks about their readings or status):\n${context.telemetrySummary}\n`
      : "";
    return `You are the AROVA AI Health Monitoring Voice Assistant speaking in a real-time two-way voice conversation for an intelligent wearable health monitoring platform.
${telemetryBlock}
VOICE CONVERSATION GUIDELINES:
1. Speak warmly, calmly, clearly, and naturally in concise conversational sentences suitable for spoken audio (1-4 sentences per answer).
2. Do not read out markdown, bullet points, asterisks, or raw JSON.
3. Introduce yourself clearly when the session begins as the AROVA AI Health Monitoring Assistant, explain that you can answer any question about their recorded wearable readings, baselines, alerts, or health monitoring, and invite their question.
4. QUESTION ANSWERING PRIORITY: Whenever the user asks ANY question (whether spoken into the microphone or sent as text), listen carefully and answer their question directly, accurately, and helpfully right away using the recorded AROVA telemetry context when available, then briefly ask if they have another question.
5. Listen attentively, detect the speaker's language (English, Kannada, or Hindi), and switch languages smoothly if they speak or ask in Kannada or Hindi.
6. Allow the user to interrupt or ask follow-up questions at any time.
7. STRICT CLINICAL GUARDRAIL: Never diagnose diseases, prescribe medications, or claim emergency clinical certification. For urgent symptoms or medical emergencies, clearly advise contacting local emergency services immediately.`;
  }

  const authorizedName =
    context.authorizedForPatientIdentity && context.patientName
      ? context.patientName
      : "your registered family member";

  const identityRule = context.authorizedForPatientIdentity
    ? `PATIENT IDENTITY AUTHORIZATION: Caregiver IS authorized to hear the patient's name (${authorizedName}).`
    : `PATIENT IDENTITY AUTHORIZATION: Caregiver is NOT authorized to hear the patient's personal name. Refer ONLY to "your registered family member" and NEVER disclose any personal name.`;

  const readingScriptLine =
    context.authorizedForHealthReadings && context.parameter && context.readingValue
      ? `We detected an unusual reading for ${authorizedName}. The recorded ${context.parameter} is ${context.readingValue}${
          context.readingUnit ? ` ${context.readingUnit}` : ""
        }, which is outside the configured monitoring threshold. We are contacting you to request that you check on the patient.`
      : null;

  const readingsRule = context.authorizedForHealthReadings
    ? `HEALTH READINGS AUTHORIZATION: Caregiver IS authorized to hear the triggering reading details.
- Reason script when explaining why you called: "${readingScriptLine || context.reasonForCalling || "An unusual health monitoring event was detected."}"
- Event severity: ${context.alertSeverity ?? "High"}
- Event timestamp: ${context.eventTimestamp ?? "Just now"}
- Additional context: ${context.thresholdContext ?? "Configured personalized monitoring threshold exceeded."}`
    : `HEALTH READINGS AUTHORIZATION: Caregiver is NOT authorized to receive specific vital numbers or parameter measurements. State ONLY that an unusual health monitoring event requires immediate check-in, and do NOT disclose specific heart rate, SpO2, temperature, or ECG numbers.`;

  const testNote =
    context.callType === "test_call"
      ? "\nCALL MODE: Administrator Test Call — clearly mention early on that this is an authorized Arova AI system verification test call for caregiver readiness, while demonstrating the exact notification flow."
      : "";

  return `You are Arova AI Health Monitoring Assistant calling an authorized registered caregiver (${
    context.caregiverName || "Registered Caregiver"
  }, priority: ${context.caregiverPriority || "primary"}) regarding a health monitoring alert.${testNote}

MULTILINGUAL BEHAVIOR (ENGLISH, KANNADA, HINDI):
1. Initial preferred language: ${languageDisplayName(context.preferredLanguage)}.
2. You are fluent in English, Kannada, and Hindi. Automatically detect which of these three languages the caregiver speaks and respond fluently in that language.
3. If the caregiver asks to switch languages or begins speaking Kannada or Hindi (or English) mid-call, switch immediately and naturally without hesitation.

OPENING SCRIPT (Speak warmly and clearly as soon as the caregiver answers):
- In English, open with:
  "Hello, this is Arova AI Health Monitoring Assistant. We have detected an unusual health monitoring event for your registered family member. These recent readings require your attention. Please check on them immediately. Are you able to assist?"
- If preferred language is Kannada or Hindi, convey that exact message faithfully and naturally in ${languageDisplayName(
    context.preferredLanguage
  )}.

${identityRule}
${readingsRule}

CAREGIVER FOLLOW-UP & RESPONSE CAPTURE:
1. Whenever the caregiver or tester asks a question (about the alert, authorized readings, or AROVA), answer their question directly and clearly first before returning to the check-in.
2. Ask clearly whether the caregiver can check on the patient immediately, is already checking, reports the patient is safe, cannot assist right now, wants another caregiver contacted, or needs emergency assistance.
3. Listen carefully to short answers, clarifications, and natural interruptions. Keep your responses concise, calm, and respectful for phone audio (1-3 short sentences per turn).
4. If the caregiver cannot assist, is unavailable, or asks for another caregiver, confirm politely that Arova AI will escalate to the next registered caregiver immediately.
5. EMERGENCY FALLBACK INSTRUCTION: Whenever the caregiver states the patient is unresponsive, in distress, needs emergency help, or asks what to do in an emergency, clearly instruct them to contact local emergency services immediately.
6. STRICT CLINICAL GUARDRAIL: Never diagnose medical conditions, prescribe medications, or claim clinical certification. Never read markdown, asterisks, or raw code.`;
}

export function buildOpeningPromptText(context?: VoiceCallContext | null): string {
  if (!context || context.callType === "direct_outbound") {
    return "The user has just started the voice session. Warmly greet them in 1-2 short sentences as the AROVA AI Voice Assistant and ask what question you can help answer today.";
  }

  const langName = languageDisplayName(context.preferredLanguage);
  if (context.preferredLanguage === "en") {
    return `The caregiver has just answered the phone call. Deliver this exact opening message warmly and clearly: "Hello, this is Arova AI Health Monitoring Assistant. We have detected an unusual health monitoring event for your registered family member. These recent readings require your attention. Please check on them immediately. Are you able to assist?"`;
  }

  return `The caregiver has just answered the phone call. Speak warmly in ${langName} delivering the exact Arova AI Health Monitoring Assistant opening notification: introduce yourself as Arova AI Health Monitoring Assistant, state that an unusual health monitoring event was detected for their registered family member requiring immediate attention, ask them to check immediately, and ask if they are able to assist.`;
}

export function classifyCaregiverTextDeterministic(
  transcript: string,
  fallbackLang: SupportedVoiceLanguage = "en"
): CaregiverClassificationResult {
  const raw = transcript.trim();
  const lower = raw.toLowerCase();

  let selectedLanguage: SupportedVoiceLanguage = fallbackLang;
  if (/[\u0C80-\u0CFF]/.test(raw) || /\b(kannada|maadthini|nodthini|illa|beku|sahaya|aagalla|chennagidare)\b/i.test(lower)) {
    selectedLanguage = "kn";
  } else if (/[\u0900-\u097F]/.test(raw) || /\b(hindi|hoon|dekh|nahi|madad|theek|bulao|karunga|karungi)\b/i.test(lower)) {
    selectedLanguage = "hi";
  } else if (raw.length > 0) {
    selectedLanguage = "en";
  }

  if (!raw) {
    return {
      caregiverResponse: "Unclear response",
      selectedLanguage,
      followUpAction: "No verbal caregiver response captured; verify manually.",
      responseSummary: "No verbal response captured during call.",
    };
  }

  if (
    /\b(911|108|112|ambulance|emergency|hospital|paramedic|unconscious|not breathing|cardiac|urgent help|madad chahiye|turant madad)\b/i.test(
      lower
    ) ||
    /(ತುರ್ತು|ಆಂಬ್ಯುಲೆನ್ಸ್|आपातकाल|एम्बुलेंस)/.test(raw)
  ) {
    return {
      caregiverResponse: "Needs emergency assistance",
      selectedLanguage,
      followUpAction: "Advised caregiver to contact local emergency services immediately; alert remains active.",
      responseSummary: "Caregiver indicated emergency assistance is required.",
    };
  }

  if (
    /\b(call someone else|another contact|other caregiver|call secondary|try next|call my|next person|doosre ko|dusre ko|bereyavarige)\b/i.test(
      lower
    ) ||
    /(ಬೇರೆಯವರಿಗೆ|दूसरे संपर्क)/.test(raw)
  ) {
    return {
      caregiverResponse: "Requests another contact",
      selectedLanguage,
      followUpAction: "Escalate immediately to next registered caregiver in priority chain.",
      responseSummary: "Caregiver requested contacting another caregiver.",
    };
  }

  if (
    /\b(already checking|with (him|her|them) now|right next to|checking right now|on my way right now|dekh raha|dekh rahi|nodtha iddini)\b/i.test(
      lower
    ) ||
    /(ನೋಡುತ್ತಿದ್ದೇನೆ|देख रहा|देख रही)/.test(raw)
  ) {
    return {
      caregiverResponse: "Already checking on the patient",
      selectedLanguage,
      followUpAction: "Caregiver is already checking on patient; keep emergency active until safety confirmed.",
      responseSummary: "Caregiver reported already checking on the patient.",
    };
  }

  if (
    /\b(patient is safe|she is fine|he is fine|they are fine|doing fine|everything is okay|safe now|all good|theek hai|chennagidare)\b/i.test(
      lower
    ) ||
    /(ಚೆನ್ನಾಗಿದ್ದಾರೆ|ಸುರಕ್ಷಿತ|ठीक है|सुरक्षित)/.test(raw)
  ) {
    return {
      caregiverResponse: "Patient is safe",
      selectedLanguage,
      followUpAction: "Caregiver reported patient is safe; await explicit dashboard confirmation to resolve.",
      responseSummary: "Caregiver reported that the patient is safe.",
    };
  }

  if (
    /\b(not available|unavailable|out of town|far away|cannot reach|in a meeting|driving|busy right now|not home|nahi aa sakta|available nahi)\b/i.test(
      lower
    ) ||
    /(ಇಲ್ಲ|ಸಿಗುವುದಿಲ್ಲ|उपलब्ध नहीं)/.test(raw)
  ) {
    return {
      caregiverResponse: "Not available",
      selectedLanguage,
      followUpAction: "Caregiver unavailable; escalate to secondary caregiver immediately.",
      responseSummary: "Caregiver stated they are not available.",
    };
  }

  if (
    /\b(unable to assist|can't help|cannot help|can't check|cannot check|unable to check|no i can't|sorry no|aagalla|madakke aagalla)\b/i.test(
      lower
    ) ||
    /(नहीं कर सकता|ಮಾದಲು ಸಾಧ್ಯವಿಲ್ಲ|ಸಾಧ್ಯವಿಲ್ಲ|ಮಾಡಲು ಸಾಧ್ಯವಿಲ್ಲ)/.test(raw)
  ) {
    return {
      caregiverResponse: "Unable to assist",
      selectedLanguage,
      followUpAction: "Caregiver unable to assist; escalate to secondary caregiver immediately.",
      responseSummary: "Caregiver stated they are unable to assist.",
    };
  }

  if (
    /\b(yes|will check|i'll check|checking immediately|on it|going now|right away|sure|okay|ok|haan|ha|karunga|ja raha|nodthini)\b/i.test(
      lower
    ) ||
    /(ಹೌದು|ನೋಡುತ್ತೇನೆ|हाँ|जा रहा)/.test(raw)
  ) {
    return {
      caregiverResponse: "Will check immediately",
      selectedLanguage,
      followUpAction: "Caregiver confirmed they will check immediately; await patient safety follow-up.",
      responseSummary: "Caregiver agreed to check on the patient immediately.",
    };
  }

  return {
    caregiverResponse: "Unclear response",
    selectedLanguage,
    followUpAction: "Caregiver response unclear; human follow-up or retry verification advised.",
    responseSummary: "Caregiver spoke, but intent could not be clearly determined.",
  };
}

function extractLiveErrorMessage(errEvent: unknown, fallback: string): string {
  if (errEvent instanceof Error && errEvent.message) {
    return errEvent.message;
  }
  if (errEvent && typeof errEvent === "object") {
    const maybe = errEvent as {
      message?: unknown;
      reason?: unknown;
      error?: unknown;
      type?: unknown;
    };
    if (typeof maybe.message === "string" && maybe.message.trim()) {
      return maybe.message.trim();
    }
    if (maybe.error instanceof Error && maybe.error.message) {
      return maybe.error.message;
    }
    if (maybe.error && typeof maybe.error === "object") {
      const nested = maybe.error as { message?: unknown };
      if (typeof nested.message === "string" && nested.message.trim()) {
        return nested.message.trim();
      }
    }
    if (typeof maybe.reason === "string" && maybe.reason.trim()) {
      return maybe.reason.trim();
    }
  }
  return fallback;
}

function getLiveGeminiClient(forLiveWs = false): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(forLiveWs ? { apiVersion: "v1beta" } : {}),
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

export async function classifyCaregiverConversation(params: {
  caregiverTranscript: string;
  assistantTranscript: string;
  fallbackLanguage: SupportedVoiceLanguage;
}): Promise<CaregiverClassificationResult> {
  const trimmedInput = params.caregiverTranscript.trim();
  if (!trimmedInput) {
    return classifyCaregiverTextDeterministic("", params.fallbackLanguage);
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return classifyCaregiverTextDeterministic(trimmedInput, params.fallbackLanguage);
  }

  try {
    const ai = getLiveGeminiClient();
    const response = await ai.models.generateContent({
      model: GEMINI_CLASSIFIER_MODEL,
      contents: `Classify the caregiver's spoken responses from an Arova AI health monitoring phone call.
Supported languages: "en" (English), "kn" (Kannada), "hi" (Hindi).

ASSISTANT TURNS (for context only):
${params.assistantTranscript.slice(-1200) || "(none)"}

CAREGIVER UTTERANCES:
${trimmedInput.slice(-1500)}

Return JSON matching the schema with:
- caregiverResponse: exact category from the enum
- selectedLanguage: "en", "kn", or "hi" detected from caregiver utterances
- followUpAction: concise 1-sentence operational next step (max 220 chars, no raw transcript quotes)
- responseSummary: concise 1-sentence summary of caregiver's intent (max 240 chars)`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            caregiverResponse: {
              type: Type.STRING,
              enum: CAREGIVER_RESPONSE_CATEGORIES,
            },
            selectedLanguage: {
              type: Type.STRING,
              enum: ["en", "kn", "hi"],
            },
            followUpAction: { type: Type.STRING },
            responseSummary: { type: Type.STRING },
          },
          required: [
            "caregiverResponse",
            "selectedLanguage",
            "followUpAction",
            "responseSummary",
          ],
        },
      },
    });

    const parsed = JSON.parse(response.text || "{}") as Partial<CaregiverClassificationResult>;
    if (
      parsed.caregiverResponse &&
      CAREGIVER_RESPONSE_CATEGORIES.includes(parsed.caregiverResponse) &&
      (parsed.selectedLanguage === "en" ||
        parsed.selectedLanguage === "kn" ||
        parsed.selectedLanguage === "hi")
    ) {
      return {
        caregiverResponse: parsed.caregiverResponse,
        selectedLanguage: parsed.selectedLanguage,
        followUpAction: (parsed.followUpAction || "Follow up with caregiver.").slice(0, 280),
        responseSummary: (parsed.responseSummary || "Caregiver response recorded.").slice(0, 480),
      };
    }
  } catch (err) {
    console.warn("Falling back to deterministic caregiver response classifier:", err);
  }

  return classifyCaregiverTextDeterministic(trimmedInput, params.fallbackLanguage);
}

const activeBridges = new Map<string, () => void>();

export function closeActiveVoiceBridge(callId: string): void {
  const closeFn = activeBridges.get(callId);
  if (closeFn) {
    closeFn();
    activeBridges.delete(callId);
  }
}

export function buildBrowserVoiceSessionContext(searchParams: URLSearchParams): VoiceCallContext | null {
  const mode = searchParams.get("mode")?.trim() || "assistant";
  const rawLang = searchParams.get("language")?.trim() || "en";
  const preferredLanguage: SupportedVoiceLanguage =
    rawLang === "kn" || rawLang === "hi" ? rawLang : "en";

  if (mode !== "caregiver_alert") {
    const rawTelemetry = (searchParams.get("telemetrySummary") || "").trim().slice(0, 400);
    return {
      callType: "direct_outbound",
      preferredLanguage,
      authorizedForPatientIdentity: false,
      authorizedForHealthReadings: false,
      explicitCallConsent: true,
      retryCount: 0,
      ...(rawTelemetry ? { telemetrySummary: rawTelemetry } : {}),
    };
  }

  const patientName = (searchParams.get("patientName") || "Monitored Patient").trim().slice(0, 100);
  const caregiverName = (searchParams.get("caregiverName") || "Browser Tester").trim().slice(0, 100);
  const parameter = (searchParams.get("parameter") || "Heart Rate").trim().slice(0, 60);
  const readingValue = (searchParams.get("readingValue") || "118").trim().slice(0, 40);
  const readingUnit = (searchParams.get("readingUnit") || "BPM").trim().slice(0, 20);
  const authorizedForPatientIdentity = searchParams.get("authorizedForPatientIdentity") !== "false";
  const authorizedForHealthReadings = searchParams.get("authorizedForHealthReadings") !== "false";

  return {
    callType: "test_call",
    patientId: "browser_voice_test",
    patientName,
    alertSeverity: "Test",
    parameter,
    readingValue,
    readingUnit,
    thresholdContext: "Browser-based Arova AI emergency voice simulation test",
    reasonForCalling: "Browser verification test for Arova AI emergency caregiver voice assistant.",
    relevantReading: `${parameter}: ${readingValue}${readingUnit ? ` ${readingUnit}` : ""}`,
    eventTimestamp: new Date().toISOString(),
    caregiverName,
    caregiverPriority: "test",
    preferredLanguage,
    authorizedForPatientIdentity,
    authorizedForHealthReadings,
    explicitCallConsent: true,
    retryCount: 0,
  };
}

export function attachTwilioMediaStreamServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const host = req.headers.host || "localhost";
      const parsed = new URL(req.url || "/", `https://${host}`);
      if (parsed.pathname === STREAM_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
        return;
      }
      if (parsed.pathname === BROWSER_STREAM_PATH) {
        browserWss.handleUpgrade(req, socket, head, (ws) => {
          browserWss.emit("connection", ws, req);
        });
        return;
      }
      return;
    } catch {
      socket.destroy();
    }
  });

  browserWss.on("connection", (clientWs: WebSocket, req) => {
    const host = req.headers.host || "localhost";
    const parsedUrl = new URL(req.url || BROWSER_STREAM_PATH, `https://${host}`);
    const callContext = buildBrowserVoiceSessionContext(parsedUrl.searchParams);
    const isCaregiverAlertMode = callContext?.callType === "test_call";

    let geminiSession: Session | null = null;
    let closed = false;
    let greetingSent = false;
    const caregiverTranscriptParts: string[] = [];
    const assistantTranscriptParts: string[] = [];
    let classificationInFlight = false;

    const sendJson = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const runBrowserClassification = async () => {
      if (classificationInFlight) return;
      const caregiverText = caregiverTranscriptParts.join(" ").trim();
      if (!caregiverText) return;
      classificationInFlight = true;
      try {
        const result = await classifyCaregiverConversation({
          caregiverTranscript: caregiverText,
          assistantTranscript: assistantTranscriptParts.join(" ").trim(),
          fallbackLanguage: callContext?.preferredLanguage ?? "en",
        });
        sendJson({ type: "classification", result });
      } finally {
        classificationInFlight = false;
      }
    };

    const maxSessionTimer = setTimeout(() => {
      cleanup("Browser voice test session reached the 10-minute limit.");
    }, 10 * 60 * 1000);

    function cleanup(errorMessage?: string) {
      if (closed) return;
      closed = true;
      clearTimeout(maxSessionTimer);

      if (errorMessage) {
        sendJson({ type: "error", message: errorMessage });
      }

      if (geminiSession) {
        try {
          geminiSession.close();
        } catch {
          // Ignore close errors
        }
        geminiSession = null;
      }

      if (
        clientWs.readyState === WebSocket.OPEN ||
        clientWs.readyState === WebSocket.CONNECTING
      ) {
        try {
          clientWs.close(errorMessage ? 1011 : 1000);
        } catch {
          // Ignore close errors
        }
      }
    }

    const startSession = async () => {
      try {
        const ai = getLiveGeminiClient(true);
        sendJson({ type: "status", status: "connecting", message: "Connecting to Gemini Live..." });

        const session = await ai.live.connect({
          model: GEMINI_LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Zephyr",
                },
              },
            },
            systemInstruction: buildArovaVoiceSystemInstruction(callContext),
          },
          callbacks: {
            onopen: () => {
              if (closed) return;
              sendJson({
                type: "status",
                status: "connected",
                message: "Connected to Arova AI (Gemini Live browser audio active).",
              });
            },
            onmessage: (message: LiveServerMessage) => {
              if (closed || clientWs.readyState !== WebSocket.OPEN) return;
              const serverContent = message.serverContent;

              if (serverContent?.inputTranscription?.text) {
                const text = serverContent.inputTranscription.text;
                caregiverTranscriptParts.push(text);
                sendJson({ type: "inputTranscript", text });
              }
              if (serverContent?.outputTranscription?.text) {
                const text = serverContent.outputTranscription.text;
                assistantTranscriptParts.push(text);
                sendJson({ type: "outputTranscript", text });
              }
              if (serverContent?.interrupted) {
                sendJson({ type: "interrupted" });
              }
              if (serverContent?.turnComplete) {
                sendJson({ type: "turnComplete" });
                if (isCaregiverAlertMode && caregiverTranscriptParts.length > 0) {
                  void runBrowserClassification();
                }
              }

              const parts = serverContent?.modelTurn?.parts ?? [];
              for (const part of parts) {
                if (part.inlineData?.data) {
                  sendJson({ type: "audio", audio: part.inlineData.data });
                }
              }
            },
            onerror: (errEvent) => {
              const reason = extractLiveErrorMessage(
                errEvent,
                "Gemini Live browser voice session encountered an error."
              );
              console.error("Gemini Live browser voice error:", reason, errEvent);
              cleanup(reason);
            },
            onclose: (closeEvent) => {
              const closeObj = closeEvent as { code?: number; reason?: string } | undefined;
              if (closeObj?.code && closeObj.code !== 1000) {
                console.warn(
                  "Gemini Live browser voice closed:",
                  closeObj.code,
                  closeObj.reason || ""
                );
              }
              if (!closed) {
                const unexpectedReason =
                  closeObj?.code && closeObj.code !== 1000 && closeObj.reason
                    ? `Gemini Live closed (${closeObj.code}): ${closeObj.reason}`
                    : undefined;
                cleanup(unexpectedReason);
              }
            },
          },
        });

        if (closed) {
          session.close();
          return;
        }

        geminiSession = session;
        if (!greetingSent) {
          greetingSent = true;
          session.sendRealtimeInput({
            text: buildOpeningPromptText(callContext),
          });
        }
      } catch (err) {
        const reason = extractLiveErrorMessage(
          err,
          "Unable to connect to Gemini Live API for browser testing."
        );
        console.error("Gemini Live browser connect failed:", reason, err);
        cleanup(reason);
      }
    };

    void startSession();

    clientWs.on("message", (rawData) => {
      if (closed || !geminiSession) return;
      let msg: { type?: string; audio?: string; text?: string };
      try {
        msg = JSON.parse(rawData.toString()) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "audio" && typeof msg.audio === "string" && msg.audio.length > 0) {
        try {
          geminiSession.sendRealtimeInput({
            audio: {
              data: msg.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (err) {
          console.error("Error forwarding browser PCM audio to Gemini Live:", err);
        }
        return;
      }

      if (msg.type === "text" && typeof msg.text === "string" && msg.text.trim()) {
        const clean = msg.text.trim().slice(0, 500);
        caregiverTranscriptParts.push(clean);
        sendJson({ type: "inputTranscript", text: clean });
        try {
          geminiSession.sendRealtimeInput({ text: clean });
        } catch (err) {
          console.error("Error forwarding browser text turn to Gemini Live:", err);
        }
      }
    });

    clientWs.on("close", () => cleanup());
    clientWs.on("error", () => cleanup());
  });

  wss.on("connection", (twilioWs: WebSocket) => {
    const codec = new TwilioGeminiAudioConverter();
    let streamSid: string | null = null;
    let callId: string | null = null;
    let callSid: string | null = null;
    let callContext: VoiceCallContext | null = null;
    let geminiSession: Session | null = null;
    let geminiConnecting = false;
    let closed = false;
    let greetingSent = false;

    // Transient in-memory turn text ONLY for structured response extraction (NO audio stored)
    const caregiverTranscriptParts: string[] = [];
    const assistantTranscriptParts: string[] = [];
    let classificationInFlight = false;
    let finalClassificationSent = false;

    const runResponseClassification = async (isFinal: boolean) => {
      if (!callId || classificationInFlight) return;
      if (isFinal && finalClassificationSent) return;
      const caregiverText = caregiverTranscriptParts.join(" ").trim();
      if (!caregiverText && !isFinal) return;

      classificationInFlight = true;
      try {
        const result = await classifyCaregiverConversation({
          caregiverTranscript: caregiverText,
          assistantTranscript: assistantTranscriptParts.join(" ").trim(),
          fallbackLanguage: callContext?.preferredLanguage ?? "en",
        });
        if (isFinal) finalClassificationSent = true;
        notifyCaregiverResponse(callId, result, isFinal);
      } finally {
        classificationInFlight = false;
      }
    };

    const cleanup = (failureReason?: string) => {
      if (closed) return;
      closed = true;

      if (callId) {
        activeBridges.delete(callId);
        void runResponseClassification(true);

        if (failureReason) {
          markOutboundCallFailure(callId, failureReason);
        } else {
          applyTwilioWebhookUpdate({
            callIdHint: callId,
            callSid: callSid ?? undefined,
            callStatus: "completed",
          });
        }
      }

      if (geminiSession) {
        try {
          geminiSession.close();
        } catch {
          // Ignore close errors
        }
        geminiSession = null;
      }

      if (
        twilioWs.readyState === WebSocket.OPEN ||
        twilioWs.readyState === WebSocket.CONNECTING
      ) {
        try {
          twilioWs.close(failureReason ? 1011 : 1000);
        } catch {
          // Ignore close errors
        }
      }
    };

    const sendIntroGreetingIfReady = () => {
      if (greetingSent || !geminiSession || !streamSid || closed) return;
      greetingSent = true;
      try {
        geminiSession.sendRealtimeInput({
          text: buildOpeningPromptText(callContext),
        });
      } catch (err) {
        console.error("Failed to trigger Gemini Live intro greeting:", err);
      }
    };

    const startGeminiLiveSession = async () => {
      if (geminiConnecting || geminiSession || closed) return;
      geminiConnecting = true;

      try {
        const ai = getLiveGeminiClient(true);
        const session = await ai.live.connect({
          model: GEMINI_LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Zephyr",
                },
              },
            },
            systemInstruction: buildArovaVoiceSystemInstruction(callContext),
          },
          callbacks: {
            onopen: () => {
              if (closed) return;
              sendIntroGreetingIfReady();
            },
            onmessage: (message: LiveServerMessage) => {
              if (closed || !streamSid || twilioWs.readyState !== WebSocket.OPEN) {
                return;
              }

              const serverContent = message.serverContent;
              if (serverContent?.inputTranscription?.text) {
                caregiverTranscriptParts.push(serverContent.inputTranscription.text);
              }
              if (serverContent?.outputTranscription?.text) {
                assistantTranscriptParts.push(serverContent.outputTranscription.text);
              }
              if (serverContent?.turnComplete && caregiverTranscriptParts.length > 0) {
                void runResponseClassification(false);
              }

              // Handle caller barge-in / natural interruption immediately
              if (serverContent?.interrupted) {
                codec.resetOutboundCarry();
                twilioWs.send(
                  JSON.stringify({
                    event: "clear",
                    streamSid,
                  })
                );
              }

              const parts = serverContent?.modelTurn?.parts ?? [];
              for (const part of parts) {
                const audioBase64 = part.inlineData?.data;
                if (!audioBase64) continue;

                const mulawFrames = codec.pcm24kBase64ToMulaw8kFrames(audioBase64);
                for (const payload of mulawFrames) {
                  if (twilioWs.readyState !== WebSocket.OPEN) break;
                  twilioWs.send(
                    JSON.stringify({
                      event: "media",
                      streamSid,
                      media: { payload },
                    })
                  );
                }
              }
            },
            onerror: (errEvent) => {
              const reason = extractLiveErrorMessage(
                errEvent,
                "Gemini Live WebSocket session encountered an error."
              );
              console.error("Gemini Live voice session error:", reason, errEvent);
              cleanup(reason);
            },
            onclose: (closeEvent) => {
              const closeObj = closeEvent as { code?: number; reason?: string } | undefined;
              if (closeObj?.code && closeObj.code !== 1000) {
                console.warn("Gemini Live Twilio bridge closed:", closeObj.code, closeObj.reason || "");
              }
              if (!closed) {
                const unexpectedReason =
                  closeObj?.code && closeObj.code !== 1000 && closeObj.reason
                    ? `Gemini Live closed (${closeObj.code}): ${closeObj.reason}`
                    : undefined;
                cleanup(unexpectedReason);
              }
            },
          },
        });

        if (closed) {
          session.close();
          return;
        }

        geminiSession = session;
        sendIntroGreetingIfReady();
      } catch (err) {
        const reason = extractLiveErrorMessage(err, "Unable to connect to Gemini Live API.");
        console.error("Gemini Live connection failed:", reason, err);
        cleanup(reason);
      } finally {
        geminiConnecting = false;
      }
    };

    twilioWs.on("message", (rawData) => {
      if (closed) return;

      let msg: {
        event: string;
        streamSid?: string;
        start?: {
          streamSid?: string;
          callSid?: string;
          customParameters?: Record<string, string>;
        };
        media?: { track?: string; payload?: string };
      };
      try {
        msg = JSON.parse(rawData.toString()) as typeof msg;
      } catch {
        return;
      }

      if (msg.event === "start") {
        const custom = msg.start?.customParameters ?? {};
        const incomingCallId = typeof custom.callId === "string" ? custom.callId.trim() : "";
        const incomingToken =
          typeof custom.streamToken === "string" ? custom.streamToken.trim() : "";

        if (
          !incomingCallId ||
          !hasStoredOutboundCall(incomingCallId) ||
          !verifyStreamToken(incomingCallId, incomingToken)
        ) {
          twilioWs.close(1008, "Unauthorized stream token.");
          closed = true;
          return;
        }

        callId = incomingCallId;
        callContext = getOutboundCallContext(callId);
        streamSid = msg.start?.streamSid || msg.streamSid || null;
        callSid = msg.start?.callSid ?? null;

        activeBridges.set(callId, () => cleanup());
        applyTwilioWebhookUpdate({
          callIdHint: callId,
          callSid: callSid ?? undefined,
          callStatus: "in-progress",
        });

        void startGeminiLiveSession();
        return;
      }

      if (msg.event === "media") {
        const track = msg.media?.track;
        if (track && track !== "inbound") return;
        const payload = msg.media?.payload;
        if (!payload || !geminiSession) return;

        const pcm16kBase64 = codec.mulaw8kBase64ToPcm16kBase64(payload);
        if (!pcm16kBase64) return;

        try {
          geminiSession.sendRealtimeInput({
            audio: {
              data: pcm16kBase64,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (err) {
          console.error("Error forwarding inbound Twilio audio to Gemini Live:", err);
        }
        return;
      }

      if (msg.event === "stop") {
        cleanup();
      }
    });

    twilioWs.on("close", () => {
      cleanup();
    });

    twilioWs.on("error", (err) => {
      console.error("Twilio Media Stream WebSocket error:", err);
      cleanup("Twilio Media Stream WebSocket error.");
    });
  });

  return wss;
}
