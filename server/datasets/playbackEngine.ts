import { analyzeTelemetry, fitPatientBaselineRemote, resetPatientMlRemote } from "../mlClient.ts";
import type {
  AvailableModalities,
  EcgSignalQuality,
  MlAnalysisResult,
  SleepStage,
  TelemetryPayload,
  TemperatureSite,
} from "../types.ts";
import type { GroundTruthGranularity, NormalizedDatasetFrame, ParsedDatasetRecording } from "./adapters/types.ts";
import {
  type BaselineIndependenceStatus,
  DatasetGroundTruthEvaluator,
  type GroundTruthEvaluationSummary,
} from "./evaluator.ts";

export type PlaybackStatus = "unloaded" | "ready" | "playing" | "paused" | "completed";

export interface PlaybackTelemetrySnapshot {
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  temperatureSite: TemperatureSite | null;
  respiratoryRateBpm: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  gyroX: number | null;
  gyroY: number | null;
  gyroZ: number | null;
  movementStatus: TelemetryPayload["movementStatus"];
  possibleFallDetected: boolean;
  sleepStage: SleepStage | null;
  ecgSamples?: number[];
  ecgSamplingRate?: number;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
}

export interface PlaybackFrameResult {
  frameIndex: number;
  relativeOffsetMs: number;
  timestampIso: string;
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
  telemetrySnapshot: PlaybackTelemetrySnapshot;
  analysis: MlAnalysisResult;
}

export interface DatasetProvenanceSummary {
  datasetId: string;
  datasetName: string;
  sourcePlatform: string;
  participantId: string;
  recordId: string;
  originalFilename: string;
  source: "dataset_playback";
  isClinicalPatient: false;
  samplingRateHz: number | null;
  startTimestampIso: string | null;
  endTimestampIso: string | null;
  durationMs: number;
  hasGroundTruthLabels: boolean;
  labelGranularity: GroundTruthGranularity;
  allFramesAnomalous: boolean;
  labeledFrameCount: number;
  availableModalities: AvailableModalities;
  temperatureSite: TemperatureSite | null;
  cohortNote: string;
  includesElderly: boolean;
  allParticipantsElderly: false;
  provenanceNote: string;
  warnings: string[];
}

export interface PlaybackStateSnapshot {
  status: PlaybackStatus;
  playbackPatientKey: string | null;
  currentRecordIndex: number;
  processedCount: number;
  totalRecords: number;
  speed: number;
  provenance: DatasetProvenanceSummary | null;
  lastResult: PlaybackFrameResult | null;
  recentResults: PlaybackFrameResult[];
  evaluation: GroundTruthEvaluationSummary;
}

export interface LoadRecordingOptions {
  speed?: number;
  prefitBaselineCount?: number;
  minBaselineSamples?: number;
}

export type TelemetryAnalyzeFn = typeof analyzeTelemetry;
export type BaselineFitFn = typeof fitPatientBaselineRemote;
export type BaselineResetFn = typeof resetPatientMlRemote;

export class DatasetPlaybackEngine {
  private recording: ParsedDatasetRecording | null = null;
  private playbackPatientKey: string | null = null;
  private status: PlaybackStatus = "unloaded";
  private currentIndex = 0;
  private speed = 1;
  private minBaselineSamples = 20;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlightStep: Promise<PlaybackFrameResult | null> | null = null;
  private recentResults: PlaybackFrameResult[] = [];
  private lastResult: PlaybackFrameResult | null = null;
  private readonly evaluator = new DatasetGroundTruthEvaluator();
  private prefitTrainingFrameIndices = new Set<number>();
  private onlineCandidateFrameIndices = new Set<number>();
  private baselineReadyFromOnline = false;
  private labelGranularity: GroundTruthGranularity = "none";
  private allFramesAnomalous = false;

  private readonly analyzeFn: TelemetryAnalyzeFn;
  private readonly fitFn: BaselineFitFn;
  private readonly resetFn: BaselineResetFn;

  constructor(deps?: {
    analyzeFn?: TelemetryAnalyzeFn;
    fitFn?: BaselineFitFn;
    resetFn?: BaselineResetFn;
  }) {
    this.analyzeFn = deps?.analyzeFn ?? analyzeTelemetry;
    this.fitFn = deps?.fitFn ?? fitPatientBaselineRemote;
    this.resetFn = deps?.resetFn ?? resetPatientMlRemote;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public async loadRecording(
    recording: ParsedDatasetRecording,
    options?: LoadRecordingOptions
  ): Promise<PlaybackStateSnapshot> {
    this.clearTimer();
    if (this.inFlightStep) {
      await this.inFlightStep.catch(() => undefined);
    }

    if (this.playbackPatientKey) {
      await this.resetFn(this.playbackPatientKey, "dataset_playback");
    }

    const playbackPatientKey = `ds_${recording.datasetId}_${recording.participantId}_${recording.recordId}`;
    await this.resetFn(playbackPatientKey, "dataset_playback");

    this.recording = {
      ...recording,
      frames: recording.frames.map((f) => ({
        ...f,
        telemetry: {
          ...f.telemetry,
          patientId: playbackPatientKey,
          source: "dataset_playback",
        },
      })),
    };
    this.playbackPatientKey = playbackPatientKey;
    this.currentIndex = 0;
    this.speed = this.clampSpeed(options?.speed ?? 1);
    this.minBaselineSamples = Math.max(5, Math.round(options?.minBaselineSamples ?? 20));
    this.recentResults = [];
    this.lastResult = null;
    this.prefitTrainingFrameIndices.clear();
    this.onlineCandidateFrameIndices.clear();
    this.baselineReadyFromOnline = false;

    this.labelGranularity =
      recording.labelGranularity ?? (recording.hasGroundTruthLabels ? "sample_level" : "none");
    this.allFramesAnomalous =
      this.recording.frames.length > 0 &&
      this.recording.frames.every((f) => f.groundTruthIsAnomalous === true);

    this.evaluator.reset();
    this.evaluator.configure({
      labelGranularity: this.labelGranularity,
      baselineIndependence: "no_baseline_trained",
      allFramesAnomalous: this.allFramesAnomalous,
    });
    this.status = this.recording.frames.length > 0 ? "ready" : "completed";

    const prefitCount = Math.max(0, Math.round(options?.prefitBaselineCount ?? 0));
    if (prefitCount > 0 && !this.allFramesAnomalous && this.recording.frames.length >= 5) {
      const candidateFrames = this.recording.frames
        .filter((f) => f.groundTruthIsAnomalous !== true)
        .slice(0, prefitCount);
      if (candidateFrames.length >= 5) {
        const samples = candidateFrames.map((f) => ({
          heartRate: f.telemetry.heartRate,
          spo2: f.telemetry.spo2,
          temperatureC: f.telemetry.temperatureC,
          accelMagnitude: f.telemetry.accelMagnitude,
          gyroMagnitude: f.telemetry.gyroMagnitude,
          movementStatus: f.telemetry.movementStatus,
          signalQuality: "good" as const,
          timestamp: f.timestampIso,
          ecgBpm: f.telemetry.ecgFeatures?.estimatedEcgBpm ?? null,
          ecgRriMs: f.telemetry.ecgFeatures?.rrIntervalMeanMs ?? null,
          ecgHrvMs: f.telemetry.ecgFeatures?.rrVariabilityMs ?? null,
          ecgSignalQuality: f.telemetry.ecgSignalQuality,
          ecgLeadOff: f.telemetry.ecgLeadOff,
          temperatureSite: f.telemetry.temperatureSite ?? this.recording!.temperatureSite,
        }));
        const fitResult = await this.fitFn(playbackPatientKey, samples, {
          source: "dataset_playback",
          minSamples: Math.min(this.minBaselineSamples, candidateFrames.length),
          availableModalities: this.recording.availableModalities,
          temperatureSite: this.recording.temperatureSite,
        });
        if (fitResult.trained || fitResult.baselineStatus === "ready") {
          for (const cf of candidateFrames) {
            this.prefitTrainingFrameIndices.add(cf.frameIndex);
          }
          const independence: BaselineIndependenceStatus = "within_recording_split_not_independent";
          this.evaluator.setBaselineIndependence(independence);
        }
      }
    }

    return this.getStatus();
  }

  private clampSpeed(rawSpeed: number): number {
    if (!Number.isFinite(rawSpeed) || rawSpeed <= 0) {
      throw new Error("Playback speed must be a positive finite number.");
    }
    return Math.max(0.25, Math.min(100, rawSpeed));
  }

  public start(): PlaybackStateSnapshot {
    if (!this.recording || this.recording.frames.length === 0) {
      throw new Error("No dataset recording is currently loaded for playback.");
    }
    if (this.status === "completed") {
      throw new Error("Playback has already completed. Call reset() before starting again.");
    }
    this.status = "playing";
    this.scheduleNextTick(0);
    return this.getStatus();
  }

  public pause(): PlaybackStateSnapshot {
    if (!this.recording) {
      throw new Error("No dataset recording is loaded.");
    }
    this.clearTimer();
    if (this.status === "playing") {
      this.status = "paused";
    }
    return this.getStatus();
  }

  public resume(): PlaybackStateSnapshot {
    if (!this.recording) {
      throw new Error("No dataset recording is loaded.");
    }
    if (this.status === "completed") {
      return this.getStatus();
    }
    this.status = "playing";
    this.scheduleNextTick(0);
    return this.getStatus();
  }

  public setSpeed(newSpeed: number): PlaybackStateSnapshot {
    this.speed = this.clampSpeed(newSpeed);
    if (this.status === "playing") {
      this.clearTimer();
      this.scheduleNextTick(this.computeNextDelayMs());
    }
    return this.getStatus();
  }

  public async reset(): Promise<PlaybackStateSnapshot> {
    this.clearTimer();
    if (this.inFlightStep) {
      await this.inFlightStep.catch(() => undefined);
    }
    if (this.playbackPatientKey) {
      await this.resetFn(this.playbackPatientKey, "dataset_playback");
    }
    this.currentIndex = 0;
    this.recentResults = [];
    this.lastResult = null;
    this.prefitTrainingFrameIndices.clear();
    this.onlineCandidateFrameIndices.clear();
    this.baselineReadyFromOnline = false;
    this.evaluator.reset();
    this.evaluator.configure({
      labelGranularity: this.labelGranularity,
      baselineIndependence: "no_baseline_trained",
      allFramesAnomalous: this.allFramesAnomalous,
    });
    this.status = this.recording && this.recording.frames.length > 0 ? "ready" : "unloaded";
    return this.getStatus();
  }

  public async step(): Promise<{ snapshot: PlaybackStateSnapshot; result: PlaybackFrameResult | null }> {
    if (!this.recording) {
      throw new Error("No dataset recording is loaded.");
    }
    this.clearTimer();
    if (this.status === "playing") {
      this.status = "paused";
    }
    const result = await this.executeCurrentFrame();
    return {
      snapshot: this.getStatus(),
      result,
    };
  }

  private computeNextDelayMs(): number {
    if (!this.recording || this.currentIndex >= this.recording.frames.length) return 0;
    if (this.currentIndex === 0) return 0;
    const prev = this.recording.frames[this.currentIndex - 1];
    const next = this.recording.frames[this.currentIndex];
    const deltaMs = Math.max(0, next.relativeOffsetMs - prev.relativeOffsetMs);
    return Math.max(5, Math.round(deltaMs / this.speed));
  }

  private scheduleNextTick(delayMs: number): void {
    this.clearTimer();
    if (this.status !== "playing" || !this.recording) return;
    if (this.currentIndex >= this.recording.frames.length) {
      this.status = "completed";
      return;
    }

    this.timer = setTimeout(async () => {
      if (this.status !== "playing") return;
      await this.executeCurrentFrame();
      if (this.status === "playing" && this.recording && this.currentIndex < this.recording.frames.length) {
        this.scheduleNextTick(this.computeNextDelayMs());
      } else if (this.recording && this.currentIndex >= this.recording.frames.length) {
        this.status = "completed";
      }
    }, delayMs);
  }

  private async executeCurrentFrame(): Promise<PlaybackFrameResult | null> {
    if (!this.recording || this.currentIndex >= this.recording.frames.length) {
      if (this.recording) this.status = "completed";
      return null;
    }

    if (this.inFlightStep) {
      return this.inFlightStep;
    }

    const frame: NormalizedDatasetFrame = this.recording.frames[this.currentIndex];
    const run = (async () => {
      const allowBaselineTraining =
        !this.allFramesAnomalous && frame.groundTruthIsAnomalous !== true;
      const wasBaselineReadyBefore =
        this.prefitTrainingFrameIndices.size > 0 || this.baselineReadyFromOnline;

      if (
        !wasBaselineReadyBefore &&
        allowBaselineTraining &&
        frame.telemetry.fingerDetected !== false &&
        frame.telemetry.irSignalOk !== false &&
        frame.telemetry.accelMagnitude <= 2.6
      ) {
        this.onlineCandidateFrameIndices.add(frame.frameIndex);
      }

      const payload = {
        ...frame.telemetry,
        allowBaselineTraining,
        policyConfig: {
          baselineMinSamples: this.minBaselineSamples,
          ...frame.telemetry.policyConfig,
        },
      };
      const analysis = await this.analyzeFn(payload);

      if (
        !wasBaselineReadyBefore &&
        (analysis.modelTrained || analysis.baselineProgress.status === "ready")
      ) {
        this.baselineReadyFromOnline = true;
        this.evaluator.setBaselineIndependence("within_recording_online_not_independent");
        this.evaluator.markFramesExcludedForBaselineTraining(this.onlineCandidateFrameIndices);
      }

      const usedForBaselineTraining =
        this.prefitTrainingFrameIndices.has(frame.frameIndex) ||
        (this.baselineReadyFromOnline && this.onlineCandidateFrameIndices.has(frame.frameIndex));

      this.evaluator.recordFrameOutcome(frame.groundTruthIsAnomalous, analysis, {
        frameIndex: frame.frameIndex,
        usedForBaselineTraining,
        telemetry: frame.telemetry,
      });

      const telemetrySnapshot: PlaybackTelemetrySnapshot = {
        heartRate: frame.telemetry.heartRate,
        spo2: frame.telemetry.spo2,
        temperatureC: frame.telemetry.temperatureC,
        temperatureSite: frame.telemetry.temperatureSite ?? this.recording!.temperatureSite ?? null,
        respiratoryRateBpm:
          typeof frame.telemetry.respiratoryRateBpm === "number"
            ? frame.telemetry.respiratoryRateBpm
            : null,
        accelMagnitude: frame.telemetry.accelMagnitude,
        gyroMagnitude: frame.telemetry.gyroMagnitude,
        accelX: typeof frame.telemetry.accelX === "number" ? frame.telemetry.accelX : null,
        accelY: typeof frame.telemetry.accelY === "number" ? frame.telemetry.accelY : null,
        accelZ: typeof frame.telemetry.accelZ === "number" ? frame.telemetry.accelZ : null,
        gyroX: typeof frame.telemetry.gyroX === "number" ? frame.telemetry.gyroX : null,
        gyroY: typeof frame.telemetry.gyroY === "number" ? frame.telemetry.gyroY : null,
        gyroZ: typeof frame.telemetry.gyroZ === "number" ? frame.telemetry.gyroZ : null,
        movementStatus: frame.telemetry.movementStatus,
        possibleFallDetected: Boolean(frame.telemetry.possibleFallDetected),
        sleepStage: frame.telemetry.sleepStage ?? null,
        ecgSamples: Array.isArray(frame.telemetry.ecgSamples)
          ? frame.telemetry.ecgSamples.slice(0, 720)
          : undefined,
        ecgSamplingRate: frame.telemetry.ecgSamplingRate,
        ecgSignalQuality: frame.telemetry.ecgSignalQuality,
        ecgLeadOff: frame.telemetry.ecgLeadOff,
      };

      const frameResult: PlaybackFrameResult = {
        frameIndex: frame.frameIndex,
        relativeOffsetMs: frame.relativeOffsetMs,
        timestampIso: frame.timestampIso,
        groundTruthLabel: frame.groundTruthLabel,
        groundTruthIsAnomalous: frame.groundTruthIsAnomalous,
        telemetrySnapshot,
        analysis,
      };

      this.currentIndex += 1;
      this.lastResult = frameResult;
      this.recentResults.push({
        ...frameResult,
        telemetrySnapshot: {
          ...frameResult.telemetrySnapshot,
          ecgSamples: undefined,
        },
      });
      if (this.recentResults.length > 100) {
        this.recentResults.shift();
      }
      if (this.recording && this.currentIndex >= this.recording.frames.length) {
        this.status = "completed";
        this.clearTimer();
      }
      return frameResult;
    })();

    this.inFlightStep = run;
    try {
      return await run;
    } finally {
      this.inFlightStep = null;
    }
  }

  public getStatus(): PlaybackStateSnapshot {
    const rec = this.recording;
    const firstFrame = rec && rec.frames.length > 0 ? rec.frames[0] : null;
    const lastFrame = rec && rec.frames.length > 0 ? rec.frames[rec.frames.length - 1] : null;
    const durationMs =
      firstFrame && lastFrame
        ? Math.max(0, lastFrame.relativeOffsetMs - firstFrame.relativeOffsetMs)
        : 0;

    return {
      status: this.status,
      playbackPatientKey: this.playbackPatientKey,
      currentRecordIndex: this.currentIndex,
      processedCount: this.currentIndex,
      totalRecords: rec ? rec.frames.length : 0,
      speed: this.speed,
      provenance: rec
        ? {
            datasetId: rec.datasetId,
            datasetName: rec.datasetName,
            sourcePlatform: rec.sourcePlatform,
            participantId: rec.participantId,
            recordId: rec.recordId,
            originalFilename: rec.originalFilename,
            source: "dataset_playback",
            isClinicalPatient: false,
            samplingRateHz: rec.samplingRateHz,
            startTimestampIso: firstFrame ? firstFrame.timestampIso : null,
            endTimestampIso: lastFrame ? lastFrame.timestampIso : null,
            durationMs,
            hasGroundTruthLabels: rec.hasGroundTruthLabels,
            labelGranularity: this.labelGranularity,
            allFramesAnomalous: this.allFramesAnomalous,
            labeledFrameCount: rec.labeledFrameCount,
            availableModalities: rec.availableModalities,
            temperatureSite: rec.temperatureSite,
            cohortNote: rec.cohortNote,
            includesElderly: rec.includesElderly,
            allParticipantsElderly: false,
            provenanceNote: rec.provenanceNote,
            warnings: rec.warnings,
          }
        : null,
      lastResult: this.lastResult,
      recentResults: [...this.recentResults],
      evaluation: this.evaluator.getSummary(),
    };
  }
}

export const sharedPlaybackEngine = new DatasetPlaybackEngine();
