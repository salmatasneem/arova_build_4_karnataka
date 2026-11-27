import crypto from "node:crypto";
import type { Request } from "express";

export type OutboundFrontendCallStatus =
  | "initiating"
  | "calling"
  | "connected"
  | "ended"
  | "failed";

export type ArovaCallStatus =
  | "Initiated"
  | "Ringing"
  | "Answered"
  | "Unanswered"
  | "Busy"
  | "Failed"
  | "Completed";

export type SupportedVoiceLanguage = "en" | "kn" | "hi";

export type CaregiverResponseCategory =
  | "Pending"
  | "Will check immediately"
  | "Already checking on the patient"
  | "Patient is safe"
  | "Unable to assist"
  | "Not available"
  | "Requests another contact"
  | "Needs emergency assistance"
  | "Unclear response";

export type TwilioCallLifecycleStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "canceled"
  | "failed";

export interface VoiceCallContext {
  callType: "direct_outbound" | "test_call" | "emergency_escalation";
  escalationId?: string;
  alertId?: string;
  patientId?: string;
  patientOwnerUid?: string;
  patientName?: string;
  alertSeverity?: "Low" | "Medium" | "High" | "Test";
  parameter?: string;
  readingValue?: string;
  readingUnit?: string;
  thresholdContext?: string;
  reasonForCalling?: string;
  relevantReading?: string;
  eventTimestamp?: string;
  caregiverContactId?: string;
  caregiverName?: string;
  caregiverPriority?: "primary" | "secondary" | "alternate" | "test";
  preferredLanguage: SupportedVoiceLanguage;
  authorizedForPatientIdentity: boolean;
  authorizedForHealthReadings: boolean;
  explicitCallConsent: boolean;
  retryCount: number;
  telemetrySummary?: string;
}

export interface OutboundCallRecord {
  callId: string;
  callSid: string | null;
  maskedPhone: string;
  status: OutboundFrontendCallStatus;
  arovaStatus: ArovaCallStatus;
  twilioStatus: TwilioCallLifecycleStatus | null;
  durationSec: number;
  errorMessage: string | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  context?: VoiceCallContext;
}

export interface OutboundTwilioConfigStatus {
  configured: boolean;
  missingEnvVars: string[];
  publicBaseUrlConfigured: boolean;
  publicBaseUrl: string | null;
}

const E164_PHONE_REGEX = /^\+[1-9]\d{7,14}$/;
const TWILIO_SID_REGEX = /^AC[a-fA-F0-9]{32}$/;
const TWILIO_CALL_SID_REGEX = /^CA[a-fA-F0-9]{32}$/;
const MAX_STORED_CALLS = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

const callStore = new Map<string, OutboundCallRecord>();
const callSidToCallId = new Map<string, string>();
const rateLimitBuckets = new Map<string, number[]>();

type CallStatusListener = (record: OutboundCallRecord) => void;
const statusListeners = new Set<CallStatusListener>();

export function registerCallStatusListener(listener: CallStatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function notifyStatusListeners(record: OutboundCallRecord): void {
  for (const listener of statusListeners) {
    try {
      listener(record);
    } catch (err) {
      console.error("Call status listener error:", err);
    }
  }
}

function isPlaceholderValue(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return !trimmed || trimmed.startsWith("MY_") || trimmed === "changeme";
}

export function resolvePublicBaseUrl(req?: Request): string | null {
  const candidates: Array<string | undefined> = [process.env.APP_URL];
  if (req) {
    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto = forwardedProto || req.protocol;
    const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
    if (proto && host) {
      candidates.push(`${proto}://${host}`);
    }
  }

  for (const candidate of candidates) {
    if (isPlaceholderValue(candidate)) continue;
    try {
      const parsed = new URL(candidate!.trim());
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        const host = parsed.hostname.toLowerCase();
        if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
          return parsed.origin;
        }
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export function getOutboundTwilioConfig(req?: Request): OutboundTwilioConfigStatus {
  const missingEnvVars: string[] = [];

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim() || "";
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || "";

  if (!TWILIO_SID_REGEX.test(accountSid)) {
    missingEnvVars.push("TWILIO_ACCOUNT_SID");
  }
  if (isPlaceholderValue(authToken) || authToken.length < 16) {
    missingEnvVars.push("TWILIO_AUTH_TOKEN");
  }
  if (!E164_PHONE_REGEX.test(fromNumber)) {
    missingEnvVars.push("TWILIO_PHONE_NUMBER");
  }
  if (isPlaceholderValue(geminiApiKey)) {
    missingEnvVars.push("GEMINI_API_KEY");
  }

  const publicBaseUrl = resolvePublicBaseUrl(req);
  if (!publicBaseUrl) {
    missingEnvVars.push("APP_URL");
  }

  return {
    configured: missingEnvVars.length === 0,
    missingEnvVars,
    publicBaseUrlConfigured: Boolean(publicBaseUrl),
    publicBaseUrl,
  };
}

function escapeXmlAttr(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createStreamToken(callId: string): string {
  const secret = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  if (!secret) {
    throw new Error("TWILIO_AUTH_TOKEN is required to sign Media Stream tokens.");
  }
  return crypto.createHmac("sha256", secret).update(`stream:${callId}`, "utf8").digest("hex");
}

export function verifyStreamToken(callId: string, token: string): boolean {
  const secret = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  if (!secret || !callId || !token) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`stream:${callId}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(token.trim(), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export function hasStoredOutboundCall(callId: string): boolean {
  return callStore.has(callId);
}

export function getStoredOutboundCall(callId: string): OutboundCallRecord | null {
  return callStore.get(callId) ?? null;
}

export function getOutboundCallContext(callId: string): VoiceCallContext | null {
  return callStore.get(callId)?.context ?? null;
}

export function markOutboundCallFailure(callId: string, reason: string): OutboundCallRecord | null {
  const existing = callStore.get(callId);
  if (!existing) return null;
  const nowIso = new Date().toISOString();
  existing.status = "failed";
  existing.arovaStatus = "Failed";
  existing.twilioStatus = "failed";
  existing.errorMessage = reason;
  existing.endedAt = existing.endedAt ?? nowIso;
  existing.updatedAt = nowIso;
  callStore.set(callId, existing);
  notifyStatusListeners(existing);
  return existing;
}

export function validateE164PhoneNumber(rawInput: unknown): {
  valid: boolean;
  normalized?: string;
  error?: string;
} {
  if (typeof rawInput !== "string") {
    return { valid: false, error: "Phone number must be a string." };
  }
  const stripped = rawInput.trim().replace(/[\s\-().]/g, "");
  if (!E164_PHONE_REGEX.test(stripped)) {
    return {
      valid: false,
      error: "Phone number must be valid E.164 format (e.g. +14155550199, 8–15 digits).",
    };
  }
  return { valid: true, normalized: stripped };
}

export function maskPhoneNumber(e164: string): string {
  if (e164.length <= 6) return "***";
  const prefix = e164.slice(0, Math.min(4, e164.length - 4));
  const suffix = e164.slice(-4);
  return `${prefix}••••${suffix}`;
}

export function checkOutboundRateLimit(clientKey: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const recent = (rateLimitBuckets.get(clientKey) ?? []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000));
    rateLimitBuckets.set(clientKey, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  rateLimitBuckets.set(clientKey, recent);
  return { allowed: true };
}

export function mapTwilioStatusToFrontend(
  twilioStatus: string,
  wasConnected = false
): {
  status: OutboundFrontendCallStatus;
  arovaStatus: ArovaCallStatus;
  normalizedTwilio: TwilioCallLifecycleStatus | null;
  error?: string;
} {
  const lower = twilioStatus.toLowerCase().trim();
  switch (lower) {
    case "queued":
    case "initiated":
      return { status: "initiating", arovaStatus: "Initiated", normalizedTwilio: lower };
    case "ringing":
      return { status: "calling", arovaStatus: "Ringing", normalizedTwilio: "ringing" };
    case "in-progress":
    case "answered":
      return { status: "connected", arovaStatus: "Answered", normalizedTwilio: "in-progress" };
    case "completed":
      return {
        status: "ended",
        arovaStatus: wasConnected ? "Completed" : "Unanswered",
        normalizedTwilio: "completed",
      };
    case "busy":
      return {
        status: "failed",
        arovaStatus: "Busy",
        normalizedTwilio: "busy",
        error: "Recipient line is busy.",
      };
    case "no-answer":
      return {
        status: "failed",
        arovaStatus: "Unanswered",
        normalizedTwilio: "no-answer",
        error: "No answer from recipient.",
      };
    case "canceled":
      return {
        status: "ended",
        arovaStatus: wasConnected ? "Completed" : "Unanswered",
        normalizedTwilio: "canceled",
        error: "Call was canceled.",
      };
    case "failed":
      return {
        status: "failed",
        arovaStatus: "Failed",
        normalizedTwilio: "failed",
        error: "Twilio reported that the outbound call failed.",
      };
    default:
      return { status: "initiating", arovaStatus: "Initiated", normalizedTwilio: null };
  }
}

export function verifyTwilioSignature(params: {
  authToken: string;
  signatureHeader: string | undefined;
  fullUrl: string;
  bodyParams: Record<string, unknown>;
}): boolean {
  if (!params.authToken || !params.signatureHeader) {
    return false;
  }

  const sortedKeys = Object.keys(params.bodyParams).sort();
  let data = params.fullUrl;
  for (const key of sortedKeys) {
    const val = params.bodyParams[key];
    data += key + (val === undefined || val === null ? "" : String(val));
  }

  const expected = crypto
    .createHmac("sha1", params.authToken)
    .update(data, "utf8")
    .digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(params.signatureHeader.trim(), "utf8");
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export function storeCallRecord(record: OutboundCallRecord): void {
  if (callStore.size >= MAX_STORED_CALLS) {
    const oldestKey = callStore.keys().next().value;
    if (oldestKey) {
      const old = callStore.get(oldestKey);
      if (old?.callSid) callSidToCallId.delete(old.callSid);
      callStore.delete(oldestKey);
    }
  }
  callStore.set(record.callId, record);
  if (record.callSid) {
    callSidToCallId.set(record.callSid, record.callId);
  }
}

export async function initiateTwilioOutboundCall(params: {
  toE164: string;
  req?: Request;
  publicBaseUrlOverride?: string;
  context?: VoiceCallContext;
}): Promise<OutboundCallRecord> {
  const cfg = getOutboundTwilioConfig(params.req);
  const effectiveBaseUrl = params.publicBaseUrlOverride || cfg.publicBaseUrl;
  if (!cfg.configured || !effectiveBaseUrl) {
    throw new Error(
      `Twilio Programmable Voice is not configured. Missing environment variables: ${cfg.missingEnvVars.join(", ")}.`
    );
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN!.trim();
  const fromNumber = process.env.TWILIO_PHONE_NUMBER!.trim();

  const callId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const twimlUrl = `${effectiveBaseUrl}/api/voice/outbound/twiml?callId=${encodeURIComponent(callId)}`;
  const statusCallbackUrl = `${effectiveBaseUrl}/api/voice/outbound/status?callId=${encodeURIComponent(callId)}`;

  const form = new URLSearchParams();
  form.set("To", params.toE164);
  form.set("From", fromNumber);
  form.set("Url", twimlUrl);
  form.set("Method", "POST");
  form.set("StatusCallback", statusCallbackUrl);
  form.set("StatusCallbackMethod", "POST");
  form.append("StatusCallbackEvent", "initiated");
  form.append("StatusCallbackEvent", "ringing");
  form.append("StatusCallbackEvent", "answered");
  form.append("StatusCallbackEvent", "completed");

  const authHeader = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
  const twilioEndpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;

  const response = await fetch(twilioEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    message?: string;
    code?: number;
  };

  if (!response.ok || !payload.sid) {
    const reason = payload.message || `Twilio API returned HTTP ${response.status}.`;
    const failedRecord: OutboundCallRecord = {
      callId,
      callSid: null,
      maskedPhone: maskPhoneNumber(params.toE164),
      status: "failed",
      arovaStatus: "Failed",
      twilioStatus: "failed",
      durationSec: 0,
      errorMessage: reason,
      startedAt: nowIso,
      connectedAt: null,
      endedAt: nowIso,
      updatedAt: nowIso,
      context: params.context,
    };
    storeCallRecord(failedRecord);
    notifyStatusListeners(failedRecord);
    throw new Error(reason);
  }

  const mapped = mapTwilioStatusToFrontend(payload.status || "queued", false);
  const record: OutboundCallRecord = {
    callId,
    callSid: payload.sid,
    maskedPhone: maskPhoneNumber(params.toE164),
    status: mapped.status,
    arovaStatus: mapped.arovaStatus,
    twilioStatus: mapped.normalizedTwilio ?? "queued",
    durationSec: 0,
    errorMessage: mapped.error ?? null,
    startedAt: nowIso,
    connectedAt: mapped.status === "connected" ? nowIso : null,
    endedAt: null,
    updatedAt: nowIso,
    context: params.context,
  };
  storeCallRecord(record);
  notifyStatusListeners(record);
  return record;
}

export function applyTwilioWebhookUpdate(params: {
  callIdHint?: string;
  callSid?: string;
  callStatus?: string;
  callDurationSec?: number;
}): OutboundCallRecord | null {
  const resolvedCallId =
    (params.callIdHint && callStore.has(params.callIdHint) ? params.callIdHint : undefined) ??
    (params.callSid ? callSidToCallId.get(params.callSid) : undefined);

  if (!resolvedCallId) return null;
  const record = callStore.get(resolvedCallId);
  if (!record) return null;

  const nowIso = new Date().toISOString();
  if (params.callSid && TWILIO_CALL_SID_REGEX.test(params.callSid) && !record.callSid) {
    record.callSid = params.callSid;
    callSidToCallId.set(params.callSid, record.callId);
  }

  if (params.callStatus) {
    const mapped = mapTwilioStatusToFrontend(params.callStatus, Boolean(record.connectedAt));
    record.status = mapped.status;
    record.arovaStatus = mapped.arovaStatus;
    record.twilioStatus = mapped.normalizedTwilio ?? record.twilioStatus;
    if (mapped.error) {
      record.errorMessage = mapped.error;
    }
    if (mapped.status === "connected" && !record.connectedAt) {
      record.connectedAt = nowIso;
    }
    if ((mapped.status === "ended" || mapped.status === "failed") && !record.endedAt) {
      record.endedAt = nowIso;
    }
  }

  if (typeof params.callDurationSec === "number" && Number.isFinite(params.callDurationSec)) {
    record.durationSec = Math.max(0, Math.round(params.callDurationSec));
  } else if (record.connectedAt && record.status === "connected") {
    record.durationSec = Math.max(
      0,
      Math.floor((Date.now() - new Date(record.connectedAt).getTime()) / 1000)
    );
  }

  record.updatedAt = nowIso;
  callStore.set(record.callId, record);
  notifyStatusListeners(record);
  return record;
}

export async function refreshOutboundCallRecord(callId: string): Promise<OutboundCallRecord | null> {
  const existing = callStore.get(callId);
  if (!existing) return null;

  if (existing.status === "connected" && existing.connectedAt) {
    existing.durationSec = Math.max(
      existing.durationSec,
      Math.floor((Date.now() - new Date(existing.connectedAt).getTime()) / 1000)
    );
  }

  if (existing.status === "ended" || existing.status === "failed") {
    return existing;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  if (
    existing.callSid &&
    TWILIO_SID_REGEX.test(accountSid) &&
    !isPlaceholderValue(authToken)
  ) {
    try {
      const authHeader = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(existing.callSid)}.json`,
        {
          headers: { Authorization: `Basic ${authHeader}` },
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { status?: string; duration?: string | null };
        const parsedDur = data.duration ? Number(data.duration) : undefined;
        applyTwilioWebhookUpdate({
          callIdHint: existing.callId,
          callSid: existing.callSid,
          callStatus: data.status,
          callDurationSec: Number.isFinite(parsedDur) ? parsedDur : undefined,
        });
      }
    } catch {
      // Keep current record if Twilio poll temporarily fails
    }
  }

  return callStore.get(callId) ?? existing;
}

export async function terminateTwilioOutboundCall(callId: string): Promise<OutboundCallRecord | null> {
  const existing = callStore.get(callId);
  if (!existing) return null;

  if (existing.status === "ended" || existing.status === "failed") {
    return existing;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";

  if (!existing.callSid || !TWILIO_SID_REGEX.test(accountSid) || isPlaceholderValue(authToken)) {
    throw new Error("Twilio call termination requires active Twilio credentials and a valid CallSid.");
  }

  const targetStatus =
    existing.twilioStatus === "queued" || existing.twilioStatus === "ringing" || existing.twilioStatus === "initiated"
      ? "canceled"
      : "completed";

  const authHeader = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
  const form = new URLSearchParams();
  form.set("Status", targetStatus);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(existing.callSid)}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  if (!response.ok) {
    const errPayload = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(errPayload.message || `Failed to terminate Twilio call (HTTP ${response.status}).`);
  }

  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    duration?: string | null;
  };

  const nowIso = new Date().toISOString();
  const parsedDur = data.duration ? Number(data.duration) : undefined;
  const wasConnected = Boolean(existing.connectedAt);
  existing.status = "ended";
  existing.arovaStatus = wasConnected ? "Completed" : "Unanswered";
  existing.twilioStatus =
    data.status === "canceled" || data.status === "completed" ? data.status : targetStatus;
  if (typeof parsedDur === "number" && Number.isFinite(parsedDur)) {
    existing.durationSec = Math.max(0, Math.round(parsedDur));
  }
  existing.endedAt = nowIso;
  existing.updatedAt = nowIso;
  callStore.set(existing.callId, existing);
  notifyStatusListeners(existing);
  return existing;
}

export function buildOutboundAnswerTwimlXml(params: {
  wssStreamUrl: string;
  callId: string;
  streamToken: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXmlAttr(params.wssStreamUrl)}">`,
    `      <Parameter name="callId" value="${escapeXmlAttr(params.callId)}" />`,
    `      <Parameter name="streamToken" value="${escapeXmlAttr(params.streamToken)}" />`,
    "    </Stream>",
    "  </Connect>",
    "</Response>",
  ].join("\n");
}
