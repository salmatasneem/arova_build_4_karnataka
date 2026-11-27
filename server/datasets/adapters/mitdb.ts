import { getDatasetCatalogEntry } from "../catalog.ts";
import { extractEcgFeatures } from "../../ecgProcessor.ts";
import {
  buildRelativeAndIsoTimestamp,
  checkUnsupportedBinaryOrArchive,
  findColumnIndex,
  inferSamplingRateHz,
  parseCsvWithHeaders,
  parseNullableNumber,
  parseTimeValueMs,
  sanitizeFilename,
} from "./csvUtils.ts";
import {
  DatasetValidationError,
  type DatasetAdapterInput,
  type NormalizedDatasetFrame,
  type ParsedDatasetRecording,
} from "./types.ts";

const NORMAL_BEAT_CODES = new Set(["n", "normal", "0", "false", "nsr"]);
const ANOMALOUS_BEAT_CODES = new Set([
  "v",
  "a",
  "l",
  "r",
  "/",
  "e",
  "f",
  "s",
  "j",
  "vf",
  "vt",
  "afib",
  "pvc",
  "pac",
  "1",
  "true",
  "arrhythmia",
  "abnormal",
  "anomalous",
]);

function parseMitdbLabel(raw: string | undefined): {
  label: string | null;
  isAnomalous: boolean | null;
} {
  if (!raw) return { label: null, isAnomalous: null };
  const cleaned = raw.replace(/^['"]+|['"]+$/g, "").trim();
  const norm = cleaned.toLowerCase();
  if (!norm || norm === "na" || norm === "null" || norm === "+" || norm === "~") {
    return { label: null, isAnomalous: null };
  }
  if (ANOMALOUS_BEAT_CODES.has(norm)) return { label: cleaned, isAnomalous: true };
  if (NORMAL_BEAT_CODES.has(norm)) return { label: cleaned, isAnomalous: false };
  return { label: cleaned, isAnomalous: null };
}

function downsampleForPayload(samples: number[], maxLen = 200): number[] {
  if (samples.length <= maxLen) return samples;
  const out: number[] = [];
  const step = samples.length / maxLen;
  for (let i = 0; i < maxLen; i++) {
    out.push(Number(samples[Math.floor(i * step)].toFixed(3)));
  }
  return out;
}

export function parseMitdbDataset(input: DatasetAdapterInput): ParsedDatasetRecording {
  const filename = sanitizeFilename(input.filename);
  checkUnsupportedBinaryOrArchive(filename, input.content);

  const catalog = getDatasetCatalogEntry("mitdb_arrhythmia")!;
  const recMatch = /(?:^|[^0-9])(\d{3})(?=[^0-9]|$)/.exec(filename);
  const participantId = input.participantId?.trim() || (recMatch ? `MITDB_${recMatch[1]}` : "MITDB_SUBJ");
  const recordId = input.recordId?.trim() || (recMatch ? `rec_${recMatch[1]}` : filename.replace(/\.[^.]+$/, ""));

  const table = parseCsvWithHeaders(input.content, filename);
  const timeIdx = findColumnIndex(table.headers, [
    "elapsed_time",
    "time_s",
    "time",
    "timestamp",
    "sample",
    "sample_index",
    "t",
  ]);
  const ecgIdx = findColumnIndex(table.headers, [
    "mlii",
    "ecg",
    "v5",
    "v1",
    "v2",
    "v4",
    "lead1",
    "val",
    "signal",
  ]);
  const labelIdx = findColumnIndex(table.headers, [
    "symbol",
    "annotation",
    "rhythm",
    "label",
    "beat_type",
    "ground_truth",
  ]);

  if (ecgIdx === -1) {
    throw new DatasetValidationError(
      `MIT-BIH CSV '${filename}' is missing an ECG lead column (expected MLII, ECG, V1, V2, V5, or val; found: ${table.rawHeaders.join(", ")}). Note: raw PhysioNet .dat/.hea files must be exported to CSV first.`,
      "MISSING_REQUIRED_COLUMNS"
    );
  }

  const parsedTimes = table.rows.map((r) => (timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null));
  const samplingRateHz = inferSamplingRateHz(parsedTimes, 360, 25, 1000);

  const rawEcg: number[] = [];
  const rawLabels: Array<{ label: string | null; isAnomalous: boolean | null }> = [];
  const validTimeList: Array<{ ms: number; isAbsoluteEpoch: boolean } | null> = [];

  for (let i = 0; i < table.rows.length; i++) {
    const val = parseNullableNumber(table.rows[i][ecgIdx]);
    if (val === null) continue;
    rawEcg.push(val);
    validTimeList.push(parsedTimes[i]);
    rawLabels.push(labelIdx !== -1 ? parseMitdbLabel(table.rows[i][labelIdx]) : { label: null, isAnomalous: null });
  }

  if (rawEcg.length < 10) {
    throw new DatasetValidationError(
      `MIT-BIH CSV '${filename}' has only ${rawEcg.length} valid ECG samples; at least 10 samples are required.`,
      "INSUFFICIENT_ECG_SAMPLES"
    );
  }

  const windowMs = Math.max(1000, Math.min(10000, input.windowMs ?? 3000));
  const targetSamplesPerWin = Math.max(25, Math.round((samplingRateHz * windowMs) / 1000));
  const samplesPerWin = Math.min(rawEcg.length, targetSamplesPerWin);
  const fallbackStepMs = Math.round(1000 / samplingRateHz);
  const frames: NormalizedDatasetFrame[] = [];

  for (let start = 0; start < rawEcg.length; start += samplesPerWin) {
    const chunk = rawEcg.slice(start, start + samplesPerWin);
    if (chunk.length < 10 && frames.length > 0) break;

    const chunkLabels = rawLabels.slice(start, start + chunk.length);
    const ecgFeatures = extractEcgFeatures({
      samples: chunk,
      samplingRateHz,
    });

    const hasAnomalous = chunkLabels.some((l) => l.isAnomalous === true);
    const hasNormal = chunkLabels.some((l) => l.isAnomalous === false);
    const groundTruthIsAnomalous = hasAnomalous ? true : hasNormal ? false : null;
    const groundTruthLabel =
      chunkLabels.find((l) => l.isAnomalous === true)?.label ??
      chunkLabels.find((l) => l.label !== null)?.label ??
      null;

    const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
      validTimeList,
      start,
      fallbackStepMs
    );

    const previewSamples = downsampleForPayload(chunk, 200);
    const derivedHr = ecgFeatures.estimatedEcgBpm;

    frames.push({
      frameIndex: frames.length,
      relativeOffsetMs,
      timestampIso,
      groundTruthLabel,
      groundTruthIsAnomalous,
      telemetry: {
        patientId: `ds_mitdb_${participantId}_${recordId}`,
        deviceId: `DATASET-MITDB-${participantId}`,
        timestamp: timestampIso,
        heartRate: derivedHr,
        spo2: null,
        temperatureC: null,
        movementStatus: "resting",
        accelMagnitude: 1.0,
        gyroMagnitude: 0.0,
        irSignalOk: true,
        fingerDetected: true,
        ecgSamples: previewSamples,
        ecgSamplingRate: samplingRateHz,
        ecgSignalQuality: ecgFeatures.signalQuality,
        ecgLeadOff: false,
        ecgTimestamp: timestampIso,
        ecgFeatures,
        source: "dataset_playback",
        availableModalities: {
          heartRate: derivedHr !== null,
          spo2: false,
          temperatureC: false,
          imu: false,
          ecg: true,
        },
        datasetContext: {
          datasetId: "mitdb_arrhythmia",
          recordId,
          groundTruthLabel,
          virtualTimestamp: timestampIso,
        },
      },
    });
  }

  const labeledFrameCount = frames.filter((f) => f.groundTruthIsAnomalous !== null).length;

  return {
    datasetId: "mitdb_arrhythmia",
    datasetName: catalog.name,
    sourcePlatform: catalog.sourcePlatform,
    participantId,
    recordId,
    originalFilename: filename,
    samplingRateHz,
    availableModalities: {
      heartRate: frames.some((f) => f.telemetry.heartRate !== null),
      spo2: false,
      temperatureC: false,
      imu: false,
      ecg: true,
    },
    temperatureSite: null,
    hasGroundTruthLabels: labeledFrameCount > 0,
    labelGranularity: labeledFrameCount > 0 ? "sample_level" : "none",
    labeledFrameCount,
    cohortNote: catalog.cohort.demographicsNote,
    includesElderly: catalog.cohort.includesElderly,
    allParticipantsElderly: false,
    provenanceNote: `Public research ECG recording (${catalog.name}, ${samplingRateHz} Hz) — NOT a SmartCare clinical patient. ${catalog.cohort.demographicsNote}`,
    warnings: [
      "MIT-BIH has no SpO2, temperature, or IMU channels; those modalities remain null and excluded from optical checks.",
    ],
    frames,
  };
}
