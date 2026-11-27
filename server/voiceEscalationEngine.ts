import crypto from "node:crypto";
import type { Request } from "express";
import {
  classifyAnalysisWithAlertLevelsPolicy,
  getDefaultAlertLevelsPolicy,
  sanitizeAlertLevelsPolicy,
  type AlertLevelsPolicyConfig,
  type AlertLevelId,
} from "./alertLevelConfig.ts";
import type { CaregiverClassificationResult } from "./geminiLiveBridge.ts";
import {
  getOutboundTwilioConfig,
  initiateTwilioOutboundCall,
  maskPhoneNumber,
  validateE164PhoneNumber,
  type ArovaCallStatus,
  type CaregiverResponseCategory,
  type OutboundCallRecord,
  type SupportedVoiceLanguage,
  type VoiceCallContext,
} from "./outboundVoice.ts";
import type { MlAnalysisResult, TelemetryPayload } from "./types.ts";

export type CaregiverPriority = "primary" | "secondary" | "alternate";
export type EmergencySeverity = AlertLevelId;
export type EscalationWorkflowStatus =
  | "logged_low"
  | "notified_medium"
  | "calling_primary"
  | "retrying"
  | "escalated_secondary"
  | "acknowledged"
  | "human_follow_up_required"
  | "fallback_notified"
  | "resolved";

export type CallEscalationBadgeStatus =
  | "none"
  | "calling_primary"
  | "retrying"
  | "escalated_secondary"
  | "acknowledged"
  | "human_follow_up_required"
  | "fallback_notified";

export interface CaregiverContactInternal {
  contactId: string;
  patientId: string;
  patientOwnerUid: string;
  caregiverUid?: string;
  caregiverName: string;
  e164Phone: string;
  maskedPhone: string;
  priority: CaregiverPriority;
  priorityRank: number;
  preferredLanguage: SupportedVoiceLanguage;
  explicitCallConsent: boolean;
  consentRecordedAt: string | null;
  authorizedForPatientIdentity: boolean;
  authorizedForHealthReadings: boolean;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export type PublicCaregiverContact = Omit<CaregiverContactInternal, "e164Phone">;

export interface VoiceRetryPolicyConfig {
  retryIntervalSec: number;
  maxCallAttempts: number;
  fallbackNotificationEnabled: boolean;
  updatedAt: string;
  updatedByUid: string;
}

export interface VoiceCallHistoryEntry {
  callId: string;
  callSid: string | null;
  escalationId: string | null;
  alertId: string | null;
  patientId: string;
  patientOwnerUid: string;
  patientName: string;
  alertSeverity: EmergencySeverity | "Test";
  reasonForCalling: string;
  relevantReading: string;
  caregiverContactId: string | null;
  caregiverName: string;
  caregiverPriority: CaregiverPriority | "test";
  maskedPhone: string;
  callStatus: ArovaCallStatus;
  selectedLanguage: SupportedVoiceLanguage;
  caregiverResponse: CaregiverResponseCategory;
  responseSummary: string | null;
  durationSec: number;
  retryCount: number;
  escalationStatus: CallEscalationBadgeStatus;
  followUpAction: string;
  isTestCall: boolean;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface VoiceEscalationEvent {
  escalationId: string;
  alertId: string;
  patientId: string;
  patientOwnerUid: string;
  patientName: string;
  severity: EmergencySeverity;
  triggerMetric: string;
  readingSummary: string;
  reasonForCalling: string;
  escalationStatus: EscalationWorkflowStatus;
  activeAttemptCount: number;
  maxAttempts: number;
  retryIntervalSec: number;
  currentCaregiverIndex: number;
  currentCaregiverName: string | null;
  currentCaregiverPriority: CaregiverPriority | null;
  caregiverResponse: CaregiverResponseCategory;
  fallbackTriggered: boolean;
  humanFollowUpRequired: boolean;
  emergencyActive: boolean;
  followUpAction: string;
  caregiverOrderIds: string[];
  attemptForCurrentCaregiver: number;
  callIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VoiceAuditLogEntry {
  auditId: string;
  eventType: string;
  patientId: string;
  patientOwnerUid: string;
  callId: string | null;
  escalationId: string | null;
  actorUid: string;
  summary: string;
  createdAt: string;
}

export type OutboundCallLauncher = (params: {
  toE164: string;
  req?: Request;
  publicBaseUrlOverride?: string;
  context?: VoiceCallContext;
}) => Promise<OutboundCallRecord>;

const MAX_CALL_HISTORY = 400;
const MAX_ESCALATIONS = 200;
const MAX_AUDIT_LOGS = 600;

function priorityDefaultRank(priority: CaregiverPriority): number {
  if (priority === "primary") return 1;
  if (priority === "secondary") return 2;
  return 3;
}

export function toPublicCaregiverContact(
  internal: CaregiverContactInternal
): PublicCaregiverContact {
  const { e164Phone: _omitted, ...safe } = internal;
  return safe;
}

export function extractRelevantReadingSummary(
  telemetry: Pick<TelemetryPayload, "heartRate" | "spo2" | "temperatureC" | "accelMagnitude">,
  analysis: Pick<MlAnalysisResult, "triggeredMetrics">
): {
  parameter: string;
  readingValue: string;
  readingUnit: string;
  summary: string;
} {
  const primaryTrigger = analysis.triggeredMetrics[0] || "";
  if (/spo2/i.test(primaryTrigger) && telemetry.spo2 !== null) {
    return {
      parameter: "SpO2",
      readingValue: telemetry.spo2.toFixed(1),
      readingUnit: "%",
      summary: `SpO2 ${telemetry.spo2.toFixed(1)}%`,
    };
  }
  if (/temp/i.test(primaryTrigger) && telemetry.temperatureC !== null) {
    return {
      parameter: "Temperature",
      readingValue: telemetry.temperatureC.toFixed(1),
      readingUnit: "°C",
      summary: `Temp ${telemetry.temperatureC.toFixed(1)} °C`,
    };
  }
  if (/movement|fall/i.test(primaryTrigger)) {
    return {
      parameter: "IMU Acceleration",
      readingValue: telemetry.accelMagnitude.toFixed(2),
      readingUnit: "g",
      summary: `Accel ${telemetry.accelMagnitude.toFixed(2)} g`,
    };
  }
  if (telemetry.heartRate !== null) {
    return {
      parameter: "Heart Rate",
      readingValue: String(Math.round(telemetry.heartRate)),
      readingUnit: "BPM",
      summary: `HR ${Math.round(telemetry.heartRate)} BPM`,
    };
  }
  if (telemetry.spo2 !== null) {
    return {
      parameter: "SpO2",
      readingValue: telemetry.spo2.toFixed(1),
      readingUnit: "%",
      summary: `SpO2 ${telemetry.spo2.toFixed(1)}%`,
    };
  }
  if (telemetry.temperatureC !== null) {
    return {
      parameter: "Temperature",
      readingValue: telemetry.temperatureC.toFixed(1),
      readingUnit: "°C",
      summary: `Temp ${telemetry.temperatureC.toFixed(1)} °C`,
    };
  }
  return {
    parameter: primaryTrigger || "Physiological Signal",
    readingValue: "Out of threshold",
    readingUnit: "",
    summary: primaryTrigger || "Threshold deviation",
  };
}

export function mapAnalysisToEmergencySeverity(
  analysis: Pick<MlAnalysisResult, "alertLevel" | "anomalyStatus" | "anomalyScore" | "persistenceCount">,
  policy?: AlertLevelsPolicyConfig
): EmergencySeverity | null {
  return classifyAnalysisWithAlertLevelsPolicy(
    analysis,
    policy ?? getDefaultAlertLevelsPolicy()
  ).severity;
}

export class VoiceEscalationEngine {
  private readonly contacts = new Map<string, CaregiverContactInternal>();
  private readonly callHistory = new Map<string, VoiceCallHistoryEntry>();
  private readonly escalations = new Map<string, VoiceEscalationEvent>();
  private readonly auditLogs: VoiceAuditLogEntry[] = [];
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly callLauncher: OutboundCallLauncher;

  private retryPolicy: VoiceRetryPolicyConfig = {
    retryIntervalSec: 30,
    maxCallAttempts: 2,
    fallbackNotificationEnabled: true,
    updatedAt: new Date().toISOString(),
    updatedByUid: "system_default",
  };

  private alertLevelsPolicy: AlertLevelsPolicyConfig = getDefaultAlertLevelsPolicy();

  constructor(options?: { callLauncher?: OutboundCallLauncher }) {
    this.callLauncher = options?.callLauncher ?? initiateTwilioOutboundCall;
  }

  public clearForTests(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.contacts.clear();
    this.callHistory.clear();
    this.escalations.clear();
    this.auditLogs.length = 0;
    this.retryPolicy = {
      retryIntervalSec: 30,
      maxCallAttempts: 2,
      fallbackNotificationEnabled: true,
      updatedAt: new Date().toISOString(),
      updatedByUid: "system_default",
    };
    this.alertLevelsPolicy = getDefaultAlertLevelsPolicy();
  }

  private recordAudit(params: {
    eventType: string;
    patientId: string;
    patientOwnerUid: string;
    callId?: string | null;
    escalationId?: string | null;
    actorUid: string;
    summary: string;
  }): VoiceAuditLogEntry {
    const entry: VoiceAuditLogEntry = {
      auditId: `aud_${crypto.randomUUID().slice(0, 12)}`,
      eventType: params.eventType.slice(0, 80),
      patientId: params.patientId,
      patientOwnerUid: params.patientOwnerUid,
      callId: params.callId ?? null,
      escalationId: params.escalationId ?? null,
      actorUid: params.actorUid,
      summary: params.summary.slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > MAX_AUDIT_LOGS) {
      this.auditLogs.pop();
    }
    return entry;
  }

  public getAuditLogs(scope?: { patientOwnerUid?: string; isAdmin?: boolean }): VoiceAuditLogEntry[] {
    if (scope?.isAdmin) return [...this.auditLogs];
    if (scope?.patientOwnerUid) {
      return this.auditLogs.filter((l) => l.patientOwnerUid === scope.patientOwnerUid);
    }
    return [];
  }

  public getRetryPolicy(): VoiceRetryPolicyConfig {
    return { ...this.retryPolicy };
  }

  public updateRetryPolicy(
    input: {
      retryIntervalSec?: number;
      maxCallAttempts?: number;
      fallbackNotificationEnabled?: boolean;
    },
    actorUid: string
  ): VoiceRetryPolicyConfig {
    const retryIntervalSec =
      typeof input.retryIntervalSec === "number" && Number.isFinite(input.retryIntervalSec)
        ? Math.max(10, Math.min(600, Math.round(input.retryIntervalSec)))
        : this.retryPolicy.retryIntervalSec;
    const maxCallAttempts =
      typeof input.maxCallAttempts === "number" && Number.isFinite(input.maxCallAttempts)
        ? Math.max(1, Math.min(5, Math.round(input.maxCallAttempts)))
        : this.retryPolicy.maxCallAttempts;
    const fallbackNotificationEnabled =
      typeof input.fallbackNotificationEnabled === "boolean"
        ? input.fallbackNotificationEnabled
        : this.retryPolicy.fallbackNotificationEnabled;

    this.retryPolicy = {
      retryIntervalSec,
      maxCallAttempts,
      fallbackNotificationEnabled,
      updatedAt: new Date().toISOString(),
      updatedByUid: actorUid,
    };

    // Keep High alert level escalation timings synchronized with global retry policy
    this.alertLevelsPolicy = {
      ...this.alertLevelsPolicy,
      updatedAt: this.retryPolicy.updatedAt,
      updatedByUid: actorUid,
      levels: {
        ...this.alertLevelsPolicy.levels,
        High: {
          ...this.alertLevelsPolicy.levels.High,
          escalation: {
            ...this.alertLevelsPolicy.levels.High.escalation,
            retryIntervalSec,
            maxCallAttempts,
          },
        },
      },
    };

    this.recordAudit({
      eventType: "retry_policy_updated",
      patientId: "global",
      patientOwnerUid: actorUid,
      actorUid,
      summary: `Updated voice retry policy: interval=${retryIntervalSec}s, maxAttempts=${maxCallAttempts}, fallback=${fallbackNotificationEnabled}.`,
    });

    return this.getRetryPolicy();
  }

  public getAlertLevelsPolicy(): AlertLevelsPolicyConfig {
    return structuredClone(this.alertLevelsPolicy);
  }

  public updateAlertLevelsPolicy(input: unknown, actorUid: string): AlertLevelsPolicyConfig {
    const next = sanitizeAlertLevelsPolicy(input, actorUid, this.alertLevelsPolicy);
    this.alertLevelsPolicy = next;

    const highEsc = next.levels.High.escalation;
    this.retryPolicy = {
      ...this.retryPolicy,
      retryIntervalSec: highEsc.retryIntervalSec,
      maxCallAttempts: Math.max(1, highEsc.maxCallAttempts || this.retryPolicy.maxCallAttempts),
      updatedAt: next.updatedAt,
      updatedByUid: actorUid,
    };

    this.recordAudit({
      eventType: "alert_levels_policy_updated",
      patientId: "global",
      patientOwnerUid: actorUid,
      actorUid,
      summary: `Updated Low/Medium/High alert levels policy (Low=${next.levels.Low.escalation.action}, Medium=${next.levels.Medium.escalation.action}, High=${next.levels.High.escalation.action}).`,
    });

    return this.getAlertLevelsPolicy();
  }

  public resetAlertLevelsPolicy(actorUid: string): AlertLevelsPolicyConfig {
    const defaults = getDefaultAlertLevelsPolicy();
    defaults.updatedByUid = actorUid;
    this.alertLevelsPolicy = defaults;
    this.retryPolicy = {
      ...this.retryPolicy,
      retryIntervalSec: defaults.levels.High.escalation.retryIntervalSec,
      maxCallAttempts: Math.max(1, defaults.levels.High.escalation.maxCallAttempts),
      updatedAt: defaults.updatedAt,
      updatedByUid: actorUid,
    };
    this.recordAudit({
      eventType: "alert_levels_policy_reset",
      patientId: "global",
      patientOwnerUid: actorUid,
      actorUid,
      summary: "Reset Low/Medium/High anomaly alert level configuration to clinical defaults.",
    });
    return this.getAlertLevelsPolicy();
  }

  public upsertCaregiverContact(
    input: {
      contactId?: string;
      patientId: string;
      patientOwnerUid: string;
      caregiverUid?: string;
      caregiverName: string;
      e164Phone: string;
      priority: CaregiverPriority;
      priorityRank?: number;
      preferredLanguage?: SupportedVoiceLanguage;
      explicitCallConsent: boolean;
      authorizedForPatientIdentity?: boolean;
      authorizedForHealthReadings?: boolean;
      status?: "active" | "paused";
    },
    actorUid: string
  ): PublicCaregiverContact {
    const phoneCheck = validateE164PhoneNumber(input.e164Phone);
    if (!phoneCheck.valid || !phoneCheck.normalized) {
      throw new Error(phoneCheck.error || "Invalid E.164 phone number.");
    }

    const name = input.caregiverName.trim().slice(0, 100);
    if (!name) {
      throw new Error("Caregiver name is required.");
    }

    const nowIso = new Date().toISOString();
    const existing = input.contactId ? this.contacts.get(input.contactId) : undefined;
    const contactId = existing?.contactId ?? (input.contactId?.trim() || `cg_${crypto.randomUUID().slice(0, 12)}`);
    const priority: CaregiverPriority =
      input.priority === "secondary" || input.priority === "alternate" ? input.priority : "primary";
    const preferredLanguage: SupportedVoiceLanguage =
      input.preferredLanguage === "kn" || input.preferredLanguage === "hi" ? input.preferredLanguage : "en";

    const consentChangedToTrue = input.explicitCallConsent && !existing?.explicitCallConsent;
    const record: CaregiverContactInternal = {
      contactId,
      patientId: input.patientId.trim(),
      patientOwnerUid: input.patientOwnerUid.trim(),
      caregiverUid: input.caregiverUid?.trim() || existing?.caregiverUid,
      caregiverName: name,
      e164Phone: phoneCheck.normalized,
      maskedPhone: maskPhoneNumber(phoneCheck.normalized),
      priority,
      priorityRank:
        typeof input.priorityRank === "number" && Number.isFinite(input.priorityRank)
          ? Math.max(1, Math.min(10, Math.round(input.priorityRank)))
          : priorityDefaultRank(priority),
      preferredLanguage,
      explicitCallConsent: Boolean(input.explicitCallConsent),
      consentRecordedAt: input.explicitCallConsent
        ? consentChangedToTrue || !existing?.consentRecordedAt
          ? nowIso
          : existing.consentRecordedAt
        : null,
      authorizedForPatientIdentity: Boolean(input.authorizedForPatientIdentity),
      authorizedForHealthReadings: Boolean(input.authorizedForHealthReadings),
      status: input.status === "paused" ? "paused" : "active",
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    this.contacts.set(contactId, record);
    this.recordAudit({
      eventType: existing ? "caregiver_contact_updated" : "caregiver_contact_created",
      patientId: record.patientId,
      patientOwnerUid: record.patientOwnerUid,
      actorUid,
      summary: `${existing ? "Updated" : "Registered"} caregiver ${record.caregiverName} (${record.priority}, ${record.maskedPhone}, consent=${record.explicitCallConsent}, lang=${record.preferredLanguage}).`,
    });

    return toPublicCaregiverContact(record);
  }

  public getCaregiverContact(contactId: string): CaregiverContactInternal | null {
    return this.contacts.get(contactId) ?? null;
  }

  public listCaregiverContacts(scope: {
    patientId?: string;
    callerUid?: string;
    isAdmin?: boolean;
  }): PublicCaregiverContact[] {
    const out: PublicCaregiverContact[] = [];
    for (const c of this.contacts.values()) {
      if (scope.patientId && c.patientId !== scope.patientId) continue;
      if (!scope.isAdmin) {
        if (
          !scope.callerUid ||
          (c.patientOwnerUid !== scope.callerUid && c.caregiverUid !== scope.callerUid)
        ) {
          continue;
        }
      }
      out.push(toPublicCaregiverContact(c));
    }
    return out.sort((a, b) => a.priorityRank - b.priorityRank);
  }

  public deleteCaregiverContact(contactId: string, actorUid: string, isAdmin: boolean): boolean {
    const existing = this.contacts.get(contactId);
    if (!existing) return false;
    if (!isAdmin && existing.patientOwnerUid !== actorUid) {
      throw new Error("Forbidden: only the patient owner or an administrator may delete this contact.");
    }
    this.contacts.delete(contactId);
    this.recordAudit({
      eventType: "caregiver_contact_deleted",
      patientId: existing.patientId,
      patientOwnerUid: existing.patientOwnerUid,
      actorUid,
      summary: `Removed caregiver contact ${existing.caregiverName} (${existing.maskedPhone}).`,
    });
    return true;
  }

  private getOrderedConsentedCaregivers(patientId: string): CaregiverContactInternal[] {
    const list: CaregiverContactInternal[] = [];
    for (const c of this.contacts.values()) {
      if (c.patientId === patientId && c.status === "active" && c.explicitCallConsent) {
        list.push(c);
      }
    }
    return list.sort((a, b) => a.priorityRank - b.priorityRank);
  }

  public listCallHistory(scope: {
    patientId?: string;
    callerUid?: string;
    isAdmin?: boolean;
  }): VoiceCallHistoryEntry[] {
    const items = Array.from(this.callHistory.values()).filter((item) => {
      if (scope.patientId && item.patientId !== scope.patientId) return false;
      if (scope.isAdmin) return true;
      return Boolean(scope.callerUid && item.patientOwnerUid === scope.callerUid);
    });
    return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public listEscalations(scope: {
    patientId?: string;
    callerUid?: string;
    isAdmin?: boolean;
  }): VoiceEscalationEvent[] {
    const items = Array.from(this.escalations.values()).filter((item) => {
      if (scope.patientId && item.patientId !== scope.patientId) return false;
      if (scope.isAdmin) return true;
      return Boolean(scope.callerUid && item.patientOwnerUid === scope.callerUid);
    });
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public getActiveHighEscalationForPatient(patientId: string): VoiceEscalationEvent | null {
    for (const esc of this.escalations.values()) {
      if (
        esc.patientId === patientId &&
        esc.severity === "High" &&
        esc.emergencyActive &&
        esc.escalationStatus !== "resolved"
      ) {
        return esc;
      }
    }
    return null;
  }

  private saveCallHistoryEntry(entry: VoiceCallHistoryEntry): void {
    if (!this.callHistory.has(entry.callId) && this.callHistory.size >= MAX_CALL_HISTORY) {
      const oldestKey = this.callHistory.keys().next().value;
      if (oldestKey) this.callHistory.delete(oldestKey);
    }
    this.callHistory.set(entry.callId, entry);
  }

  private saveEscalation(esc: VoiceEscalationEvent): void {
    if (!this.escalations.has(esc.escalationId) && this.escalations.size >= MAX_ESCALATIONS) {
      const oldestKey = this.escalations.keys().next().value;
      if (oldestKey) this.escalations.delete(oldestKey);
    }
    this.escalations.set(esc.escalationId, esc);
  }

  public async triggerAdminTestCall(params: {
    contactId: string;
    patientName?: string;
    parameter?: string;
    readingValue?: string;
    readingUnit?: string;
    language?: SupportedVoiceLanguage;
    reasonForCalling?: string;
    actorUid: string;
    req?: Request;
    publicBaseUrlOverride?: string;
  }): Promise<VoiceCallHistoryEntry> {
    const contact = this.contacts.get(params.contactId);
    if (!contact) {
      throw new Error("Registered caregiver contact not found.");
    }
    if (contact.status !== "active") {
      throw new Error("Caregiver contact is paused and cannot receive automated calls.");
    }
    if (!contact.explicitCallConsent) {
      throw new Error(
        `Caregiver ${contact.caregiverName} has not granted explicit automated-call consent.`
      );
    }

    const lang = params.language ?? contact.preferredLanguage;
    const patientDisplayName = (params.patientName || `Patient (${contact.patientId})`).slice(0, 100);
    const paramLabel = (params.parameter || "Heart Rate").slice(0, 60);
    const readingVal = (params.readingValue || "118").slice(0, 40);
    const readingUnit = (params.readingUnit || "BPM").slice(0, 20);
    const relevantReading = `${paramLabel}: ${readingVal}${readingUnit ? ` ${readingUnit}` : ""}`;
    const reason =
      params.reasonForCalling?.trim() ||
      "Admin verification test call for Arova AI emergency caregiver voice readiness.";

    const nowIso = new Date().toISOString();
    const callContext: VoiceCallContext = {
      callType: "test_call",
      patientId: contact.patientId,
      patientOwnerUid: contact.patientOwnerUid,
      patientName: patientDisplayName,
      alertSeverity: "Test",
      parameter: paramLabel,
      readingValue: readingVal,
      readingUnit,
      thresholdContext: "Administrator system verification test event",
      reasonForCalling: reason,
      relevantReading,
      eventTimestamp: nowIso,
      caregiverContactId: contact.contactId,
      caregiverName: contact.caregiverName,
      caregiverPriority: "test",
      preferredLanguage: lang,
      authorizedForPatientIdentity: contact.authorizedForPatientIdentity,
      authorizedForHealthReadings: contact.authorizedForHealthReadings,
      explicitCallConsent: contact.explicitCallConsent,
      retryCount: 0,
    };

    try {
      const outbound = await this.callLauncher({
        toE164: contact.e164Phone,
        req: params.req,
        publicBaseUrlOverride: params.publicBaseUrlOverride,
        context: callContext,
      });

      const entry: VoiceCallHistoryEntry = {
        callId: outbound.callId,
        callSid: outbound.callSid,
        escalationId: null,
        alertId: null,
        patientId: contact.patientId,
        patientOwnerUid: contact.patientOwnerUid,
        patientName: patientDisplayName,
        alertSeverity: "Test",
        reasonForCalling: reason,
        relevantReading,
        caregiverContactId: contact.contactId,
        caregiverName: contact.caregiverName,
        caregiverPriority: "test",
        maskedPhone: contact.maskedPhone,
        callStatus: outbound.arovaStatus,
        selectedLanguage: lang,
        caregiverResponse: "Pending",
        responseSummary: null,
        durationSec: outbound.durationSec,
        retryCount: 0,
        escalationStatus: "none",
        followUpAction: "Admin test call initiated via Twilio.",
        isTestCall: true,
        errorMessage: outbound.errorMessage,
        startedAt: outbound.startedAt,
        endedAt: outbound.endedAt,
        updatedAt: outbound.updatedAt,
      };
      this.saveCallHistoryEntry(entry);

      this.recordAudit({
        eventType: "admin_test_call_initiated",
        patientId: contact.patientId,
        patientOwnerUid: contact.patientOwnerUid,
        callId: entry.callId,
        actorUid: params.actorUid,
        summary: `Admin initiated real test call to ${contact.caregiverName} (${contact.maskedPhone}, lang=${lang}).`,
      });

      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to place test call.";
      const failedCallId = `call_fail_${crypto.randomUUID().slice(0, 12)}`;
      const failedEntry: VoiceCallHistoryEntry = {
        callId: failedCallId,
        callSid: null,
        escalationId: null,
        alertId: null,
        patientId: contact.patientId,
        patientOwnerUid: contact.patientOwnerUid,
        patientName: patientDisplayName,
        alertSeverity: "Test",
        reasonForCalling: reason,
        relevantReading,
        caregiverContactId: contact.contactId,
        caregiverName: contact.caregiverName,
        caregiverPriority: "test",
        maskedPhone: contact.maskedPhone,
        callStatus: "Failed",
        selectedLanguage: lang,
        caregiverResponse: "Pending",
        responseSummary: null,
        durationSec: 0,
        retryCount: 0,
        escalationStatus: "none",
        followUpAction: msg.slice(0, 280),
        isTestCall: true,
        errorMessage: msg,
        startedAt: nowIso,
        endedAt: nowIso,
        updatedAt: nowIso,
      };
      this.saveCallHistoryEntry(failedEntry);

      this.recordAudit({
        eventType: "admin_test_call_failed",
        patientId: contact.patientId,
        patientOwnerUid: contact.patientOwnerUid,
        callId: failedCallId,
        actorUid: params.actorUid,
        summary: `Admin test call to ${contact.caregiverName} failed: ${msg}`,
      });

      throw err;
    }
  }

  public async evaluateAnalysisEvent(params: {
    telemetry: TelemetryPayload;
    analysis: MlAnalysisResult;
    patientName?: string;
    patientOwnerUid?: string;
    alertId?: string;
    actorUid?: string;
    publicBaseUrlOverride?: string;
  }): Promise<{
    severity: EmergencySeverity | null;
    escalation: VoiceEscalationEvent | null;
    duplicateSuppressed: boolean;
  }> {
    const classification = classifyAnalysisWithAlertLevelsPolicy(
      params.analysis,
      this.alertLevelsPolicy
    );
    const severity = classification.severity;
    const escalationPlan = classification.escalationPlan;
    if (!severity || !escalationPlan) {
      return { severity: null, escalation: null, duplicateSuppressed: false };
    }

    const patientId = params.telemetry.patientId;
    const ownerUid = params.patientOwnerUid || "system_ingest";
    const patientName = (params.patientName || `Patient ${patientId}`).slice(0, 100);
    const readingInfo = extractRelevantReadingSummary(params.telemetry, params.analysis);
    const nowIso = new Date().toISOString();

    if (!escalationPlan.triggerAutomatedVoiceCall && (!escalationPlan.notifyCaregivers || escalationPlan.action === "log_only")) {
      const esc: VoiceEscalationEvent = {
        escalationId: `esc_${crypto.randomUUID().slice(0, 12)}`,
        alertId: params.alertId || `al_${Date.now()}`,
        patientId,
        patientOwnerUid: ownerUid,
        patientName,
        severity,
        triggerMetric: readingInfo.parameter,
        readingSummary: readingInfo.summary,
        reasonForCalling: params.analysis.explanation.slice(0, 380),
        escalationStatus: "logged_low",
        activeAttemptCount: 0,
        maxAttempts: escalationPlan.maxCallAttempts,
        retryIntervalSec: escalationPlan.retryIntervalSec,
        currentCaregiverIndex: 0,
        currentCaregiverName: null,
        currentCaregiverPriority: null,
        caregiverResponse: "Pending",
        fallbackTriggered: false,
        humanFollowUpRequired: false,
        emergencyActive: false,
        followUpAction: `${severity} severity anomaly logged to monitoring dashboard (no automated voice call).`,
        caregiverOrderIds: [],
        attemptForCurrentCaregiver: 0,
        callIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.saveEscalation(esc);
      return { severity, escalation: esc, duplicateSuppressed: false };
    }

    if (!escalationPlan.triggerAutomatedVoiceCall) {
      const ordered = this.getOrderedConsentedCaregivers(patientId);
      const primary = ordered[0] ?? null;
      const esc: VoiceEscalationEvent = {
        escalationId: `esc_${crypto.randomUUID().slice(0, 12)}`,
        alertId: params.alertId || `al_${Date.now()}`,
        patientId,
        patientOwnerUid: ownerUid,
        patientName,
        severity,
        triggerMetric: readingInfo.parameter,
        readingSummary: readingInfo.summary,
        reasonForCalling: params.analysis.explanation.slice(0, 380),
        escalationStatus: "notified_medium",
        activeAttemptCount: 0,
        maxAttempts: escalationPlan.maxCallAttempts,
        retryIntervalSec: escalationPlan.retryIntervalSec,
        currentCaregiverIndex: 0,
        currentCaregiverName: primary?.caregiverName ?? null,
        currentCaregiverPriority: primary?.priority ?? null,
        caregiverResponse: "Pending",
        fallbackTriggered: false,
        humanFollowUpRequired: false,
        emergencyActive: true,
        followUpAction: primary
          ? `${severity} warning alert notified to primary caregiver (${primary.caregiverName}) on dashboard.`
          : `${severity} warning alert logged for dashboard caregiver review.`,
        caregiverOrderIds: ordered.map((c) => c.contactId),
        attemptForCurrentCaregiver: 0,
        callIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.saveEscalation(esc);
      this.recordAudit({
        eventType: "medium_warning_notified",
        patientId,
        patientOwnerUid: ownerUid,
        escalationId: esc.escalationId,
        actorUid: params.actorUid || "ml_engine",
        summary: `${severity} severity alert (${readingInfo.summary}) notified primary caregiver without voice call.`,
      });
      return { severity, escalation: esc, duplicateSuppressed: false };
    }

    // Automated Voice Calling Workflow with Duplicate Prevention (High by default, or any level configured for voice calls)
    const existingActive = this.getActiveHighEscalationForPatient(patientId);
    if (existingActive) {
      existingActive.updatedAt = nowIso;
      existingActive.readingSummary = readingInfo.summary;
      this.saveEscalation(existingActive);
      this.recordAudit({
        eventType: "duplicate_call_prevented",
        patientId,
        patientOwnerUid: ownerUid,
        escalationId: existingActive.escalationId,
        actorUid: params.actorUid || "ml_engine",
        summary: `Prevented duplicate automated voice call for active ${existingActive.severity} escalation (${existingActive.escalationId}) on reading ${readingInfo.summary}.`,
      });
      return { severity, escalation: existingActive, duplicateSuppressed: true };
    }

    const allOrdered = this.getOrderedConsentedCaregivers(patientId);
    const orderedCaregivers =
      escalationPlan.caregiverPriorityTarget === "primary"
        ? allOrdered.slice(0, 1)
        : allOrdered;
    const effectiveMaxAttempts =
      escalationPlan.maxCallAttempts > 0
        ? escalationPlan.maxCallAttempts
        : this.retryPolicy.maxCallAttempts;
    const effectiveRetrySec =
      escalationPlan.retryIntervalSec > 0
        ? escalationPlan.retryIntervalSec
        : this.retryPolicy.retryIntervalSec;

    const escalationId = `esc_${crypto.randomUUID().slice(0, 12)}`;
    const esc: VoiceEscalationEvent = {
      escalationId,
      alertId: params.alertId || `al_${Date.now()}`,
      patientId,
      patientOwnerUid: ownerUid,
      patientName,
      severity,
      triggerMetric: readingInfo.parameter,
      readingSummary: readingInfo.summary,
      reasonForCalling: params.analysis.explanation.slice(0, 380),
      escalationStatus:
        orderedCaregivers.length > 0 ? "calling_primary" : "human_follow_up_required",
      activeAttemptCount: 0,
      maxAttempts: effectiveMaxAttempts,
      retryIntervalSec: effectiveRetrySec,
      currentCaregiverIndex: 0,
      currentCaregiverName: orderedCaregivers[0]?.caregiverName ?? null,
      currentCaregiverPriority: orderedCaregivers[0]?.priority ?? null,
      caregiverResponse: "Pending",
      fallbackTriggered: orderedCaregivers.length === 0 && this.retryPolicy.fallbackNotificationEnabled,
      humanFollowUpRequired: orderedCaregivers.length === 0,
      emergencyActive: true,
      followUpAction:
        orderedCaregivers.length > 0
          ? `Initiating urgent Arova AI call to ${orderedCaregivers[0].caregiverName}.`
          : "No consented caregivers registered; fallback human follow-up required immediately.",
      caregiverOrderIds: escalationPlan.escalateToNextCaregiver
        ? orderedCaregivers.map((c) => c.contactId)
        : orderedCaregivers.slice(0, 1).map((c) => c.contactId),
      attemptForCurrentCaregiver: 0,
      callIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.saveEscalation(esc);

    if (orderedCaregivers.length === 0) {
      this.recordAudit({
        eventType: "fallback_no_consented_caregiver",
        patientId,
        patientOwnerUid: ownerUid,
        escalationId,
        actorUid: params.actorUid || "ml_engine",
        summary: `${severity} severity anomaly (${readingInfo.summary}) detected, but no consented active caregivers exist. Marked human_follow_up_required.`,
      });
      return { severity, escalation: esc, duplicateSuppressed: false };
    }

    await this.placeEscalationCallAttempt(esc, orderedCaregivers[0], readingInfo, params.publicBaseUrlOverride);
    return { severity, escalation: esc, duplicateSuppressed: false };
  }

  private async placeEscalationCallAttempt(
    esc: VoiceEscalationEvent,
    caregiver: CaregiverContactInternal,
    readingInfo: { parameter: string; readingValue: string; readingUnit: string; summary: string },
    publicBaseUrlOverride?: string
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    esc.attemptForCurrentCaregiver += 1;
    esc.activeAttemptCount += 1;
    esc.currentCaregiverName = caregiver.caregiverName;
    esc.currentCaregiverPriority = caregiver.priority;
    esc.escalationStatus =
      esc.currentCaregiverIndex === 0
        ? esc.attemptForCurrentCaregiver > 1
          ? "retrying"
          : "calling_primary"
        : "escalated_secondary";
    esc.updatedAt = nowIso;

    const context: VoiceCallContext = {
      callType: "emergency_escalation",
      escalationId: esc.escalationId,
      alertId: esc.alertId,
      patientId: esc.patientId,
      patientOwnerUid: esc.patientOwnerUid,
      patientName: esc.patientName,
      alertSeverity: "High",
      parameter: readingInfo.parameter,
      readingValue: readingInfo.readingValue,
      readingUnit: readingInfo.readingUnit,
      thresholdContext: esc.reasonForCalling,
      reasonForCalling: esc.reasonForCalling,
      relevantReading: readingInfo.summary,
      eventTimestamp: esc.createdAt,
      caregiverContactId: caregiver.contactId,
      caregiverName: caregiver.caregiverName,
      caregiverPriority: caregiver.priority,
      preferredLanguage: caregiver.preferredLanguage,
      authorizedForPatientIdentity: caregiver.authorizedForPatientIdentity,
      authorizedForHealthReadings: caregiver.authorizedForHealthReadings,
      explicitCallConsent: caregiver.explicitCallConsent,
      retryCount: esc.attemptForCurrentCaregiver - 1,
    };

    const badgeStatus: CallEscalationBadgeStatus =
      esc.currentCaregiverIndex === 0
        ? esc.attemptForCurrentCaregiver > 1
          ? "retrying"
          : "calling_primary"
        : "escalated_secondary";

    const cfg = getOutboundTwilioConfig();
    if (!cfg.configured && !publicBaseUrlOverride) {
      // Only skip if neither real Twilio nor injected test launcher is provided
    }

    try {
      const outbound = await this.callLauncher({
        toE164: caregiver.e164Phone,
        publicBaseUrlOverride,
        context,
      });

      const entry: VoiceCallHistoryEntry = {
        callId: outbound.callId,
        callSid: outbound.callSid,
        escalationId: esc.escalationId,
        alertId: esc.alertId,
        patientId: esc.patientId,
        patientOwnerUid: esc.patientOwnerUid,
        patientName: esc.patientName,
        alertSeverity: "High",
        reasonForCalling: esc.reasonForCalling,
        relevantReading: readingInfo.summary,
        caregiverContactId: caregiver.contactId,
        caregiverName: caregiver.caregiverName,
        caregiverPriority: caregiver.priority,
        maskedPhone: caregiver.maskedPhone,
        callStatus: outbound.arovaStatus,
        selectedLanguage: caregiver.preferredLanguage,
        caregiverResponse: "Pending",
        responseSummary: null,
        durationSec: outbound.durationSec,
        retryCount: esc.attemptForCurrentCaregiver - 1,
        escalationStatus: badgeStatus,
        followUpAction: `Automated call (${caregiver.priority} #${esc.attemptForCurrentCaregiver}) placed to ${caregiver.caregiverName}.`,
        isTestCall: false,
        errorMessage: outbound.errorMessage,
        startedAt: outbound.startedAt,
        endedAt: outbound.endedAt,
        updatedAt: outbound.updatedAt,
      };

      esc.callIds.push(outbound.callId);
      this.saveCallHistoryEntry(entry);
      this.saveEscalation(esc);

      this.recordAudit({
        eventType: "emergency_call_placed",
        patientId: esc.patientId,
        patientOwnerUid: esc.patientOwnerUid,
        callId: outbound.callId,
        escalationId: esc.escalationId,
        actorUid: "escalation_engine",
        summary: `Placed High-severity call attempt #${esc.attemptForCurrentCaregiver} to ${caregiver.priority} caregiver ${caregiver.caregiverName} (${caregiver.maskedPhone}).`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Twilio dispatch failed.";
      const failedCallId = `call_err_${crypto.randomUUID().slice(0, 12)}`;
      const entry: VoiceCallHistoryEntry = {
        callId: failedCallId,
        callSid: null,
        escalationId: esc.escalationId,
        alertId: esc.alertId,
        patientId: esc.patientId,
        patientOwnerUid: esc.patientOwnerUid,
        patientName: esc.patientName,
        alertSeverity: "High",
        reasonForCalling: esc.reasonForCalling,
        relevantReading: readingInfo.summary,
        caregiverContactId: caregiver.contactId,
        caregiverName: caregiver.caregiverName,
        caregiverPriority: caregiver.priority,
        maskedPhone: caregiver.maskedPhone,
        callStatus: "Failed",
        selectedLanguage: caregiver.preferredLanguage,
        caregiverResponse: "Pending",
        responseSummary: null,
        durationSec: 0,
        retryCount: esc.attemptForCurrentCaregiver - 1,
        escalationStatus: "human_follow_up_required",
        followUpAction: msg.slice(0, 280),
        isTestCall: false,
        errorMessage: msg,
        startedAt: nowIso,
        endedAt: nowIso,
        updatedAt: nowIso,
      };
      esc.callIds.push(failedCallId);
      this.saveCallHistoryEntry(entry);

      this.recordAudit({
        eventType: "emergency_call_dispatch_failed",
        patientId: esc.patientId,
        patientOwnerUid: esc.patientOwnerUid,
        callId: failedCallId,
        escalationId: esc.escalationId,
        actorUid: "escalation_engine",
        summary: `Emergency call dispatch to ${caregiver.caregiverName} failed: ${msg}`,
      });

      await this.advanceRetryOrEscalate(esc, "call_failed");
    }
  }

  public async handleOutboundCallStatusUpdate(record: OutboundCallRecord): Promise<void> {
    const history = this.callHistory.get(record.callId);
    if (!history) return;

    history.callSid = record.callSid;
    history.callStatus = record.arovaStatus;
    history.durationSec = record.durationSec;
    history.errorMessage = record.errorMessage;
    history.endedAt = record.endedAt;
    history.updatedAt = record.updatedAt;
    this.saveCallHistoryEntry(history);

    if (!history.escalationId) return;
    const esc = this.escalations.get(history.escalationId);
    if (!esc || !esc.emergencyActive || esc.escalationStatus === "resolved") return;

    // Only react to unanswered/busy/failed on the currently active call
    const latestCallId = esc.callIds[esc.callIds.length - 1];
    if (latestCallId !== record.callId) return;

    if (
      record.arovaStatus === "Unanswered" ||
      record.arovaStatus === "Busy" ||
      record.arovaStatus === "Failed"
    ) {
      await this.advanceRetryOrEscalate(esc, record.arovaStatus.toLowerCase());
    }
  }

  public async handleCaregiverResponseUpdate(
    callId: string,
    result: CaregiverClassificationResult,
    isFinal: boolean
  ): Promise<void> {
    const history = this.callHistory.get(callId);
    if (!history) return;

    history.selectedLanguage = result.selectedLanguage;
    history.caregiverResponse = result.caregiverResponse;
    history.responseSummary = result.responseSummary;
    history.followUpAction = result.followUpAction;
    history.updatedAt = new Date().toISOString();

    if (history.escalationId) {
      const esc = this.escalations.get(history.escalationId);
      if (esc && esc.emergencyActive && esc.escalationStatus !== "resolved") {
        esc.caregiverResponse = result.caregiverResponse;
        esc.followUpAction = result.followUpAction;
        esc.updatedAt = history.updatedAt;

        const declining =
          result.caregiverResponse === "Unable to assist" ||
          result.caregiverResponse === "Not available" ||
          result.caregiverResponse === "Requests another contact";

        if (declining && isFinal) {
          history.escalationStatus = "escalated_secondary";
          this.saveCallHistoryEntry(history);
          this.saveEscalation(esc);
          await this.advanceRetryOrEscalate(esc, "caregiver_declined_or_requested_alternate");
          return;
        }

        if (
          result.caregiverResponse === "Will check immediately" ||
          result.caregiverResponse === "Already checking on the patient" ||
          result.caregiverResponse === "Patient is safe" ||
          result.caregiverResponse === "Needs emergency assistance"
        ) {
          // NEVER mark emergency resolved simply because the call was answered!
          esc.escalationStatus = "acknowledged";
          esc.emergencyActive = true;
          history.escalationStatus = "acknowledged";
          this.saveEscalation(esc);
        }
      }
    }

    this.saveCallHistoryEntry(history);
    if (isFinal) {
      this.recordAudit({
        eventType: "caregiver_response_recorded",
        patientId: history.patientId,
        patientOwnerUid: history.patientOwnerUid,
        callId: history.callId,
        escalationId: history.escalationId,
        actorUid: "gemini_live_agent",
        summary: `Recorded caregiver response "${result.caregiverResponse}" (lang=${result.selectedLanguage}) for ${history.caregiverName}.`,
      });
    }
  }

  public async advanceRetryOrEscalate(
    esc: VoiceEscalationEvent,
    reason: string,
    options?: { immediateRetryForTests?: boolean }
  ): Promise<VoiceEscalationEvent> {
    if (!esc.emergencyActive || esc.escalationStatus === "resolved") {
      return esc;
    }

    const clearPendingTimer = () => {
      const t = this.retryTimers.get(esc.escalationId);
      if (t) {
        clearTimeout(t);
        this.retryTimers.delete(esc.escalationId);
      }
    };
    clearPendingTimer();

    const currentContactId = esc.caregiverOrderIds[esc.currentCaregiverIndex];
    const currentContact = currentContactId ? this.contacts.get(currentContactId) : undefined;
    const declined = reason === "caregiver_declined_or_requested_alternate";

    const readingInfo = {
      parameter: esc.triggerMetric || "Health Signal",
      readingValue: esc.readingSummary || "Out of threshold",
      readingUnit: "",
      summary: esc.readingSummary || "Threshold deviation",
    };

    if (
      !declined &&
      currentContact &&
      currentContact.status === "active" &&
      currentContact.explicitCallConsent &&
      esc.attemptForCurrentCaregiver < esc.maxAttempts
    ) {
      esc.escalationStatus = "retrying";
      esc.followUpAction = `Previous attempt (${reason}) did not reach ${currentContact.caregiverName}; scheduling retry in ${esc.retryIntervalSec}s.`;
      esc.updatedAt = new Date().toISOString();
      this.saveEscalation(esc);

      if (options?.immediateRetryForTests) {
        await this.placeEscalationCallAttempt(esc, currentContact, readingInfo);
      } else {
        const timer = setTimeout(() => {
          this.retryTimers.delete(esc.escalationId);
          if (esc.emergencyActive && esc.escalationStatus === "retrying") {
            void this.placeEscalationCallAttempt(esc, currentContact, readingInfo);
          }
        }, esc.retryIntervalSec * 1000);
        this.retryTimers.set(esc.escalationId, timer);
      }
      return esc;
    }

    // Move to next consented caregiver in priority list
    let nextIndex = esc.currentCaregiverIndex + 1;
    let nextCaregiver: CaregiverContactInternal | undefined;
    while (nextIndex < esc.caregiverOrderIds.length) {
      const candidate = this.contacts.get(esc.caregiverOrderIds[nextIndex]);
      if (candidate && candidate.status === "active" && candidate.explicitCallConsent) {
        nextCaregiver = candidate;
        break;
      }
      nextIndex++;
    }

    if (nextCaregiver) {
      esc.currentCaregiverIndex = nextIndex;
      esc.attemptForCurrentCaregiver = 0;
      esc.escalationStatus = "escalated_secondary";
      esc.currentCaregiverName = nextCaregiver.caregiverName;
      esc.currentCaregiverPriority = nextCaregiver.priority;
      esc.followUpAction = `Escalating to ${nextCaregiver.priority} caregiver ${nextCaregiver.caregiverName} (${reason}).`;
      esc.updatedAt = new Date().toISOString();
      this.saveEscalation(esc);

      this.recordAudit({
        eventType: "escalation_advanced_to_next_caregiver",
        patientId: esc.patientId,
        patientOwnerUid: esc.patientOwnerUid,
        escalationId: esc.escalationId,
        actorUid: "escalation_engine",
        summary: `Escalated alert ${esc.alertId} to ${nextCaregiver.priority} caregiver ${nextCaregiver.caregiverName} after ${reason}.`,
      });

      await this.placeEscalationCallAttempt(esc, nextCaregiver, readingInfo);
      return esc;
    }

    // All caregivers exhausted -> fallback notification + human_follow_up_required
    esc.escalationStatus = "human_follow_up_required";
    esc.fallbackTriggered = this.retryPolicy.fallbackNotificationEnabled;
    esc.humanFollowUpRequired = true;
    esc.emergencyActive = true;
    esc.followUpAction =
      "All registered caregivers unavailable or unreachable; fallback alert triggered — immediate human follow-up required.";
    esc.updatedAt = new Date().toISOString();
    this.saveEscalation(esc);

    const lastCallId = esc.callIds[esc.callIds.length - 1];
    if (lastCallId) {
      const lastHistory = this.callHistory.get(lastCallId);
      if (lastHistory) {
        lastHistory.escalationStatus = esc.fallbackTriggered
          ? "fallback_notified"
          : "human_follow_up_required";
        lastHistory.followUpAction = esc.followUpAction;
        lastHistory.updatedAt = esc.updatedAt;
        this.saveCallHistoryEntry(lastHistory);
      }
    }

    this.recordAudit({
      eventType: "fallback_human_follow_up_required",
      patientId: esc.patientId,
      patientOwnerUid: esc.patientOwnerUid,
      escalationId: esc.escalationId,
      actorUid: "escalation_engine",
      summary: `All caregivers exhausted for High escalation ${esc.escalationId}. Fallback triggered=${esc.fallbackTriggered}; marked human_follow_up_required.`,
    });

    return esc;
  }

  public resolveEscalationByHuman(params: {
    escalationId: string;
    actorUid: string;
    isAdmin: boolean;
    followUpNote?: string;
  }): VoiceEscalationEvent {
    const esc = this.escalations.get(params.escalationId);
    if (!esc) {
      throw new Error("Escalation event not found.");
    }
    if (!params.isAdmin && esc.patientOwnerUid !== params.actorUid) {
      throw new Error("Forbidden: unauthorized to resolve this patient escalation.");
    }

    const timer = this.retryTimers.get(esc.escalationId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(esc.escalationId);
    }

    esc.escalationStatus = "resolved";
    esc.emergencyActive = false;
    esc.humanFollowUpRequired = false;
    esc.followUpAction = (
      params.followUpNote?.trim() || "Emergency manually verified and resolved by authorized staff."
    ).slice(0, 300);
    esc.updatedAt = new Date().toISOString();
    this.saveEscalation(esc);

    this.recordAudit({
      eventType: "escalation_resolved_by_human",
      patientId: esc.patientId,
      patientOwnerUid: esc.patientOwnerUid,
      escalationId: esc.escalationId,
      actorUid: params.actorUid,
      summary: `Emergency escalation ${esc.escalationId} explicitly resolved by ${params.actorUid}: ${esc.followUpAction}`,
    });

    return esc;
  }
}

export const sharedVoiceEscalationEngine = new VoiceEscalationEngine();
