import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, it } from "node:test";
import express from "express";
import {
  requireAdminFirebaseUser,
  requireVerifiedFirebaseUser,
  setTestTokenVerifier,
} from "../firebaseAuth.ts";
import {
  buildArovaVoiceSystemInstruction,
  buildBrowserVoiceSessionContext,
  CAREGIVER_RESPONSE_CATEGORIES,
  classifyCaregiverTextDeterministic,
} from "../geminiLiveBridge.ts";
import {
  mapTwilioStatusToFrontend,
  maskPhoneNumber,
  validateE164PhoneNumber,
  verifyTwilioSignature,
  type OutboundCallRecord,
  type VoiceCallContext,
} from "../outboundVoice.ts";
import {
  mapAnalysisToEmergencySeverity,
  VoiceEscalationEngine,
} from "../voiceEscalationEngine.ts";
import type { MlAnalysisResult, TelemetryPayload } from "../types.ts";

function makeTelemetry(overrides: Partial<TelemetryPayload> = {}): TelemetryPayload {
  return {
    patientId: overrides.patientId ?? "patient_voice_test",
    deviceId: overrides.deviceId ?? "ESP32-VOICE-01",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    heartRate: overrides.heartRate === undefined ? 128 : overrides.heartRate,
    spo2: overrides.spo2 === undefined ? 97 : overrides.spo2,
    temperatureC: overrides.temperatureC === undefined ? 36.8 : overrides.temperatureC,
    movementStatus: overrides.movementStatus ?? "resting",
    accelMagnitude: overrides.accelMagnitude ?? 1.0,
    gyroMagnitude: overrides.gyroMagnitude ?? 2.0,
    possibleFallDetected: overrides.possibleFallDetected ?? false,
    irSignalOk: true,
    fingerDetected: true,
    source: "esp32_hardware",
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<MlAnalysisResult> = {}): MlAnalysisResult {
  return {
    mlServiceConnected: true,
    mlEngine: "python_isolation_forest",
    modelTrained: true,
    modelVersion: "v1-test",
    ecgModelTrained: false,
    signalQuality: "good",
    anomalyStatus: overrides.anomalyStatus ?? "anomalous",
    anomalyScore: overrides.anomalyScore ?? -0.18,
    alertLevel: overrides.alertLevel ?? "Critical",
    triggeredMetrics: overrides.triggeredMetrics ?? ["heart_rate_elevated"],
    contributingFeatures: overrides.contributingFeatures ?? ["heart_rate"],
    contributingDetails: [],
    persistenceCount: 3,
    persistenceRequired: 3,
    matchedBaselineContext: "resting",
    windowSize: 5,
    baselineProgress: {
      collectedSamples: 25,
      requiredSamples: 20,
      status: "ready",
      source: "esp32_hardware",
      modelVersion: "v1-test",
      restingSamples: 20,
      activeSamples: 5,
      ecgBaselineSamples: 0,
    },
    explanation: overrides.explanation ?? "Sustained elevated heart rate above personalized baseline.",
    ...overrides,
  };
}

function createMockLauncher() {
  const launched: Array<{ toE164: string; context?: VoiceCallContext; record: OutboundCallRecord }> = [];
  const launcher = async (params: {
    toE164: string;
    context?: VoiceCallContext;
  }): Promise<OutboundCallRecord> => {
    const nowIso = new Date().toISOString();
    const record: OutboundCallRecord = {
      callId: `call_mock_${crypto.randomUUID().slice(0, 8)}`,
      callSid: `CA${crypto.randomBytes(16).toString("hex")}`,
      maskedPhone: maskPhoneNumber(params.toE164),
      status: "initiating",
      arovaStatus: "Initiated",
      twilioStatus: "queued",
      durationSec: 0,
      errorMessage: null,
      startedAt: nowIso,
      connectedAt: null,
      endedAt: null,
      updatedAt: nowIso,
      context: params.context,
    };
    launched.push({ toE164: params.toE164, context: params.context, record });
    return record;
  };
  return { launcher, launched };
}

describe("Arova AI — Intelligent Health Monitoring Voice Assistant", () => {
  afterEach(() => {
    setTestTokenVerifier(null);
  });

  it("1. Validates E.164 phone numbers and masks raw phone numbers across contact & call history reads", async () => {
    assert.equal(validateE164PhoneNumber("+91 98765-43210").normalized, "+919876543210");
    assert.equal(validateE164PhoneNumber("9876543210").valid, false);
    assert.equal(validateE164PhoneNumber("+0123456789").valid, false);

    const { launcher } = createMockLauncher();
    const engine = new VoiceEscalationEngine({ callLauncher: launcher });

    const contact = engine.upsertCaregiverContact(
      {
        patientId: "pt_mask_1",
        patientOwnerUid: "owner_1",
        caregiverName: "Ananya",
        e164Phone: "+919876543210",
        priority: "primary",
        preferredLanguage: "en",
        explicitCallConsent: true,
        authorizedForPatientIdentity: true,
        authorizedForHealthReadings: true,
      },
      "admin_uid"
    );

    assert.equal("e164Phone" in contact, false);
    assert.equal(contact.maskedPhone, "+919••••3210");

    const listed = engine.listCaregiverContacts({ callerUid: "owner_1", isAdmin: false });
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes("9876543210"), false);

    const callEntry = await engine.triggerAdminTestCall({
      contactId: contact.contactId,
      patientName: "Patient A",
      actorUid: "admin_uid",
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert.equal(callEntry.maskedPhone, "+919••••3210");
    assert.equal(JSON.stringify(engine.listCallHistory({ isAdmin: true })).includes("9876543210"), false);
  });

  it("2. Enforces explicit caregiver call consent before placing test or automated escalation calls", async () => {
    const { launcher, launched } = createMockLauncher();
    const engine = new VoiceEscalationEngine({ callLauncher: launcher });

    const unconsented = engine.upsertCaregiverContact(
      {
        patientId: "pt_consent_1",
        patientOwnerUid: "owner_1",
        caregiverName: "Unconsented Contact",
        e164Phone: "+14155550101",
        priority: "primary",
        preferredLanguage: "en",
        explicitCallConsent: false,
      },
      "admin_uid"
    );

    await assert.rejects(
      () =>
        engine.triggerAdminTestCall({
          contactId: unconsented.contactId,
          actorUid: "admin_uid",
        }),
      /consent/i
    );

    const evalRes = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_consent_1" }),
      analysis: makeAnalysis({ alertLevel: "Critical" }),
      patientName: "Patient Consent",
      patientOwnerUid: "owner_1",
    });

    assert.equal(launched.length, 0);
    assert.equal(evalRes.escalation?.escalationStatus, "human_follow_up_required");
    assert.equal(evalRes.escalation?.humanFollowUpRequired, true);
  });

  it("3. Enforces RBAC authentication (401 unauthenticated, 403 non-admin/unverified, 200 admin)", async () => {
    setTestTokenVerifier(async (token) => {
      if (token === "unverified_tok") {
        return {
          uid: "u_unverified",
          email: "user@example.com",
          emailVerified: false,
          displayName: "Unverified",
          isAdmin: false,
        };
      }
      if (token === "user_tok") {
        return {
          uid: "u_standard",
          email: "caregiver@example.com",
          emailVerified: true,
          displayName: "Caregiver",
          isAdmin: false,
        };
      }
      if (token === "admin_tok") {
        return {
          uid: "u_admin",
          email: "aasiyahadiya7575@gmail.com",
          emailVerified: true,
          displayName: "Admin",
          isAdmin: true,
        };
      }
      return null;
    });

    const app = express();
    app.use(express.json());
    app.get("/api/test/verified", requireVerifiedFirebaseUser, (_req, res) => {
      res.json({ ok: true });
    });
    app.post("/api/test/admin", requireAdminFirebaseUser, (_req, res) => {
      res.json({ ok: true });
    });

    const server = app.listen(0);
    const addr = server.address();
    assert(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const noAuth = await fetch(`${base}/api/test/verified`);
      assert.equal(noAuth.status, 401);

      const unverified = await fetch(`${base}/api/test/verified`, {
        headers: { Authorization: "Bearer unverified_tok" },
      });
      assert.equal(unverified.status, 403);

      const nonAdmin = await fetch(`${base}/api/test/admin`, {
        method: "POST",
        headers: { Authorization: "Bearer user_tok" },
      });
      assert.equal(nonAdmin.status, 403);

      const adminRes = await fetch(`${base}/api/test/admin`, {
        method: "POST",
        headers: { Authorization: "Bearer admin_tok" },
      });
      assert.equal(adminRes.status, 200);
    } finally {
      server.close();
    }
  });

  it("4. Phase 2 Multilingual Prompt & PHI Authorization gating omits unauthorized patient name & readings", () => {
    const unauthorizedPrompt = buildArovaVoiceSystemInstruction({
      callType: "emergency_escalation",
      patientId: "pt_phi",
      patientName: "Secret Patient Name",
      alertSeverity: "High",
      parameter: "Heart Rate",
      readingValue: "142",
      readingUnit: "BPM",
      preferredLanguage: "kn",
      authorizedForPatientIdentity: false,
      authorizedForHealthReadings: false,
      explicitCallConsent: true,
      retryCount: 0,
    });

    assert.equal(unauthorizedPrompt.includes("Secret Patient Name"), false);
    assert.equal(unauthorizedPrompt.includes("142"), false);
    assert.match(unauthorizedPrompt, /NOT authorized to hear the patient's personal name/i);
    assert.match(unauthorizedPrompt, /NOT authorized to receive specific vital numbers/i);
    assert.match(unauthorizedPrompt, /Kannada/i);

    const authorizedPrompt = buildArovaVoiceSystemInstruction({
      callType: "emergency_escalation",
      patientId: "pt_phi",
      patientName: "Lakshmi Rao",
      alertSeverity: "High",
      parameter: "Heart Rate",
      readingValue: "142",
      readingUnit: "BPM",
      preferredLanguage: "en",
      authorizedForPatientIdentity: true,
      authorizedForHealthReadings: true,
      explicitCallConsent: true,
      retryCount: 0,
    });

    assert.match(authorizedPrompt, /Hello, this is Arova AI Health Monitoring Assistant/);
    assert.match(authorizedPrompt, /We detected an unusual reading for Lakshmi Rao\. The recorded Heart Rate is 142 BPM/);
    assert.match(authorizedPrompt, /contact local emergency services immediately/i);
  });

  it("5. Phase 2 Multilingual Response Classifier supports all 8 categories across English, Kannada, and Hindi", () => {
    const cases: Array<{ text: string; expectedCat: string; expectedLang: string }> = [
      { text: "Yes I will check right away", expectedCat: "Will check immediately", expectedLang: "en" },
      { text: "I am already checking on him now", expectedCat: "Already checking on the patient", expectedLang: "en" },
      { text: "She is fine and patient is safe now", expectedCat: "Patient is safe", expectedLang: "en" },
      { text: "Sorry I am unable to assist", expectedCat: "Unable to assist", expectedLang: "en" },
      { text: "I am not available I am out of town", expectedCat: "Not available", expectedLang: "en" },
      { text: "Please call someone else or another contact", expectedCat: "Requests another contact", expectedLang: "en" },
      { text: "Call an ambulance we need emergency help", expectedCat: "Needs emergency assistance", expectedLang: "en" },
      { text: "ಹೌದು ನಾನು ಈಗ ನೋಡುತ್ತೇನೆ", expectedCat: "Will check immediately", expectedLang: "kn" },
      { text: "नहीं मैं देख नहीं सकता अभी उपलब्ध नहीं हूँ", expectedCat: "Not available", expectedLang: "hi" },
      { text: "hmm maybe later", expectedCat: "Unclear response", expectedLang: "en" },
    ];

    assert.equal(CAREGIVER_RESPONSE_CATEGORIES.length, 8);
    for (const c of cases) {
      const res = classifyCaregiverTextDeterministic(c.text, "en");
      assert.equal(res.caregiverResponse, c.expectedCat);
      assert.equal(res.selectedLanguage, c.expectedLang);
    }
  });

  it("6. Phase 3 Severity Engine maps Low/Medium/High accurately and prevents duplicate High calls", async () => {
    assert.equal(mapAnalysisToEmergencySeverity(makeAnalysis({ alertLevel: "Normal", anomalyStatus: "normal" })), null);
    assert.equal(mapAnalysisToEmergencySeverity(makeAnalysis({ alertLevel: "Normal", anomalyStatus: "anomalous" })), "Low");
    assert.equal(mapAnalysisToEmergencySeverity(makeAnalysis({ alertLevel: "Warning" })), "Medium");
    assert.equal(mapAnalysisToEmergencySeverity(makeAnalysis({ alertLevel: "Critical" })), "High");

    const { launcher, launched } = createMockLauncher();
    const engine = new VoiceEscalationEngine({ callLauncher: launcher });

    engine.upsertCaregiverContact(
      {
        patientId: "pt_sev",
        patientOwnerUid: "owner_sev",
        caregiverName: "Primary One",
        e164Phone: "+919876543211",
        priority: "primary",
        preferredLanguage: "en",
        explicitCallConsent: true,
      },
      "admin_uid"
    );

    const lowRes = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_sev" }),
      analysis: makeAnalysis({ alertLevel: "Normal", anomalyStatus: "anomalous" }),
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert.equal(lowRes.severity, "Low");
    assert.equal(launched.length, 0);

    const medRes = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_sev" }),
      analysis: makeAnalysis({ alertLevel: "Warning", anomalyStatus: "anomalous" }),
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert.equal(medRes.severity, "Medium");
    assert.equal(launched.length, 0);

    const high1 = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_sev", heartRate: 145 }),
      analysis: makeAnalysis({ alertLevel: "Critical", anomalyStatus: "anomalous" }),
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert.equal(high1.severity, "High");
    assert.equal(high1.duplicateSuppressed, false);
    assert.equal(launched.length, 1);

    const high2 = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_sev", heartRate: 148 }),
      analysis: makeAnalysis({ alertLevel: "Critical", anomalyStatus: "anomalous" }),
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert.equal(high2.duplicateSuppressed, true);
    assert.equal(launched.length, 1);
  });

  it("7 & 8. Escalates Primary -> Secondary -> Alternate -> fallback human_follow_up_required, and never auto-resolves emergency on call answer", async () => {
    const { launcher, launched } = createMockLauncher();
    const engine = new VoiceEscalationEngine({ callLauncher: launcher });
    engine.updateRetryPolicy({ retryIntervalSec: 15, maxCallAttempts: 2, fallbackNotificationEnabled: true }, "admin");

    engine.upsertCaregiverContact(
      {
        patientId: "pt_esc",
        patientOwnerUid: "owner_esc",
        caregiverName: "Primary CG",
        e164Phone: "+919876500001",
        priority: "primary",
        preferredLanguage: "en",
        explicitCallConsent: true,
      },
      "admin"
    );
    engine.upsertCaregiverContact(
      {
        patientId: "pt_esc",
        patientOwnerUid: "owner_esc",
        caregiverName: "Secondary CG",
        e164Phone: "+919876500002",
        priority: "secondary",
        preferredLanguage: "kn",
        explicitCallConsent: true,
      },
      "admin"
    );
    engine.upsertCaregiverContact(
      {
        patientId: "pt_esc",
        patientOwnerUid: "owner_esc",
        caregiverName: "Alternate CG",
        e164Phone: "+919876500003",
        priority: "alternate",
        preferredLanguage: "hi",
        explicitCallConsent: true,
      },
      "admin"
    );

    const { escalation } = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_esc" }),
      analysis: makeAnalysis({ alertLevel: "Critical" }),
      patientOwnerUid: "owner_esc",
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert(escalation);
    assert.equal(launched.length, 1);
    assert.equal(escalation.currentCaregiverName, "Primary CG");

    // Attempt 1 unanswered -> immediate retry to Primary CG
    await engine.advanceRetryOrEscalate(escalation, "unanswered", { immediateRetryForTests: true });
    assert.equal(launched.length, 2);
    assert.equal(escalation.currentCaregiverName, "Primary CG");
    assert.equal(escalation.escalationStatus, "retrying");

    // Attempt 2 unanswered -> escalate to Secondary CG
    await engine.advanceRetryOrEscalate(escalation, "busy", { immediateRetryForTests: true });
    assert.equal(launched.length, 3);
    assert.equal(escalation.currentCaregiverName, "Secondary CG");
    assert.equal(escalation.escalationStatus, "escalated_secondary");

    // Secondary CG answers & says Unable to assist -> escalate immediately to Alternate CG
    const secondaryCallId = launched[2].record.callId;
    await engine.handleCaregiverResponseUpdate(
      secondaryCallId,
      {
        caregiverResponse: "Unable to assist",
        selectedLanguage: "kn",
        followUpAction: "Caregiver unable to assist; escalating.",
        responseSummary: "Declined",
      },
      true
    );
    assert.equal(launched.length, 4);
    assert.equal(escalation.currentCaregiverName, "Alternate CG");

    // Alternate exhausts attempts -> fallback & human_follow_up_required
    await engine.advanceRetryOrEscalate(escalation, "unanswered", { immediateRetryForTests: true });
    assert.equal(launched.length, 5);
    await engine.advanceRetryOrEscalate(escalation, "no-answer", { immediateRetryForTests: true });
    assert.equal(escalation.escalationStatus, "human_follow_up_required");
    assert.equal(escalation.fallbackTriggered, true);
    assert.equal(escalation.humanFollowUpRequired, true);
    assert.equal(escalation.emergencyActive, true);

    // Safety Invariant check on second patient: Answering + "Will check immediately" NEVER resolves emergency
    engine.upsertCaregiverContact(
      {
        patientId: "pt_inv",
        patientOwnerUid: "owner_inv",
        caregiverName: "Prompt CG",
        e164Phone: "+919876500009",
        priority: "primary",
        preferredLanguage: "en",
        explicitCallConsent: true,
      },
      "admin"
    );
    const invRes = await engine.evaluateAnalysisEvent({
      telemetry: makeTelemetry({ patientId: "pt_inv" }),
      analysis: makeAnalysis({ alertLevel: "Critical" }),
      patientOwnerUid: "owner_inv",
      publicBaseUrlOverride: "https://example.run.app",
    });
    assert(invRes.escalation);
    const invCallId = invRes.escalation.callIds[0];
    await engine.handleCaregiverResponseUpdate(
      invCallId,
      {
        caregiverResponse: "Will check immediately",
        selectedLanguage: "en",
        followUpAction: "Checking right away.",
        responseSummary: "Will check immediately",
      },
      true
    );
    assert.equal(invRes.escalation.escalationStatus, "acknowledged");
    assert.equal(invRes.escalation.emergencyActive, true);

    const resolved = engine.resolveEscalationByHuman({
      escalationId: invRes.escalation.escalationId,
      actorUid: "owner_inv",
      isAdmin: false,
      followUpNote: "Caregiver verified patient pulse and seated safely.",
    });
    assert.equal(resolved.escalationStatus, "resolved");
    assert.equal(resolved.emergencyActive, false);
  });

  it("9. Verifies Twilio HMAC-SHA1 webhook signatures and maps all 7 Arova call statuses", () => {
    const authToken = "super_secret_twilio_auth_token";
    const fullUrl = "https://example.run.app/api/voice/outbound/status?callId=123";
    const bodyParams = {
      CallSid: "CA1234567890abcdef1234567890abcdef",
      CallStatus: "completed",
      CallDuration: "42",
    };

    const sortedKeys = Object.keys(bodyParams).sort();
    let payload = fullUrl;
    for (const k of sortedKeys) {
      payload += k + bodyParams[k as keyof typeof bodyParams];
    }
    const validSig = crypto.createHmac("sha1", authToken).update(payload, "utf8").digest("base64");

    assert.equal(
      verifyTwilioSignature({ authToken, signatureHeader: validSig, fullUrl, bodyParams }),
      true
    );
    assert.equal(
      verifyTwilioSignature({ authToken, signatureHeader: "bad_sig==", fullUrl, bodyParams }),
      false
    );

    assert.equal(mapTwilioStatusToFrontend("queued", false).arovaStatus, "Initiated");
    assert.equal(mapTwilioStatusToFrontend("ringing", false).arovaStatus, "Ringing");
    assert.equal(mapTwilioStatusToFrontend("in-progress", false).arovaStatus, "Answered");
    assert.equal(mapTwilioStatusToFrontend("no-answer", false).arovaStatus, "Unanswered");
    assert.equal(mapTwilioStatusToFrontend("busy", false).arovaStatus, "Busy");
    assert.equal(mapTwilioStatusToFrontend("failed", false).arovaStatus, "Failed");
    assert.equal(mapTwilioStatusToFrontend("completed", true).arovaStatus, "Completed");
  });

  it("10. Builds browser voice session contexts safely with language sanitization, PHI flags, and clamping", () => {
    const defaultCtx = buildBrowserVoiceSessionContext(new URLSearchParams());
    assert(defaultCtx);
    assert.equal(defaultCtx.callType, "direct_outbound");
    assert.equal(defaultCtx.preferredLanguage, "en");
    assert.equal(defaultCtx.authorizedForPatientIdentity, false);
    assert.equal(defaultCtx.authorizedForHealthReadings, false);

    const invalidLangCtx = buildBrowserVoiceSessionContext(
      new URLSearchParams({ mode: "assistant", language: "fr" })
    );
    assert(invalidLangCtx);
    assert.equal(invalidLangCtx.callType, "direct_outbound");
    assert.equal(invalidLangCtx.preferredLanguage, "en");

    const restrictedAlertCtx = buildBrowserVoiceSessionContext(
      new URLSearchParams({
        mode: "caregiver_alert",
        language: "kn",
        patientName: "Confidential Patient",
        caregiverName: "Browser Admin",
        parameter: "SpO2",
        readingValue: "84",
        readingUnit: "%",
        authorizedForPatientIdentity: "false",
        authorizedForHealthReadings: "false",
      })
    );
    assert(restrictedAlertCtx);
    assert.equal(restrictedAlertCtx.callType, "test_call");
    assert.equal(restrictedAlertCtx.preferredLanguage, "kn");
    assert.equal(restrictedAlertCtx.authorizedForPatientIdentity, false);
    assert.equal(restrictedAlertCtx.authorizedForHealthReadings, false);

    const restrictedPrompt = buildArovaVoiceSystemInstruction(restrictedAlertCtx);
    assert.equal(restrictedPrompt.includes("Confidential Patient"), false);
    assert.equal(restrictedPrompt.includes("84"), false);
    assert.match(restrictedPrompt, /Kannada/i);

    const longName = "A".repeat(150);
    const authorizedAlertCtx = buildBrowserVoiceSessionContext(
      new URLSearchParams({
        mode: "caregiver_alert",
        language: "hi",
        patientName: longName,
        parameter: "Heart Rate",
        readingValue: "136",
        readingUnit: "BPM",
        authorizedForPatientIdentity: "true",
        authorizedForHealthReadings: "true",
      })
    );
    assert(authorizedAlertCtx);
    assert.equal(authorizedAlertCtx.preferredLanguage, "hi");
    assert.equal(authorizedAlertCtx.patientName?.length, 100);
    assert.equal(authorizedAlertCtx.authorizedForPatientIdentity, true);
    assert.equal(authorizedAlertCtx.authorizedForHealthReadings, true);

    const authorizedPrompt = buildArovaVoiceSystemInstruction(authorizedAlertCtx);
    assert.match(authorizedPrompt, /Heart Rate is 136 BPM/);
    assert.match(authorizedPrompt, /Hindi/i);
  });
});
