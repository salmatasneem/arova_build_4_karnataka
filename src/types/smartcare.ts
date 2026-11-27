export type UserRole = "patient" | "caregiver" | "admin";
export type AlertLevel = "Normal" | "Warning" | "Critical";
export type MovementStatus = "resting" | "walking" | "active" | "fall_suspect" | "inactive";
export type SignalQuality = "good" | "noisy" | "poor_contact";
export type EcgSignalQuality = "good" | "noisy" | "lead_off" | "unavailable";
export type TelemetrySource = "sample_demo" | "simulator" | "esp32_hardware" | "dataset_playback";
export type AlertSource = TelemetrySource | "webcam_pose" | "demo_simulation";
export type FallDetectionState = "Normal" | "Warning" | "Possible Fall";
export type FallDetectionEventStatus =
  | "pending_confirmation"
  | "cancelled_safe"
  | "acknowledged"
  | "escalated"
  | "false_alert"
  | "resolved";
export type FallSensorFusionStatus =
  | "webcam_only"
  | "corroborated"
  | "sensor_disagreement";
export type CameraMonitoringStatus =
  | "standby"
  | "active"
  | "denied"
  | "unavailable"
  | "disconnected"
  | "low_confidence"
  | "out_of_frame";
export type MlEngineType = "unconnected_rule_check" | "python_isolation_forest";
export type AnomalyStatus =
  | "insufficient_baseline"
  | "paused_poor_quality"
  | "normal"
  | "anomalous";
export type TemperatureSite =
  | "skin_wrist"
  | "skin_chest"
  | "axillary"
  | "core_rectal"
  | "ambient"
  | "unknown";
export type SleepStage = "wake" | "n1" | "n2" | "n3" | "rem" | "asleep" | "unknown";
export type BaselineStatus = "not_started" | "collecting" | "ready";
export type AlertStatus = "active" | "acknowledged" | "resolved";
export type CallEscalationStatus =
  | "not_triggered"
  | "provider_unconfigured"
  | "calling_primary"
  | "primary_answered"
  | "escalated_secondary"
  | "completed";

export const VALIDATION_LIMITS = {
  MAX_ID_LEN: 128,
  MAX_NAME_LEN: 100,
  MAX_TITLE_LEN: 160,
  MAX_EXPLANATION_LEN: 600,
  MAX_ALERT_EXPLANATION_LEN: 800,
  MAX_FOLLOWUP_LEN: 500,
  MAX_ECG_BATCH: 250,
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
} as const;

export interface EcgFeatures {
  samplingRateHz: number;
  sampleCount: number;
  rPeakCount: number;
  estimatedEcgBpm: number | null;
  rrIntervalMeanMs: number | null;
  rrVariabilityMs: number | null;
  amplitudeRange: number;
  signalQuality: EcgSignalQuality;
}

export interface EcgSegmentRecord {
  segmentId: string;
  deviceId: string;
  patientId: string;
  samples: number[];
  samplingRate: number;
  signalQuality: EcgSignalQuality;
  leadOff: boolean;
  timestamp: string;
  features?: EcgFeatures;
  source: TelemetrySource;
}

export type AccountStatus = "active" | "suspended";

export interface UserProfileSettings {
  notificationsEnabled?: boolean;
  preferredLanguage?: SupportedVoiceLanguage;
  emergencyAlertsEnabled?: boolean;
  ageGroup?: string;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  role: UserRole;
  accountStatus?: AccountStatus;
  profileSettings?: UserProfileSettings;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserPrivateContact {
  uid: string;
  email: string;
  phone?: string;
  emergencyNotes?: string;
  updatedAt?: string;
}

export interface PatientRecord {
  patientId: string;
  ownerUid: string;
  displayName: string;
  ageGroup?: string;
  baselineStatus: BaselineStatus;
  baselineSamplesCount: number;
  baselineHeartRateMean?: number;
  baselineSpo2Mean?: number;
  baselineTempMean?: number;
  baselineSource?: TelemetrySource;
  baselineModelTrained?: boolean;
  baselineModelVersion?: string;
  baselineEcgBpmMean?: number;
  baselineActiveHrMean?: number;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  primaryCaregiverName?: string;
  secondaryCaregiverName?: string;
  dataMode: "sample" | "live";
  createdAt?: string;
  updatedAt?: string;
}

export interface SensorAvailabilityMap {
  pulseOximeter: boolean;
  temperature: boolean;
  imu: boolean;
  ecg: boolean;
  oled: boolean;
  vibrationMotor: boolean;
}

export interface DeviceVibrationCommand {
  commandId: string;
  deviceId: string;
  action: "activate" | "deactivate";
  pattern: "none" | "single_pulse" | "triple_alert";
  durationMs: number;
  reason: string;
  issuedAt: string;
  issuedByUid: string;
}

export interface LastReadingSummary {
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  movementStatus: MovementStatus;
  signalQuality: SignalQuality;
  accelX?: number | null;
  accelY?: number | null;
  accelZ?: number | null;
  timestamp: string;
}

export type SimSensorErrorMode =
  | "none"
  | "poor_contact"
  | "temp_disconnected"
  | "ecg_lead_off";

export interface RegisteredWearableDevice {
  deviceId: string;
  label: string;
  patientId: string;
  ownerUid: string;
  boardType: string;
  pulseOxChipVariant: string;
  ecgSensor: string;
  imuSensor: string;
  tempSensor: string;
  displayModule: string;
  hapticModule: string;
  firmwareVersion: string;
  samplingIntervalMs: number;
  connectionStatus: "not_connected" | "streaming" | "offline";
  lastSeenAt: string | null;
  lastDataSource: "esp32_hardware" | "simulator" | "none";
  sensorAvailability: SensorAvailabilityMap;
  maskedToken: string | null;
  tokenProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VitalReading {
  readingId: string;
  patientId: string;
  ownerUid: string;
  deviceId?: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  movementStatus: MovementStatus;
  accelMagnitude?: number;
  gyroMagnitude?: number;
  possibleFallDetected?: boolean;
  accelX?: number | null;
  accelY?: number | null;
  accelZ?: number | null;
  gyroX?: number | null;
  gyroY?: number | null;
  gyroZ?: number | null;
  imuSamplingRate?: number | null;
  respiratoryRateBpm?: number | null;
  temperatureSite?: TemperatureSite | null;
  sleepStage?: SleepStage | null;
  ecgSamples?: number[];
  ecgSamplingRate?: number;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
  ecgTimestamp?: string;
  ecgHeartRateBpm?: number;
  signalQuality: SignalQuality;
  sensorAvailability?: SensorAvailabilityMap;
  batteryPct?: number | null;
  anomalyStatus?: AnomalyStatus;
  anomalyScore: number;
  alertLevel: AlertLevel;
  contributingFeatures?: string[];
  plainLanguageExplanations?: string[];
  persistenceCount?: number;
  modelVersion?: string;
  source: TelemetrySource;
  mlEngine: MlEngineType;
  explanation: string;
  createdAt: string;
}

export type NotificationChannel = "in_app" | "sms" | "email" | "voice_call";
export type NotificationDeliveryStatus =
  | "delivered"
  | "simulated"
  | "failed"
  | "skipped_unauthorized";

export interface NotificationAttemptRecord {
  attemptId: string;
  channel: NotificationChannel;
  recipientRole: "patient" | "caregiver" | "admin";
  recipientUid?: string;
  recipientName: string;
  targetMasked?: string;
  provider: string;
  deliveryStatus: NotificationDeliveryStatus;
  isSimulated: boolean;
  message: string;
  errorDetail?: string;
  timestamp: string;
}

export interface EscalationHistoryEntry {
  stepId: string;
  stage: string;
  summary: string;
  actorUid?: string;
  timestamp: string;
}

export interface AlertRelevantReadingsSnapshot {
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  movementStatus: MovementStatus;
  signalQuality: SignalQuality;
}

export interface AlertRecord {
  alertId: string;
  patientId: string;
  ownerUid: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  level: "Warning" | "Critical";
  status: AlertStatus;
  title: string;
  explanation: string;
  prototypeNotice?: string;
  anomalyScore?: number;
  signalQuality?: SignalQuality;
  relevantReadingsSummary?: string;
  relevantReadings?: AlertRelevantReadingsSnapshot;
  triggeredMetrics: string[];
  source: AlertSource;
  fallEventId?: string;
  detectionMode?: "webcam_pose" | "demo_simulation";
  sensorFusionStatus?: FallSensorFusionStatus;
  location?: FallDetectionLocation | null;
  confirmationDeadlineAt?: string;
  acknowledgedByUid?: string;
  acknowledgedByName?: string;
  patientAcknowledged?: boolean;
  patientAcknowledgedAt?: string;
  caregiverAcknowledgedAt?: string;
  falseAlertReported?: boolean;
  falseAlertReason?: string;
  falseAlertReportedAt?: string;
  followUpAction?: string;
  unreadByPatient?: boolean;
  unreadByCaregiver?: boolean;
  escalationStatus?: string;
  escalationDueAt?: string;
  escalatedToCaregiversAt?: string;
  escalationHistory?: EscalationHistoryEntry[];
  notificationAttempts?: NotificationAttemptRecord[];
  notificationStatus?: "pending" | "simulated" | "delivered" | "partial_failure" | "failed";
  suppressedOccurrences?: number;
  callEscalationStatus: CallEscalationStatus;
  callLog: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FallDetectionLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt: string;
}

export interface FallDetectionEventRecord {
  eventId: string;
  alertId: string;
  patientId: string;
  ownerUid: string;
  patientName: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  detectionMode: "webcam_pose" | "demo_simulation";
  isSimulated?: boolean;
  state: FallDetectionState;
  status: FallDetectionEventStatus;
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
  confirmationDeadlineAt: string;
  suppressedDuplicates?: number;
  escalationTrigger?: "patient_ack_timeout" | "user_help_requested" | "manual";
  patientAckStatus?:
    | "awaiting_confirmation"
    | "user_confirmed_safe"
    | "assistance_requested"
    | "unacknowledged"
    | "caregiver_acknowledged";
  caregiverNotificationInitiated?: boolean;
  notificationAttempts?: NotificationAttemptRecord[];
  followUpNotes?: string;
  detectedAt: string;
  updatedAt: string;
  cancelledBy?: string;
  cancellationReason?: string;
  escalatedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
}

export interface CameraTelemetrySnapshot {
  patientId: string;
  ownerUid: string;
  cameraStatus: CameraMonitoringStatus;
  deviceLabel?: string;
  peopleCount: number;
  poseConfidence: number;
  sensorDisagreement: boolean;
  errorMessage?: string;
  updatedAt: string;
}

export interface AdminFallDetectionStats {
  totalFallEvents: number;
  activeFallEvents: number;
  escalatedFallEvents: number;
  cancelledSafeCount: number;
  falseFallAlerts: number;
  sensorDisagreementCount: number;
  cameraErrorsCount: number;
  latestCameraStatus: CameraMonitoringStatus;
  latestCameraUpdatedAt: string | null;
  recentCameraErrors: Array<{
    errorId: string;
    patientId: string;
    cameraStatus: CameraMonitoringStatus;
    message: string;
    timestamp: string;
  }>;
}

export interface InAppNotification {
  notificationId: string;
  alertId: string;
  patientId: string;
  patientOwnerUid: string;
  recipientUid?: string;
  recipientRole: "patient" | "caregiver" | "admin";
  severity: "Warning" | "Critical";
  title: string;
  message: string;
  prototypeNotice: string;
  deliveryStatus: NotificationDeliveryStatus;
  isSimulated: boolean;
  read: boolean;
  readAt?: string;
  createdAt: string;
}

export interface NotificationEscalationConfig {
  patientAckTimeoutSec: number;
  duplicateAlertWindowSec: number;
  caregiverEscalationEnabled: boolean;
  escalateOnWarning: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  voiceEnabled: boolean;
  updatedAt: string;
  updatedByUid: string;
}

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

export interface AdminAlertStats {
  totalAlerts: number;
  activeAlerts: number;
  acknowledgedAlerts: number;
  resolvedAlerts: number;
  falseAlerts: number;
  criticalAlerts: number;
  warningAlerts: number;
  suppressedDuplicates: number;
  unreadNotifications: number;
  totalNotifications: number;
  errorCount: number;
  fallDetectionStats?: AdminFallDetectionStats;
}

export interface NotificationErrorLog {
  errorId: string;
  alertId?: string;
  patientId?: string;
  channel: "in_app" | "sms" | "email" | "voice_call" | "escalation_engine";
  provider: string;
  message: string;
  timestamp: string;
}

export interface WearableDevice {
  deviceId: string;
  label: string;
  patientId: string;
  ownerUid: string;
  boardType: string;
  pulseOxChipVariant: string;
  ecgSensor?: string;
  imuSensor: string;
  tempSensor: string;
  displayModule: string;
  hapticModule: string;
  samplingIntervalMs: number;
  connectionStatus: "not_connected" | "streaming" | "offline";
  lastSeenAt?: string;
  lastDataSource?: "esp32_hardware" | "simulator" | "none";
  sensorAvailability?: SensorAvailabilityMap;
  lastReadingSummary?: LastReadingSummary;
  firmwareVersion: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CarePermissions {
  viewReadings?: boolean;
  acknowledgeAlerts?: boolean;
  receiveCalls?: boolean;
}

export interface CareLink {
  linkId: string;
  patientId: string;
  patientName: string;
  patientOwnerUid: string;
  caregiverUid: string;
  caregiverName: string;
  priority: "primary" | "secondary";
  status: "active" | "pending" | "revoked";
  relationship?: string;
  permissions?: CarePermissions;
  createdAt?: string;
  updatedAt?: string;
}

export interface BaselineRecord {
  baselineId: string;
  patientId: string;
  ownerUid: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  source: "sample_demo" | "simulator" | "esp32_hardware";
  learningStatus: BaselineStatus;
  featureStatistics: {
    heartRateMean?: number;
    heartRateMedian?: number;
    heartRateStd?: number;
    spo2Mean?: number;
    spo2Median?: number;
    spo2Std?: number;
    tempMean?: number;
    tempMedian?: number;
    tempStd?: number;
    accelMean?: number;
    accelMedian?: number;
    accelStd?: number;
    activeHrMean?: number;
    ecgBpmMean?: number;
    sampleCount?: number;
  };
  modelVersion?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MlDetectionConfig {
  contamination: number;
  nEstimators: number;
  retrainInterval: number;
  baselineMinSamples: number;
  warningPersistenceWindows: number;
  criticalPersistenceWindows: number;
  anomalyScoreWarning: number;
  anomalyScoreCritical: number;
  zScoreWarning: number;
  zScoreCritical: number;
}

export interface MlModelStatusSummary {
  mlServiceConnected?: boolean;
  patient_id: string;
  source: string | null;
  trained: boolean;
  sample_count: number;
  min_training_samples: number;
  model_version: string | null;
  trained_at: string | null;
  updated_at: string | null;
  contamination?: number;
  n_estimators?: number;
  retrain_count?: number;
  means: Record<string, number> | null;
  medians: Record<string, number> | null;
  stds: Record<string, number> | null;
  resting_means?: Record<string, number> | null;
  resting_medians?: Record<string, number> | null;
  resting_stds?: Record<string, number> | null;
  active_means?: Record<string, number> | null;
  active_medians?: Record<string, number> | null;
  active_stds?: Record<string, number> | null;
  history_count?: number;
  config?: Record<string, number>;
}

export interface MlEvaluationResult {
  evaluated_at: string;
  labeled_data_available: boolean;
  sample_count: number;
  model_version: string | null;
  source: string | null;
  evaluation_note: string;
  disclaimer: string;
  metrics_requiring_labels: string[];
  supervised_metrics: {
    labeled_count: number;
    accuracy: number;
    precision: number;
    recall: number;
    f1_score: number;
    confusion_matrix: {
      tn: number;
      fp: number;
      fn: number;
      tp: number;
      matrix: number[][];
    };
  } | null;
  unsupervised_metrics: {
    valid_quality_count: number;
    noisy_quality_count: number;
    poor_quality_count: number;
    normal_count: number;
    anomalous_count: number;
    insufficient_baseline_count: number;
    flagged_rate: number;
    anomaly_score_mean: number | null;
    anomaly_score_median: number | null;
    anomaly_score_std: number | null;
    anomaly_score_min: number | null;
    anomaly_score_max: number | null;
    anomaly_score_iqr: number | null;
    normal_vs_anomalous_score_gap: number | null;
    baseline_sample_count: number;
  };
}

export interface MlGraphMeta {
  id: string;
  title?: string;
  metric?: string;
  filename: string;
  url: string;
  point_count?: number;
  generated_at?: string;
}

export interface AnomalyEventRecord {
  eventId: string;
  patientId: string;
  ownerUid: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  anomalyScore: number;
  alertLevel: AlertLevel;
  featureSummary: string;
  contributingFeatures?: string[];
  modelVersion?: string;
  source: "sample_demo" | "simulator" | "esp32_hardware";
  createdAt: string;
}

export interface SystemAuditLog {
  logId: string;
  userId: string;
  actorRole: UserRole;
  eventType: string;
  summary: string;
  targetId?: string;
  createdAt: string;
}

export type AlertLevelId = "Low" | "Medium" | "High";

export type EscalationActionMode =
  | "log_only"
  | "dashboard_notify"
  | "automated_voice_call"
  | "emergency_escalation_chain";

export type CaregiverTargetMode = "none" | "primary" | "all_ordered";
export type HapticAlertPattern = "none" | "single_pulse" | "triple_alert";

export interface AlertLevelDetectionCriteria {
  mappedMlAlertLevels: AlertLevel[];
  requireAnomalousStatus: boolean;
  anomalyScoreMaxThreshold: number;
  minZScore: number;
  minPersistenceWindows: number;
}

export interface AlertLevelEscalationWorkflow {
  action: EscalationActionMode;
  notifyCaregivers: boolean;
  triggerAutomatedVoiceCall: boolean;
  requireExplicitConsent: boolean;
  caregiverPriorityTarget: CaregiverTargetMode;
  maxCallAttempts: number;
  retryIntervalSec: number;
  escalateToNextCaregiver: boolean;
  duplicateSuppressionWindowSec: number;
  hapticPattern: HapticAlertPattern;
}

export interface AlertLevelRuleDefinition {
  level: AlertLevelId;
  label: string;
  description: string;
  enabled: boolean;
  detection: AlertLevelDetectionCriteria;
  escalation: AlertLevelEscalationWorkflow;
}

export interface AlertLevelsPolicyConfig {
  version: number;
  updatedAt: string;
  updatedByUid: string;
  levels: Record<AlertLevelId, AlertLevelRuleDefinition>;
}

export interface SystemSettings {
  settingId: string;
  escalationTimeoutSec: number;
  baselineMinSamples: number;
  samplingDefaultMs: number;
  warningPersistenceWindows?: number;
  criticalPersistenceWindows?: number;
  anomalyScoreThreshold?: number;
  retryIntervalSec?: number;
  maxCallAttempts?: number;
  fallbackNotificationEnabled?: boolean;
  alertLevels?: AlertLevelsPolicyConfig;
  updatedByUid: string;
  updatedAt?: string;
}

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

export type CaregiverPriority = "primary" | "secondary" | "alternate";

export interface CaregiverVoiceContact {
  contactId: string;
  patientId: string;
  patientOwnerUid: string;
  caregiverUid?: string;
  caregiverName: string;
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
  alertSeverity: "Low" | "Medium" | "High" | "Test";
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
  escalationStatus: string;
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
  severity: "Low" | "Medium" | "High";
  triggerMetric: string;
  readingSummary: string;
  reasonForCalling: string;
  escalationStatus: string;
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

export interface BaselineProgressSummary {
  collectedSamples: number;
  requiredSamples: number;
  status: BaselineStatus;
  source: TelemetrySource | null;
  modelVersion: string | null;
  restingSamples: number;
  activeSamples: number;
  ecgBaselineSamples: number;
}

export interface IntegrationStatus {
  gemini: {
    configured: boolean;
    model: string;
  };
  mlService: {
    configured: boolean;
    reachable: boolean;
    urlConfigured: boolean;
    demoMode: boolean;
    engineLabel: string;
  };
  voiceCalling: {
    configured: boolean;
    providerName: string;
    timeoutSec: number;
    usingDefaultTimeout: boolean;
  };
  outboundTwilio?: {
    configured: boolean;
    missingEnvVars: string[];
    publicBaseUrlConfigured: boolean;
    statusMessage?: string;
  };
  browserVoice?: {
    configured: boolean;
    model: string;
    streamPath: string;
  };
  wearableIngest: {
    endpoint: string;
    tokenProtected: boolean;
  };
  firebase?: {
    configured: boolean;
    projectId: string;
    databaseId: string;
  };
  notifications?: NotificationProvidersStatus;
}

// --- Stage 3: Public Dataset Lab Types ---

export type DatasetAccessTier =
  | "open_access"
  | "registration_required"
  | "restricted_dua"
  | "credentialed_required";

export type DatasetAgeCohort =
  | "mixed_young_and_elderly"
  | "wide_adult_including_elderly"
  | "general_adult"
  | "young_healthy_adults"
  | "adult_clinical_sleep"
  | "hospital_icu_mixed";

export type SupportedAdapterDatasetId =
  | "sisfall"
  | "umafall"
  | "bidmc_ppg_respiration"
  | "mitdb_arrhythmia"
  | "ppg_dalia"
  | "wesad";

export interface AvailableModalities {
  heartRate?: boolean;
  spo2?: boolean;
  temperatureC?: boolean;
  imu?: boolean;
  ecg?: boolean;
  respiratoryRate?: boolean;
  sleepStage?: boolean;
}

export interface PublicDatasetCatalogEntry {
  id: string;
  name: string;
  sourcePlatform: string;
  exactUrl: string;
  doiOrReference: string;
  accessTier: DatasetAccessTier;
  requiresManualDownload: boolean;
  accessInstructions: string;
  cohort: {
    ageGroup: DatasetAgeCohort;
    includesElderly: boolean;
    allParticipantsElderly: false;
    participantCountSummary: string;
    demographicsNote: string;
  };
  signalsAvailable: {
    ecg: boolean;
    ppgOrHr: boolean;
    spo2: boolean;
    temperature: boolean;
    temperatureSite: "skin_wrist" | "skin_chest" | "core_rectal" | "none";
    imuAccel: boolean;
    imuGyro: boolean;
    respiratoryRate: boolean;
    sleepStages: boolean;
    fallLabels: boolean;
  };
  samplingRatesNote: string;
  nativeFormats: string[];
  integratedLocally: false;
  stageStatus: string;
}

export interface DatasetAdapterSpec {
  datasetId: SupportedAdapterDatasetId;
  supportedExtensions: string[];
  expectedFormats: string[];
  requiredColumnsNote: string;
  optionalColumnsNote: string;
  conversionWorkflowNote: string;
}

export type PlaybackStatus = "unloaded" | "ready" | "playing" | "paused" | "completed";

export interface PlaybackTelemetrySnapshot {
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  temperatureSite: TemperatureSite | null;
  respiratoryRateBpm: number | null;
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
  sleepStage: SleepStage | null;
  ecgSamples?: number[];
  ecgSamplingRate?: number;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
}

export interface PlaybackMlAnalysis {
  mlServiceConnected: boolean;
  mlEngine: MlEngineType;
  modelTrained: boolean;
  modelVersion: string | null;
  ecgModelTrained: boolean;
  signalQuality: SignalQuality;
  anomalyStatus: AnomalyStatus;
  anomalyScore: number;
  alertLevel: AlertLevel;
  triggeredMetrics: string[];
  contributingFeatures: string[];
  contributingDetails: Array<{
    feature: string;
    currentValue: number;
    baselineValue: number;
    zScore: number;
    context: string;
    unit: string;
  }>;
  persistenceCount: number;
  persistenceRequired: number;
  matchedBaselineContext: string;
  windowSize: number;
  baselineProgress: BaselineProgressSummary;
  explanation: string;
  ecgFeatures?: EcgFeatures;
  predictionClassification?: {
    stage:
      | "paused_poor_quality"
      | "insufficient_baseline"
      | "normal"
      | "anomalous_sensor_window"
      | "potential_fall_alert"
      | "confirmed_fall_event"
      | "confirmed_physiological_alert";
    anomalousWindow: boolean;
    potentialFallAlert: boolean;
    alertTriggered: boolean;
    confirmedFallEvent: boolean;
  };
}

export interface PlaybackFrameResult {
  frameIndex: number;
  relativeOffsetMs: number;
  timestampIso: string;
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
  telemetrySnapshot: PlaybackTelemetrySnapshot;
  analysis: PlaybackMlAnalysis;
}

export type GroundTruthGranularity = "sample_level" | "trial_level" | "none";

export type BaselineIndependenceStatus =
  | "no_baseline_trained"
  | "within_recording_split_not_independent"
  | "within_recording_online_not_independent";

export interface DatasetProvenanceSummary {
  datasetId: string;
  datasetName: string;
  sourcePlatform: string;
  participantId: string;
  recordId: string;
  originalFilename: string;
  source: "dataset_playback";
  isClinicalPatient: false;
  samplingRateHz: number | null;
  startTimestampIso: string | null;
  endTimestampIso: string | null;
  durationMs: number;
  hasGroundTruthLabels: boolean;
  labelGranularity?: GroundTruthGranularity;
  allFramesAnomalous?: boolean;
  labeledFrameCount: number;
  availableModalities: AvailableModalities;
  temperatureSite: TemperatureSite | null;
  cohortNote: string;
  includesElderly: boolean;
  allParticipantsElderly: false;
  provenanceNote: string;
  warnings: string[];
}

export interface GroundTruthConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
}

export interface EventEvaluationMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
  groundTruthEventCount: number;
  detectedEventCount: number;
  predictedEventCount: number;
}

export interface GroundTruthEvaluationSummary {
  hasGroundTruthLabels: boolean;
  labelGranularity?: GroundTruthGranularity;
  baselineIndependence?: BaselineIndependenceStatus;
  totalProcessedFrames: number;
  labeledCount: number;
  unlabeledCount: number;
  skippedPoorQualityCount: number;
  excludedBaselineTrainingCount?: number;
  metrics: GroundTruthConfusionMatrix | null;
  frameEvaluation?: {
    alertLevel: GroundTruthConfusionMatrix;
    anomalousWindow: GroundTruthConfusionMatrix;
    confirmedFallEvent: GroundTruthConfusionMatrix;
    counts: {
      anomalousWindowCount: number;
      potentialFallAlertCount: number;
      alertTriggeredCount: number;
      confirmedFallEventCount: number;
    };
    metricDescriptions: {
      alertLevel: string;
      anomalousWindow: string;
      confirmedFallEvent: string;
    };
  } | null;
  eventEvaluation?: {
    available: boolean;
    groundTruthEventCount: number;
    alertEventMetrics: EventEvaluationMetrics | null;
    confirmedFallEventMetrics: EventEvaluationMetrics | null;
    note: string;
  };
  limitationNote?: string | null;
  note: string;
  disclaimer: string;
}

export interface PlaybackStateSnapshot {
  status: PlaybackStatus;
  playbackPatientKey: string | null;
  currentRecordIndex: number;
  processedCount: number;
  totalRecords: number;
  speed: number;
  provenance: DatasetProvenanceSummary | null;
  lastResult: PlaybackFrameResult | null;
  recentResults: PlaybackFrameResult[];
  evaluation: GroundTruthEvaluationSummary;
}

export interface DatasetImportResponse {
  ok: boolean;
  recording: {
    datasetId: SupportedAdapterDatasetId;
    datasetName: string;
    sourcePlatform: string;
    participantId: string;
    recordId: string;
    originalFilename: string;
    samplingRateHz: number | null;
    startTimestampIso: string | null;
    endTimestampIso: string | null;
    durationMs: number;
    availableModalities: AvailableModalities;
    temperatureSite: TemperatureSite | null;
    hasGroundTruthLabels: boolean;
    labelGranularity?: GroundTruthGranularity;
    allFramesAnomalous?: boolean;
    labeledFrameCount: number;
    totalFrames: number;
    cohortNote: string;
    includesElderly: boolean;
    allParticipantsElderly: false;
    provenanceNote: string;
    warnings: string[];
  };
  playback: PlaybackStateSnapshot;
}

