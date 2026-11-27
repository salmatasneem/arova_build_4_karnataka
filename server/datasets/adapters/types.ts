import type { AvailableModalities, TelemetryPayload, TemperatureSite } from "../../types.ts";

export type SupportedAdapterDatasetId =
  | "sisfall"
  | "umafall"
  | "bidmc_ppg_respiration"
  | "mitdb_arrhythmia"
  | "ppg_dalia"
  | "wesad";

export class DatasetValidationError extends Error {
  public readonly statusCode = 400;
  public readonly code: string;
  public readonly details?: string[];

  constructor(message: string, code = "DATASET_VALIDATION_ERROR", details?: string[]) {
    super(message);
    this.name = "DatasetValidationError";
    this.code = code;
    this.details = details;
  }
}

export interface NormalizedDatasetFrame {
  frameIndex: number;
  relativeOffsetMs: number;
  timestampIso: string;
  telemetry: TelemetryPayload;
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
}

export type GroundTruthGranularity = "sample_level" | "trial_level" | "none";

export interface ParsedDatasetRecording {
  datasetId: SupportedAdapterDatasetId;
  datasetName: string;
  sourcePlatform: string;
  participantId: string;
  recordId: string;
  originalFilename: string;
  samplingRateHz: number | null;
  availableModalities: AvailableModalities;
  temperatureSite: TemperatureSite | null;
  hasGroundTruthLabels: boolean;
  labelGranularity?: GroundTruthGranularity;
  labeledFrameCount: number;
  cohortNote: string;
  includesElderly: boolean;
  allParticipantsElderly: false;
  provenanceNote: string;
  warnings: string[];
  frames: NormalizedDatasetFrame[];
}

export interface DatasetAdapterInput {
  datasetId: SupportedAdapterDatasetId;
  filename: string;
  content: string;
  participantId?: string;
  recordId?: string;
  windowMs?: number;
}

export interface DatasetAdapterSpec {
  datasetId: SupportedAdapterDatasetId;
  supportedExtensions: string[];
  expectedFormats: string[];
  requiredColumnsNote: string;
  optionalColumnsNote: string;
  conversionWorkflowNote: string;
}
