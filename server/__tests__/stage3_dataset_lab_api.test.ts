import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { sharedBaselineTracker } from "../baselineTracker.ts";
import { parseDatasetFile } from "../datasets/adapters/index.ts";
import { DatasetPlaybackEngine } from "../datasets/playbackEngine.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { resetPatientMlRemote } from "../mlClient.ts";

describe("Stage 3 — Dataset Lab Telemetry Snapshot & Provenance Time-Range Contract", () => {
  const cleanupKeys: string[] = [];

  after(async () => {
    for (const key of cleanupKeys) {
      await resetPatientMlRemote(key, "dataset_playback");
      sharedBaselineTracker.resetPatient(key);
      sharedWindowStore.clear(key);
      sharedAlertDecisionEngine.clear(key);
    }
  });

  it("1. PlaybackFrameResult.telemetrySnapshot exposes real modality values and preserves nulls for absent channels", async () => {
    const csv = [
      "timestamp,ax,ay,az,gx,gy,gz,label",
      "0.0,0.01,-0.02,1.00,2.5,1.0,0.5,adl",
      "0.5,0.02,0.01,1.01,3.0,1.2,0.7,adl",
      "1.0,2.10,1.80,1.90,150.0,90.0,45.0,fall",
    ].join("\n");

    const recording = parseDatasetFile({
      datasetId: "sisfall",
      filename: "SA02_stage3_test.csv",
      content: csv,
    });

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, { speed: 2 });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);

    assert.equal(loaded.provenance?.durationMs, 1000);
    assert.ok(loaded.provenance?.startTimestampIso);
    assert.ok(loaded.provenance?.endTimestampIso);
    assert.equal(loaded.provenance?.hasGroundTruthLabels, true);
    assert.equal(loaded.provenance?.labeledFrameCount, 3);

    const step1 = await engine.step();
    assert.ok(step1.result?.telemetrySnapshot);
    assert.equal(step1.result?.telemetrySnapshot.heartRate, null);
    assert.equal(step1.result?.telemetrySnapshot.spo2, null);
    assert.equal(step1.result?.telemetrySnapshot.temperatureC, null);
    assert.equal(step1.result?.telemetrySnapshot.respiratoryRateBpm, null);
    assert.ok((step1.result?.telemetrySnapshot.accelMagnitude ?? 0) > 0.9);
    assert.equal(step1.result?.telemetrySnapshot.possibleFallDetected, false);

    await engine.step();
    const step3 = await engine.step();
    assert.equal(step3.result?.telemetrySnapshot.possibleFallDetected, true);
    assert.equal(step3.result?.groundTruthIsAnomalous, true);
    assert.equal(step3.snapshot.evaluation.hasGroundTruthLabels, true);
    assert.equal(step3.snapshot.evaluation.labeledCount, 3);
  });

  it("2. ECG playback attaches ecgSamples to lastResult while omitting heavy sample arrays in recentResults history", async () => {
    const rows = ["'Elapsed time','MLII','symbol'"];
    const total = 1440;
    for (let i = 0; i < total; i++) {
      const t = (i / 360).toFixed(4);
      const phase = i % 300;
      const mv = phase === 100 ? 1.25 : phase === 99 || phase === 101 ? 0.55 : phase === 102 ? -0.35 : 0.02;
      const sym = i === 100 || i === 1000 ? "N" : "";
      rows.push(`${t},${mv},${sym}`);
    }

    const recording = parseDatasetFile({
      datasetId: "mitdb_arrhythmia",
      filename: "mitdb_100_stage3.csv",
      content: rows.join("\n"),
      windowMs: 2000,
    });

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, { speed: 1 });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);

    await engine.step();
    const step2 = await engine.step();
    const snap = step2.snapshot;
    assert.ok(Array.isArray(snap.lastResult?.telemetrySnapshot.ecgSamples));
    assert.ok((snap.lastResult?.telemetrySnapshot.ecgSamples?.length ?? 0) > 50);
    assert.equal(snap.recentResults.length, 2);
    assert.equal(snap.recentResults[0].telemetrySnapshot.ecgSamples, undefined);
    assert.equal(snap.recentResults[1].telemetrySnapshot.ecgSamples, undefined);
    assert.ok(snap.lastResult?.analysis.ecgFeatures);
  });

  it("3. SisFall adapter handles official trailing separators, ADXL345/ITG3200 header aliases, and warns on Fxx trial-level labels", () => {
    const rawOfficial = [
      "0, 0, 256, 1638, 0, 0, 0, 1024, 0, ;",
      "600, 500, 400, 25000, -24000, 20000, 1200, 1000, 900;",
    ].join("\n");
    const parsedRaw = parseDatasetFile({
      datasetId: "sisfall",
      filename: "F01_SA01_R01.txt",
      content: rawOfficial,
    });
    assert.equal(parsedRaw.participantId, "SA01");
    assert.equal(parsedRaw.recordId, "F01");
    assert.equal(parsedRaw.frames[0].telemetry.accelMagnitude, 1);
    assert.ok(parsedRaw.frames[1].telemetry.gyroMagnitude > 2000, "3-axis ITG3200 magnitude can exceed 2000 deg/s");
    assert.ok(parsedRaw.warnings.some((w) => w.includes("Trial-level filename label")));

    const chipHeaderCsv = [
      "timestamp,ADXL345_X,ADXL345_Y,ADXL345_Z,ITG3200_X,ITG3200_Y,ITG3200_Z,label",
      "0.000,0,0,256,0,0,0,adl",
      "0.005,12,-4,255,10,-8,4,adl",
    ].join("\n");
    const parsedChip = parseDatasetFile({
      datasetId: "sisfall",
      filename: "D01_SE01_R01.csv",
      content: chipHeaderCsv,
    });
    assert.equal(parsedChip.frames.length, 2);
    assert.equal(parsedChip.frames[0].telemetry.accelMagnitude, 1);
    assert.equal(parsedChip.frames[0].groundTruthIsAnomalous, false);
  });
});

