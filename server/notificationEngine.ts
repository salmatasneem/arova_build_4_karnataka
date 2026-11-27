import crypto from "node:crypto";
import {
  PROTOTYPE_ALERT_NOTICE,
  sharedAlertDecisionEngine,
} from "./alertDecisionEngine.ts";
import {
  dispatchEmailNotification,
  dispatchSmsNotification,
  dispatchVoiceCallNotification,
  getNotificationProvidersStatus,
  type ExternalDispatchResult,
} from "./notificationProviders.ts";
import { recordServerAuditEvent } from "./rbacRoutes.ts";
import type {
  AdminFallDetectionStats,
  CameraMonitoringStatus,
  CameraTelemetrySnapshot,
  EscalationHistoryEntry,
  FallDetectionEventRecord,
  FallDetectionLocation,
  FallDetectionState,
  FallSensorFusionStatus,
  InAppNotificationRecord,
  MlAnalysisResult,
  NotificationAttemptRecord,
  NotificationDeliveryStatus,
  NotificationEscalationConfig,
  Phase5AlertRecord,
  TelemetryPayload,
} from "./types.ts";

export interface AuthorizedCareLinkEntry {
  linkId: string;
  patientId: string;
  patientName?: string;
  patientOwnerUid: string;
  caregiverUid: string;
  caregiverName: string;
  caregiverEmail?: string;
  caregiverPhone?: string;
  explicitCallConsent?: boolean;
  priority: "primary" | "secondary";
  status: "active" | "pending" | "revoked";
  relationship?: string;
  permissions?: {
    viewReadings?: boolean;
    acknowledgeAlerts?: boolean;
    receiveCalls?: boolean;
  };
  updatedAt?: string;
}

export interface NotificationErrorLogEntry {
  errorId: string;
  alertId?: string;
  patientId?: string;
  channel: "in_app" | "sms" | "email" | "voice_call" | "escalation_engine";
  provider: string;
  message: string;
  timestamp: string;
}

export interface ProcessTelemetryAlertResult {
  monitoringState: "Normal" | "Warning" | "Critical";
  alertCreated: boolean;
  duplicateSuppressed: boolean;
  suppressedAlertId?: string;
  alert: Phase5AlertRecord | null;
  notifications: InAppNotificationRecord[];
}

export interface DispatchOverrideHooks {
  sms?: typeof dispatchSmsNotification;
  email?: typeof dispatchEmailNotification;
  voice?: typeof dispatchVoiceCallNotification;
}

const DEFAULT_NOTIFICATION_CONFIG: NotificationEscalationConfig = {
  patientAckTimeoutSec: 60,
  duplicateAlertWindowSec: 120,
  caregiverEscalationEnabled: true,
  escalateOnWarning: false,
  smsEnabled: true,
  emailEnabled: true,
  voiceEnabled: true,
  updatedAt: new Date().toISOString(),
  updatedByUid: "system_default",
};

export class NotificationEscalationEngine {
  private readonly alerts = new Map<string, Phase5AlertRecord>();
  private readonly notifications = new Map<string, InAppNotificationRecord>();
  private readonly careLinks = new Map<string, AuthorizedCareLinkEntry>();
  private readonly errorLogs: NotificationErrorLogEntry[] = [];
  private readonly escalationTimers = new Map<string, NodeJS.Timeout>();
  private readonly fallEvents = new Map<string, FallDetectionEventRecord>();
  private readonly cameraTelemetry = new Map<string, CameraTelemetrySnapshot>();
  private readonly cameraErrors: AdminFallDetectionStats["recentCameraErrors"] = [];
  private sensorDisagreementCount = 0;
  private config: NotificationEscalationConfig = { ...DEFAULT_NOTIFICATION_CONFIG };
  private dispatchHooks: DispatchOverrideHooks = {};

  public setDispatchHooksForTests(hooks: DispatchOverrideHooks): void {
    this.dispatchHooks = hooks;
  }

  public clearForTests(): void {
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    this.alerts.clear();
    this.notifications.clear();
    this.careLinks.clear();
    this.fallEvents.clear();
    this.cameraTelemetry.clear();
    this.cameraErrors.length = 0;
    this.sensorDisagreementCount = 0;
    this.errorLogs.length = 0;
    this.dispatchHooks = {};
    this.config = { ...DEFAULT_NOTIFICATION_CONFIG, updatedAt: new Date().toISOString() };
  }

  public getConfig(): NotificationEscalationConfig {
    return { ...this.config };
  }

  public updateConfig(
    patch: Partial<Omit<NotificationEscalationConfig, "updatedAt" | "updatedByUid">>,
    adminUid: string
  ): NotificationEscalationConfig {
    const clampInt = (val: unknown, min: number, max: number, fallback: number): number => {
      if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
      return Math.max(min, Math.min(max, Math.round(val)));
    };

    this.config = {
      patientAckTimeoutSec: clampInt(patch.patientAckTimeoutSec, 1, 3600, this.config.patientAckTimeoutSec),
      duplicateAlertWindowSec: clampInt(patch.duplicateAlertWindowSec, 0, 3600, this.config.duplicateAlertWindowSec),
      caregiverEscalationEnabled:
        typeof patch.caregiverEscalationEnabled === "boolean"
          ? patch.caregiverEscalationEnabled
          : this.config.caregiverEscalationEnabled,
      escalateOnWarning:
        typeof patch.escalateOnWarning === "boolean"
          ? patch.escalateOnWarning
          : this.config.escalateOnWarning,
      smsEnabled: typeof patch.smsEnabled === "boolean" ? patch.smsEnabled : this.config.smsEnabled,
      emailEnabled:
        typeof patch.emailEnabled === "boolean" ? patch.emailEnabled : this.config.emailEnabled,
      voiceEnabled:
        typeof patch.voiceEnabled === "boolean" ? patch.voiceEnabled : this.config.voiceEnabled,
      updatedAt: new Date().toISOString(),
      updatedByUid: adminUid,
    };

    recordServerAuditEvent({
      userId: adminUid,
      actorRole: "admin",
      eventType: "notification_escalation_config_updated",
      summary: `Updated escalation timing (${this.config.patientAckTimeoutSec}s ack wait, ${this.config.duplicateAlertWindowSec}s duplicate suppression).`,
    });

    return this.getConfig();
  }

  public syncCareLinks(links: AuthorizedCareLinkEntry[]): AuthorizedCareLinkEntry[] {
    for (const link of links) {
      if (!link?.linkId || !link.patientId || !link.caregiverUid) continue;
      this.upsertCareLink(link);
    }
    return this.listCareLinks();
  }

  public upsertCareLink(link: AuthorizedCareLinkEntry): AuthorizedCareLinkEntry {
    const normalized: AuthorizedCareLinkEntry = {
      ...link,
      linkId: link.linkId.trim(),
      patientId: link.patientId.trim(),
      patientOwnerUid: link.patientOwnerUid.trim(),
      caregiverUid: link.caregiverUid.trim(),
      caregiverName: link.caregiverName.trim() || "Authorized Caregiver",
      caregiverEmail: link.caregiverEmail?.trim() || undefined,
      caregiverPhone: link.caregiverPhone?.trim() || undefined,
      explicitCallConsent: Boolean(link.explicitCallConsent),
      priority: link.priority === "secondary" ? "secondary" : "primary",
      status: link.status === "revoked" || link.status === "pending" ? link.status : "active",
      updatedAt: link.updatedAt || new Date().toISOString(),
    };
    this.careLinks.set(normalized.linkId, normalized);
    return normalized;
  }

  public listCareLinks(patientId?: string): AuthorizedCareLinkEntry[] {
    return Array.from(this.careLinks.values()).filter(
      (link) => !patientId || link.patientId === patientId
    );
  }

  public getAuthorizedCaregiversForPatient(patientId: string): AuthorizedCareLinkEntry[] {
    return Array.from(this.careLinks.values())
      .filter((link) => link.patientId === patientId && link.status === "active")
      .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "primary" ? -1 : 1));
  }

  public isAuthorizedCaregiverForPatient(uid: string, patientId: string, alert?: Phase5AlertRecord): boolean {
    if (!uid) return false;
    const linksForCaregiver = Array.from(this.careLinks.values()).filter(
      (l) => l.patientId === patientId && l.caregiverUid === uid
    );
    if (linksForCaregiver.length > 0) {
      return linksForCaregiver.some((l) => l.status === "active");
    }
    if (alert) {
      return alert.primaryCaregiverUid === uid || alert.secondaryCaregiverUid === uid;
    }
    return false;
  }

  public canUserAccessPatientAlert(
    caller: { uid?: string; isAdmin?: boolean } | null,
    alert: Phase5AlertRecord
  ): boolean {
    if (caller?.isAdmin) return true;
    if (!caller?.uid) {
      return alert.ownerUid === "sample_owner" || alert.patientId === "patient_primary";
    }
    if (alert.ownerUid === caller.uid) return true;
    return this.isAuthorizedCaregiverForPatient(caller.uid, alert.patientId, alert);
  }

  private cancelTimer(alertId: string): void {
    const timer = this.escalationTimers.get(alertId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(alertId);
    }
  }

  private logNotificationError(entry: Omit<NotificationErrorLogEntry, "errorId" | "timestamp">): void {
    this.errorLogs.unshift({
      ...entry,
      errorId: `nerr_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      timestamp: new Date().toISOString(),
    });
    if (this.errorLogs.length > 100) {
      this.errorLogs.length = 100;
    }
  }

  private appendHistory(
    alert: Phase5AlertRecord,
    stage: EscalationHistoryEntry["stage"],
    summary: string,
    actorUid?: string
  ): void {
    alert.escalationHistory.push({
      stepId: `step_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      stage,
      summary,
      actorUid,
      timestamp: new Date().toISOString(),
    });
  }

  private createInAppNotification(params: {
    alert: Phase5AlertRecord;
    recipientUid?: string;
    recipientRole: "patient" | "caregiver" | "admin";
    title: string;
    message: string;
    isSimulated: boolean;
  }): InAppNotificationRecord {
    const notification: InAppNotificationRecord = {
      notificationId: `notif_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      alertId: params.alert.alertId,
      patientId: params.alert.patientId,
      patientOwnerUid: params.alert.ownerUid,
      recipientUid: params.recipientUid,
      recipientRole: params.recipientRole,
      severity: params.alert.level,
      title: params.title,
      message: params.message,
      prototypeNotice: PROTOTYPE_ALERT_NOTICE,
      deliveryStatus: params.isSimulated ? "simulated" : "delivered",
      isSimulated: params.isSimulated,
      read: false,
      createdAt: new Date().toISOString(),
    };
    this.notifications.set(notification.notificationId, notification);
    return notification;
  }

  private computeOverallNotificationStatus(
    attempts: NotificationAttemptRecord[]
  ): Phase5AlertRecord["notificationStatus"] {
    if (attempts.length === 0) return "pending";
    const external = attempts.filter((a) => a.channel !== "in_app");
    const target = external.length > 0 ? external : attempts;
    const delivered = target.filter((a) => a.deliveryStatus === "delivered").length;
    const simulated = target.filter((a) => a.deliveryStatus === "simulated").length;
    const failed = target.filter((a) => a.deliveryStatus === "failed").length;

    if (failed > 0 && delivered === 0 && simulated === 0) return "failed";
    if (failed > 0) return "partial_failure";
    if (delivered > 0) return "delivered";
    if (simulated > 0) return "simulated";
    return "pending";
  }

  public async processTelemetryEvaluation(params: {
    telemetry: TelemetryPayload;
    analysis: MlAnalysisResult;
    patientName?: string;
    patientOwnerUid?: string;
    primaryCaregiverUid?: string;
    secondaryCaregiverUid?: string;
    publicBaseUrlOverride?: string;
    patientAckTimeoutMsOverride?: number;
  }): Promise<ProcessTelemetryAlertResult> {
    const { telemetry, analysis } = params;
    const level = analysis.alertLevel;

    if (level === "Normal") {
      return {
        monitoringState: "Normal",
        alertCreated: false,
        duplicateSuppressed: false,
        alert: null,
        notifications: [],
      };
    }

    const nowIso = new Date().toISOString();
    const newAlertId = `alert_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const source = telemetry.source ?? "simulator";

    const duplicateCheck = sharedAlertDecisionEngine.checkAndTrackDuplicateAlert({
      patientId: telemetry.patientId,
      source,
      level,
      triggeredMetrics: analysis.triggeredMetrics,
      newAlertId,
      duplicateWindowSec: this.config.duplicateAlertWindowSec,
    });

    if (duplicateCheck.duplicateSuppressed && duplicateCheck.existingAlertId) {
      const existing = this.alerts.get(duplicateCheck.existingAlertId) ?? null;
      if (existing) {
        existing.suppressedOccurrences += 1;
        existing.updatedAt = nowIso;
        existing.anomalyScore = analysis.anomalyScore;
        this.appendHistory(
          existing,
          "duplicate_suppressed",
          `Suppressed duplicate ${level} alert for ongoing ${analysis.triggeredMetrics.join(", ") || "anomaly"} event (occurrence #${existing.suppressedOccurrences + 1}).`
        );
      }
      return {
        monitoringState: level,
        alertCreated: false,
        duplicateSuppressed: true,
        suppressedAlertId: duplicateCheck.existingAlertId,
        alert: existing,
        notifications: [],
      };
    }

    const ownerUid = params.patientOwnerUid?.trim() || "sample_owner";
    const patientName = params.patientName?.trim() || `Patient (${telemetry.patientId})`;
    const isSimulatedSource = source !== "esp32_hardware";

    const alertTitle =
      analysis.triggeredMetrics.length > 0
        ? `${level} Prototype Alert: ${analysis.triggeredMetrics.join(" + ")}`
        : `${level} Prototype Anomaly Alert`;

    const alert: Phase5AlertRecord = {
      alertId: newAlertId,
      patientId: telemetry.patientId,
      ownerUid,
      primaryCaregiverUid: params.primaryCaregiverUid,
      secondaryCaregiverUid: params.secondaryCaregiverUid,
      level,
      status: "active",
      title: alertTitle,
      explanation: analysis.explanation,
      prototypeNotice: PROTOTYPE_ALERT_NOTICE,
      anomalyScore: analysis.anomalyScore,
      signalQuality: analysis.signalQuality,
      relevantReadings: {
        heartRate: telemetry.heartRate,
        spo2: telemetry.spo2,
        temperatureC: telemetry.temperatureC,
        accelMagnitude: telemetry.accelMagnitude,
        gyroMagnitude: telemetry.gyroMagnitude,
        movementStatus: telemetry.movementStatus,
        signalQuality: analysis.signalQuality,
      },
      triggeredMetrics: [...analysis.triggeredMetrics],
      source,
      patientAcknowledged: false,
      falseAlertReported: false,
      unreadByPatient: true,
      unreadByCaregiver: false,
      escalationStatus: "notified_patient",
      escalationHistory: [],
      notificationAttempts: [],
      notificationStatus: isSimulatedSource ? "simulated" : "delivered",
      suppressedOccurrences: 0,
      callEscalationStatus: "not_triggered",
      callLog: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.appendHistory(
      alert,
      "alert_created",
      `${level} prototype monitoring alert created (${alert.triggeredMetrics.join(", ") || "multivariate score"}; score ${analysis.anomalyScore.toFixed(3)}).`
    );

    const createdNotifications: InAppNotificationRecord[] = [];
    const patientNotif = this.createInAppNotification({
      alert,
      recipientUid: ownerUid,
      recipientRole: "patient",
      title: alert.title,
      message: `${alert.explanation} (${PROTOTYPE_ALERT_NOTICE})`,
      isSimulated: isSimulatedSource,
    });
    createdNotifications.push(patientNotif);

    alert.notificationAttempts.push({
      attemptId: `att_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      channel: "in_app",
      recipientRole: "patient",
      recipientUid: ownerUid,
      recipientName: patientName,
      provider: "AROVA In-App Notification Center",
      deliveryStatus: isSimulatedSource ? "simulated" : "delivered",
      isSimulated: isSimulatedSource,
      message: alert.explanation,
      timestamp: nowIso,
    });
    this.appendHistory(
      alert,
      "patient_notified",
      `Patient notified in-app (${isSimulatedSource ? "simulated telemetry source" : "live wearable telemetry"}).`
    );

    this.alerts.set(alert.alertId, alert);

    const shouldScheduleEscalation =
      this.config.caregiverEscalationEnabled &&
      (level === "Critical" || (level === "Warning" && this.config.escalateOnWarning));

    if (shouldScheduleEscalation) {
      const waitMs =
        typeof params.patientAckTimeoutMsOverride === "number" &&
        Number.isFinite(params.patientAckTimeoutMsOverride) &&
        params.patientAckTimeoutMsOverride >= 10
          ? params.patientAckTimeoutMsOverride
          : this.config.patientAckTimeoutSec * 1000;

      alert.escalationStatus = "awaiting_patient_ack";
      alert.escalationDueAt = new Date(Date.now() + waitMs).toISOString();
      this.appendHistory(
        alert,
        "awaiting_patient_ack",
        `Waiting up to ${Math.round(waitMs / 1000)}s for patient acknowledgement before escalating to authorized caregivers.`
      );

      const timer = setTimeout(() => {
        void this.escalateAlertToCaregivers(alert.alertId, {
          trigger: "patient_ack_timeout",
          publicBaseUrlOverride: params.publicBaseUrlOverride,
        });
      }, waitMs);
      timer.unref?.();
      this.escalationTimers.set(alert.alertId, timer);
    } else if (level === "Warning") {
      // Warning alerts notify linked authorized caregivers in-app immediately without starting emergency call escalation
      const caregivers = this.getAuthorizedCaregiversForPatient(alert.patientId);
      if (caregivers.length > 0) {
        alert.unreadByCaregiver = true;
        alert.escalationStatus = "notified_caregiver";
        for (const cg of caregivers) {
          const cgNotif = this.createInAppNotification({
            alert,
            recipientUid: cg.caregiverUid,
            recipientRole: "caregiver",
            title: `[Warning] ${alert.title}`,
            message: `${patientName}: ${alert.explanation}`,
            isSimulated: isSimulatedSource,
          });
          createdNotifications.push(cgNotif);
          alert.notificationAttempts.push({
            attemptId: `att_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
            channel: "in_app",
            recipientRole: "caregiver",
            recipientUid: cg.caregiverUid,
            recipientName: cg.caregiverName,
            provider: "AROVA In-App Caregiver Feed",
            deliveryStatus: isSimulatedSource ? "simulated" : "delivered",
            isSimulated: isSimulatedSource,
            message: alert.explanation,
            timestamp: new Date().toISOString(),
          });
        }
        this.appendHistory(
          alert,
          "caregiver_notified",
          `Sent non-escalation Warning notification to ${caregivers.length} authorized caregiver(s).`
        );
      }
    }

    alert.notificationStatus = this.computeOverallNotificationStatus(alert.notificationAttempts);
    alert.updatedAt = new Date().toISOString();

    return {
      monitoringState: level,
      alertCreated: true,
      duplicateSuppressed: false,
      alert,
      notifications: createdNotifications,
    };
  }

  public async escalateAlertToCaregivers(
    alertId: string,
    opts?: {
      trigger?: "patient_ack_timeout" | "user_help_requested" | "manual";
      publicBaseUrlOverride?: string;
    }
  ): Promise<Phase5AlertRecord | null> {
    const alert = this.alerts.get(alertId);
    if (!alert) return null;

    // Duplicate escalation & already-handled guard
    if (
      alert.escalatedToCaregiversAt ||
      alert.patientAcknowledged ||
      alert.falseAlertReported ||
      alert.status === "resolved" ||
      alert.status === "acknowledged"
    ) {
      this.cancelTimer(alertId);
      return alert;
    }

    this.cancelTimer(alertId);
    const nowIso = new Date().toISOString();
    const trigger = opts?.trigger ?? "patient_ack_timeout";
    const linkedFall = alert.fallEventId ? this.fallEvents.get(alert.fallEventId) : undefined;
    const isSimulatedFall = Boolean(linkedFall?.isSimulated || alert.source === "demo_simulation");
    const patientDisplayName = linkedFall?.patientName || alert.patientId;
    const isHelpRequested = trigger === "user_help_requested";

    alert.escalatedToCaregiversAt = nowIso;
    alert.escalationStatus = "escalated_to_caregiver";
    alert.updatedAt = nowIso;

    const authorizedCaregivers = this.getAuthorizedCaregiversForPatient(alert.patientId);
    this.appendHistory(
      alert,
      "escalated_to_caregiver",
      isHelpRequested
        ? `Patient pressed SEND HELP / NOT SAFE; notifying ${authorizedCaregivers.length} authorized linked caregiver(s).`
        : trigger === "manual"
        ? `Manual escalation triggered; notifying ${authorizedCaregivers.length} authorized linked caregiver(s).`
        : `Patient did not respond to safety confirmation within timeout; notifying ${authorizedCaregivers.length} authorized linked caregiver(s).`
    );

    if (authorizedCaregivers.length === 0) {
      this.logNotificationError({
        alertId: alert.alertId,
        patientId: alert.patientId,
        channel: "escalation_engine",
        provider: "AROVA Care Link Consent Registry",
        message: "No active authorized caregivers linked to this patient at escalation time.",
      });
      this.appendHistory(
        alert,
        "notification_failed",
        "Escalation paused: no active linked caregiver consent found for this patient."
      );
      alert.notificationStatus = this.computeOverallNotificationStatus(alert.notificationAttempts);
      if (linkedFall && linkedFall.status === "pending_confirmation") {
        linkedFall.status = "escalated";
        linkedFall.escalatedAt = nowIso;
        linkedFall.escalationTrigger = trigger;
        linkedFall.patientAckStatus = isHelpRequested ? "assistance_requested" : "unacknowledged";
        linkedFall.caregiverNotificationInitiated = false;
        linkedFall.notificationAttempts = [];
        linkedFall.updatedAt = nowIso;
      }
      return alert;
    }

    alert.unreadByCaregiver = true;
    const smsFn = this.dispatchHooks.sms ?? dispatchSmsNotification;
    const emailFn = this.dispatchHooks.email ?? dispatchEmailNotification;
    const voiceFn = this.dispatchHooks.voice ?? dispatchVoiceCallNotification;
    const isSimulatedSource = alert.source !== "esp32_hardware";

    const dashboardUrl = opts?.publicBaseUrlOverride
      ? `${opts.publicBaseUrlOverride.replace(/\/$/, "")}/?tab=caregiver`
      : "/?tab=caregiver";

    const fallCaregiverTitle = isSimulatedFall
      ? "[SIMULATED DEMO] AROVA – Possible Fall Alert"
      : "AROVA – Possible Fall Alert";
    const fallAckSummary = isHelpRequested
      ? "The patient pressed SEND HELP / NOT SAFE and requested assistance."
      : "The patient has not responded to the safety confirmation.";
    const fallLocationLine = alert.location
      ? `Location: ${alert.location.latitude.toFixed(5)}, ${alert.location.longitude.toFixed(5)}.`
      : "Location unavailable.";
    const fallCaregiverMessage = `A possible fall has been detected for ${patientDisplayName}. ${fallAckSummary} Please check on them. Severity: ${alert.level} | Status: ${
      isHelpRequested ? "Assistance Requested" : "UNACKNOWLEDGED"
    } | Details: ${alert.explanation} | ${fallLocationLine} Caregiver Dashboard: ${dashboardUrl}`;

    for (const cg of authorizedCaregivers) {
      const notifTitle = alert.fallEventId
        ? fallCaregiverTitle
        : `[Escalated ${alert.level}] ${alert.title}`;
      const notifMessage = alert.fallEventId
        ? fallCaregiverMessage
        : `Unacknowledged alert for ${alert.patientId}: ${alert.explanation}`;

      const notif = this.createInAppNotification({
        alert,
        recipientUid: cg.caregiverUid,
        recipientRole: "caregiver",
        title: notifTitle,
        message: notifMessage,
        isSimulated: isSimulatedSource,
      });
      alert.notificationAttempts.push({
        attemptId: `att_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
        channel: "in_app",
        recipientRole: "caregiver",
        recipientUid: cg.caregiverUid,
        recipientName: cg.caregiverName,
        provider: "AROVA In-App Caregiver Feed",
        deliveryStatus: notif.deliveryStatus,
        isSimulated: notif.isSimulated,
        message: notif.message,
        timestamp: nowIso,
      });

      const readingSummary = `HR=${alert.relevantReadings.heartRate ?? "N/A"}, SpO2=${alert.relevantReadings.spo2 ?? "N/A"}%, Temp=${alert.relevantReadings.temperatureC ?? "N/A"}C`;
      const externalText = alert.fallEventId
        ? `${fallCaregiverTitle}: ${fallCaregiverMessage} ${PROTOTYPE_ALERT_NOTICE}`
        : `AROVA ${alert.level} Prototype Alert (${alert.patientId}): ${alert.explanation} [${readingSummary}]. ${PROTOTYPE_ALERT_NOTICE}`;

      const recordAttempt = (res: ExternalDispatchResult) => {
        alert.notificationAttempts.push({
          attemptId: `att_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
          channel: res.channel,
          recipientRole: "caregiver",
          recipientUid: cg.caregiverUid,
          recipientName: cg.caregiverName,
          targetMasked: res.targetMasked,
          provider: res.provider,
          deliveryStatus: res.deliveryStatus,
          isSimulated: res.isSimulated,
          message: res.detail,
          errorDetail: res.errorDetail,
          timestamp: new Date().toISOString(),
        });
        alert.callLog.unshift(`${res.channel.toUpperCase()} -> ${cg.caregiverName}: ${res.deliveryStatus} (${res.provider})`);
        if (alert.callLog.length > 12) alert.callLog.length = 12;

        if (res.deliveryStatus === "failed") {
          this.logNotificationError({
            alertId: alert.alertId,
            patientId: alert.patientId,
            channel: res.channel,
            provider: res.provider,
            message: res.errorDetail || res.detail,
          });
        }
      };

      if (this.config.smsEnabled) {
        try {
          const smsRes = await smsFn({ toPhone: cg.caregiverPhone, message: externalText });
          recordAttempt(smsRes);
        } catch (err) {
          recordAttempt({
            channel: "sms",
            provider: "SMS Dispatcher",
            deliveryStatus: "failed",
            isSimulated: false,
            detail: "Unexpected SMS dispatcher exception.",
            errorDetail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (this.config.emailEnabled) {
        try {
          const emailRes = await emailFn({
            toEmail: cg.caregiverEmail,
            subject: alert.fallEventId
              ? fallCaregiverTitle
              : `[AROVA ${alert.level} Prototype Alert] ${alert.patientId}`,
            text: externalText,
          });
          recordAttempt(emailRes);
        } catch (err) {
          recordAttempt({
            channel: "email",
            provider: "Email Dispatcher",
            deliveryStatus: "failed",
            isSimulated: false,
            detail: "Unexpected Email dispatcher exception.",
            errorDetail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (alert.level === "Critical" && this.config.voiceEnabled && cg.permissions?.receiveCalls !== false) {
        try {
          const voiceRes = await voiceFn({
            toPhone: cg.caregiverPhone,
            explicitCallConsent: Boolean(cg.explicitCallConsent),
            caregiverName: cg.caregiverName,
            patientName: patientDisplayName,
            reason: alert.fallEventId ? fallCaregiverMessage : alert.explanation,
            publicBaseUrlOverride: opts?.publicBaseUrlOverride,
          });
          recordAttempt(voiceRes);
          alert.callEscalationStatus =
            voiceRes.deliveryStatus === "delivered" ? "calling_primary" : "provider_unconfigured";
        } catch (err) {
          recordAttempt({
            channel: "voice_call",
            provider: "Voice Dispatcher",
            deliveryStatus: "failed",
            isSimulated: false,
            detail: "Unexpected Voice dispatcher exception.",
            errorDetail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    alert.notificationStatus = this.computeOverallNotificationStatus(alert.notificationAttempts);
    this.appendHistory(
      alert,
      "caregiver_notified",
      `Caregiver notification dispatch complete (${alert.notificationStatus}).`
    );
    alert.updatedAt = new Date().toISOString();

    if (linkedFall) {
      if (linkedFall.status === "pending_confirmation" || linkedFall.status === "escalated") {
        linkedFall.status = "escalated";
      }
      linkedFall.escalatedAt = nowIso;
      linkedFall.escalationTrigger = trigger;
      linkedFall.patientAckStatus = isHelpRequested ? "assistance_requested" : "unacknowledged";
      linkedFall.caregiverNotificationInitiated = true;
      linkedFall.notificationAttempts = alert.notificationAttempts.filter(
        (a) => a.recipientRole === "caregiver"
      );
      linkedFall.updatedAt = alert.updatedAt;
    }
    return alert;
  }

  public acknowledgeAlert(params: {
    alertId: string;
    actorUid: string;
    actorRole: "patient" | "caregiver" | "admin";
    actorName?: string;
    followUpAction?: string;
    isAdmin?: boolean;
  }): Phase5AlertRecord {
    const alert = this.alerts.get(params.alertId);
    if (!alert) {
      throw new Error(`Alert '${params.alertId}' not found.`);
    }

    const authorized =
      Boolean(params.isAdmin) ||
      alert.ownerUid === params.actorUid ||
      this.isAuthorizedCaregiverForPatient(params.actorUid, alert.patientId, alert);
    if (!authorized) {
      throw new Error("Forbidden: caller is not authorized to acknowledge this patient's alert.");
    }

    if (params.actorRole === "caregiver" && !params.isAdmin) {
      const links = Array.from(this.careLinks.values()).filter(
        (l) => l.patientId === alert.patientId && l.caregiverUid === params.actorUid && l.status === "active"
      );
      if (links.some((l) => l.permissions?.acknowledgeAlerts === false)) {
        throw new Error("Forbidden: caregiver link does not grant alert acknowledgement permission.");
      }
    }

    this.cancelTimer(alert.alertId);
    sharedAlertDecisionEngine.markAlertCleared(alert.patientId, alert.source, alert.alertId);

    const nowIso = new Date().toISOString();
    alert.status = "acknowledged";
    alert.acknowledgedByUid = params.actorUid;
    alert.acknowledgedByName = params.actorName?.trim() || params.actorRole;
    if (params.followUpAction?.trim()) {
      alert.followUpAction = params.followUpAction.trim().slice(0, 500);
    }

    if (params.actorRole === "patient") {
      alert.patientAcknowledged = true;
      alert.patientAcknowledgedAt = nowIso;
      alert.unreadByPatient = false;
      alert.escalationStatus = "patient_acknowledged";
      this.appendHistory(
        alert,
        "patient_acknowledged",
        `Patient acknowledged alert (${alert.acknowledgedByName}); pending escalation cancelled.`,
        params.actorUid
      );
      for (const notif of this.notifications.values()) {
        if (notif.alertId === alert.alertId && notif.recipientRole === "patient") {
          notif.read = true;
          notif.readAt = nowIso;
        }
      }
    } else {
      alert.caregiverAcknowledgedAt = nowIso;
      alert.unreadByCaregiver = false;
      alert.escalationStatus = "caregiver_acknowledged";
      this.appendHistory(
        alert,
        "caregiver_acknowledged",
        `${params.actorRole === "admin" ? "Administrator" : "Authorized caregiver"} (${alert.acknowledgedByName}) acknowledged alert${alert.followUpAction ? `: ${alert.followUpAction}` : "."}`,
        params.actorUid
      );
      for (const notif of this.notifications.values()) {
        if (notif.alertId === alert.alertId && notif.recipientRole === "caregiver") {
          notif.read = true;
          notif.readAt = nowIso;
        }
      }
    }

    alert.updatedAt = nowIso;
    if (alert.fallEventId) {
      const linkedFall = this.fallEvents.get(alert.fallEventId);
      if (linkedFall && linkedFall.status !== "false_alert" && linkedFall.status !== "cancelled_safe") {
        linkedFall.status =
          params.actorRole === "patient" ? "cancelled_safe" : "caregiver_acknowledged";
        linkedFall.patientAckStatus =
          params.actorRole === "patient" ? "user_confirmed_safe" : "caregiver_acknowledged";
        linkedFall.acknowledgedBy = alert.acknowledgedByName;
        if (alert.followUpAction) {
          linkedFall.followUpNotes = alert.followUpAction;
        }
        if (params.actorRole === "patient") {
          linkedFall.cancelledBy = alert.acknowledgedByName;
          linkedFall.cancellationReason = alert.followUpAction || "Patient acknowledged alert.";
          linkedFall.resolvedAt = nowIso;
        }
        linkedFall.updatedAt = nowIso;
      }
    }
    recordServerAuditEvent({
      userId: params.actorUid,
      actorRole: params.actorRole,
      eventType: "alert_acknowledged",
      summary: `Alert ${alert.alertId} acknowledged by ${alert.acknowledgedByName}.`,
      targetId: alert.alertId,
    });
    return alert;
  }

  public reportFalseAlert(params: {
    alertId: string;
    actorUid: string;
    actorRole: "patient" | "caregiver" | "admin";
    actorName?: string;
    reason?: string;
    isAdmin?: boolean;
  }): Phase5AlertRecord {
    const alert = this.alerts.get(params.alertId);
    if (!alert) {
      throw new Error(`Alert '${params.alertId}' not found.`);
    }

    const authorized =
      Boolean(params.isAdmin) ||
      alert.ownerUid === params.actorUid ||
      this.isAuthorizedCaregiverForPatient(params.actorUid, alert.patientId, alert);
    if (!authorized) {
      throw new Error("Forbidden: caller is not authorized to report false alerts for this patient.");
    }

    this.cancelTimer(alert.alertId);
    sharedAlertDecisionEngine.markAlertCleared(alert.patientId, alert.source, alert.alertId);

    const nowIso = new Date().toISOString();
    const cleanReason =
      params.reason?.trim().slice(0, 300) || "Reported as false alert by authorized user.";
    alert.falseAlertReported = true;
    alert.falseAlertReason = cleanReason;
    alert.falseAlertReportedByUid = params.actorUid;
    alert.falseAlertReportedAt = nowIso;
    alert.status = "resolved";
    alert.escalationStatus = "false_alert";
    alert.followUpAction = `False Alert: ${cleanReason}`;
    alert.unreadByPatient = false;
    alert.unreadByCaregiver = false;
    alert.updatedAt = nowIso;

    this.appendHistory(
      alert,
      "false_alert_reported",
      `Marked as false alert by ${params.actorName?.trim() || params.actorRole}: ${cleanReason}`,
      params.actorUid
    );

    for (const notif of this.notifications.values()) {
      if (notif.alertId === alert.alertId) {
        notif.read = true;
        notif.readAt = nowIso;
      }
    }

    if (alert.fallEventId) {
      const linkedFall = this.fallEvents.get(alert.fallEventId);
      if (linkedFall) {
        linkedFall.status = "false_alert";
        linkedFall.cancellationReason = cleanReason;
        linkedFall.resolvedAt = nowIso;
        linkedFall.updatedAt = nowIso;
      }
    }

    recordServerAuditEvent({
      userId: params.actorUid,
      actorRole: params.actorRole,
      eventType: "alert_marked_false",
      summary: `Alert ${alert.alertId} flagged as false alert (${cleanReason}).`,
      targetId: alert.alertId,
    });

    return alert;
  }

  public resolveAlert(params: {
    alertId: string;
    actorUid: string;
    actorRole: "patient" | "caregiver" | "admin";
    actorName?: string;
    followUpAction?: string;
    isAdmin?: boolean;
  }): Phase5AlertRecord {
    const alert = this.alerts.get(params.alertId);
    if (!alert) {
      throw new Error(`Alert '${params.alertId}' not found.`);
    }

    const authorized =
      Boolean(params.isAdmin) ||
      alert.ownerUid === params.actorUid ||
      this.isAuthorizedCaregiverForPatient(params.actorUid, alert.patientId, alert);
    if (!authorized) {
      throw new Error("Forbidden: caller is not authorized to resolve this patient's alert.");
    }

    this.cancelTimer(alert.alertId);
    sharedAlertDecisionEngine.markAlertCleared(alert.patientId, alert.source, alert.alertId);

    const nowIso = new Date().toISOString();
    alert.status = "resolved";
    alert.escalationStatus = "resolved";
    alert.unreadByPatient = false;
    alert.unreadByCaregiver = false;
    if (params.followUpAction?.trim()) {
      alert.followUpAction = params.followUpAction.trim().slice(0, 500);
    }
    alert.updatedAt = nowIso;

    this.appendHistory(
      alert,
      "resolved",
      `Alert resolved by ${params.actorName?.trim() || params.actorRole}${alert.followUpAction ? `: ${alert.followUpAction}` : "."}`,
      params.actorUid
    );

    for (const notif of this.notifications.values()) {
      if (notif.alertId === alert.alertId) {
        notif.read = true;
        notif.readAt = nowIso;
      }
    }

    if (alert.fallEventId) {
      const linkedFall = this.fallEvents.get(alert.fallEventId);
      if (linkedFall && linkedFall.status !== "false_alert" && linkedFall.status !== "cancelled_safe") {
        linkedFall.status = "resolved";
        if (params.followUpAction?.trim()) {
          linkedFall.followUpNotes = params.followUpAction.trim().slice(0, 500);
        }
        linkedFall.resolvedAt = nowIso;
        linkedFall.updatedAt = nowIso;
      }
    }

    return alert;
  }

  public async reportFallDetectionEvent(params: {
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
    location?: FallDetectionLocation | null;
    confirmationCountdownSec?: number;
    publicBaseUrlOverride?: string;
  }): Promise<{
    eventCreated: boolean;
    duplicateSuppressed: boolean;
    fallEvent: FallDetectionEventRecord;
    alert: Phase5AlertRecord | null;
    notifications: InAppNotificationRecord[];
  }> {
    const nowIso = new Date().toISOString();
    const source = params.detectionMode === "demo_simulation" ? "demo_simulation" : "webcam_pose";
    const isSimulated = params.detectionMode === "demo_simulation";
    const ownerUid = params.patientOwnerUid?.trim() || "sample_owner";
    const patientName = params.patientName?.trim() || `Patient (${params.patientId})`;
    const countdownSec = Math.max(
      1,
      Math.min(180, Math.round(params.confirmationCountdownSec ?? 20))
    );

    if (params.sensorFusionStatus === "sensor_disagreement") {
      this.sensorDisagreementCount += 1;
    }

    const level: "Warning" | "Critical" =
      params.state === "Possible Fall" ? "Critical" : "Warning";
    const newEventId = `fall_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const newAlertId = `alert_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

    const duplicateCheck = sharedAlertDecisionEngine.checkAndTrackDuplicateAlert({
      patientId: params.patientId,
      source,
      level,
      triggeredMetrics: [
        params.state === "Possible Fall" ? "Webcam Fall Posture" : "Posture Warning",
      ],
      newAlertId,
      duplicateWindowSec: this.config.duplicateAlertWindowSec,
    });

    if (duplicateCheck.duplicateSuppressed && duplicateCheck.existingAlertId) {
      const existingAlert = this.alerts.get(duplicateCheck.existingAlertId) ?? null;
      const existingFall = existingAlert?.fallEventId
        ? this.fallEvents.get(existingAlert.fallEventId)
        : Array.from(this.fallEvents.values()).find(
            (e) =>
              e.patientId === params.patientId &&
              (e.status === "pending_confirmation" || e.status === "escalated")
          );
      if (existingAlert) {
        existingAlert.suppressedOccurrences += 1;
        existingAlert.updatedAt = nowIso;
        this.appendHistory(
          existingAlert,
          "duplicate_suppressed",
          `Suppressed duplicate ${params.state} fall event (#${existingAlert.suppressedOccurrences + 1}).`
        );
      }
      if (existingFall) {
        existingFall.suppressedDuplicates += 1;
        existingFall.updatedAt = nowIso;
        return {
          eventCreated: false,
          duplicateSuppressed: true,
          fallEvent: existingFall,
          alert: existingAlert,
          notifications: [],
        };
      }
    }

    const confirmationDeadlineAt = new Date(Date.now() + countdownSec * 1000).toISOString();
    const validLocation =
      params.location &&
      typeof params.location.latitude === "number" &&
      Number.isFinite(params.location.latitude) &&
      params.location.latitude >= -90 &&
      params.location.latitude <= 90 &&
      typeof params.location.longitude === "number" &&
      Number.isFinite(params.location.longitude) &&
      params.location.longitude >= -180 &&
      params.location.longitude <= 180
        ? {
            latitude: Number(params.location.latitude.toFixed(6)),
            longitude: Number(params.location.longitude.toFixed(6)),
            accuracyMeters:
              typeof params.location.accuracyMeters === "number" &&
              Number.isFinite(params.location.accuracyMeters)
                ? Math.round(params.location.accuracyMeters)
                : undefined,
            capturedAt: params.location.capturedAt || nowIso,
          }
        : null;

    const fallTitle =
      params.state === "Possible Fall"
        ? isSimulated
          ? "SIMULATED DEMO — Possible Fall Detected (Camera AI)"
          : "ALERT – Possible Fall Detected (Camera AI)"
        : isSimulated
        ? "SIMULATED DEMO — Posture / Fall Warning (Camera AI)"
        : "Camera Posture Warning — Verify Patient Status";

    const alert: Phase5AlertRecord = {
      alertId: newAlertId,
      patientId: params.patientId,
      ownerUid,
      primaryCaregiverUid: params.primaryCaregiverUid,
      secondaryCaregiverUid: params.secondaryCaregiverUid,
      level,
      status: "active",
      title: fallTitle,
      explanation: params.reason.slice(0, 800),
      prototypeNotice:
        "Prototype computer-vision fall detection only — accuracy is not clinically validated. Verify safety directly.",
      anomalyScore: params.state === "Possible Fall" ? -0.45 : -0.15,
      signalQuality: params.confidence >= 0.45 ? "good" : "noisy",
      relevantReadings: {
        heartRate: null,
        spo2: null,
        temperatureC: null,
        accelMagnitude: 1.0,
        gyroMagnitude: 0,
        movementStatus: params.state === "Possible Fall" ? "fall_suspect" : "active",
        signalQuality: params.confidence >= 0.45 ? "good" : "noisy",
      },
      triggeredMetrics: [
        params.state === "Possible Fall" ? "Camera Pose Fall" : "Camera Posture Warning",
        ...(params.sensorFusionStatus === "corroborated"
          ? ["Wearable IMU Corroborated"]
          : params.sensorFusionStatus === "sensor_disagreement"
          ? ["Sensor Disagreement"]
          : []),
      ],
      source,
      fallEventId: newEventId,
      detectionMode: params.detectionMode,
      sensorFusionStatus: params.sensorFusionStatus,
      location: validLocation,
      confirmationDeadlineAt,
      patientAcknowledged: false,
      falseAlertReported: false,
      unreadByPatient: true,
      unreadByCaregiver: params.state === "Warning",
      escalationStatus:
        params.state === "Possible Fall" ? "awaiting_patient_ack" : "notified_caregiver",
      escalationDueAt: params.state === "Possible Fall" ? confirmationDeadlineAt : undefined,
      escalationHistory: [],
      notificationAttempts: [],
      notificationStatus: isSimulated ? "simulated" : "delivered",
      suppressedOccurrences: 0,
      callEscalationStatus: "not_triggered",
      callLog: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const fallEvent: FallDetectionEventRecord = {
      eventId: newEventId,
      patientId: params.patientId,
      patientName,
      ownerUid,
      primaryCaregiverUid: params.primaryCaregiverUid,
      secondaryCaregiverUid: params.secondaryCaregiverUid,
      alertId: newAlertId,
      detectionMode: params.detectionMode,
      isSimulated,
      state: params.state,
      status: params.state === "Possible Fall" ? "pending_confirmation" : "resolved",
      reason: params.reason.slice(0, 600),
      confidence: Number(Math.max(0, Math.min(1, params.confidence)).toFixed(3)),
      torsoAngleDeg: Number(Math.max(0, Math.min(180, params.torsoAngleDeg)).toFixed(1)),
      verticalVelocity: Number(params.verticalVelocity.toFixed(3)),
      horizontalDurationSec: Number(Math.max(0, params.horizontalDurationSec).toFixed(2)),
      peopleCount: Math.max(0, Math.round(params.peopleCount)),
      sensorFusionStatus: params.sensorFusionStatus,
      wearableSummary: params.wearableSummary?.slice(0, 240),
      location: validLocation,
      confirmationCountdownSec: countdownSec,
      confirmationDeadlineAt,
      suppressedDuplicates: 0,
      patientAckStatus: params.state === "Possible Fall" ? "awaiting_confirmation" : undefined,
      caregiverNotificationInitiated: false,
      notificationAttempts: [],
      detectedAt: nowIso,
      updatedAt: nowIso,
    };

    this.appendHistory(
      alert,
      "alert_created",
      `${fallTitle} (confidence ${Math.round(fallEvent.confidence * 100)}%, torso ${fallEvent.torsoAngleDeg}°, fusion: ${fallEvent.sensorFusionStatus}).`
    );

    const createdNotifications: InAppNotificationRecord[] = [];
    const patientNotif = this.createInAppNotification({
      alert,
      recipientUid: ownerUid,
      recipientRole: "patient",
      title: alert.title,
      message: `${alert.explanation}${validLocation ? ` Location shared (${validLocation.latitude.toFixed(4)}, ${validLocation.longitude.toFixed(4)}).` : " Location unavailable."} (${alert.prototypeNotice})`,
      isSimulated,
    });
    createdNotifications.push(patientNotif);

    alert.notificationAttempts.push({
      attemptId: `att_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
      channel: "in_app",
      recipientRole: "patient",
      recipientUid: ownerUid,
      recipientName: patientName,
      provider: "AROVA Fall Alert Overlay & In-App Center",
      deliveryStatus: isSimulated ? "simulated" : "delivered",
      isSimulated,
      message: alert.explanation,
      timestamp: nowIso,
    });

    this.alerts.set(alert.alertId, alert);
    this.fallEvents.set(fallEvent.eventId, fallEvent);

    if (params.state === "Possible Fall" && this.config.caregiverEscalationEnabled) {
      const waitMs = countdownSec * 1000;
      this.appendHistory(
        alert,
        "awaiting_patient_ack",
        `Waiting ${countdownSec}s for user "I'm Safe – Cancel Alert" confirmation before escalating to linked caregivers.`
      );
      const timer = setTimeout(() => {
        void this.escalateAlertToCaregivers(alert.alertId, {
          trigger: "patient_ack_timeout",
          publicBaseUrlOverride: params.publicBaseUrlOverride,
        });
      }, waitMs);
      timer.unref?.();
      this.escalationTimers.set(alert.alertId, timer);
    } else if (params.state === "Warning") {
      const caregivers = this.getAuthorizedCaregiversForPatient(params.patientId);
      for (const cg of caregivers) {
        const cgNotif = this.createInAppNotification({
          alert,
          recipientUid: cg.caregiverUid,
          recipientRole: "caregiver",
          title: `[Camera Warning] ${patientName}`,
          message: alert.explanation,
          isSimulated,
        });
        createdNotifications.push(cgNotif);
      }
    }

    alert.notificationStatus = this.computeOverallNotificationStatus(alert.notificationAttempts);
    recordServerAuditEvent({
      userId: ownerUid,
      actorRole: "patient",
      eventType: "fall_detection_event_recorded",
      summary: `${fallTitle} recorded (${params.sensorFusionStatus}${validLocation ? ", location attached" : ", location unavailable"}).`,
      targetId: fallEvent.eventId,
    });

    return {
      eventCreated: true,
      duplicateSuppressed: false,
      fallEvent,
      alert,
      notifications: createdNotifications,
    };
  }

  public cancelFallEventSafe(params: {
    eventId: string;
    actorUid: string;
    actorRole: "patient" | "caregiver" | "admin";
    actorName?: string;
    reason?: string;
    isAdmin?: boolean;
  }): FallDetectionEventRecord {
    const evt = this.fallEvents.get(params.eventId);
    if (!evt) {
      throw new Error(`Fall detection event '${params.eventId}' not found.`);
    }
    const alert = this.alerts.get(evt.alertId);
    const authorized =
      Boolean(params.isAdmin) ||
      evt.ownerUid === params.actorUid ||
      (!params.actorUid && evt.ownerUid === "sample_owner") ||
      this.isAuthorizedCaregiverForPatient(params.actorUid, evt.patientId, alert);
    if (!authorized) {
      throw new Error("Forbidden: caller is not authorized to cancel this fall alert.");
    }

    const nowIso = new Date().toISOString();
    this.cancelTimer(evt.alertId);
    const source = evt.detectionMode === "demo_simulation" ? "demo_simulation" : "webcam_pose";
    sharedAlertDecisionEngine.markAlertCleared(evt.patientId, source, evt.alertId);

    const cancelBy = params.actorName?.trim() || params.actorRole;
    const cancelNote =
      params.reason?.trim().slice(0, 300) || "User confirmed safe — emergency alert cancelled.";

    evt.status = "cancelled_safe";
    evt.patientAckStatus = "user_confirmed_safe";
    evt.cancelledBy = cancelBy;
    evt.cancellationReason = cancelNote;
    evt.resolvedAt = nowIso;
    evt.updatedAt = nowIso;

    if (alert) {
      alert.status = "resolved";
      alert.patientAcknowledged = true;
      alert.patientAcknowledgedAt = nowIso;
      alert.acknowledgedByUid = params.actorUid || "sample_owner";
      alert.acknowledgedByName = cancelBy;
      alert.followUpAction = `I'm Safe – Alert Cancelled: ${cancelNote}`;
      alert.escalationStatus = "resolved";
      alert.unreadByPatient = false;
      alert.unreadByCaregiver = false;
      alert.updatedAt = nowIso;
      this.appendHistory(
        alert,
        "patient_acknowledged",
        `Cancelled safely by ${cancelBy}: ${cancelNote}`,
        params.actorUid
      );
      for (const notif of this.notifications.values()) {
        if (notif.alertId === alert.alertId) {
          notif.read = true;
          notif.readAt = nowIso;
        }
      }
    }

    recordServerAuditEvent({
      userId: params.actorUid || "sample_owner",
      actorRole: params.actorRole,
      eventType: "fall_alert_cancelled_safe",
      summary: `Fall alert ${evt.eventId} cancelled safely by ${cancelBy}.`,
      targetId: evt.eventId,
    });

    return evt;
  }

  public async requestFallEventHelp(params: {
    eventId: string;
    actorUid: string;
    actorRole: "patient" | "caregiver" | "admin";
    actorName?: string;
    reason?: string;
    isAdmin?: boolean;
    publicBaseUrlOverride?: string;
  }): Promise<{
    fallEvent: FallDetectionEventRecord;
    alert: Phase5AlertRecord | null;
  }> {
    const evt = this.fallEvents.get(params.eventId);
    if (!evt) {
      throw new Error(`Fall detection event '${params.eventId}' not found.`);
    }
    const existingAlert = this.alerts.get(evt.alertId) ?? null;
    const authorized =
      Boolean(params.isAdmin) ||
      evt.ownerUid === params.actorUid ||
      (!params.actorUid && evt.ownerUid === "sample_owner") ||
      this.isAuthorizedCaregiverForPatient(params.actorUid, evt.patientId, existingAlert ?? undefined);
    if (!authorized) {
      throw new Error("Forbidden: caller is not authorized to escalate this fall alert.");
    }

    this.cancelTimer(evt.alertId);
    const updatedAlert = await this.escalateAlertToCaregivers(evt.alertId, {
      trigger: "user_help_requested",
      publicBaseUrlOverride: params.publicBaseUrlOverride,
    });

    const nowIso = new Date().toISOString();
    evt.status = "escalated";
    evt.escalatedAt = evt.escalatedAt ?? nowIso;
    evt.escalationTrigger = "user_help_requested";
    evt.patientAckStatus = "assistance_requested";
    evt.caregiverNotificationInitiated = Boolean(
      updatedAlert && updatedAlert.notificationAttempts.some((a) => a.recipientRole === "caregiver")
    );
    evt.notificationAttempts = updatedAlert
      ? updatedAlert.notificationAttempts.filter((a) => a.recipientRole === "caregiver")
      : [];
    evt.updatedAt = nowIso;

    recordServerAuditEvent({
      userId: params.actorUid || "sample_owner",
      actorRole: params.actorRole,
      eventType: "fall_help_requested",
      summary: `User pressed SEND HELP / NOT SAFE on fall alert ${evt.eventId}; caregiver notification initiated.`,
      targetId: evt.eventId,
    });

    return {
      fallEvent: evt,
      alert: updatedAlert,
    };
  }

  public listFallEvents(scope: {
    callerUid?: string;
    isAdmin?: boolean;
    patientId?: string;
  }): FallDetectionEventRecord[] {
    return Array.from(this.fallEvents.values())
      .filter((evt) => !scope.patientId || evt.patientId === scope.patientId)
      .filter((evt) => {
        if (scope.isAdmin) return true;
        if (!scope.callerUid) {
          return evt.ownerUid === "sample_owner" || evt.patientId === "patient_primary";
        }
        if (evt.ownerUid === scope.callerUid) return true;
        return this.isAuthorizedCaregiverForPatient(scope.callerUid, evt.patientId);
      })
      .sort((a, b) => (b.detectedAt > a.detectedAt ? 1 : -1));
  }

  public recordCameraTelemetry(snapshot: Omit<CameraTelemetrySnapshot, "updatedAt">): CameraTelemetrySnapshot {
    const nowIso = new Date().toISOString();
    const rec: CameraTelemetrySnapshot = {
      ...snapshot,
      updatedAt: nowIso,
    };
    this.cameraTelemetry.set(snapshot.patientId, rec);

    if (
      snapshot.cameraStatus === "denied" ||
      snapshot.cameraStatus === "unavailable" ||
      snapshot.cameraStatus === "disconnected"
    ) {
      this.cameraErrors.unshift({
        errorId: `camerr_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
        patientId: snapshot.patientId,
        cameraStatus: snapshot.cameraStatus,
        message:
          snapshot.errorMessage?.slice(0, 240) ||
          `Camera reported ${snapshot.cameraStatus} state.`,
        timestamp: nowIso,
      });
      if (this.cameraErrors.length > 50) {
        this.cameraErrors.length = 50;
      }
    }
    return rec;
  }

  public getFallDetectionAdminStats(): AdminFallDetectionStats {
    const allFall = Array.from(this.fallEvents.values());
    const cams = Array.from(this.cameraTelemetry.values()).sort((a, b) =>
      b.updatedAt > a.updatedAt ? 1 : -1
    );
    const latestCam = cams[0] ?? null;

    return {
      totalFallEvents: allFall.length,
      activeFallEvents: allFall.filter(
        (e) => e.status === "pending_confirmation" || e.status === "escalated"
      ).length,
      escalatedFallEvents: allFall.filter((e) => e.status === "escalated").length,
      cancelledSafeCount: allFall.filter((e) => e.status === "cancelled_safe").length,
      falseFallAlerts: allFall.filter((e) => e.status === "false_alert").length,
      sensorDisagreementCount: this.sensorDisagreementCount,
      cameraErrorsCount: this.cameraErrors.length,
      latestCameraStatus: latestCam?.cameraStatus ?? ("standby" as CameraMonitoringStatus),
      latestCameraUpdatedAt: latestCam?.updatedAt ?? null,
      recentCameraErrors: this.cameraErrors.slice(0, 12),
    };
  }

  public markNotificationRead(params: {
    notificationId: string;
    actorUid?: string;
    isAdmin?: boolean;
  }): InAppNotificationRecord {
    const notif = this.notifications.get(params.notificationId);
    if (!notif) {
      throw new Error(`Notification '${params.notificationId}' not found.`);
    }

    const alert = this.alerts.get(notif.alertId);
    const authorized =
      Boolean(params.isAdmin) ||
      (!params.actorUid && notif.patientOwnerUid === "sample_owner") ||
      (Boolean(params.actorUid) &&
        (notif.recipientUid === params.actorUid ||
          notif.patientOwnerUid === params.actorUid ||
          (alert ? this.isAuthorizedCaregiverForPatient(params.actorUid!, alert.patientId, alert) : false)));

    if (!authorized) {
      throw new Error("Forbidden: unauthorized to mark this notification read.");
    }

    notif.read = true;
    notif.readAt = new Date().toISOString();

    if (alert) {
      const remainingUnreadForRole = Array.from(this.notifications.values()).some(
        (n) => n.alertId === alert.alertId && n.recipientRole === notif.recipientRole && !n.read
      );
      if (notif.recipientRole === "patient") {
        alert.unreadByPatient = remainingUnreadForRole;
      } else if (notif.recipientRole === "caregiver") {
        alert.unreadByCaregiver = remainingUnreadForRole;
      }
    }

    return notif;
  }

  public listAlerts(scope: {
    callerUid?: string;
    isAdmin?: boolean;
    patientId?: string;
    roleFilter?: "patient" | "caregiver" | "admin";
  }): Phase5AlertRecord[] {
    return Array.from(this.alerts.values())
      .filter((alert) => !scope.patientId || alert.patientId === scope.patientId)
      .filter((alert) =>
        this.canUserAccessPatientAlert(
          scope.callerUid || scope.isAdmin
            ? { uid: scope.callerUid, isAdmin: scope.isAdmin }
            : null,
          alert
        )
      )
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  public listNotifications(scope: {
    callerUid?: string;
    isAdmin?: boolean;
    patientId?: string;
    roleFilter?: "patient" | "caregiver" | "admin";
  }): InAppNotificationRecord[] {
    return Array.from(this.notifications.values())
      .filter((notif) => !scope.patientId || notif.patientId === scope.patientId)
      .filter((notif) => !scope.roleFilter || notif.recipientRole === scope.roleFilter)
      .filter((notif) => {
        if (scope.isAdmin) return true;
        if (!scope.callerUid) {
          return notif.patientOwnerUid === "sample_owner" || notif.patientId === "patient_primary";
        }
        if (notif.patientOwnerUid === scope.callerUid || notif.recipientUid === scope.callerUid) {
          return true;
        }
        return this.isAuthorizedCaregiverForPatient(scope.callerUid, notif.patientId);
      })
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  public getAdminStats() {
    const allAlerts = Array.from(this.alerts.values());
    const allNotifications = Array.from(this.notifications.values());
    const providers = getNotificationProvidersStatus();
    return {
      totalAlerts: allAlerts.length,
      activeAlerts: allAlerts.filter((a) => a.status === "active").length,
      acknowledgedAlerts: allAlerts.filter((a) => a.status === "acknowledged").length,
      resolvedAlerts: allAlerts.filter((a) => a.status === "resolved").length,
      falseAlerts: allAlerts.filter((a) => a.falseAlertReported).length,
      criticalAlerts: allAlerts.filter((a) => a.level === "Critical").length,
      warningAlerts: allAlerts.filter((a) => a.level === "Warning").length,
      suppressedDuplicates: allAlerts.reduce((acc, a) => acc + a.suppressedOccurrences, 0),
      unreadNotifications: allNotifications.filter((n) => !n.read).length,
      totalNotifications: allNotifications.length,
      errorCount: this.errorLogs.length,
      fallDetectionStats: this.getFallDetectionAdminStats(),
      providers,
      config: this.getConfig(),
    };
  }

  public getErrorLogs(): NotificationErrorLogEntry[] {
    return [...this.errorLogs];
  }
}

export const sharedNotificationEngine = new NotificationEscalationEngine();
