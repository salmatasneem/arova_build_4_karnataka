export type AlertLevel = "Normal" | "Warning" | "Critical";
export type MovementStatus = "resting" | "walking" | "active" | "fall_suspect" | "inactive";
export type SignalQuality = "good" | "noisy" | "poor_contact";
export type EcgSignalQuality = "good" | "noisy" | "lead_off" | "unavailable";
export type TelemetrySource = "sample_demo" | "simulator" | "esp32_hardware" | "dataset_playback";
export type AlertSource = TelemetrySource | "webcam_pose" | "demo_simulation";
export type MlEngineType = "unconnected_rule_check" | "python_isolation_forest";
export type AnomalyStatus =
  | "insufficient_baseline"
  | "paused_poor_quality"
  | "normal"
  | "anomalous";
export type PredictionStage =
  | "paused_poor_quality"
  | "insufficient_baseline"
  | "normal"
  | "anomalous_sensor_window"
  | "potential_fall_alert"
  | "confirmed_fall_event"
  | "confirmed_physiological_alert";
export type TemperatureSite =
  | "skin_wrist"
  | "skin_chest"
  | "axillary"
  | "core_rectal"
  | "ambient"
  | "unknown";
export type SleepStage = "wake" | "n1" | "n2" | "n3" | "rem" | "asleep" | "unknown";

export interface AvailableModalities {
  heartRate?: boolean;
  spo2?: boolean;
  temperatureC?: boolean;
  imu?: boolean;
  ecg?: boolean;
  respiratoryRate?: boolean;
  sleepStage?: boolean;
}

export interface FallMetrics {
  impactPeakG?: number | null;
  freeFallDurationMs?: number | null;
  postFallStillnessSec?: number | null;
  postFallOrientationDeg?: number | null;
  groundTruthFallLabel?: string | null;
}

export interface DatasetPlaybackContext {
  datasetId: string;
  recordId?: string;
  groundTruthLabel?: string | null;
  virtualTimestamp?: string;
}

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

export interface ContributingFeatureDetail {
  feature: string;
  currentValue: number;
  baselineValue: number;
  zScore: number;
  context: string;
  unit: string;
}

export interface BaselineStatsBundle {
  heartRate: number;
  spo2: number;
  temperatureC: number;
  accelMagnitude: number;
  gyroMagnitude: number;
}

export interface ActivityBaselineSummary {
  sampleCount: number;
  heartRateMean: number;
  heartRateMedian?: number;
  heartRateStd: number;
  spo2Mean: number;
  spo2Median?: number;
  spo2Std: number;
}

export interface MlBaselineSummaryStats {
  means: BaselineStatsBundle;
  medians: BaselineStatsBundle;
  stds: BaselineStatsBundle;
  resting: ActivityBaselineSummary | null;
  active: ActivityBaselineSummary | null;
  sampleCount: number;
  updatedAt: string | null;
}

export interface MlModelMetadata {
  modelVersion: string | null;
  trainedAt: string | null;
  updatedAt: string | null;
  retrainCount: number;
  sampleCount: number;
  contamination: number;
  nEstimators: number;
  retrainInterval: number;
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

export interface BaselineProgress {
  collectedSamples: number;
  requiredSamples: number;
  status: "not_started" | "collecting" | "ready";
  source: TelemetrySource | null;
  modelVersion: string | null;
  restingSamples: number;
  activeSamples: number;
  ecgBaselineSamples: number;
  means?: Partial<BaselineStatsBundle>;
  medians?: Partial<BaselineStatsBundle>;
  stds?: Partial<BaselineStatsBundle>;
  updatedAt?: string | null;
}

export interface AlertPolicyConfig {
  baselineMinSamples?: number;
  warningPersistenceWindows?: number;
  criticalPersistenceWindows?: number;
  anomalyScoreWarningThreshold?: number;
  anomalyScoreCriticalThreshold?: number;
  zScoreWarningThreshold?: number;
  zScoreCriticalThreshold?: number;
}

export interface TelemetryPayload {
  patientId: string;
  deviceId?: string;
  timestamp?: string;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  movementStatus: MovementStatus;
  accelMagnitude: number;
  gyroMagnitude: number;
  possibleFallDetected?: boolean;
  irSignalOk?: boolean;
  fingerDetected?: boolean;
  ecgSamples?: number[];
  ecgSamplingRate?: number;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
  ecgTimestamp?: string;
  ecgFeatures?: EcgFeatures;
  source?: TelemetrySource;
  baselineMeans?: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
  };
  baselineTrained?: boolean;
  allowBaselineTraining?: boolean;
  policyConfig?: AlertPolicyConfig;
  // Backward-compatible optional extended fields for Stage 1+ dataset playback & future multi-axis sensors
  accelX?: number | null;
  accelY?: number | null;
  accelZ?: number | null;
  gyroX?: number | null;
  gyroY?: number | null;
  gyroZ?: number | null;
  imuSamplingRate?: number | null;
  fallMetrics?: FallMetrics;
  respiratoryRateBpm?: number | null;
  temperatureSite?: TemperatureSite | null;
  sleepStage?: SleepStage | null;
  availableModalities?: AvailableModalities;
  datasetContext?: DatasetPlaybackContext;
}

export interface PredictionClassification {
  stage: PredictionStage;
  anomalousWindow: boolean;
  potentialFallAlert: boolean;
  alertTriggered: boolean;
  confirmedFallEvent: boolean;
}

export interface MlAnalysisResult {
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
  contributingDetails: ContributingFeatureDetail[];
  persistenceCount: number;
  persistenceRequired: number;
  matchedBaselineContext: string;
  windowSize: number;
  baselineProgress: BaselineProgress;
  explanation: string;
  plainLanguageExplanations?: string[];
  timestamp?: string;
  isSimulated?: boolean;
  sensorValues?: {
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    accelMagnitude: number;
    gyroMagnitude: number;
    movementStatus: MovementStatus;
  };
  baselineStats?: MlBaselineSummaryStats | null;
  modelMetadata?: MlModelMetadata | null;
  ecgFeatures?: EcgFeatures;
  predictionClassification?: PredictionClassification;
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

export type CallEscalationStatus =
  | "not_triggered"
  | "provider_unconfigured"
  | "calling_primary"
  | "primary_answered"
  | "escalated_secondary"
  | "completed";

export interface EscalationWorkflowState {
  alertId: string;
  patientId: string;
  primaryCaregiverName: string;
  primaryCaregiverPhoneConfigured: boolean;
  secondaryCaregiverName: string;
  secondaryCaregiverPhoneConfigured: boolean;
  providerConfigured: boolean;
  providerName: string;
  timeoutSec: number;
  status: CallEscalationStatus;
  startedAt: string;
  primaryCallAttemptedAt?: string;
  escalatedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  isDryRun: boolean;
  log: string[];
}

export type NotificationChannel = "in_app" | "sms" | "email" | "voice_call";
export type NotificationDeliveryStatus =
  | "delivered"
  | "simulated"
  | "failed"
  | "skipped_unauthorized";

export interface AlertRelevantReadingsSnapshot {
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  movementStatus: MovementStatus;
  signalQuality: SignalQuality;
}

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
  stage:
    | "alert_created"
    | "patient_notified"
    | "awaiting_patient_ack"
    | "patient_acknowledged"
    | "escalated_to_caregiver"
    | "caregiver_notified"
    | "caregiver_acknowledged"
    | "false_alert_reported"
    | "resolved"
    | "duplicate_suppressed"
    | "notification_failed";
  summary: string;
  actorUid?: string;
  timestamp: string;
}

export interface Phase5AlertRecord {
  alertId: string;
  patientId: string;
  ownerUid: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  level: "Warning" | "Critical";
  status: "active" | "acknowledged" | "resolved";
  title: string;
  explanation: string;
  prototypeNotice: string;
  anomalyScore: number;
  signalQuality: SignalQuality;
  relevantReadings: AlertRelevantReadingsSnapshot;
  triggeredMetrics: string[];
  source: AlertSource;
  fallEventId?: string;
  detectionMode?: "webcam_pose" | "demo_simulation";
  sensorFusionStatus?: FallSensorFusionStatus;
  location?: FallDetectionLocation | null;
  confirmationDeadlineAt?: string;
  acknowledgedByUid?: string;
  acknowledgedByName?: string;
  patientAcknowledged: boolean;
  patientAcknowledgedAt?: string;
  caregiverAcknowledgedAt?: string;
  falseAlertReported: boolean;
  falseAlertReason?: string;
  falseAlertReportedByUid?: string;
  falseAlertReportedAt?: string;
  followUpAction?: string;
  unreadByPatient: boolean;
  unreadByCaregiver: boolean;
  escalationStatus:
    | "none"
    | "notified_patient"
    | "awaiting_patient_ack"
    | "notified_caregiver"
    | "escalated_to_caregiver"
    | "patient_acknowledged"
    | "caregiver_acknowledged"
    | "false_alert"
    | "resolved";
  escalationDueAt?: string;
  escalatedToCaregiversAt?: string;
  escalationHistory: EscalationHistoryEntry[];
  notificationAttempts: NotificationAttemptRecord[];
  notificationStatus: "pending" | "simulated" | "delivered" | "partial_failure" | "failed";
  suppressedOccurrences: number;
  callEscalationStatus: CallEscalationStatus;
  callLog: string[];
  createdAt: string;
  updatedAt: string;
}

export type FallDetectionState = "Normal" | "Warning" | "Possible Fall";
export type FallDetectionEventStatus =
  | "pending_confirmation"
  | "escalated"
  | "cancelled_safe"
  | "caregiver_acknowledged"
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

export interface FallDetectionLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt: string;
}

export interface FallDetectionEventRecord {
  eventId: string;
  patientId: string;
  patientName: string;
  ownerUid: string;
  primaryCaregiverUid?: string;
  secondaryCaregiverUid?: string;
  alertId: string;
  detectionMode: "webcam_pose" | "demo_simulation";
  isSimulated: boolean;
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
  confirmationCountdownSec: number;
  confirmationDeadlineAt: string;
  suppressedDuplicates: number;
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
  cancelledBy?: string;
  cancellationReason?: string;
  escalatedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  detectedAt: string;
  updatedAt: string;
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

export interface InAppNotificationRecord {
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

