import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { sharedBaselineTracker } from "../baselineTracker.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { isAdminEmail, setTestTokenVerifier } from "../firebaseAuth.ts";
import { sharedNotificationEngine } from "../notificationEngine.ts";
import {
  dispatchEmailNotification,
  dispatchSmsNotification,
  dispatchVoiceCallNotification,
  getNotificationProvidersStatus,
} from "../notificationProviders.ts";
import { createNotificationRouter } from "../notificationRoutes.ts";
import { clearServerAuditLogsForTests } from "../rbacRoutes.ts";
import type { MlAnalysisResult, TelemetryPayload } from "../types.ts";

const TEST_PATIENT_IDS = [
  "patient_p5_normal",
  "patient_p5_warn",
  "patient_p5_crit",
  "patient_p5_dup",
  "patient_p5_ack",
  "patient_p5_rbac",
  "patient_p5_esc",
  "patient_p5_poor",
  "patient_p5_err",
  "patient_p5_ai",
];

function makeAnalysis(overrides: Partial<MlAnalysisResult> = {}): MlAnalysisResult {
  return {
    mlServiceConnected: false,
    mlEngine: "unconnected_rule_check",
    modelTrained: true,
    modelVersion: "arova_test_v1",
    ecgModelTrained: false,
    signalQuality: "good",
    anomalyStatus: "normal",
    anomalyScore: 0.14,
    alertLevel: "Normal",
    triggeredMetrics: [],
    contributingFeatures: [],
    contributingDetails: [],
    persistenceCount: 0,
    persistenceRequired: 2,
    matchedBaselineContext: "resting",
    windowSize: 6,
    baselineProgress: {
      collectedSamples: 25,
      requiredSamples: 20,
      status: "ready",
      source: "simulator",
      modelVersion: "arova_test_v1",
      restingSamples: 25,
      activeSamples: 0,
      ecgBaselineSamples: 0,
    },
    explanation: "Readings align with resting personal baseline.",
    ...overrides,
  };
}

function makeTelemetry(
  patientId: string,
  overrides: Partial<TelemetryPayload> = {}
): TelemetryPayload {
  return {
    patientId,
    deviceId: "arova_sim_test",
    timestamp: new Date().toISOString(),
    heartRate: 74,
    spo2: 98,
    temperatureC: 36.7,
    movementStatus: "resting",
    accelMagnitude: 1.0,
    gyroMagnitude: 3.5,
    possibleFallDetected: false,
    irSignalOk: true,
    fingerDetected: true,
    source: "simulator",
    ...overrides,
  };
}

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use("/api", createNotificationRouter());
  const server = app.listen(0);
  const addr = server.address();
  assert(addr && typeof addr === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

describe("Phase 5 — Intelligent Alerts, Notifications, Escalation, Providers & Gemini Assistant", () => {
  beforeEach(() => {
    sharedNotificationEngine.clearForTests();
    sharedAlertDecisionEngine.clear();
    sharedWindowStore.clear();
    clearServerAuditLogsForTests();

    setTestTokenVerifier(async (token) => {
      if (token === "patient_tok") {
        return {
          uid: "uid_patient_p5",
          email: "patient.p5@example.com",
          emailVerified: true,
          displayName: "Patient P5",
          isAdmin: false,
        };
      }
      if (token === "caregiver_active_tok") {
        return {
          uid: "uid_cg_active",
          email: "cg.active@example.com",
          emailVerified: true,
          displayName: "Active Caregiver",
          isAdmin: false,
        };
      }
      if (token === "caregiver_revoked_tok") {
        return {
          uid: "uid_cg_revoked",
          email: "cg.revoked@example.com",
          emailVerified: true,
          displayName: "Revoked Caregiver",
          isAdmin: false,
        };
      }
      if (token === "caregiver_unlinked_tok") {
        return {
          uid: "uid_cg_unlinked",
          email: "cg.unlinked@example.com",
          emailVerified: true,
          displayName: "Unlinked User",
          isAdmin: false,
        };
      }
      if (token === "admin_tok") {
        return {
          uid: "uid_admin_p5",
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
    sharedNotificationEngine.clearForTests();
    sharedAlertDecisionEngine.clear();
    sharedWindowStore.clear();
    clearServerAuditLogsForTests();
    for (const pid of TEST_PATIENT_IDS) {
      sharedBaselineTracker.resetPatient(pid);
    }
  });

  it("1. Normal state creates no alert and no notifications", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer patient_tok",
        },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_normal"),
          patientOwnerUid: "uid_patient_p5",
          analysis: makeAnalysis({ alertLevel: "Normal", anomalyStatus: "normal" }),
        }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        evaluation: {
          monitoringState: string;
          alertCreated: boolean;
          alert: unknown;
          notifications: unknown[];
        };
      };
      assert.equal(data.evaluation.monitoringState, "Normal");
      assert.equal(data.evaluation.alertCreated, false);
      assert.equal(data.evaluation.alert, null);
      assert.equal(data.evaluation.notifications.length, 0);
    } finally {
      server.close();
    }
  });

  it("2. Warning alert creates patient notification & authorized caregiver notification without voice call escalation", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_warn_1",
        patientId: "patient_p5_warn",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15550001111",
        caregiverEmail: "cg.active@example.com",
        explicitCallConsent: true,
        priority: "primary",
        status: "active",
      });

      const res = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer patient_tok",
        },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_warn", { heartRate: 118 }),
          patientOwnerUid: "uid_patient_p5",
          analysis: makeAnalysis({
            alertLevel: "Warning",
            anomalyStatus: "anomalous",
            anomalyScore: -0.09,
            triggeredMetrics: ["Heart Rate"],
            explanation: "Heart rate 118 BPM sustained above resting personal baseline.",
          }),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        evaluation: {
          monitoringState: string;
          alertCreated: boolean;
          alert: {
            level: string;
            prototypeNotice: string;
            escalationStatus: string;
            notificationAttempts: Array<{ channel: string; recipientRole: string }>;
          };
          notifications: Array<{ recipientRole: string; recipientUid?: string; isSimulated: boolean }>;
        };
      };

      assert.equal(body.evaluation.monitoringState, "Warning");
      assert.equal(body.evaluation.alertCreated, true);
      assert.equal(body.evaluation.alert.level, "Warning");
      assert.match(body.evaluation.alert.prototypeNotice, /prototype monitoring notification/i);
      assert.match(body.evaluation.alert.prototypeNotice, /not a medical diagnosis/i);
      assert.equal(body.evaluation.alert.escalationStatus, "notified_caregiver");

      const patientNotifs = body.evaluation.notifications.filter((n) => n.recipientRole === "patient");
      const cgNotifs = body.evaluation.notifications.filter(
        (n) => n.recipientRole === "caregiver" && n.recipientUid === "uid_cg_active"
      );
      assert.equal(patientNotifs.length, 1);
      assert.equal(cgNotifs.length, 1);
      assert.equal(
        body.evaluation.alert.notificationAttempts.some((a) => a.channel === "voice_call"),
        false
      );
    } finally {
      server.close();
    }
  });

  it("3. Critical acute telemetry triggers Critical alert, patient notification, and awaiting_patient_ack state", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer patient_tok",
        },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_crit", {
            heartRate: 156,
            spo2: 85,
            temperatureC: 39.8,
          }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 5000,
        }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        analysis: MlAnalysisResult;
        evaluation: {
          monitoringState: string;
          alertCreated: boolean;
          alert: {
            level: string;
            escalationStatus: string;
            patientAcknowledged: boolean;
            notificationStatus: string;
            relevantReadings: { heartRate: number | null; spo2: number | null };
          };
          notifications: Array<{ recipientRole: string; deliveryStatus: string; isSimulated: boolean }>;
        };
      };

      assert.equal(data.analysis.alertLevel, "Critical");
      assert.equal(data.evaluation.monitoringState, "Critical");
      assert.equal(data.evaluation.alertCreated, true);
      assert.equal(data.evaluation.alert.level, "Critical");
      assert.equal(data.evaluation.alert.escalationStatus, "awaiting_patient_ack");
      assert.equal(data.evaluation.alert.patientAcknowledged, false);
      assert.equal(data.evaluation.alert.relevantReadings.heartRate, 156);
      assert.equal(data.evaluation.alert.relevantReadings.spo2, 85);
      assert.equal(data.evaluation.notifications.length, 1);
      assert.equal(data.evaluation.notifications[0].recipientRole, "patient");
      assert.equal(data.evaluation.notifications[0].deliveryStatus, "simulated");
      assert.equal(data.evaluation.notifications[0].isSimulated, true);
    } finally {
      server.close();
    }
  });

  it("4. Duplicate alert suppression prevents repeat alerts within window and allows escalation or post-ack alerts", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      // 1) Initial Warning
      const firstRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_dup", { heartRate: 115 }),
          patientOwnerUid: "uid_patient_p5",
          analysis: makeAnalysis({
            alertLevel: "Warning",
            anomalyStatus: "anomalous",
            anomalyScore: -0.08,
            triggeredMetrics: ["Heart Rate"],
            explanation: "Elevated heart rate above baseline.",
          }),
        }),
      });
      const first = (await firstRes.json()) as {
        evaluation: { alertCreated: boolean; alert: { alertId: string } };
      };
      assert.equal(first.evaluation.alertCreated, true);
      const warnAlertId = first.evaluation.alert.alertId;

      // 2) Duplicate Warning within window -> suppressed
      const dupRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_dup", { heartRate: 117 }),
          patientOwnerUid: "uid_patient_p5",
          analysis: makeAnalysis({
            alertLevel: "Warning",
            anomalyStatus: "anomalous",
            anomalyScore: -0.09,
            triggeredMetrics: ["Heart Rate"],
            explanation: "Elevated heart rate continues.",
          }),
        }),
      });
      const dup = (await dupRes.json()) as {
        evaluation: {
          alertCreated: boolean;
          duplicateSuppressed: boolean;
          suppressedAlertId?: string;
          alert: { suppressedOccurrences: number };
          notifications: unknown[];
        };
      };
      assert.equal(dup.evaluation.alertCreated, false);
      assert.equal(dup.evaluation.duplicateSuppressed, true);
      assert.equal(dup.evaluation.suppressedAlertId, warnAlertId);
      assert.equal(dup.evaluation.alert.suppressedOccurrences, 1);
      assert.equal(dup.evaluation.notifications.length, 0);

      // 3) Escalation Warning -> Critical emits a new alert
      const critRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_dup", { heartRate: 152, spo2: 86 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 5000,
          analysis: makeAnalysis({
            alertLevel: "Critical",
            anomalyStatus: "anomalous",
            anomalyScore: -0.24,
            triggeredMetrics: ["Heart Rate", "SpO2"],
            explanation: "Critical deviation in HR and SpO2.",
          }),
        }),
      });
      const crit = (await critRes.json()) as {
        evaluation: { alertCreated: boolean; alert: { alertId: string } };
      };
      assert.equal(crit.evaluation.alertCreated, true);
      assert.notEqual(crit.evaluation.alert.alertId, warnAlertId);

      // 4) Acknowledge Critical alert -> new Critical alert is allowed afterwards
      const ackRes = await fetch(`${baseUrl}/api/alerts/${crit.evaluation.alert.alertId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({ actorRole: "patient" }),
      });
      assert.equal(ackRes.status, 200);

      const postAckRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_dup", { heartRate: 155, spo2: 84 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 5000,
          analysis: makeAnalysis({
            alertLevel: "Critical",
            anomalyStatus: "anomalous",
            anomalyScore: -0.26,
            triggeredMetrics: ["Heart Rate", "SpO2"],
            explanation: "New post-ack critical episode.",
          }),
        }),
      });
      const postAck = (await postAckRes.json()) as {
        evaluation: { alertCreated: boolean; alert: { alertId: string } };
      };
      assert.equal(postAck.evaluation.alertCreated, true);
      assert.notEqual(postAck.evaluation.alert.alertId, crit.evaluation.alert.alertId);
    } finally {
      server.close();
    }
  });

  it("5. Patient acknowledgement cancels pending caregiver escalation timer cleanly", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_ack_1",
        patientId: "patient_p5_ack",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15550001111",
        priority: "primary",
        status: "active",
      });

      const createRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_ack", { heartRate: 155, spo2: 86 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 90,
        }),
      });
      const created = (await createRes.json()) as {
        evaluation: { alert: { alertId: string } };
      };

      const ackRes = await fetch(
        `${baseUrl}/api/alerts/${created.evaluation.alert.alertId}/acknowledge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
          body: JSON.stringify({ actorRole: "patient", followUpAction: "Resting and hydrating." }),
        }
      );
      assert.equal(ackRes.status, 200);
      const acked = (await ackRes.json()) as {
        alert: {
          patientAcknowledged: boolean;
          escalationStatus: string;
          escalatedToCaregiversAt?: string;
        };
      };
      assert.equal(acked.alert.patientAcknowledged, true);
      assert.equal(acked.alert.escalationStatus, "patient_acknowledged");

      // Wait beyond the 90ms escalation deadline to verify timer was cancelled
      await new Promise((r) => setTimeout(r, 180));

      const cgFeedRes = await fetch(
        `${baseUrl}/api/notifications?patientId=patient_p5_ack&role=caregiver`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      assert.equal(cgFeedRes.status, 200);
      const cgFeed = (await cgFeedRes.json()) as {
        alerts: Array<{ escalatedToCaregiversAt?: string; patientAcknowledged: boolean }>;
        notifications: unknown[];
      };
      assert.equal(cgFeed.notifications.length, 0);
      assert.equal(cgFeed.alerts[0].escalatedToCaregiversAt, undefined);
      assert.equal(cgFeed.alerts[0].patientAcknowledged, true);
    } finally {
      server.close();
    }
  });

  it("6. Caregiver consent RBAC allows linked caregiver and blocks revoked/unlinked users + protects admin config", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_rbac_active",
        patientId: "patient_p5_rbac",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_active",
        caregiverName: "Active Caregiver",
        priority: "primary",
        status: "active",
      });
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_rbac_revoked",
        patientId: "patient_p5_rbac",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_revoked",
        caregiverName: "Revoked Caregiver",
        priority: "secondary",
        status: "revoked",
      });

      const createRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_rbac", { heartRate: 152, spo2: 87 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 25,
        }),
      });
      const created = (await createRes.json()) as {
        evaluation: { alert: { alertId: string } };
      };
      const alertId = created.evaluation.alert.alertId;
      await new Promise((r) => setTimeout(r, 90));

      // Revoked and unlinked callers receive zero patient alerts/notifications
      for (const badToken of ["caregiver_revoked_tok", "caregiver_unlinked_tok"]) {
        const feedRes = await fetch(`${baseUrl}/api/notifications?patientId=patient_p5_rbac`, {
          headers: { Authorization: `Bearer ${badToken}` },
        });
        assert.equal(feedRes.status, 200);
        const feed = (await feedRes.json()) as { alerts: unknown[]; notifications: unknown[] };
        assert.equal(feed.alerts.length, 0);
        assert.equal(feed.notifications.length, 0);

        const ackBad = await fetch(`${baseUrl}/api/alerts/${alertId}/acknowledge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${badToken}`,
          },
          body: JSON.stringify({ actorRole: "caregiver" }),
        });
        assert.equal(ackBad.status, 403);

        const falseBad = await fetch(`${baseUrl}/api/alerts/${alertId}/false-alert`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${badToken}`,
          },
          body: JSON.stringify({ actorRole: "caregiver", reason: "Unauthorized attempt" }),
        });
        assert.equal(falseBad.status, 403);
      }

      // Active caregiver sees alert/notification and can acknowledge + resolve with follow-up note
      const activeFeedRes = await fetch(`${baseUrl}/api/notifications?patientId=patient_p5_rbac`, {
        headers: { Authorization: "Bearer caregiver_active_tok" },
      });
      const activeFeed = (await activeFeedRes.json()) as {
        alerts: Array<{ alertId: string }>;
        notifications: Array<{ recipientUid: string }>;
      };
      assert.equal(activeFeed.alerts.length, 1);
      assert.ok(activeFeed.notifications.some((n) => n.recipientUid === "uid_cg_active"));

      const ackOk = await fetch(`${baseUrl}/api/alerts/${alertId}/acknowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_active_tok",
        },
        body: JSON.stringify({
          actorRole: "caregiver",
          followUpAction: "Checked on patient by phone; sensor re-seated.",
        }),
      });
      assert.equal(ackOk.status, 200);

      const resolveOk = await fetch(`${baseUrl}/api/alerts/${alertId}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_active_tok",
        },
        body: JSON.stringify({
          actorRole: "caregiver",
          followUpAction: "Readings stabilized after rest.",
        }),
      });
      assert.equal(resolveOk.status, 200);
      const resolved = (await resolveOk.json()) as {
        alert: { status: string; followUpAction: string };
      };
      assert.equal(resolved.alert.status, "resolved");
      assert.match(resolved.alert.followUpAction, /stabilized/i);

      // Non-admin cannot change escalation timing config; admin can
      const nonAdminCfg = await fetch(`${baseUrl}/api/notifications/escalation-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({ patientAckTimeoutSec: 30 }),
      });
      assert.equal(nonAdminCfg.status, 403);

      const adminCfg = await fetch(`${baseUrl}/api/notifications/escalation-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin_tok" },
        body: JSON.stringify({ patientAckTimeoutSec: 45, duplicateAlertWindowSec: 90 }),
      });
      assert.equal(adminCfg.status, 200);
      const cfgBody = (await adminCfg.json()) as {
        config: { patientAckTimeoutSec: number; duplicateAlertWindowSec: number };
      };
      assert.equal(cfgBody.config.patientAckTimeoutSec, 45);
      assert.equal(cfgBody.config.duplicateAlertWindowSec, 90);
    } finally {
      server.close();
    }
  });

  it("7. Auto-escalation notifies authorized caregiver on timeout and prevents duplicate escalation", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_esc_1",
        patientId: "patient_p5_esc",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15552223333",
        caregiverEmail: "cg.active@example.com",
        explicitCallConsent: true,
        priority: "primary",
        status: "active",
      });

      const createRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_esc", { heartRate: 158, spo2: 84 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 30,
        }),
      });
      const created = (await createRes.json()) as {
        evaluation: { alert: { alertId: string } };
      };
      const alertId = created.evaluation.alert.alertId;

      await new Promise((r) => setTimeout(r, 110));

      const beforeRepeat = sharedNotificationEngine
        .listAlerts({ isAdmin: true, patientId: "patient_p5_esc" })
        .find((a) => a.alertId === alertId);
      assert(beforeRepeat);
      assert.equal(beforeRepeat.escalationStatus, "escalated_to_caregiver");
      assert.ok(beforeRepeat.escalatedToCaregiversAt);
      const initialAttempts = beforeRepeat.notificationAttempts.length;
      assert.ok(initialAttempts >= 2);

      // Re-invoking escalation must not create duplicate caregiver notifications or attempts
      await sharedNotificationEngine.escalateAlertToCaregivers(alertId, { trigger: "manual" });
      const afterRepeat = sharedNotificationEngine
        .listAlerts({ isAdmin: true, patientId: "patient_p5_esc" })
        .find((a) => a.alertId === alertId);
      assert(afterRepeat);
      assert.equal(afterRepeat.notificationAttempts.length, initialAttempts);
    } finally {
      server.close();
    }
  });

  it("8. External notification providers default to Simulation Mode and block emergency numbers (911/112/108)", async () => {
    const savedEnv = {
      EXOTEL_SID: process.env.EXOTEL_SID,
      EXOTEL_API_KEY: process.env.EXOTEL_API_KEY,
      EXOTEL_API_TOKEN: process.env.EXOTEL_API_TOKEN,
      EXOTEL_CALLER_ID: process.env.EXOTEL_CALLER_ID,
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
      NOTIFICATION_EMAIL_WEBHOOK_URL: process.env.NOTIFICATION_EMAIL_WEBHOOK_URL,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
    };

    try {
      for (const k of Object.keys(savedEnv) as Array<keyof typeof savedEnv>) {
        delete process.env[k];
      }

      const status = getNotificationProvidersStatus();
      assert.equal(status.sms.mode, "simulation");
      assert.equal(status.email.mode, "simulation");
      assert.equal(status.voice.mode, "simulation");
      assert.match(status.emergencyServicesGuardrail, /911|112|108/);

      const simSms = await dispatchSmsNotification({
        toPhone: "+15551234567",
        message: "Prototype test alert",
      });
      assert.equal(simSms.deliveryStatus, "simulated");
      assert.equal(simSms.isSimulated, true);

      const simEmail = await dispatchEmailNotification({
        toEmail: "caregiver@example.com",
        subject: "AROVA Prototype Alert",
        text: "Test email body",
      });
      assert.equal(simEmail.deliveryStatus, "simulated");
      assert.equal(simEmail.isSimulated, true);

      for (const emergencyNum of ["911", "112", "108"]) {
        const blockedSms = await dispatchSmsNotification({
          toPhone: emergencyNum,
          message: "Should be blocked",
        });
        assert.equal(blockedSms.deliveryStatus, "skipped_unauthorized");
        assert.equal(blockedSms.isSimulated, false);

        const blockedVoice = await dispatchVoiceCallNotification({
          toPhone: emergencyNum,
          explicitCallConsent: true,
          caregiverName: "Emergency",
          patientName: "Patient",
          reason: "Test",
        });
        assert.equal(blockedVoice.deliveryStatus, "skipped_unauthorized");
        assert.equal(blockedVoice.isSimulated, false);
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("9. Gemini AI assistant endpoint validates input, enforces patient RBAC, and handles missing API key", async () => {
    const { server, baseUrl } = await startTestServer();
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    try {
      // 400 on missing question / missing context
      const badQuestion = await fetch(`${baseUrl}/api/ai/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "   ", context: {} }),
      });
      assert.equal(badQuestion.status, 400);

      const badContext = await fetch(`${baseUrl}/api/ai/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Explain my heart rate" }),
      });
      assert.equal(badContext.status, 400);

      // 401 on invalid bearer token
      const badToken = await fetch(`${baseUrl}/api/ai/assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid_token_xyz",
        },
        body: JSON.stringify({
          question: "Explain my readings",
          context: {
            role: "patient",
            patientId: "patient_p5_ai",
            patientOwnerUid: "uid_patient_p5",
            patientName: "Patient P5",
            dataMode: "sample",
            baselineStatus: "ready",
            baselineSummary: "Mean HR 74",
            recentReadings: [],
            recentAlerts: [],
          },
        }),
      });
      assert.equal(badToken.status, 401);

      // 403 when unlinked user queries another patient's telemetry
      const crossPatient = await fetch(`${baseUrl}/api/ai/assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer caregiver_unlinked_tok",
        },
        body: JSON.stringify({
          question: "Summarize alerts",
          context: {
            role: "caregiver",
            patientId: "patient_p5_ai",
            patientOwnerUid: "uid_patient_p5",
            patientName: "Patient P5",
            dataMode: "live",
            baselineStatus: "ready",
            baselineSummary: "Mean HR 74",
            recentReadings: [],
            recentAlerts: [],
          },
        }),
      });
      assert.equal(crossPatient.status, 403);

      // 503 when authorized owner asks while GEMINI_API_KEY is unset
      delete process.env.GEMINI_API_KEY;
      const missingKeyRes = await fetch(`${baseUrl}/api/ai/assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer patient_tok",
        },
        body: JSON.stringify({
          question: "Why was my alert triggered?",
          context: {
            role: "patient",
            patientId: "patient_p5_ai",
            patientOwnerUid: "uid_patient_p5",
            patientName: "Patient P5",
            dataMode: "sample",
            baselineStatus: "ready",
            baselineSummary: "Mean HR 74",
            recentReadings: [],
            recentAlerts: [],
          },
        }),
      });
      assert.equal(missingKeyRes.status, 503);
      const errBody = (await missingKeyRes.json()) as { error: string };
      assert.match(errBody.error, /GEMINI_API_KEY/i);
    } finally {
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGeminiKey;
      server.close();
    }
  });

  it("10. Poor-quality / null sensor telemetry pauses scoring without emitting false alerts", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_poor", {
            heartRate: null,
            spo2: null,
            fingerDetected: false,
            irSignalOk: false,
          }),
          patientOwnerUid: "uid_patient_p5",
        }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        analysis: MlAnalysisResult;
        evaluation: {
          monitoringState: string;
          alertCreated: boolean;
          alert: unknown;
          notifications: unknown[];
        };
      };
      assert.equal(data.analysis.anomalyStatus, "paused_poor_quality");
      assert.equal(data.analysis.alertLevel, "Normal");
      assert.equal(data.evaluation.monitoringState, "Normal");
      assert.equal(data.evaluation.alertCreated, false);
      assert.equal(data.evaluation.alert, null);
      assert.equal(data.evaluation.notifications.length, 0);
    } finally {
      server.close();
    }
  });

  it("11. Provider dispatch failures are caught gracefully and recorded in admin error logs", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_err_1",
        patientId: "patient_p5_err",
        patientOwnerUid: "uid_patient_p5",
        caregiverUid: "uid_cg_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15559990000",
        caregiverEmail: "cg.active@example.com",
        priority: "primary",
        status: "active",
      });

      sharedNotificationEngine.setDispatchHooksForTests({
        sms: async () => {
          throw new Error("Simulated SMS Gateway Timeout");
        },
      });

      const createRes = await fetch(`${baseUrl}/api/alerts/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          telemetry: makeTelemetry("patient_p5_err", { heartRate: 160, spo2: 83 }),
          patientOwnerUid: "uid_patient_p5",
          patientAckTimeoutMsOverride: 25,
        }),
      });
      assert.equal(createRes.status, 200);

      await new Promise((r) => setTimeout(r, 110));

      const statsRes = await fetch(`${baseUrl}/api/notifications/stats`, {
        headers: { Authorization: "Bearer admin_tok" },
      });
      assert.equal(statsRes.status, 200);
      const statsBody = (await statsRes.json()) as {
        stats: { errorCount: number; criticalAlerts: number };
        errorLogs: Array<{ channel: string; message: string }>;
      };
      assert.ok(statsBody.stats.criticalAlerts >= 1);
      assert.ok(statsBody.stats.errorCount >= 1);
      assert.ok(
        statsBody.errorLogs.some(
          (l) => l.channel === "sms" && l.message.includes("Simulated SMS Gateway Timeout")
        )
      );
    } finally {
      server.close();
    }
  });
});
