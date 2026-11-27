import {
  getOutboundTwilioConfig,
  initiateTwilioOutboundCall,
  maskPhoneNumber,
  validateE164PhoneNumber,
} from "./outboundVoice.ts";
import { getVoiceProviderConfig } from "./voiceClient.ts";
import type { NotificationChannel, NotificationDeliveryStatus } from "./types.ts";

export interface ProviderChannelStatus {
  configured: boolean;
  mode: "live" | "simulation";
  providerName: string;
  missingEnvVars: string[];
  setupSummary: string;
}

export interface NotificationProvidersStatus {
  sms: ProviderChannelStatus;
  email: ProviderChannelStatus;
  voice: ProviderChannelStatus;
  simulationNotice: string;
  emergencyServicesGuardrail: string;
}

export interface ExternalDispatchResult {
  channel: NotificationChannel;
  provider: string;
  deliveryStatus: NotificationDeliveryStatus;
  isSimulated: boolean;
  targetMasked?: string;
  detail: string;
  errorDetail?: string;
}

const RESTRICTED_EMERGENCY_NUMBERS = new Set([
  "911",
  "112",
  "999",
  "100",
  "101",
  "102",
  "108",
  "000",
]);

function isPlaceholder(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return !trimmed || trimmed.startsWith("MY_") || trimmed === "changeme";
}

function getExotelConfig() {
  const sid = process.env.EXOTEL_SID?.trim() || "";
  const apiKey = process.env.EXOTEL_API_KEY?.trim() || "";
  const apiToken = process.env.EXOTEL_API_TOKEN?.trim() || "";
  const subdomain = process.env.EXOTEL_SUBDOMAIN?.trim() || "api.exotel.com";
  const from = process.env.EXOTEL_CALLER_ID?.trim() || process.env.EXOTEL_FROM?.trim() || "";

  const missing: string[] = [];
  if (isPlaceholder(sid)) missing.push("EXOTEL_SID");
  if (isPlaceholder(apiKey)) missing.push("EXOTEL_API_KEY");
  if (isPlaceholder(apiToken)) missing.push("EXOTEL_API_TOKEN");
  if (isPlaceholder(from)) missing.push("EXOTEL_CALLER_ID");

  return {
    configured: missing.length === 0,
    sid,
    apiKey,
    apiToken,
    subdomain,
    from,
    missing,
  };
}

function getTwilioSmsConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";
  const fromNumber = process.env.TWILIO_PHONE_NUMBER?.trim() || "";
  const validSid = /^AC[a-fA-F0-9]{32}$/.test(accountSid);
  const validToken = !isPlaceholder(authToken) && authToken.length >= 16;
  const validFrom = validateE164PhoneNumber(fromNumber).valid;
  return {
    configured: validSid && validToken && validFrom,
    accountSid,
    authToken,
    fromNumber,
  };
}

function getEmailWebhookConfig() {
  const webhookUrl = process.env.NOTIFICATION_EMAIL_WEBHOOK_URL?.trim() || "";
  const resendKey = process.env.RESEND_API_KEY?.trim() || "";
  const fromEmail = process.env.NOTIFICATION_FROM_EMAIL?.trim() || "";

  let validWebhook = false;
  if (!isPlaceholder(webhookUrl)) {
    try {
      const u = new URL(webhookUrl);
      validWebhook = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      validWebhook = false;
    }
  }

  const resendReady = !isPlaceholder(resendKey) && !isPlaceholder(fromEmail);
  return {
    configured: validWebhook || resendReady,
    mode: validWebhook ? ("webhook" as const) : resendReady ? ("resend" as const) : ("none" as const),
    webhookUrl,
    webhookSecret: process.env.NOTIFICATION_EMAIL_API_KEY?.trim() || "",
    resendKey,
    fromEmail,
    missing: validWebhook || resendReady ? [] : ["NOTIFICATION_EMAIL_WEBHOOK_URL (or RESEND_API_KEY + NOTIFICATION_FROM_EMAIL)"],
  };
}

export function isRestrictedEmergencyDestination(rawTarget: string): boolean {
  const digits = rawTarget.replace(/[^\d]/g, "");
  return RESTRICTED_EMERGENCY_NUMBERS.has(digits);
}

export function maskEmailAddress(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 1) return "***@***";
  return `${trimmed.slice(0, 2)}••••${trimmed.slice(at)}`;
}

export function getNotificationProvidersStatus(): NotificationProvidersStatus {
  const exotel = getExotelConfig();
  const twilioSms = getTwilioSmsConfig();
  const emailCfg = getEmailWebhookConfig();
  const twilioVoice = getOutboundTwilioConfig();
  const genericVoice = getVoiceProviderConfig();

  const smsConfigured = exotel.configured || twilioSms.configured;
  const voiceConfigured = exotel.configured || twilioVoice.configured || genericVoice.configured;

  return {
    sms: {
      configured: smsConfigured,
      mode: smsConfigured ? "live" : "simulation",
      providerName: exotel.configured
        ? "Exotel SMS"
        : twilioSms.configured
        ? "Twilio Programmable SMS"
        : "Simulation Mode (SMS Unconfigured)",
      missingEnvVars: smsConfigured ? [] : ["EXOTEL_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN / EXOTEL_CALLER_ID (or TWILIO_*)"],
      setupSummary: smsConfigured
        ? "Server SMS credentials detected and active."
        : "Configure EXOTEL_* or TWILIO_* variables in Settings > Secrets to enable live SMS alerts. Currently recording simulated SMS attempts.",
    },
    email: {
      configured: emailCfg.configured,
      mode: emailCfg.configured ? "live" : "simulation",
      providerName: emailCfg.mode === "resend"
        ? "Resend Email API"
        : emailCfg.mode === "webhook"
        ? "Email Webhook Relay"
        : "Simulation Mode (Email Unconfigured)",
      missingEnvVars: emailCfg.missing,
      setupSummary: emailCfg.configured
        ? "Email notification backend is configured."
        : "Set NOTIFICATION_EMAIL_WEBHOOK_URL (or RESEND_API_KEY + NOTIFICATION_FROM_EMAIL) in server secrets to send real caregiver emails.",
    },
    voice: {
      configured: voiceConfigured,
      mode: voiceConfigured ? "live" : "simulation",
      providerName: twilioVoice.configured
        ? "Twilio Programmable Voice + Gemini Live"
        : exotel.configured
        ? "Exotel Voice Connect"
        : genericVoice.configured
        ? genericVoice.providerName
        : "Simulation Mode (Voice Unconfigured)",
      missingEnvVars: voiceConfigured ? [] : twilioVoice.missingEnvVars,
      setupSummary: voiceConfigured
        ? "Voice escalation provider is configured on the server."
        : "Configure TWILIO_* + APP_URL (or EXOTEL_*) in server secrets to place live caregiver calls.",
    },
    simulationNotice:
      "Unconfigured external channels operate in clearly labeled Simulation Mode (marked 'simulated', never 'delivered').",
    emergencyServicesGuardrail:
      "AROVA never automatically contacts emergency services (911/112/108) or claims emergency responders were notified.",
  };
}

export async function dispatchSmsNotification(params: {
  toPhone?: string;
  message: string;
}): Promise<ExternalDispatchResult> {
  const cleanPhone = params.toPhone?.trim() || "";
  if (cleanPhone && isRestrictedEmergencyDestination(cleanPhone)) {
    return {
      channel: "sms",
      provider: "Safety Guardrail",
      deliveryStatus: "skipped_unauthorized",
      isSimulated: false,
      detail: "Blocked attempt to message an emergency service number directly.",
      errorDetail: "AROVA does not automatically contact emergency services.",
    };
  }

  const exotel = getExotelConfig();
  const twilioSms = getTwilioSmsConfig();

  if (!cleanPhone || !validateE164PhoneNumber(cleanPhone).valid) {
    return {
      channel: "sms",
      provider: "Simulation Mode (No Caregiver Phone E.164)",
      deliveryStatus: "simulated",
      isSimulated: true,
      detail: `[SIMULATED SMS] ${params.message} (no verified E.164 phone registered on contact).`,
    };
  }

  const masked = maskPhoneNumber(cleanPhone);

  if (exotel.configured) {
    try {
      const auth = Buffer.from(`${exotel.apiKey}:${exotel.apiToken}`, "utf8").toString("base64");
      const form = new URLSearchParams();
      form.set("From", exotel.from);
      form.set("To", cleanPhone);
      form.set("Body", params.message.slice(0, 480));

      const res = await fetch(
        `https://${encodeURIComponent(exotel.subdomain)}/v1/Accounts/${encodeURIComponent(exotel.sid)}/Sms/send.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        }
      );

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        return {
          channel: "sms",
          provider: "Exotel SMS",
          deliveryStatus: "failed",
          isSimulated: false,
          targetMasked: masked,
          detail: `Exotel SMS dispatch failed (HTTP ${res.status}).`,
          errorDetail: bodyText.slice(0, 200) || `HTTP ${res.status}`,
        };
      }

      return {
        channel: "sms",
        provider: "Exotel SMS",
        deliveryStatus: "delivered",
        isSimulated: false,
        targetMasked: masked,
        detail: `SMS delivered via Exotel to ${masked}.`,
      };
    } catch (err) {
      return {
        channel: "sms",
        provider: "Exotel SMS",
        deliveryStatus: "failed",
        isSimulated: false,
        targetMasked: masked,
        detail: "Exotel SMS network request failed.",
        errorDetail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (twilioSms.configured) {
    try {
      const auth = Buffer.from(`${twilioSms.accountSid}:${twilioSms.authToken}`, "utf8").toString("base64");
      const form = new URLSearchParams();
      form.set("From", twilioSms.fromNumber);
      form.set("To", cleanPhone);
      form.set("Body", params.message.slice(0, 480));

      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSms.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        }
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        return {
          channel: "sms",
          provider: "Twilio SMS",
          deliveryStatus: "failed",
          isSimulated: false,
          targetMasked: masked,
          detail: `Twilio SMS failed (HTTP ${res.status}).`,
          errorDetail: payload.message || `HTTP ${res.status}`,
        };
      }

      return {
        channel: "sms",
        provider: "Twilio SMS",
        deliveryStatus: "delivered",
        isSimulated: false,
        targetMasked: masked,
        detail: `SMS delivered via Twilio to ${masked}.`,
      };
    } catch (err) {
      return {
        channel: "sms",
        provider: "Twilio SMS",
        deliveryStatus: "failed",
        isSimulated: false,
        targetMasked: masked,
        detail: "Twilio SMS request failed.",
        errorDetail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    channel: "sms",
    provider: "Simulation Mode (SMS Unconfigured)",
    deliveryStatus: "simulated",
    isSimulated: true,
    targetMasked: masked,
    detail: `[SIMULATED SMS] Would send to ${masked}: ${params.message.slice(0, 180)}`,
  };
}

export async function dispatchEmailNotification(params: {
  toEmail?: string;
  subject: string;
  text: string;
}): Promise<ExternalDispatchResult> {
  const emailCfg = getEmailWebhookConfig();
  const cleanEmail = params.toEmail?.trim() || "";
  const masked = cleanEmail ? maskEmailAddress(cleanEmail) : undefined;

  if (!emailCfg.configured || !cleanEmail) {
    return {
      channel: "email",
      provider: "Simulation Mode (Email Unconfigured)",
      deliveryStatus: "simulated",
      isSimulated: true,
      targetMasked: masked,
      detail: `[SIMULATED EMAIL] ${params.subject}${masked ? ` -> ${masked}` : " (no recipient email configured)"}`,
    };
  }

  try {
    if (emailCfg.mode === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${emailCfg.resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: emailCfg.fromEmail,
          to: [cleanEmail],
          subject: params.subject.slice(0, 160),
          text: params.text.slice(0, 1500),
        }),
      });
      if (!res.ok) {
        return {
          channel: "email",
          provider: "Resend Email API",
          deliveryStatus: "failed",
          isSimulated: false,
          targetMasked: masked,
          detail: `Email delivery failed (HTTP ${res.status}).`,
          errorDetail: `Resend HTTP ${res.status}`,
        };
      }
      return {
        channel: "email",
        provider: "Resend Email API",
        deliveryStatus: "delivered",
        isSimulated: false,
        targetMasked: masked,
        detail: `Email delivered to ${masked}.`,
      };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (emailCfg.webhookSecret) {
      headers["Authorization"] = `Bearer ${emailCfg.webhookSecret}`;
    }
    const res = await fetch(emailCfg.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: cleanEmail,
        subject: params.subject.slice(0, 160),
        text: params.text.slice(0, 1500),
        isPrototypeNotice: true,
      }),
    });
    if (!res.ok) {
      return {
        channel: "email",
        provider: "Email Webhook Relay",
        deliveryStatus: "failed",
        isSimulated: false,
        targetMasked: masked,
        detail: `Email webhook returned HTTP ${res.status}.`,
        errorDetail: `HTTP ${res.status}`,
      };
    }
    return {
      channel: "email",
      provider: "Email Webhook Relay",
      deliveryStatus: "delivered",
      isSimulated: false,
      targetMasked: masked,
      detail: `Email dispatched via webhook to ${masked}.`,
    };
  } catch (err) {
    return {
      channel: "email",
      provider: emailCfg.mode === "resend" ? "Resend Email API" : "Email Webhook Relay",
      deliveryStatus: "failed",
      isSimulated: false,
      targetMasked: masked,
      detail: "Email delivery request failed.",
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function dispatchVoiceCallNotification(params: {
  toPhone?: string;
  explicitCallConsent?: boolean;
  caregiverName: string;
  patientName: string;
  reason: string;
  publicBaseUrlOverride?: string;
}): Promise<ExternalDispatchResult> {
  const cleanPhone = params.toPhone?.trim() || "";
  if (cleanPhone && isRestrictedEmergencyDestination(cleanPhone)) {
    return {
      channel: "voice_call",
      provider: "Safety Guardrail",
      deliveryStatus: "skipped_unauthorized",
      isSimulated: false,
      detail: "Blocked automatic calling of emergency services.",
      errorDetail: "AROVA does not place automated calls to emergency services.",
    };
  }

  const twilioCfg = getOutboundTwilioConfig();
  const masked = cleanPhone && validateE164PhoneNumber(cleanPhone).valid ? maskPhoneNumber(cleanPhone) : undefined;

  if (!params.explicitCallConsent || !masked || !twilioCfg.configured) {
    const reasonHint = !twilioCfg.configured
      ? "Twilio credentials not configured"
      : !params.explicitCallConsent
      ? "explicit caregiver call consent not granted"
      : "no E.164 phone registered";
    return {
      channel: "voice_call",
      provider: "Simulation Mode (Voice Unconfigured)",
      deliveryStatus: "simulated",
      isSimulated: true,
      targetMasked: masked,
      detail: `[SIMULATED VOICE CALL] Would call ${params.caregiverName}${masked ? ` (${masked})` : ""} for ${params.patientName} (${reasonHint}).`,
    };
  }

  try {
    const call = await initiateTwilioOutboundCall({
      toE164: cleanPhone,
      publicBaseUrlOverride: params.publicBaseUrlOverride,
      context: {
        callType: "emergency_escalation",
        patientName: params.patientName,
        alertSeverity: "High",
        reasonForCalling: params.reason,
        caregiverName: params.caregiverName,
        caregiverPriority: "primary",
        preferredLanguage: "en",
        authorizedForPatientIdentity: true,
        authorizedForHealthReadings: true,
        explicitCallConsent: true,
        retryCount: 0,
      },
    });
    return {
      channel: "voice_call",
      provider: "Twilio Programmable Voice",
      deliveryStatus: "delivered",
      isSimulated: false,
      targetMasked: masked,
      detail: `Outbound voice call (${call.callId}) placed to ${params.caregiverName} (${masked}).`,
    };
  } catch (err) {
    return {
      channel: "voice_call",
      provider: "Twilio Programmable Voice",
      deliveryStatus: "failed",
      isSimulated: false,
      targetMasked: masked,
      detail: `Voice call to ${params.caregiverName} failed.`,
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  }
}
