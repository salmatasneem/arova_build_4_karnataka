import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Globe,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Send,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { CaregiverResponseCategory, SupportedVoiceLanguage } from "../types/smartcare.ts";

export type BrowserVoiceTestMode = "assistant" | "caregiver_alert";
export type BrowserVoiceSessionStatus =
  | "ready"
  | "connecting"
  | "connected"
  | "ended"
  | "error";

interface TranscriptItem {
  id: string;
  speaker: "ai" | "user";
  text: string;
}

interface ClassificationPreview {
  caregiverResponse: CaregiverResponseCategory;
  selectedLanguage: SupportedVoiceLanguage;
  followUpAction: string;
  responseSummary: string;
}

interface BrowserVoiceTestPanelProps {
  mode: BrowserVoiceTestMode;
  defaultLanguage?: SupportedVoiceLanguage;
  patientName?: string;
  caregiverName?: string;
  parameter?: string;
  readingValue?: string;
  readingUnit?: string;
  authorizedForPatientIdentity?: boolean;
  authorizedForHealthReadings?: boolean;
  telemetrySummary?: string;
  compact?: boolean;
}

const VOICE_BAR_HEIGHTS = [14, 24, 34, 20, 38, 28, 18, 32, 22, 14];

const LANGUAGE_LABELS: Record<SupportedVoiceLanguage, string> = {
  en: "English",
  kn: "Kannada",
  hi: "Hindi",
};

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function downsampleTo16kPcmBase64(input: Float32Array, inputSampleRate: number): string {
  const targetRate = 16000;
  let samples: Float32Array;

  if (inputSampleRate === targetRate) {
    samples = input;
  } else {
    const ratio = inputSampleRate / targetRate;
    const newLength = Math.max(1, Math.floor(input.length / ratio));
    samples = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const frac = srcIdx - idx0;
      samples[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
    }
  }

  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, Math.round(int16), true);
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodePcm24kBase64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLen = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = byteLen / 2;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export function BrowserVoiceTestPanel({
  mode,
  defaultLanguage = "en",
  patientName = "Monitored Patient",
  caregiverName = "Caregiver",
  parameter = "Heart Rate",
  readingValue = "118",
  readingUnit = "BPM",
  authorizedForPatientIdentity = true,
  authorizedForHealthReadings = true,
  telemetrySummary = "",
  compact = false,
}: BrowserVoiceTestPanelProps) {
  const [language, setLanguage] = useState<SupportedVoiceLanguage>(defaultLanguage);
  const [status, setStatus] = useState<BrowserVoiceSessionStatus>("ready");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [classification, setClassification] = useState<ClassificationPreview | null>(null);
  const [textReply, setTextReply] = useState("");
  const [micAvailable, setMicAvailable] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<BrowserVoiceSessionStatus>("ready");
  const geminiConnectedRef = useRef(false);
  const mutedRef = useRef(false);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    setLanguage(defaultLanguage);
  }, [defaultLanguage]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mutedRef.current = micMuted;
  }, [micMuted]);

  const stopPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes
      }
    }
    activeSourcesRef.current.clear();
    if (outputCtxRef.current) {
      nextStartTimeRef.current = outputCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const teardownSession = useCallback(
    (nextStatus: BrowserVoiceSessionStatus = "ended", message?: string) => {
      if (processorRef.current) {
        try {
          processorRef.current.onaudioprocess = null;
          processorRef.current.disconnect();
        } catch {
          // Ignore
        }
        processorRef.current = null;
      }

      if (silentGainRef.current) {
        try {
          silentGainRef.current.disconnect();
        } catch {
          // Ignore
        }
        silentGainRef.current = null;
      }

      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.disconnect();
        } catch {
          // Ignore
        }
        sourceNodeRef.current = null;
      }

      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          track.stop();
        }
        mediaStreamRef.current = null;
      }

      if (inputCtxRef.current) {
        void inputCtxRef.current.close().catch(() => {});
        inputCtxRef.current = null;
      }

      stopPlaybackQueue();
      if (outputCtxRef.current) {
        void outputCtxRef.current.close().catch(() => {});
        outputCtxRef.current = null;
      }

      if (wsRef.current) {
        try {
          if (
            wsRef.current.readyState === WebSocket.OPEN ||
            wsRef.current.readyState === WebSocket.CONNECTING
          ) {
            wsRef.current.close(1000);
          }
        } catch {
          // Ignore
        }
        wsRef.current = null;
      }

      geminiConnectedRef.current = false;
      setMicEnabled(false);
      setMicLevel(0);
      setAiSpeaking(false);
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      if (message) setStatusMessage(message);
    },
    [stopPlaybackQueue]
  );

  useEffect(() => {
    return () => {
      teardownSession("ready");
    };
  }, [teardownSession]);

  useEffect(() => {
    if (status !== "connected") return;
    const timer = setInterval(() => {
      setDurationSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const schedulePcm24kAudio = useCallback((base64Audio: string) => {
    const ctx = outputCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    const floatSamples = decodePcm24kBase64ToFloat32(base64Audio);
    if (floatSamples.length === 0) return;

    const buffer = ctx.createBuffer(1, floatSamples.length, 24000);
    buffer.copyToChannel(new Float32Array(floatSamples), 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.02, nextStartTimeRef.current);
    nextStartTimeRef.current = startAt + buffer.duration;

    setAiSpeaking(true);
    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
      if (activeSourcesRef.current.size === 0) {
        setAiSpeaking(false);
      }
    };
    source.start(startAt);
  }, []);

  const appendTranscript = useCallback((speaker: "ai" | "user", rawText: string) => {
    const clean = rawText.trim();
    if (!clean) return;
    setTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.speaker === speaker) {
        const joined = `${last.text} ${clean}`.replace(/\s+/g, " ").trim();
        return [...prev.slice(0, -1), { ...last, text: joined }];
      }
      return [
        ...prev.slice(-15),
        { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, speaker, text: clean },
      ];
    });
  }, []);

  const enableMicrophoneCapture = useCallback(async (announce = false): Promise<boolean> => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicAvailable(false);
        setMicEnabled(false);
        if (announce) {
          setStatusMessage(
            "Browser microphone API is unavailable in this frame. You can type your question below."
          );
        }
        return false;
      }

      if (mediaStreamRef.current && inputCtxRef.current && processorRef.current) {
        if (inputCtxRef.current.state === "suspended") {
          await inputCtxRef.current.resume();
        }
        setMicAvailable(true);
        setMicEnabled(true);
        setMicMuted(false);
        mutedRef.current = false;
        if (announce) {
          setStatusMessage("Microphone enabled — click Start Browser Voice Test or speak your question.");
        }
        return true;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext();
      await inputCtx.resume();
      inputCtxRef.current = inputCtx;

      const sourceNode = inputCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const silentGain = inputCtx.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;

      const inputSampleRate = inputCtx.sampleRate;
      processor.onaudioprocess = (event) => {
        const activeWs = wsRef.current;
        if (
          mutedRef.current ||
          !geminiConnectedRef.current ||
          !activeWs ||
          activeWs.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        const channel = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0; i < channel.length; i += 4) {
          sumSquares += channel[i] * channel[i];
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, Math.floor(channel.length / 4)));
        setMicLevel(Math.min(100, Math.round(rms * 420)));

        const audioBase64 = downsampleTo16kPcmBase64(channel, inputSampleRate);
        activeWs.send(JSON.stringify({ type: "audio", audio: audioBase64 }));
      };

      sourceNode.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(inputCtx.destination);
      setMicAvailable(true);
      setMicEnabled(true);
      setMicMuted(false);
      mutedRef.current = false;
      if (announce) {
        setStatusMessage(
          statusRef.current === "connected"
            ? "Microphone enabled — speak your question aloud now."
            : "Microphone enabled — click Start Browser Voice Test to ask your question by voice."
        );
      }
      return true;
    } catch (micErr) {
      console.warn("Microphone capture unavailable:", micErr);
      setMicAvailable(false);
      setMicEnabled(false);
      if (announce) {
        setStatusMessage(
          "Microphone permission was blocked by the browser. Allow microphone access in your browser site settings, then click Enable Microphone."
        );
      }
      return false;
    }
  }, []);

  const startBrowserVoiceSession = async () => {
    if (status === "connecting" || status === "connected") return;

    statusRef.current = "connecting";
    geminiConnectedRef.current = false;
    setStatus("connecting");
    setDurationSec(0);
    setTranscripts([]);
    setClassification(null);
    setMicMuted(false);
    mutedRef.current = false;
    setStatusMessage("Starting browser microphone & Gemini Live audio session...");

    try {
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      await outputCtx.resume();
      outputCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const micReady = await enableMicrophoneCapture(false);

      const qs = new URLSearchParams({
        mode,
        language,
        patientName,
        caregiverName,
        parameter,
        readingValue,
        readingUnit,
        authorizedForPatientIdentity: String(authorizedForPatientIdentity),
        authorizedForHealthReadings: String(authorizedForHealthReadings),
        ...(telemetrySummary ? { telemetrySummary } : {}),
      });

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/api/voice/browser/stream?${qs.toString()}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        let msg: {
          type?: string;
          status?: string;
          message?: string;
          audio?: string;
          text?: string;
          result?: ClassificationPreview;
        };
        try {
          msg = JSON.parse(event.data as string) as typeof msg;
        } catch {
          return;
        }

        if (msg.type === "status") {
          if (msg.status === "connected") {
            geminiConnectedRef.current = true;
            statusRef.current = "connected";
            setStatus("connected");
            setStatusMessage(
              micReady
                ? "Microphone active — speak your question aloud or type it below."
                : "Microphone unavailable in browser — listen to Arova AI and type your question below."
            );
          } else if (msg.message) {
            setStatusMessage(msg.message);
          }
          return;
        }

        if (msg.type === "audio" && msg.audio) {
          schedulePcm24kAudio(msg.audio);
          return;
        }

        if (msg.type === "interrupted") {
          stopPlaybackQueue();
          setAiSpeaking(false);
          return;
        }

        if (msg.type === "turnComplete") {
          if (activeSourcesRef.current.size === 0) {
            setAiSpeaking(false);
          }
          return;
        }

        if (msg.type === "inputTranscript" && msg.text) {
          appendTranscript("user", msg.text);
          return;
        }

        if (msg.type === "outputTranscript" && msg.text) {
          appendTranscript("ai", msg.text);
          return;
        }

        if (msg.type === "classification" && msg.result) {
          setClassification(msg.result);
          return;
        }

        if (msg.type === "error") {
          teardownSession("error", msg.message || "Browser Gemini Live voice error.");
        }
      };

      ws.onerror = () => {
        if (statusRef.current === "error") return;
        teardownSession("error", "WebSocket connection to Arova AI browser voice stream failed.");
      };

      ws.onclose = (ev) => {
        if (statusRef.current === "error" || statusRef.current === "ended") return;
        geminiConnectedRef.current = false;
        if (ev.code !== 1000 && statusRef.current === "connecting") {
          teardownSession(
            "error",
            ev.reason || "Could not start browser Gemini Live session. Verify GEMINI_API_KEY."
          );
          return;
        }
        teardownSession("ended", ev.code === 1000 ? undefined : "Browser voice stream disconnected.");
      };
    } catch (err) {
      teardownSession(
        "error",
        err instanceof Error ? err.message : "Failed to initialize browser audio session."
      );
    }
  };

  const handleSendTextReply = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = textReply.trim();
    if (!clean || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "text", text: clean }));
    setTextReply("");
  };

  const isLive = status === "connecting" || status === "connected";

  return (
    <div className="space-y-4">
      {/* Status & Waveform Card */}
      <div className="rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] p-4 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border ${
                status === "connected"
                  ? "bg-[#00B800] text-white border-[#008F00]"
                  : status === "connecting"
                    ? "bg-[#00B800]/12 text-[#008F00] border-[#00B800]/35"
                    : status === "error"
                      ? "bg-red-50 text-red-800 border-red-300"
                      : "bg-white text-[#202525] border-[#D9E0E0]"
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${status === "connected" ? "animate-pulse" : ""}`} />
              <span>
                {status === "connected"
                  ? "Browser Voice Live"
                  : status === "connecting"
                    ? "Connecting..."
                    : status === "ended"
                      ? "Browser Test Ended"
                      : status === "error"
                        ? "Session Error"
                        : "Browser Voice Ready"}
              </span>
            </span>

            <span className="text-[11px] font-mono text-[#737B7B]">
              Gemini Live · No Twilio Needed
            </span>
          </div>

          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-[#D9E0E0] text-xs font-mono font-semibold text-[#202525] tabular-nums">
            <Clock className="w-3.5 h-3.5 text-[#00B800]" />
            <span>{formatDuration(durationSec)}</span>
          </div>
        </div>

        {/* Mic Indicator & Bars */}
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={() => {
              if (!micEnabled) {
                void enableMicrophoneCapture(true);
              } else {
                setMicMuted((m) => !m);
              }
            }}
            title={
              !micEnabled
                ? "Enable microphone"
                : micMuted
                  ? "Unmute microphone"
                  : "Mute microphone"
            }
            className={`relative w-11 h-11 rounded-2xl flex items-center justify-center border shrink-0 transition-colors cursor-pointer ${
              micEnabled && !micMuted
                ? "bg-[#00B800] border-[#008F00] text-white shadow-[0_6px_16px_-4px_rgba(0,184,0,0.45)]"
                : status === "error"
                  ? "bg-red-50 border-red-300 text-red-600"
                  : "bg-white border-[#D9E0E0] text-[#008F00] hover:border-[#00B800]"
            }`}
          >
            {micMuted || !micAvailable ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          <div className="flex-1 space-y-1.5 min-w-0">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#202525] truncate">
                {status === "connected"
                  ? !micEnabled
                    ? "Click Enable Microphone to Speak or Type Below"
                    : micMuted
                      ? "Microphone Muted (Listening Paused)"
                      : aiSpeaking
                        ? "Arova AI Speaking..."
                        : micLevel > 8
                          ? "Hearing Your Question..."
                          : "Listening — Ask Any Question"
                  : status === "connecting"
                    ? "Opening Gemini Live Audio Stream..."
                    : micEnabled
                      ? "Microphone Ready — Start Voice Test to Ask Questions"
                      : mode === "caregiver_alert"
                        ? "Enable Microphone & Test Caregiver Alert Script"
                        : "Enable Microphone to Ask Arova AI by Voice"}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-[#737B7B] shrink-0">
                {status === "connected" ? (
                  <Volume2 className="w-3.5 h-3.5 text-[#00B800]" />
                ) : (
                  <VolumeX className="w-3.5 h-3.5" />
                )}
                <span>{LANGUAGE_LABELS[language]}</span>
              </span>
            </div>

            <div
              className="h-9 rounded-xl bg-white border border-[#D9E0E0] px-3 flex items-center justify-between gap-1.5"
              aria-hidden="true"
            >
              {VOICE_BAR_HEIGHTS.map((heightPx, idx) => {
                const isLiveWave = status === "connected" && !micMuted;
                const isSoft = status === "connecting";
                const dynamicBoost =
                  isLiveWave && micLevel > 4
                    ? Math.min(30, Math.round((micLevel / 100) * 26 * (0.65 + (idx % 3) * 0.2)))
                    : 0;
                return (
                  <span
                    key={idx}
                    className={`flex-1 rounded-full transition-all duration-100 ${
                      status === "error"
                        ? "bg-red-400"
                        : isLiveWave
                          ? aiSpeaking || micLevel > 6
                            ? "arova-voice-bar bg-[#00B800]"
                            : "bg-[#00B800]/60"
                          : isSoft
                            ? "arova-voice-bar bg-[#00B800]/70"
                            : "bg-[#D9E0E0]"
                    }`}
                    style={{
                      height: isLiveWave
                        ? `${Math.max(8, Math.min(30, Math.round(heightPx * 0.55) + dynamicBoost))}px`
                        : isSoft
                          ? `${Math.max(8, Math.round(heightPx * 0.5))}px`
                          : "6px",
                      animationDelay: `${idx * 90}ms`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Language & Action Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
          <label className="inline-flex items-center gap-2 text-xs text-[#202525]">
            <Globe className="w-3.5 h-3.5 text-[#00B800]" />
            <span className="font-medium">Language:</span>
            <select
              value={language}
              disabled={isLive}
              onChange={(e) => setLanguage(e.target.value as SupportedVoiceLanguage)}
              className="px-2.5 py-1.5 text-xs font-medium bg-white border border-[#D9E0E0] rounded-lg text-[#202525] focus:outline-none focus:border-[#00B800] disabled:opacity-60"
            >
              <option value="en">English</option>
              <option value="kn">Kannada</option>
              <option value="hi">Hindi</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {!micEnabled && (
              <button
                type="button"
                onClick={() => void enableMicrophoneCapture(true)}
                className="arova-cta-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] hover:text-[#008F00] cursor-pointer whitespace-nowrap shrink-0"
              >
                <Mic className="w-3.5 h-3.5 text-[#00B800]" />
                <span>Enable Microphone</span>
              </button>
            )}
            {!isLive ? (
              <button
                type="button"
                onClick={() => void startBrowserVoiceSession()}
                className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-xl cursor-pointer whitespace-nowrap shrink-0"
              >
                <Mic className="w-3.5 h-3.5" />
                <span>Start Browser Voice Test</span>
              </button>
            ) : (
              <>
                {micEnabled && (
                  <button
                    type="button"
                    onClick={() => setMicMuted((m) => !m)}
                    className="px-3 py-2 text-xs font-semibold text-[#202525] bg-white border border-[#D9E0E0] rounded-xl hover:border-[#00B800] cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {micMuted ? "Unmute Mic" : "Mute Mic"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => teardownSession("ended", "Browser voice test ended.")}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl cursor-pointer whitespace-nowrap shrink-0"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>End Voice Test</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {statusMessage && (
        <div
          className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs border ${
            status === "error"
              ? "bg-red-50 border-red-300 text-red-900"
              : "bg-[#00B800]/10 border-[#00B800]/30 text-[#008F00]"
          }`}
        >
          {status === "error" ? (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#00B800]" />
          )}
          <span>{statusMessage}</span>
        </div>
      )}

      {/* Caregiver Classification Badge */}
      {mode === "caregiver_alert" && classification && (
        <div className="rounded-xl border border-[#00B800]/30 bg-[#00B800]/10 p-3 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-[#008F00]">
              Structured Caregiver Response: {classification.caregiverResponse}
            </span>
            <span className="font-mono text-[11px] text-[#737B7B]">
              Detected: {LANGUAGE_LABELS[classification.selectedLanguage]}
            </span>
          </div>
          <p className="text-[#202525]">{classification.followUpAction}</p>
        </div>
      )}

      {/* Live Captions & Typed Fallback */}
      {(transcripts.length > 0 || status === "connected") && (
        <div className="rounded-xl border border-[#D9E0E0] bg-white p-3 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#737B7B]">
            Live Voice Transcript
          </div>
          <div
            className={`overflow-y-auto space-y-2 text-xs ${
              compact ? "max-h-36" : "max-h-48"
            }`}
          >
            {transcripts.length === 0 ? (
              <p className="text-[#737B7B] italic">
                Listening for Gemini Live greeting and voice input...
              </p>
            ) : (
              transcripts.map((t) => (
                <div
                  key={t.id}
                  className={`px-3 py-2 rounded-lg ${
                    t.speaker === "ai"
                      ? "bg-[#00B800]/10 border border-[#00B800]/25 text-[#202525]"
                      : "bg-[#EEF2F2] border border-[#D9E0E0] text-[#202525] ml-6"
                  }`}
                >
                  <span className="font-semibold text-[#008F00] mr-1.5">
                    {t.speaker === "ai" ? "Arova AI:" : "You:"}
                  </span>
                  <span>{t.text}</span>
                </div>
              ))
            )}
          </div>

          {status === "connected" && (
            <form onSubmit={handleSendTextReply} className="flex gap-2 pt-1.5 border-t border-[#D9E0E0]">
              <input
                type="text"
                value={textReply}
                onChange={(e) => setTextReply(e.target.value)}
                placeholder="Ask a question aloud into your mic or type it here..."
                className="flex-1 px-3 py-1.5 text-xs bg-white border border-[#D9E0E0] rounded-lg text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
              <button
                type="submit"
                disabled={!textReply.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Send className="w-3 h-3" />
                <span>Ask</span>
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
