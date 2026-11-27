import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { sharedAlertDecisionEngine } from "../alertDecisionEngine.ts";
import { sharedBaselineTracker } from "../baselineTracker.ts";
import { parseDatasetFile } from "../datasets/adapters/index.ts";
import { DatasetGroundTruthEvaluator } from "../datasets/evaluator.ts";
import { DatasetPlaybackEngine } from "../datasets/playbackEngine.ts";
import { sharedWindowStore } from "../featureExtractor.ts";
import { classifyPrediction, resetPatientMlRemote } from "../mlClient.ts";

describe("Fall Detection Evaluation Semantics & Baseline Isolation Validation", () => {
  const cleanupKeys: string[] = [];

  after(async () => {
    for (const key of cleanupKeys) {
      await resetPatientMlRemote(key, "dataset_playback");
      sharedBaselineTracker.resetPatient(key);
      sharedWindowStore.clear(key);
      sharedAlertDecisionEngine.clear(key);
    }
  });

  it("1. Distinguishes anomalous sensor window, potential fall alert, physiological alert, and confirmed fall event", () => {
    // 1a. Transient single-window vital deviation (no fall cue, Normal alert awaiting persistence)
    const transientVital = classifyPrediction(
      { possibleFallDetected: false, movementStatus: "resting", accelMagnitude: 1.0 },
      { anomalyStatus: "anomalous", alertLevel: "Normal", triggeredMetrics: ["Heart Rate"] }
    );
    assert.equal(transientVital.stage, "anomalous_sensor_window");
    assert.equal(transientVital.anomalousWindow, true);
    assert.equal(transientVital.potentialFallAlert, false);
    assert.equal(transientVital.alertTriggered, false);
    assert.equal(transientVital.confirmedFallEvent, false);

    // 1b. Single-window fall impact cue before multi-window persistence completes
    const transientFall = classifyPrediction(
      { possibleFallDetected: true, movementStatus: "fall_suspect", accelMagnitude: 3.9 },
      {
        anomalyStatus: "anomalous",
        alertLevel: "Normal",
        triggeredMetrics: ["Movement (Experimental Fall Indicator)"],
      }
    );
    assert.equal(transientFall.stage, "potential_fall_alert");
    assert.equal(transientFall.anomalousWindow, true);
    assert.equal(transientFall.potentialFallAlert, true);
    assert.equal(transientFall.alertTriggered, false);
    assert.equal(transientFall.confirmedFallEvent, false);

    // 1c. Persistence-confirmed physiological alert WITHOUT fall kinematics
    const physAlert = classifyPrediction(
      { possibleFallDetected: false, movementStatus: "active", accelMagnitude: 1.3 },
      { anomalyStatus: "anomalous", alertLevel: "Warning", triggeredMetrics: ["Heart Rate"] }
    );
    assert.equal(physAlert.stage, "confirmed_physiological_alert");
    assert.equal(physAlert.alertTriggered, true);
    assert.equal(physAlert.confirmedFallEvent, false);

    // 1d. Persistence-confirmed fall event (Warning/Critical alert + fall/movement cue)
    const confirmedFall = classifyPrediction(
      { possibleFallDetected: true, movementStatus: "fall_suspect", accelMagnitude: 4.1 },
      {
        anomalyStatus: "anomalous",
        alertLevel: "Warning",
        triggeredMetrics: ["Movement (Experimental Fall Indicator)"],
      }
    );
    assert.equal(confirmedFall.stage, "confirmed_fall_event");
    assert.equal(confirmedFall.anomalousWindow, true);
    assert.equal(confirmedFall.potentialFallAlert, true);
    assert.equal(confirmedFall.alertTriggered, true);
    assert.equal(confirmedFall.confirmedFallEvent, true);
  });

  it("2. Evaluates persistence-aware alert metrics separately from raw anomalous windows and computes sample-level event detection", () => {
    const ev = new DatasetGroundTruthEvaluator();
    ev.configure({ labelGranularity: "sample_level", baselineIndependence: "no_baseline_trained" });

    // Frame 0: Normal ADL
    ev.recordFrameOutcome(
      false,
      { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good", triggeredMetrics: [] },
      { frameIndex: 0, telemetry: { possibleFallDetected: false, movementStatus: "resting", accelMagnitude: 1.0 } }
    );
    // Frame 1: Transient 1-window ADL spike (suppressed by warning persistence -> alertLevel=Normal)
    ev.recordFrameOutcome(
      false,
      { alertLevel: "Normal", anomalyStatus: "anomalous", signalQuality: "good", triggeredMetrics: ["Heart Rate"] },
      { frameIndex: 1, telemetry: { possibleFallDetected: false, movementStatus: "active", accelMagnitude: 1.4 } }
    );
    // Frame 2: Normal ADL
    ev.recordFrameOutcome(
      false,
      { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good", triggeredMetrics: [] },
      { frameIndex: 2, telemetry: { possibleFallDetected: false, movementStatus: "resting", accelMagnitude: 1.0 } }
    );
    // Frames 3..5: Sample-level ground-truth fall event (persistence=2 -> Frame 3 potential, Frames 4-5 confirmed)
    ev.recordFrameOutcome(
      true,
      {
        alertLevel: "Normal",
        anomalyStatus: "anomalous",
        signalQuality: "good",
        triggeredMetrics: ["Movement (Experimental Fall Indicator)"],
      },
      { frameIndex: 3, telemetry: { possibleFallDetected: true, movementStatus: "fall_suspect", accelMagnitude: 3.5 } }
    );
    ev.recordFrameOutcome(
      true,
      {
        alertLevel: "Warning",
        anomalyStatus: "anomalous",
        signalQuality: "good",
        triggeredMetrics: ["Movement (Experimental Fall Indicator)"],
      },
      { frameIndex: 4, telemetry: { possibleFallDetected: true, movementStatus: "fall_suspect", accelMagnitude: 4.2 } }
    );
    ev.recordFrameOutcome(
      true,
      {
        alertLevel: "Critical",
        anomalyStatus: "anomalous",
        signalQuality: "good",
        triggeredMetrics: ["Movement (Experimental Fall Indicator)"],
      },
      { frameIndex: 5, telemetry: { possibleFallDetected: true, movementStatus: "fall_suspect", accelMagnitude: 3.1 } }
    );
    // Frame 6: Unlabeled post-trial frame
    ev.recordFrameOutcome(
      null,
      { alertLevel: "Normal", anomalyStatus: "normal", signalQuality: "good", triggeredMetrics: [] },
      { frameIndex: 6 }
    );

    const summary = ev.getSummary();
    assert.equal(summary.hasGroundTruthLabels, true);
    assert.equal(summary.labelGranularity, "sample_level");
    assert.equal(summary.labeledCount, 6);
    assert.equal(summary.unlabeledCount, 1);

    // Alert-level metrics respect persistence: Frame 1 transient spike is NOT counted as FP!
    assert.equal(summary.metrics?.tp, 2);
    assert.equal(summary.metrics?.fp, 0);
    assert.equal(summary.metrics?.tn, 3);
    assert.equal(summary.metrics?.fn, 1);
    assert.equal(summary.metrics?.precision, 1);

    // Raw anomalous-window metrics separately show Frame 1 as FP and Frame 3 as TP
    assert.equal(summary.frameEvaluation?.anomalousWindow.tp, 3);
    assert.equal(summary.frameEvaluation?.anomalousWindow.fp, 1);
    assert.equal(summary.frameEvaluation?.anomalousWindow.tn, 2);
    assert.equal(summary.frameEvaluation?.anomalousWindow.fn, 0);

    // Confirmed fall event metrics
    assert.equal(summary.frameEvaluation?.confirmedFallEvent.tp, 2);
    assert.equal(summary.frameEvaluation?.confirmedFallEvent.fp, 0);
    assert.equal(summary.frameEvaluation?.counts.potentialFallAlertCount, 3);
    assert.equal(summary.frameEvaluation?.counts.confirmedFallEventCount, 2);

    // Event-level metrics detect the 1 contiguous GT fall event [3..5] without FP clusters
    assert.equal(summary.eventEvaluation.available, true);
    assert.equal(summary.eventEvaluation.groundTruthEventCount, 1);
    assert.equal(summary.eventEvaluation.alertEventMetrics?.tp, 1);
    assert.equal(summary.eventEvaluation.alertEventMetrics?.fp, 0);
    assert.equal(summary.eventEvaluation.alertEventMetrics?.fn, 0);
    assert.equal(summary.eventEvaluation.alertEventMetrics?.f1Score, 1);
    assert.equal(summary.eventEvaluation.confirmedFallEventMetrics?.tp, 1);
    assert.equal(summary.eventEvaluation.confirmedFallEventMetrics?.f1Score, 1);
  });

  it("3. Refuses baseline training on all-fall SisFall trial files and reports trial-level limitations honestly", async () => {
    // 25 normal-looking pre-fall walking rows inside an official trial-level F01 file (25 rows < 200 -> 25 frames)
    const rawLines = Array.from({ length: 25 }, () => "2, -1, 256, 20, -15, 10, 0, 1024, 0;");
    const recording = parseDatasetFile({
      datasetId: "sisfall",
      filename: "F01_SE06_R01.txt",
      content: rawLines.join("\n"),
    });

    assert.equal(recording.labelGranularity, "trial_level");

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, {
      prefitBaselineCount: 20,
      minBaselineSamples: 20,
    });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);
    assert.equal(loaded.provenance?.labelGranularity, "trial_level");
    assert.equal(loaded.provenance?.allFramesAnomalous, true);

    // Step all 25 frames — none may enter the baseline tracker or train Isolation Forest
    let lastSnap = loaded;
    for (let i = 0; i < 25; i++) {
      const stepped = await engine.step();
      lastSnap = stepped.snapshot;
      assert.equal(stepped.result?.analysis.modelTrained, false);
      assert.equal(stepped.result?.analysis.baselineProgress.collectedSamples, 0);
    }

    assert.equal(lastSnap.evaluation.labelGranularity, "trial_level");
    assert.equal(lastSnap.evaluation.baselineIndependence, "no_baseline_trained");
    assert.equal(lastSnap.evaluation.eventEvaluation.available, false);
    assert.match(lastSnap.evaluation.eventEvaluation.note, /trial-level filename labels/i);
    assert.ok(lastSnap.evaluation.limitationNote);
    assert.match(lastSnap.evaluation.limitationNote!, /baseline training was disabled/i);
  });

  it("4. Excludes same-recording baseline-training frames from metrics, marks non-independence, and preserves recording isolation", async () => {
    const csvRows = ["timestamp,ax,ay,az,gx,gy,gz,label"];
    for (let i = 0; i < 23; i++) {
      csvRows.push(`${(i * 0.2).toFixed(1)},0.01,-0.02,1.00,5.0,-3.0,2.0,adl`);
    }
    csvRows.push("4.6,2.30,1.90,1.80,320.0,240.0,190.0,fall");
    csvRows.push("4.8,2.40,1.95,1.85,350.0,260.0,200.0,fall");

    const recording = parseDatasetFile({
      datasetId: "sisfall",
      filename: "SE06_merged_eval_isolation.csv",
      content: csvRows.join("\n"),
    });
    assert.equal(recording.labelGranularity, "sample_level");

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, {
      prefitBaselineCount: 20,
      minBaselineSamples: 20,
    });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);

    let snap = loaded;
    for (let i = 0; i < 25; i++) {
      const stepped = await engine.step();
      snap = stepped.snapshot;
    }

    // 20 prefix frames used for prefitBaselineCount must be excluded from evaluation metrics (leaving 5 held-out frames: 3 adl + 2 fall)
    assert.equal(snap.evaluation.excludedBaselineTrainingCount, 20);
    assert.equal(snap.evaluation.labeledCount, 5);
    assert.equal(snap.evaluation.baselineIndependence, "within_recording_split_not_independent");
    assert.ok(snap.evaluation.limitationNote);
    assert.match(snap.evaluation.limitationNote!, /Non-independent same-recording baseline split/i);

    // Event-level detection on held-out frames detects the 1 fall event after 2-window persistence
    assert.equal(snap.evaluation.eventEvaluation.available, true);
    assert.equal(snap.evaluation.eventEvaluation.groundTruthEventCount, 1);
    assert.equal(snap.evaluation.eventEvaluation.confirmedFallEventMetrics?.tp, 1);

    // Participant + recording isolation remains intact
    assert.equal(sharedBaselineTracker.getProfile(loaded.playbackPatientKey!, "esp32_hardware"), null);
    assert.equal(sharedBaselineTracker.getProfile(loaded.playbackPatientKey!, "simulator"), null);
    assert.equal(sharedBaselineTracker.getProfile("ds_sisfall_SE06_D01", "dataset_playback"), null);
  });

  it("5. Handles missing ground-truth labels cleanly without inventing metrics", async () => {
    const csv = [
      "timestamp,ax,ay,az,gx,gy,gz",
      "0.0,0.01,0.00,1.00,2.0,1.0,0.5",
      "0.2,0.02,-0.01,1.01,2.5,1.2,0.4",
      "0.4,2.50,1.80,1.90,220.0,150.0,90.0",
    ].join("\n");

    const recording = parseDatasetFile({
      datasetId: "sisfall",
      filename: "unlabeled_imu_trace.csv",
      content: csv,
    });
    assert.equal(recording.hasGroundTruthLabels, false);
    assert.equal(recording.labelGranularity, "none");

    const engine = new DatasetPlaybackEngine();
    const loaded = await engine.loadRecording(recording, { prefitBaselineCount: 0 });
    assert.ok(loaded.playbackPatientKey);
    cleanupKeys.push(loaded.playbackPatientKey);

    let snap = loaded;
    for (let i = 0; i < 3; i++) {
      const res = await engine.step();
      snap = res.snapshot;
    }

    assert.equal(snap.evaluation.hasGroundTruthLabels, false);
    assert.equal(snap.evaluation.labelGranularity, "none");
    assert.equal(snap.evaluation.labeledCount, 0);
    assert.equal(snap.evaluation.unlabeledCount, 3);
    assert.equal(snap.evaluation.metrics, null);
    assert.equal(snap.evaluation.frameEvaluation, null);
    assert.equal(snap.evaluation.eventEvaluation.available, false);
  });
});
