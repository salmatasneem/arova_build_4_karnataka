import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import express from "express";
import { BaselineTracker, sharedBaselineTracker, type BaselineSampleInput } from "../baselineTracker.ts";
import { getDatasetCatalog, getDatasetCatalogEntry } from "../datasets/catalog.ts";
import { createWearableRouter } from "../esp32Ingest.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { analyzeTelemetry, fitPatientBaselineRemote, validateSensorQuality } from "../mlClient.ts";
import type { TelemetryPayload } from "../types.ts";

describe("Stage 1 — Schema, Dataset Catalog & Modality-Aware Isolation Foundation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smartcare-stage1-test-"));
  const cleanupPatientIds: string[] = [];

  after(() => {
    for (const pid of cleanupPatientIds) {
      sharedBaselineTracker.resetPatient(pid);
      sharedWindowStore.clear(pid);
      sharedAlertDecisionEngine.clear(pid);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("1. Public dataset catalog verifies URLs, non-local status, and honest age cohort labels", () => {
    const catalog = getDatasetCatalog();
    assert.equal(catalog.length, 12);

    for (const ds of catalog) {
      assert.equal(ds.integratedLocally, false);
      assert.equal(ds.requiresManualDownload, true);
      assert.equal(ds.stageStatus, "cataloged_stage1_adapter_pending_stage2");
      assert.equal(ds.cohort.allParticipantsElderly, false);
      assert.ok(ds.exactUrl.startsWith("https://"), `Expected https URL for ${ds.id}`);
    }

    // Explicitly verify mixed/elderly-inclusive vs general/young adult distinctions
    const sisfall = getDatasetCatalogEntry("sisfall");
    const ppgDalia = getDatasetCatalogEntry("ppg_dalia");
    const wesad = getDatasetCatalogEntry("wesad");
    const umafall = getDatasetCatalogEntry("umafall");
    const sleepEdfx = getDatasetCatalogEntry("sleep_edfx");
    const dreamt = getDatasetCatalogEntry("dreamt");

    assert.equal(sisfall?.cohort.includesElderly, true);
    assert.equal(sleepEdfx?.cohort.includesElderly, true);
    assert.equal(ppgDalia?.cohort.includesElderly, false);
    assert.equal(wesad?.cohort.includesElderly, false);
    assert.equal(umafall?.cohort.includesElderly, false);
    assert.equal(dreamt?.accessTier, "restricted_dua");
  });

  it("2. dataset_playback baselines remain strictly isolated from esp32_hardware and simulator", () => {
    const tracker = new BaselineTracker(path.join(tempDir, "stage1-isolation.json"));

    const imuSamples: BaselineSampleInput[] = Array.from({ length: 12 }, (_, i) => ({
      timestampMs: 1_700_000_000_000 + i * 5000,
      heartRate: null,
      spo2: null,
      temperatureC: null,
      accelMagnitude: 1.0 + (i % 3) * 0.05,
      gyroMagnitude: 3.0 + (i % 2),
      movementStatus: i % 4 === 3 ? "walking" : "resting",
      signalQuality: "good",
      availableModalities: { heartRate: false, spo2: false, imu: true, temperatureC: false },
    }));

    const dsProfile = tracker.fitBaseline("p_iso", "dataset_playback", imuSamples, 10);
    assert.equal(dsProfile.source, "dataset_playback");
    assert.equal(dsProfile.sampleCount, 12);

    // Hardware & simulator baselines must remain completely untouched
    assert.equal(tracker.getProfile("p_iso", "esp32_hardware"), null);
    assert.equal(tracker.getProfile("p_iso", "simulator"), null);
    assert.equal(tracker.getProgress("p_iso", "esp32_hardware", 10).collectedSamples, 0);
    assert.equal(tracker.getProgress("p_iso", "simulator", 10).collectedSamples, 0);
  });

  it("3. Modality-aware quality validation applies ONLY to dataset_playback; esp32_hardware optical gate stays strict", async () => {
    const pid = `pt_stage1_mod_${Date.now()}`;
    cleanupPatientIds.push(pid);

    // esp32_hardware with null HR/SpO2 must remain poor_contact even if availableModalities attempts to disable them
    const hwPayload: TelemetryPayload = {
      patientId: pid,
      deviceId: "ESP32-S1-01",
      heartRate: null,
      spo2: null,
      temperatureC: 36.6,
      movementStatus: "resting",
      accelMagnitude: 1.0,
      gyroMagnitude: 3.0,
      irSignalOk: true,
      fingerDetected: true,
      source: "esp32_hardware",
      availableModalities: { heartRate: false, spo2: false, imu: true },
    };
    const hwQuality = validateSensorQuality(hwPayload);
    assert.equal(hwQuality.signalQuality, "poor_contact");

    const hwAnalysis = await analyzeTelemetry(hwPayload);
    assert.equal(hwAnalysis.signalQuality, "poor_contact");
    assert.equal(hwAnalysis.anomalyStatus, "paused_poor_quality");

    // dataset_playback IMU-only (e.g. SisFall) must validate as 'good' and fit/score cleanly
    const imuModalities = { heartRate: false, spo2: false, imu: true, temperatureC: false };
    const dsFitSamples = Array.from({ length: 20 }, (_, i) => ({
      heartRate: null,
      spo2: null,
      temperatureC: null,
      accelMagnitude: 1.0 + (i % 3) * 0.04,
      gyroMagnitude: 4.0 + (i % 2),
      movementStatus: i % 4 === 3 ? ("walking" as const) : ("resting" as const),
      signalQuality: "good" as const,
      timestamp: new Date(1_700_010_000_000 + i * 5000).toISOString(),
    }));
    const dsFit = await fitPatientBaselineRemote(pid, dsFitSamples, {
      source: "dataset_playback",
      minSamples: 20,
      availableModalities: imuModalities,
    });
    assert.equal(dsFit.source, "dataset_playback");
    assert.equal(dsFit.baselineStatus, "ready");

    const dsCheck = await analyzeTelemetry({
      patientId: pid,
      heartRate: null,
      spo2: null,
      temperatureC: null,
      movementStatus: "resting",
      accelMagnitude: 1.01,
      gyroMagnitude: 4.2,
      source: "dataset_playback",
      availableModalities: imuModalities,
      datasetContext: { datasetId: "sisfall", recordId: "SE06_D01" },
    });
    assert.equal(dsCheck.signalQuality, "good");
    assert.equal(dsCheck.anomalyStatus, "normal");
    assert.equal(dsCheck.alertLevel, "Normal");

    // Verify wrist skin temperature threshold (28.5 C allowed on dataset_playback skin_wrist, rejected on esp32_hardware)
    const wristOk = validateSensorQuality({
      patientId: pid,
      heartRate: 72,
      spo2: null,
      temperatureC: 28.5,
      movementStatus: "resting",
      accelMagnitude: 1.0,
      gyroMagnitude: 2.0,
      source: "dataset_playback",
      temperatureSite: "skin_wrist",
      availableModalities: { heartRate: true, spo2: false, temperatureC: true },
    });
    assert.equal(wristOk.signalQuality, "good");

    const hwTempRejected = validateSensorQuality({
      patientId: pid,
      heartRate: 72,
      spo2: 98,
      temperatureC: 28.5,
      movementStatus: "resting",
      accelMagnitude: 1.0,
      gyroMagnitude: 2.0,
      source: "esp32_hardware",
      temperatureSite: "skin_wrist",
    });
    assert.equal(hwTempRejected.signalQuality, "poor_contact");
  });

  it("4. Existing ESP32 /api/wearable/ingest contract works unchanged and preserves optional Stage 1 fields", async () => {
    const pid = `pt_stage1_esp32_${Date.now()}`;
    cleanupPatientIds.push(pid);

    const app = express();
    app.use(express.json());
    app.use("/api/wearable", createWearableRouter());

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // Legacy ESP32 firmware JSON payload (no Stage 1 fields) + optional Stage 1 accel axes
      const res = await fetch(`${baseUrl}/api/wearable/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "ESP32-TEST-99",
          patientId: pid,
          pulseOxVariant: "MAX30100",
          tempSensorModel: "unconfirmed",
          ecgSensorModel: "AD8232",
          heartRate: 74,
          spo2: 98,
          temperatureC: null,
          accelMagnitude: 1.02,
          gyroMagnitude: 3.1,
          movementStatus: "resting",
          possibleFallDetected: false,
          irSignalOk: true,
          fingerDetected: true,
          ecgSamples: [],
          ecgSamplingRate: 200,
          ecgLeadOff: true,
          source: "simulator",
          accelX: 0.02,
          accelY: 0.01,
          accelZ: 1.01,
          imuSamplingRate: 100,
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.source, "simulator");
      assert.equal(body.signalQuality, "good");
      assert.equal(body.ecgLeadOff, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
