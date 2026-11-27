import { auth } from "../lib/firebase.ts";
import type {
  AdminAlertStats,
  AdminFallDetectionStats,
  AlertLevelsPolicyConfig,
  AlertRecord,
  AnomalyStatus,
  BaselineProgressSummary,
  CameraMonitoringStatus,
  CameraTelemetrySnapshot,
  CaregiverPriority,
  CaregiverVoiceContact,
  CarePermissions,
  DatasetAdapterSpec,
  DatasetImportResponse,
  DeviceVibrationCommand,
  EcgFeatures,
  EcgSegmentRecord,
  EcgSignalQuality,
  FallDetectionEventRecord,
  FallDetectionLocation,
  FallDetectionState,
  FallSensorFusionStatus,
  InAppNotification,
  IntegrationStatus,
  MlDetectionConfig,
  MlEvaluationResult,
  MlGraphMeta,
  MlModelStatusSummary,
  MovementStatus,
  NotificationErrorLog,
  NotificationEscalationConfig,
  NotificationProvidersStatus,
  PlaybackFrameResult,
  PlaybackStateSnapshot,
  PublicDatasetCatalogEntry,
  RegisteredWearableDevice,
  SensorAvailabilityMap,
  SupportedVoiceLanguage,
  SystemAuditLog,
  TelemetrySource,
  UserRole,
  VoiceAuditLogEntry,
  VoiceCallHistoryEntry,
  VoiceEscalationEvent,
  VoiceRetryPolicyConfig,
} from "../types/smartcare.ts";

export async function fetchIntegrationStatus(): Promise<IntegrationStatus> {
  const res = await fetch("/api/system/integrations");
  if (!res.ok) {
    throw new Error("Failed to check backend integration status.");
  }
  return res.json();
}

export async function fetchLatestHardwareEvents(patientId?: string): Promise<{
  snapshot?: Record<string, unknown> | null;
  ecgHistory?: EcgSegmentRecord[];
  events?: Array<Record<string, unknown>>;
}> {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/wearable/latest${qs}`);
  if (!res.ok) {
    throw new Error("Failed to query hardware ingestion buffer.");
  }
  return res.json();
}

export async function fetchPatientBaselineStatus(
  patientId: string,
  minSamples = 20
): Promise<{
  patientId: string;
  esp32Hardware: BaselineProgressSummary;
  simulator: BaselineProgressSummary;
  activeBaseline: BaselineProgressSummary;
}> {
  const res = await fetch(
    `/api/ml/baseline/status/${encodeURIComponent(patientId)}?minSamples=${encodeURIComponent(String(minSamples))}`
  );
  if (!res.ok) {
    throw new Error("Failed to load patient baseline status.");
  }
  return res.json();
}

export async function sendSimulatedWearablePacket(payload: {
  deviceId: string;
  patientId: string;
  patientName?: string;
  patientOwnerUid?: string;
  timestamp?: string;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  accelX?: number | null;
  accelY?: number | null;
  accelZ?: number | null;
  gyroX?: number | null;
  gyroY?: number | null;
  gyroZ?: number | null;
  movementStatus: MovementStatus;
  possibleFallDetected?: boolean;
  irSignalOk?: boolean;
  fingerDetected?: boolean;
  sensor_quality?: "good" | "noisy" | "poor_contact" | "unavailable";
  sensorAvailability?: Partial<SensorAvailabilityMap>;
  batteryPct?: number | null;
  ecgSamples?: number[];
  ecgSamplingRate?: number;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
  ecgTimestamp?: string;
  source?: TelemetrySource;
  baselineMeans?: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
  };
  baselineTrained?: boolean;
  policyConfig?: {
    baselineMinSamples?: number;
    warningPersistenceWindows?: number;
    criticalPersistenceWindows?: number;
    anomalyScoreWarningThreshold?: number;
    anomalyScoreCriticalThreshold?: number;
    zScoreWarningThreshold?: number;
    zScoreCriticalThreshold?: number;
  };
}) {
  const res = await fetch("/api/wearable/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      source: payload.source ?? "simulator",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Telemetry ingestion failed.");
  }
  return data as {
    ok: boolean;
    deviceId: string;
    patientId: string;
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    accelMagnitude: number;
    gyroMagnitude: number;
    accelX: number | null;
    accelY: number | null;
    accelZ: number | null;
    gyroX: number | null;
    gyroY: number | null;
    gyroZ: number | null;
    movementStatus: MovementStatus;
    possibleFallDetected: boolean;
    ecgSamples: number[];
    ecgSamplingRate: number;
    ecgSignalQuality: EcgSignalQuality;
    ecgLeadOff: boolean;
    ecgTimestamp: string | null;
    ecgFeatures: EcgFeatures;
    signalQuality: "good" | "noisy" | "poor_contact";
    sensorAvailability?: SensorAvailabilityMap;
    batteryPct?: number | null;
    oledActive?: boolean;
    deviceCommand?: DeviceVibrationCommand | null;
    anomalyStatus: AnomalyStatus;
    anomalyScore: number;
    alertLevel: "Normal" | "Warning" | "Critical";
    mlEngine: "unconnected_rule_check" | "python_isolation_forest";
    mlServiceConnected: boolean;
    modelTrained: boolean;
    modelVersion: string | null;
    ecgModelTrained: boolean;
    triggeredMetrics: string[];
    contributingFeatures: string[];
    plainLanguageExplanations?: string[];
    persistenceCount: number;
    persistenceRequired: number;
    matchedBaselineContext: string;
    windowSize: number;
    baselineProgress: BaselineProgressSummary;
    explanation: string;
    hapticPattern: string;
    receivedAt: string;
    source: TelemetrySource;
    phase5Alert?: AlertRecord | null;
    duplicateAlertSuppressed?: boolean;
    suppressedAlertId?: string;
  };
}

export async function requestBaselineFit(
  patientId: string,
  samples: Array<{
    heartRate: number;
    spo2: number;
    temperatureC: number | null;
    accelMagnitude?: number;
    gyroMagnitude?: number;
    movementStatus?: MovementStatus;
    signalQuality?: "good" | "noisy" | "poor_contact";
    timestamp?: string;
    ecgBpm?: number | null;
    ecgSignalQuality?: EcgSignalQuality;
    ecgLeadOff?: boolean;
  }>,
  options?: {
    source?: TelemetrySource;
    minSamples?: number;
  }
) {
  const res = await fetch("/api/ml/baseline/fit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patientId,
      samples,
      source: options?.source ?? "simulator",
      minSamples: options?.minSamples ?? 20,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Baseline fitting failed.");
  }
  return data as {
    mlServiceConnected: boolean;
    trained: boolean;
    baselineStatus: "not_started" | "collecting" | "ready";
    sampleCount: number;
    requiredSamples: number;
    source: TelemetrySource;
    modelVersion: string;
    restingSamples: number;
    activeSamples: number;
    ecgBaselineSamples: number;
    means: { heartRate: number; spo2: number; temperatureC: number };
    medians?: { heartRate: number; spo2: number; temperatureC: number };
    stds?: { heartRate: number; spo2: number; temperatureC: number };
    ecgBpmMean: number | null;
    activeHeartRateMean: number | null;
    message: string;
  };
}

export async function triggerVoiceEscalation(params: {
  alertId: string;
  patientId: string;
  patientName: string;
  summary: string;
  primaryCaregiverName: string;
  secondaryCaregiverName: string;
  timeoutSec: number;
  dryRun: boolean;
}) {
  const res = await fetch("/api/voice/escalate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Escalation request failed.");
  }
  return data as {
    alertId: string;
    status:
      | "not_triggered"
      | "provider_unconfigured"
      | "calling_primary"
      | "primary_answered"
      | "escalated_secondary"
      | "completed";
    providerConfigured: boolean;
    providerName: string;
    timeoutSec: number;
    isDryRun: boolean;
    log: string[];
  };
}

export async function advanceVoiceOutcome(
  alertId: string,
  action: "primary_answered" | "primary_no_answer_escalate" | "secondary_acknowledged"
) {
  const res = await fetch("/api/voice/outcome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alertId, action }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to update escalation outcome.");
  }
  return data as {
    alertId: string;
    status:
      | "not_triggered"
      | "provider_unconfigured"
      | "calling_primary"
      | "primary_answered"
      | "escalated_secondary"
      | "completed";
    log: string[];
  };
}

export interface OutboundCallApiState {
  callId: string;
  status: "initiating" | "calling" | "connected" | "ended" | "failed";
  twilioStatus: string | null;
  maskedPhone?: string;
  durationSec: number;
  errorMessage?: string | null;
  startedAt?: string;
  connectedAt?: string | null;
  endedAt?: string | null;
}

export class OutboundCallApiError extends Error {
  public readonly missingEnvVars?: string[];
  public readonly configured?: boolean;

  constructor(message: string, options?: { missingEnvVars?: string[]; configured?: boolean }) {
    super(message);
    this.name = "OutboundCallApiError";
    this.missingEnvVars = options?.missingEnvVars;
    this.configured = options?.configured;
  }
}

export async function initiateOutboundVoiceCall(e164Number: string): Promise<OutboundCallApiState> {
  const res = await fetch("/api/voice/outbound/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ e164Number }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<OutboundCallApiState> & {
    error?: string;
    missingEnvVars?: string[];
    configured?: boolean;
  };
  if (!res.ok || !data.callId || !data.status) {
    throw new OutboundCallApiError(
      data.error || "Failed to initiate outbound voice call.",
      {
        missingEnvVars: Array.isArray(data.missingEnvVars) ? data.missingEnvVars : undefined,
        configured: data.configured,
      }
    );
  }
  return {
    callId: data.callId,
    status: data.status,
    twilioStatus: data.twilioStatus ?? null,
    maskedPhone: data.maskedPhone,
    durationSec: typeof data.durationSec === "number" ? data.durationSec : 0,
    startedAt: data.startedAt,
  };
}

export async function fetchOutboundVoiceCallStatus(callId: string): Promise<OutboundCallApiState> {
  const res = await fetch(`/api/voice/outbound/status/${encodeURIComponent(callId)}`);
  const data = (await res.json().catch(() => ({}))) as Partial<OutboundCallApiState> & {
    error?: string;
  };
  if (!res.ok || !data.callId || !data.status) {
    throw new Error(data.error || "Failed to read outbound call status.");
  }
  return {
    callId: data.callId,
    status: data.status,
    twilioStatus: data.twilioStatus ?? null,
    maskedPhone: data.maskedPhone,
    durationSec: typeof data.durationSec === "number" ? data.durationSec : 0,
    errorMessage: data.errorMessage ?? null,
    startedAt: data.startedAt,
    connectedAt: data.connectedAt ?? null,
    endedAt: data.endedAt ?? null,
  };
}

export async function terminateOutboundVoiceCall(callId: string): Promise<OutboundCallApiState> {
  const res = await fetch("/api/voice/outbound/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<OutboundCallApiState> & {
    error?: string;
  };
  if (!res.ok || !data.callId || !data.status) {
    throw new Error(data.error || "Failed to terminate outbound call.");
  }
  return {
    callId: data.callId,
    status: data.status,
    twilioStatus: data.twilioStatus ?? null,
    durationSec: typeof data.durationSec === "number" ? data.durationSec : 0,
    endedAt: data.endedAt ?? null,
  };
}

// --- Arova AI Emergency Voice Calling (Authenticated) ---

async function buildAuthHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchVoiceCaregiverContacts(
  patientId?: string
): Promise<CaregiverVoiceContact[]> {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/voice/contacts${qs}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    contacts?: CaregiverVoiceContact[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load registered caregiver contacts.");
  }
  return data.contacts ?? [];
}

export async function saveVoiceCaregiverContact(payload: {
  contactId?: string;
  patientId: string;
  patientOwnerUid?: string;
  caregiverName: string;
  phoneNumber: string;
  priority: CaregiverPriority;
  preferredLanguage: SupportedVoiceLanguage;
  explicitCallConsent: boolean;
  authorizedForPatientIdentity: boolean;
  authorizedForHealthReadings: boolean;
  status?: "active" | "paused";
}): Promise<CaregiverVoiceContact> {
  const res = await fetch("/api/voice/contacts", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    contact?: CaregiverVoiceContact;
    error?: string;
  };
  if (!res.ok || !data.contact) {
    throw new Error(data.error || "Failed to save caregiver voice contact.");
  }
  return data.contact;
}

export async function updateVoiceCaregiverContact(
  contactId: string,
  patch: Partial<{
    caregiverName: string;
    phoneNumber: string;
    priority: CaregiverPriority;
    preferredLanguage: SupportedVoiceLanguage;
    explicitCallConsent: boolean;
    authorizedForPatientIdentity: boolean;
    authorizedForHealthReadings: boolean;
    status: "active" | "paused";
  }>
): Promise<CaregiverVoiceContact> {
  const res = await fetch(`/api/voice/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as {
    contact?: CaregiverVoiceContact;
    error?: string;
  };
  if (!res.ok || !data.contact) {
    throw new Error(data.error || "Failed to update caregiver voice contact.");
  }
  return data.contact;
}

export async function deleteVoiceCaregiverContact(contactId: string): Promise<void> {
  const res = await fetch(`/api/voice/contacts/${encodeURIComponent(contactId)}`, {
    method: "DELETE",
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to delete caregiver contact.");
  }
}

export async function fetchVoiceRetrySettings(): Promise<VoiceRetryPolicyConfig> {
  const res = await fetch("/api/voice/settings/retry", {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    settings?: VoiceRetryPolicyConfig;
    error?: string;
  };
  if (!res.ok || !data.settings) {
    throw new Error(data.error || "Failed to load retry settings.");
  }
  return data.settings;
}

export async function saveVoiceRetrySettings(payload: {
  retryIntervalSec: number;
  maxCallAttempts: number;
  fallbackNotificationEnabled: boolean;
}): Promise<VoiceRetryPolicyConfig> {
  const res = await fetch("/api/voice/settings/retry", {
    method: "PUT",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    settings?: VoiceRetryPolicyConfig;
    error?: string;
  };
  if (!res.ok || !data.settings) {
    throw new Error(data.error || "Failed to update retry settings.");
  }
  return data.settings;
}

export async function triggerAdminVoiceTestCall(payload: {
  contactId: string;
  patientName?: string;
  parameter?: string;
  readingValue?: string;
  readingUnit?: string;
  language?: SupportedVoiceLanguage;
  reasonForCalling?: string;
}): Promise<VoiceCallHistoryEntry> {
  const res = await fetch("/api/voice/admin/test-call", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    call?: VoiceCallHistoryEntry;
    error?: string;
    missingEnvVars?: string[];
    configured?: boolean;
  };
  if (!res.ok || !data.call) {
    throw new OutboundCallApiError(data.error || "Failed to initiate admin test call.", {
      missingEnvVars: Array.isArray(data.missingEnvVars) ? data.missingEnvVars : undefined,
      configured: data.configured,
    });
  }
  return data.call;
}

export async function fetchVoiceCallHistory(
  patientId?: string
): Promise<VoiceCallHistoryEntry[]> {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/voice/history${qs}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    history?: VoiceCallHistoryEntry[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load voice call history.");
  }
  return data.history ?? [];
}

export async function fetchVoiceEscalations(
  patientId?: string
): Promise<VoiceEscalationEvent[]> {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/voice/escalations${qs}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    escalations?: VoiceEscalationEvent[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load emergency escalations.");
  }
  return data.escalations ?? [];
}

export async function resolveVoiceEscalation(
  escalationId: string,
  followUpNote?: string
): Promise<VoiceEscalationEvent> {
  const res = await fetch(`/api/voice/escalations/${encodeURIComponent(escalationId)}/resolve`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ followUpNote }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    escalation?: VoiceEscalationEvent;
    error?: string;
  };
  if (!res.ok || !data.escalation) {
    throw new Error(data.error || "Failed to resolve escalation.");
  }
  return data.escalation;
}

export async function fetchVoiceAuditLogs(): Promise<VoiceAuditLogEntry[]> {
  const res = await fetch("/api/voice/audit", {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    logs?: VoiceAuditLogEntry[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load voice audit logs.");
  }
  return data.logs ?? [];
}

export async function fetchAlertLevelsPolicy(): Promise<{
  policy: AlertLevelsPolicyConfig;
  defaults: AlertLevelsPolicyConfig;
}> {
  const res = await fetch("/api/system/alert-levels");
  const data = (await res.json().catch(() => ({}))) as {
    policy?: AlertLevelsPolicyConfig;
    defaults?: AlertLevelsPolicyConfig;
    error?: string;
  };
  if (!res.ok || !data.policy || !data.defaults) {
    throw new Error(data.error || "Failed to load alert level policy configuration.");
  }
  return { policy: data.policy, defaults: data.defaults };
}

export async function saveAlertLevelsPolicy(
  policy: AlertLevelsPolicyConfig
): Promise<AlertLevelsPolicyConfig> {
  const res = await fetch("/api/system/alert-levels", {
    method: "PUT",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(policy),
  });
  const data = (await res.json().catch(() => ({}))) as {
    policy?: AlertLevelsPolicyConfig;
    error?: string;
  };
  if (!res.ok || !data.policy) {
    throw new Error(data.error || "Failed to save alert level policy configuration.");
  }
  return data.policy;
}

export async function resetAlertLevelsPolicy(): Promise<AlertLevelsPolicyConfig> {
  const res = await fetch("/api/system/alert-levels/reset", {
    method: "POST",
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    policy?: AlertLevelsPolicyConfig;
    error?: string;
  };
  if (!res.ok || !data.policy) {
    throw new Error(data.error || "Failed to reset alert level policy configuration.");
  }
  return data.policy;
}

export async function askGeminiAssistant(params: {
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  context: {
    role: UserRole;
    patientId?: string;
    patientOwnerUid?: string;
    patientName: string;
    dataMode: "sample" | "live";
    baselineStatus: string;
    baselineSummary: string;
    baselineStats?: {
      heartRateMean?: number;
      spo2Mean?: number;
      tempMean?: number;
      sampleCount?: number;
    };
    latestReading: {
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
      anomalyScore?: number;
      relevantReadings?: {
        heartRate: number | null;
        spo2: number | null;
        temperatureC: number | null;
        movementStatus: string;
        signalQuality: string;
      };
      falseAlertReported?: boolean;
      followUpAction?: string;
      notificationStatus?: string;
      escalationStatus?: string;
      escalationHistory?: Array<{ stage: string; summary: string; timestamp: string }>;
      callEscalationStatus: string;
      timestamp: string;
    }>;
  };
}): Promise<string> {
  const res = await fetch("/api/ai/assistant", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Assistant request failed.");
  }
  return data.answer as string;
}

// --- Phase 5: Intelligent Alerts, Notifications & Escalation APIs ---

export async function fetchPhase5Notifications(params?: {
  patientId?: string;
  role?: UserRole;
}): Promise<{
  alerts: AlertRecord[];
  notifications: InAppNotification[];
  unreadCount: number;
  config: NotificationEscalationConfig;
  providers: NotificationProvidersStatus;
}> {
  const qs = new URLSearchParams();
  if (params?.patientId) qs.set("patientId", params.patientId);
  if (params?.role) qs.set("role", params.role);
  const queryStr = qs.toString() ? `?${qs.toString()}` : "";
  const res = await fetch(`/api/notifications${queryStr}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    alerts?: AlertRecord[];
    notifications?: InAppNotification[];
    unreadCount?: number;
    config?: NotificationEscalationConfig;
    providers?: NotificationProvidersStatus;
    error?: string;
  };
  if (!res.ok || !data.config || !data.providers) {
    throw new Error(data.error || "Failed to load notifications and alert status.");
  }
  return {
    alerts: data.alerts ?? [],
    notifications: data.notifications ?? [],
    unreadCount: typeof data.unreadCount === "number" ? data.unreadCount : 0,
    config: data.config,
    providers: data.providers,
  };
}

export async function markPhase5NotificationRead(
  notificationId: string
): Promise<InAppNotification> {
  const res = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: "POST",
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    notification?: InAppNotification;
    error?: string;
  };
  if (!res.ok || !data.notification) {
    throw new Error(data.error || "Failed to mark notification read.");
  }
  return data.notification;
}

export async function syncBackendCareLinks(
  links: Array<{
    linkId: string;
    patientId: string;
    patientName?: string;
    patientOwnerUid: string;
    caregiverUid: string;
    caregiverName: string;
    priority: "primary" | "secondary";
    status: "active" | "pending" | "revoked";
    relationship?: string;
    permissions?: CarePermissions;
  }>
): Promise<void> {
  if (!auth.currentUser || links.length === 0) return;
  await fetch("/api/notifications/care-links", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ links }),
  }).catch(() => {});
}

export async function acknowledgePhase5Alert(
  alertId: string,
  payload: {
    actorRole: UserRole;
    actorName?: string;
    followUpAction?: string;
  }
): Promise<AlertRecord> {
  const res = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { alert?: AlertRecord; error?: string };
  if (!res.ok || !data.alert) {
    throw new Error(data.error || "Failed to acknowledge alert.");
  }
  return data.alert;
}

export async function reportPhase5FalseAlert(
  alertId: string,
  payload: {
    actorRole: UserRole;
    actorName?: string;
    reason?: string;
  }
): Promise<AlertRecord> {
  const res = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/false-alert`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { alert?: AlertRecord; error?: string };
  if (!res.ok || !data.alert) {
    throw new Error(data.error || "Failed to report false alert.");
  }
  return data.alert;
}

export async function resolvePhase5Alert(
  alertId: string,
  payload: {
    actorRole: UserRole;
    actorName?: string;
    followUpAction?: string;
  }
): Promise<AlertRecord> {
  const res = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/resolve`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { alert?: AlertRecord; error?: string };
  if (!res.ok || !data.alert) {
    throw new Error(data.error || "Failed to resolve alert.");
  }
  return data.alert;
}

export async function fetchNotificationConfig(): Promise<{
  config: NotificationEscalationConfig;
  providers: NotificationProvidersStatus;
}> {
  const res = await fetch("/api/notifications/config");
  const data = (await res.json().catch(() => ({}))) as {
    config?: NotificationEscalationConfig;
    providers?: NotificationProvidersStatus;
    error?: string;
  };
  if (!res.ok || !data.config || !data.providers) {
    throw new Error(data.error || "Failed to load notification escalation config.");
  }
  return { config: data.config, providers: data.providers };
}

export async function saveNotificationEscalationConfig(
  patch: Partial<Omit<NotificationEscalationConfig, "updatedAt" | "updatedByUid">>
): Promise<{
  config: NotificationEscalationConfig;
  providers: NotificationProvidersStatus;
}> {
  const res = await fetch("/api/notifications/escalation-config", {
    method: "PUT",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as {
    config?: NotificationEscalationConfig;
    providers?: NotificationProvidersStatus;
    error?: string;
  };
  if (!res.ok || !data.config || !data.providers) {
    throw new Error(data.error || "Failed to save notification escalation configuration.");
  }
  return { config: data.config, providers: data.providers };
}

export async function fetchAdminNotificationStats(): Promise<{
  stats: AdminAlertStats;
  errorLogs: NotificationErrorLog[];
}> {
  const res = await fetch("/api/notifications/stats", {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    stats?: AdminAlertStats;
    errorLogs?: NotificationErrorLog[];
    error?: string;
  };
  if (!res.ok || !data.stats) {
    throw new Error(data.error || "Failed to load admin notification statistics.");
  }
  return {
    stats: data.stats,
    errorLogs: data.errorLogs ?? [],
  };
}

// --- Stage 3: Dataset Lab API Client ---

export class DatasetImportApiError extends Error {
  public readonly code?: string;
  public readonly details?: string[];

  constructor(message: string, code?: string, details?: string[]) {
    super(message);
    this.name = "DatasetImportApiError";
    this.code = code;
    this.details = details;
  }
}

export async function fetchDatasetCatalog(): Promise<{
  stage: number;
  integratedLocally: boolean;
  datasets: PublicDatasetCatalogEntry[];
}> {
  const res = await fetch("/api/datasets/catalog");
  if (!res.ok) {
    throw new Error("Failed to load public dataset catalog.");
  }
  return res.json();
}

export async function fetchDatasetAdapters(): Promise<{
  stage: number;
  adapters: DatasetAdapterSpec[];
}> {
  const res = await fetch("/api/datasets/adapters");
  if (!res.ok) {
    throw new Error("Failed to load dataset adapter specifications.");
  }
  return res.json();
}

export async function importDatasetFile(payload: {
  datasetId: string;
  filename: string;
  content: string;
  participantId?: string;
  recordId?: string;
  windowMs?: number;
  autoLoadPlayback?: boolean;
  speed?: number;
  prefitBaselineCount?: number;
  minBaselineSamples?: number;
}): Promise<DatasetImportResponse> {
  const res = await fetch("/api/datasets/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as Partial<DatasetImportResponse> & {
    error?: string;
    code?: string;
    details?: string[];
  };
  if (!res.ok) {
    throw new DatasetImportApiError(
      data.error || "Dataset import failed.",
      data.code,
      data.details
    );
  }
  return data as DatasetImportResponse;
}

export async function fetchPlaybackStatus(): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/status");
  if (!res.ok) {
    throw new Error("Failed to fetch dataset playback status.");
  }
  return res.json();
}

export async function startPlayback(): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/start", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to start playback.");
  return data as PlaybackStateSnapshot;
}

export async function pausePlayback(): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/pause", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to pause playback.");
  return data as PlaybackStateSnapshot;
}

export async function resumePlayback(): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/resume", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to resume playback.");
  return data as PlaybackStateSnapshot;
}

export async function stepPlayback(): Promise<{
  snapshot: PlaybackStateSnapshot;
  result: PlaybackFrameResult | null;
}> {
  const res = await fetch("/api/datasets/playback/step", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to step playback.");
  return data as { snapshot: PlaybackStateSnapshot; result: PlaybackFrameResult | null };
}

export async function resetPlayback(): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/reset", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to reset playback.");
  return data as PlaybackStateSnapshot;
}

export async function setPlaybackSpeed(speed: number): Promise<PlaybackStateSnapshot> {
  const res = await fetch("/api/datasets/playback/speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to update playback speed.");
  return data as PlaybackStateSnapshot;
}

// --- Phase 2: Backend Auth Session Verification & RBAC Audit ---

export async function verifyBackendSession(): Promise<{
  authenticated: boolean;
  user: {
    uid: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    isAdmin: boolean;
    recommendedRoleRedirect?: UserRole;
  };
  firebase: {
    configured: boolean;
    projectId: string;
    databaseId: string;
  };
} | null> {
  if (!auth.currentUser) return null;
  const res = await fetch("/api/auth/session", {
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function postBackendAuditEvent(payload: {
  eventType: string;
  summary: string;
  actorRole: UserRole;
  targetId?: string;
}): Promise<void> {
  if (!auth.currentUser) return;
  try {
    await fetch("/api/auth/audit", {
      method: "POST",
      headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-blocking audit call
  }
}

export async function fetchBackendAuditLogs(limit = 50): Promise<SystemAuditLog[]> {
  if (!auth.currentUser) return [];
  const res = await fetch(`/api/audit-logs?limit=${encodeURIComponent(String(limit))}`, {
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { logs?: SystemAuditLog[] };
  return data.logs ?? [];
}

// --- Phase 3: Authenticated ESP32 Device Management & Haptic Commands ---

export async function fetchRegisteredWearableDevices(
  patientId?: string
): Promise<RegisteredWearableDevice[]> {
  if (!auth.currentUser) return [];
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/wearable/devices${qs}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    devices?: RegisteredWearableDevice[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load registered wearable devices.");
  }
  return data.devices ?? [];
}

export async function registerWearableDevice(payload: {
  deviceId: string;
  patientId: string;
  label?: string;
  boardType?: string;
  pulseOxChipVariant?: string;
  ecgSensor?: string;
  imuSensor?: string;
  tempSensor?: string;
  samplingIntervalMs?: number;
  firmwareVersion?: string;
  rotateToken?: boolean;
}): Promise<{ device: RegisteredWearableDevice; deviceApiKey?: string }> {
  const res = await fetch("/api/wearable/devices/register", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    device?: RegisteredWearableDevice;
    deviceApiKey?: string;
    error?: string;
  };
  if (!res.ok || !data.device) {
    throw new Error(data.error || "Failed to register wearable device.");
  }
  return { device: data.device, deviceApiKey: data.deviceApiKey };
}

export async function updateWearableDeviceStatus(
  deviceId: string,
  connectionStatus: "not_connected" | "streaming" | "offline"
): Promise<RegisteredWearableDevice> {
  const res = await fetch(`/api/wearable/devices/${encodeURIComponent(deviceId)}/status`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ connectionStatus }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    device?: RegisteredWearableDevice;
    error?: string;
  };
  if (!res.ok || !data.device) {
    throw new Error(data.error || "Failed to update wearable device connection status.");
  }
  return data.device;
}

export async function sendWearableHapticCommand(
  deviceId: string,
  payload: {
    action: "activate" | "deactivate";
    pattern?: "none" | "single_pulse" | "triple_alert";
    durationMs?: number;
    reason?: string;
  }
): Promise<DeviceVibrationCommand> {
  const res = await fetch(`/api/wearable/devices/${encodeURIComponent(deviceId)}/command`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    command?: DeviceVibrationCommand;
    error?: string;
  };
  if (!res.ok || !data.command) {
    throw new Error(data.error || "Failed to dispatch vibration motor command.");
  }
  return data.command;
}

export async function fetchMlModelStatus(patientId: string): Promise<MlModelStatusSummary> {
  const res = await fetch(`/api/ml/model/status/${encodeURIComponent(patientId)}`, {
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) {
    throw new Error("Failed to fetch ML model status.");
  }
  return res.json();
}

export async function fetchMlConfig(): Promise<{
  config: MlDetectionConfig;
  mlServiceReachable: boolean;
}> {
  const res = await fetch("/api/ml/config", {
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) {
    throw new Error("Failed to fetch ML detection configuration.");
  }
  return res.json();
}

export async function saveMlConfig(
  patch: Partial<MlDetectionConfig>
): Promise<{
  config: MlDetectionConfig;
  mlServiceReachable: boolean;
}> {
  const res = await fetch("/api/ml/config", {
    method: "PUT",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as {
    config?: MlDetectionConfig;
    mlServiceReachable?: boolean;
    error?: string;
  };
  if (!res.ok || !data.config) {
    throw new Error(data.error || "Failed to update ML detection configuration.");
  }
  return {
    config: data.config,
    mlServiceReachable: Boolean(data.mlServiceReachable),
  };
}

export async function runMlEvaluation(payload: {
  patientId: string;
  source?: "esp32_hardware" | "simulator";
  samples: Array<{
    heartRate?: number | null;
    spo2?: number | null;
    temperatureC?: number | null;
    accelMagnitude?: number | null;
    gyroMagnitude?: number | null;
    movementStatus?: MovementStatus;
    signalQuality?: string;
    irSignalOk?: boolean;
    fingerDetected?: boolean;
    source?: string;
    timestamp?: string;
    label?: "normal" | "anomalous" | 0 | 1 | boolean | null;
  }>;
}): Promise<MlEvaluationResult> {
  const res = await fetch("/api/ml/evaluate", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as MlEvaluationResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || "Failed to evaluate ML anomaly detection model.");
  }
  return data;
}

export async function generateMlGraphs(payload: {
  patientId: string;
  source?: "esp32_hardware" | "simulator";
  samples: Array<{
    heartRate?: number | null;
    spo2?: number | null;
    temperatureC?: number | null;
    accelMagnitude?: number | null;
    gyroMagnitude?: number | null;
    movementStatus?: MovementStatus;
    signalQuality?: string;
    irSignalOk?: boolean;
    fingerDetected?: boolean;
    source?: string;
    timestamp?: string;
    anomalyScore?: number;
    anomalyStatus?: string;
  }>;
}): Promise<{
  patient_id: string;
  source: string;
  sample_count: number;
  graphs: MlGraphMeta[];
  ml_service_connected?: boolean;
}> {
  const res = await fetch("/api/ml/graphs/generate", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    patient_id?: string;
    source?: string;
    sample_count?: number;
    graphs?: MlGraphMeta[];
    ml_service_connected?: boolean;
    error?: string;
  };
  if (!res.ok || !Array.isArray(data.graphs)) {
    throw new Error(data.error || "Failed to generate ML evaluation graphs.");
  }
  return {
    patient_id: data.patient_id ?? payload.patientId,
    source: data.source ?? (payload.source || "simulator"),
    sample_count: data.sample_count ?? payload.samples.length,
    graphs: data.graphs,
    ml_service_connected: data.ml_service_connected,
  };
}

export async function fetchMlGraphs(patientId: string): Promise<{
  patient_id: string;
  graphs: MlGraphMeta[];
}> {
  const res = await fetch(`/api/ml/graphs/${encodeURIComponent(patientId)}`, {
    headers: await buildAuthHeaders(),
  });
  if (!res.ok) {
    return { patient_id: patientId, graphs: [] };
  }
  return res.json();
}

// --- Webcam Fall Detection & Emergency Escalation APIs ---

export async function fetchFallDetectionEvents(patientId?: string): Promise<{
  events: FallDetectionEventRecord[];
  stats: AdminFallDetectionStats | null;
}> {
  const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : "";
  const res = await fetch(`/api/fall-detection/events${qs}`, {
    headers: await buildAuthHeaders(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    events?: FallDetectionEventRecord[];
    stats?: AdminFallDetectionStats;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to load camera fall detection events.");
  }
  return {
    events: data.events ?? [],
    stats: data.stats ?? null,
  };
}

export async function reportFallDetectionEvent(payload: {
  patientId: string;
  patientName?: string;
  patientOwnerUid?: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  detectionMode: "webcam_pose" | "demo_simulation";
  state: FallDetectionState;
  reason: string;
  confidence: number;
  torsoAngleDeg: number;
  verticalVelocity: number;
  horizontalDurationSec: number;
  peopleCount: number;
  sensorFusionStatus: FallSensorFusionStatus;
  wearableSummary?: string;
  location: FallDetectionLocation | null;
  confirmationCountdownSec?: number;
}): Promise<{
  eventCreated: boolean;
  duplicateSuppressed: boolean;
  suppressedAlertId?: string;
  fallEvent: FallDetectionEventRecord | null;
  alert: AlertRecord | null;
  notifications: InAppNotification[];
}> {
  const res = await fetch("/api/fall-detection/events", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    eventCreated?: boolean;
    duplicateSuppressed?: boolean;
    suppressedAlertId?: string;
    fallEvent?: FallDetectionEventRecord | null;
    alert?: AlertRecord | null;
    notifications?: InAppNotification[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "Failed to record fall detection event.");
  }
  return {
    eventCreated: Boolean(data.eventCreated),
    duplicateSuppressed: Boolean(data.duplicateSuppressed),
    suppressedAlertId: data.suppressedAlertId,
    fallEvent: data.fallEvent ?? null,
    alert: data.alert ?? null,
    notifications: data.notifications ?? [],
  };
}

export async function cancelFallDetectionSafe(
  eventId: string,
  payload: {
    actorRole: UserRole;
    actorName?: string;
    reason?: string;
  }
): Promise<FallDetectionEventRecord> {
  const res = await fetch(`/api/fall-detection/events/${encodeURIComponent(eventId)}/cancel`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    fallEvent?: FallDetectionEventRecord;
    error?: string;
  };
  if (!res.ok || !data.fallEvent) {
    throw new Error(data.error || "Failed to cancel fall detection alert.");
  }
  return data.fallEvent;
}

export async function requestFallDetectionHelp(
  eventId: string,
  payload: {
    actorRole: UserRole;
    actorName?: string;
    reason?: string;
  }
): Promise<{
  fallEvent: FallDetectionEventRecord;
  alert: AlertRecord | null;
}> {
  const res = await fetch(`/api/fall-detection/events/${encodeURIComponent(eventId)}/request-help`, {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    fallEvent?: FallDetectionEventRecord;
    alert?: AlertRecord | null;
    error?: string;
  };
  if (!res.ok || !data.fallEvent) {
    throw new Error(data.error || "Failed to initiate caregiver notification.");
  }
  return {
    fallEvent: data.fallEvent,
    alert: data.alert ?? null,
  };
}

export async function postCameraTelemetry(payload: {
  patientId: string;
  patientOwnerUid?: string;
  cameraStatus: CameraMonitoringStatus;
  deviceLabel?: string;
  peopleCount: number;
  poseConfidence: number;
  sensorDisagreement?: boolean;
  errorMessage?: string;
}): Promise<CameraTelemetrySnapshot> {
  const res = await fetch("/api/fall-detection/telemetry", {
    method: "POST",
    headers: await buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    snapshot?: CameraTelemetrySnapshot;
    error?: string;
  };
  if (!res.ok || !data.snapshot) {
    throw new Error(data.error || "Failed to update camera telemetry status.");
  }
  return data.snapshot;
}

