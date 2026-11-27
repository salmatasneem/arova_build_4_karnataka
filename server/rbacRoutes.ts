import express from "express";
import {
  getFirebaseServerSummary,
  requireAdminFirebaseUser,
  requireAuthenticatedFirebaseUser,
  type AuthenticatedRequest,
} from "./firebaseAuth.ts";

export type AuditActorRole = "patient" | "caregiver" | "admin";

export interface ServerAuditLogRecord {
  logId: string;
  userId: string;
  actorRole: AuditActorRole;
  eventType: string;
  summary: string;
  targetId?: string;
  createdAt: string;
}

const MAX_AUDIT_LOGS = 500;
const serverAuditLogs: ServerAuditLogRecord[] = [];

export function recordServerAuditEvent(input: {
  userId: string;
  actorRole: AuditActorRole;
  eventType: string;
  summary: string;
  targetId?: string;
}): ServerAuditLogRecord {
  const entry: ServerAuditLogRecord = {
    logId: `srv_log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: input.userId.slice(0, 128),
    actorRole: input.actorRole,
    eventType: input.eventType.trim().slice(0, 80) || "system_event",
    summary: input.summary.trim().slice(0, 400) || "AROVA event recorded.",
    ...(input.targetId ? { targetId: input.targetId.trim().slice(0, 128) } : {}),
    createdAt: new Date().toISOString(),
  };

  serverAuditLogs.unshift(entry);
  if (serverAuditLogs.length > MAX_AUDIT_LOGS) {
    serverAuditLogs.length = MAX_AUDIT_LOGS;
  }
  return entry;
}

export function getServerAuditLogs(limitCount = 100): ServerAuditLogRecord[] {
  const safeLimit = Math.max(1, Math.min(MAX_AUDIT_LOGS, Math.round(limitCount)));
  return serverAuditLogs.slice(0, safeLimit);
}

export function clearServerAuditLogsForTests(): void {
  serverAuditLogs.length = 0;
}

export function createRbacRouter(): express.Router {
  const router = express.Router();

  router.get("/auth/session", requireAuthenticatedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    res.json({
      authenticated: true,
      user: {
        uid: user.uid,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
        recommendedRoleRedirect: user.isAdmin ? "admin" : undefined,
      },
      firebase: getFirebaseServerSummary(),
    });
  });

  router.post("/auth/audit", requireAuthenticatedFirebaseUser, (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const body = req.body as {
      eventType?: unknown;
      summary?: unknown;
      actorRole?: unknown;
      targetId?: unknown;
    };

    const eventType = typeof body?.eventType === "string" ? body.eventType.trim() : "";
    const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
    const requestedRole = typeof body?.actorRole === "string" ? body.actorRole.trim() : "patient";
    const targetId = typeof body?.targetId === "string" ? body.targetId.trim() : undefined;

    if (!eventType || eventType.length > 80) {
      res.status(400).json({ error: "eventType (1..80 characters) is required." });
      return;
    }
    if (!summary || summary.length > 400) {
      res.status(400).json({ error: "summary (1..400 characters) is required." });
      return;
    }
    if (requestedRole !== "patient" && requestedRole !== "caregiver" && requestedRole !== "admin") {
      res.status(400).json({ error: "actorRole must be patient, caregiver, or admin." });
      return;
    }
    if (requestedRole === "admin" && !user.isAdmin) {
      res.status(403).json({
        error: "Forbidden: cannot record an administrator audit event without verified admin authorization.",
      });
      return;
    }

    const log = recordServerAuditEvent({
      userId: user.uid,
      actorRole: requestedRole,
      eventType,
      summary,
      targetId,
    });

    res.status(201).json({ ok: true, log });
  });

  router.get("/audit-logs", requireAdminFirebaseUser, (req: AuthenticatedRequest, res) => {
    const rawLimit = Number(req.query.limit);
    const limitCount = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;
    res.json({
      logs: getServerAuditLogs(limitCount),
    });
  });

  return router;
}
