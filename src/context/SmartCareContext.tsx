import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  settingId: "global",
  escalationTimeoutSec: 30,
  baselineMinSamples: 20,
  samplingDefaultMs: 2000,
  warningPersistenceWindows: 2,
  criticalPersistenceWindows: 3,
  anomalyScoreThreshold: -0.05,
  updatedByUid: "system_default",
};

const INITIAL_FALLBACK_PATIENTS: PatientRecord[] = [
  {
    patientId: "patient_primary",
    ownerUid: "local_workspace",
    displayName: "Monitored Patient",
    baselineStatus: "not_started",
    baselineSamplesCount: 0,
    dataMode: "sample",
  },
];

const INITIAL_FALLBACK_READINGS: Record<string, VitalReading[]> = {
  patient_primary: [],
};

const INITIAL_FALLBACK_DEVICES: WearableDevice[] = [
  {
    deviceId: "esp32_node_01",
    label: "ESP32 Wearable Node #1",
    patientId: "patient_primary",
    ownerUid: "local_workspace",
    boardType: "ESP32 DevKit v1 (Wi-Fi)",
    pulseOxChipVariant: "MAX30100 (Confirmed)",
    ecgSensor: "AD8232 Provisional ECG (ADC1 + LO+/LO-)",
    imuSensor: "MPU6050 6-Axis IMU",
    tempSensor: "Configurable (Pending Confirmation)",
    displayModule: "0.96-inch SSD1306 I2C OLED (128x64)",
    hapticModule: "Vibration Motor (Transistor/MOSFET Driver)",
    samplingIntervalMs: 2000,
    connectionStatus: "not_connected",
    firmwareVersion: "smartcare-max30100-ecg-v2.0",
  },
];

import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  testFirestoreConnection,
} from "../lib/firebase.ts";
import {
  acknowledgePhase5Alert,
  cancelFallDetectionSafe,
  fetchAdminNotificationStats,
  fetchAlertLevelsPolicy,
  fetchBackendAuditLogs,
  fetchFallDetectionEvents,
  fetchIntegrationStatus,
  fetchLatestHardwareEvents,
  fetchNotificationConfig,
  fetchPatientBaselineStatus,
  fetchPhase5Notifications,
  fetchRegisteredWearableDevices,
  markPhase5NotificationRead,
  postBackendAuditEvent,
  postCameraTelemetry,
  registerWearableDevice,
  reportFallDetectionEvent,
  reportPhase5FalseAlert,
  requestBaselineFit,
  requestFallDetectionHelp,
  resetAlertLevelsPolicy,
  resolvePhase5Alert,
  saveAlertLevelsPolicy,
  saveNotificationEscalationConfig,
  sendSimulatedWearablePacket,
  sendWearableHapticCommand,
  syncBackendCareLinks,
  updateWearableDeviceStatus,
  verifyBackendSession,
} from "../services/apiClient.ts";
import {
  VALIDATION_LIMITS,
  type AccountStatus,
  type AdminAlertStats,
  type AdminFallDetectionStats,
  type AlertLevelsPolicyConfig,
  type AlertRecord,
  type AnomalyEventRecord,
  type AnomalyStatus,
  type BaselineProgressSummary,
  type BaselineRecord,
  type CallEscalationStatus,
  type CameraMonitoringStatus,
  type CameraTelemetrySnapshot,
  type CareLink,
  type CarePermissions,
  type DeviceVibrationCommand,
  type EcgSegmentRecord,
  type EcgSignalQuality,
  type FallDetectionEventRecord,
  type FallDetectionLocation,
  type FallDetectionState,
  type FallSensorFusionStatus,
  type InAppNotification,
  type IntegrationStatus,
  type LastReadingSummary,
  type MovementStatus,
  type NotificationErrorLog,
  type NotificationEscalationConfig,
  type NotificationProvidersStatus,
  type PatientRecord,
  type RegisteredWearableDevice,
  type SensorAvailabilityMap,
  type SimSensorErrorMode,
  type SupportedVoiceLanguage,
  type SystemAuditLog,
  type SystemSettings,
  type TelemetrySource,
  type UserPrivateContact,
  type UserProfile,
  type UserProfileSettings,
  type UserRole,
  type VitalReading,
  type WearableDevice,
} from "../types/smartcare.ts";

const ADMIN_ALLOWLIST_EMAILS = new Set([
  "aasiyahadiya7575@gmail.com",
  "salmatasneem75@gmail.com",
  "salmatasneem692@gmail.com",
]);

const EMPTY_PLACEHOLDER_PATIENT: PatientRecord = {
  patientId: "unassigned_patient",
  ownerUid: "",
  displayName: "No Linked Patient",
  baselineStatus: "not_started",
  baselineSamplesCount: 0,
  dataMode: "live",
};

function mapFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/operation-not-allowed":
      return "Email/Password authentication is not enabled yet in Firebase Console (Authentication > Sign-in method). Enable Email/Password there or sign in with Google.";
    case "auth/email-already-in-use":
      return "An AROVA account with this email already exists. Try signing in or resetting your password.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password. Please check your credentials or reset your password.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment before trying again.";
    case "auth/popup-closed-by-user":
      return "Google sign-in popup was closed before completing.";
    default:
      return err instanceof Error ? err.message : "Authentication failed.";
  }
}

const DEFAULT_ALERT_LEVELS_POLICY: AlertLevelsPolicyConfig = {
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedByUid: "system_default",
  levels: {
    Low: {
      level: "Low",
      label: "Low Severity · Early Deviation",
      description:
        "Single-window or mild personalized baseline deviation. Logged passively for trend review without waking caregivers.",
      enabled: true,
      detection: {
        mappedMlAlertLevels: ["Normal"],
        requireAnomalousStatus: true,
        anomalyScoreMaxThreshold: 0.05,
        minZScore: 1.5,
        minPersistenceWindows: 1,
      },
      escalation: {
        action: "log_only",
        notifyCaregivers: false,
        triggerAutomatedVoiceCall: false,
        requireExplicitConsent: true,
        caregiverPriorityTarget: "none",
        maxCallAttempts: 0,
        retryIntervalSec: 60,
        escalateToNextCaregiver: false,
        duplicateSuppressionWindowSec: 300,
        hapticPattern: "none",
      },
    },
    Medium: {
      level: "Medium",
      label: "Medium Severity · Sustained Warning",
      description:
        "Multi-window physiological deviation or Warning-level Isolation Forest anomaly. Alerts dashboard & primary caregiver.",
      enabled: true,
      detection: {
        mappedMlAlertLevels: ["Warning"],
        requireAnomalousStatus: false,
        anomalyScoreMaxThreshold: -0.05,
        minZScore: 2.0,
        minPersistenceWindows: 2,
      },
      escalation: {
        action: "dashboard_notify",
        notifyCaregivers: true,
        triggerAutomatedVoiceCall: false,
        requireExplicitConsent: true,
        caregiverPriorityTarget: "primary",
        maxCallAttempts: 1,
        retryIntervalSec: 45,
        escalateToNextCaregiver: false,
        duplicateSuppressionWindowSec: 300,
        hapticPattern: "single_pulse",
      },
    },
    High: {
      level: "High",
      label: "High Severity · Critical Emergency",
      description:
        "Severe multi-signal deviation, acute threshold breach, or confirmed fall event. Triggers automated emergency escalation chain.",
      enabled: true,
      detection: {
        mappedMlAlertLevels: ["Critical"],
        requireAnomalousStatus: false,
        anomalyScoreMaxThreshold: -0.18,
        minZScore: 3.0,
        minPersistenceWindows: 3,
      },
      escalation: {
        action: "emergency_escalation_chain",
        notifyCaregivers: true,
        triggerAutomatedVoiceCall: true,
        requireExplicitConsent: true,
        caregiverPriorityTarget: "all_ordered",
        maxCallAttempts: 2,
        retryIntervalSec: 30,
        escalateToNextCaregiver: true,
        duplicateSuppressionWindowSec: 600,
        hapticPattern: "triple_alert",
      },
    },
  },
};

interface SmartCareContextValue {
  authReady: boolean;
  authLoading: boolean;
  firestoreConnected: boolean;
  user: User | null;
  emailVerified: boolean;
  isAdminUser: boolean;
  assignedRole: UserRole | null;
  activeRole: UserRole;
  userProfile: UserProfile | null;
  privateContact: UserPrivateContact | null;
  lastAuthRedirectRole: UserRole | null;
  clearLastAuthRedirectRole: () => void;
  setActiveRole: (role: UserRole) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  registerWithEmail: (input: {
    name: string;
    email: string;
    password: string;
    role: "patient" | "caregiver";
    ageGroup?: string;
  }) => Promise<UserRole>;
  signInWithEmail: (email: string, password: string) => Promise<UserRole>;
  sendPasswordReset: (email: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  refreshCurrentUser: () => Promise<boolean>;
  signOutUser: () => Promise<void>;
  authError: string | null;
  clearAuthError: () => void;

  usingSampleData: boolean;
  hasFirestoreWorkspace: boolean;
  initializeFirestoreWorkspace: () => Promise<void>;
  updateProfileSettings: (input: {
    displayName: string;
    ageGroup?: string;
    phone?: string;
    emergencyNotes?: string;
    notificationsEnabled?: boolean;
    preferredLanguage?: SupportedVoiceLanguage;
    emergencyAlertsEnabled?: boolean;
  }) => Promise<void>;

  patients: PatientRecord[];
  selectedPatientId: string;
  setSelectedPatientId: (id: string) => void;
  selectedPatient: PatientRecord;

  readings: VitalReading[];
  alerts: AlertRecord[];
  devices: WearableDevice[];
  careLinks: CareLink[];
  registeredUsers: UserProfile[];
  baselines: BaselineRecord[];
  anomalyEvents: AnomalyEventRecord[];
  auditLogs: SystemAuditLog[];
  liveHardwareSnapshot: VitalReading | null;
  ecgSegments: EcgSegmentRecord[];
  baselineStatusSummary: {
    esp32Hardware: BaselineProgressSummary;
    simulator: BaselineProgressSummary;
    activeBaseline: BaselineProgressSummary;
  } | null;
  systemSettings: SystemSettings;
  alertLevelsPolicy: AlertLevelsPolicyConfig;
  integrations: IntegrationStatus | null;
  refreshIntegrations: () => Promise<void>;
  notifications: InAppNotification[];
  unreadNotificationCount: number;
  notificationConfig: NotificationEscalationConfig | null;
  notificationProviders: NotificationProvidersStatus | null;
  adminAlertStats: AdminAlertStats | null;
  fallDetectionStats: AdminFallDetectionStats | null;
  notificationErrorLogs: NotificationErrorLog[];
  fallEvents: FallDetectionEventRecord[];
  activeEmergencyFallEvent: FallDetectionEventRecord | null;
  latestCameraTelemetry: CameraTelemetrySnapshot | null;
  refreshPhase5Notifications: () => Promise<void>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  reportWebcamFallDetection: (input: {
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
  }) => Promise<{
    eventCreated: boolean;
    duplicateSuppressed: boolean;
    fallEvent: FallDetectionEventRecord | null;
  }>;
  cancelFallAlertSafe: (eventId: string, reason?: string) => Promise<void>;
  requestFallHelp: (eventId: string, reason?: string) => Promise<void>;
  dismissEmergencyOverlay: (eventId: string) => void;
  postCameraStatusTelemetry: (input: {
    cameraStatus: CameraMonitoringStatus;
    deviceLabel?: string;
    peopleCount: number;
    poseConfidence: number;
    sensorDisagreement?: boolean;
    errorMessage?: string;
  }) => Promise<void>;

  injectSimulatorReading: (input: {
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
    ecgSamples?: number[];
    ecgSamplingRate?: number;
    ecgSignalQuality?: EcgSignalQuality;
    ecgLeadOff?: boolean;
    ecgTimestamp?: string;
    source?: TelemetrySource;
  }) => Promise<VitalReading>;
  registeredBackendDevices: RegisteredWearableDevice[];
  refreshBackendDevices: () => Promise<void>;
  registerDeviceWithBackend: (input: {
    deviceId: string;
    label?: string;
    pulseOxChipVariant?: string;
    ecgSensor?: string;
    tempSensor?: string;
    samplingIntervalMs?: number;
    firmwareVersion?: string;
    rotateToken?: boolean;
  }) => Promise<{ device: RegisteredWearableDevice; deviceApiKey?: string }>;
  setDeviceConnectionState: (
    deviceId: string,
    connectionStatus: "not_connected" | "streaming" | "offline"
  ) => Promise<void>;
  triggerDeviceVibrationCommand: (
    deviceId: string,
    payload: {
      action: "activate" | "deactivate";
      pattern?: "none" | "single_pulse" | "triple_alert";
      durationMs?: number;
      reason?: string;
    }
  ) => Promise<DeviceVibrationCommand>;
  simRunning: boolean;
  simMode: "normal" | "unusual";
  simDeviceConnected: boolean;
  simSensorError: SimSensorErrorMode;
  simIntervalMs: number;
  simLastPacketSummary: string | null;
  startSimulation: (mode?: "normal" | "unusual") => void;
  stopSimulation: () => void;
  setSimMode: (mode: "normal" | "unusual") => void;
  setSimIntervalMs: (ms: number) => void;
  setSimSensorError: (err: SimSensorErrorMode) => void;
  generateNormalReading: () => Promise<VitalReading | null>;
  generateUnusualReading: () => Promise<VitalReading | null>;
  disconnectSimulatedDevice: () => Promise<void>;
  reconnectSimulatedDevice: () => Promise<void>;
  fitBaselineForSelectedPatient: () => Promise<{ message: string; mlServiceConnected: boolean }>;
  acknowledgeAlert: (
    alertId: string,
    followUpAction: string,
    actorRoleOverride?: UserRole
  ) => Promise<void>;
  reportFalseAlert: (
    alertId: string,
    reason: string,
    actorRoleOverride?: UserRole
  ) => Promise<void>;
  resolveAlert: (
    alertId: string,
    followUpAction: string,
    actorRoleOverride?: UserRole
  ) => Promise<void>;
  updateAlertEscalation: (
    alertId: string,
    status: CallEscalationStatus,
    newLogEntries: string[]
  ) => Promise<void>;
  updateNotificationConfig: (
    patch: Partial<Omit<NotificationEscalationConfig, "updatedAt" | "updatedByUid">>
  ) => Promise<NotificationEscalationConfig>;
  saveDeviceConfig: (device: {
    deviceId: string;
    label: string;
    pulseOxChipVariant: string;
    ecgSensor?: string;
    tempSensor: string;
    samplingIntervalMs: number;
    firmwareVersion: string;
  }) => Promise<void>;
  adminUpdateDevice: (
    deviceId: string,
    patch: {
      connectionStatus?: "not_connected" | "streaming" | "offline";
      samplingIntervalMs?: number;
      label?: string;
    }
  ) => Promise<void>;
  addCareLink: (input: {
    patientId?: string;
    caregiverName: string;
    caregiverUid: string;
    priority: "primary" | "secondary";
    relationship?: string;
    permissions?: CarePermissions;
  }) => Promise<void>;
  updateCareLinkStatus: (
    linkId: string,
    status: "active" | "pending" | "revoked"
  ) => Promise<void>;
  adminUpdateUserAccount: (
    targetUid: string,
    patch: {
      role?: UserRole;
      accountStatus?: AccountStatus;
    }
  ) => Promise<void>;
  updateSystemSettings: (next: {
    escalationTimeoutSec: number;
    baselineMinSamples: number;
    samplingDefaultMs: number;
    warningPersistenceWindows?: number;
    criticalPersistenceWindows?: number;
    anomalyScoreThreshold?: number;
  }) => Promise<void>;
  updateAlertLevelsPolicy: (next: AlertLevelsPolicyConfig) => Promise<AlertLevelsPolicyConfig>;
  resetAlertLevelsPolicyConfig: () => Promise<AlertLevelsPolicyConfig>;
}

const SmartCareContext = createContext<SmartCareContextValue | null>(null);

function tsToIso(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === "string") return val;
  if (typeof (val as Timestamp)?.toDate === "function") {
    return (val as Timestamp).toDate().toISOString();
  }
  return new Date().toISOString();
}

function sanitizeId(raw: string, fallbackPrefix: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return cleaned || `${fallbackPrefix}_${Date.now()}`;
}

export function SmartCareProvider({ children }: { children: React.ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [firestoreConnected, setFirestoreConnected] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [assignedRole, setAssignedRole] = useState<UserRole | null>(null);
  const [activeRole, setActiveRoleState] = useState<UserRole>("patient");
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [privateContact, setPrivateContact] = useState<UserPrivateContact | null>(null);
  const [lastAuthRedirectRole, setLastAuthRedirectRole] = useState<UserRole | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const pendingRegistrationRef = useRef<{
    email: string;
    displayName: string;
    role: "patient" | "caregiver";
    ageGroup?: string;
  } | null>(null);
  const triggerRedirectOnNextAuthRef = useRef(false);

  const [firestorePatients, setFirestorePatients] = useState<PatientRecord[]>([]);
  const [firestoreReadings, setFirestoreReadings] = useState<VitalReading[]>([]);
  const [firestoreAlerts, setFirestoreAlerts] = useState<AlertRecord[]>([]);
  const [firestoreDevices, setFirestoreDevices] = useState<WearableDevice[]>([]);
  const [firestoreCareLinks, setFirestoreCareLinks] = useState<CareLink[]>([]);
  const [firestoreUsers, setFirestoreUsers] = useState<UserProfile[]>([]);
  const [firestoreBaselines, setFirestoreBaselines] = useState<BaselineRecord[]>([]);
  const [firestoreAnomalyEvents, setFirestoreAnomalyEvents] = useState<AnomalyEventRecord[]>([]);
  const [firestoreAuditLogs, setFirestoreAuditLogs] = useState<SystemAuditLog[]>([]);
  const [backendAuditLogs, setBackendAuditLogs] = useState<SystemAuditLog[]>([]);
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(DEFAULT_SYSTEM_SETTINGS);
  const [alertLevelsPolicy, setAlertLevelsPolicy] = useState<AlertLevelsPolicyConfig>(
    DEFAULT_ALERT_LEVELS_POLICY
  );

  const [samplePatients, setSamplePatients] = useState<PatientRecord[]>(INITIAL_FALLBACK_PATIENTS);
  const [sampleReadingsMap, setSampleReadingsMap] =
    useState<Record<string, VitalReading[]>>(INITIAL_FALLBACK_READINGS);
  const [sampleAlerts, setSampleAlerts] = useState<AlertRecord[]>([]);
  const [sampleDevices, setSampleDevices] = useState<WearableDevice[]>(INITIAL_FALLBACK_DEVICES);
  const [sampleCareLinks, setSampleCareLinks] = useState<CareLink[]>([]);
  const [sampleBaselines, setSampleBaselines] = useState<BaselineRecord[]>([]);
  const [sampleAnomalyEvents, setSampleAnomalyEvents] = useState<AnomalyEventRecord[]>([]);

  const [selectedPatientId, setSelectedPatientId] = useState<string>(
    INITIAL_FALLBACK_PATIENTS[0].patientId
  );
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [liveHardwareSnapshot, setLiveHardwareSnapshot] = useState<VitalReading | null>(null);
  const [serverEcgHistory, setServerEcgHistory] = useState<EcgSegmentRecord[]>([]);
  const [registeredBackendDevices, setRegisteredBackendDevices] = useState<RegisteredWearableDevice[]>([]);
  const [simRunning, setSimRunning] = useState(false);
  const [simMode, setSimMode] = useState<"normal" | "unusual">("normal");
  const [simDeviceConnected, setSimDeviceConnected] = useState(true);
  const [simSensorError, setSimSensorError] = useState<SimSensorErrorMode>("none");
  const [simIntervalMs, setSimIntervalMs] = useState(2500);
  const [simLastPacketSummary, setSimLastPacketSummary] = useState<string | null>(null);
  const lastPersistedHardwareKeyRef = useRef<string | null>(null);
  const [baselineStatusSummary, setBaselineStatusSummary] = useState<{
    esp32Hardware: BaselineProgressSummary;
    simulator: BaselineProgressSummary;
    activeBaseline: BaselineProgressSummary;
  } | null>(null);
  const [backendAlerts, setBackendAlerts] = useState<AlertRecord[]>([]);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [notificationConfig, setNotificationConfig] = useState<NotificationEscalationConfig | null>(
    null
  );
  const [notificationProviders, setNotificationProviders] =
    useState<NotificationProvidersStatus | null>(null);
  const [adminAlertStats, setAdminAlertStats] = useState<AdminAlertStats | null>(null);
  const [fallDetectionStats, setFallDetectionStats] = useState<AdminFallDetectionStats | null>(null);
  const [notificationErrorLogs, setNotificationErrorLogs] = useState<NotificationErrorLog[]>([]);
  const [firestoreFallEvents, setFirestoreFallEvents] = useState<FallDetectionEventRecord[]>([]);
  const [backendFallEvents, setBackendFallEvents] = useState<FallDetectionEventRecord[]>([]);
  const [sampleFallEvents, setSampleFallEvents] = useState<FallDetectionEventRecord[]>([]);
  const [dismissedFallEventIds, setDismissedFallEventIds] = useState<string[]>([]);
  const [latestCameraTelemetry, setLatestCameraTelemetry] = useState<CameraTelemetrySnapshot | null>(
    null
  );

  const clearAuthError = useCallback(() => setAuthError(null), []);
  const clearLastAuthRedirectRole = useCallback(() => setLastAuthRedirectRole(null), []);

  const writeAuditLog = useCallback(
    async (
      targetUser: { uid: string; role: UserRole },
      eventType: string,
      summary: string,
      targetId?: string
    ) => {
      const logId = sanitizeId(`log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, "log");
      try {
        await setDoc(doc(db, "audit_logs", logId), {
          logId,
          userId: targetUser.uid,
          actorRole: targetUser.role,
          eventType: eventType.slice(0, 80),
          summary: summary.slice(0, 400),
          ...(targetId ? { targetId: targetId.slice(0, 128) } : {}),
          createdAt: serverTimestamp(),
        });
      } catch {
        // Non-fatal if offline or permission constrained
      }
      void postBackendAuditEvent({
        eventType,
        summary,
        actorRole: targetUser.role,
        targetId,
      });
    },
    []
  );

  const provisionPatientWorkspaceForUser = useCallback(
    async (targetUid: string, displayName: string, ageGroup?: string) => {
      const patientId = sanitizeId(`pt_${targetUid.slice(0, 16)}`, "pt");
      const deviceId = sanitizeId(`esp32_${targetUid.slice(0, 12)}`, "esp32");
      const baselineId = sanitizeId(`${patientId}_simulator`, "base");
      const cleanName = (displayName || "My Patient Profile").slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      const cleanAgeGroup = (ageGroup || "Adult · Personalized Baseline").slice(0, 40);

      const ptRef = doc(db, "patients", patientId);
      const existingPt = await getDoc(ptRef);
      if (!existingPt.exists()) {
        await setDoc(ptRef, {
          patientId,
          ownerUid: targetUid,
          displayName: cleanName,
          ageGroup: cleanAgeGroup,
          baselineStatus: "not_started",
          baselineSamplesCount: 0,
          primaryCaregiverName: "Primary Caregiver (Unassigned)",
          secondaryCaregiverName: "Secondary Caregiver (Unassigned)",
          dataMode: "live",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const devRef = doc(db, "devices", deviceId);
      const existingDev = await getDoc(devRef);
      if (!existingDev.exists()) {
        await setDoc(devRef, {
          deviceId,
          label: "ESP32 Wearable Node #1",
          patientId,
          ownerUid: targetUid,
          boardType: "ESP32 DevKit v1 (Wi-Fi)",
          pulseOxChipVariant: "MAX30100 (Confirmed)",
          ecgSensor: "AD8232 Provisional ECG (ADC1 + LO+/LO-)",
          imuSensor: "MPU6050 6-Axis IMU",
          tempSensor: "Configurable (Model Pending Confirmation)",
          displayModule: "0.96-inch SSD1306 I2C OLED (128x64)",
          hapticModule: "Vibration Motor (Transistor/MOSFET Driver)",
          samplingIntervalMs: 2000,
          connectionStatus: "not_connected",
          firmwareVersion: "arova-max30100-ecg-v2.0",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const baseRef = doc(db, "baselines", baselineId);
      const existingBase = await getDoc(baseRef);
      if (!existingBase.exists()) {
        await setDoc(baseRef, {
          baselineId,
          patientId,
          ownerUid: targetUid,
          source: "simulator",
          learningStatus: "not_started",
          featureStatistics: {
            sampleCount: 0,
          },
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      setSelectedPatientId(patientId);
      return patientId;
    },
    []
  );

  const refreshIntegrations = useCallback(async () => {
    try {
      const data = await fetchIntegrationStatus();
      setIntegrations(data);
    } catch {
      // Leave previous integration state
    }
  }, []);

  useEffect(() => {
    void testFirestoreConnection().then(setFirestoreConnected);
    void refreshIntegrations();
    void fetchAlertLevelsPolicy()
      .then((res) => setAlertLevelsPolicy(res.policy))
      .catch(() => {
        // Keep defaults cleanly
      });
  }, [refreshIntegrations]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setEmailVerified(Boolean(nextUser?.emailVerified));
      setAuthError(null);
      if (!nextUser) {
        setIsAdminUser(false);
        setAssignedRole(null);
        setUserProfile(null);
        setPrivateContact(null);
        setFirestorePatients([]);
        setFirestoreReadings([]);
        setFirestoreAlerts([]);
        setFirestoreDevices([]);
        setFirestoreCareLinks([]);
        setFirestoreUsers([]);
        setFirestoreBaselines([]);
        setFirestoreAnomalyEvents([]);
        setFirestoreAuditLogs([]);
        setFirestoreFallEvents([]);
        setBackendAuditLogs([]);
        setAuthReady(true);
        return;
      }

      try {
        const userRef = doc(db, "users", nextUser.uid);
        const snap = await getDoc(userRef);
        const normalizedEmail = nextUser.email?.toLowerCase().trim() ?? "";
        const isBootstrapAdmin =
          nextUser.emailVerified && ADMIN_ALLOWLIST_EMAILS.has(normalizedEmail);

        let adminFlag = isBootstrapAdmin;
        if (!adminFlag && nextUser.emailVerified) {
          try {
            const adminSnap = await getDoc(doc(db, "admins", nextUser.uid));
            adminFlag = adminSnap.exists();
          } catch {
            adminFlag = false;
          }
        }
        setIsAdminUser(adminFlag);

        const pendingReg = pendingRegistrationRef.current;
        const matchesPending =
          pendingReg &&
          (!nextUser.email || pendingReg.email.toLowerCase() === nextUser.email.toLowerCase());

        let resolvedRole: UserRole = "patient";

        if (!snap.exists()) {
          const initialRole: UserRole = adminFlag
            ? "admin"
            : matchesPending
            ? pendingReg.role
            : "patient";
          const initialName = (
            (matchesPending ? pendingReg.displayName : nextUser.displayName) ||
            nextUser.email ||
            "AROVA User"
          ).slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);

          const initialSettings: UserProfileSettings = {
            notificationsEnabled: true,
            preferredLanguage: "en",
            emergencyAlertsEnabled: true,
            ...(matchesPending && pendingReg.ageGroup
              ? { ageGroup: pendingReg.ageGroup.slice(0, 40) }
              : {}),
          };

          await setDoc(userRef, {
            uid: nextUser.uid,
            displayName: initialName,
            role: initialRole,
            accountStatus: "active",
            profileSettings: initialSettings,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          const contactRef = doc(db, "users", nextUser.uid, "private", "contact");
          await setDoc(contactRef, {
            uid: nextUser.uid,
            email: (nextUser.email || "user@example.com").slice(0, 160),
            updatedAt: serverTimestamp(),
          });

          if (initialRole === "patient") {
            await provisionPatientWorkspaceForUser(
              nextUser.uid,
              initialName,
              matchesPending ? pendingReg.ageGroup : undefined
            );
          }

          await writeAuditLog(
            { uid: nextUser.uid, role: initialRole },
            "account_registered",
            `Registered ${initialRole} account (${nextUser.email || nextUser.uid}).`,
            nextUser.uid
          );

          pendingRegistrationRef.current = null;
          resolvedRole = initialRole;
          setUserProfile({
            uid: nextUser.uid,
            displayName: initialName,
            role: initialRole,
            accountStatus: "active",
            profileSettings: initialSettings,
          });
          setPrivateContact({
            uid: nextUser.uid,
            email: nextUser.email || "user@example.com",
          });
        } else {
          const data = snap.data() as Record<string, unknown>;
          const storedRole = data.role as UserRole | undefined;
          if (storedRole === "admin" && adminFlag) {
            resolvedRole = "admin";
          } else if (storedRole === "caregiver") {
            resolvedRole = "caregiver";
          } else if (adminFlag) {
            resolvedRole = "admin";
          } else {
            resolvedRole = "patient";
          }

          const settings =
            data.profileSettings && typeof data.profileSettings === "object"
              ? (data.profileSettings as UserProfileSettings)
              : undefined;

          setUserProfile({
            uid: String(data.uid ?? nextUser.uid),
            displayName: String(data.displayName ?? nextUser.displayName ?? "AROVA User"),
            role: resolvedRole,
            accountStatus: data.accountStatus === "suspended" ? "suspended" : "active",
            profileSettings: settings,
            createdAt: tsToIso(data.createdAt),
            updatedAt: tsToIso(data.updatedAt),
          });

          try {
            const contactSnap = await getDoc(doc(db, "users", nextUser.uid, "private", "contact"));
            if (contactSnap.exists()) {
              const cd = contactSnap.data() as Record<string, unknown>;
              setPrivateContact({
                uid: nextUser.uid,
                email: String(cd.email ?? nextUser.email ?? ""),
                phone: cd.phone ? String(cd.phone) : undefined,
                emergencyNotes: cd.emergencyNotes ? String(cd.emergencyNotes) : undefined,
                updatedAt: tsToIso(cd.updatedAt),
              });
            }
          } catch {
            // Ignore private contact read errors cleanly
          }
        }

        setAssignedRole(resolvedRole);
        setActiveRoleState(resolvedRole);

        if (triggerRedirectOnNextAuthRef.current) {
          triggerRedirectOnNextAuthRef.current = false;
          setLastAuthRedirectRole(resolvedRole);
        }

        // Verify token with Express backend session endpoint (non-blocking)
        void verifyBackendSession().catch(() => null);
      } catch (err) {
        console.error("Auth profile sync error:", err);
      } finally {
        setAuthReady(true);
      }
    });
    return () => unsub();
  }, [provisionPatientWorkspaceForUser, writeAuditLog]);

  // Subscribe to Firestore collections when user is authenticated
  useEffect(() => {
    if (!authReady || !user) return;

    const mapPatientDoc = (d: { id: string; data: () => Record<string, unknown> }): PatientRecord => {
      const data = d.data();
      return {
        patientId: String(data.patientId ?? d.id),
        ownerUid: String(data.ownerUid ?? user.uid),
        displayName: String(data.displayName ?? "Patient"),
        ageGroup: data.ageGroup ? String(data.ageGroup) : undefined,
        baselineStatus: (data.baselineStatus as PatientRecord["baselineStatus"]) ?? "not_started",
        baselineSamplesCount: Number(data.baselineSamplesCount ?? 0),
        baselineHeartRateMean:
          typeof data.baselineHeartRateMean === "number" ? data.baselineHeartRateMean : undefined,
        baselineSpo2Mean:
          typeof data.baselineSpo2Mean === "number" ? data.baselineSpo2Mean : undefined,
        baselineTempMean:
          typeof data.baselineTempMean === "number" ? data.baselineTempMean : undefined,
        baselineSource: data.baselineSource ? (String(data.baselineSource) as TelemetrySource) : undefined,
        baselineModelTrained:
          typeof data.baselineModelTrained === "boolean" ? data.baselineModelTrained : undefined,
        baselineModelVersion: data.baselineModelVersion ? String(data.baselineModelVersion) : undefined,
        baselineEcgBpmMean:
          typeof data.baselineEcgBpmMean === "number" ? data.baselineEcgBpmMean : undefined,
        baselineActiveHrMean:
          typeof data.baselineActiveHrMean === "number" ? data.baselineActiveHrMean : undefined,
        primaryCaregiverUid: data.primaryCaregiverUid ? String(data.primaryCaregiverUid) : undefined,
        secondaryCaregiverUid: data.secondaryCaregiverUid
          ? String(data.secondaryCaregiverUid)
          : undefined,
        primaryCaregiverName: data.primaryCaregiverName ? String(data.primaryCaregiverName) : undefined,
        secondaryCaregiverName: data.secondaryCaregiverName
          ? String(data.secondaryCaregiverName)
          : undefined,
        dataMode: data.dataMode === "live" ? "live" : "sample",
        createdAt: tsToIso(data.createdAt),
        updatedAt: tsToIso(data.updatedAt),
      };
    };

    const ownedMap = new Map<string, PatientRecord>();
    const cgPrimaryMap = new Map<string, PatientRecord>();
    const cgSecondaryMap = new Map<string, PatientRecord>();
    const syncMergedPatients = () => {
      const merged = new Map<string, PatientRecord>([
        ...ownedMap,
        ...cgPrimaryMap,
        ...cgSecondaryMap,
      ]);
      const list = Array.from(merged.values());
      setFirestorePatients(list);
      if (list.length > 0 && !list.some((p) => p.patientId === selectedPatientId)) {
        setSelectedPatientId(list[0].patientId);
      }
    };

    const patientsQuery = isAdminUser
      ? query(collection(db, "patients"), limit(50))
      : query(collection(db, "patients"), where("ownerUid", "==", user.uid), limit(25));

    const unsubPatients = onSnapshot(
      patientsQuery,
      (snap) => {
        ownedMap.clear();
        for (const d of snap.docs) {
          const rec = mapPatientDoc(d);
          ownedMap.set(rec.patientId, rec);
        }
        syncMergedPatients();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "patients")
    );

    const unsubCaregiverPrimaryPatients = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "patients"), where("primaryCaregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgPrimaryMap.clear();
            for (const d of snap.docs) {
              const rec = mapPatientDoc(d);
              cgPrimaryMap.set(rec.patientId, rec);
            }
            syncMergedPatients();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "patients")
        );

    const unsubCaregiverSecondaryPatients = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "patients"), where("secondaryCaregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgSecondaryMap.clear();
            for (const d of snap.docs) {
              const rec = mapPatientDoc(d);
              cgSecondaryMap.set(rec.patientId, rec);
            }
            syncMergedPatients();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "patients")
        );

    const mapDeviceDoc = (d: { id: string; data: () => Record<string, unknown> }): WearableDevice => {
      const data = d.data();
      const rawAvail =
        data.sensorAvailability && typeof data.sensorAvailability === "object"
          ? (data.sensorAvailability as Partial<SensorAvailabilityMap>)
          : undefined;
      const rawSummary =
        data.lastReadingSummary && typeof data.lastReadingSummary === "object"
          ? (data.lastReadingSummary as LastReadingSummary)
          : undefined;
      return {
        deviceId: String(data.deviceId ?? d.id),
        label: String(data.label ?? "ESP32 Node"),
        patientId: String(data.patientId ?? ""),
        ownerUid: String(data.ownerUid ?? ""),
        boardType: String(data.boardType ?? "ESP32"),
        pulseOxChipVariant: String(data.pulseOxChipVariant ?? "MAX30102 / MAX30100"),
        ecgSensor: data.ecgSensor ? String(data.ecgSensor) : "AD8232 Provisional ECG",
        imuSensor: String(data.imuSensor ?? "MPU6050"),
        tempSensor: String(data.tempSensor ?? "Configurable (Pending Confirmation)"),
        displayModule: String(data.displayModule ?? "0.96-inch SSD1306 OLED (128x64)"),
        hapticModule: String(data.hapticModule ?? "Vibration Motor (Transistor/MOSFET Driver)"),
        samplingIntervalMs: Number(data.samplingIntervalMs ?? 2000),
        connectionStatus: (data.connectionStatus as WearableDevice["connectionStatus"]) ?? "not_connected",
        lastSeenAt: data.lastSeenAt ? String(data.lastSeenAt) : undefined,
        lastDataSource:
          data.lastDataSource === "esp32_hardware" || data.lastDataSource === "simulator"
            ? data.lastDataSource
            : "none",
        sensorAvailability: rawAvail
          ? {
              pulseOximeter: Boolean(rawAvail.pulseOximeter),
              temperature: Boolean(rawAvail.temperature),
              imu: Boolean(rawAvail.imu),
              ecg: Boolean(rawAvail.ecg),
              oled: rawAvail.oled !== false,
              vibrationMotor: rawAvail.vibrationMotor !== false,
            }
          : undefined,
        lastReadingSummary: rawSummary,
        firmwareVersion: String(data.firmwareVersion ?? "arova-esp32-v3.0"),
        createdAt: tsToIso(data.createdAt),
        updatedAt: tsToIso(data.updatedAt),
      };
    };

    const ownedDevicesMap = new Map<string, WearableDevice>();
    const cgDevicesMap = new Map<string, WearableDevice>();
    const syncDevices = () => {
      setFirestoreDevices(Array.from(new Map([...ownedDevicesMap, ...cgDevicesMap]).values()));
    };

    const devicesQuery = isAdminUser
      ? query(collection(db, "devices"), limit(50))
      : query(collection(db, "devices"), where("ownerUid", "==", user.uid), limit(25));

    const unsubDevices = onSnapshot(
      devicesQuery,
      (snap) => {
        ownedDevicesMap.clear();
        for (const d of snap.docs) {
          const rec = mapDeviceDoc(d);
          ownedDevicesMap.set(rec.deviceId, rec);
        }
        syncDevices();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "devices")
    );

    const unsubCareDevices = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "devices"), where("primaryCaregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgDevicesMap.clear();
            for (const d of snap.docs) {
              const rec = mapDeviceDoc(d);
              cgDevicesMap.set(rec.deviceId, rec);
            }
            syncDevices();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "devices")
        );

    const mapCareLinkDoc = (d: { id: string; data: () => Record<string, unknown> }): CareLink => {
      const data = d.data();
      return {
        linkId: String(data.linkId ?? d.id),
        patientId: String(data.patientId ?? ""),
        patientName: String(data.patientName ?? ""),
        patientOwnerUid: String(data.patientOwnerUid ?? ""),
        caregiverUid: String(data.caregiverUid ?? ""),
        caregiverName: String(data.caregiverName ?? ""),
        priority: data.priority === "secondary" ? "secondary" : "primary",
        status: (data.status as CareLink["status"]) ?? "active",
        relationship: data.relationship ? String(data.relationship) : undefined,
        permissions:
          data.permissions && typeof data.permissions === "object"
            ? (data.permissions as CarePermissions)
            : undefined,
        createdAt: tsToIso(data.createdAt),
        updatedAt: tsToIso(data.updatedAt),
      };
    };

    const ownerCareMap = new Map<string, CareLink>();
    const cgCareMap = new Map<string, CareLink>();
    const syncCareLinks = () => {
      setFirestoreCareLinks(Array.from(new Map([...ownerCareMap, ...cgCareMap]).values()));
    };

    const careQuery = isAdminUser
      ? query(collection(db, "careLinks"), limit(50))
      : query(collection(db, "careLinks"), where("patientOwnerUid", "==", user.uid), limit(25));

    const unsubCare = onSnapshot(
      careQuery,
      (snap) => {
        ownerCareMap.clear();
        for (const d of snap.docs) {
          const rec = mapCareLinkDoc(d);
          ownerCareMap.set(rec.linkId, rec);
        }
        syncCareLinks();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "careLinks")
    );

    const unsubCareAsCaregiver = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "careLinks"), where("caregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgCareMap.clear();
            for (const d of snap.docs) {
              const rec = mapCareLinkDoc(d);
              cgCareMap.set(rec.linkId, rec);
            }
            syncCareLinks();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "careLinks")
        );

    const unsubSettings = onSnapshot(
      doc(db, "systemSettings", "global"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const storedAlertLevels =
            data.alertLevels && typeof data.alertLevels === "object"
              ? (data.alertLevels as AlertLevelsPolicyConfig)
              : undefined;
          setSystemSettings({
            settingId: "global",
            escalationTimeoutSec: Number(data.escalationTimeoutSec ?? 30),
            baselineMinSamples: Number(data.baselineMinSamples ?? 20),
            samplingDefaultMs: Number(data.samplingDefaultMs ?? 2000),
            warningPersistenceWindows: Number(data.warningPersistenceWindows ?? 2),
            criticalPersistenceWindows: Number(data.criticalPersistenceWindows ?? 3),
            anomalyScoreThreshold: Number(data.anomalyScoreThreshold ?? -0.05),
            retryIntervalSec:
              typeof data.retryIntervalSec === "number" ? data.retryIntervalSec : 30,
            maxCallAttempts:
              typeof data.maxCallAttempts === "number" ? data.maxCallAttempts : 2,
            fallbackNotificationEnabled:
              typeof data.fallbackNotificationEnabled === "boolean"
                ? data.fallbackNotificationEnabled
                : true,
            alertLevels: storedAlertLevels,
            updatedByUid: String(data.updatedByUid ?? ""),
            updatedAt: tsToIso(data.updatedAt),
          });
          if (storedAlertLevels?.levels?.Low && storedAlertLevels?.levels?.Medium && storedAlertLevels?.levels?.High) {
            setAlertLevelsPolicy(storedAlertLevels);
          }
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, "systemSettings/global")
    );

    const unsubUsers = isAdminUser
      ? onSnapshot(
          query(collection(db, "users"), limit(100)),
          (snap) => {
            setFirestoreUsers(
              snap.docs.map((d) => {
                const data = d.data();
                return {
                  uid: String(data.uid ?? d.id),
                  displayName: String(data.displayName ?? "User"),
                  role: (data.role as UserRole) ?? "patient",
                  accountStatus: data.accountStatus === "suspended" ? "suspended" : "active",
                  profileSettings:
                    data.profileSettings && typeof data.profileSettings === "object"
                      ? (data.profileSettings as UserProfileSettings)
                      : undefined,
                  createdAt: tsToIso(data.createdAt),
                  updatedAt: tsToIso(data.updatedAt),
                };
              })
            );
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "users")
        )
      : () => {};

    const mapBaselineDoc = (d: { id: string; data: () => Record<string, unknown> }): BaselineRecord => {
      const data = d.data();
      return {
        baselineId: String(data.baselineId ?? d.id),
        patientId: String(data.patientId ?? ""),
        ownerUid: String(data.ownerUid ?? ""),
        primaryCaregiverUid: data.primaryCaregiverUid ? String(data.primaryCaregiverUid) : undefined,
        secondaryCaregiverUid: data.secondaryCaregiverUid
          ? String(data.secondaryCaregiverUid)
          : undefined,
        source: (data.source as BaselineRecord["source"]) ?? "simulator",
        learningStatus: (data.learningStatus as BaselineRecord["learningStatus"]) ?? "not_started",
        featureStatistics:
          data.featureStatistics && typeof data.featureStatistics === "object"
            ? (data.featureStatistics as BaselineRecord["featureStatistics"])
            : {},
        modelVersion: data.modelVersion ? String(data.modelVersion) : undefined,
        createdAt: tsToIso(data.createdAt),
        updatedAt: tsToIso(data.updatedAt),
      };
    };

    const ownedBaselinesMap = new Map<string, BaselineRecord>();
    const cgPrimaryBaselinesMap = new Map<string, BaselineRecord>();
    const cgSecondaryBaselinesMap = new Map<string, BaselineRecord>();
    const syncMergedBaselines = () => {
      const merged = new Map<string, BaselineRecord>();
      for (const [k, v] of cgSecondaryBaselinesMap) merged.set(k, v);
      for (const [k, v] of cgPrimaryBaselinesMap) merged.set(k, v);
      for (const [k, v] of ownedBaselinesMap) merged.set(k, v);
      setFirestoreBaselines(Array.from(merged.values()));
    };

    const unsubBaselines = onSnapshot(
      isAdminUser
        ? query(collection(db, "baselines"), limit(50))
        : query(collection(db, "baselines"), where("ownerUid", "==", user.uid), limit(25)),
      (snap) => {
        ownedBaselinesMap.clear();
        for (const d of snap.docs) {
          const rec = mapBaselineDoc(d);
          ownedBaselinesMap.set(rec.baselineId, rec);
        }
        syncMergedBaselines();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "baselines")
    );

    const unsubCaregiverPrimaryBaselines = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "baselines"), where("primaryCaregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgPrimaryBaselinesMap.clear();
            for (const d of snap.docs) {
              const rec = mapBaselineDoc(d);
              cgPrimaryBaselinesMap.set(rec.baselineId, rec);
            }
            syncMergedBaselines();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "baselines")
        );

    const unsubCaregiverSecondaryBaselines = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "baselines"), where("secondaryCaregiverUid", "==", user.uid), limit(25)),
          (snap) => {
            cgSecondaryBaselinesMap.clear();
            for (const d of snap.docs) {
              const rec = mapBaselineDoc(d);
              cgSecondaryBaselinesMap.set(rec.baselineId, rec);
            }
            syncMergedBaselines();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "baselines")
        );

    const mapAnomalyEventDoc = (d: {
      id: string;
      data: () => Record<string, unknown>;
    }): AnomalyEventRecord => {
      const data = d.data();
      return {
        eventId: String(data.eventId ?? d.id),
        patientId: String(data.patientId ?? ""),
        ownerUid: String(data.ownerUid ?? ""),
        primaryCaregiverUid: data.primaryCaregiverUid ? String(data.primaryCaregiverUid) : undefined,
        secondaryCaregiverUid: data.secondaryCaregiverUid
          ? String(data.secondaryCaregiverUid)
          : undefined,
        anomalyScore: Number(data.anomalyScore ?? 0),
        alertLevel: (data.alertLevel as AnomalyEventRecord["alertLevel"]) ?? "Normal",
        featureSummary: String(data.featureSummary ?? ""),
        contributingFeatures: Array.isArray(data.contributingFeatures)
          ? data.contributingFeatures.map(String)
          : undefined,
        modelVersion: data.modelVersion ? String(data.modelVersion) : undefined,
        source: (data.source as AnomalyEventRecord["source"]) ?? "simulator",
        createdAt: tsToIso(data.createdAt),
      };
    };

    const ownedEventsMap = new Map<string, AnomalyEventRecord>();
    const cgPrimaryEventsMap = new Map<string, AnomalyEventRecord>();
    const cgSecondaryEventsMap = new Map<string, AnomalyEventRecord>();
    const syncMergedAnomalyEvents = () => {
      const merged = new Map<string, AnomalyEventRecord>();
      for (const [k, v] of cgSecondaryEventsMap) merged.set(k, v);
      for (const [k, v] of cgPrimaryEventsMap) merged.set(k, v);
      for (const [k, v] of ownedEventsMap) merged.set(k, v);
      setFirestoreAnomalyEvents(
        Array.from(merged.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      );
    };

    const unsubAnomalyEvents = onSnapshot(
      isAdminUser
        ? query(collection(db, "anomaly_events"), limit(50))
        : query(collection(db, "anomaly_events"), where("ownerUid", "==", user.uid), limit(30)),
      (snap) => {
        ownedEventsMap.clear();
        for (const d of snap.docs) {
          const rec = mapAnomalyEventDoc(d);
          ownedEventsMap.set(rec.eventId, rec);
        }
        syncMergedAnomalyEvents();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "anomaly_events")
    );

    const unsubCaregiverPrimaryAnomalyEvents = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "anomaly_events"), where("primaryCaregiverUid", "==", user.uid), limit(30)),
          (snap) => {
            cgPrimaryEventsMap.clear();
            for (const d of snap.docs) {
              const rec = mapAnomalyEventDoc(d);
              cgPrimaryEventsMap.set(rec.eventId, rec);
            }
            syncMergedAnomalyEvents();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "anomaly_events")
        );

    const unsubCaregiverSecondaryAnomalyEvents = isAdminUser
      ? () => {}
      : onSnapshot(
          query(collection(db, "anomaly_events"), where("secondaryCaregiverUid", "==", user.uid), limit(30)),
          (snap) => {
            cgSecondaryEventsMap.clear();
            for (const d of snap.docs) {
              const rec = mapAnomalyEventDoc(d);
              cgSecondaryEventsMap.set(rec.eventId, rec);
            }
            syncMergedAnomalyEvents();
          },
          (err) => handleFirestoreError(err, OperationType.LIST, "anomaly_events")
        );

    const unsubAuditLogs = onSnapshot(
      isAdminUser
        ? query(collection(db, "audit_logs"), limit(60))
        : query(collection(db, "audit_logs"), where("userId", "==", user.uid), limit(30)),
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              logId: String(data.logId ?? d.id),
              userId: String(data.userId ?? ""),
              actorRole: (data.actorRole as UserRole) ?? "patient",
              eventType: String(data.eventType ?? "event"),
              summary: String(data.summary ?? ""),
              targetId: data.targetId ? String(data.targetId) : undefined,
              createdAt: tsToIso(data.createdAt),
            };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setFirestoreAuditLogs(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "audit_logs")
    );

    if (isAdminUser) {
      void fetchBackendAuditLogs(50).then(setBackendAuditLogs).catch(() => {});
    }

    return () => {
      unsubPatients();
      unsubCaregiverPrimaryPatients();
      unsubCaregiverSecondaryPatients();
      unsubDevices();
      unsubCareDevices();
      unsubCare();
      unsubCareAsCaregiver();
      unsubSettings();
      unsubUsers();
      unsubBaselines();
      unsubCaregiverPrimaryBaselines();
      unsubCaregiverSecondaryBaselines();
      unsubAnomalyEvents();
      unsubCaregiverPrimaryAnomalyEvents();
      unsubCaregiverSecondaryAnomalyEvents();
      unsubAuditLogs();
    };
  }, [authReady, user, isAdminUser]);

  // Subscribe to readings & alerts for active Firestore patient
  useEffect(() => {
    if (!authReady || !user) return;
    const isFirestorePatient = firestorePatients.some((p) => p.patientId === selectedPatientId);
    if (!isFirestorePatient) {
      setFirestoreReadings([]);
      setFirestoreAlerts([]);
      setFirestoreFallEvents([]);
      return;
    }

    const activePt = firestorePatients.find((p) => p.patientId === selectedPatientId);
    const scopeField =
      activePt?.primaryCaregiverUid === user.uid && activePt.ownerUid !== user.uid
        ? "primaryCaregiverUid"
        : activePt?.secondaryCaregiverUid === user.uid && activePt.ownerUid !== user.uid
        ? "secondaryCaregiverUid"
        : "ownerUid";

    const readingsRef = collection(db, "patients", selectedPatientId, "readings");
    const readingsQuery = isAdminUser
      ? query(readingsRef, orderBy("createdAt", "desc"), limit(40))
      : query(
          readingsRef,
          where(scopeField, "==", user.uid),
          orderBy("createdAt", "desc"),
          limit(40)
        );

    const unsubReadings = onSnapshot(
      readingsQuery,
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              readingId: String(data.readingId ?? d.id),
              patientId: String(data.patientId ?? selectedPatientId),
              ownerUid: String(data.ownerUid ?? user.uid),
              deviceId: data.deviceId ? String(data.deviceId) : undefined,
              heartRate: typeof data.heartRate === "number" ? data.heartRate : null,
              spo2: typeof data.spo2 === "number" ? data.spo2 : null,
              temperatureC: typeof data.temperatureC === "number" ? data.temperatureC : null,
              movementStatus: data.movementStatus ?? "resting",
              accelMagnitude: typeof data.accelMagnitude === "number" ? data.accelMagnitude : 1.0,
              gyroMagnitude: typeof data.gyroMagnitude === "number" ? data.gyroMagnitude : 3.0,
              accelX: typeof data.accelX === "number" ? data.accelX : null,
              accelY: typeof data.accelY === "number" ? data.accelY : null,
              accelZ: typeof data.accelZ === "number" ? data.accelZ : null,
              gyroX: typeof data.gyroX === "number" ? data.gyroX : null,
              gyroY: typeof data.gyroY === "number" ? data.gyroY : null,
              gyroZ: typeof data.gyroZ === "number" ? data.gyroZ : null,
              possibleFallDetected: Boolean(data.possibleFallDetected),
              ecgSamples: Array.isArray(data.ecgSamples) ? data.ecgSamples.map(Number) : undefined,
              ecgSamplingRate: typeof data.ecgSamplingRate === "number" ? data.ecgSamplingRate : undefined,
              ecgSignalQuality: data.ecgSignalQuality as EcgSignalQuality | undefined,
              ecgLeadOff: typeof data.ecgLeadOff === "boolean" ? data.ecgLeadOff : undefined,
              ecgTimestamp: data.ecgTimestamp ? String(data.ecgTimestamp) : undefined,
              ecgHeartRateBpm: typeof data.ecgHeartRateBpm === "number" ? data.ecgHeartRateBpm : undefined,
              signalQuality: data.signalQuality ?? "good",
              anomalyStatus: data.anomalyStatus as AnomalyStatus | undefined,
              anomalyScore: Number(data.anomalyScore ?? 0),
              alertLevel: data.alertLevel ?? "Normal",
              contributingFeatures: Array.isArray(data.contributingFeatures)
                ? data.contributingFeatures.map(String)
                : undefined,
              persistenceCount:
                typeof data.persistenceCount === "number" ? data.persistenceCount : undefined,
              modelVersion: data.modelVersion ? String(data.modelVersion) : undefined,
              source: data.source ?? "simulator",
              mlEngine: data.mlEngine ?? "unconnected_rule_check",
              explanation: String(data.explanation ?? ""),
              createdAt: tsToIso(data.createdAt),
            } as VitalReading;
          })
          .reverse();
        setFirestoreReadings(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `patients/${selectedPatientId}/readings`)
    );

    const alertsRef = collection(db, "patients", selectedPatientId, "alerts");
    const alertsQuery = isAdminUser
      ? query(alertsRef, orderBy("createdAt", "desc"), limit(30))
      : query(
          alertsRef,
          where(scopeField, "==", user.uid),
          orderBy("createdAt", "desc"),
          limit(30)
        );

    const unsubAlerts = onSnapshot(
      alertsQuery,
      (snap) => {
        setFirestoreAlerts(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              alertId: String(data.alertId ?? d.id),
              patientId: String(data.patientId ?? selectedPatientId),
              ownerUid: String(data.ownerUid ?? user.uid),
              level: data.level === "Critical" ? "Critical" : "Warning",
              status: data.status ?? "active",
              title: String(data.title ?? "Alert"),
              explanation: String(data.explanation ?? ""),
              triggeredMetrics: Array.isArray(data.triggeredMetrics)
                ? data.triggeredMetrics.map(String)
                : [],
              source: data.source ?? "simulator",
              prototypeNotice: data.prototypeNotice ? String(data.prototypeNotice) : undefined,
              anomalyScore: typeof data.anomalyScore === "number" ? data.anomalyScore : undefined,
              relevantReadingsSummary: data.relevantReadingsSummary
                ? String(data.relevantReadingsSummary)
                : undefined,
              patientAcknowledged:
                typeof data.patientAcknowledged === "boolean"
                  ? data.patientAcknowledged
                  : undefined,
              falseAlertReported:
                typeof data.falseAlertReported === "boolean" ? data.falseAlertReported : undefined,
              falseAlertReason: data.falseAlertReason ? String(data.falseAlertReason) : undefined,
              unreadByPatient:
                typeof data.unreadByPatient === "boolean" ? data.unreadByPatient : undefined,
              unreadByCaregiver:
                typeof data.unreadByCaregiver === "boolean" ? data.unreadByCaregiver : undefined,
              notificationStatus: data.notificationStatus as AlertRecord["notificationStatus"],
              escalationStatus: data.escalationStatus ? String(data.escalationStatus) : undefined,
              acknowledgedByUid: data.acknowledgedByUid ? String(data.acknowledgedByUid) : undefined,
              acknowledgedByName: data.acknowledgedByName
                ? String(data.acknowledgedByName)
                : undefined,
              followUpAction: data.followUpAction ? String(data.followUpAction) : undefined,
              callEscalationStatus: data.callEscalationStatus ?? "not_triggered",
              callLog: Array.isArray(data.callLog) ? data.callLog.map(String) : [],
              createdAt: tsToIso(data.createdAt),
              updatedAt: tsToIso(data.updatedAt),
            } as AlertRecord;
          })
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `patients/${selectedPatientId}/alerts`)
    );

    const fallEventsRef = collection(db, "patients", selectedPatientId, "fallEvents");
    const fallEventsQuery = isAdminUser
      ? query(fallEventsRef, orderBy("createdAt", "desc"), limit(25))
      : query(
          fallEventsRef,
          where(scopeField, "==", user.uid),
          orderBy("createdAt", "desc"),
          limit(25)
        );

    const unsubFallEvents = onSnapshot(
      fallEventsQuery,
      (snap) => {
        setFirestoreFallEvents(
          snap.docs.map((d) => {
            const data = d.data();
            const rawLoc =
              data.location && typeof data.location === "object"
                ? (data.location as FallDetectionLocation)
                : null;
            const matchingPt = firestorePatients.find(
              (p) => p.patientId === String(data.patientId ?? selectedPatientId)
            );
            return {
              eventId: String(data.eventId ?? d.id),
              alertId: String(data.alertId ?? ""),
              patientId: String(data.patientId ?? selectedPatientId),
              ownerUid: String(data.ownerUid ?? user.uid),
              patientName: String(data.patientName ?? matchingPt?.displayName ?? "Patient"),
              primaryCaregiverUid: data.primaryCaregiverUid
                ? String(data.primaryCaregiverUid)
                : undefined,
              secondaryCaregiverUid: data.secondaryCaregiverUid
                ? String(data.secondaryCaregiverUid)
                : undefined,
              detectionMode:
                data.detectionMode === "demo_simulation" ? "demo_simulation" : "webcam_pose",
              isSimulated: Boolean(data.isSimulated ?? data.detectionMode === "demo_simulation"),
              state:
                data.state === "Possible Fall" || data.state === "Warning" ? data.state : "Normal",
              status:
                (data.status as FallDetectionEventRecord["status"]) ?? "pending_confirmation",
              reason: String(data.reason ?? ""),
              confidence: Number(data.confidence ?? 0.5),
              torsoAngleDeg: Number(data.torsoAngleDeg ?? 0),
              verticalVelocity: Number(data.verticalVelocity ?? 0),
              horizontalDurationSec: Number(data.horizontalDurationSec ?? 0),
              peopleCount: Number(data.peopleCount ?? 1),
              sensorFusionStatus:
                (data.sensorFusionStatus as FallSensorFusionStatus) ?? "webcam_only",
              wearableSummary: data.wearableSummary ? String(data.wearableSummary) : undefined,
              location: rawLoc,
              confirmationDeadlineAt: data.confirmationDeadlineAt
                ? String(data.confirmationDeadlineAt)
                : new Date(new Date(tsToIso(data.createdAt)).getTime() + 20_000).toISOString(),
              detectedAt: data.detectedAt ? String(data.detectedAt) : tsToIso(data.createdAt),
              updatedAt: tsToIso(data.updatedAt),
              cancelledBy: data.cancelledBy ? String(data.cancelledBy) : undefined,
              cancellationReason: data.cancellationReason
                ? String(data.cancellationReason)
                : undefined,
              escalatedAt: data.escalatedAt ? String(data.escalatedAt) : undefined,
              acknowledgedBy: data.acknowledgedBy ? String(data.acknowledgedBy) : undefined,
              resolvedAt: data.resolvedAt ? String(data.resolvedAt) : undefined,
            } as FallDetectionEventRecord;
          })
        );
      },
      () => {
        // Non-fatal if composite index is still syncing
      }
    );

    return () => {
      unsubReadings();
      unsubAlerts();
      unsubFallEvents();
    };
  }, [authReady, user, isAdminUser, selectedPatientId, firestorePatients]);

  const isStrictFirestoreRole = Boolean(
    user && (assignedRole === "caregiver" || assignedRole === "admin" || isAdminUser)
  );
  const hasFirestoreWorkspace = Boolean(user && firestorePatients.length > 0);
  const usingSampleData = user ? (isStrictFirestoreRole ? false : !hasFirestoreWorkspace) : true;

  const patients = useMemo(() => {
    if (!usingSampleData) return firestorePatients;
    return samplePatients;
  }, [usingSampleData, firestorePatients, samplePatients]);

  const selectedPatient = useMemo(
    () =>
      patients.find((p) => p.patientId === selectedPatientId) ??
      patients[0] ??
      EMPTY_PLACEHOLDER_PATIENT,
    [patients, selectedPatientId]
  );

  const readings = useMemo(() => {
    if (!usingSampleData) return firestoreReadings;
    return sampleReadingsMap[selectedPatient.patientId] ?? [];
  }, [usingSampleData, firestoreReadings, sampleReadingsMap, selectedPatient.patientId]);

  const alerts = useMemo(() => {
    const baseAlerts = !usingSampleData ? firestoreAlerts : sampleAlerts;
    const merged = new Map<string, AlertRecord>();
    for (const a of backendAlerts) {
      merged.set(a.alertId, a);
    }
    for (const a of baseAlerts) {
      const existing = merged.get(a.alertId);
      merged.set(a.alertId, existing ? { ...existing, ...a, escalationHistory: existing.escalationHistory ?? a.escalationHistory, notificationAttempts: existing.notificationAttempts ?? a.notificationAttempts, relevantReadings: existing.relevantReadings ?? a.relevantReadings, suppressedOccurrences: existing.suppressedOccurrences ?? a.suppressedOccurrences } : a);
    }
    return Array.from(merged.values()).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }, [usingSampleData, firestoreAlerts, sampleAlerts, backendAlerts]);

  const fallEvents = useMemo(() => {
    const baseEvents = !usingSampleData ? firestoreFallEvents : sampleFallEvents;
    const merged = new Map<string, FallDetectionEventRecord>();
    for (const evt of backendFallEvents) {
      merged.set(evt.eventId, evt);
    }
    for (const evt of baseEvents) {
      const existing = merged.get(evt.eventId);
      merged.set(evt.eventId, existing ? { ...evt, ...existing } : evt);
    }
    return Array.from(merged.values()).sort((a, b) => (b.detectedAt > a.detectedAt ? 1 : -1));
  }, [usingSampleData, firestoreFallEvents, sampleFallEvents, backendFallEvents]);

  const activeEmergencyFallEvent = useMemo(() => {
    return (
      fallEvents.find(
        (evt) =>
          evt.patientId === selectedPatient.patientId &&
          evt.state === "Possible Fall" &&
          (evt.status === "pending_confirmation" ||
            (evt.status === "escalated" && !dismissedFallEventIds.includes(evt.eventId)))
      ) ?? null
    );
  }, [fallEvents, selectedPatient.patientId, dismissedFallEventIds]);

  const devices = !usingSampleData ? firestoreDevices : sampleDevices;
  const careLinks = !usingSampleData ? firestoreCareLinks : sampleCareLinks;

  const refreshPhase5Notifications = useCallback(async () => {
    try {
      const targetPtId =
        selectedPatient.patientId && selectedPatient.patientId !== "unassigned_patient"
          ? selectedPatient.patientId
          : undefined;
      const [res, fallRes] = await Promise.all([
        fetchPhase5Notifications({ patientId: targetPtId }),
        fetchFallDetectionEvents(targetPtId).catch(() => ({ events: [], stats: null })),
      ]);
      setBackendAlerts(res.alerts);
      setNotifications(res.notifications);
      setNotificationConfig(res.config);
      setNotificationProviders(res.providers);
      if (fallRes.events.length > 0 || backendFallEvents.length > 0) {
        setBackendFallEvents(fallRes.events);
      }
      if (fallRes.stats) {
        setFallDetectionStats(fallRes.stats);
      }

      if (user && isAdminUser) {
        try {
          const statsRes = await fetchAdminNotificationStats();
          setAdminAlertStats(statsRes.stats);
          setNotificationErrorLogs(statsRes.errorLogs);
          if (statsRes.stats.fallDetectionStats) {
            setFallDetectionStats(statsRes.stats.fallDetectionStats);
          }
        } catch {
          // Non-fatal if user is not admin
        }
      }
    } catch {
      try {
        const cfg = await fetchNotificationConfig();
        setNotificationConfig(cfg.config);
        setNotificationProviders(cfg.providers);
      } catch {
        // Non-fatal offline fallback
      }
    }
  }, [selectedPatient.patientId, user, isAdminUser, backendFallEvents.length]);

  useEffect(() => {
    if (!authReady) return;
    void refreshPhase5Notifications();
    const hasPendingFall = fallEvents.some(
      (evt) =>
        evt.patientId === selectedPatient.patientId && evt.status === "pending_confirmation"
    );
    const timer = setInterval(
      () => void refreshPhase5Notifications(),
      hasPendingFall ? 1500 : 5000
    );
    return () => clearInterval(timer);
  }, [authReady, refreshPhase5Notifications, fallEvents, selectedPatient.patientId]);

  useEffect(() => {
    if (!authReady || !user || firestoreCareLinks.length === 0) return;
    void syncBackendCareLinks(firestoreCareLinks);
  }, [authReady, user, firestoreCareLinks]);

  const unreadNotificationCount = useMemo(() => {
    const roleFilter = activeRole === "caregiver" ? "caregiver" : activeRole === "patient" ? "patient" : null;
    const notifUnread = notifications.filter((n) => {
      if (n.read) return false;
      if (roleFilter && n.recipientRole !== roleFilter) return false;
      return true;
    }).length;
    if (notifUnread > 0) return notifUnread;
    return alerts.filter((a) => {
      if (a.status === "resolved") return false;
      if (activeRole === "patient") return a.unreadByPatient ?? !a.patientAcknowledged;
      return a.unreadByCaregiver ?? a.status === "active";
    }).length;
  }, [notifications, alerts, activeRole]);
  const registeredUsers: UserProfile[] = useMemo(() => {
    if (user && firestoreUsers.length > 0) return firestoreUsers;
    if (user) {
      return [
        userProfile ?? {
          uid: user.uid,
          displayName: user.displayName || user.email || "Current User",
          role: assignedRole ?? activeRole,
          accountStatus: "active",
        },
      ];
    }
    return [];
  }, [user, firestoreUsers, userProfile, assignedRole, activeRole]);

  const auditLogs: SystemAuditLog[] = useMemo(() => {
    const merged = new Map<string, SystemAuditLog>();
    for (const item of firestoreAuditLogs) merged.set(item.logId, item);
    for (const item of backendAuditLogs) merged.set(item.logId, item);
    return Array.from(merged.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [firestoreAuditLogs, backendAuditLogs]);

  const refreshBackendDevices = useCallback(async () => {
    if (!user) {
      setRegisteredBackendDevices([]);
      return;
    }
    try {
      const list = await fetchRegisteredWearableDevices();
      setRegisteredBackendDevices(list);
    } catch {
      // Keep prior list
    }
  }, [user]);

  useEffect(() => {
    if (authReady && user) {
      void refreshBackendDevices();
    } else {
      setRegisteredBackendDevices([]);
    }
  }, [authReady, user, refreshBackendDevices]);

  // Poll /api/wearable/latest & sync live ESP32 hardware packets securely into Firestore
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetchLatestHardwareEvents(selectedPatient.patientId);
        if (!active) return;
        setServerEcgHistory(Array.isArray(res.ecgHistory) ? res.ecgHistory : []);

        try {
          const bStatus = await fetchPatientBaselineStatus(
            selectedPatient.patientId,
            systemSettings.baselineMinSamples
          );
          if (active) setBaselineStatusSummary(bStatus);
        } catch {
          // Non-fatal
        }

        const snap = res.snapshot;
        if (!snap || snap.source !== "esp32_hardware") {
          setLiveHardwareSnapshot(null);
          return;
        }
        const receivedAt = String(snap.receivedAt ?? "");
        const ageMs = Date.now() - new Date(receivedAt).getTime();
        if (Number.isFinite(ageMs) && ageMs <= 30_000) {
          const features = (snap.ecgFeatures ?? {}) as { estimatedEcgBpm?: number | null };
          const snapDeviceId = snap.deviceId
            ? sanitizeId(String(snap.deviceId), "esp32")
            : devices.find((d) => d.patientId === selectedPatient.patientId)?.deviceId ?? "esp32_node_01";
          const readingId = sanitizeId(`hw_${receivedAt}_${snapDeviceId}`, "hw");
          const boundedEcg = Array.isArray(snap.ecgSamples)
            ? snap.ecgSamples.map(Number).slice(0, VALIDATION_LIMITS.MAX_ECG_BATCH)
            : undefined;
          const snapAvail =
            snap.sensorAvailability && typeof snap.sensorAvailability === "object"
              ? (snap.sensorAvailability as SensorAvailabilityMap)
              : undefined;

          const liveReading: VitalReading = {
            readingId,
            patientId: String(snap.patientId ?? selectedPatient.patientId),
            ownerUid: selectedPatient.ownerUid,
            deviceId: snapDeviceId,
            heartRate: typeof snap.heartRate === "number" ? snap.heartRate : null,
            spo2: typeof snap.spo2 === "number" ? snap.spo2 : null,
            temperatureC: typeof snap.temperatureC === "number" ? snap.temperatureC : null,
            movementStatus: (snap.movementStatus as MovementStatus) ?? "resting",
            accelMagnitude: Number(snap.accelMagnitude ?? 1),
            gyroMagnitude: Number(snap.gyroMagnitude ?? 0),
            accelX: typeof snap.accelX === "number" ? snap.accelX : null,
            accelY: typeof snap.accelY === "number" ? snap.accelY : null,
            accelZ: typeof snap.accelZ === "number" ? snap.accelZ : null,
            gyroX: typeof snap.gyroX === "number" ? snap.gyroX : null,
            gyroY: typeof snap.gyroY === "number" ? snap.gyroY : null,
            gyroZ: typeof snap.gyroZ === "number" ? snap.gyroZ : null,
            possibleFallDetected: Boolean(snap.possibleFallDetected),
            ecgSamples: boundedEcg,
            ecgSamplingRate: typeof snap.ecgSamplingRate === "number" ? snap.ecgSamplingRate : undefined,
            ecgSignalQuality: (snap.ecgSignalQuality as EcgSignalQuality) ?? "unavailable",
            ecgLeadOff: Boolean(snap.ecgLeadOff),
            ecgTimestamp: snap.ecgTimestamp ? String(snap.ecgTimestamp) : receivedAt,
            ecgHeartRateBpm:
              typeof features.estimatedEcgBpm === "number" ? features.estimatedEcgBpm : undefined,
            signalQuality: (snap.signalQuality as VitalReading["signalQuality"]) ?? "good",
            sensorAvailability: snapAvail,
            batteryPct: typeof snap.batteryPct === "number" ? snap.batteryPct : null,
            anomalyStatus: snap.anomalyStatus as AnomalyStatus | undefined,
            anomalyScore: Number(snap.anomalyScore ?? 0),
            alertLevel: (snap.alertLevel as VitalReading["alertLevel"]) ?? "Normal",
            contributingFeatures: Array.isArray(snap.contributingFeatures)
              ? snap.contributingFeatures.map(String)
              : undefined,
            persistenceCount:
              typeof snap.persistenceCount === "number" ? snap.persistenceCount : undefined,
            modelVersion: snap.modelVersion ? String(snap.modelVersion) : undefined,
            source: "esp32_hardware",
            mlEngine: (snap.mlEngine as VitalReading["mlEngine"]) ?? "unconnected_rule_check",
            explanation: String(snap.explanation ?? "ESP32 wearable packet received."),
            plainLanguageExplanations: Array.isArray(snap.plainLanguageExplanations)
              ? snap.plainLanguageExplanations.map(String).slice(0, 5)
              : undefined,
            createdAt: receivedAt,
          };

          setLiveHardwareSnapshot(liveReading);

          const dedupeKey = `${liveReading.patientId}::${receivedAt}`;
          if (lastPersistedHardwareKeyRef.current !== dedupeKey) {
            lastPersistedHardwareKeyRef.current = dedupeKey;

            const summaryPayload: LastReadingSummary = {
              heartRate: liveReading.heartRate,
              spo2: liveReading.spo2,
              temperatureC: liveReading.temperatureC,
              movementStatus: liveReading.movementStatus,
              signalQuality: liveReading.signalQuality,
              ...(typeof liveReading.accelX === "number" ? { accelX: liveReading.accelX } : {}),
              ...(typeof liveReading.accelY === "number" ? { accelY: liveReading.accelY } : {}),
              ...(typeof liveReading.accelZ === "number" ? { accelZ: liveReading.accelZ } : {}),
              timestamp: receivedAt.slice(0, 60),
            };

            if (hasFirestoreWorkspace && user && selectedPatient.ownerUid === user.uid) {
              try {
                const readingDoc: Record<string, unknown> = {
                  readingId,
                  patientId: selectedPatient.patientId,
                  ownerUid: selectedPatient.ownerUid,
                  deviceId: snapDeviceId,
                  heartRate: liveReading.heartRate,
                  spo2: liveReading.spo2,
                  temperatureC: liveReading.temperatureC,
                  movementStatus: liveReading.movementStatus,
                  accelMagnitude: liveReading.accelMagnitude,
                  gyroMagnitude: liveReading.gyroMagnitude,
                  possibleFallDetected: Boolean(liveReading.possibleFallDetected),
                  signalQuality: liveReading.signalQuality,
                  anomalyScore: liveReading.anomalyScore,
                  alertLevel: liveReading.alertLevel,
                  source: "esp32_hardware",
                  mlEngine: liveReading.mlEngine,
                  explanation: liveReading.explanation.slice(0, VALIDATION_LIMITS.MAX_EXPLANATION_LEN),
                  createdAt: serverTimestamp(),
                };
                if (typeof liveReading.accelX === "number") readingDoc.accelX = liveReading.accelX;
                if (typeof liveReading.accelY === "number") readingDoc.accelY = liveReading.accelY;
                if (typeof liveReading.accelZ === "number") readingDoc.accelZ = liveReading.accelZ;
                if (typeof liveReading.gyroX === "number") readingDoc.gyroX = liveReading.gyroX;
                if (typeof liveReading.gyroY === "number") readingDoc.gyroY = liveReading.gyroY;
                if (typeof liveReading.gyroZ === "number") readingDoc.gyroZ = liveReading.gyroZ;
                if (liveReading.anomalyStatus) readingDoc.anomalyStatus = liveReading.anomalyStatus;
                if (Array.isArray(liveReading.contributingFeatures)) {
                  readingDoc.contributingFeatures = liveReading.contributingFeatures.slice(0, 8);
                }
                if (typeof liveReading.persistenceCount === "number") {
                  readingDoc.persistenceCount = Math.max(0, Math.round(liveReading.persistenceCount));
                }
                if (liveReading.modelVersion) {
                  readingDoc.modelVersion = liveReading.modelVersion.slice(0, 80);
                }
                if (boundedEcg && boundedEcg.length > 0) {
                  readingDoc.ecgSamples = boundedEcg;
                  readingDoc.ecgSamplingRate = liveReading.ecgSamplingRate ?? 200;
                  readingDoc.ecgSignalQuality = liveReading.ecgSignalQuality ?? "good";
                  readingDoc.ecgLeadOff = Boolean(liveReading.ecgLeadOff);
                  if (liveReading.ecgTimestamp) readingDoc.ecgTimestamp = liveReading.ecgTimestamp.slice(0, 60);
                  if (typeof liveReading.ecgHeartRateBpm === "number") {
                    readingDoc.ecgHeartRateBpm = liveReading.ecgHeartRateBpm;
                  }
                } else if (liveReading.ecgLeadOff) {
                  readingDoc.ecgLeadOff = true;
                  readingDoc.ecgSignalQuality = "lead_off";
                }
                if (selectedPatient.primaryCaregiverUid) {
                  readingDoc.primaryCaregiverUid = selectedPatient.primaryCaregiverUid;
                }
                if (selectedPatient.secondaryCaregiverUid) {
                  readingDoc.secondaryCaregiverUid = selectedPatient.secondaryCaregiverUid;
                }
                await setDoc(
                  doc(db, "patients", selectedPatient.patientId, "readings", readingId),
                  readingDoc
                );

                // Update assigned Firestore device status + sensor availability + lastReadingSummary
                const fsDevice =
                  firestoreDevices.find((d) => d.deviceId === snapDeviceId) ??
                  firestoreDevices.find((d) => d.patientId === selectedPatient.patientId);
                if (fsDevice) {
                  await updateDoc(doc(db, "devices", fsDevice.deviceId), {
                    connectionStatus: "streaming",
                    lastSeenAt: receivedAt.slice(0, 60),
                    lastDataSource: "esp32_hardware",
                    ...(snapAvail ? { sensorAvailability: snapAvail } : {}),
                    lastReadingSummary: summaryPayload,
                    updatedAt: serverTimestamp(),
                  });
                }

                if (liveReading.anomalyStatus === "anomalous" || liveReading.alertLevel !== "Normal") {
                  const hwEventId = sanitizeId(`evt_hw_${receivedAt}`, "evt");
                  const hwAnomalyDoc: Record<string, unknown> = {
                    eventId: hwEventId,
                    patientId: selectedPatient.patientId,
                    ownerUid: selectedPatient.ownerUid,
                    anomalyScore: liveReading.anomalyScore,
                    alertLevel: liveReading.alertLevel,
                    featureSummary: liveReading.explanation.slice(0, 500),
                    contributingFeatures: (liveReading.contributingFeatures ?? []).slice(0, 8),
                    source: "esp32_hardware",
                    createdAt: serverTimestamp(),
                  };
                  if (liveReading.modelVersion) {
                    hwAnomalyDoc.modelVersion = liveReading.modelVersion.slice(0, 80);
                  }
                  if (selectedPatient.primaryCaregiverUid) {
                    hwAnomalyDoc.primaryCaregiverUid = selectedPatient.primaryCaregiverUid;
                  }
                  if (selectedPatient.secondaryCaregiverUid) {
                    hwAnomalyDoc.secondaryCaregiverUid = selectedPatient.secondaryCaregiverUid;
                  }
                  await setDoc(doc(db, "anomaly_events", hwEventId), hwAnomalyDoc);
                }

                if (
                  (liveReading.alertLevel === "Warning" || liveReading.alertLevel === "Critical") &&
                  !snap.duplicateAlertSuppressed
                ) {
                  const phase5HwAlert =
                    snap.phase5Alert && typeof snap.phase5Alert === "object"
                      ? (snap.phase5Alert as Partial<AlertRecord>)
                      : undefined;
                  const alertId = sanitizeId(
                    phase5HwAlert?.alertId ? String(phase5HwAlert.alertId) : `al_hw_${receivedAt}`,
                    "al"
                  );
                  const triggeredMetrics = Array.isArray(snap.triggeredMetrics)
                    ? snap.triggeredMetrics.map(String).slice(0, 8)
                    : ["Multi-sensor"];
                  const boundedAnomalyScore = Math.max(-2, Math.min(2, Number(liveReading.anomalyScore ?? 0)));
                  const readingsSummary = `HR: ${liveReading.heartRate ?? "null"} BPM, SpO2: ${
                    liveReading.spo2 ?? "null"
                  }%, Temp: ${liveReading.temperatureC ?? "null"} C (${liveReading.signalQuality})`.slice(0, 240);
                  await setDoc(doc(db, "patients", selectedPatient.patientId, "alerts", alertId), {
                    alertId,
                    patientId: selectedPatient.patientId,
                    ownerUid: selectedPatient.ownerUid,
                    ...(selectedPatient.primaryCaregiverUid
                      ? { primaryCaregiverUid: selectedPatient.primaryCaregiverUid }
                      : {}),
                    ...(selectedPatient.secondaryCaregiverUid
                      ? { secondaryCaregiverUid: selectedPatient.secondaryCaregiverUid }
                      : {}),
                    level: liveReading.alertLevel,
                    status: "active",
                    title: `${liveReading.alertLevel} ESP32 wearable reading (${triggeredMetrics.join(", ")})`.slice(
                      0,
                      VALIDATION_LIMITS.MAX_TITLE_LEN
                    ),
                    explanation: liveReading.explanation.slice(
                      0,
                      VALIDATION_LIMITS.MAX_ALERT_EXPLANATION_LEN
                    ),
                    triggeredMetrics,
                    source: "esp32_hardware",
                    anomalyScore: boundedAnomalyScore,
                    prototypeNotice: (
                      phase5HwAlert?.prototypeNotice ||
                      "Prototype monitoring alert only — not a medical diagnosis. Please verify directly."
                    ).slice(0, 240),
                    relevantReadingsSummary: readingsSummary,
                    patientAcknowledged: false,
                    falseAlertReported: false,
                    unreadByPatient: true,
                    unreadByCaregiver: liveReading.alertLevel === "Warning",
                    notificationStatus: phase5HwAlert?.notificationStatus ?? "simulated",
                    escalationStatus: (
                      phase5HwAlert?.escalationStatus ??
                      (liveReading.alertLevel === "Critical" ? "awaiting_patient_ack" : "notified_caregiver")
                    ).slice(0, 64),
                    callEscalationStatus:
                      liveReading.alertLevel === "Critical"
                        ? "provider_unconfigured"
                        : "not_triggered",
                    callLog: [`${receivedAt} — ${liveReading.alertLevel} alert streamed by ESP32 hardware.`],
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                  });
                }
              } catch {
                // Non-fatal if user permissions are read-only caregiver or offline
              }
            } else if (usingSampleData) {
              setSampleReadingsMap((prev) => ({
                ...prev,
                [selectedPatient.patientId]: [
                  ...(prev[selectedPatient.patientId] ?? []),
                  liveReading,
                ].slice(-40),
              }));
              setSampleDevices((prev) =>
                prev.map((d) =>
                  d.patientId === selectedPatient.patientId || d.deviceId === snapDeviceId
                    ? {
                        ...d,
                        connectionStatus: "streaming",
                        lastSeenAt: receivedAt,
                        lastDataSource: "esp32_hardware",
                        sensorAvailability: snapAvail ?? d.sensorAvailability,
                        lastReadingSummary: summaryPayload,
                        updatedAt: receivedAt,
                      }
                    : d
                )
              );
              if (liveReading.anomalyStatus === "anomalous" || liveReading.alertLevel !== "Normal") {
                const evt: AnomalyEventRecord = {
                  eventId: sanitizeId(`evt_hw_${receivedAt}`, "evt"),
                  patientId: selectedPatient.patientId,
                  ownerUid: selectedPatient.ownerUid,
                  anomalyScore: liveReading.anomalyScore,
                  alertLevel: liveReading.alertLevel,
                  featureSummary: liveReading.explanation.slice(0, 500),
                  contributingFeatures: (liveReading.contributingFeatures ?? []).slice(0, 8),
                  modelVersion: liveReading.modelVersion,
                  source: "esp32_hardware",
                  createdAt: receivedAt,
                };
                setSampleAnomalyEvents((prev) => [evt, ...prev].slice(0, 40));
              }
            }
          }
        } else {
          setLiveHardwareSnapshot(null);
          // Mark stale hardware device offline cleanly
          if (hasFirestoreWorkspace && user && selectedPatient.ownerUid === user.uid && !simRunning) {
            const staleHwDev = firestoreDevices.find(
              (d) =>
                d.patientId === selectedPatient.patientId &&
                d.connectionStatus === "streaming" &&
                d.lastDataSource === "esp32_hardware"
            );
            if (staleHwDev) {
              void updateDoc(doc(db, "devices", staleHwDev.deviceId), {
                connectionStatus: "offline",
                updatedAt: serverTimestamp(),
              }).catch(() => {});
            }
          }
        }
      } catch {
        // Keep last state
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    selectedPatient.patientId,
    selectedPatient.ownerUid,
    selectedPatient.primaryCaregiverUid,
    selectedPatient.secondaryCaregiverUid,
    systemSettings.baselineMinSamples,
    hasFirestoreWorkspace,
    usingSampleData,
    user,
    devices,
    firestoreDevices,
    simRunning,
  ]);

  const ecgSegments: EcgSegmentRecord[] = useMemo(() => {
    const hwSegs = serverEcgHistory.filter((s) => s.source === "esp32_hardware");
    const readingSegs: EcgSegmentRecord[] = [...readings]
      .reverse()
      .filter((r) => (Array.isArray(r.ecgSamples) && r.ecgSamples.length > 0) || r.ecgLeadOff)
      .map((r) => ({
        segmentId: `rd_ecg_${r.readingId}`,
        deviceId: devices.find((d) => d.patientId === r.patientId)?.deviceId ?? "wearable",
        patientId: r.patientId,
        samples: r.ecgSamples ?? [],
        samplingRate: r.ecgSamplingRate ?? 200,
        signalQuality: r.ecgSignalQuality ?? (r.ecgLeadOff ? "lead_off" : "good"),
        leadOff: Boolean(r.ecgLeadOff),
        timestamp: r.ecgTimestamp ?? r.createdAt,
        features: r.ecgHeartRateBpm
          ? {
              samplingRateHz: r.ecgSamplingRate ?? 200,
              sampleCount: r.ecgSamples?.length ?? 0,
              rPeakCount: 0,
              estimatedEcgBpm: r.ecgHeartRateBpm,
              rrIntervalMeanMs: null,
              rrVariabilityMs: null,
              amplitudeRange: 0,
              signalQuality: r.ecgSignalQuality ?? "good",
            }
          : undefined,
        source: r.source,
      }));
    return [...hwSegs, ...readingSegs];
  }, [serverEcgHistory, readings, devices]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    setAuthLoading(true);
    triggerRedirectOnNextAuthRef.current = true;
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      triggerRedirectOnNextAuthRef.current = false;
      const msg = mapFirebaseAuthError(err);
      setAuthError(msg);
      throw new Error(msg);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const registerWithEmail = useCallback(
    async (input: {
      name: string;
      email: string;
      password: string;
      role: "patient" | "caregiver";
      ageGroup?: string;
    }): Promise<UserRole> => {
      setAuthError(null);
      setAuthLoading(true);
      const cleanName = input.name.trim().slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      const cleanEmail = input.email.trim();
      const chosenRole: "patient" | "caregiver" =
        input.role === "caregiver" ? "caregiver" : "patient";

      if (!cleanName || !cleanEmail || input.password.length < 6) {
        setAuthLoading(false);
        const msg = "Full name, valid email, and password (6+ characters) are required.";
        setAuthError(msg);
        throw new Error(msg);
      }

      pendingRegistrationRef.current = {
        email: cleanEmail,
        displayName: cleanName,
        role: chosenRole,
        ageGroup: input.ageGroup,
      };
      triggerRedirectOnNextAuthRef.current = true;

      try {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, input.password);
        await updateProfile(cred.user, { displayName: cleanName });
        try {
          await sendEmailVerification(cred.user);
        } catch {
          // Non-fatal if rate-limited
        }
        return chosenRole;
      } catch (err) {
        pendingRegistrationRef.current = null;
        triggerRedirectOnNextAuthRef.current = false;
        const msg = mapFirebaseAuthError(err);
        setAuthError(msg);
        throw new Error(msg);
      } finally {
        setAuthLoading(false);
      }
    },
    []
  );

  const signInWithEmail = useCallback(async (email: string, password: string): Promise<UserRole> => {
    setAuthError(null);
    setAuthLoading(true);
    triggerRedirectOnNextAuthRef.current = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const normEmail = cred.user.email?.toLowerCase().trim() ?? "";
      const adminBootstrap =
        cred.user.emailVerified && ADMIN_ALLOWLIST_EMAILS.has(normEmail);
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      const storedRole = snap.exists() ? (snap.data()?.role as UserRole | undefined) : undefined;
      if (adminBootstrap || (storedRole === "admin" && cred.user.emailVerified)) {
        return "admin";
      }
      return storedRole === "caregiver" ? "caregiver" : "patient";
    } catch (err) {
      triggerRedirectOnNextAuthRef.current = false;
      const msg = mapFirebaseAuthError(err);
      setAuthError(msg);
      throw new Error(msg);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      const msg = mapFirebaseAuthError(err);
      setAuthError(msg);
      throw new Error(msg);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const resendVerificationEmail = useCallback(async () => {
    if (!auth.currentUser) return;
    setAuthError(null);
    try {
      await sendEmailVerification(auth.currentUser);
    } catch (err) {
      const msg = mapFirebaseAuthError(err);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, []);

  const refreshCurrentUser = useCallback(async (): Promise<boolean> => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    const refreshed = auth.currentUser;
    const verified = Boolean(refreshed.emailVerified);
    setEmailVerified(verified);
    const normEmail = refreshed.email?.toLowerCase().trim() ?? "";
    if (verified && ADMIN_ALLOWLIST_EMAILS.has(normEmail)) {
      setIsAdminUser(true);
      setAssignedRole("admin");
      setActiveRoleState("admin");
    }
    return verified;
  }, []);

  const signOutUser = useCallback(async () => {
    if (user) {
      void writeAuditLog(
        { uid: user.uid, role: assignedRole ?? activeRole },
        "account_signed_out",
        `User ${user.email || user.uid} signed out.`,
        user.uid
      );
    }
    await signOut(auth);
    setSelectedPatientId(INITIAL_FALLBACK_PATIENTS[0].patientId);
    setActiveRoleState("patient");
  }, [user, assignedRole, activeRole, writeAuditLog]);

  const setActiveRole = useCallback(
    async (role: UserRole) => {
      if (user) {
        // Enforce RBAC for signed-in users: cannot escalate to admin unless verified admin
        if (role === "admin" && !isAdminUser) {
          setAuthError("Administrator role requires a verified AROVA administrator account.");
          return;
        }
        // Caregivers cannot switch into another role unless admin
        if (assignedRole && assignedRole !== "admin" && role !== assignedRole) {
          setAuthError(
            `Your account is assigned the '${assignedRole}' role. Role changes require an administrator.`
          );
          return;
        }
      }
      setActiveRoleState(role);
    },
    [user, isAdminUser, assignedRole]
  );

  const initializeFirestoreWorkspace = useCallback(async () => {
    if (!user) return;
    try {
      await provisionPatientWorkspaceForUser(
        user.uid,
        user.displayName || user.email || "My Patient Profile",
        userProfile?.profileSettings?.ageGroup
      );
      await writeAuditLog(
        { uid: user.uid, role: assignedRole ?? activeRole },
        "workspace_initialized",
        "Initialized patient monitoring profile, ESP32 device, and baseline record in Firestore.",
        user.uid
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `patients/pt_${user.uid.slice(0, 16)}`);
    }
  }, [user, userProfile, assignedRole, activeRole, provisionPatientWorkspaceForUser, writeAuditLog]);

  const updateProfileSettings = useCallback(
    async (input: {
      displayName: string;
      ageGroup?: string;
      phone?: string;
      emergencyNotes?: string;
      notificationsEnabled?: boolean;
      preferredLanguage?: SupportedVoiceLanguage;
      emergencyAlertsEnabled?: boolean;
    }) => {
      if (!user) throw new Error("Sign in to update profile settings.");
      const cleanName = input.displayName.trim().slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      if (!cleanName) throw new Error("Display name cannot be empty.");

      const nextSettings: UserProfileSettings = {
        notificationsEnabled: input.notificationsEnabled ?? userProfile?.profileSettings?.notificationsEnabled ?? true,
        preferredLanguage: input.preferredLanguage ?? userProfile?.profileSettings?.preferredLanguage ?? "en",
        emergencyAlertsEnabled:
          input.emergencyAlertsEnabled ?? userProfile?.profileSettings?.emergencyAlertsEnabled ?? true,
        ...(input.ageGroup?.trim() ? { ageGroup: input.ageGroup.trim().slice(0, 40) } : {}),
      };

      try {
        await updateDoc(doc(db, "users", user.uid), {
          displayName: cleanName,
          profileSettings: nextSettings,
          updatedAt: serverTimestamp(),
        });

        await updateProfile(user, { displayName: cleanName });

        const cleanEmail = (user.email || privateContact?.email || "user@example.com").slice(0, 160);
        const contactPayload: Record<string, unknown> = {
          uid: user.uid,
          email: cleanEmail,
          updatedAt: serverTimestamp(),
        };
        if (input.phone !== undefined) {
          contactPayload.phone = input.phone.trim().slice(0, 32);
        }
        if (input.emergencyNotes !== undefined) {
          contactPayload.emergencyNotes = input.emergencyNotes.trim().slice(0, 500);
        }
        await setDoc(doc(db, "users", user.uid, "private", "contact"), contactPayload, { merge: true });

        // Keep owned patient record synchronized
        const ownedPatient = firestorePatients.find((p) => p.ownerUid === user.uid);
        if (ownedPatient) {
          await updateDoc(doc(db, "patients", ownedPatient.patientId), {
            displayName: cleanName,
            ...(input.ageGroup?.trim() ? { ageGroup: input.ageGroup.trim().slice(0, 40) } : {}),
            updatedAt: serverTimestamp(),
          });
        }

        setUserProfile((prev) =>
          prev
            ? { ...prev, displayName: cleanName, profileSettings: nextSettings }
            : { uid: user.uid, displayName: cleanName, role: assignedRole ?? activeRole, profileSettings: nextSettings }
        );
        setPrivateContact((prev) => ({
          uid: user.uid,
          email: cleanEmail,
          phone: input.phone !== undefined ? input.phone.trim().slice(0, 32) : prev?.phone,
          emergencyNotes:
            input.emergencyNotes !== undefined
              ? input.emergencyNotes.trim().slice(0, 500)
              : prev?.emergencyNotes,
        }));

        await writeAuditLog(
          { uid: user.uid, role: assignedRole ?? activeRole },
          "profile_updated",
          `Updated profile settings for ${cleanName}.`,
          user.uid
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${user.uid}`);
      }
    },
    [user, userProfile, privateContact, firestorePatients, assignedRole, activeRole, writeAuditLog]
  );

  const injectSimulatorReading = useCallback(
    async (input: {
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
      ecgSamples?: number[];
      ecgSamplingRate?: number;
      ecgSignalQuality?: EcgSignalQuality;
      ecgLeadOff?: boolean;
      ecgTimestamp?: string;
      source?: TelemetrySource;
    }): Promise<VitalReading> => {
      const targetPatient = selectedPatient;
      const targetDevice = devices.find((d) => d.patientId === targetPatient.patientId) ?? devices[0];
      const deviceId = targetDevice?.deviceId ?? "sim_esp32_01";
      const baselineMeans =
        typeof targetPatient.baselineHeartRateMean === "number" &&
        typeof targetPatient.baselineSpo2Mean === "number" &&
        typeof targetPatient.baselineTempMean === "number"
          ? {
              heartRate: targetPatient.baselineHeartRateMean,
              spo2: targetPatient.baselineSpo2Mean,
              temperatureC: targetPatient.baselineTempMean,
            }
          : undefined;

      const res = await sendSimulatedWearablePacket({
        deviceId,
        patientId: targetPatient.patientId,
        patientName: targetPatient.displayName,
        patientOwnerUid: targetPatient.ownerUid,
        timestamp: new Date().toISOString(),
        heartRate: input.heartRate,
        spo2: input.spo2,
        temperatureC: input.temperatureC,
        accelMagnitude: input.accelMagnitude,
        gyroMagnitude: input.gyroMagnitude,
        accelX: input.accelX,
        accelY: input.accelY,
        accelZ: input.accelZ,
        gyroX: input.gyroX,
        gyroY: input.gyroY,
        gyroZ: input.gyroZ,
        movementStatus: input.movementStatus,
        possibleFallDetected: input.possibleFallDetected,
        irSignalOk: input.irSignalOk ?? true,
        fingerDetected: input.fingerDetected ?? true,
        sensor_quality: input.sensor_quality,
        sensorAvailability: input.sensorAvailability,
        ecgSamples: input.ecgSamples,
        ecgSamplingRate: input.ecgSamplingRate,
        ecgSignalQuality: input.ecgSignalQuality,
        ecgLeadOff: input.ecgLeadOff,
        ecgTimestamp: input.ecgTimestamp,
        source: input.source ?? "simulator",
        baselineMeans,
        baselineTrained: targetPatient.baselineStatus === "ready",
        policyConfig: {
          baselineMinSamples: systemSettings.baselineMinSamples,
          warningPersistenceWindows:
            alertLevelsPolicy.levels.Medium.detection.minPersistenceWindows ??
            systemSettings.warningPersistenceWindows ??
            2,
          criticalPersistenceWindows:
            alertLevelsPolicy.levels.High.detection.minPersistenceWindows ??
            systemSettings.criticalPersistenceWindows ??
            3,
          anomalyScoreWarningThreshold:
            alertLevelsPolicy.levels.Medium.detection.anomalyScoreMaxThreshold ??
            systemSettings.anomalyScoreThreshold ??
            -0.05,
          anomalyScoreCriticalThreshold:
            alertLevelsPolicy.levels.High.detection.anomalyScoreMaxThreshold ?? -0.18,
          zScoreWarningThreshold: alertLevelsPolicy.levels.Medium.detection.minZScore ?? 2.0,
          zScoreCriticalThreshold: alertLevelsPolicy.levels.High.detection.minZScore ?? 3.0,
        },
      });

      const boundedEcg = Array.isArray(res.ecgSamples)
        ? res.ecgSamples.slice(0, VALIDATION_LIMITS.MAX_ECG_BATCH)
        : undefined;
      const readingId = `rd_${Date.now()}`;
      const newReading: VitalReading = {
        readingId,
        patientId: targetPatient.patientId,
        ownerUid: targetPatient.ownerUid,
        deviceId,
        primaryCaregiverUid: targetPatient.primaryCaregiverUid,
        secondaryCaregiverUid: targetPatient.secondaryCaregiverUid,
        heartRate: res.heartRate,
        spo2: res.spo2,
        temperatureC: res.temperatureC,
        movementStatus: res.movementStatus,
        accelMagnitude: res.accelMagnitude,
        gyroMagnitude: res.gyroMagnitude,
        accelX: res.accelX,
        accelY: res.accelY,
        accelZ: res.accelZ,
        gyroX: res.gyroX,
        gyroY: res.gyroY,
        gyroZ: res.gyroZ,
        possibleFallDetected: res.possibleFallDetected,
        ecgSamples: boundedEcg,
        ecgSamplingRate: res.ecgSamplingRate,
        ecgSignalQuality: res.ecgSignalQuality,
        ecgLeadOff: res.ecgLeadOff,
        ecgTimestamp: res.ecgTimestamp ?? undefined,
        ecgHeartRateBpm: res.ecgFeatures?.estimatedEcgBpm ?? undefined,
        signalQuality: res.signalQuality,
        sensorAvailability: res.sensorAvailability,
        batteryPct: res.batteryPct ?? null,
        anomalyStatus: res.anomalyStatus,
        anomalyScore: res.anomalyScore,
        alertLevel: res.alertLevel,
        contributingFeatures: res.contributingFeatures?.slice(0, 8),
        persistenceCount: res.persistenceCount,
        modelVersion: res.modelVersion ?? undefined,
        source: res.source,
        mlEngine: res.mlEngine,
        explanation: res.explanation.slice(0, VALIDATION_LIMITS.MAX_EXPLANATION_LEN),
        plainLanguageExplanations: Array.isArray(res.plainLanguageExplanations)
          ? res.plainLanguageExplanations.slice(0, 5)
          : undefined,
        createdAt: res.receivedAt,
      };

      const summaryPayload: LastReadingSummary = {
        heartRate: newReading.heartRate,
        spo2: newReading.spo2,
        temperatureC: newReading.temperatureC,
        movementStatus: newReading.movementStatus,
        signalQuality: newReading.signalQuality,
        ...(typeof newReading.accelX === "number" ? { accelX: newReading.accelX } : {}),
        ...(typeof newReading.accelY === "number" ? { accelY: newReading.accelY } : {}),
        ...(typeof newReading.accelZ === "number" ? { accelZ: newReading.accelZ } : {}),
        timestamp: res.receivedAt.slice(0, 60),
      };

      if (res.baselineProgress) {
        try {
          const bStatus = await fetchPatientBaselineStatus(
            targetPatient.patientId,
            systemSettings.baselineMinSamples
          );
          setBaselineStatusSummary(bStatus);
        } catch {
          // Non-fatal
        }
      }

      if (hasFirestoreWorkspace && user) {
        try {
          const readingDoc: Record<string, unknown> = {
            readingId,
            patientId: targetPatient.patientId,
            ownerUid: targetPatient.ownerUid,
            deviceId: deviceId.slice(0, 128),
            heartRate: newReading.heartRate,
            spo2: newReading.spo2,
            temperatureC: newReading.temperatureC,
            movementStatus: newReading.movementStatus,
            accelMagnitude: newReading.accelMagnitude,
            gyroMagnitude: newReading.gyroMagnitude,
            possibleFallDetected: Boolean(newReading.possibleFallDetected),
            signalQuality: newReading.signalQuality,
            anomalyScore: newReading.anomalyScore,
            alertLevel: newReading.alertLevel,
            source: newReading.source,
            mlEngine: newReading.mlEngine,
            explanation: newReading.explanation,
            createdAt: serverTimestamp(),
          };
          if (typeof newReading.accelX === "number") readingDoc.accelX = newReading.accelX;
          if (typeof newReading.accelY === "number") readingDoc.accelY = newReading.accelY;
          if (typeof newReading.accelZ === "number") readingDoc.accelZ = newReading.accelZ;
          if (typeof newReading.gyroX === "number") readingDoc.gyroX = newReading.gyroX;
          if (typeof newReading.gyroY === "number") readingDoc.gyroY = newReading.gyroY;
          if (typeof newReading.gyroZ === "number") readingDoc.gyroZ = newReading.gyroZ;
          if (newReading.anomalyStatus) {
            readingDoc.anomalyStatus = newReading.anomalyStatus;
          }
          if (Array.isArray(newReading.contributingFeatures)) {
            readingDoc.contributingFeatures = newReading.contributingFeatures.slice(0, 8);
          }
          if (typeof newReading.persistenceCount === "number") {
            readingDoc.persistenceCount = Math.max(0, Math.round(newReading.persistenceCount));
          }
          if (newReading.modelVersion) {
            readingDoc.modelVersion = newReading.modelVersion.slice(0, 80);
          }
          if (boundedEcg && boundedEcg.length > 0) {
            readingDoc.ecgSamples = boundedEcg;
            readingDoc.ecgSamplingRate = newReading.ecgSamplingRate ?? 200;
            readingDoc.ecgSignalQuality = newReading.ecgSignalQuality ?? "good";
            readingDoc.ecgLeadOff = Boolean(newReading.ecgLeadOff);
            if (newReading.ecgTimestamp) {
              readingDoc.ecgTimestamp = newReading.ecgTimestamp.slice(0, 60);
            }
            if (typeof newReading.ecgHeartRateBpm === "number") {
              readingDoc.ecgHeartRateBpm = newReading.ecgHeartRateBpm;
            }
          } else if (newReading.ecgLeadOff) {
            readingDoc.ecgLeadOff = true;
            readingDoc.ecgSignalQuality = "lead_off";
          }
          if (targetPatient.primaryCaregiverUid) {
            readingDoc.primaryCaregiverUid = targetPatient.primaryCaregiverUid;
          }
          if (targetPatient.secondaryCaregiverUid) {
            readingDoc.secondaryCaregiverUid = targetPatient.secondaryCaregiverUid;
          }
          await setDoc(doc(db, "patients", targetPatient.patientId, "readings", readingId), readingDoc);

          // Update Firestore device telemetry summary cleanly without confusing simulator for real hardware
          if (targetDevice && firestoreDevices.some((d) => d.deviceId === targetDevice.deviceId)) {
            await updateDoc(doc(db, "devices", targetDevice.deviceId), {
              lastSeenAt: res.receivedAt.slice(0, 60),
              lastDataSource: res.source === "esp32_hardware" ? "esp32_hardware" : "simulator",
              ...(res.sensorAvailability ? { sensorAvailability: res.sensorAvailability } : {}),
              lastReadingSummary: summaryPayload,
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }

          if (newReading.anomalyStatus === "anomalous" || newReading.alertLevel !== "Normal") {
            const eventId = sanitizeId(`evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, "evt");
            const anomalyDoc: Record<string, unknown> = {
              eventId,
              patientId: targetPatient.patientId,
              ownerUid: targetPatient.ownerUid,
              anomalyScore: newReading.anomalyScore,
              alertLevel: newReading.alertLevel,
              featureSummary: newReading.explanation.slice(0, 500),
              contributingFeatures: (newReading.contributingFeatures ?? []).slice(0, 8),
              source: newReading.source === "esp32_hardware" ? "esp32_hardware" : "simulator",
              createdAt: serverTimestamp(),
            };
            if (newReading.modelVersion) {
              anomalyDoc.modelVersion = newReading.modelVersion.slice(0, 80);
            }
            if (targetPatient.primaryCaregiverUid) {
              anomalyDoc.primaryCaregiverUid = targetPatient.primaryCaregiverUid;
            }
            if (targetPatient.secondaryCaregiverUid) {
              anomalyDoc.secondaryCaregiverUid = targetPatient.secondaryCaregiverUid;
            }
            await setDoc(doc(db, "anomaly_events", eventId), anomalyDoc);
          }

          if (
            (newReading.alertLevel === "Warning" || newReading.alertLevel === "Critical") &&
            !res.duplicateAlertSuppressed
          ) {
            const alertId = sanitizeId(
              res.phase5Alert?.alertId ? res.phase5Alert.alertId : `al_${Date.now()}`,
              "al"
            );
            const callStatus: CallEscalationStatus =
              newReading.alertLevel === "Critical" ? "provider_unconfigured" : "not_triggered";
            const boundedAnomalyScore = Math.max(-2, Math.min(2, Number(newReading.anomalyScore ?? 0)));
            const readingsSummary = `HR: ${newReading.heartRate ?? "null"} BPM, SpO2: ${
              newReading.spo2 ?? "null"
            }%, Temp: ${newReading.temperatureC ?? "null"} C (${newReading.signalQuality})`.slice(0, 240);
            const alertDoc: Record<string, unknown> = {
              alertId,
              patientId: targetPatient.patientId,
              ownerUid: targetPatient.ownerUid,
              level: newReading.alertLevel,
              status: "active",
              title: `${newReading.alertLevel} wearable reading detected (${res.triggeredMetrics.join(", ") || "Deviation"})`.slice(
                0,
                VALIDATION_LIMITS.MAX_TITLE_LEN
              ),
              explanation: newReading.explanation.slice(0, VALIDATION_LIMITS.MAX_ALERT_EXPLANATION_LEN),
              triggeredMetrics: res.triggeredMetrics.slice(0, 8),
              source: newReading.source,
              anomalyScore: boundedAnomalyScore,
              prototypeNotice: (
                res.phase5Alert?.prototypeNotice ||
                "Prototype monitoring alert only — not a medical diagnosis. Please verify directly."
              ).slice(0, 240),
              relevantReadingsSummary: readingsSummary,
              patientAcknowledged: false,
              falseAlertReported: false,
              unreadByPatient: true,
              unreadByCaregiver: newReading.alertLevel === "Warning",
              notificationStatus: res.phase5Alert?.notificationStatus ?? "simulated",
              escalationStatus: (
                res.phase5Alert?.escalationStatus ??
                (newReading.alertLevel === "Critical" ? "awaiting_patient_ack" : "notified_caregiver")
              ).slice(0, 64),
              callEscalationStatus: callStatus,
              callLog: [
                `${res.receivedAt} — ${newReading.alertLevel} alert recorded from ${newReading.source}.`,
              ],
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            };
            if (targetPatient.primaryCaregiverUid) {
              alertDoc.primaryCaregiverUid = targetPatient.primaryCaregiverUid;
            }
            if (targetPatient.secondaryCaregiverUid) {
              alertDoc.secondaryCaregiverUid = targetPatient.secondaryCaregiverUid;
            }
            await setDoc(doc(db, "patients", targetPatient.patientId, "alerts", alertId), alertDoc);
            await writeAuditLog(
              { uid: user.uid, role: assignedRole ?? activeRole },
              "alert_generated",
              `${newReading.alertLevel} alert recorded for ${targetPatient.displayName}.`,
              alertId
            );
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `patients/${targetPatient.patientId}/readings`);
        }
      } else {
        setSampleReadingsMap((prev) => ({
          ...prev,
          [targetPatient.patientId]: [...(prev[targetPatient.patientId] ?? []), newReading].slice(-40),
        }));
        setSampleDevices((prev) =>
          prev.map((d) =>
            d.deviceId === deviceId
              ? {
                  ...d,
                  lastSeenAt: res.receivedAt,
                  lastDataSource: res.source === "esp32_hardware" ? "esp32_hardware" : "simulator",
                  sensorAvailability: res.sensorAvailability ?? d.sensorAvailability,
                  lastReadingSummary: summaryPayload,
                  updatedAt: res.receivedAt,
                }
              : d
          )
        );
        if (newReading.anomalyStatus === "anomalous" || newReading.alertLevel !== "Normal") {
          const sampleEvt: AnomalyEventRecord = {
            eventId: sanitizeId(`evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, "evt"),
            patientId: targetPatient.patientId,
            ownerUid: targetPatient.ownerUid,
            anomalyScore: newReading.anomalyScore,
            alertLevel: newReading.alertLevel,
            featureSummary: newReading.explanation.slice(0, 500),
            contributingFeatures: (newReading.contributingFeatures ?? []).slice(0, 8),
            modelVersion: newReading.modelVersion,
            source: newReading.source === "esp32_hardware" ? "esp32_hardware" : "simulator",
            createdAt: res.receivedAt,
          };
          setSampleAnomalyEvents((prev) => [sampleEvt, ...prev].slice(0, 40));
        }

        if (
          (newReading.alertLevel === "Warning" || newReading.alertLevel === "Critical") &&
          !res.duplicateAlertSuppressed
        ) {
          const phase5Alert = res.phase5Alert;
          const newAlert: AlertRecord = phase5Alert
            ? {
                ...phase5Alert,
                alertId: phase5Alert.alertId || `al_${Date.now()}`,
              }
            : {
                alertId: `al_${Date.now()}`,
                patientId: targetPatient.patientId,
                ownerUid: targetPatient.ownerUid,
                level: newReading.alertLevel,
                status: "active",
                title: `${newReading.alertLevel} simulator reading (${res.triggeredMetrics.join(", ") || "Deviation"})`,
                explanation: newReading.explanation,
                prototypeNotice:
                  "Prototype monitoring alert only — not a medical diagnosis. Please verify directly.",
                anomalyScore: newReading.anomalyScore,
                relevantReadingsSummary: `HR: ${newReading.heartRate ?? "null"} BPM, SpO2: ${
                  newReading.spo2 ?? "null"
                }%, Temp: ${newReading.temperatureC ?? "null"} C`,
                patientAcknowledged: false,
                falseAlertReported: false,
                unreadByPatient: true,
                unreadByCaregiver: newReading.alertLevel === "Warning",
                triggeredMetrics: res.triggeredMetrics.slice(0, 8),
                source: newReading.source,
                callEscalationStatus:
                  newReading.alertLevel === "Critical" ? "provider_unconfigured" : "not_triggered",
                callLog: [`${res.receivedAt} — ${newReading.alertLevel} alert generated from simulator.`],
                createdAt: res.receivedAt,
                updatedAt: res.receivedAt,
              };
          setSampleAlerts((prev) => [newAlert, ...prev]);
        }
      }

      if (newReading.alertLevel === "Warning" || newReading.alertLevel === "Critical") {
        void refreshPhase5Notifications();
      }

      return newReading;
    },
    [
      selectedPatient,
      devices,
      firestoreDevices,
      hasFirestoreWorkspace,
      user,
      systemSettings,
      alertLevelsPolicy,
      assignedRole,
      activeRole,
      writeAuditLog,
      refreshPhase5Notifications,
    ]
  );

  // --- Phase 3: Shared Continuous Simulation Engine & Backend Device Controls ---
  const buildSimulatedReadingPayload = useCallback(
    (mode: "normal" | "unusual", errMode: SimSensorErrorMode) => {
      if (errMode === "poor_contact") {
        return {
          heartRate: null,
          spo2: null,
          temperatureC: 36.6,
          accelX: 0.02,
          accelY: -0.01,
          accelZ: 0.99,
          gyroX: 0.4,
          gyroY: -0.2,
          gyroZ: 0.3,
          accelMagnitude: 0.99,
          gyroMagnitude: 0.5,
          movementStatus: "resting" as MovementStatus,
          possibleFallDetected: false,
          irSignalOk: false,
          fingerDetected: false,
          sensor_quality: "poor_contact" as const,
          sensorAvailability: {
            pulseOximeter: false,
            temperature: true,
            imu: true,
            ecg: false,
            oled: true,
            vibrationMotor: true,
          },
          source: "simulator" as TelemetrySource,
        };
      }
      if (errMode === "temp_disconnected") {
        return {
          heartRate: Math.round(72 + (Math.random() - 0.5) * 6),
          spo2: Number((98.0 + (Math.random() - 0.5) * 0.8).toFixed(1)),
          temperatureC: null,
          accelX: 0.03,
          accelY: 0.01,
          accelZ: 1.0,
          gyroX: 1.2,
          gyroY: 0.8,
          gyroZ: -0.6,
          accelMagnitude: 1.0,
          gyroMagnitude: 1.5,
          movementStatus: "resting" as MovementStatus,
          possibleFallDetected: false,
          irSignalOk: true,
          fingerDetected: true,
          sensor_quality: "good" as const,
          sensorAvailability: {
            pulseOximeter: true,
            temperature: false,
            imu: true,
            ecg: true,
            oled: true,
            vibrationMotor: true,
          },
          source: "simulator" as TelemetrySource,
        };
      }
      if (mode === "unusual") {
        const spikeFall = Math.random() > 0.6;
        const ax = Number((spikeFall ? 2.45 : 0.42).toFixed(3));
        const ay = Number((spikeFall ? -1.4 : 0.25).toFixed(3));
        const az = Number((spikeFall ? 1.15 : 0.92).toFixed(3));
        const amag = Number(Math.sqrt(ax * ax + ay * ay + az * az).toFixed(2));
        return {
          heartRate: Math.round(124 + Math.random() * 14),
          spo2: Number((88.5 + Math.random() * 3.0).toFixed(1)),
          temperatureC: Number((38.2 + Math.random() * 0.6).toFixed(1)),
          accelX: ax,
          accelY: ay,
          accelZ: az,
          gyroX: 48.0,
          gyroY: -36.0,
          gyroZ: 24.0,
          accelMagnitude: amag,
          gyroMagnitude: 64.5,
          movementStatus: (spikeFall ? "fall_suspect" : "active") as MovementStatus,
          possibleFallDetected: spikeFall,
          irSignalOk: true,
          fingerDetected: true,
          ecgLeadOff: errMode === "ecg_lead_off",
          ecgSignalQuality: (errMode === "ecg_lead_off" ? "lead_off" : "good") as EcgSignalQuality,
          sensor_quality: "good" as const,
          sensorAvailability: {
            pulseOximeter: true,
            temperature: true,
            imu: true,
            ecg: errMode !== "ecg_lead_off",
            oled: true,
            vibrationMotor: true,
          },
          source: "simulator" as TelemetrySource,
        };
      }
      const ax = Number(((Math.random() - 0.5) * 0.08).toFixed(3));
      const ay = Number(((Math.random() - 0.5) * 0.08).toFixed(3));
      const az = Number((0.99 + (Math.random() - 0.5) * 0.04).toFixed(3));
      const amag = Number(Math.sqrt(ax * ax + ay * ay + az * az).toFixed(3));
      return {
        heartRate: Math.round(72 + (Math.random() - 0.5) * 8),
        spo2: Number((97.8 + (Math.random() - 0.5) * 0.8).toFixed(1)),
        temperatureC: Number((36.6 + (Math.random() - 0.5) * 0.3).toFixed(1)),
        accelX: ax,
        accelY: ay,
        accelZ: az,
        gyroX: Number(((Math.random() - 0.5) * 4).toFixed(1)),
        gyroY: Number(((Math.random() - 0.5) * 4).toFixed(1)),
        gyroZ: Number(((Math.random() - 0.5) * 4).toFixed(1)),
        accelMagnitude: amag,
        gyroMagnitude: 3.2,
        movementStatus: "resting" as MovementStatus,
        possibleFallDetected: false,
        irSignalOk: true,
        fingerDetected: true,
        ecgLeadOff: errMode === "ecg_lead_off",
        ecgSignalQuality: (errMode === "ecg_lead_off" ? "lead_off" : "good") as EcgSignalQuality,
        sensor_quality: "good" as const,
        sensorAvailability: {
          pulseOximeter: true,
          temperature: true,
          imu: true,
          ecg: errMode !== "ecg_lead_off",
          oled: true,
          vibrationMotor: true,
        },
        source: "simulator" as TelemetrySource,
      };
    },
    []
  );

  const generateNormalReading = useCallback(async (): Promise<VitalReading | null> => {
    if (!simDeviceConnected) {
      setSimLastPacketSummary("Simulated device is disconnected. Reconnect it to stream.");
      return null;
    }
    const created = await injectSimulatorReading(buildSimulatedReadingPayload("normal", simSensorError));
    setSimLastPacketSummary(
      `Normal simulated reading: HR ${created.heartRate ?? "--"} BPM · SpO₂ ${
        created.spo2 ?? "--"
      }% · Temp ${created.temperatureC ?? "--"} °C (${created.alertLevel})`
    );
    return created;
  }, [simDeviceConnected, simSensorError, injectSimulatorReading, buildSimulatedReadingPayload]);

  const generateUnusualReading = useCallback(async (): Promise<VitalReading | null> => {
    if (!simDeviceConnected) {
      setSimLastPacketSummary("Simulated device is disconnected. Reconnect it to stream.");
      return null;
    }
    const created = await injectSimulatorReading(buildSimulatedReadingPayload("unusual", simSensorError));
    setSimLastPacketSummary(
      `Unusual simulated reading: HR ${created.heartRate ?? "--"} BPM · SpO₂ ${
        created.spo2 ?? "--"
      }% · Temp ${created.temperatureC ?? "--"} °C (${created.alertLevel})`
    );
    return created;
  }, [simDeviceConnected, simSensorError, injectSimulatorReading, buildSimulatedReadingPayload]);

  const startSimulation = useCallback(
    (mode?: "normal" | "unusual") => {
      if (mode) setSimMode(mode);
      setSimDeviceConnected(true);
      setSimRunning(true);
    },
    []
  );

  const stopSimulation = useCallback(() => {
    setSimRunning(false);
  }, []);

  const disconnectSimulatedDevice = useCallback(async () => {
    setSimRunning(false);
    setSimDeviceConnected(false);
    setSimLastPacketSummary("Simulated device disconnected (test mode).");
    const targetDev = devices.find((d) => d.patientId === selectedPatient.patientId) ?? devices[0];
    if (targetDev && hasFirestoreWorkspace && user && selectedPatient.ownerUid === user.uid) {
      await updateDoc(doc(db, "devices", targetDev.deviceId), {
        connectionStatus: "offline",
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    } else if (targetDev && usingSampleData) {
      setSampleDevices((prev) =>
        prev.map((d) =>
          d.deviceId === targetDev.deviceId ? { ...d, connectionStatus: "offline" } : d
        )
      );
    }
  }, [devices, selectedPatient.patientId, selectedPatient.ownerUid, hasFirestoreWorkspace, user, usingSampleData]);

  const reconnectSimulatedDevice = useCallback(async () => {
    setSimDeviceConnected(true);
    setSimLastPacketSummary("Simulated device reconnected (ready to stream simulator packets).");
  }, []);

  useEffect(() => {
    if (!simRunning || !simDeviceConnected) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const payload = buildSimulatedReadingPayload(simMode, simSensorError);
        const created = await injectSimulatorReading(payload);
        if (!cancelled) {
          setSimLastPacketSummary(
            `Simulator stream (${simMode}): HR ${created.heartRate ?? "--"} BPM · SpO₂ ${
              created.spo2 ?? "--"
            }% · ${created.alertLevel}`
          );
        }
      } catch (err) {
        if (!cancelled) {
          setSimLastPacketSummary(err instanceof Error ? err.message : "Simulator tick failed.");
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), Math.max(1000, simIntervalMs));
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    simRunning,
    simDeviceConnected,
    simMode,
    simSensorError,
    simIntervalMs,
    buildSimulatedReadingPayload,
    injectSimulatorReading,
  ]);

  const registerDeviceWithBackend = useCallback(
    async (input: {
      deviceId: string;
      label?: string;
      pulseOxChipVariant?: string;
      ecgSensor?: string;
      tempSensor?: string;
      samplingIntervalMs?: number;
      firmwareVersion?: string;
      rotateToken?: boolean;
    }) => {
      const res = await registerWearableDevice({
        ...input,
        patientId: selectedPatient.patientId,
      });
      await refreshBackendDevices();
      return res;
    },
    [selectedPatient.patientId, refreshBackendDevices]
  );

  const setDeviceConnectionState = useCallback(
    async (
      deviceId: string,
      connectionStatus: "not_connected" | "streaming" | "offline"
    ) => {
      if (user) {
        await updateWearableDeviceStatus(deviceId, connectionStatus).catch(() => null);
        await refreshBackendDevices();
      }
      if (hasFirestoreWorkspace && user) {
        const fsDev = firestoreDevices.find((d) => d.deviceId === deviceId);
        if (fsDev) {
          await updateDoc(doc(db, "devices", fsDev.deviceId), {
            connectionStatus,
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        }
      } else {
        setSampleDevices((prev) =>
          prev.map((d) => (d.deviceId === deviceId ? { ...d, connectionStatus } : d))
        );
      }
      if (connectionStatus !== "streaming") {
        setLiveHardwareSnapshot(null);
      }
    },
    [user, hasFirestoreWorkspace, firestoreDevices, refreshBackendDevices]
  );

  const triggerDeviceVibrationCommand = useCallback(
    async (
      deviceId: string,
      payload: {
        action: "activate" | "deactivate";
        pattern?: "none" | "single_pulse" | "triple_alert";
        durationMs?: number;
        reason?: string;
      }
    ) => {
      const cmd = await sendWearableHapticCommand(deviceId, payload);
      return cmd;
    },
    []
  );

  const fitBaselineForSelectedPatient = useCallback(async () => {
    const cleanFilter = (r: VitalReading): r is VitalReading & { heartRate: number; spo2: number } =>
      r.signalQuality === "good" &&
      typeof r.heartRate === "number" &&
      typeof r.spo2 === "number";

    const hwClean = readings.filter((r) => r.source === "esp32_hardware").filter(cleanFilter);
    const simClean = readings.filter((r) => r.source === "simulator").filter(cleanFilter);

    let chosenSource: TelemetrySource = "simulator";
    let chosenList = simClean;
    if (hwClean.length >= 5) {
      chosenSource = "esp32_hardware";
      chosenList = hwClean;
    } else if (simClean.length < 5) {
      throw new Error(
        "Personalized baseline learning excludes sample_demo records. Collect at least 5 quality-filtered simulator packets or live ESP32 hardware packets first."
      );
    }

    const cleanSamples = chosenList.map((r) => ({
      heartRate: r.heartRate,
      spo2: r.spo2,
      temperatureC: r.temperatureC,
      accelMagnitude: r.accelMagnitude ?? 1.0,
      gyroMagnitude: r.gyroMagnitude ?? 3.0,
      movementStatus: r.movementStatus,
      signalQuality: r.signalQuality,
      timestamp: r.createdAt,
      ecgBpm: r.ecgHeartRateBpm ?? null,
      ecgSignalQuality: r.ecgSignalQuality ?? "unavailable",
      ecgLeadOff: Boolean(r.ecgLeadOff),
    }));

    const result = await requestBaselineFit(selectedPatient.patientId, cleanSamples, {
      source: chosenSource,
      minSamples: systemSettings.baselineMinSamples,
    });
    const nextStatus = result.baselineStatus;

    try {
      const bStatus = await fetchPatientBaselineStatus(
        selectedPatient.patientId,
        systemSettings.baselineMinSamples
      );
      setBaselineStatusSummary(bStatus);
    } catch {
      // Non-fatal
    }

    if (hasFirestoreWorkspace && user) {
      try {
        const updatePayload: Record<string, unknown> = {
          baselineStatus: nextStatus,
          baselineSamplesCount: result.sampleCount,
          baselineHeartRateMean: result.means.heartRate,
          baselineSpo2Mean: result.means.spo2,
          baselineTempMean: result.means.temperatureC,
          baselineSource: result.source,
          baselineModelTrained: result.trained,
          baselineModelVersion: result.modelVersion.slice(0, 80),
          updatedAt: serverTimestamp(),
        };
        if (typeof result.ecgBpmMean === "number") {
          updatePayload.baselineEcgBpmMean = result.ecgBpmMean;
        }
        if (typeof result.activeHeartRateMean === "number") {
          updatePayload.baselineActiveHrMean = result.activeHeartRateMean;
        }
        await updateDoc(doc(db, "patients", selectedPatient.patientId), updatePayload);

        const baseSource = result.source === "esp32_hardware" ? "esp32_hardware" : "simulator";
        const baselineId = sanitizeId(`${selectedPatient.patientId}_${baseSource}`, "base");
        const featureStatistics: Record<string, unknown> = {
          heartRateMean: result.means.heartRate,
          spo2Mean: result.means.spo2,
          tempMean: result.means.temperatureC,
          sampleCount: result.sampleCount,
        };
        if (result.medians) {
          if (typeof result.medians.heartRate === "number") {
            featureStatistics.heartRateMedian = result.medians.heartRate;
          }
          if (typeof result.medians.spo2 === "number") {
            featureStatistics.spo2Median = result.medians.spo2;
          }
          if (typeof result.medians.temperatureC === "number") {
            featureStatistics.tempMedian = result.medians.temperatureC;
          }
        }
        if (result.stds) {
          if (typeof result.stds.heartRate === "number") {
            featureStatistics.heartRateStd = result.stds.heartRate;
          }
          if (typeof result.stds.spo2 === "number") {
            featureStatistics.spo2Std = result.stds.spo2;
          }
          if (typeof result.stds.temperatureC === "number") {
            featureStatistics.tempStd = result.stds.temperatureC;
          }
        }
        if (typeof result.activeHeartRateMean === "number") {
          featureStatistics.activeHrMean = result.activeHeartRateMean;
        }
        if (typeof result.ecgBpmMean === "number") {
          featureStatistics.ecgBpmMean = result.ecgBpmMean;
        }
        const existingBaseSnap = await getDoc(doc(db, "baselines", baselineId));
        if (existingBaseSnap.exists()) {
          await updateDoc(doc(db, "baselines", baselineId), {
            learningStatus: nextStatus,
            featureStatistics,
            modelVersion: result.modelVersion.slice(0, 80),
            ...(selectedPatient.primaryCaregiverUid
              ? { primaryCaregiverUid: selectedPatient.primaryCaregiverUid }
              : {}),
            ...(selectedPatient.secondaryCaregiverUid
              ? { secondaryCaregiverUid: selectedPatient.secondaryCaregiverUid }
              : {}),
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(doc(db, "baselines", baselineId), {
            baselineId,
            patientId: selectedPatient.patientId,
            ownerUid: selectedPatient.ownerUid,
            ...(selectedPatient.primaryCaregiverUid
              ? { primaryCaregiverUid: selectedPatient.primaryCaregiverUid }
              : {}),
            ...(selectedPatient.secondaryCaregiverUid
              ? { secondaryCaregiverUid: selectedPatient.secondaryCaregiverUid }
              : {}),
            source: baseSource,
            learningStatus: nextStatus,
            featureStatistics,
            modelVersion: result.modelVersion.slice(0, 80),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        await writeAuditLog(
          { uid: user.uid, role: assignedRole ?? activeRole },
          "baseline_updated",
          `Baseline fitted for ${selectedPatient.displayName} (${result.sampleCount} ${baseSource} samples).`,
          selectedPatient.patientId
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `patients/${selectedPatient.patientId}`);
      }
    } else {
      const baseSource = result.source === "esp32_hardware" ? "esp32_hardware" : "simulator";
      const baselineId = sanitizeId(`${selectedPatient.patientId}_${baseSource}`, "base");
      const nowIso = new Date().toISOString();
      setSampleBaselines((prev) => {
        const nextRec: BaselineRecord = {
          baselineId,
          patientId: selectedPatient.patientId,
          ownerUid: selectedPatient.ownerUid,
          source: baseSource,
          learningStatus: nextStatus,
          featureStatistics: {
            heartRateMean: result.means.heartRate,
            heartRateMedian: result.medians?.heartRate,
            heartRateStd: result.stds?.heartRate,
            spo2Mean: result.means.spo2,
            spo2Median: result.medians?.spo2,
            spo2Std: result.stds?.spo2,
            tempMean: result.means.temperatureC,
            tempMedian: result.medians?.temperatureC,
            tempStd: result.stds?.temperatureC,
            activeHrMean: result.activeHeartRateMean ?? undefined,
            ecgBpmMean: result.ecgBpmMean ?? undefined,
            sampleCount: result.sampleCount,
          },
          modelVersion: result.modelVersion,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const idx = prev.findIndex((b) => b.baselineId === baselineId);
        if (idx >= 0) {
          const clone = [...prev];
          clone[idx] = { ...clone[idx], ...nextRec };
          return clone;
        }
        return [nextRec, ...prev];
      });
      setSamplePatients((prev) =>
        prev.map((p) =>
          p.patientId === selectedPatient.patientId
            ? {
                ...p,
                baselineStatus: nextStatus,
                baselineSamplesCount: result.sampleCount,
                baselineHeartRateMean: result.means.heartRate,
                baselineSpo2Mean: result.means.spo2,
                baselineTempMean: result.means.temperatureC,
                baselineSource: result.source,
                baselineModelTrained: result.trained,
                baselineModelVersion: result.modelVersion,
                baselineEcgBpmMean: result.ecgBpmMean ?? p.baselineEcgBpmMean,
                baselineActiveHrMean: result.activeHeartRateMean ?? p.baselineActiveHrMean,
              }
            : p
        )
      );
    }

    return { message: result.message, mlServiceConnected: result.mlServiceConnected };
  }, [readings, selectedPatient.patientId, systemSettings.baselineMinSamples, hasFirestoreWorkspace, user]);

  const markNotificationRead = useCallback(
    async (notificationId: string) => {
      setNotifications((prev) =>
        prev.map((n) =>
          n.notificationId === notificationId
            ? { ...n, read: true, readAt: new Date().toISOString() }
            : n
        )
      );
      try {
        await markPhase5NotificationRead(notificationId);
        await refreshPhase5Notifications();
      } catch {
        // Keep optimistic read update if notification exists only locally
      }
    },
    [refreshPhase5Notifications]
  );

  const acknowledgeAlert = useCallback(
    async (alertId: string, followUpAction: string, actorRoleOverride?: UserRole) => {
      const cleanNote = followUpAction.trim().slice(0, VALIDATION_LIMITS.MAX_FOLLOWUP_LEN);
      const actorRole = actorRoleOverride ?? assignedRole ?? activeRole;
      const defaultAckName = actorRole === "patient" ? "Monitored Patient" : "Caregiver On Duty";
      const ackName = (userProfile?.displayName || user?.displayName || defaultAckName).slice(
        0,
        VALIDATION_LIMITS.MAX_NAME_LEN
      );
      const ackUid = user?.uid || (actorRole === "patient" ? "sample_owner" : "demo_caregiver");

      // Sync with backend Phase 5 escalation engine (cancels pending timers if patient acked)
      try {
        const updatedBackend = await acknowledgePhase5Alert(alertId, {
          actorRole,
          actorName: ackName,
          followUpAction: cleanNote || undefined,
        });
        setBackendAlerts((prev) =>
          prev.some((a) => a.alertId === alertId)
            ? prev.map((a) => (a.alertId === alertId ? updatedBackend : a))
            : [updatedBackend, ...prev]
        );
      } catch {
        // Alert may be Firestore-only from earlier turn; continue Firestore/local update
      }

      if (!usingSampleData && user) {
        const target = alerts.find((a) => a.alertId === alertId);
        if (target && firestoreAlerts.some((fa) => fa.alertId === alertId)) {
          try {
            const patientId = target.patientId ?? selectedPatient.patientId;
            await updateDoc(doc(db, "patients", patientId, "alerts", alertId), {
              status: "acknowledged",
              acknowledgedByUid: ackUid,
              acknowledgedByName: ackName,
              followUpAction: cleanNote || `Alert acknowledged by ${actorRole}.`,
              ...(actorRole === "patient"
                ? {
                    patientAcknowledged: true,
                    unreadByPatient: false,
                    escalationStatus: "patient_acknowledged",
                  }
                : {
                    unreadByCaregiver: false,
                    escalationStatus: "caregiver_acknowledged",
                  }),
              updatedAt: serverTimestamp(),
            });
            await writeAuditLog(
              { uid: user.uid, role: actorRole },
              "alert_acknowledged",
              `Alert ${alertId} acknowledged by ${ackName} (${actorRole}).`,
              alertId
            );
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `alerts/${alertId}`);
          }
        }
      } else {
        setSampleAlerts((prev) =>
          prev.map((a) =>
            a.alertId === alertId
              ? {
                  ...a,
                  status: "acknowledged",
                  acknowledgedByUid: ackUid,
                  acknowledgedByName: ackName,
                  followUpAction: cleanNote || `Alert acknowledged by ${actorRole}.`,
                  ...(actorRole === "patient"
                    ? {
                        patientAcknowledged: true,
                        unreadByPatient: false,
                        escalationStatus: "patient_acknowledged",
                      }
                    : {
                        unreadByCaregiver: false,
                        escalationStatus: "caregiver_acknowledged",
                      }),
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      }
      void refreshPhase5Notifications();
    },
    [
      user,
      userProfile,
      usingSampleData,
      alerts,
      firestoreAlerts,
      selectedPatient.patientId,
      assignedRole,
      activeRole,
      writeAuditLog,
      refreshPhase5Notifications,
    ]
  );

  const reportFalseAlert = useCallback(
    async (alertId: string, reason: string, actorRoleOverride?: UserRole) => {
      const cleanReason =
        reason.trim().slice(0, 300) || "Reported as false alert (sensor artifact / normal activity).";
      const actorRole = actorRoleOverride ?? assignedRole ?? activeRole;
      const actorName = (
        userProfile?.displayName ||
        user?.displayName ||
        (actorRole === "patient" ? "Monitored Patient" : "Caregiver On Duty")
      ).slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      const ackUid = user?.uid || (actorRole === "patient" ? "sample_owner" : "demo_caregiver");

      try {
        const updatedBackend = await reportPhase5FalseAlert(alertId, {
          actorRole,
          actorName,
          reason: cleanReason,
        });
        setBackendAlerts((prev) =>
          prev.some((a) => a.alertId === alertId)
            ? prev.map((a) => (a.alertId === alertId ? updatedBackend : a))
            : [updatedBackend, ...prev]
        );
      } catch {
        // Continue with Firestore/local update if backend alert does not exist
      }

      if (!usingSampleData && user) {
        const target = alerts.find((a) => a.alertId === alertId);
        if (target && firestoreAlerts.some((fa) => fa.alertId === alertId)) {
          try {
            const patientId = target.patientId ?? selectedPatient.patientId;
            await updateDoc(doc(db, "patients", patientId, "alerts", alertId), {
              status: "resolved",
              falseAlertReported: true,
              falseAlertReason: cleanReason,
              acknowledgedByUid: ackUid,
              acknowledgedByName: actorName,
              followUpAction: `False Alert: ${cleanReason}`.slice(0, VALIDATION_LIMITS.MAX_FOLLOWUP_LEN),
              unreadByPatient: false,
              unreadByCaregiver: false,
              escalationStatus: "false_alert",
              updatedAt: serverTimestamp(),
            });
            await writeAuditLog(
              { uid: user.uid, role: actorRole },
              "alert_marked_false",
              `Alert ${alertId} flagged as false alert by ${actorName}: ${cleanReason}`,
              alertId
            );
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `alerts/${alertId}`);
          }
        }
      } else {
        setSampleAlerts((prev) =>
          prev.map((a) =>
            a.alertId === alertId
              ? {
                  ...a,
                  status: "resolved",
                  falseAlertReported: true,
                  falseAlertReason: cleanReason,
                  falseAlertReportedAt: new Date().toISOString(),
                  acknowledgedByUid: ackUid,
                  acknowledgedByName: actorName,
                  followUpAction: `False Alert: ${cleanReason}`,
                  unreadByPatient: false,
                  unreadByCaregiver: false,
                  escalationStatus: "false_alert",
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      }
      void refreshPhase5Notifications();
    },
    [
      user,
      userProfile,
      usingSampleData,
      alerts,
      firestoreAlerts,
      selectedPatient.patientId,
      assignedRole,
      activeRole,
      writeAuditLog,
      refreshPhase5Notifications,
    ]
  );

  const resolveAlert = useCallback(
    async (alertId: string, followUpAction: string, actorRoleOverride?: UserRole) => {
      const cleanNote = followUpAction.trim().slice(0, VALIDATION_LIMITS.MAX_FOLLOWUP_LEN);
      const actorRole = actorRoleOverride ?? assignedRole ?? activeRole;
      const ackName = (userProfile?.displayName || user?.displayName || "Caregiver On Duty").slice(
        0,
        VALIDATION_LIMITS.MAX_NAME_LEN
      );
      const ackUid = user?.uid || "demo_caregiver";

      try {
        const updatedBackend = await resolvePhase5Alert(alertId, {
          actorRole,
          actorName: ackName,
          followUpAction: cleanNote || undefined,
        });
        setBackendAlerts((prev) =>
          prev.some((a) => a.alertId === alertId)
            ? prev.map((a) => (a.alertId === alertId ? updatedBackend : a))
            : [updatedBackend, ...prev]
        );
      } catch {
        // Continue with Firestore/local update
      }

      if (!usingSampleData && user) {
        const target = alerts.find((a) => a.alertId === alertId);
        if (target && firestoreAlerts.some((fa) => fa.alertId === alertId)) {
          try {
            const patientId = target.patientId ?? selectedPatient.patientId;
            await updateDoc(doc(db, "patients", patientId, "alerts", alertId), {
              status: "resolved",
              acknowledgedByUid: ackUid,
              acknowledgedByName: ackName,
              followUpAction: cleanNote || "Follow-up completed and alert resolved.",
              unreadByPatient: false,
              unreadByCaregiver: false,
              escalationStatus: "resolved",
              updatedAt: serverTimestamp(),
            });
            await writeAuditLog(
              { uid: user.uid, role: actorRole },
              "alert_resolved",
              `Alert ${alertId} resolved by ${ackName}.`,
              alertId
            );
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `alerts/${alertId}`);
          }
        }
      } else {
        setSampleAlerts((prev) =>
          prev.map((a) =>
            a.alertId === alertId
              ? {
                  ...a,
                  status: "resolved",
                  acknowledgedByUid: ackUid,
                  acknowledgedByName: ackName,
                  followUpAction: cleanNote || "Follow-up completed and alert resolved.",
                  unreadByPatient: false,
                  unreadByCaregiver: false,
                  escalationStatus: "resolved",
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      }
      void refreshPhase5Notifications();
    },
    [
      user,
      userProfile,
      usingSampleData,
      alerts,
      firestoreAlerts,
      selectedPatient.patientId,
      assignedRole,
      activeRole,
      writeAuditLog,
      refreshPhase5Notifications,
    ]
  );

  const reportWebcamFallDetection = useCallback(
    async (input: {
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
    }) => {
      const targetPatient = selectedPatient;
      const res = await reportFallDetectionEvent({
        patientId: targetPatient.patientId,
        patientName: targetPatient.displayName,
        patientOwnerUid: targetPatient.ownerUid || user?.uid || "sample_owner",
        primaryCaregiverUid: targetPatient.primaryCaregiverUid,
        secondaryCaregiverUid: targetPatient.secondaryCaregiverUid,
        ...input,
      });

      if (res.fallEvent) {
        setBackendFallEvents((prev) => [
          res.fallEvent!,
          ...prev.filter((e) => e.eventId !== res.fallEvent!.eventId),
        ]);
        if (hasFirestoreWorkspace && user && targetPatient.ownerUid === user.uid) {
          try {
            const eventId = sanitizeId(res.fallEvent.eventId, "fall");
            const fallDoc: Record<string, unknown> = {
              eventId,
              alertId: sanitizeId(res.fallEvent.alertId, "al"),
              patientId: targetPatient.patientId,
              ownerUid: targetPatient.ownerUid,
              detectionMode: res.fallEvent.detectionMode,
              isSimulated: Boolean(res.fallEvent.isSimulated),
              state: res.fallEvent.state,
              status: res.fallEvent.status,
              reason: res.fallEvent.reason.slice(0, 600),
              confidence: Math.max(0, Math.min(1, Number(res.fallEvent.confidence))),
              torsoAngleDeg: Math.max(0, Math.min(180, Number(res.fallEvent.torsoAngleDeg))),
              verticalVelocity: Math.max(-20, Math.min(20, Number(res.fallEvent.verticalVelocity ?? 0))),
              horizontalDurationSec: Math.max(
                0,
                Math.min(3600, Number(res.fallEvent.horizontalDurationSec ?? 0))
              ),
              peopleCount: Math.max(0, Math.min(20, Math.round(res.fallEvent.peopleCount ?? 1))),
              sensorFusionStatus: res.fallEvent.sensorFusionStatus,
              ...(res.fallEvent.wearableSummary
                ? { wearableSummary: res.fallEvent.wearableSummary.slice(0, 240) }
                : {}),
              location: res.fallEvent.location ?? null,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            };
            if (targetPatient.primaryCaregiverUid) {
              fallDoc.primaryCaregiverUid = targetPatient.primaryCaregiverUid;
            }
            if (targetPatient.secondaryCaregiverUid) {
              fallDoc.secondaryCaregiverUid = targetPatient.secondaryCaregiverUid;
            }
            await setDoc(doc(db, "patients", targetPatient.patientId, "fallEvents", eventId), fallDoc);

            if (res.alert) {
              const alertId = sanitizeId(res.alert.alertId, "al");
              await setDoc(doc(db, "patients", targetPatient.patientId, "alerts", alertId), {
                alertId,
                patientId: targetPatient.patientId,
                ownerUid: targetPatient.ownerUid,
                ...(targetPatient.primaryCaregiverUid
                  ? { primaryCaregiverUid: targetPatient.primaryCaregiverUid }
                  : {}),
                ...(targetPatient.secondaryCaregiverUid
                  ? { secondaryCaregiverUid: targetPatient.secondaryCaregiverUid }
                  : {}),
                level: res.alert.level,
                status: res.alert.status,
                title: res.alert.title.slice(0, VALIDATION_LIMITS.MAX_TITLE_LEN),
                explanation: res.alert.explanation.slice(0, VALIDATION_LIMITS.MAX_ALERT_EXPLANATION_LEN),
                triggeredMetrics: res.alert.triggeredMetrics.slice(0, 8),
                source: res.alert.source,
                fallEventId: eventId,
                sensorFusionStatus: res.fallEvent.sensorFusionStatus,
                prototypeNotice: (
                  res.alert.prototypeNotice ||
                  "Prototype computer vision fall monitoring — not a clinical diagnosis."
                ).slice(0, 240),
                patientAcknowledged: false,
                falseAlertReported: false,
                unreadByPatient: true,
                unreadByCaregiver: res.alert.unreadByCaregiver ?? false,
                notificationStatus: res.alert.notificationStatus ?? "simulated",
                escalationStatus: (res.alert.escalationStatus || "awaiting_patient_ack").slice(0, 64),
                callEscalationStatus: res.alert.callEscalationStatus,
                callLog: res.alert.callLog.slice(0, 12),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            }
          } catch {
            // Keep backend event active even if Firestore write fails for non-owner role
          }
        } else if (usingSampleData) {
          setSampleFallEvents((prev) => [
            res.fallEvent!,
            ...prev.filter((e) => e.eventId !== res.fallEvent!.eventId),
          ]);
          if (res.alert) {
            setSampleAlerts((prev) => [res.alert!, ...prev]);
          }
        }
      }

      if (res.notifications.length > 0) {
        setNotifications((prev) => [...res.notifications, ...prev]);
      }
      void refreshPhase5Notifications();
      return {
        eventCreated: res.eventCreated,
        duplicateSuppressed: res.duplicateSuppressed,
        fallEvent: res.fallEvent,
      };
    },
    [selectedPatient, user, hasFirestoreWorkspace, usingSampleData, refreshPhase5Notifications]
  );

  const cancelFallAlertSafe = useCallback(
    async (eventId: string, reason?: string) => {
      const actorRole = assignedRole ?? activeRole;
      const actorName = (
        userProfile?.displayName ||
        user?.displayName ||
        (actorRole === "patient" ? "Monitored Patient" : "Caregiver")
      ).slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      const updated = await cancelFallDetectionSafe(eventId, {
        actorRole,
        actorName,
        reason: reason?.trim() || "User clicked 'I'm Safe – Cancel Alert'.",
      });
      setBackendFallEvents((prev) => prev.map((e) => (e.eventId === eventId ? updated : e)));
      setSampleFallEvents((prev) => prev.map((e) => (e.eventId === eventId ? updated : e)));

      if (hasFirestoreWorkspace && user) {
        try {
          await updateDoc(doc(db, "patients", updated.patientId, "fallEvents", sanitizeId(eventId, "fall")), {
            status: "cancelled_safe",
            cancelledBy: (updated.cancelledBy ?? actorName).slice(0, 100),
            cancellationReason: (updated.cancellationReason ?? "User confirmed safe.").slice(0, 300),
            updatedAt: serverTimestamp(),
          });
          if (updated.alertId) {
            await updateDoc(doc(db, "patients", updated.patientId, "alerts", sanitizeId(updated.alertId, "al")), {
              status: "resolved",
              patientAcknowledged: true,
              unreadByPatient: false,
              unreadByCaregiver: false,
              escalationStatus: "resolved",
              followUpAction: "I'm Safe – Alert Cancelled",
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
        } catch {
          // Non-fatal if Firestore event is backend-only
        }
      }
      void refreshPhase5Notifications();
    },
    [assignedRole, activeRole, userProfile, user, hasFirestoreWorkspace, refreshPhase5Notifications]
  );

  const requestFallHelp = useCallback(
    async (eventId: string, reason?: string) => {
      const actorRole = assignedRole ?? activeRole;
      const actorName = (
        userProfile?.displayName ||
        user?.displayName ||
        (actorRole === "patient" ? "Monitored Patient" : "Caregiver")
      ).slice(0, VALIDATION_LIMITS.MAX_NAME_LEN);
      const { fallEvent: updated, alert: updatedAlert } = await requestFallDetectionHelp(eventId, {
        actorRole,
        actorName,
        reason: reason?.trim() || "User pressed SEND HELP / NOT SAFE.",
      });
      setBackendFallEvents((prev) =>
        prev.some((e) => e.eventId === eventId)
          ? prev.map((e) => (e.eventId === eventId ? updated : e))
          : [updated, ...prev]
      );
      setSampleFallEvents((prev) => prev.map((e) => (e.eventId === eventId ? updated : e)));
      if (updatedAlert) {
        setBackendAlerts((prev) =>
          prev.some((a) => a.alertId === updatedAlert.alertId)
            ? prev.map((a) => (a.alertId === updatedAlert.alertId ? updatedAlert : a))
            : [updatedAlert, ...prev]
        );
      }

      if (hasFirestoreWorkspace && user) {
        try {
          await updateDoc(doc(db, "patients", updated.patientId, "fallEvents", sanitizeId(eventId, "fall")), {
            status: "escalated",
            updatedAt: serverTimestamp(),
          });
          if (updated.alertId) {
            await updateDoc(doc(db, "patients", updated.patientId, "alerts", sanitizeId(updated.alertId, "al")), {
              escalationStatus: "escalated_to_caregiver",
              unreadByCaregiver: true,
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          }
        } catch {
          // Non-fatal if Firestore doc does not exist
        }
      }
      void refreshPhase5Notifications();
    },
    [assignedRole, activeRole, userProfile, user, hasFirestoreWorkspace, refreshPhase5Notifications]
  );

  const dismissEmergencyOverlay = useCallback((eventId: string) => {
    setDismissedFallEventIds((prev) => (prev.includes(eventId) ? prev : [...prev, eventId]));
  }, []);

  const postCameraStatusTelemetry = useCallback(
    async (input: {
      cameraStatus: CameraMonitoringStatus;
      deviceLabel?: string;
      peopleCount: number;
      poseConfidence: number;
      sensorDisagreement?: boolean;
      errorMessage?: string;
    }) => {
      try {
        const snapshot = await postCameraTelemetry({
          patientId: selectedPatient.patientId,
          patientOwnerUid: selectedPatient.ownerUid || user?.uid || "sample_owner",
          ...input,
        });
        setLatestCameraTelemetry(snapshot);
      } catch {
        // Non-fatal camera telemetry update
      }
    },
    [selectedPatient.patientId, selectedPatient.ownerUid, user?.uid]
  );

  const updateNotificationConfig = useCallback(
    async (patch: Partial<Omit<NotificationEscalationConfig, "updatedAt" | "updatedByUid">>) => {
      const res = await saveNotificationEscalationConfig(patch);
      setNotificationConfig(res.config);
      setNotificationProviders(res.providers);
      void refreshPhase5Notifications();
      return res.config;
    },
    [refreshPhase5Notifications]
  );

  const updateAlertEscalation = useCallback(
    async (alertId: string, status: CallEscalationStatus, newLogEntries: string[]) => {
      const boundedLog = newLogEntries.slice(-12);
      if (hasFirestoreWorkspace && user) {
        try {
          const target = alerts.find((a) => a.alertId === alertId);
          const patientId = target?.patientId ?? selectedPatient.patientId;
          await updateDoc(doc(db, "patients", patientId, "alerts", alertId), {
            callEscalationStatus: status,
            callLog: boundedLog,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `alerts/${alertId}`);
        }
      } else {
        setSampleAlerts((prev) =>
          prev.map((a) =>
            a.alertId === alertId
              ? {
                  ...a,
                  callEscalationStatus: status,
                  callLog: boundedLog,
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      }
    },
    [hasFirestoreWorkspace, user, alerts, selectedPatient.patientId]
  );

  const saveDeviceConfig = useCallback(
    async (input: {
      deviceId: string;
      label: string;
      pulseOxChipVariant: string;
      ecgSensor?: string;
      tempSensor: string;
      samplingIntervalMs: number;
      firmwareVersion: string;
    }) => {
      const safeId = sanitizeId(input.deviceId, "esp32");
      const ecgVal = (input.ecgSensor || "AD8232 Provisional ECG (ADC1 + LO+/LO-)").slice(0, 60);
      const targetPt = selectedPatient;
      if (!usingSampleData && user) {
        try {
          const existing = firestoreDevices.find((d) => d.deviceId === safeId);
          if (existing) {
            await updateDoc(doc(db, "devices", safeId), {
              label: input.label.slice(0, 100),
              pulseOxChipVariant: input.pulseOxChipVariant.slice(0, 60),
              ecgSensor: ecgVal,
              tempSensor: input.tempSensor.slice(0, 60),
              samplingIntervalMs: Math.max(250, Math.min(60000, Math.round(input.samplingIntervalMs))),
              firmwareVersion: input.firmwareVersion.slice(0, 40),
              updatedAt: serverTimestamp(),
            });
          } else {
            await setDoc(doc(db, "devices", safeId), {
              deviceId: safeId,
              label: input.label.slice(0, 100),
              patientId: targetPt.patientId,
              ownerUid: targetPt.ownerUid || user.uid,
              ...(targetPt.primaryCaregiverUid
                ? { primaryCaregiverUid: targetPt.primaryCaregiverUid }
                : {}),
              ...(targetPt.secondaryCaregiverUid
                ? { secondaryCaregiverUid: targetPt.secondaryCaregiverUid }
                : {}),
              boardType: "ESP32 DevKit v1 (Wi-Fi)",
              pulseOxChipVariant: input.pulseOxChipVariant.slice(0, 60),
              ecgSensor: ecgVal,
              imuSensor: "MPU6050 6-Axis IMU",
              tempSensor: input.tempSensor.slice(0, 60),
              displayModule: "0.96-inch SSD1306 I2C OLED (128x64)",
              hapticModule: "Vibration Motor (Transistor/MOSFET Driver)",
              samplingIntervalMs: Math.max(250, Math.min(60000, Math.round(input.samplingIntervalMs))),
              connectionStatus: "not_connected",
              firmwareVersion: input.firmwareVersion.slice(0, 40),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
          await writeAuditLog(
            { uid: user.uid, role: assignedRole ?? activeRole },
            "device_saved",
            `Updated wearable device configuration for ${safeId}.`,
            safeId
          );
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `devices/${safeId}`);
        }
      } else {
        setSampleDevices((prev) => {
          const idx = prev.findIndex((d) => d.deviceId === safeId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], ...input, ecgSensor: ecgVal, updatedAt: new Date().toISOString() };
            return copy;
          }
          return [
            ...prev,
            {
              deviceId: safeId,
              label: input.label,
              patientId: targetPt.patientId,
              ownerUid: targetPt.ownerUid,
              boardType: "ESP32 DevKit v1 (Wi-Fi)",
              pulseOxChipVariant: input.pulseOxChipVariant,
              ecgSensor: ecgVal,
              imuSensor: "MPU6050 6-Axis IMU",
              tempSensor: input.tempSensor,
              displayModule: "0.96-inch SSD1306 I2C OLED (128x64)",
              hapticModule: "Vibration Motor (Transistor/MOSFET Driver)",
              samplingIntervalMs: input.samplingIntervalMs,
              connectionStatus: "not_connected",
              firmwareVersion: input.firmwareVersion,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
        });
      }
    },
    [usingSampleData, user, firestoreDevices, selectedPatient, assignedRole, activeRole, writeAuditLog]
  );

  const adminUpdateDevice = useCallback(
    async (
      deviceId: string,
      patch: {
        connectionStatus?: "not_connected" | "streaming" | "offline";
        samplingIntervalMs?: number;
        label?: string;
      }
    ) => {
      if (!usingSampleData && user) {
        try {
          const updatePayload: Record<string, unknown> = {
            updatedAt: serverTimestamp(),
          };
          if (patch.connectionStatus) updatePayload.connectionStatus = patch.connectionStatus;
          if (typeof patch.samplingIntervalMs === "number") {
            updatePayload.samplingIntervalMs = Math.max(
              250,
              Math.min(60000, Math.round(patch.samplingIntervalMs))
            );
          }
          if (patch.label?.trim()) {
            updatePayload.label = patch.label.trim().slice(0, 100);
          }
          await updateDoc(doc(db, "devices", deviceId), updatePayload);
          await writeAuditLog(
            { uid: user.uid, role: assignedRole ?? activeRole },
            "device_status_updated",
            `Updated device ${deviceId} status (${patch.connectionStatus ?? "config"}).`,
            deviceId
          );
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `devices/${deviceId}`);
        }
      } else {
        setSampleDevices((prev) =>
          prev.map((d) =>
            d.deviceId === deviceId
              ? { ...d, ...patch, updatedAt: new Date().toISOString() }
              : d
          )
        );
      }
    },
    [usingSampleData, user, assignedRole, activeRole, writeAuditLog]
  );

  const addCareLink = useCallback(
    async (input: {
      patientId?: string;
      caregiverName: string;
      caregiverUid: string;
      priority: "primary" | "secondary";
      relationship?: string;
      permissions?: CarePermissions;
    }) => {
      const targetPt =
        (input.patientId ? patients.find((p) => p.patientId === input.patientId) : undefined) ??
        selectedPatient;
      if (!targetPt || !targetPt.patientId || targetPt.patientId === "unassigned_patient") {
        throw new Error("Select a valid registered patient profile before linking a caregiver.");
      }

      const linkId = sanitizeId(`link_${Date.now()}`, "link");
      const cgUid = sanitizeId(input.caregiverUid, "cg");
      const cgName = input.caregiverName.trim().slice(0, VALIDATION_LIMITS.MAX_NAME_LEN) || "Caregiver";
      const permissions: CarePermissions = {
        viewReadings: input.permissions?.viewReadings ?? true,
        acknowledgeAlerts: input.permissions?.acknowledgeAlerts ?? true,
        receiveCalls: input.permissions?.receiveCalls ?? true,
      };
      const relationship = input.relationship?.trim().slice(0, 60) || "Family / Caregiver";

      if (!usingSampleData && user) {
        try {
          await setDoc(doc(db, "careLinks", linkId), {
            linkId,
            patientId: targetPt.patientId,
            patientName: targetPt.displayName.slice(0, VALIDATION_LIMITS.MAX_NAME_LEN),
            patientOwnerUid: targetPt.ownerUid,
            caregiverUid: cgUid,
            caregiverName: cgName,
            priority: input.priority,
            status: "active",
            relationship,
            permissions,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          const patientPatch: Record<string, unknown> = {
            updatedAt: serverTimestamp(),
          };
          if (input.priority === "primary") {
            patientPatch.primaryCaregiverUid = cgUid;
            patientPatch.primaryCaregiverName = cgName;
          } else {
            patientPatch.secondaryCaregiverUid = cgUid;
            patientPatch.secondaryCaregiverName = cgName;
          }
          await updateDoc(doc(db, "patients", targetPt.patientId), patientPatch);

          const linkedDevices = firestoreDevices.filter((d) => d.patientId === targetPt.patientId);
          for (const dev of linkedDevices) {
            await updateDoc(doc(db, "devices", dev.deviceId), {
              ...(input.priority === "primary"
                ? { primaryCaregiverUid: cgUid }
                : { secondaryCaregiverUid: cgUid }),
              updatedAt: serverTimestamp(),
            });
          }

          await writeAuditLog(
            { uid: user.uid, role: assignedRole ?? activeRole },
            "care_link_created",
            `Linked ${input.priority} caregiver ${cgName} (${cgUid}) to ${targetPt.displayName}.`,
            linkId
          );
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `careLinks/${linkId}`);
        }
      } else {
        setSampleCareLinks((prev) => [
          ...prev,
          {
            linkId,
            patientId: targetPt.patientId,
            patientName: targetPt.displayName,
            patientOwnerUid: targetPt.ownerUid,
            caregiverUid: cgUid,
            caregiverName: cgName,
            priority: input.priority,
            status: "active",
            relationship,
            permissions,
          },
        ]);
      }
    },
    [usingSampleData, user, patients, selectedPatient, firestoreDevices, assignedRole, activeRole, writeAuditLog]
  );

  const updateCareLinkStatus = useCallback(
    async (linkId: string, status: "active" | "pending" | "revoked") => {
      if (!usingSampleData && user) {
        try {
          await updateDoc(doc(db, "careLinks", linkId), {
            status,
            updatedAt: serverTimestamp(),
          });
          await writeAuditLog(
            { uid: user.uid, role: assignedRole ?? activeRole },
            "care_link_updated",
            `Updated caregiver relationship ${linkId} status to ${status}.`,
            linkId
          );
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `careLinks/${linkId}`);
        }
      } else {
        setSampleCareLinks((prev) =>
          prev.map((l) => (l.linkId === linkId ? { ...l, status } : l))
        );
      }
    },
    [usingSampleData, user, assignedRole, activeRole, writeAuditLog]
  );

  const adminUpdateUserAccount = useCallback(
    async (
      targetUid: string,
      patch: {
        role?: UserRole;
        accountStatus?: AccountStatus;
      }
    ) => {
      if (!user || !isAdminUser) {
        throw new Error("Administrator authorization required to modify user accounts.");
      }
      try {
        const updatePayload: Record<string, unknown> = {
          updatedAt: serverTimestamp(),
        };
        if (patch.role) updatePayload.role = patch.role;
        if (patch.accountStatus) updatePayload.accountStatus = patch.accountStatus;

        await updateDoc(doc(db, "users", targetUid), updatePayload);

        if (patch.role === "admin") {
          const targetUser = firestoreUsers.find((u) => u.uid === targetUid);
          await setDoc(doc(db, "admins", targetUid), {
            uid: targetUid,
            displayName: targetUser?.displayName ?? "AROVA Admin",
            role: "admin",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else if (patch.role) {
          try {
            await deleteDoc(doc(db, "admins", targetUid));
          } catch {
            // Ignore if not present
          }
        }

        await writeAuditLog(
          { uid: user.uid, role: "admin" },
          "admin_user_updated",
          `Admin updated account ${targetUid} (${[
            patch.role ? `role=${patch.role}` : null,
            patch.accountStatus ? `status=${patch.accountStatus}` : null,
          ]
            .filter(Boolean)
            .join(", ")}).`,
          targetUid
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${targetUid}`);
      }
    },
    [user, isAdminUser, firestoreUsers, writeAuditLog]
  );

  const updateSystemSettings = useCallback(
    async (next: {
      escalationTimeoutSec: number;
      baselineMinSamples: number;
      samplingDefaultMs: number;
      warningPersistenceWindows?: number;
      criticalPersistenceWindows?: number;
      anomalyScoreThreshold?: number;
      retryIntervalSec?: number;
      maxCallAttempts?: number;
      fallbackNotificationEnabled?: boolean;
    }) => {
      const clamped = {
        settingId: "global",
        escalationTimeoutSec: Math.max(10, Math.min(600, Math.round(next.escalationTimeoutSec))),
        baselineMinSamples: Math.max(5, Math.min(5000, Math.round(next.baselineMinSamples))),
        samplingDefaultMs: Math.max(500, Math.min(60000, Math.round(next.samplingDefaultMs))),
        warningPersistenceWindows: Math.max(
          1,
          Math.min(10, Math.round(next.warningPersistenceWindows ?? systemSettings.warningPersistenceWindows ?? 2))
        ),
        criticalPersistenceWindows: Math.max(
          1,
          Math.min(15, Math.round(next.criticalPersistenceWindows ?? systemSettings.criticalPersistenceWindows ?? 3))
        ),
        anomalyScoreThreshold: Math.max(
          -1.0,
          Math.min(0.5, Number(next.anomalyScoreThreshold ?? systemSettings.anomalyScoreThreshold ?? -0.05))
        ),
        retryIntervalSec: Math.max(
          10,
          Math.min(600, Math.round(next.retryIntervalSec ?? systemSettings.retryIntervalSec ?? 30))
        ),
        maxCallAttempts: Math.max(
          1,
          Math.min(5, Math.round(next.maxCallAttempts ?? systemSettings.maxCallAttempts ?? 2))
        ),
        fallbackNotificationEnabled:
          typeof next.fallbackNotificationEnabled === "boolean"
            ? next.fallbackNotificationEnabled
            : systemSettings.fallbackNotificationEnabled ?? true,
      };

      if (user && isAdminUser) {
        try {
          await setDoc(doc(db, "systemSettings", "global"), {
            ...clamped,
            ...(systemSettings.alertLevels ? { alertLevels: systemSettings.alertLevels } : {}),
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, "systemSettings/global");
        }
      } else {
        setSystemSettings({
          ...clamped,
          alertLevels: systemSettings.alertLevels,
          updatedByUid: user?.uid ?? "demo_admin_preview",
          updatedAt: new Date().toISOString(),
        });
      }
    },
    [user, isAdminUser, systemSettings]
  );

  const updateAlertLevelsPolicy = useCallback(
    async (next: AlertLevelsPolicyConfig): Promise<AlertLevelsPolicyConfig> => {
      if (user && isAdminUser) {
        const saved = await saveAlertLevelsPolicy(next);
        setAlertLevelsPolicy(saved);

        const highEsc = saved.levels.High.escalation;
        const medDet = saved.levels.Medium.detection;
        const highDet = saved.levels.High.detection;

        try {
          await setDoc(doc(db, "systemSettings", "global"), {
            settingId: "global",
            escalationTimeoutSec: systemSettings.escalationTimeoutSec,
            baselineMinSamples: systemSettings.baselineMinSamples,
            samplingDefaultMs: systemSettings.samplingDefaultMs,
            warningPersistenceWindows: Math.max(1, Math.min(10, medDet.minPersistenceWindows)),
            criticalPersistenceWindows: Math.max(1, Math.min(15, highDet.minPersistenceWindows)),
            anomalyScoreThreshold: medDet.anomalyScoreMaxThreshold,
            retryIntervalSec: highEsc.retryIntervalSec,
            maxCallAttempts: Math.max(1, Math.min(5, highEsc.maxCallAttempts || 2)),
            fallbackNotificationEnabled: systemSettings.fallbackNotificationEnabled ?? true,
            alertLevels: saved,
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, "systemSettings/global");
        }
        return saved;
      }

      const previewSaved: AlertLevelsPolicyConfig = {
        ...next,
        updatedAt: new Date().toISOString(),
        updatedByUid: user?.uid ?? "demo_admin_preview",
      };
      setAlertLevelsPolicy(previewSaved);
      return previewSaved;
    },
    [user, isAdminUser, systemSettings]
  );

  const resetAlertLevelsPolicyConfig = useCallback(async (): Promise<AlertLevelsPolicyConfig> => {
    if (user && isAdminUser) {
      const reset = await resetAlertLevelsPolicy();
      setAlertLevelsPolicy(reset);
      try {
        await setDoc(doc(db, "systemSettings", "global"), {
          settingId: "global",
          escalationTimeoutSec: systemSettings.escalationTimeoutSec,
          baselineMinSamples: systemSettings.baselineMinSamples,
          samplingDefaultMs: systemSettings.samplingDefaultMs,
          warningPersistenceWindows: reset.levels.Medium.detection.minPersistenceWindows,
          criticalPersistenceWindows: reset.levels.High.detection.minPersistenceWindows,
          anomalyScoreThreshold: reset.levels.Medium.detection.anomalyScoreMaxThreshold,
          retryIntervalSec: reset.levels.High.escalation.retryIntervalSec,
          maxCallAttempts: Math.max(1, reset.levels.High.escalation.maxCallAttempts),
          fallbackNotificationEnabled: systemSettings.fallbackNotificationEnabled ?? true,
          alertLevels: reset,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, "systemSettings/global");
      }
      return reset;
    }

    const previewReset: AlertLevelsPolicyConfig = {
      ...DEFAULT_ALERT_LEVELS_POLICY,
      updatedAt: new Date().toISOString(),
      updatedByUid: user?.uid ?? "demo_admin_preview",
    };
    setAlertLevelsPolicy(previewReset);
    return previewReset;
  }, [user, isAdminUser, systemSettings]);

  return (
    <SmartCareContext.Provider
      value={{
        authReady,
        authLoading,
        firestoreConnected,
        user,
        emailVerified,
        isAdminUser,
        assignedRole,
        activeRole,
        userProfile,
        privateContact,
        lastAuthRedirectRole,
        clearLastAuthRedirectRole,
        setActiveRole,
        signInWithGoogle,
        registerWithEmail,
        signInWithEmail,
        sendPasswordReset,
        resendVerificationEmail,
        refreshCurrentUser,
        signOutUser,
        authError,
        clearAuthError,
        usingSampleData,
        hasFirestoreWorkspace,
        initializeFirestoreWorkspace,
        updateProfileSettings,
        patients,
        selectedPatientId: selectedPatient.patientId,
        setSelectedPatientId,
        selectedPatient,
        readings,
        alerts,
        devices,
        careLinks,
        registeredUsers,
        baselines: hasFirestoreWorkspace ? firestoreBaselines : sampleBaselines,
        anomalyEvents: hasFirestoreWorkspace ? firestoreAnomalyEvents : sampleAnomalyEvents,
        auditLogs,
        liveHardwareSnapshot,
        ecgSegments,
        baselineStatusSummary,
        systemSettings,
        alertLevelsPolicy,
        integrations,
        refreshIntegrations,
        notifications,
        unreadNotificationCount,
        notificationConfig,
        notificationProviders,
        adminAlertStats,
        fallDetectionStats,
        notificationErrorLogs,
        fallEvents,
        activeEmergencyFallEvent,
        latestCameraTelemetry,
        refreshPhase5Notifications,
        markNotificationRead,
        reportWebcamFallDetection,
        cancelFallAlertSafe,
        requestFallHelp,
        dismissEmergencyOverlay,
        postCameraStatusTelemetry,
        injectSimulatorReading,
        registeredBackendDevices,
        refreshBackendDevices,
        registerDeviceWithBackend,
        setDeviceConnectionState,
        triggerDeviceVibrationCommand,
        simRunning,
        simMode,
        simDeviceConnected,
        simSensorError,
        simIntervalMs,
        simLastPacketSummary,
        startSimulation,
        stopSimulation,
        setSimMode,
        setSimIntervalMs,
        setSimSensorError,
        generateNormalReading,
        generateUnusualReading,
        disconnectSimulatedDevice,
        reconnectSimulatedDevice,
        fitBaselineForSelectedPatient,
        acknowledgeAlert,
        reportFalseAlert,
        resolveAlert,
        updateAlertEscalation,
        updateNotificationConfig,
        saveDeviceConfig,
        adminUpdateDevice,
        addCareLink,
        updateCareLinkStatus,
        adminUpdateUserAccount,
        updateSystemSettings,
        updateAlertLevelsPolicy,
        resetAlertLevelsPolicyConfig,
      }}
    >
      {children}
    </SmartCareContext.Provider>
  );
}

export function useSmartCare(): SmartCareContextValue {
  const ctx = useContext(SmartCareContext);
  if (!ctx) {
    throw new Error("useSmartCare must be used inside SmartCareProvider.");
  }
  return ctx;
}
