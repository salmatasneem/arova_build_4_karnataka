import type { MlAnalysisResult, TelemetryPayload } from "../types.ts";
import type { GroundTruthGranularity } from "./adapters/types.ts";

export interface GroundTruthConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
}

export interface EventEvaluationMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1Score: number;
  groundTruthEventCount: number;
  detectedEventCount: number;
  predictedEventCount: number;
}

export type BaselineIndependenceStatus =
  | "no_baseline_trained"
  | "within_recording_split_not_independent"
  | "within_recording_online_not_independent";

export interface FrameEvaluationBreakdown {
  alertLevel: GroundTruthConfusionMatrix;
  anomalousWindow: GroundTruthConfusionMatrix;
  confirmedFallEvent: GroundTruthConfusionMatrix;
  counts: {
    anomalousWindowCount: number;
    potentialFallAlertCount: number;
    alertTriggeredCount: number;
    confirmedFallEventCount: number;
  };
  metricDescriptions: {
    alertLevel: string;
    anomalousWindow: string;
    confirmedFallEvent: string;
  };
}

export interface EventEvaluationSummary {
  available: boolean;
  groundTruthEventCount: number;
  alertEventMetrics: EventEvaluationMetrics | null;
  confirmedFallEventMetrics: EventEvaluationMetrics | null;
  note: string;
}

export interface GroundTruthEvaluationSummary {
  hasGroundTruthLabels: boolean;
  labelGranularity: GroundTruthGranularity;
  baselineIndependence: BaselineIndependenceStatus;
  totalProcessedFrames: number;
  labeledCount: number;
  unlabeledCount: number;
  skippedPoorQualityCount: number;
  excludedBaselineTrainingCount: number;
  /** Primary frame-level evaluation: persistence-aware alert level (Warning / Critical). */
  metrics: GroundTruthConfusionMatrix | null;
  frameEvaluation: FrameEvaluationBreakdown | null;
  eventEvaluation: EventEvaluationSummary;
  limitationNote: string | null;
  note: string;
  disclaimer: string;
}

const EVALUATION_DISCLAIMER =
  "Evaluates SmartCare AI anomaly/alert output against dataset-provided event or protocol labels. This measures anomaly detection performance only and is not a clinically validated diagnosis.";

const METRIC_DESCRIPTIONS = {
  alertLevel:
    "Frame-level persistence-aware alert evaluation: positive only when alertLevel is Warning or Critical (suppresses single-window transient spikes awaiting warning persistence).",
  anomalousWindow:
    "Frame-level raw anomalous sensor window evaluation: positive whenever anomalyStatus is 'anomalous', including single-window transient outliers before persistence confirms an alert.",
  confirmedFallEvent:
    "Frame-level confirmed fall event evaluation: positive only when Warning/Critical alert persistence is met alongside an active fall/movement indicator.",
};

interface RecordedFrameEvaluation {
  frameIndex: number;
  groundTruthIsAnomalous: boolean | null;
  skippedPoorQuality: boolean;
  usedForBaselineTraining: boolean;
  anomalousWindow: boolean;
  potentialFallAlert: boolean;
  alertTriggered: boolean;
  confirmedFallEvent: boolean;
}

interface IndexInterval {
  start: number;
  end: number;
}

function buildMatrix(tp: number, fp: number, tn: number, fn: number): GroundTruthConfusionMatrix {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    tp,
    fp,
    tn,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1Score: Number(f1Score.toFixed(4)),
  };
}

function extractContiguousIntervals(
  entries: RecordedFrameEvaluation[],
  predicate: (e: RecordedFrameEvaluation) => boolean
): IndexInterval[] {
  const intervals: IndexInterval[] = [];
  let current: IndexInterval | null = null;
  for (const entry of entries) {
    if (predicate(entry)) {
      if (current && entry.frameIndex === current.end + 1) {
        current.end = entry.frameIndex;
      } else {
        if (current) intervals.push(current);
        current = { start: entry.frameIndex, end: entry.frameIndex };
      }
    } else if (current) {
      intervals.push(current);
      current = null;
    }
  }
  if (current) intervals.push(current);
  return intervals;
}

function intervalsOverlap(a: IndexInterval, b: IndexInterval): boolean {
  return a.start <= b.end && a.end >= b.start;
}

function computeEventMetrics(
  gtEvents: IndexInterval[],
  predEvents: IndexInterval[]
): EventEvaluationMetrics {
  const detectedGt = gtEvents.filter((gt) => predEvents.some((pred) => intervalsOverlap(gt, pred))).length;
  const unmatchedPred = predEvents.filter((pred) => !gtEvents.some((gt) => intervalsOverlap(gt, pred))).length;
  const tp = detectedGt;
  const fn = gtEvents.length - detectedGt;
  const fp = unmatchedPred;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    tp,
    fp,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1Score: Number(f1Score.toFixed(4)),
    groundTruthEventCount: gtEvents.length,
    detectedEventCount: detectedGt,
    predictedEventCount: predEvents.length,
  };
}

export class DatasetGroundTruthEvaluator {
  private entries: RecordedFrameEvaluation[] = [];
  private labelGranularity: GroundTruthGranularity = "sample_level";
  private baselineIndependence: BaselineIndependenceStatus = "no_baseline_trained";
  private allFramesAnomalous = false;

  public configure(options: {
    labelGranularity?: GroundTruthGranularity;
    baselineIndependence?: BaselineIndependenceStatus;
    allFramesAnomalous?: boolean;
  }): void {
    if (options.labelGranularity !== undefined) {
      this.labelGranularity = options.labelGranularity;
    }
    if (options.baselineIndependence !== undefined) {
      this.baselineIndependence = options.baselineIndependence;
    }
    if (options.allFramesAnomalous !== undefined) {
      this.allFramesAnomalous = options.allFramesAnomalous;
    }
  }

  public setBaselineIndependence(status: BaselineIndependenceStatus): void {
    this.baselineIndependence = status;
  }

  public markFramesExcludedForBaselineTraining(frameIndices: Iterable<number>): void {
    const idxSet = new Set(frameIndices);
    for (const entry of this.entries) {
      if (idxSet.has(entry.frameIndex)) {
        entry.usedForBaselineTraining = true;
      }
    }
  }

  public reset(): void {
    this.entries = [];
    this.labelGranularity = "sample_level";
    this.baselineIndependence = "no_baseline_trained";
    this.allFramesAnomalous = false;
  }

  public recordFrameOutcome(
    groundTruthIsAnomalous: boolean | null,
    analysis: Pick<MlAnalysisResult, "alertLevel" | "anomalyStatus" | "signalQuality"> &
      Partial<Pick<MlAnalysisResult, "triggeredMetrics" | "predictionClassification">>,
    options?: {
      frameIndex?: number;
      usedForBaselineTraining?: boolean;
      telemetry?: Pick<TelemetryPayload, "possibleFallDetected" | "movementStatus" | "accelMagnitude">;
    }
  ): void {
    const frameIndex = options?.frameIndex ?? this.entries.length;
    const isPoorQuality = analysis.anomalyStatus === "paused_poor_quality";
    const cls = analysis.predictionClassification;

    const anomalousWindow = cls
      ? cls.anomalousWindow
      : !isPoorQuality && analysis.anomalyStatus === "anomalous";
    const alertTriggered = cls
      ? cls.alertTriggered
      : !isPoorQuality && (analysis.alertLevel === "Warning" || analysis.alertLevel === "Critical");
    const hasFallCue =
      Boolean(options?.telemetry?.possibleFallDetected) ||
      options?.telemetry?.movementStatus === "fall_suspect" ||
      (typeof options?.telemetry?.accelMagnitude === "number" &&
        options.telemetry.accelMagnitude >= 2.8) ||
      Boolean(analysis.triggeredMetrics?.some((m) => /movement|fall/i.test(m)));
    const potentialFallAlert = cls ? cls.potentialFallAlert : !isPoorQuality && hasFallCue;
    const confirmedFallEvent = cls
      ? cls.confirmedFallEvent
      : !isPoorQuality && alertTriggered && hasFallCue;

    this.entries.push({
      frameIndex,
      groundTruthIsAnomalous,
      skippedPoorQuality: isPoorQuality,
      usedForBaselineTraining: Boolean(options?.usedForBaselineTraining),
      anomalousWindow,
      potentialFallAlert,
      alertTriggered,
      confirmedFallEvent,
    });
  }

  public getSummary(): GroundTruthEvaluationSummary {
    const totalProcessedFrames = this.entries.length;
    let unlabeledCount = 0;
    let skippedPoorQualityCount = 0;
    let excludedBaselineTrainingCount = 0;
    const scoredLabeled: RecordedFrameEvaluation[] = [];

    for (const e of this.entries) {
      if (e.groundTruthIsAnomalous === null) {
        unlabeledCount += 1;
        continue;
      }
      if (e.usedForBaselineTraining) {
        excludedBaselineTrainingCount += 1;
        continue;
      }
      if (e.skippedPoorQuality) {
        skippedPoorQualityCount += 1;
        continue;
      }
      scoredLabeled.push(e);
    }

    const labeledCount = scoredLabeled.length;
    const effectiveGranularity: GroundTruthGranularity =
      totalProcessedFrames === 0
        ? this.labelGranularity
        : labeledCount === 0 && excludedBaselineTrainingCount === 0 && unlabeledCount === totalProcessedFrames
        ? "none"
        : this.labelGranularity;

    const limitationParts: string[] = [];
    if (effectiveGranularity === "trial_level") {
      limitationParts.push(
        "Trial-level labels only: every frame inherits the recording filename label without fall onset/offset timestamps, so frame-level evaluation is limited (pre-fall and post-fall normal windows inside fall files register as FN) and event-level boundaries are unavailable."
      );
    }
    if (this.allFramesAnomalous) {
      limitationParts.push(
        "All labeled frames in this recording are marked anomalous/fall; baseline training was disabled so the detector is never fitted on fall-only data."
      );
    }
    if (this.baselineIndependence === "within_recording_split_not_independent") {
      limitationParts.push(
        `Non-independent same-recording baseline split: ${excludedBaselineTrainingCount} normal prefix frames used to fit the baseline are excluded from evaluation metrics, and remaining frames from the same recording do not represent independent cross-trial validation.`
      );
    } else if (this.baselineIndependence === "within_recording_online_not_independent") {
      limitationParts.push(
        `Non-independent online baseline learning: ${excludedBaselineTrainingCount} normal frames consumed to fit the baseline during playback are excluded from metrics, and remaining frames come from the same recording.`
      );
    }
    const limitationNote = limitationParts.length > 0 ? limitationParts.join(" ") : null;

    if (labeledCount === 0) {
      let note: string;
      if (excludedBaselineTrainingCount > 0 && skippedPoorQualityCount === 0) {
        note = `All ${excludedBaselineTrainingCount} labeled frames processed so far were used for baseline training and excluded from evaluation metrics.`;
      } else if (skippedPoorQualityCount > 0) {
        note = `No scored labeled frames yet (${skippedPoorQualityCount} paused due to signal quality, ${excludedBaselineTrainingCount} excluded baseline-training frames).`;
      } else {
        note =
          "Ground-truth labels are unavailable for processed frames; precision, recall, and F1 are omitted.";
      }

      return {
        hasGroundTruthLabels: false,
        labelGranularity: effectiveGranularity,
        baselineIndependence: this.baselineIndependence,
        totalProcessedFrames,
        labeledCount: 0,
        unlabeledCount,
        skippedPoorQualityCount,
        excludedBaselineTrainingCount,
        metrics: null,
        frameEvaluation: null,
        eventEvaluation: {
          available: false,
          groundTruthEventCount: 0,
          alertEventMetrics: null,
          confirmedFallEventMetrics: null,
          note:
            effectiveGranularity === "trial_level"
              ? "Event-level evaluation is unavailable because only trial-level filename labels are provided without onset/offset timestamps."
              : "Event-level evaluation requires scored sample-level labeled frames.",
        },
        limitationNote,
        note,
        disclaimer: EVALUATION_DISCLAIMER,
      };
    }

    let alertTp = 0;
    let alertFp = 0;
    let alertTn = 0;
    let alertFn = 0;

    let winTp = 0;
    let winFp = 0;
    let winTn = 0;
    let winFn = 0;

    let fallTp = 0;
    let fallFp = 0;
    let fallTn = 0;
    let fallFn = 0;

    let anomalousWindowCount = 0;
    let potentialFallAlertCount = 0;
    let alertTriggeredCount = 0;
    let confirmedFallEventCount = 0;

    for (const e of scoredLabeled) {
      const gt = Boolean(e.groundTruthIsAnomalous);

      if (e.anomalousWindow) anomalousWindowCount += 1;
      if (e.potentialFallAlert) potentialFallAlertCount += 1;
      if (e.alertTriggered) alertTriggeredCount += 1;
      if (e.confirmedFallEvent) confirmedFallEventCount += 1;

      if (gt && e.alertTriggered) alertTp += 1;
      else if (!gt && e.alertTriggered) alertFp += 1;
      else if (!gt && !e.alertTriggered) alertTn += 1;
      else alertFn += 1;

      if (gt && e.anomalousWindow) winTp += 1;
      else if (!gt && e.anomalousWindow) winFp += 1;
      else if (!gt && !e.anomalousWindow) winTn += 1;
      else winFn += 1;

      if (gt && e.confirmedFallEvent) fallTp += 1;
      else if (!gt && e.confirmedFallEvent) fallFp += 1;
      else if (!gt && !e.confirmedFallEvent) fallTn += 1;
      else fallFn += 1;
    }

    const alertMatrix = buildMatrix(alertTp, alertFp, alertTn, alertFn);
    const windowMatrix = buildMatrix(winTp, winFp, winTn, winFn);
    const confirmedFallMatrix = buildMatrix(fallTp, fallFp, fallTn, fallFn);

    let eventEvaluation: EventEvaluationSummary;
    if (effectiveGranularity !== "sample_level") {
      eventEvaluation = {
        available: false,
        groundTruthEventCount: 0,
        alertEventMetrics: null,
        confirmedFallEventMetrics: null,
        note: "Event-level evaluation is unavailable because this dataset provides trial-level filename labels only without genuine fall onset/offset timestamps.",
      };
    } else {
      const gtEvents = extractContiguousIntervals(scoredLabeled, (e) => Boolean(e.groundTruthIsAnomalous));
      if (gtEvents.length === 0) {
        const alertPredCount = extractContiguousIntervals(scoredLabeled, (e) => e.alertTriggered).length;
        eventEvaluation = {
          available: false,
          groundTruthEventCount: 0,
          alertEventMetrics: null,
          confirmedFallEventMetrics: null,
          note:
            alertPredCount > 0
              ? `No positive ground-truth events occurred in the evaluated labeled frames (${alertPredCount} false-positive alert event cluster${alertPredCount === 1 ? "" : "s"}).`
              : "No positive ground-truth events occurred in the evaluated labeled frames.",
        };
      } else {
        const predAlertEvents = extractContiguousIntervals(scoredLabeled, (e) => e.alertTriggered);
        const predConfirmedFallEvents = extractContiguousIntervals(
          scoredLabeled,
          (e) => e.confirmedFallEvent
        );
        eventEvaluation = {
          available: true,
          groundTruthEventCount: gtEvents.length,
          alertEventMetrics: computeEventMetrics(gtEvents, predAlertEvents),
          confirmedFallEventMetrics: computeEventMetrics(gtEvents, predConfirmedFallEvents),
          note: `Event-level evaluation across ${gtEvents.length} contiguous ground-truth event${gtEvents.length === 1 ? "" : "s"} (an event counts as detected when overlapped by at least one persistence-confirmed alert/fall window).`,
        };
      }
    }

    const excludedNote =
      excludedBaselineTrainingCount > 0
        ? `, ${excludedBaselineTrainingCount} excluded baseline-training`
        : "";

    return {
      hasGroundTruthLabels: true,
      labelGranularity: effectiveGranularity,
      baselineIndependence: this.baselineIndependence,
      totalProcessedFrames,
      labeledCount,
      unlabeledCount,
      skippedPoorQualityCount,
      excludedBaselineTrainingCount,
      metrics: alertMatrix,
      frameEvaluation: {
        alertLevel: alertMatrix,
        anomalousWindow: windowMatrix,
        confirmedFallEvent: confirmedFallMatrix,
        counts: {
          anomalousWindowCount,
          potentialFallAlertCount,
          alertTriggeredCount,
          confirmedFallEventCount,
        },
        metricDescriptions: METRIC_DESCRIPTIONS,
      },
      eventEvaluation,
      limitationNote,
      note: `Computed from ${labeledCount} scored labeled frames (${unlabeledCount} unlabeled, ${skippedPoorQualityCount} skipped poor quality${excludedNote}).`,
      disclaimer: EVALUATION_DISCLAIMER,
    };
  }
}
