import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { isAdminEmail, setTestTokenVerifier } from "../firebaseAuth.ts";
import { sharedNotificationEngine } from "../notificationEngine.ts";
import { createNotificationRouter } from "../notificationRoutes.ts";
import { clearServerAuditLogsForTests } from "../rbacRoutes.ts";
import {
  TemporalFallDetector,
  combineWebcamAndWearableSignals,
  generateSimulatedPoseSequence,
} from "../../src/utils/fallDetectionEngine.ts";
import type { VitalReading } from "../../src/types/smartcare.ts";

function makeVitalReading(overrides: Partial<VitalReading> = {}): VitalReading {
  return {
    readingId: "vital_test_1",
    patientId: "patient_fall_test",
    ownerUid: "uid_patient_fall",
    deviceId: "arova_esp32_test",
    source: "esp32_hardware",
    heartRate: 76,
    spo2: 98,
    temperatureC: 36.7,
    movementStatus: "resting",
    accelMagnitude: 1.0,
    gyroMagnitude: 4.0,
    possibleFallDetected: false,
    signalQuality: "good",
    anomalyScore: 0.1,
    alertLevel: "Normal",
    mlEngine: "python_isolation_forest",
    explanation: "Normal resting vitals",
    createdAt: new Date().toISOString(),
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

describe("Webcam-Based Fall Detection — Pose Logic, Sensor Fusion, Escalation & Privacy", () => {
  beforeEach(() => {
    sharedNotificationEngine.clearForTests();
    sharedAlertDecisionEngine.clear();
    clearServerAuditLogsForTests();

    setTestTokenVerifier(async (token) => {
      if (token === "patient_tok") {
        return {
          uid: "uid_patient_fall",
          email: "patient.fall@example.com",
          emailVerified: true,
          displayName: "Patient Fall",
          isAdmin: false,
        };
      }
      if (token === "caregiver_active_tok") {
        return {
          uid: "uid_cg_fall_active",
          email: "cg.fall@example.com",
          emailVerified: true,
          displayName: "Active Caregiver",
          isAdmin: false,
        };
      }
      if (token === "caregiver_unlinked_tok") {
        return {
          uid: "uid_cg_fall_unlinked",
          email: "cg.unlinked@example.com",
          emailVerified: true,
          displayName: "Unlinked User",
          isAdmin: false,
        };
      }
      if (token === "admin_tok") {
        return {
          uid: "uid_admin_fall",
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
    clearServerAuditLogsForTests();
  });

  it("1. Standing normal classifies as Normal without false warnings or falls", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("standing");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.equal(results[results.length - 1].activity, "standing");
    assert.equal(results[results.length - 1].poseQualityOk, true);
  });

  it("1b. Walking normally classifies as Normal (walking) without false warnings or falls", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("walking");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.equal(results[results.length - 1].activity, "walking");
    assert.equal(results[results.length - 1].poseQualityOk, true);
  });

  it("2. Sitting down slowly classifies as Normal (sitting) with no fall trigger", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("sitting");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.equal(results[results.length - 1].activity, "sitting");
  });

  it("3. Controlled bending down classifies as Normal and never triggers Possible Fall", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("bending");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.ok(results.some((r) => r.activity === "bending"));
  });

  it("4. Intentional slow lying down classifies as Normal (intentional_lying)", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("intentional_lying");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.equal(results[results.length - 1].activity, "intentional_lying");
  });

  it("5. Sudden fall (rapid downward drop + sustained horizontal posture) triggers Possible Fall", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("sudden_fall");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    const final = results[results.length - 1];
    assert.equal(final.state, "Possible Fall");
    assert.equal(final.activity, "sudden_fall");
    assert.ok(final.torsoAngleDeg >= 58);
    assert.ok(final.horizontalDurationSec >= 1.2);
    assert.ok(final.indicators.includes("upright_to_horizontal_transition"));
  });

  it("6. Subject leaving camera frame suppresses fall detection with clear positioning notice", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("out_of_frame");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Normal"));
    assert.ok(results.every((r) => r.activity === "out_of_frame"));
    assert.ok(results.every((r) => r.poseQualityOk === false));
    assert.ok(
      results[results.length - 1].reason.includes("Person not detected – Please check camera positioning")
    );
  });

  it("7. Poor lighting / low pose confidence reports uncertain Warning visibility state without false fall", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("low_confidence");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    assert.ok(results.every((r) => r.state === "Warning"));
    assert.ok(results.every((r) => r.activity === "low_confidence"));
    assert.ok(results.every((r) => r.poseQualityOk === false));
    assert.ok(
      results[0].reason.includes("Low visibility – Fall detection accuracy may be reduced")
    );
  });

  it("8. Multiple people in frame engages ambiguity safeguard (Warning) and prevents single-person Possible Fall escalation", () => {
    const detector = new TemporalFallDetector();
    const frames = generateSimulatedPoseSequence("multiple_people");
    const results = frames.map((f) => detector.evaluateFrame(f.poses, f.timestampMs));
    const final = results[results.length - 1];
    assert.equal(final.peopleCount, 2);
    assert.equal(final.activity, "multiple_people");
    assert.notEqual(final.state, "Possible Fall");
    assert.equal(final.state, "Warning");
  });

  it("9. Wearable sensor fusion corroborates aligned falls, downgrades disagreements to Warning, and handles offline wearables", () => {
    const detector = new TemporalFallDetector();
    const fallFrames = generateSimulatedPoseSequence("sudden_fall");
    let poseFallEval = detector.evaluateFrame(fallFrames[0].poses, fallFrames[0].timestampMs);
    for (const f of fallFrames) {
      poseFallEval = detector.evaluateFrame(f.poses, f.timestampMs);
    }
    assert.equal(poseFallEval.state, "Possible Fall");

    // 9a) Corroborated with fresh wearable IMU fall spike
    const corroborated = combineWebcamAndWearableSignals(
      poseFallEval,
      makeVitalReading({
        movementStatus: "fall_suspect",
        accelMagnitude: 2.65,
        gyroMagnitude: 68,
        possibleFallDetected: true,
        createdAt: new Date().toISOString(),
      })
    );
    assert.equal(corroborated.finalState, "Possible Fall");
    assert.equal(corroborated.sensorFusionStatus, "corroborated");
    assert.equal(corroborated.sensorDisagreement, false);

    // 9b) Disagreement: webcam sees fall while fresh wearable stays calm -> downgraded to Warning
    const disagreement = combineWebcamAndWearableSignals(
      poseFallEval,
      makeVitalReading({
        movementStatus: "resting",
        accelMagnitude: 1.01,
        gyroMagnitude: 3.2,
        possibleFallDetected: false,
        createdAt: new Date().toISOString(),
      })
    );
    assert.equal(disagreement.finalState, "Warning");
    assert.equal(disagreement.sensorFusionStatus, "sensor_disagreement");
    assert.equal(disagreement.sensorDisagreement, true);

    // 9c) Offline / stale wearable (> 45s) -> standalone webcam_only
    const offline = combineWebcamAndWearableSignals(poseFallEval, null);
    assert.equal(offline.finalState, "Possible Fall");
    assert.equal(offline.sensorFusionStatus, "webcam_only");

    const stale = combineWebcamAndWearableSignals(
      poseFallEval,
      makeVitalReading({
        movementStatus: "resting",
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    assert.equal(stale.finalState, "Possible Fall");
    assert.equal(stale.sensorFusionStatus, "webcam_only");
  });

  it("10. Camera error telemetry (denied, unavailable, disconnected) is recorded in admin stats", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const status of ["denied", "unavailable", "disconnected"] as const) {
        const res = await fetch(`${baseUrl}/api/fall-detection/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
          body: JSON.stringify({
            patientId: "patient_fall_cam_err",
            patientOwnerUid: "uid_patient_fall",
            cameraStatus: status,
            deviceLabel: "Built-in Webcam",
            errorMessage: `Camera reported ${status}`,
          }),
        });
        assert.equal(res.status, 200);
      }

      const statsRes = await fetch(`${baseUrl}/api/notifications/stats`, {
        headers: { Authorization: "Bearer admin_tok" },
      });
      assert.equal(statsRes.status, 200);
      const statsBody = (await statsRes.json()) as {
        stats: {
          fallDetectionStats: {
            cameraErrorsCount: number;
            latestCameraStatus: string;
            recentCameraErrors: Array<{ cameraStatus: string; patientId: string }>;
          };
        };
      };
      assert.equal(statsBody.stats.fallDetectionStats.cameraErrorsCount, 3);
      assert.equal(statsBody.stats.fallDetectionStats.latestCameraStatus, "disconnected");
      assert.ok(
        statsBody.stats.fallDetectionStats.recentCameraErrors.some((e) => e.cameraStatus === "denied")
      );
      assert.ok(
        statsBody.stats.fallDetectionStats.recentCameraErrors.some((e) => e.cameraStatus === "unavailable")
      );
    } finally {
      server.close();
    }
  });

  it("11. I'm Safe cancel endpoint cancels escalation countdown, marks cancelled_safe, and avoids caregiver notification", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_fall_safe_1",
        patientId: "patient_fall_safe",
        patientOwnerUid: "uid_patient_fall",
        caregiverUid: "uid_cg_fall_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15553334444",
        caregiverEmail: "cg.fall@example.com",
        explicitCallConsent: true,
        priority: "primary",
        status: "active",
      });

      const reportRes = await fetch(`${baseUrl}/api/fall-detection/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          patientId: "patient_fall_safe",
          patientName: "Patient Safe",
          patientOwnerUid: "uid_patient_fall",
          detectionMode: "webcam_pose",
          state: "Possible Fall",
          reason: "Rapid fall collapse detected.",
          confidence: 0.91,
          torsoAngleDeg: 78,
          verticalVelocity: 0.92,
          horizontalDurationSec: 1.6,
          peopleCount: 1,
          sensorFusionStatus: "corroborated",
          confirmationCountdownSec: 1,
        }),
      });
      assert.equal(reportRes.status, 201);
      const created = (await reportRes.json()) as {
        eventCreated: boolean;
        fallEvent: { eventId: string; alertId: string; status: string };
      };
      assert.equal(created.eventCreated, true);
      assert.equal(created.fallEvent.status, "pending_confirmation");

      // Immediately press "I'm Safe – Cancel Alert"
      const cancelRes = await fetch(
        `${baseUrl}/api/fall-detection/events/${created.fallEvent.eventId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
          body: JSON.stringify({
            actorRole: "patient",
            reason: "User pressed I'm Safe before escalation",
          }),
        }
      );
      assert.equal(cancelRes.status, 200);
      const cancelledBody = (await cancelRes.json()) as {
        fallEvent: { status: string; cancelledBy: string };
      };
      assert.equal(cancelledBody.fallEvent.status, "cancelled_safe");

      // Wait beyond the 1s countdown to confirm caregiver escalation does not fire
      await new Promise((r) => setTimeout(r, 1150));

      const cgFeedRes = await fetch(
        `${baseUrl}/api/notifications?patientId=patient_fall_safe&role=caregiver`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      assert.equal(cgFeedRes.status, 200);
      const cgFeed = (await cgFeedRes.json()) as {
        notifications: unknown[];
        alerts: Array<{ status: string; escalationStatus: string }>;
      };
      assert.equal(cgFeed.notifications.length, 0);
      assert.equal(cgFeed.alerts[0].status, "resolved");
      assert.equal(cgFeed.alerts[0].escalationStatus, "resolved");
    } finally {
      server.close();
    }
  });

  it("12. Caregiver receives fall escalation when unacknowledged, duplicate falls are suppressed, and RBAC blocks unauthorized callers", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_fall_esc_1",
        patientId: "patient_fall_esc",
        patientOwnerUid: "uid_patient_fall",
        caregiverUid: "uid_cg_fall_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15554445555",
        caregiverEmail: "cg.fall@example.com",
        explicitCallConsent: true,
        priority: "primary",
        status: "active",
      });

      const firstRes = await fetch(`${baseUrl}/api/fall-detection/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          patientId: "patient_fall_esc",
          patientName: "Patient Esc",
          patientOwnerUid: "uid_patient_fall",
          detectionMode: "webcam_pose",
          state: "Possible Fall",
          reason: "Possible fall sustained on floor.",
          confidence: 0.89,
          torsoAngleDeg: 81,
          verticalVelocity: 0.98,
          horizontalDurationSec: 1.9,
          peopleCount: 1,
          sensorFusionStatus: "webcam_only",
          confirmationCountdownSec: 1,
        }),
      });
      assert.equal(firstRes.status, 201);
      const firstBody = (await firstRes.json()) as {
        eventCreated: boolean;
        fallEvent: { eventId: string; alertId: string };
      };

      // Duplicate fall within suppression window should not spawn a second alert
      const dupRes = await fetch(`${baseUrl}/api/fall-detection/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          patientId: "patient_fall_esc",
          patientName: "Patient Esc",
          patientOwnerUid: "uid_patient_fall",
          detectionMode: "webcam_pose",
          state: "Possible Fall",
          reason: "Continued horizontal posture.",
          confidence: 0.88,
          torsoAngleDeg: 82,
          verticalVelocity: 0.1,
          horizontalDurationSec: 3.1,
          peopleCount: 1,
          sensorFusionStatus: "webcam_only",
          confirmationCountdownSec: 1,
        }),
      });
      assert.equal(dupRes.status, 200);
      const dupBody = (await dupRes.json()) as {
        eventCreated: boolean;
        duplicateSuppressed: boolean;
        fallEvent: { eventId: string; suppressedDuplicates: number };
      };
      assert.equal(dupBody.eventCreated, false);
      assert.equal(dupBody.duplicateSuppressed, true);
      assert.equal(dupBody.fallEvent.eventId, firstBody.fallEvent.eventId);
      assert.equal(dupBody.fallEvent.suppressedDuplicates, 1);

      // Wait for 1s countdown to expire and trigger caregiver escalation
      await new Promise((r) => setTimeout(r, 1150));

      // Unlinked caregiver cannot cancel or view non-sample fall event
      const unauthCancel = await fetch(
        `${baseUrl}/api/fall-detection/events/${firstBody.fallEvent.eventId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer caregiver_unlinked_tok" },
          body: JSON.stringify({ actorRole: "caregiver" }),
        }
      );
      assert.equal(unauthCancel.status, 403);

      const unauthNoTok = await fetch(
        `${baseUrl}/api/fall-detection/events/${firstBody.fallEvent.eventId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorRole: "patient" }),
        }
      );
      assert.equal(unauthNoTok.status, 401);

      // Authorized active caregiver sees escalated fall event and notifications
      const eventsRes = await fetch(
        `${baseUrl}/api/fall-detection/events?patientId=patient_fall_esc`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      assert.equal(eventsRes.status, 200);
      const eventsBody = (await eventsRes.json()) as {
        events: Array<{ eventId: string; status: string }>;
      };
      assert.equal(eventsBody.events.length, 1);
      assert.equal(eventsBody.events[0].status, "escalated");

      const cgNotifRes = await fetch(
        `${baseUrl}/api/notifications?patientId=patient_fall_esc&role=caregiver`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      const cgNotifBody = (await cgNotifRes.json()) as {
        notifications: Array<{ title: string; message: string }>;
      };
      assert.equal(cgNotifBody.notifications.length, 1);
      assert.equal(cgNotifBody.notifications[0].title, "AROVA – Possible Fall Alert");
      assert.ok(
        cgNotifBody.notifications[0].message.includes(
          "A possible fall has been detected for Patient Esc."
        )
      );
      assert.ok(cgNotifBody.notifications[0].message.includes("UNACKNOWLEDGED"));
    } finally {
      server.close();
    }
  });

  it("13. Location fallback preserves null and sends 'Location unavailable' when omitted, and stores valid coordinates when shared", async () => {
    const dispatchedMessages: string[] = [];
    sharedNotificationEngine.setDispatchHooksForTests({
      sms: async (input) => {
        dispatchedMessages.push(input.message);
        return {
          channel: "sms",
          provider: "Test Hook SMS",
          deliveryStatus: "simulated",
          isSimulated: true,
          detail: input.message,
        };
      },
    });

    sharedNotificationEngine.upsertCareLink({
      linkId: "link_loc_1",
      patientId: "patient_fall_loc_none",
      patientOwnerUid: "uid_patient_fall",
      caregiverUid: "uid_cg_fall_active",
      caregiverName: "Active Caregiver",
      caregiverPhone: "+15556667777",
      status: "active",
      priority: "primary",
    });
    sharedNotificationEngine.upsertCareLink({
      linkId: "link_loc_2",
      patientId: "patient_fall_loc_valid",
      patientOwnerUid: "uid_patient_fall",
      caregiverUid: "uid_cg_fall_active",
      caregiverName: "Active Caregiver",
      caregiverPhone: "+15556667777",
      status: "active",
      priority: "primary",
    });

    const noLocResult = await sharedNotificationEngine.reportFallDetectionEvent({
      patientId: "patient_fall_loc_none",
      patientOwnerUid: "uid_patient_fall",
      detectionMode: "webcam_pose",
      state: "Possible Fall",
      reason: "Possible fall without GPS opt-in.",
      confidence: 0.9,
      torsoAngleDeg: 80,
      verticalVelocity: 0.85,
      horizontalDurationSec: 1.5,
      peopleCount: 1,
      sensorFusionStatus: "webcam_only",
      location: null,
      confirmationCountdownSec: 15,
    });
    assert.equal(noLocResult.fallEvent.location, null);
    assert(noLocResult.alert);
    assert.equal(noLocResult.alert.location, null);

    await sharedNotificationEngine.escalateAlertToCaregivers(noLocResult.alert.alertId, {
      trigger: "manual",
    });
    assert.ok(dispatchedMessages.some((m) => m.includes("Location unavailable.")));

    const withLocResult = await sharedNotificationEngine.reportFallDetectionEvent({
      patientId: "patient_fall_loc_valid",
      patientOwnerUid: "uid_patient_fall",
      detectionMode: "demo_simulation",
      state: "Possible Fall",
      reason: "Possible fall with opt-in coordinates.",
      confidence: 0.93,
      torsoAngleDeg: 82,
      verticalVelocity: 0.95,
      horizontalDurationSec: 1.7,
      peopleCount: 1,
      sensorFusionStatus: "corroborated",
      location: {
        latitude: 37.4220656,
        longitude: -122.0840897,
        accuracyMeters: 12,
        capturedAt: new Date().toISOString(),
      },
      confirmationCountdownSec: 15,
    });
    assert(withLocResult.fallEvent.location);
    assert.equal(withLocResult.fallEvent.location.latitude, 37.422066);
    assert.equal(withLocResult.fallEvent.location.longitude, -122.08409);

    assert(withLocResult.alert);
    await sharedNotificationEngine.escalateAlertToCaregivers(withLocResult.alert.alertId, {
      trigger: "manual",
    });
    assert.ok(dispatchedMessages.some((m) => m.includes("37.42207, -122.08409")));
  });

  it("14. Default countdown is 20s, SEND HELP / NOT SAFE escalates immediately with Caregiver notification initiated, and Caregiver can acknowledge & resolve with notes", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      sharedNotificationEngine.upsertCareLink({
        linkId: "link_fall_help_1",
        patientId: "patient_fall_help",
        patientOwnerUid: "uid_patient_fall",
        caregiverUid: "uid_cg_fall_active",
        caregiverName: "Active Caregiver",
        caregiverPhone: "+15557778888",
        caregiverEmail: "cg.help@example.com",
        explicitCallConsent: true,
        priority: "primary",
        status: "active",
      });

      const reportRes = await fetch(`${baseUrl}/api/fall-detection/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
        body: JSON.stringify({
          patientId: "patient_fall_help",
          patientName: "Aarav Sharma",
          patientOwnerUid: "uid_patient_fall",
          detectionMode: "webcam_pose",
          state: "Possible Fall",
          reason: "Rapid collapse detected.",
          confidence: 0.94,
          torsoAngleDeg: 82,
          verticalVelocity: 1.04,
          horizontalDurationSec: 1.5,
          peopleCount: 1,
          sensorFusionStatus: "webcam_only",
        }),
      });
      assert.equal(reportRes.status, 201);
      const created = (await reportRes.json()) as {
        fallEvent: { eventId: string; alertId: string; confirmationCountdownSec: number };
      };
      assert.equal(created.fallEvent.confirmationCountdownSec, 20);

      // Press SEND HELP / NOT SAFE immediately
      const helpRes = await fetch(
        `${baseUrl}/api/fall-detection/events/${created.fallEvent.eventId}/request-help`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer patient_tok" },
          body: JSON.stringify({ actorRole: "patient" }),
        }
      );
      assert.equal(helpRes.status, 200);
      const helpBody = (await helpRes.json()) as {
        fallEvent: {
          status: string;
          escalationTrigger: string;
          patientAckStatus: string;
          caregiverNotificationInitiated: boolean;
          notificationAttempts: Array<{ channel: string; deliveryStatus: string }>;
        };
      };
      assert.equal(helpBody.fallEvent.status, "escalated");
      assert.equal(helpBody.fallEvent.escalationTrigger, "user_help_requested");
      assert.equal(helpBody.fallEvent.patientAckStatus, "assistance_requested");
      assert.equal(helpBody.fallEvent.caregiverNotificationInitiated, true);
      assert.ok(helpBody.fallEvent.notificationAttempts.length >= 1);

      // Caregiver receives exact AROVA notification
      const cgNotifRes = await fetch(
        `${baseUrl}/api/notifications?patientId=patient_fall_help&role=caregiver`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      const cgNotifBody = (await cgNotifRes.json()) as {
        notifications: Array<{ title: string; message: string }>;
      };
      assert.equal(cgNotifBody.notifications.length, 1);
      assert.equal(cgNotifBody.notifications[0].title, "AROVA – Possible Fall Alert");
      assert.ok(
        cgNotifBody.notifications[0].message.includes(
          "A possible fall has been detected for Aarav Sharma."
        )
      );
      assert.ok(cgNotifBody.notifications[0].message.includes("SEND HELP / NOT SAFE"));

      // Caregiver acknowledges and marks resolved with follow-up notes
      const ackRes = await fetch(
        `${baseUrl}/api/alerts/${created.fallEvent.alertId}/acknowledge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer caregiver_active_tok" },
          body: JSON.stringify({
            actorRole: "caregiver",
            followUpAction: "Called patient and confirmed on the way.",
          }),
        }
      );
      assert.equal(ackRes.status, 200);

      const resolveRes = await fetch(
        `${baseUrl}/api/alerts/${created.fallEvent.alertId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer caregiver_active_tok" },
          body: JSON.stringify({
            actorRole: "caregiver",
            followUpAction: "Assisted patient safely; monitoring resumed.",
          }),
        }
      );
      assert.equal(resolveRes.status, 200);

      const finalEventsRes = await fetch(
        `${baseUrl}/api/fall-detection/events?patientId=patient_fall_help`,
        { headers: { Authorization: "Bearer caregiver_active_tok" } }
      );
      const finalEvents = (await finalEventsRes.json()) as {
        events: Array<{ status: string; followUpNotes?: string }>;
      };
      assert.equal(finalEvents.events[0].status, "resolved");
      assert.equal(
        finalEvents.events[0].followUpNotes,
        "Assisted patient safely; monitoring resumed."
      );
    } finally {
      server.close();
    }
  });
});
