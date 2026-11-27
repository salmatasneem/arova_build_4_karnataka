import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { sharedBaselineTracker } from "../baselineTracker.ts";
import {
  DatasetValidationError,
  getSupportedAdapterSpecs,
  parseDatasetFile,
} from "../datasets/adapters/index.ts";
import { DatasetGroundTruthEvaluator } from "../datasets/evaluator.ts";
import { DatasetPlaybackEngine } from "../datasets/playbackEngine.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { checkMlServiceHealth, resetPatientMlRemote } from "../mlClient.ts";

describe("Stage 2 — Dataset File Import Adapters, Playback Engine & Ground-Truth Evaluation", () => {
  const cleanupKeys: string[] = [];

  after(async () => {
    for (const key of cleanupKeys) {
      await resetPatientMlRemote(key, "dataset_playback");
      sharedBaselineTracker.resetPatient(key);
      sharedWindowStore.clear(key);
      sharedAlertDecisionEngine.clear(key);
    }
  });

  it("1. SisFall adapter parses raw 9-column ADC TXT and named CSV without fabricating missing modalities", () => {
    // 256 LSB ≈ 1g on ADXL345 (±16g, 13-bit), then a fall spike (~850 LSB ≈ 3.3g)
    const rawTxt = [
      "12, -8, 256, 40, -20, 15, 20, -10, 1024;",
      "15, -6, 254, 45, -18, 12, 22, -12, 1020;",
      "450, 320, 720, 1800, -1200, 900, 600, 400, 1800;",
    ].join("\n");

    const parsedRaw = parseDatasetFile({
      datasetId: "sisfall",
      filename: "F01_SE06_R01.txt",
      content: rawTxt,
    });

    assert.equal(parsedRaw.datasetId, "sisfall");
    assert.equal(parsedRaw.participantId, "SE06");
    assert.equal(parsedRaw.recordId, "F01");
    assert.equal(parsedRaw.samplingRateHz, 200);
    assert.equal(parsedRaw.availableModalities.imu, true);
    assert.equal(parsedRaw.availableModalities.heartRate, false);
    assert.equal(parsedRaw.availableModalities.spo2, false);
    assert.equal(parsedRaw.availableModalities.temperatureC, false);
    assert.equal(parsedRaw.allParticipantsElderly, false);
    assert.equal(parsedRaw.includesElderly, true);
    assert.equal(parsedRaw.hasGroundTruthLabels, true);
    assert.equal(parsedRaw.frames.length, 3);
    assert.equal(parsedRaw.frames[0].telemetry.heartRate, null);
    assert.equal(parsedRaw.frames[0].telemetry.spo2, null);
    assert.equal(parsedRaw.frames[0].telemetry.temperatureC, null);
    assert.ok(parsedRaw.frames[0].telemetry.accelMagnitude > 0.9 && parsedRaw.frames[0].telemetry.accelMagnitude < 1.15);
    assert.ok(parsedRaw.frames[2].telemetry.accelMagnitude >= 2.8);
    assert.equal(parsedRaw.frames[2].telemetry.possibleFallDetected, true);
    assert.equal(parsedRaw.frames[2].groundTruthIsAnomalous, true);

    // Named CSV with timestamps preserved
    const namedCsv = [
      "timestamp,ax,ay,az,gx,gy,gz,label",
      "0.0,0.02,-0.01,1.00,2.1,1.0,0.5,adl",
      "0.5,0.01,0.02,1.01,3.0,1.2,0.8,adl",
      "1.0,1.80,1.60,2.20,140.0,80.0,45.0,fall",
    ].join("\n");
    const parsedCsv = parseDatasetFile({
      datasetId: "sisfall",
      filename: "SA01_custom.csv",
      content: namedCsv,
    });
    assert.equal(parsedCsv.frames[0].relativeOffsetMs, 0);
    assert.equal(parsedCsv.frames[1].relativeOffsetMs, 500);
    assert.equal(parsedCsv.frames[2].relativeOffsetMs, 1000);
    assert.equal(parsedCsv.frames[0].groundTruthIsAnomalous, false);
    assert.equal(parsedCsv.frames[2].groundTruthIsAnomalous, true);
  });

  it("2. UMAFall adapter parses official semicolon multi-sensor logs and respects young-adult cohort truth", () => {
    const umaOfficial = [
      "% UMAFall Official Test Export",
      "% Subject 04",
      "TimeStamp; Sample No; X-Axis; Y-Axis; Z-Axis; Sensor Type; Sensor ID",
      "0.00; 1; 0.01; -0.02; 1.00; 0; 1",
      "0.00; 1; 1.2; -0.5; 2.0; 1; 1",
      "0.00; 1; 22.0; 15.0; -10.0; 2; 1",
      "0.05; 2; 2.10; 1.80; 1.90; 0; 1",
      "0.05; 2; 120.0; -90.0; 40.0; 1; 1",
    ].join("\n");

    const parsed = parseDatasetFile({
      datasetId: "umafall",
      filename: "UMAFall_Subject_04_Fall_Forward.csv",
      content: umaOfficial,
    });

    assert.equal(parsed.datasetId, "umafall");
    assert.equal(parsed.participantId, "SUBJ_04");
    assert.equal(parsed.includesElderly, false);
    assert.equal(parsed.allParticipantsElderly, false);
    assert.equal(parsed.frames.length, 2);
    assert.equal(parsed.frames[0].relativeOffsetMs, 0);
    assert.equal(parsed.frames[1].relativeOffsetMs, 50);
    assert.ok(parsed.frames[1].telemetry.accelMagnitude >= 2.8);
    assert.equal(parsed.frames[1].telemetry.gyroMagnitude > 100, true);
    assert.equal(parsed.frames[0].telemetry.spo2, null);
    assert.equal(parsed.frames[0].groundTruthIsAnomalous, true);
  });

  it("3. BIDMC adapter preserves missing values as null and omits ground-truth labels when absent", () => {
    const bidmcCsv = [
      "Time [s], HR, PULSE, RESP, SpO2",
      "0, 72, 72, 16, 98",
      "1, 74, 74, NA, 98",
      "2, , 75, 17, 97",
      "3, 73, 73, 16, --",
    ].join("\n");

    const parsed = parseDatasetFile({
      datasetId: "bidmc_ppg_respiration",
      filename: "bidmc_01_Numerics.csv",
      content: bidmcCsv,
    });

    assert.equal(parsed.participantId, "BIDMC_01");
    assert.equal(parsed.hasGroundTruthLabels, false);
    assert.equal(parsed.labeledFrameCount, 0);
    assert.equal(parsed.frames.length, 4);
    assert.equal(parsed.frames[1].telemetry.respiratoryRateBpm, null);
    assert.equal(parsed.frames[2].telemetry.heartRate, null);
    assert.equal(parsed.frames[2].telemetry.availableModalities?.heartRate, false);
    assert.equal(parsed.frames[2].telemetry.availableModalities?.spo2, true);
    assert.equal(parsed.frames[3].telemetry.spo2, null);
    assert.equal(parsed.frames[3].telemetry.temperatureC, null);
  });

  it("4. MIT-BIH CSV adapter extracts ECG features and maps beat annotations without fabricating SpO2/IMU", () => {
    // Generate 4 seconds (1440 samples at 360 Hz) of clean synthetic R-peaks at ~72 BPM (every 300 samples)
    const rows = ["'Elapsed time','MLII','symbol'"];
    const total = 1440;
    for (let i = 0; i < total; i++) {
      const t = (i / 360).toFixed(4);
      const phase = i % 300;
      const mv = phase === 100 ? 1.25 : phase === 99 || phase === 101 ? 0.55 : phase === 102 ? -0.35 : 0.02;
      const sym = i === 100 ? "N" : i === 1000 ? "V" : "";
      rows.push(`${t},${mv},${sym}`);
    }

    const parsed = parseDatasetFile({
      datasetId: "mitdb_arrhythmia",
      filename: "mitdb_100_export.csv",
      content: rows.join("\n"),
      windowMs: 2000,
    });

    assert.equal(parsed.participantId, "MITDB_100");
    assert.equal(parsed.samplingRateHz, 360);
    assert.equal(parsed.frames.length, 2);
    assert.equal(parsed.availableModalities.ecg, true);
    assert.equal(parsed.availableModalities.spo2, false);
    assert.equal(parsed.availableModalities.temperatureC, false);
    assert.equal(parsed.availableModalities.imu, false);
    assert.ok(parsed.frames[0].telemetry.ecgFeatures?.estimatedEcgBpm !== null);
    assert.ok(
      Math.abs((parsed.frames[0].telemetry.ecgFeatures?.estimatedEcgBpm ?? 0) - 72) <= 5,
      `Expected ~72 BPM, got ${parsed.frames[0].telemetry.ecgFeatures?.estimatedEcgBpm}`
    );
    assert.equal(parsed.frames[0].groundTruthLabel, "N");
    assert.equal(parsed.frames[0].groundTruthIsAnomalous, false);
    assert.equal(parsed.frames[1].groundTruthLabel, "V");
    assert.equal(parsed.frames[1].groundTruthIsAnomalous, true);
  });

  it("5. PPG-DaLiA and WESAD adapters set skin_wrist temperature, convert E4 1/64g counts, and enforce adult non-elderly cohort metadata", () => {
    const wesadCsv = [
      "timestamp,hr,skin_temp,acc_x,acc_y,acc_z,label",
      "0,68,31.2,2,-1,64,1",
      "1,70,31.3,3,0,63,0",
      "2,102,31.8,12,8,66,2",
      "3,74,31.5,1,0,64,3",
    ].join("\n");

    const parsedWesad = parseDatasetFile({
      datasetId: "wesad",
      filename: "WESAD_S2_export.csv",
      content: wesadCsv,
    });

    assert.equal(parsedWesad.participantId, "WESAD_S2");
    assert.equal(parsedWesad.temperatureSite, "skin_wrist");
    assert.equal(parsedWesad.includesElderly, false);
    assert.equal(parsedWesad.allParticipantsElderly, false);
    assert.equal(parsedWesad.frames[0].telemetry.temperatureSite, "skin_wrist");
    assert.ok(parsedWesad.frames[0].telemetry.accelMagnitude >= 0.9 && parsedWesad.frames[0].telemetry.accelMagnitude <= 1.1);
    assert.equal(parsedWesad.frames[0].groundTruthIsAnomalous, false); // baseline=1
    assert.equal(parsedWesad.frames[1].groundTruthIsAnomalous, null); // transient=0
    assert.equal(parsedWesad.frames[2].groundTruthIsAnomalous, true); // stress=2
    assert.equal(parsedWesad.frames[3].groundTruthIsAnomalous, false); // amusement=3

    const daliaCsv = [
      "time_s,heart_rate,temp,accel_magnitude,activity",
      "0,76,30.8,1.02,sitting",
      "1,104,31.0,1.38,walking",
    ].join("\n");

    const parsedDalia = parseDatasetFile({
      datasetId: "ppg_dalia",
      filename: "S5_ppgdalia.csv",
      content: daliaCsv,
    });
    assert.equal(parsedDalia.participantId, "PPGDALIA_S5");
    assert.equal(parsedDalia.includesElderly, false);
    assert.equal(parsedDalia.hasGroundTruthLabels, false);
    assert.equal(parsedDalia.frames[1].telemetry.movementStatus, "walking");
  });

  it("6. Rejects invalid files, missing required columns, and raw EDF/WFDB/PKL binaries with clear guidance", () => {
    assert.ok(getSupportedAdapterSpecs().length === 6);

    assert.throws(
      () =>
        parseDatasetFile({
          datasetId: "mitdb_arrhythmia",
          filename: "100.dat",
          content: "binary_placeholder",
        }),
      (err) => err instanceof DatasetValidationError && err.code === "UNSUPPORTED_WFDB_BINARY"
    );

    assert.throws(
      () =>
        parseDatasetFile({
          datasetId: "wesad",
          filename: "S2.pkl",
          content: "pickle_placeholder",
        }),
      (err) => err instanceof DatasetValidationError && err.code === "UNSUPPORTED_PKL_BINARY"
    );

    assert.throws(
      () =>
        parseDatasetFile({
          datasetId: "bidmc_ppg_respiration",
          filename: "SC4001E0.edf",
          content: "0       ",
        }),
      (err) => err instanceof DatasetValidationError && err.code === "UNSUPPORTED_EDF_BINARY"
    );

    assert.throws(
      () =>
        parseDatasetFile({
          datasetId: "bidmc_ppg_respiration",
          filename: "bad.csv",
          content: "Time [s], Foo, Bar\n0, 1, 2\n",
        }),
      (err) => err instanceof DatasetValidationError && err.code === "MISSING_REQUIRED_COLUMNS"
    );
  });

  it("7. Playback engine supports start, pause, resume, step, reset, speed, and preserves original relative timestamps", async () => {
    const csv = [
      "timestamp,hr,skin_temp,acc_x,acc_y,acc_z,label",
      ...Array.from({ length: 24 }, (_, i) => {
        const isStress = i >= 21;
        const hr = isStress ? 124 + (i - 21) * 4 : 68 + (i % 3);
        const temp = isStress ? 32.6 : 31.2;
        return `${i * 5},${hr},${temp},0.01,0.02,1.00,${isStress ? 2 : 1}`;
      }),
    ].join("\n");

    const recording = parseDatasetFile({
      datasetId: "wesad",
      filename: "WESAD_S7_playback.csv",
      content: csv,
    });

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, { speed: 5, prefitBaselineCount: 20 });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);
    assert.equal(loaded.status, "ready");
    assert.equal(loaded.totalRecords, 24);
    assert.equal(loaded.provenance?.isClinicalPatient, false);
    assert.equal(loaded.provenance?.source, "dataset_playback");

    // Step 1 & Step 2 manually
    const step1 = await engine.step();
    assert.equal(step1.result?.relativeOffsetMs, 0);
    assert.equal(step1.snapshot.currentRecordIndex, 1);

    const step2 = await engine.step();
    assert.equal(step2.result?.relativeOffsetMs, 5000);
    assert.equal(
      Date.parse(step2.result!.timestampIso) - Date.parse(step1.result!.timestampIso),
      5000,
      "Original relative timestamps must stay 5000ms apart regardless of playback speed"
    );

    // Check live Python ML service connection if active on port 18000
    const mlHealth = await checkMlServiceHealth();
    if (mlHealth.reachable) {
      assert.equal(step2.result?.analysis.mlServiceConnected, true);
      assert.equal(step2.result?.analysis.mlEngine, "python_isolation_forest");
    }

    // Verify dataset_playback never mutated esp32_hardware or simulator baselines
    assert.equal(sharedBaselineTracker.getProfile(loaded.playbackPatientKey!, "esp32_hardware"), null);
    assert.equal(sharedBaselineTracker.getProfile(loaded.playbackPatientKey!, "simulator"), null);

    // Pause / speed / start / resume / reset lifecycle
    engine.setSpeed(500); // clamped safely to 100
    assert.equal(engine.getStatus().speed, 100);

    engine.start();
    assert.equal(engine.getStatus().status, "playing");
    engine.pause();
    assert.equal(engine.getStatus().status, "paused");
    engine.resume();
    await new Promise((r) => setTimeout(r, 450));
    const afterPlay = engine.getStatus();
    assert.ok(afterPlay.processedCount > 2, "Expected accelerated playback to advance multiple frames");
    await engine.pause();

    const afterReset = await engine.reset();
    assert.equal(afterReset.status, "ready");
    assert.equal(afterReset.currentRecordIndex, 0);
    assert.equal(afterReset.evaluation.labeledCount, 0);
  });

  it("8. Ground-truth evaluator computes TP/FP/TN/FN/Precision/Recall/F1 accurately and omits metrics when unlabeled", () => {
    const ev = new DatasetGroundTruthEvaluator();

    // Unlabeled recording produces null metrics
    ev.recordFrameOutcome(null, { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good" });
    ev.recordFrameOutcome(null, { alertLevel: "Warning", anomalyStatus: "anomalous", signalQuality: "good" });
    const unlabeledSummary = ev.getSummary();
    assert.equal(unlabeledSummary.hasGroundTruthLabels, false);
    assert.equal(unlabeledSummary.metrics, null);
    assert.match(unlabeledSummary.disclaimer, /not a clinically validated diagnosis/i);

    // Reset and verify exact TP=2, FP=1, TN=2, FN=1 -> Precision=2/3, Recall=2/3, F1=2/3
    ev.reset();
    ev.recordFrameOutcome(true, { alertLevel: "Warning", anomalyStatus: "anomalous", signalQuality: "good" }); // TP
    ev.recordFrameOutcome(true, { alertLevel: "Critical", anomalyStatus: "anomalous", signalQuality: "good" }); // TP
    ev.recordFrameOutcome(false, { alertLevel: "Warning", anomalyStatus: "anomalous", signalQuality: "good" }); // FP
    ev.recordFrameOutcome(false, { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good" }); // TN
    ev.recordFrameOutcome(false, { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good" }); // TN
    ev.recordFrameOutcome(true, { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good" }); // FN
    // Poor quality frame tracked separately
    ev.recordFrameOutcome(true, { alertLevel: "Normal", anomalyStatus: "paused_poor_quality", signalQuality: "poor_contact" });

    const labeledSummary = ev.getSummary();
    assert.equal(labeledSummary.hasGroundTruthLabels, true);
    assert.equal(labeledSummary.labeledCount, 6);
    assert.equal(labeledSummary.skippedPoorQualityCount, 1);
    assert.equal(labeledSummary.metrics?.tp, 2);
    assert.equal(labeledSummary.metrics?.fp, 1);
    assert.equal(labeledSummary.metrics?.tn, 2);
    assert.equal(labeledSummary.metrics?.fn, 1);
    assert.ok(Math.abs((labeledSummary.metrics?.precision ?? 0) - 0.6667) < 0.001);
    assert.ok(Math.abs((labeledSummary.metrics?.recall ?? 0) - 0.6667) < 0.001);
    assert.ok(Math.abs((labeledSummary.metrics?.f1Score ?? 0) - 0.6667) < 0.001);
  });
});
