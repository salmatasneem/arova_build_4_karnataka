import { getDatasetCatalogEntry } from "../catalog.ts";
import { extractEcgFeatures } from "../../ecgProcessor.ts";
import {
  buildRelativeAndIsoTimestamp,
  checkUnsupportedBinaryOrArchive,
  findColumnIndex,
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

function parseBidmcParticipant(filename: string): string | null {
  const m = /bidmc[_-]?(\d{2})/i.exec(filename);
  return m ? `BIDMC_${m[1]}` : null;
}

function parseOptionalAnomalyLabel(raw: string | undefined): {
  label: string | null;
  isAnomalous: boolean | null;
} {
  if (!raw) return { label: null, isAnomalous: null };
  const norm = raw.trim().toLowerCase();
  if (!norm || norm === "na" || norm === "null") return { label: null, isAnomalous: null };
  if (norm === "1" || norm === "true" || norm === "abnormal" || norm === "anomalous" || norm === "desat") {
    return { label: raw.trim(), isAnomalous: true };
  }
  if (norm === "0" || norm === "false" || norm === "normal" || norm === "baseline") {
    return { label: raw.trim(), isAnomalous: false };
  }
  return { label: raw.trim(), isAnomalous: null };
}

export function parseBidmcDataset(input: DatasetAdapterInput): ParsedDatasetRecording {
  const filename = sanitizeFilename(input.filename);
  checkUnsupportedBinaryOrArchive(filename, input.content);

  const catalog = getDatasetCatalogEntry("bidmc_ppg_respiration")!;
  const participantId = input.participantId?.trim() || parseBidmcParticipant(filename) || "BIDMC_SUBJ";
  const recordId = input.recordId?.trim() || filename.replace(/\.[^.]+$/, "");

  const table = parseCsvWithHeaders(input.content, filename);
  const timeIdx = findColumnIndex(table.headers, ["time_s", "time", "timestamp", "elapsed_time", "t"]);
  const hrIdx = findColumnIndex(table.headers, ["hr", "heart_rate", "pulse"]);
  const spo2Idx = findColumnIndex(table.headers, ["spo2", "spo2_pct", "o2sat"]);
  const respIdx = findColumnIndex(table.headers, ["resp", "respiration", "rr", "respiratory_rate"]);
  const ecgIdx = findColumnIndex(table.headers, ["ecg", "ii", "v", "avr", "mlii"]);
  const labelIdx = findColumnIndex(table.headers, ["label", "anomaly", "ground_truth"]);

  if (hrIdx === -1 && spo2Idx === -1 && respIdx === -1 && ecgIdx === -1) {
    throw new DatasetValidationError(
      `BIDMC CSV '${filename}' is missing required signal columns (expected HR/PULSE, SpO2, RESP, or ECG/II/V; found: ${table.rawHeaders.join(", ")}).`,
      "MISSING_REQUIRED_COLUMNS"
    );
  }

  const warnings: string[] = [];
  const parsedTimes = table.rows.map((r) => (timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null));
  let inferredRateHz = 1;
  if (parsedTimes.length >= 2 && parsedTimes[0] && parsedTimes[1]) {
    const dt = parsedTimes[1].ms - parsedTimes[0].ms;
    if (dt > 0) inferredRateHz = Math.max(1, Math.round(1000 / dt));
  }

  // If high-rate Signals CSV (e.g. 125 Hz ECG without numeric HR/SpO2), aggregate into 1s frames
  const isSignalsWaveformCsv = ecgIdx !== -1 && hrIdx === -1 && spo2Idx === -1 && inferredRateHz >= 25;
  const frames: NormalizedDatasetFrame[] = [];

  if (isSignalsWaveformCsv) {
    const samplesPerSec = Math.max(25, inferredRateHz);
    for (let start = 0; start < table.rows.length; start += samplesPerSec) {
      const end = Math.min(table.rows.length, start + samplesPerSec);
      const ecgChunk: number[] = [];
      const respChunk: number[] = [];
      for (let i = start; i < end; i++) {
        const e = parseNullableNumber(table.rows[i][ecgIdx]);
        if (e !== null) ecgChunk.push(e);
        if (respIdx !== -1) {
          const rv = parseNullableNumber(table.rows[i][respIdx]);
          if (rv !== null) respChunk.push(rv);
        }
      }
      const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
        parsedTimes,
        start,
        1000
      );
      const ecgFeatures = extractEcgFeatures({
        samples: ecgChunk,
        samplingRateHz: inferredRateHz,
      });
      const lbl = labelIdx !== -1 ? parseOptionalAnomalyLabel(table.rows[start][labelIdx]) : { label: null, isAnomalous: null };

      frames.push({
        frameIndex: frames.length,
        relativeOffsetMs,
        timestampIso,
        groundTruthLabel: lbl.label,
        groundTruthIsAnomalous: lbl.isAnomalous,
        telemetry: {
          patientId: `ds_bidmc_${participantId}_${recordId}`,
          deviceId: `DATASET-BIDMC-${participantId}`,
          timestamp: timestampIso,
          heartRate: ecgFeatures.estimatedEcgBpm,
          spo2: null,
          temperatureC: null,
          movementStatus: "resting",
          accelMagnitude: 1.0,
          gyroMagnitude: 0.0,
          irSignalOk: true,
          fingerDetected: true,
          ecgSamples: ecgChunk.slice(0, 200),
          ecgSamplingRate: inferredRateHz,
          ecgSignalQuality: ecgFeatures.signalQuality,
          ecgLeadOff: false,
          ecgFeatures,
          source: "dataset_playback",
          availableModalities: {
            heartRate: ecgFeatures.estimatedEcgBpm !== null,
            spo2: false,
            temperatureC: false,
            imu: false,
            ecg: true,
            respiratoryRate: false,
          },
          datasetContext: {
            datasetId: "bidmc_ppg_respiration",
            recordId,
            groundTruthLabel: lbl.label,
            virtualTimestamp: timestampIso,
          },
        },
      });
    }
    warnings.push("Imported BIDMC waveform CSV; HR derived per 1s window from ECG channel, SpO2 absent in waveform file.");
  } else {
    let anyHr = false;
    let anySpo2 = false;
    let anyResp = false;

    for (let i = 0; i < table.rows.length; i++) {
      const r = table.rows[i];
      const hr = hrIdx !== -1 ? parseNullableNumber(r[hrIdx]) : null;
      const spo2 = spo2Idx !== -1 ? parseNullableNumber(r[spo2Idx]) : null;
      const resp = respIdx !== -1 ? parseNullableNumber(r[respIdx]) : null;

      if (hr === null && spo2 === null && resp === null) continue;
      if (hr !== null) anyHr = true;
      if (spo2 !== null) anySpo2 = true;
      if (resp !== null) anyResp = true;

      const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
        parsedTimes,
        i,
        1000
      );
      const lbl = labelIdx !== -1 ? parseOptionalAnomalyLabel(r[labelIdx]) : { label: null, isAnomalous: null };

      frames.push({
        frameIndex: frames.length,
        relativeOffsetMs,
        timestampIso,
        groundTruthLabel: lbl.label,
        groundTruthIsAnomalous: lbl.isAnomalous,
        telemetry: {
          patientId: `ds_bidmc_${participantId}_${recordId}`,
          deviceId: `DATASET-BIDMC-${participantId}`,
          timestamp: timestampIso,
          heartRate: hr,
          spo2,
          temperatureC: null,
          movementStatus: "resting",
          accelMagnitude: 1.0,
          gyroMagnitude: 0.0,
          irSignalOk: hr !== null || spo2 !== null,
          fingerDetected: hr !== null || spo2 !== null,
          respiratoryRateBpm: resp,
          source: "dataset_playback",
          availableModalities: {
            heartRate: hr !== null,
            spo2: spo2 !== null,
            temperatureC: false,
            imu: false,
            ecg: false,
            respiratoryRate: resp !== null,
          },
          datasetContext: {
            datasetId: "bidmc_ppg_respiration",
            recordId,
            groundTruthLabel: lbl.label,
            virtualTimestamp: timestampIso,
          },
        },
      });
    }

    if (frames.length === 0) {
      throw new DatasetValidationError(
        `BIDMC CSV '${filename}' contained no valid numeric vital rows.`,
        "NO_VALID_SAMPLES"
      );
    }

    if (!anySpo2) warnings.push("SpO2 column missing or all null in this BIDMC CSV.");
    if (!anyHr) warnings.push("HR/PULSE column missing or all null in this BIDMC CSV.");
    if (!anyResp) warnings.push("RESP column missing or all null in this BIDMC CSV.");
  }

  const anyHrAvail = frames.some((f) => f.telemetry.availableModalities?.heartRate);
  const anySpo2Avail = frames.some((f) => f.telemetry.availableModalities?.spo2);
  const anyRespAvail = frames.some((f) => f.telemetry.availableModalities?.respiratoryRate);
  const anyEcgAvail = frames.some((f) => f.telemetry.availableModalities?.ecg);
  const labeledFrameCount = frames.filter((f) => f.groundTruthIsAnomalous !== null).length;

  return {
    datasetId: "bidmc_ppg_respiration",
    datasetName: catalog.name,
    sourcePlatform: catalog.sourcePlatform,
    participantId,
    recordId,
    originalFilename: filename,
    samplingRateHz: inferredRateHz,
    availableModalities: {
      heartRate: anyHrAvail,
      spo2: anySpo2Avail,
      temperatureC: false,
      imu: false,
      ecg: anyEcgAvail,
      respiratoryRate: anyRespAvail,
    },
    temperatureSite: null,
    hasGroundTruthLabels: labeledFrameCount > 0,
    labelGranularity: labeledFrameCount > 0 ? "sample_level" : "none",
    labeledFrameCount,
    cohortNote: catalog.cohort.demographicsNote,
    includesElderly: catalog.cohort.includesElderly,
    allParticipantsElderly: false,
    provenanceNote: `Public research recording (${catalog.name}) — NOT a SmartCare clinical patient. ${catalog.cohort.demographicsNote}`,
    warnings,
    frames,
  };
}
