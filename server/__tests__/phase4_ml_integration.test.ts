import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import express from "express";
import http from "node:http";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { sharedBaselineTracker } from "../baselineTracker.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { requireAdminFirebaseUser } from "../firebaseAuth.ts";
import {
  analyzeTelemetry,
  evaluateMlModelRemote,
  fetchMlConfigRemote,
  fetchMlModelStatusRemote,
  fitPatientBaselineRemote,
  resetPatientMlRemote,
  resolveMlGraphFilePath,
  updateMlConfigRemote,
} from "../mlClient.ts";
import type { MovementStatus, TelemetryPayload } from "../types.ts";

function buildPayload(overrides: Partial<TelemetryPayload> = {}): TelemetryPayload {
  return {
    patientId: overrides.patientId ?? "phase4_p1",
    deviceId: overrides.deviceId ?? "SIM-ESP32-P4",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    heartRate: overrides.heartRate === undefined ? 72 : overrides.heartRate,
    spo2: overrides.spo2 === undefined ? 98.4 : overrides.spo2,
    temperatureC: overrides.temperatureC === undefined ? 36.6 : overrides.temperatureC,
    movementStatus: overrides.movementStatus ?? "resting",
    accelMagnitude: overrides.accelMagnitude ?? 1.0,
    gyroMagnitude: overrides.gyroMagnitude ?? 2.0,
    possibleFallDetected: overrides.possibleFallDetected ?? false,
    irSignalOk: overrides.irSignalOk ?? true,
    fingerDetected: overrides.fingerDetected ?? true,
    source: overrides.source ?? "simulator",
    ...overrides,
  };
}

describe("Phase 4 — AI/ML Anomaly Detection, Baseline Statistics, Evaluation & Security", () => {
  const testPatients: string[] = [];

  after(async () => {
    for (const pid of testPatients) {
      await resetPatientMlRemote(pid);
      sharedBaselineTracker.resetPatient(pid);
      sharedWindowStore.clear(pid);
      sharedAlertDecisionEngine.clear(pid);
    }
  });

  it("1. Distinguishes insufficient baseline, missing temp, poor sensor contact, and normal vs unusual explanations", async () => {
    const pid = `p4_flow_${Date.now()}`;
    testPatients.push(pid);

    // Insufficient baseline (< 20 samples)
    const insuffRes = await analyzeTelemetry(
      buildPayload({
        patientId: pid,
        source: "simulator",
        heartRate: 73,
        spo2: 98.2,
        temperatureC: 36.6,
      })
    );
    assert.equal(insuffRes.anomalyStatus, "insufficient_baseline");
    assert.equal(insuffRes.isSimulated, true);
    assert.ok(Array.isArray(insuffRes.plainLanguageExplanations) && insuffRes.plainLanguageExplanations.length > 0);
    assert.equal(insuffRes.sensorValues?.heartRate, 73);

    // Fit 20 clean baseline samples on simulator
    const cleanBatch = Array.from({ length: 20 }, (_, i) => ({
      heartRate: 70 + (i % 5),
      spo2: 98.2 + (i % 2) * 0.2,
      temperatureC: 36.5 + (i % 2) * 0.1,
      accelMagnitude: 1.0 + (i % 2) * 0.02,
      gyroMagnitude: 2.0,
      movementStatus: "resting" as MovementStatus,
      signalQuality: "good" as const,
      timestamp: new Date(1_700_100_000_000 + i * 5000).toISOString(),
    }));
    const fitRes = await fitPatientBaselineRemote(pid, cleanBatch, {
      source: "simulator",
      minSamples: 20,
    });
    assert.equal(fitRes.baselineStatus, "ready");
    assert.ok(typeof fitRes.medians.heartRate === "number" && fitRes.medians.heartRate >= 70);
    assert.ok(typeof fitRes.stds.heartRate === "number" && fitRes.stds.heartRate >= 0);

    // Missing temperature should still process cleanly as Normal when HR/SpO2 match baseline
    const missingTempRes = await analyzeTelemetry(
      buildPayload({
        patientId: pid,
        source: "simulator",
        heartRate: 72,
        spo2: 98.3,
        temperatureC: null,
        timestamp: new Date(1_700_100_200_000).toISOString(),
      })
    );
    assert.equal(missingTempRes.anomalyStatus, "normal");
    assert.equal(missingTempRes.sensorValues?.temperatureC, null);

    // Poor contact / invalid sensor readings pause anomaly scoring
    const poorRes = await analyzeTelemetry(
      buildPayload({
        patientId: pid,
        source: "simulator",
        heartRate: null,
        spo2: null,
        temperatureC: null,
        fingerDetected: false,
        irSignalOk: false,
        timestamp: new Date(1_700_100_210_000).toISOString(),
      })
    );
    assert.equal(poorRes.signalQuality, "poor_contact");
    assert.equal(poorRes.anomalyStatus, "paused_poor_quality");
    assert.equal(poorRes.alertLevel, "Normal");

    // Unusual reading triggers plain-language explanation & is NOT added to clean baseline samples
    const beforeCount = sharedBaselineTracker.getSamples(pid, "simulator").length;
    const unusual1 = await analyzeTelemetry(
      buildPayload({
        patientId: pid,
        source: "simulator",
        heartRate: 132,
        spo2: 88.5,
        temperatureC: 38.8,
        timestamp: new Date(1_700_100_220_000).toISOString(),
      })
    );
    const unusual2 = await analyzeTelemetry(
      buildPayload({
        patientId: pid,
        source: "simulator",
        heartRate: 135,
        spo2: 88.0,
        temperatureC: 38.9,
        timestamp: new Date(1_700_100_230_000).toISOString(),
      })
    );
    const afterCount = sharedBaselineTracker.getSamples(pid, "simulator").length;
    assert.equal(unusual1.anomalyStatus, "anomalous");
    assert.notEqual(unusual2.alertLevel, "Normal");
    assert.equal(afterCount, beforeCount, "Anomalous readings must not pollute learned baseline");
    assert.ok(
      unusual2.plainLanguageExplanations?.some((line) => /baseline|differ|oxygen|heart/i.test(line))
    );
  });

  it("2. Enforces strict multi-patient and simulator-vs-hardware isolation", async () => {
    const pidA = `p4_iso_a_${Date.now()}`;
    const pidB = `p4_iso_b_${Date.now()}`;
    testPatients.push(pidA, pidB);

    await fitPatientBaselineRemote(
      pidA,
      Array.from({ length: 20 }, (_, i) => ({
        heartRate: 62 + (i % 2),
        spo2: 98.8,
        temperatureC: 36.4,
        accelMagnitude: 1.0,
        gyroMagnitude: 1.5,
        movementStatus: "resting" as MovementStatus,
        signalQuality: "good" as const,
        timestamp: new Date(1_700_200_000_000 + i * 5000).toISOString(),
      })),
      { source: "esp32_hardware", minSamples: 20 }
    );

    const statusA = await fetchMlModelStatusRemote(pidA, "esp32_hardware");
    const statusB = await fetchMlModelStatusRemote(pidB, "esp32_hardware");
    const statusASim = await fetchMlModelStatusRemote(pidA, "simulator");

    assert.equal(statusA.sample_count, 20);
    assert.equal(statusB.sample_count, 0, "Patient B must never inherit Patient A's baseline");
    assert.equal(statusASim.sample_count, 0, "Simulator baseline must remain isolated from ESP32 hardware");

    const hwCheck = await analyzeTelemetry(
      buildPayload({
        patientId: pidA,
        source: "esp32_hardware",
        heartRate: 63,
        spo2: 98.7,
        temperatureC: 36.4,
        timestamp: new Date(1_700_200_200_000).toISOString(),
      })
    );
    assert.equal(hwCheck.isSimulated, false);
    assert.equal(hwCheck.anomalyStatus, "normal");
  });

  it("3. Evaluates unlabeled data honestly (no fabricated supervised metrics) and labeled data accurately", async () => {
    const pid = `p4_eval_${Date.now()}`;
    testPatients.push(pid);

    const unlabeledRes = await evaluateMlModelRemote({
      patientId: pid,
      source: "simulator",
      readings: [
        { heartRate: 72, spo2: 98.4, temperatureC: 36.6, signalQuality: "good", anomalyStatus: "normal", anomalyScore: 0.08, alertLevel: "Normal" },
        { heartRate: 132, spo2: 88.2, temperatureC: 38.6, signalQuality: "good", anomalyStatus: "anomalous", anomalyScore: -0.22, alertLevel: "Critical" },
      ],
    });

    assert.equal(unlabeledRes.evaluation.labeled_data_available, false);
    assert.equal(unlabeledRes.evaluation.supervised_metrics, null);
    assert.ok(unlabeledRes.evaluation.metrics_requiring_labels.includes("Accuracy"));
    assert.equal(unlabeledRes.evaluation.unsupervised_metrics.anomalous_count, 1);

    const labeledRes = await evaluateMlModelRemote({
      patientId: pid,
      source: "simulator",
      readings: [
        { heartRate: 72, spo2: 98.4, temperatureC: 36.6, signalQuality: "good", anomalyStatus: "normal", anomalyScore: 0.09, alertLevel: "Normal", label: "normal" },
        { heartRate: 74, spo2: 98.2, temperatureC: 36.6, signalQuality: "good", anomalyStatus: "normal", anomalyScore: 0.07, alertLevel: "Normal", label: "normal" },
        { heartRate: 130, spo2: 88.0, temperatureC: 38.7, signalQuality: "good", anomalyStatus: "anomalous", anomalyScore: -0.24, alertLevel: "Critical", label: "anomalous" },
      ],
    });

    assert.equal(labeledRes.evaluation.labeled_data_available, true);
    assert.ok(labeledRes.evaluation.supervised_metrics !== null);
    assert.equal(labeledRes.evaluation.supervised_metrics.accuracy, 1);
    assert.equal(labeledRes.evaluation.supervised_metrics.f1_score, 1);
    assert.equal(labeledRes.evaluation.supervised_metrics.confusion_matrix.tp, 1);
    assert.equal(labeledRes.evaluation.supervised_metrics.confusion_matrix.tn, 2);
  });

  it("4. Validates ML config updates, graph path traversal rejection, and admin RBAC guard", async () => {
    const initialCfg = await fetchMlConfigRemote();
    assert.ok(initialCfg.config.contamination > 0);
    const updatedCfg = await updateMlConfigRemote({ contamination: 0.07 });
    assert.equal(updatedCfg.config.contamination, 0.07);
    await updateMlConfigRemote({ contamination: initialCfg.config.contamination });

    // Path traversal checks
    assert.equal(resolveMlGraphFilePath("../main.py"), null);
    assert.equal(resolveMlGraphFilePath("..%2Fmain.py"), null);
    assert.equal(resolveMlGraphFilePath("nonexistent_graph.png"), null);

    // RBAC admin guard rejects unauthenticated PUT requests
    const miniApp = express();
    miniApp.use(express.json());
    miniApp.put("/api/ml/config", requireAdminFirebaseUser, (_req, res) => {
      res.json({ ok: true });
    });
    const server = http.createServer(miniApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const addr = server.address() as { port: number };
      const resp = await fetch(`http://127.0.0.1:${addr.port}/api/ml/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contamination: 0.1 }),
      });
      assert.equal(resp.status, 401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
