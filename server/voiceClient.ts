import type { EscalationWorkflowState } from "./types.ts";

const escalationStore = new Map<string, EscalationWorkflowState>();

const DEFAULT_DEV_VOICE_TIMEOUT_SEC = 30;

export function getVoiceProviderConfig(): {
  configured: boolean;
  providerName: string;
  timeoutSec: number;
  usingDefaultTimeout: boolean;
} {
  const providerName = process.env.VOICE_PROVIDER?.trim() || "Not Configured (Optional in Dev)";
  const webhookUrl = process.env.VOICE_WEBHOOK_URL?.trim() || "";
  const envTimeoutSet = Boolean(process.env.VOICE_CALL_TIMEOUT_SEC?.trim());
  const rawTimeout = Number(process.env.VOICE_CALL_TIMEOUT_SEC || String(DEFAULT_DEV_VOICE_TIMEOUT_SEC));
  const timeoutSec =
    Number.isFinite(rawTimeout) && rawTimeout >= 10 && rawTimeout <= 600
      ? Math.round(rawTimeout)
      : DEFAULT_DEV_VOICE_TIMEOUT_SEC;

  let validWebhook = false;
  if (webhookUrl) {
    try {
      const u = new URL(webhookUrl);
      validWebhook = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      validWebhook = false;
    }
  }

  return {
    configured: Boolean(process.env.VOICE_PROVIDER?.trim() && validWebhook),
    providerName,
    timeoutSec,
    usingDefaultTimeout: !envTimeoutSet,
  };
}

export async function initiateCaregiverEscalation(params: {
  alertId: string;
  patientId: string;
  patientName: string;
  summary: string;
  primaryCaregiverName: string;
  secondaryCaregiverName: string;
  timeoutSec?: number;
  dryRun?: boolean;
}): Promise<EscalationWorkflowState> {
  const config = getVoiceProviderConfig();
  const effectiveTimeout = params.timeoutSec ?? config.timeoutSec;
  const nowIso = new Date().toISOString();

  if (!config.configured && !params.dryRun) {
    const state: EscalationWorkflowState = {
      alertId: params.alertId,
      patientId: params.patientId,
      primaryCaregiverName: params.primaryCaregiverName,
      primaryCaregiverPhoneConfigured: false,
      secondaryCaregiverName: params.secondaryCaregiverName,
      secondaryCaregiverPhoneConfigured: false,
      providerConfigured: false,
      providerName: config.providerName,
      timeoutSec: effectiveTimeout,
      status: "provider_unconfigured",
      startedAt: nowIso,
      isDryRun: false,
      log: [
        `${nowIso} — Critical alert confirmed for ${params.patientName}.`,
        `${nowIso} — Voice provider not configured (VOICE_PROVIDER / VOICE_WEBHOOK_URL missing); no automated phone call placed.`,
      ],
    };
    escalationStore.set(params.alertId, state);
    return state;
  }

  if (config.configured && !params.dryRun) {
    const webhookUrl = process.env.VOICE_WEBHOOK_URL!.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.VOICE_API_KEY?.trim()) {
      headers["Authorization"] = `Bearer ${process.env.VOICE_API_KEY.trim()}`;
    }

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "critical_alert_call_primary",
        alertId: params.alertId,
        patientId: params.patientId,
        patientName: params.patientName,
        caregiverRole: "primary",
        caregiverName: params.primaryCaregiverName,
        summary: params.summary,
        timeoutSec: effectiveTimeout,
      }),
    });

    if (!res.ok) {
      throw new Error(`Voice provider webhook returned HTTP ${res.status}`);
    }

    const state: EscalationWorkflowState = {
      alertId: params.alertId,
      patientId: params.patientId,
      primaryCaregiverName: params.primaryCaregiverName,
      primaryCaregiverPhoneConfigured: true,
      secondaryCaregiverName: params.secondaryCaregiverName,
      secondaryCaregiverPhoneConfigured: true,
      providerConfigured: true,
      providerName: config.providerName,
      timeoutSec: effectiveTimeout,
      status: "calling_primary",
      startedAt: nowIso,
      primaryCallAttemptedAt: nowIso,
      isDryRun: false,
      log: [
        `${nowIso} — Critical alert confirmed. Dispatched primary caregiver call request to ${params.primaryCaregiverName} via ${config.providerName} (timeout ${effectiveTimeout}s).`,
      ],
    };
    escalationStore.set(params.alertId, state);
    return state;
  }

  // Explicit Dry-Run workflow simulation (never masquerades as a real external call)
  const dryState: EscalationWorkflowState = {
    alertId: params.alertId,
    patientId: params.patientId,
    primaryCaregiverName: params.primaryCaregiverName,
    primaryCaregiverPhoneConfigured: false,
    secondaryCaregiverName: params.secondaryCaregiverName,
    secondaryCaregiverPhoneConfigured: false,
    providerConfigured: config.configured,
    providerName: config.configured ? config.providerName : "Workflow Dry-Run (No Live Provider)",
    timeoutSec: effectiveTimeout,
    status: "calling_primary",
    startedAt: nowIso,
    primaryCallAttemptedAt: nowIso,
    isDryRun: true,
    log: [
      `${nowIso} — [DRY-RUN] Critical alert confirmed for ${params.patientName}.`,
      `${nowIso} — [DRY-RUN] Attempting primary caregiver (${params.primaryCaregiverName}); waiting up to ${effectiveTimeout}s for acknowledgement.`,
    ],
  };
  escalationStore.set(params.alertId, dryState);
  return dryState;
}

export function advanceEscalationOutcome(
  alertId: string,
  action: "primary_answered" | "primary_no_answer_escalate" | "secondary_acknowledged"
): EscalationWorkflowState | null {
  const existing = escalationStore.get(alertId);
  if (!existing) return null;

  const nowIso = new Date().toISOString();
  const prefix = existing.isDryRun ? "[DRY-RUN] " : "";

  if (action === "primary_answered") {
    existing.status = "primary_answered";
    existing.acknowledgedAt = nowIso;
    existing.acknowledgedBy = existing.primaryCaregiverName;
    existing.log.push(`${nowIso} — ${prefix}Primary caregiver (${existing.primaryCaregiverName}) answered and acknowledged alert.`);
  } else if (action === "primary_no_answer_escalate") {
    existing.status = "escalated_secondary";
    existing.escalatedAt = nowIso;
    existing.log.push(
      `${nowIso} — ${prefix}No acknowledgement from ${existing.primaryCaregiverName} within ${existing.timeoutSec}s. Escalating to secondary caregiver (${existing.secondaryCaregiverName}).`
    );
  } else if (action === "secondary_acknowledged") {
    existing.status = "completed";
    existing.acknowledgedAt = nowIso;
    existing.acknowledgedBy = existing.secondaryCaregiverName;
    existing.log.push(`${nowIso} — ${prefix}Secondary caregiver (${existing.secondaryCaregiverName}) answered and acknowledged escalation.`);
  }

  escalationStore.set(alertId, existing);
  return existing;
}

export function getEscalationState(alertId: string): EscalationWorkflowState | null {
  return escalationStore.get(alertId) ?? null;
}
