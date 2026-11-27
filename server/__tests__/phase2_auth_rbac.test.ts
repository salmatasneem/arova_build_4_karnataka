import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { createWearableRouter } from "../esp32Ingest.ts";
import {
  getFirebaseProjectId,
  getFirebaseServerSummary,
  isAdminEmail,
  setTestTokenVerifier,
} from "../firebaseAuth.ts";
import {
  clearServerAuditLogsForTests,
  createRbacRouter,
  getServerAuditLogs,
} from "../rbacRoutes.ts";

describe("Phase 2 — Firebase Auth, RBAC, Audit Logs & Wearable Ingest Deduplication", () => {
  beforeEach(() => {
    clearServerAuditLogsForTests();
    setTestTokenVerifier(async (token) => {
      if (token === "patient_unverified_tok") {
        return {
          uid: "uid_patient_unverified",
          email: "patient.new@example.com",
          emailVerified: false,
          displayName: "New Patient",
          isAdmin: false,
        };
      }
      if (token === "caregiver_tok") {
        return {
          uid: "uid_caregiver_1",
          email: "caregiver1@example.com",
          emailVerified: true,
          displayName: "Caregiver One",
          isAdmin: false,
        };
      }
      if (token === "unverified_admin_email_tok") {
        return {
          uid: "uid_unverified_admin",
          email: "salmatasneem692@gmail.com",
          emailVerified: false,
          displayName: "Unverified Admin Claim",
          isAdmin: isAdminEmail("salmatasneem692@gmail.com", false),
        };
      }
      if (token === "admin_verified_tok") {
        return {
          uid: "uid_admin_verified",
          email: "salmatasneem692@gmail.com",
          emailVerified: true,
          displayName: "AROVA Admin",
          isAdmin: isAdminEmail("salmatasneem692@gmail.com", true),
        };
      }
      return null;
    });
  });

  afterEach(() => {
    setTestTokenVerifier(null);
    clearServerAuditLogsForTests();
  });

  it("1. Enforces verified email requirement for admin allowlist & resolves Firebase server summary", () => {
    assert.equal(isAdminEmail("salmatasneem692@gmail.com", false), false);
    assert.equal(isAdminEmail("salmatasneem692@gmail.com", true), true);
    assert.equal(isAdminEmail("  SALMATASNEEM692@gmail.com ", true), true);
    assert.equal(isAdminEmail("aasiyahadiya7575@gmail.com", true), true);
    assert.equal(isAdminEmail("salmatasneem75@gmail.com", true), true);
    assert.equal(isAdminEmail("random.user@example.com", true), false);
    assert.equal(isAdminEmail(null, true), false);

    const summary = getFirebaseServerSummary();
    assert.equal(summary.configured, true);
    assert.equal(summary.projectId, getFirebaseProjectId());
    assert.equal(summary.projectId, "arcane-bay-qsmzh");
  });

  it("2. Protects /api/auth/session, /api/auth/audit, and /api/audit-logs with strict RBAC", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createRbacRouter());

    const server = app.listen(0);
    const addr = server.address();
    assert(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      // Unauthenticated session & audit checks -> 401
      const unauthSession = await fetch(`${base}/api/auth/session`);
      assert.equal(unauthSession.status, 401);

      const unauthAuditPost = await fetch(`${base}/api/auth/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "login",
          summary: "Attempt",
          actorRole: "patient",
        }),
      });
      assert.equal(unauthAuditPost.status, 401);

      const unauthAuditLogs = await fetch(`${base}/api/audit-logs`);
      assert.equal(unauthAuditLogs.status, 401);

      // Authenticated unverified patient -> 200 on /api/auth/session, isAdmin false
      const patientSessionRes = await fetch(`${base}/api/auth/session`, {
        headers: { Authorization: "Bearer patient_unverified_tok" },
      });
      assert.equal(patientSessionRes.status, 200);
      const patientSession = (await patientSessionRes.json()) as {
        authenticated: boolean;
        user: { uid: string; isAdmin: boolean; recommendedRoleRedirect?: string };
        firebase: { configured: boolean; projectId: string };
      };
      assert.equal(patientSession.authenticated, true);
      assert.equal(patientSession.user.uid, "uid_patient_unverified");
      assert.equal(patientSession.user.isAdmin, false);
      assert.equal(patientSession.user.recommendedRoleRedirect, undefined);
      assert.equal(patientSession.firebase.configured, true);

      // Unverified email matching admin allowlist still cannot elevate to admin
      const unverifiedAdminSessionRes = await fetch(`${base}/api/auth/session`, {
        headers: { Authorization: "Bearer unverified_admin_email_tok" },
      });
      assert.equal(unverifiedAdminSessionRes.status, 200);
      const unverifiedAdminSession = (await unverifiedAdminSessionRes.json()) as {
        user: { isAdmin: boolean };
      };
      assert.equal(unverifiedAdminSession.user.isAdmin, false);

      // Non-admin trying to record actorRole: "admin" -> 403
      const forgeAdminAuditRes = await fetch(`${base}/api/auth/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_tok",
        },
        body: JSON.stringify({
          eventType: "role_escalation",
          summary: "Tried to impersonate admin",
          actorRole: "admin",
        }),
      });
      assert.equal(forgeAdminAuditRes.status, 403);

      // Invalid audit payload -> 400
      const invalidAuditRes = await fetch(`${base}/api/auth/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_tok",
        },
        body: JSON.stringify({
          eventType: "",
          summary: "Missing eventType",
          actorRole: "caregiver",
        }),
      });
      assert.equal(invalidAuditRes.status, 400);

      // Caregiver recording valid caregiver audit event -> 201
      const validCaregiverAuditRes = await fetch(`${base}/api/auth/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_tok",
        },
        body: JSON.stringify({
          eventType: "alert_acknowledged",
          summary: "Caregiver acknowledged alert alt_101",
          actorRole: "caregiver",
          targetId: "alt_101",
        }),
      });
      assert.equal(validCaregiverAuditRes.status, 201);

      // Non-admin reading /api/audit-logs -> 403
      const caregiverReadLogs = await fetch(`${base}/api/audit-logs`, {
        headers: { Authorization: "Bearer caregiver_tok" },
      });
      assert.equal(caregiverReadLogs.status, 403);

      // Verified admin session -> 200 with recommendedRoleRedirect === "admin"
      const adminSessionRes = await fetch(`${base}/api/auth/session`, {
        headers: { Authorization: "Bearer admin_verified_tok" },
      });
      assert.equal(adminSessionRes.status, 200);
      const adminSession = (await adminSessionRes.json()) as {
        user: { isAdmin: boolean; recommendedRoleRedirect?: string };
      };
      assert.equal(adminSession.user.isAdmin, true);
      assert.equal(adminSession.user.recommendedRoleRedirect, "admin");

      // Verified admin recording admin event -> 201 & reading /api/audit-logs -> 200
      const adminAuditRes = await fetch(`${base}/api/auth/audit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin_verified_tok",
        },
        body: JSON.stringify({
          eventType: "caregiver_link_approved",
          summary: "Admin approved caregiver link",
          actorRole: "admin",
          targetId: "link_9",
        }),
      });
      assert.equal(adminAuditRes.status, 201);

      const adminReadLogsRes = await fetch(`${base}/api/audit-logs?limit=10`, {
        headers: { Authorization: "Bearer admin_verified_tok" },
      });
      assert.equal(adminReadLogsRes.status, 200);
      const logsJson = (await adminReadLogsRes.json()) as {
        logs: Array<{ eventType: string; actorRole: string; targetId?: string }>;
      };
      assert.equal(logsJson.logs.length, 2);
      assert.equal(logsJson.logs[0].eventType, "caregiver_link_approved");
      assert.equal(logsJson.logs[1].eventType, "alert_acknowledged");
      assert.equal(getServerAuditLogs(10).length, 2);
    } finally {
      server.close();
    }
  });

  it("3. Rejects duplicate (patientId, deviceId, timestamp) telemetry packets with HTTP 409 while permitting distinct timestamps", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/wearable", createWearableRouter());

    const server = app.listen(0);
    const addr = server.address();
    assert(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const ts1 = `2026-11-27T04:00:00.000Z`;
      const ts2 = `2026-11-27T04:00:05.000Z`;
      const basePayload = {
        patientId: "pt_dedup_phase2",
        deviceId: "ESP32-DEDUP-01",
        heartRate: 76,
        spo2: 98,
        temperatureC: 36.6,
        movementStatus: "resting",
        source: "simulator",
      };

      const firstRes = await fetch(`${base}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, timestamp: ts1 }),
      });
      assert.equal(firstRes.status, 200);

      // Exact replay with same patientId, deviceId, and timestamp -> 409 Conflict
      const dupRes = await fetch(`${base}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, timestamp: ts1 }),
      });
      assert.equal(dupRes.status, 409);

      // New timestamp -> 200 OK
      const nextRes = await fetch(`${base}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, timestamp: ts2 }),
      });
      assert.equal(nextRes.status, 200);

      // Omitted timestamp packets are never rejected as duplicates
      const noTs1 = await fetch(`${base}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      });
      const noTs2 = await fetch(`${base}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      });
      assert.equal(noTs1.status, 200);
      assert.equal(noTs2.status, 200);
    } finally {
      server.close();
    }
  });
});
