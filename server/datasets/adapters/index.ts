import { parseBidmcDataset } from "./bidmc.ts";
import { parseMitdbDataset } from "./mitdb.ts";
import { parsePpgDaliaOrWesadDataset } from "./ppgDaliaWesad.ts";
import { parseSisFallDataset } from "./sisfall.ts";
import { parseUmaFallDataset } from "./umafall.ts";
import {
  DatasetValidationError,
  type DatasetAdapterInput,
  type DatasetAdapterSpec,
  type ParsedDatasetRecording,
  type SupportedAdapterDatasetId,
} from "./types.ts";

export {
  DatasetValidationError,
  type DatasetAdapterInput,
  type DatasetAdapterSpec,
  type NormalizedDatasetFrame,
  type ParsedDatasetRecording,
  type SupportedAdapterDatasetId,
} from "./types.ts";

const SUPPORTED_ADAPTER_SPECS: DatasetAdapterSpec[] = [
  {
    datasetId: "sisfall",
    supportedExtensions: [".txt", ".csv"],
    expectedFormats: [
      "Official headerless 9-column raw ADC TXT (ADXL345 X,Y,Z; ITG3200 X,Y,Z; MMA8451Q X,Y,Z at 200 Hz)",
      "Converted CSV with headers: ax/ay/az (or adxl_x/y/z or acc_x/y/z), optional gx/gy/gz, timestamp/time_s, label/fall",
    ],
    requiredColumnsNote: "At least 6 numeric columns (raw TXT) or ax/ay/az (named CSV).",
    optionalColumnsNote: "gx/gy/gz, timestamp/time_s, label/fall/activity; filename codes (e.g. F01_SE06_R01.txt, D01_SA01_R01.txt) supply participant & fall/ADL ground truth.",
    conversionWorkflowNote: "Raw SisFall .txt files import directly with zero conversion.",
  },
  {
    datasetId: "umafall",
    supportedExtensions: [".csv", ".txt"],
    expectedFormats: [
      "Official UMAFall semicolon CSV (% metadata lines + TimeStamp; Sample No; X-Axis; Y-Axis; Z-Axis; Sensor Type; Sensor ID)",
      "Merged IMU CSV with headers: timestamp, ax/ay/az (or acc_x/y/z), optional gx/gy/gz, label/activity",
    ],
    requiredColumnsNote: "Either (TimeStamp, X-Axis, Y-Axis, Z-Axis, Sensor Type) or (ax, ay, az).",
    optionalColumnsNote: "gx/gy/gz gyroscope axes, label/activity, Subject_XX & Fall/ADL in filename.",
    conversionWorkflowNote: "Official UMAFall CSV logs import directly.",
  },
  {
    datasetId: "bidmc_ppg_respiration",
    supportedExtensions: [".csv"],
    expectedFormats: [
      "PhysioNet BIDMC 1 Hz Numerics CSV (Time [s], HR, PULSE, RESP, SpO2)",
      "PhysioNet BIDMC 125 Hz Signals CSV (Time [s], RESP, PLETH, V/II/ECG)",
    ],
    requiredColumnsNote: "At least one signal column (HR/PULSE, SpO2, RESP, or ECG/II/V) and recommended Time [s].",
    optionalColumnsNote: "Optional label/anomaly column; missing numeric values stay null without fabrication.",
    conversionWorkflowNote: "Use PhysioNet BIDMC CSV downloads directly; for raw WFDB .dat/.hea convert first via `wfdb.rdsamp` or PhysioNet LightWAVE Export as CSV.",
  },
  {
    datasetId: "mitdb_arrhythmia",
    supportedExtensions: [".csv"],
    expectedFormats: [
      "PhysioNet LightWAVE / wfdb.rdsamp CSV export (Elapsed time/time_s/sample + ECG channel MLII/V1/V2/V5/ECG + optional symbol/annotation)",
    ],
    requiredColumnsNote: "An ECG lead column (MLII, ECG, V1, V2, V5, or val) with >= 10 samples.",
    optionalColumnsNote: "time/Elapsed time (defaults to 360 Hz if omitted), beat annotation symbol column (N vs V/A/L/R/etc.).",
    conversionWorkflowNote: "Raw WFDB (.dat/.hea/.atr) binaries are NOT parsed directly in Node. Export via PhysioNet LightWAVE ('Export as CSV') or Python `wfdb.rdsamp` + `wfdb.rdann` before uploading CSV.",
  },
  {
    datasetId: "ppg_dalia",
    supportedExtensions: [".csv"],
    expectedFormats: [
      "Exported Empatica E4 / RespiBAN CSV (timestamp/time_s, hr/heart_rate, temp/skin_temp, acc_x/acc_y/acc_z or accel_magnitude, optional resp/activity)",
    ],
    requiredColumnsNote: "At least one signal column (hr/heart_rate, temp/skin_temp, acc_x/y/z or accel_magnitude, or resp).",
    optionalColumnsNote: "timestamp/time_s, activity, label.",
    conversionWorkflowNote: "Raw UCI .pkl files are NOT parsed in Node for safety. Export subject signals from Sx.pkl to CSV using pandas/numpy before importing.",
  },
  {
    datasetId: "wesad",
    supportedExtensions: [".csv"],
    expectedFormats: [
      "Exported WESAD Empatica E4 / RespiBAN CSV (timestamp/time_s, hr/heart_rate, temp/skin_temp, acc_x/acc_y/acc_z or accel_magnitude, optional resp, label)",
    ],
    requiredColumnsNote: "At least one signal column (hr/heart_rate, temp/skin_temp, acc_x/y/z or accel_magnitude, or resp).",
    optionalColumnsNote: "label/condition (0=transient, 1=baseline, 2=stress, 3=amusement, 4=meditation), timestamp/time_s.",
    conversionWorkflowNote: "Raw UCI WESAD .pkl files are NOT parsed in Node for safety. Export wrist/chest channels + synchronized labels to CSV in Python before importing.",
  },
];

export function getSupportedAdapterSpecs(): DatasetAdapterSpec[] {
  return SUPPORTED_ADAPTER_SPECS;
}

export function isSupportedAdapterDatasetId(id: string): id is SupportedAdapterDatasetId {
  return SUPPORTED_ADAPTER_SPECS.some((spec) => spec.datasetId === id);
}

export function parseDatasetFile(input: DatasetAdapterInput): ParsedDatasetRecording {
  if (!input.content || !input.content.trim()) {
    throw new DatasetValidationError("Uploaded dataset file content is empty.", "EMPTY_CONTENT");
  }

  switch (input.datasetId) {
    case "sisfall":
      return parseSisFallDataset(input);
    case "umafall":
      return parseUmaFallDataset(input);
    case "bidmc_ppg_respiration":
      return parseBidmcDataset(input);
    case "mitdb_arrhythmia":
      return parseMitdbDataset(input);
    case "ppg_dalia":
      return parsePpgDaliaOrWesadDataset("ppg_dalia", input);
    case "wesad":
      return parsePpgDaliaOrWesadDataset("wesad", input);
    default:
      throw new DatasetValidationError(
        `Dataset '${String(input.datasetId)}' does not have a CSV/TXT adapter in Stage 2 (supported: ${SUPPORTED_ADAPTER_SPECS.map((s) => s.datasetId).join(", ")}). Binary EDF/WFDB/PKL datasets require conversion to CSV first.`,
        "UNSUPPORTED_DATASET_ADAPTER"
      );
  }
}
