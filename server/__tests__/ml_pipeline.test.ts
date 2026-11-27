import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ServerAlertDecisionEngine, sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { BaselineTracker, sharedBaselineTracker, type BaselineSampleInput } from "../baselineTracker.ts";
import { extractWindowFeatures, SlidingWindowStore, sharedWindowStore } from "../featureExtractor.ts";
import { analyzeTelemetry, fitPatientBaselineRemote, validateSensorQuality } from "../mlClient.ts";
import type { MovementStatus, TelemetryPayload } from "../types.ts";

function makeSample(overrides: Partial<BaselineSampleInput> = {}): BaselineSampleInput {
  return {
    timestampMs: overrides.timestampMs ?? Date.now(),
    heartRate: overrides.heartRate ?? 72,
    spo2: overrides.spo2 ?? 98,
    temperatureC: overrides.temperatureC === undefined ? 36.6 : overrides.temperatureC,
    accelMagnitude: overrides.accelMagnitude ?? 1.0,
    gyroMagnitude: overrides.gyroMagnitude ?? 2.0,
    movementStatus: overrides.movementStatus ?? "resting",
    signalQuality: overrides.signalQuality ?? "good",
    ecgBpm: overrides.ecgBpm ?? null,
    ecgRriMs: overrides.ecgRriMs ?? null,
    ecgHrvMs: overrides.ecgHrvMs ?? null,
    ecgSignalQuality: overrides.ecgSignalQuality ?? "unavailable",
    ecgLeadOff: overrides.ecgLeadOff ?? false,
  };
}

function makeTelemetry(overrides: Partial<TelemetryPayload> = {}): TelemetryPayload {
  return {
    patientId: overrides.patientId ?? "test_patient_ml",
    deviceId: overrides.deviceId ?? "ESP32-TEST-01",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    heartRate: overrides.heartRate === undefined ? 72 : overrides.heartRate,
    spo2: overrides.spo2 === undefined ? 98 : overrides.spo2,
    temperatureC: overrides.temperatureC === undefined ? 36.6 : overrides.temperatureC,
    movementStatus: overrides.movementStatus ?? "resting",
    accelMagnitude: overrides.accelMagnitude ?? 1.0,
    gyroMagnitude: overrides.gyroMagnitude ?? 2.0,
    possibleFallDetected: overrides.possibleFallDetected ?? false,
    irSignalOk: overrides.irSignalOk ?? true,
    fingerDetected: overrides.fingerDetected ?? true,
    source: overrides.source ?? "esp32_hardware",
    ...overrides,
  };
}

describe("SmartCare AI — Personalized Baseline & Anomaly Detection Pipeline", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcare-ml-test-"));
  const tempPersistFile = path.join(tempDir, "baselines.json");
  const e2ePatientIds: string[] = [];

  after(() => {
    for (const pid of e2ePatientIds) {
      sharedBaselineTracker.resetPatient(pid);
      sharedWindowStore.clear(pid);
      sharedAlertDecisionEngine.clear(pid);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("1. BaselineTracker enforces source separation, quality filtering, and activity sub-baselines", () => {
    const tracker = new BaselineTracker(tempPersistFile);

    // Exclude sample_demo from personalized baseline learning
    const demoResult = tracker.recordCleanSample("p_src", "sample_demo", makeSample(), 10);
    assert.equal(demoResult.accepted, false);
    assert.throws(() => tracker.fitBaseline("p_src", "sample_demo", [makeSample()], 10));

    // Quality gate excludes poor_contact / noisy samples
    const poorResult = tracker.recordCleanSample(
      "p_src",
      "esp32_hardware",
      makeSample({ signalQuality: "poor_contact" }),
      10
    );
    assert.equal(poorResult.accepted, false);

    // Mixed resting + active + nullable temperature + good ECG samples on esp32_hardware
    const hwSamples: BaselineSampleInput[] = [];
    for (let i = 0; i < 8; i++) {
      hwSamples.push(
        makeSample({
          timestampMs: 1_700_000_000_000 + i * 5000,
          heartRate: 68 + (i % 3),
          spo2: 98.2,
          temperatureC: i % 2 === 0 ? 36.5 : null, // nullable temperature supported
          movementStatus: "resting",
          accelMagnitude: 1.0,
          ecgBpm: 69,
          ecgHrvMs: 42,
          ecgSignalQuality: "good",
          ecgLeadOff: false,
        })
      );
    }
    for (let i = 0; i < 6; i++) {
      hwSamples.push(
        makeSample({
          timestampMs: 1_700_000_050_000 + i * 5000,
          heartRate: 98 + (i % 3),
          spo2: 97.6,
          temperatureC: null,
          movementStatus: "walking",
          accelMagnitude: 1.38,
          ecgBpm: 99,
          ecgHrvMs: 30,
          ecgSignalQuality: "good",
          ecgLeadOff: false,
        })
      );
    }

    const hwProfile = tracker.fitBaseline("p_src", "esp32_hardware", hwSamples, 12);
    assert.equal(hwProfile.source, "esp32_hardware");
    assert.equal(hwProfile.sampleCount, 14);
    assert.ok(hwProfile.resting && hwProfile.resting.heartRateMean < 72);
    assert.ok(hwProfile.active && hwProfile.active.heartRateMean > 95);
    assert.ok(hwProfile.ecgBpmMean !== null && hwProfile.ecgBaselineSamples === 14);

    // Simulator baseline remains strictly isolated from esp32_hardware
    const simProgressBefore = tracker.getProgress("p_src", "simulator", 12);
    assert.equal(simProgressBefore.status, "not_started");
    assert.equal(simProgressBefore.collectedSamples, 0);
    assert.equal(tracker.getProfile("p_src", "simulator"), null);
  });

  it("2. SlidingWindowStore & feature extractor distinguish normal walking vs true deviation and compute temp slope", () => {
    const tracker = new BaselineTracker(path.join(tempDir, "window-baselines.json"));
    const samples: BaselineSampleInput[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeSample({
          timestampMs: 1_700_000_000_000 + i * 5000,
          heartRate: 70 + (i % 2),
          spo2: 98.5,
          temperatureC: 36.5,
          movementStatus: "resting",
          accelMagnitude: 1.0,
        })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeSample({
          timestampMs: 1_700_000_100_000 + i * 5000,
          heartRate: 100 + (i % 3),
          spo2: 97.8,
          temperatureC: 36.6,
          movementStatus: "walking",
          accelMagnitude: 1.35,
        })
      ),
    ];
    const profile = tracker.fitBaseline("p_win", "esp32_hardware", samples, 15);
    const store = new SlidingWindowStore(8, 15 * 60_000);

    // Walking at 101 BPM matches active sub-baseline -> low z-score
    const walkWindow = store.append("p_win", "esp32_hardware", {
      timestampMs: 1_700_000_200_000,
      heartRate: 101,
      spo2: 97.9,
      temperatureC: 36.6,
      accelMagnitude: 1.36,
      gyroMagnitude: 14,
      movementStatus: "walking",
      signalQuality: "good",
      ecgLeadOff: false,
    });
    const walkFeatures = extractWindowFeatures({ window: walkWindow, profile });
    assert.equal(walkFeatures.matchedBaselineContext, "active");
    assert.ok(Math.abs(walkFeatures.hrZScore) < 1.5, `Expected low active HR z-score, got ${walkFeatures.hrZScore}`);

    // Timestamped rising temperature trend across 4 minutes
    const driftStore = new SlidingWindowStore(8, 15 * 60_000);
    const baseT = 1_700_000_300_000;
    const temps = [36.6, 37.0, 37.5, 38.1];
    let driftWindow = [] as ReturnType<SlidingWindowStore["append"]>;
    for (let i = 0; i < temps.length; i++) {
      driftWindow = driftStore.append("p_drift", "esp32_hardware", {
        timestampMs: baseT + i * 60_000,
        heartRate: 74 + i * 10,
        spo2: 98 - i,
        temperatureC: temps[i],
        accelMagnitude: 1.0,
        gyroMagnitude: 2.0,
        movementStatus: "resting",
        signalQuality: "good",
        ecgLeadOff: true,
      });
    }
    const driftFeatures = extractWindowFeatures({ window: driftWindow, profile });
    assert.ok(driftFeatures.tempSlopeCPerMin > 0.35, `Expected positive temp slope, got ${driftFeatures.tempSlopeCPerMin}`);
    assert.equal(driftFeatures.ecgLeadOff, true);
    assert.equal(driftFeatures.ecgAvailable, false);
  });

  it("3. ServerAlertDecisionEngine enforces quality gate, insufficient_baseline + acute guardrail, and persistence", () => {
    const engine = new ServerAlertDecisionEngine();
    const store = new SlidingWindowStore();
    const tracker = new BaselineTracker(path.join(tempDir, "decision-baselines.json"));

    const baselineSamples = Array.from({ length: 12 }, (_, i) =>
      makeSample({
        timestampMs: 1_700_000_000_000 + i * 5000,
        heartRate: 71 + (i % 2),
        spo2: 98.4,
        temperatureC: 36.6,
        movementStatus: "resting",
      })
    );
    const profile = tracker.fitBaseline("p_dec", "esp32_hardware", baselineSamples, 12);

    // (a) Insufficient baseline normal reading -> insufficient_baseline, Normal alert
    const w0 = store.append("p_insuff", "esp32_hardware", {
      timestampMs: 1_700_000_000_000,
      heartRate: 75,
      spo2: 98,
      temperatureC: 36.6,
      accelMagnitude: 1.0,
      gyroMagnitude: 2.0,
      movementStatus: "resting",
      signalQuality: "good",
      ecgLeadOff: false,
    });
    const f0 = extractWindowFeatures({ window: w0, profile: null });
    const dInsuff = engine.evaluate({
      patientId: "p_insuff",
      source: "esp32_hardware",
      signalQuality: "good",
      qualityNotes: [],
      ecgLeadOff: false,
      heartRate: 75,
      spo2: 98,
      temperatureC: 36.6,
      accelMagnitude: 1.0,
      possibleFallDetected: false,
      baselineReady: false,
      baselineProgress: {
        collectedSamples: 3,
        requiredSamples: 20,
        status: "collecting",
        source: "esp32_hardware",
        modelVersion: null,
        restingSamples: 3,
        activeSamples: 0,
        ecgBaselineSamples: 0,
      },
      features: f0,
      mlServiceConnected: false,
    });
    assert.equal(dInsuff.anomalyStatus, "insufficient_baseline");
    assert.equal(dInsuff.alertLevel, "Normal");

    // (b) Insufficient baseline + acute hypoxia (SpO2 <= 88) -> acute safety guardrail Critical
    const dAcute = engine.evaluate({
      patientId: "p_insuff",
      source: "esp32_hardware",
      signalQuality: "good",
      qualityNotes: [],
      ecgLeadOff: false,
      heartRate: 132,
      spo2: 86,
      temperatureC: 36.7,
      accelMagnitude: 1.0,
      possibleFallDetected: false,
      baselineReady: false,
      baselineProgress: {
        collectedSamples: 3,
        requiredSamples: 20,
        status: "collecting",
        source: "esp32_hardware",
        modelVersion: null,
        restingSamples: 3,
        activeSamples: 0,
        ecgBaselineSamples: 0,
      },
      features: f0,
      mlServiceConnected: false,
    });
    assert.equal(dAcute.anomalyStatus, "insufficient_baseline");
    assert.equal(dAcute.alertLevel, "Critical");

    // (c) Poor contact pauses scoring
    const dPoor = engine.evaluate({
      patientId: "p_dec",
      source: "esp32_hardware",
      signalQuality: "poor_contact",
      qualityNotes: ["No finger detected"],
      ecgLeadOff: true,
      heartRate: null,
      spo2: null,
      temperatureC: null,
      accelMagnitude: 1.0,
      possibleFallDetected: false,
      baselineReady: true,
      baselineProgress: tracker.getProgress("p_dec", "esp32_hardware", 12),
      features: f0,
      mlServiceConnected: false,
    });
    assert.equal(dPoor.anomalyStatus, "paused_poor_quality");
    assert.equal(dPoor.alertLevel, "Normal");
    assert.ok(dPoor.explanation.includes("lead-off"));

    // (d) Single transient spike is suppressed by warningPersistenceWindows=2; 2nd consecutive confirms Warning
    const spikeEntry = {
      timestampMs: 1_700_001_000_000,
      heartRate: 102,
      spo2: 98.0,
      temperatureC: 36.7,
      accelMagnitude: 1.0,
      gyroMagnitude: 2.0,
      movementStatus: "resting" as MovementStatus,
      signalQuality: "good" as const,
      ecgLeadOff: false,
    };
    const w1 = store.append("p_dec", "esp32_hardware", spikeEntry);
    const f1 = extractWindowFeatures({ window: w1, profile });
    const d1 = engine.evaluate({
      patientId: "p_dec",
      source: "esp32_hardware",
      signalQuality: "good",
      qualityNotes: [],
      ecgLeadOff: false,
      heartRate: 102,
      spo2: 98.0,
      temperatureC: 36.7,
      accelMagnitude: 1.0,
      possibleFallDetected: false,
      baselineReady: true,
      baselineProgress: tracker.getProgress("p_dec", "esp32_hardware", 12),
      features: f1,
      mlServiceConnected: false,
      policyInput: { warningPersistenceWindows: 2, criticalPersistenceWindows: 3 },
    });
    assert.equal(d1.anomalyStatus, "anomalous");
    assert.equal(d1.alertLevel, "Normal");
    assert.equal(d1.persistenceCount, 1);

    const w2 = store.append("p_dec", "esp32_hardware", { ...spikeEntry, timestampMs: 1_700_001_005_000 });
    const f2 = extractWindowFeatures({ window: w2, profile });
    const d2 = engine.evaluate({
      patientId: "p_dec",
      source: "esp32_hardware",
      signalQuality: "good",
      qualityNotes: [],
      ecgLeadOff: false,
      heartRate: 102,
      spo2: 98.0,
      temperatureC: 36.7,
      accelMagnitude: 1.0,
      possibleFallDetected: false,
      baselineReady: true,
      baselineProgress: tracker.getProgress("p_dec", "esp32_hardware", 12),
      features: f2,
      mlServiceConnected: false,
      policyInput: { warningPersistenceWindows: 2, criticalPersistenceWindows: 3 },
    });
    assert.equal(d2.alertLevel, "Warning");
    assert.equal(d2.persistenceCount, 2);
  });

  it("4. End-to-end analyzeTelemetry handles missing temp, lead-off ECG, poor contact, and synthetic evaluation metrics", async () => {
    const pid = `test_e2e_${Date.now()}`;
    e2ePatientIds.push(pid);

    // Fit personalized baseline with 20 clean resting + walking samples (no temp sensor confirmed -> null)
    const fitSamples = [
      ...Array.from({ length: 12 }, (_, i) => ({
        heartRate: 70 + (i % 3),
        spo2: 98.4,
        temperatureC: 36.6,
        accelMagnitude: 1.0,
        gyroMagnitude: 2.0,
        movementStatus: "resting" as MovementStatus,
        signalQuality: "good" as const,
        timestamp: new Date(1_700_000_000_000 + i * 5000).toISOString(),
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        heartRate: 98 + (i % 3),
        spo2: 97.8,
        temperatureC: 36.6,
        accelMagnitude: 1.38,
        gyroMagnitude: 14.0,
        movementStatus: "walking" as MovementStatus,
        signalQuality: "good" as const,
        timestamp: new Date(1_700_000_100_000 + i * 5000).toISOString(),
      })),
    ];

    const fitRes = await fitPatientBaselineRemote(pid, fitSamples, {
      source: "esp32_hardware",
      minSamples: 20,
    });
    assert.equal(fitRes.baselineStatus, "ready");
    assert.equal(fitRes.sampleCount, 20);

    // Missing temperature & ECG lead-off packet should NOT fail or produce fake alerts
    const missingTempRes = await analyzeTelemetry(
      makeTelemetry({
        patientId: pid,
        heartRate: 72,
        spo2: 98.3,
        temperatureC: null,
        ecgLeadOff: true,
        ecgSignalQuality: "lead_off",
      })
    );
    assert.equal(missingTempRes.alertLevel, "Normal");
    assert.equal(missingTempRes.anomalyStatus, "normal");
    assert.ok(missingTempRes.explanation.includes("lead-off"));

    // Poor contact check
    const qualityCheck = validateSensorQuality(
      makeTelemetry({ patientId: pid, fingerDetected: false, heartRate: null, spo2: null })
    );
    assert.equal(qualityCheck.signalQuality, "poor_contact");

    // Synthetic Evaluation Benchmark (explicitly synthetic/simulated, non-clinical)
    interface SyntheticCase {
      label: "normal" | "anomalous";
      payload: Partial<TelemetryPayload>;
    }

    const t0 = 1_700_002_000_000;
    const cases: SyntheticCase[] = [
      // Normal resting (4)
      { label: "normal", payload: { heartRate: 71, spo2: 98.5, temperatureC: 36.6, movementStatus: "resting" } },
      { label: "normal", payload: { heartRate: 72, spo2: 98.3, temperatureC: 36.6, movementStatus: "resting" } },
      { label: "normal", payload: { heartRate: 70, spo2: 98.6, temperatureC: 36.5, movementStatus: "resting" } },
      { label: "normal", payload: { heartRate: 73, spo2: 98.4, temperatureC: 36.6, movementStatus: "resting" } },
      // Normal walking (3)
      { label: "normal", payload: { heartRate: 99, spo2: 97.9, temperatureC: 36.6, movementStatus: "walking", accelMagnitude: 1.35 } },
      { label: "normal", payload: { heartRate: 100, spo2: 97.8, temperatureC: 36.6, movementStatus: "walking", accelMagnitude: 1.38 } },
      { label: "normal", payload: { heartRate: 98, spo2: 97.8, temperatureC: 36.7, movementStatus: "walking", accelMagnitude: 1.36 } },
      // Single-packet transient glitch followed by normal recovery (expected Normal due to persistence=2)
      { label: "normal", payload: { heartRate: 101, spo2: 98.2, temperatureC: 36.6, movementStatus: "resting" } },
      { label: "normal", payload: { heartRate: 72, spo2: 98.4, temperatureC: 36.6, movementStatus: "resting" } },
      // Sustained anomalous drift + critical distress (5 consecutive anomalous readings)
      { label: "anomalous", payload: { heartRate: 108, spo2: 94.8, temperatureC: 37.8, movementStatus: "resting" } },
      { label: "anomalous", payload: { heartRate: 114, spo2: 93.4, temperatureC: 38.2, movementStatus: "resting" } },
      { label: "anomalous", payload: { heartRate: 122, spo2: 91.5, temperatureC: 38.6, movementStatus: "resting" } },
      { label: "anomalous", payload: { heartRate: 132, spo2: 89.2, temperatureC: 39.0, movementStatus: "resting" } },
      { label: "anomalous", payload: { heartRate: 136, spo2: 88.5, temperatureC: 39.2, movementStatus: "resting" } },
    ];

    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const result = await analyzeTelemetry(
        makeTelemetry({
          patientId: pid,
          timestamp: new Date(t0 + i * 30_000).toISOString(),
          policyConfig: { warningPersistenceWindows: 2, criticalPersistenceWindows: 3 },
          ...c.payload,
        })
      );
      const predictedAlert = result.alertLevel !== "Normal";
      if (c.label === "anomalous" && predictedAlert) tp++;
      else if (c.label === "normal" && predictedAlert) fp++;
      else if (c.label === "normal" && !predictedAlert) tn++;
      else fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;

    assert.ok(precision >= 0.85, `Expected synthetic precision >= 0.85, got ${precision.toFixed(2)}`);
    assert.ok(recall >= 0.8, `Expected synthetic recall >= 0.80, got ${recall.toFixed(2)}`);
    assert.ok(fpr <= 0.12, `Expected synthetic FPR <= 0.12, got ${fpr.toFixed(2)}`);
  });
});
