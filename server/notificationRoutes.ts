import express from "express";
import {
  requireAdminFirebaseUser,
  requireAuthenticatedFirebaseUser,
  verifyFirebaseIdToken,
  type AuthenticatedRequest,
  type VerifiedFirebaseUser,
} from "./firebaseAuth.ts";
import { askSmartCareAssistant, type AssistantContextPayload } from "./gemini.ts";
import { analyzeTelemetry } from "./mlClient.ts";
import {
  sharedNotificationEngine,
  type AuthorizedCareLinkEntry,
} from "./notificationEngine.ts";
import { getNotificationProvidersStatus } from "./notificationProviders.ts";
import { resolvePublicBaseUrl } from "./outboundVoice.ts";
import { buildPolicyConfigFromAlertLevels } from "./alertLevelConfig.ts";
import { sharedVoiceEscalationEngine } from "./voiceEscalationEngine.ts";
import type {
  CameraMonitoringStatus,
  FallDetectionLocation,
  FallDetectionState,
  FallSensorFusionStatus,
  MlAnalysisResult,
  TelemetryPayload,
} from "./types.ts";

async function resolveOptionalUser(
  req: express.Request
): Promise<{ provided: boolean; user: VerifiedFirebaseUser | null }> {
  const authHeader = req.header("authorization") || req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { provided: false, user: null };
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return { provided: true, user: null };
  }
  const user = await verifyFirebaseIdToken(token).catch(() => null);
  return { provided: true, user };
}

export function createNotificationRouter(): express.Router {
  const router = express.Router();

  router.get("/notifications/config", (_req, res) => {
    res.json({
      ok: true,
      config: sharedNotificationEngine.getConfig(),
      providers: getNotificationProvidersStatus(),
    });
  });

  router.put(
    "/notifications/escalation-config",
    requireAdminFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      try {
        const user = req.firebaseUser!;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const updated = sharedNotificationEngine.updateConfig(
          {
            patientAckTimeoutSec:
              typeof body.patientAckTimeoutSec === "number" ? body.patientAckTimeoutSec : undefined,
            duplicateAlertWindowSec:
              typeof body.duplicateAlertWindowSec === "number"
                ? body.duplicateAlertWindowSec
                : undefined,
            caregiverEscalationEnabled:
              typeof body.caregiverEscalationEnabled === "boolean"
                ? body.caregiverEscalationEnabled
                : undefined,
            escalateOnWarning:
              typeof body.escalateOnWarning === "boolean" ? body.escalateOnWarning : undefined,
            smsEnabled: typeof body.smsEnabled === "boolean" ? body.smsEnabled : undefined,
            emailEnabled: typeof body.emailEnabled === "boolean" ? body.emailEnabled : undefined,
            voiceEnabled: typeof body.voiceEnabled === "boolean" ? body.voiceEnabled : undefined,
          },
          user.uid
        );
        res.json({
          ok: true,
          config: updated,
          providers: getNotificationProvidersStatus(),
        });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Failed to update escalation config.",
        });
      }
    }
  );

  router.get(
    "/notifications/stats",
    requireAdminFirebaseUser,
    (_req: AuthenticatedRequest, res) => {
      res.json({
        ok: true,
        stats: sharedNotificationEngine.getAdminStats(),
        errorLogs: sharedNotificationEngine.getErrorLogs(),
      });
    }
  );

  router.post(
    "/notifications/care-links",
    requireAuthenticatedFirebaseUser,
    (req: AuthenticatedRequest, res) => {
      const user = req.firebaseUser!;
      const body = (req.body ?? {}) as { links?: unknown };
      if (!Array.isArray(body.links)) {
        res.status(400).json({ error: "links array is required." });
        return;
      }

      const accepted: AuthorizedCareLinkEntry[] = [];
      for (const raw of body.links) {
        if (!raw || typeof raw !== "object") continue;
        const link = raw as Partial<AuthorizedCareLinkEntry>;
        if (!link.linkId || !link.patientId || !link.patientOwnerUid || !link.caregiverUid) {
          continue;
        }
        const allowed =
          user.isAdmin ||
          link.patientOwnerUid === user.uid ||
          link.caregiverUid === user.uid;
        if (!allowed) {
          res.status(403).json({
            error: "Forbidden: cannot register care links belonging to another patient/caregiver.",
          });
          return;
        }
        accepted.push(
          sharedNotificationEngine.upsertCareLink({
            linkId: link.linkId,
            patientId: link.patientId,
            patientName: link.patientName,
            patientOwnerUid: link.patientOwnerUid,
            caregiverUid: link.caregiverUid,
            caregiverName: link.caregiverName || "Authorized Caregiver",
            caregiverEmail: link.caregiverEmail,
            caregiverPhone: link.caregiverPhone,
            explicitCallConsent: Boolean(link.explicitCallConsent),
            priority: link.priority === "secondary" ? "secondary" : "primary",
            status:
              link.status === "revoked" || link.status === "pending" ? link.status : "active",
            relationship: link.relationship,
            permissions: link.permissions,
            updatedAt: link.updatedAt,
          })
        );
      }

      res.json({ ok: true, count: accepted.length, links: accepted });
    }
  );

  router.get("/notifications", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    const patientId =
      typeof req.query.patientId === "string" && req.query.patientId.trim()
        ? req.query.patientId.trim()
        : undefined;
    const rawRole = typeof req.query.role === "string" ? req.query.role.trim() : undefined;
    const roleFilter =
      rawRole === "patient" || rawRole === "caregiver" || rawRole === "admin"
        ? rawRole
        : undefined;

    const alerts = sharedNotificationEngine.listAlerts({
      callerUid: auth.user?.uid,
      isAdmin: auth.user?.isAdmin,
      patientId,
      roleFilter,
    });
    const notifications = sharedNotificationEngine.listNotifications({
      callerUid: auth.user?.uid,
      isAdmin: auth.user?.isAdmin,
      patientId,
      roleFilter,
    });
    const unreadCount = notifications.filter((n) => !n.read).length;

    res.json({
      ok: true,
      alerts,
      notifications,
      unreadCount,
      config: sharedNotificationEngine.getConfig(),
      providers: getNotificationProvidersStatus(),
    });
  });

  router.post("/notifications/:notificationId/read", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const updated = sharedNotificationEngine.markNotificationRead({
        notificationId: req.params.notificationId,
        actorUid: auth.user?.uid,
        isAdmin: auth.user?.isAdmin,
      });
      res.json({ ok: true, notification: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to mark notification read.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post("/alerts/evaluate", async (req, res) => {
    try {
      const auth = await resolveOptionalUser(req);
      if (auth.provided && !auth.user) {
        res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
        return;
      }

      const body = (req.body ?? {}) as {
        telemetry?: Partial<TelemetryPayload>;
        analysis?: MlAnalysisResult;
        patientName?: unknown;
        patientOwnerUid?: unknown;
        primaryCaregiverUid?: unknown;
        secondaryCaregiverUid?: unknown;
        patientAckTimeoutMsOverride?: unknown;
      };

      if (!body.telemetry?.patientId) {
        res.status(400).json({ error: "telemetry.patientId is required." });
        return;
      }

      const requestedOwnerUid =
        typeof body.patientOwnerUid === "string" && body.patientOwnerUid.trim()
          ? body.patientOwnerUid.trim()
          : auth.user?.uid || "sample_owner";

      if (auth.user && !auth.user.isAdmin) {
        const isOwner = requestedOwnerUid === auth.user.uid;
        const isCaregiver = sharedNotificationEngine.isAuthorizedCaregiverForPatient(
          auth.user.uid,
          body.telemetry.patientId
        );
        if (!isOwner && !isCaregiver) {
          res.status(403).json({ error: "Forbidden: unauthorized patient scope." });
          return;
        }
      }

      const telemetry: TelemetryPayload = {
        patientId: body.telemetry.patientId,
        deviceId: body.telemetry.deviceId ?? "arova_device",
        timestamp: body.telemetry.timestamp ?? new Date().toISOString(),
        heartRate:
          body.telemetry.heartRate === undefined ? null : (body.telemetry.heartRate as number | null),
        spo2: body.telemetry.spo2 === undefined ? null : (body.telemetry.spo2 as number | null),
        temperatureC:
          body.telemetry.temperatureC === undefined
            ? null
            : (body.telemetry.temperatureC as number | null),
        movementStatus: body.telemetry.movementStatus ?? "resting",
        accelMagnitude:
          typeof body.telemetry.accelMagnitude === "number" ? body.telemetry.accelMagnitude : 1.0,
        gyroMagnitude:
          typeof body.telemetry.gyroMagnitude === "number" ? body.telemetry.gyroMagnitude : 4.0,
        possibleFallDetected: Boolean(body.telemetry.possibleFallDetected),
        irSignalOk: body.telemetry.irSignalOk ?? true,
        fingerDetected: body.telemetry.fingerDetected ?? true,
        source: body.telemetry.source ?? "simulator",
        baselineMeans: body.telemetry.baselineMeans,
        baselineTrained: body.telemetry.baselineTrained,
        policyConfig:
          body.telemetry.policyConfig ??
          buildPolicyConfigFromAlertLevels(sharedVoiceEscalationEngine.getAlertLevelsPolicy()),
      };

      const analysis = body.analysis ?? (await analyzeTelemetry(telemetry));
      const evaluation = await sharedNotificationEngine.processTelemetryEvaluation({
        telemetry,
        analysis,
        patientName: typeof body.patientName === "string" ? body.patientName : undefined,
        patientOwnerUid: requestedOwnerUid,
        primaryCaregiverUid:
          typeof body.primaryCaregiverUid === "string" ? body.primaryCaregiverUid : undefined,
        secondaryCaregiverUid:
          typeof body.secondaryCaregiverUid === "string" ? body.secondaryCaregiverUid : undefined,
        publicBaseUrlOverride: resolvePublicBaseUrl(req) ?? undefined,
        patientAckTimeoutMsOverride:
          typeof body.patientAckTimeoutMsOverride === "number"
            ? body.patientAckTimeoutMsOverride
            : undefined,
      });

      res.json({ ok: true, analysis, evaluation });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Alert evaluation failed.",
      });
    }
  });

  router.post("/alerts/:alertId/acknowledge", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        actorRole?: unknown;
        actorName?: unknown;
        followUpAction?: unknown;
      };
      const existingAlert = sharedNotificationEngine
        .listAlerts({ isAdmin: true })
        .find((a) => a.alertId === req.params.alertId);

      if (!existingAlert) {
        res.status(404).json({ error: `Alert '${req.params.alertId}' not found.` });
        return;
      }

      if (!auth.user && existingAlert.ownerUid !== "sample_owner") {
        res.status(401).json({ error: "Authentication required for non-sample alerts." });
        return;
      }

      const actorRole =
        body.actorRole === "caregiver" || body.actorRole === "admin" ? body.actorRole : "patient";

      const updated = sharedNotificationEngine.acknowledgeAlert({
        alertId: req.params.alertId,
        actorUid: auth.user?.uid ?? "sample_owner",
        actorRole: auth.user?.isAdmin && actorRole === "admin" ? "admin" : actorRole,
        actorName:
          typeof body.actorName === "string" && body.actorName.trim()
            ? body.actorName.trim()
            : auth.user?.displayName || actorRole,
        followUpAction: typeof body.followUpAction === "string" ? body.followUpAction : undefined,
        isAdmin: auth.user?.isAdmin,
      });
      res.json({ ok: true, alert: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to acknowledge alert.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post("/alerts/:alertId/false-alert", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        actorRole?: unknown;
        actorName?: unknown;
        reason?: unknown;
      };
      const existingAlert = sharedNotificationEngine
        .listAlerts({ isAdmin: true })
        .find((a) => a.alertId === req.params.alertId);

      if (!existingAlert) {
        res.status(404).json({ error: `Alert '${req.params.alertId}' not found.` });
        return;
      }

      if (!auth.user && existingAlert.ownerUid !== "sample_owner") {
        res.status(401).json({ error: "Authentication required for non-sample alerts." });
        return;
      }

      const actorRole =
        body.actorRole === "caregiver" || body.actorRole === "admin" ? body.actorRole : "patient";

      const updated = sharedNotificationEngine.reportFalseAlert({
        alertId: req.params.alertId,
        actorUid: auth.user?.uid ?? "sample_owner",
        actorRole: auth.user?.isAdmin && actorRole === "admin" ? "admin" : actorRole,
        actorName:
          typeof body.actorName === "string" && body.actorName.trim()
            ? body.actorName.trim()
            : auth.user?.displayName || actorRole,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        isAdmin: auth.user?.isAdmin,
      });
      res.json({ ok: true, alert: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to report false alert.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post("/alerts/:alertId/resolve", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        actorRole?: unknown;
        actorName?: unknown;
        followUpAction?: unknown;
      };
      const existingAlert = sharedNotificationEngine
        .listAlerts({ isAdmin: true })
        .find((a) => a.alertId === req.params.alertId);

      if (!existingAlert) {
        res.status(404).json({ error: `Alert '${req.params.alertId}' not found.` });
        return;
      }

      if (!auth.user && existingAlert.ownerUid !== "sample_owner") {
        res.status(401).json({ error: "Authentication required for non-sample alerts." });
        return;
      }

      const actorRole =
        body.actorRole === "caregiver" || body.actorRole === "admin" ? body.actorRole : "caregiver";

      const updated = sharedNotificationEngine.resolveAlert({
        alertId: req.params.alertId,
        actorUid: auth.user?.uid ?? "sample_owner",
        actorRole: auth.user?.isAdmin && actorRole === "admin" ? "admin" : actorRole,
        actorName:
          typeof body.actorName === "string" && body.actorName.trim()
            ? body.actorName.trim()
            : auth.user?.displayName || actorRole,
        followUpAction: typeof body.followUpAction === "string" ? body.followUpAction : undefined,
        isAdmin: auth.user?.isAdmin,
      });
      res.json({ ok: true, alert: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve alert.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // --- Webcam Fall Detection Events, Safe Cancellation & Camera Telemetry ---
  router.get("/fall-detection/events", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    const patientId =
      typeof req.query.patientId === "string" && req.query.patientId.trim()
        ? req.query.patientId.trim()
        : undefined;

    const events = sharedNotificationEngine.listFallEvents({
      callerUid: auth.user?.uid,
      isAdmin: auth.user?.isAdmin,
      patientId,
    });
    res.json({
      ok: true,
      events,
      stats: sharedNotificationEngine.getFallDetectionAdminStats(),
    });
  });

  router.post("/fall-detection/events", async (req, res) => {
    try {
      const auth = await resolveOptionalUser(req);
      if (auth.provided && !auth.user) {
        res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
        return;
      }

      const body = (req.body ?? {}) as {
        patientId?: unknown;
        patientName?: unknown;
        patientOwnerUid?: unknown;
        primaryCaregiverUid?: unknown;
        secondaryCaregiverUid?: unknown;
        detectionMode?: unknown;
        state?: unknown;
        reason?: unknown;
        confidence?: unknown;
        torsoAngleDeg?: unknown;
        verticalVelocity?: unknown;
        horizontalDurationSec?: unknown;
        peopleCount?: unknown;
        sensorFusionStatus?: unknown;
        wearableSummary?: unknown;
        location?: unknown;
        confirmationCountdownSec?: unknown;
      };

      const patientId = typeof body.patientId === "string" ? body.patientId.trim() : "";
      if (!patientId) {
        res.status(400).json({ error: "patientId is required." });
        return;
      }

      const requestedOwnerUid =
        typeof body.patientOwnerUid === "string" && body.patientOwnerUid.trim()
          ? body.patientOwnerUid.trim()
          : auth.user?.uid || "sample_owner";

      if (auth.user && !auth.user.isAdmin) {
        const isOwner = requestedOwnerUid === auth.user.uid;
        const isCaregiver = sharedNotificationEngine.isAuthorizedCaregiverForPatient(
          auth.user.uid,
          patientId
        );
        if (!isOwner && !isCaregiver) {
          res.status(403).json({ error: "Forbidden: unauthorized patient scope." });
          return;
        }
      }

      const state: FallDetectionState =
        body.state === "Possible Fall" || body.state === "Warning" ? body.state : "Warning";
      const detectionMode = body.detectionMode === "demo_simulation" ? "demo_simulation" : "webcam_pose";
      const sensorFusionStatus: FallSensorFusionStatus =
        body.sensorFusionStatus === "corroborated" || body.sensorFusionStatus === "sensor_disagreement"
          ? body.sensorFusionStatus
          : "webcam_only";

      const rawLoc =
        body.location && typeof body.location === "object"
          ? (body.location as Partial<FallDetectionLocation>)
          : null;

      const result = await sharedNotificationEngine.reportFallDetectionEvent({
        patientId,
        patientName: typeof body.patientName === "string" ? body.patientName : undefined,
        patientOwnerUid: requestedOwnerUid,
        primaryCaregiverUid:
          typeof body.primaryCaregiverUid === "string" ? body.primaryCaregiverUid : undefined,
        secondaryCaregiverUid:
          typeof body.secondaryCaregiverUid === "string" ? body.secondaryCaregiverUid : undefined,
        detectionMode,
        state,
        reason:
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "Pose estimation detected fall posture criteria.",
        confidence: typeof body.confidence === "number" && Number.isFinite(body.confidence) ? body.confidence : 0.75,
        torsoAngleDeg:
          typeof body.torsoAngleDeg === "number" && Number.isFinite(body.torsoAngleDeg)
            ? body.torsoAngleDeg
            : 75,
        verticalVelocity:
          typeof body.verticalVelocity === "number" && Number.isFinite(body.verticalVelocity)
            ? body.verticalVelocity
            : 0,
        horizontalDurationSec:
          typeof body.horizontalDurationSec === "number" && Number.isFinite(body.horizontalDurationSec)
            ? body.horizontalDurationSec
            : 0,
        peopleCount:
          typeof body.peopleCount === "number" && Number.isFinite(body.peopleCount)
            ? body.peopleCount
            : 1,
        sensorFusionStatus,
        wearableSummary: typeof body.wearableSummary === "string" ? body.wearableSummary : undefined,
        location: rawLoc
          ? {
              latitude: Number(rawLoc.latitude),
              longitude: Number(rawLoc.longitude),
              accuracyMeters:
                typeof rawLoc.accuracyMeters === "number" ? rawLoc.accuracyMeters : undefined,
              capturedAt:
                typeof rawLoc.capturedAt === "string" ? rawLoc.capturedAt : new Date().toISOString(),
            }
          : null,
        confirmationCountdownSec:
          typeof body.confirmationCountdownSec === "number" &&
          Number.isFinite(body.confirmationCountdownSec)
            ? body.confirmationCountdownSec
            : undefined,
        publicBaseUrlOverride: resolvePublicBaseUrl(req) ?? undefined,
      });

      res.status(result.eventCreated ? 201 : 200).json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to record fall detection event.",
      });
    }
  });

  router.post("/fall-detection/events/:eventId/cancel", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        actorRole?: unknown;
        actorName?: unknown;
        reason?: unknown;
      };
      const existing = sharedNotificationEngine
        .listFallEvents({ isAdmin: true })
        .find((e) => e.eventId === req.params.eventId);
      if (!existing) {
        res.status(404).json({ error: `Fall event '${req.params.eventId}' not found.` });
        return;
      }
      if (!auth.user && existing.ownerUid !== "sample_owner") {
        res.status(401).json({ error: "Authentication required for non-sample fall events." });
        return;
      }

      const actorRole =
        body.actorRole === "caregiver" || body.actorRole === "admin" ? body.actorRole : "patient";
      const updated = sharedNotificationEngine.cancelFallEventSafe({
        eventId: req.params.eventId,
        actorUid: auth.user?.uid ?? "sample_owner",
        actorRole: auth.user?.isAdmin && actorRole === "admin" ? "admin" : actorRole,
        actorName:
          typeof body.actorName === "string" && body.actorName.trim()
            ? body.actorName.trim()
            : auth.user?.displayName || actorRole,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        isAdmin: auth.user?.isAdmin,
      });
      res.json({ ok: true, fallEvent: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to cancel fall event.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post("/fall-detection/events/:eventId/request-help", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        actorRole?: unknown;
        actorName?: unknown;
        reason?: unknown;
      };
      const existing = sharedNotificationEngine
        .listFallEvents({ isAdmin: true })
        .find((e) => e.eventId === req.params.eventId);
      if (!existing) {
        res.status(404).json({ error: `Fall event '${req.params.eventId}' not found.` });
        return;
      }
      if (!auth.user && existing.ownerUid !== "sample_owner") {
        res.status(401).json({ error: "Authentication required for non-sample fall events." });
        return;
      }

      const actorRole =
        body.actorRole === "caregiver" || body.actorRole === "admin" ? body.actorRole : "patient";
      const result = await sharedNotificationEngine.requestFallEventHelp({
        eventId: req.params.eventId,
        actorUid: auth.user?.uid ?? "sample_owner",
        actorRole: auth.user?.isAdmin && actorRole === "admin" ? "admin" : actorRole,
        actorName:
          typeof body.actorName === "string" && body.actorName.trim()
            ? body.actorName.trim()
            : auth.user?.displayName || actorRole,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        isAdmin: auth.user?.isAdmin,
        publicBaseUrlOverride: resolvePublicBaseUrl(req) ?? undefined,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to escalate fall event.";
      const status = msg.startsWith("Forbidden") ? 403 : msg.includes("not found") ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post("/fall-detection/telemetry", async (req, res) => {
    const auth = await resolveOptionalUser(req);
    if (auth.provided && !auth.user) {
      res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
      return;
    }

    const body = (req.body ?? {}) as {
      patientId?: unknown;
      patientOwnerUid?: unknown;
      cameraStatus?: unknown;
      deviceLabel?: unknown;
      peopleCount?: unknown;
      poseConfidence?: unknown;
      sensorDisagreement?: unknown;
      errorMessage?: unknown;
    };

    const patientId = typeof body.patientId === "string" ? body.patientId.trim() : "";
    if (!patientId) {
      res.status(400).json({ error: "patientId is required." });
      return;
    }

    const allowedStatuses = new Set<CameraMonitoringStatus>([
      "standby",
      "active",
      "denied",
      "unavailable",
      "disconnected",
      "low_confidence",
      "out_of_frame",
    ]);
    const cameraStatus: CameraMonitoringStatus =
      typeof body.cameraStatus === "string" && allowedStatuses.has(body.cameraStatus as CameraMonitoringStatus)
        ? (body.cameraStatus as CameraMonitoringStatus)
        : "standby";

    const snapshot = sharedNotificationEngine.recordCameraTelemetry({
      patientId,
      ownerUid:
        typeof body.patientOwnerUid === "string" && body.patientOwnerUid.trim()
          ? body.patientOwnerUid.trim()
          : auth.user?.uid || "sample_owner",
      cameraStatus,
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
      peopleCount:
        typeof body.peopleCount === "number" && Number.isFinite(body.peopleCount)
          ? Math.max(0, Math.round(body.peopleCount))
          : 0,
      poseConfidence:
        typeof body.poseConfidence === "number" && Number.isFinite(body.poseConfidence)
          ? Math.max(0, Math.min(1, body.poseConfidence))
          : 0,
      sensorDisagreement: Boolean(body.sensorDisagreement),
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage.slice(0, 240) : undefined,
    });

    res.json({ ok: true, snapshot });
  });

  router.post("/ai/assistant", async (req, res) => {
    try {
      const auth = await resolveOptionalUser(req);
      if (auth.provided && !auth.user) {
        res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
        return;
      }

      const body = req.body as {
        question?: string;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
        context?: AssistantContextPayload;
      };

      const question = typeof body?.question === "string" ? body.question.trim() : "";
      if (!question || question.length > 1500) {
        res.status(400).json({ error: "A question between 1 and 1500 characters is required." });
        return;
      }
      if (!body.context) {
        res.status(400).json({ error: "Patient telemetry context is required." });
        return;
      }

      // Enforce authorization when caller is authenticated and querying non-sample patient data
      if (
        auth.user &&
        !auth.user.isAdmin &&
        body.context.patientId &&
        body.context.patientId !== "patient_primary"
      ) {
        const isOwner = body.context.patientOwnerUid === auth.user.uid;
        const isLinkedCaregiver = sharedNotificationEngine.isAuthorizedCaregiverForPatient(
          auth.user.uid,
          body.context.patientId
        );
        if (!isOwner && !isLinkedCaregiver) {
          res.status(403).json({
            error: "Forbidden: caller is not authorized to query this patient's telemetry or alerts.",
          });
          return;
        }
      }

      const answer = await askSmartCareAssistant(question, body.history ?? [], body.context);
      res.json({ answer });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Gemini assistant request failed.";
      let status = 500;
      let cleanMsg = raw;
      if (raw.includes("GEMINI_API_KEY")) {
        status = 503;
      } else if (raw.includes("503") || raw.includes("UNAVAILABLE")) {
        status = 503;
        cleanMsg = "Gemini AI is temporarily experiencing high demand (503 UNAVAILABLE). Please retry in a moment.";
      } else if (raw.includes("429") || raw.includes("RESOURCE_EXHAUSTED")) {
        status = 429;
        cleanMsg = "Gemini AI rate limit or quota reached (429 RESOURCE_EXHAUSTED).";
      } else if (raw.includes("403") || raw.includes("PERMISSION_DENIED") || raw.includes("API_KEY_INVALID")) {
        status = 403;
        cleanMsg = "Gemini API key was rejected (403/400). Check Settings > Secrets.";
      }
      res.status(status).json({ error: cleanMsg });
    }
  });

  return router;
}
