import { getDatasetCatalogEntry } from "../catalog.ts";
import type { MovementStatus } from "../../types.ts";
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

function parseWesadOrDaliaLabel(
  datasetId: "ppg_dalia" | "wesad",
  rawLabel: string | undefined,
  rawActivity: string | undefined
): {
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
  movementStatus: MovementStatus;
} {
  const act = (rawActivity ?? "").trim().toLowerCase();
  let movementStatus: MovementStatus = "resting";
  if (act.includes("walk") || act.includes("ascending")) movementStatus = "walking";
  else if (act.includes("stair") || act.includes("cycl") || act.includes("soccer") || act.includes("active")) {
    movementStatus = "active";
  }

  const raw = (rawLabel ?? "").trim();
  const norm = raw.toLowerCase();
  if (!norm || norm === "na" || norm === "null") {
    return { groundTruthLabel: rawActivity?.trim() || null, groundTruthIsAnomalous: null, movementStatus };
  }

  if (datasetId === "wesad") {
    // Official WESAD protocol labels: 0=transient/not defined, 1=baseline, 2=stress, 3=amusement, 4=meditation
    if (norm === "2" || norm === "stress" || norm === "anomalous" || norm === "abnormal") {
      return { groundTruthLabel: "stress", groundTruthIsAnomalous: true, movementStatus };
    }
    if (norm === "1" || norm === "baseline" || norm === "normal") {
      return { groundTruthLabel: "baseline", groundTruthIsAnomalous: false, movementStatus };
    }
    if (norm === "3" || norm === "amusement") {
      return { groundTruthLabel: "amusement", groundTruthIsAnomalous: false, movementStatus };
    }
    if (norm === "4" || norm === "meditation") {
      return { groundTruthLabel: "meditation", groundTruthIsAnomalous: false, movementStatus };
    }
    if (norm === "0" || norm === "transient" || norm === "undefined") {
      return { groundTruthLabel: "transient", groundTruthIsAnomalous: null, movementStatus };
    }
    return { groundTruthLabel: raw, groundTruthIsAnomalous: null, movementStatus };
  }

  // PPG-DaLiA activity codes or optional anomaly column
  if (norm === "anomalous" || norm === "abnormal" || norm === "true" || norm === "1_anomaly") {
    return { groundTruthLabel: raw, groundTruthIsAnomalous: true, movementStatus };
  }
  if (norm === "normal" || norm === "baseline") {
    return { groundTruthLabel: raw, groundTruthIsAnomalous: false, movementStatus };
  }
  if (norm.includes("walk")) movementStatus = "walking";
  else if (norm.includes("stair") || norm.includes("cycl") || norm.includes("soccer")) movementStatus = "active";

  return { groundTruthLabel: raw, groundTruthIsAnomalous: null, movementStatus };
}

export function parsePpgDaliaOrWesadDataset(
  datasetId: "ppg_dalia" | "wesad",
  input: DatasetAdapterInput
): ParsedDatasetRecording {
  const filename = sanitizeFilename(input.filename);
  checkUnsupportedBinaryOrArchive(filename, input.content);

  const catalog = getDatasetCatalogEntry(datasetId)!;
  const subjMatch = /(?:^|[^a-zA-Z0-9])(S\d{1,2})(?=[^a-zA-Z0-9]|$)/i.exec(filename);
  const defaultPrefix = datasetId === "wesad" ? "WESAD" : "PPGDALIA";
  const participantId = input.participantId?.trim() || (subjMatch ? `${defaultPrefix}_${subjMatch[1].toUpperCase()}` : `${defaultPrefix}_SUBJ`);
  const recordId = input.recordId?.trim() || filename.replace(/\.[^.]+$/, "");

  const table = parseCsvWithHeaders(input.content, filename);
  const timeIdx = findColumnIndex(table.headers, ["timestamp", "time_s", "time", "elapsed_s", "t"]);
  const hrIdx = findColumnIndex(table.headers, ["hr", "heart_rate", "heart_rate_bpm", "bpm"]);
  const tempIdx = findColumnIndex(table.headers, ["temp", "temperature", "temperature_c", "skin_temp", "e4_temp"]);
  const axIdx = findColumnIndex(table.headers, ["acc_x", "ax", "accel_x"]);
  const ayIdx = findColumnIndex(table.headers, ["acc_y", "ay", "accel_y"]);
  const azIdx = findColumnIndex(table.headers, ["acc_z", "az", "accel_z"]);
  const accelMagIdx = findColumnIndex(table.headers, ["accel_magnitude", "acc_mag"]);
  const respIdx = findColumnIndex(table.headers, ["resp", "respiration", "respiratory_rate"]);
  const labelIdx = findColumnIndex(table.headers, ["label", "condition", "ground_truth"]);
  const activityIdx = findColumnIndex(table.headers, ["activity", "activity_id", "movement"]);

  const hasAnySignalCol =
    hrIdx !== -1 ||
    tempIdx !== -1 ||
    accelMagIdx !== -1 ||
    (axIdx !== -1 && ayIdx !== -1 && azIdx !== -1) ||
    respIdx !== -1;

  if (!hasAnySignalCol) {
    throw new DatasetValidationError(
      `${catalog.name} CSV '${filename}' is missing required signal columns (expected at least one of hr/heart_rate, temp/skin_temp, acc_x/y/z or accel_magnitude, or resp; found: ${table.rawHeaders.join(", ")}). Note: raw UCI .pkl archives must be exported to CSV in Python first.`,
      "MISSING_REQUIRED_COLUMNS"
    );
  }

  const parsedTimes = table.rows.map((r) => (timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null));
  let samplingRateHz = 4;
  if (parsedTimes.length >= 2 && parsedTimes[0] && parsedTimes[1]) {
    const dt = parsedTimes[1].ms - parsedTimes[0].ms;
    if (dt > 0) samplingRateHz = Math.max(1, Math.round(1000 / dt));
  }

  // Detect Empatica E4 raw 1/64g integer accel scale if axes are provided
  let e4AccelScale = 1.0;
  if (axIdx !== -1 && ayIdx !== -1 && azIdx !== -1) {
    const sampleMags: number[] = [];
    for (let i = 0; i < Math.min(table.rows.length, 25); i++) {
      const r = table.rows[i];
      const ax = parseNullableNumber(r[axIdx]);
      const ay = parseNullableNumber(r[ayIdx]);
      const az = parseNullableNumber(r[azIdx]);
      if (ax !== null && ay !== null && az !== null) {
        sampleMags.push(Math.sqrt(ax * ax + ay * ay + az * az));
      }
    }
    const med = sampleMags.length > 0 ? sampleMags[Math.floor(sampleMags.length / 2)] : 1;
    if (med > 20) e4AccelScale = 1.0 / 64.0;
  }

  const warnings: string[] = [];
  if (e4AccelScale < 1) {
    warnings.push("Detected Empatica E4 1/64g accelerometer counts; converted to g units.");
  }

  const frames: NormalizedDatasetFrame[] = [];
  const fallbackStepMs = Math.round(1000 / samplingRateHz);

  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i];
    const hr = hrIdx !== -1 ? parseNullableNumber(r[hrIdx]) : null;
    const temp = tempIdx !== -1 ? parseNullableNumber(r[tempIdx]) : null;
    const resp = respIdx !== -1 ? parseNullableNumber(r[respIdx]) : null;

    let ax: number | null = null;
    let ay: number | null = null;
    let az: number | null = null;
    let accelMagnitude = 1.0;
    let hasImuRow = false;

    if (axIdx !== -1 && ayIdx !== -1 && azIdx !== -1) {
      const rax = parseNullableNumber(r[axIdx]);
      const ray = parseNullableNumber(r[ayIdx]);
      const raz = parseNullableNumber(r[azIdx]);
      if (rax !== null && ray !== null && raz !== null) {
        ax = Number((rax * e4AccelScale).toFixed(4));
        ay = Number((ray * e4AccelScale).toFixed(4));
        az = Number((raz * e4AccelScale).toFixed(4));
        accelMagnitude = Number(Math.sqrt(ax * ax + ay * ay + az * az).toFixed(3));
        hasImuRow = true;
      }
    } else if (accelMagIdx !== -1) {
      const mag = parseNullableNumber(r[accelMagIdx]);
      if (mag !== null) {
        accelMagnitude = Number(mag.toFixed(3));
        hasImuRow = true;
      }
    }

    if (hr === null && temp === null && !hasImuRow && resp === null) continue;

    const { groundTruthLabel, groundTruthIsAnomalous, movementStatus: parsedMv } = parseWesadOrDaliaLabel(
      datasetId,
      labelIdx !== -1 ? r[labelIdx] : undefined,
      activityIdx !== -1 ? r[activityIdx] : undefined
    );

    const movementStatus: MovementStatus =
      parsedMv !== "resting"
        ? parsedMv
        : hasImuRow && accelMagnitude >= 1.25
        ? "walking"
        : "resting";

    const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
      parsedTimes,
      i,
      fallbackStepMs
    );

    frames.push({
      frameIndex: frames.length,
      relativeOffsetMs,
      timestampIso,
      groundTruthLabel,
      groundTruthIsAnomalous,
      telemetry: {
        patientId: `ds_${datasetId}_${participantId}_${recordId}`,
        deviceId: `DATASET-${defaultPrefix}-${participantId}`,
        timestamp: timestampIso,
        heartRate: hr,
        spo2: null,
        temperatureC: temp,
        temperatureSite: temp !== null ? "skin_wrist" : null,
        movementStatus,
        accelMagnitude,
        gyroMagnitude: 0,
        irSignalOk: hr !== null,
        fingerDetected: hr !== null,
        accelX: ax,
        accelY: ay,
        accelZ: az,
        imuSamplingRate: hasImuRow ? samplingRateHz : null,
        respiratoryRateBpm: resp,
        source: "dataset_playback",
        availableModalities: {
          heartRate: hr !== null,
          spo2: false,
          temperatureC: temp !== null,
          imu: hasImuRow,
          ecg: false,
          respiratoryRate: resp !== null,
        },
        datasetContext: {
          datasetId,
          recordId,
          groundTruthLabel,
          virtualTimestamp: timestampIso,
        },
      },
    });
  }

  if (frames.length === 0) {
    throw new DatasetValidationError(
      `${catalog.name} CSV '${filename}' contained no valid numeric signal rows.`,
      "NO_VALID_SAMPLES"
    );
  }

  const anyHr = frames.some((f) => f.telemetry.heartRate !== null);
  const anyTemp = frames.some((f) => f.telemetry.temperatureC !== null);
  const anyImu = frames.some((f) => f.telemetry.availableModalities?.imu);
  const anyResp = frames.some((f) => f.telemetry.respiratoryRateBpm !== null && f.telemetry.respiratoryRateBpm !== undefined);
  const labeledFrameCount = frames.filter((f) => f.groundTruthIsAnomalous !== null).length;

  return {
    datasetId,
    datasetName: catalog.name,
    sourcePlatform: catalog.sourcePlatform,
    participantId,
    recordId,
    originalFilename: filename,
    samplingRateHz,
    availableModalities: {
      heartRate: anyHr,
      spo2: false,
      temperatureC: anyTemp,
      imu: anyImu,
      ecg: false,
      respiratoryRate: anyResp,
    },
    temperatureSite: anyTemp ? "skin_wrist" : null,
    hasGroundTruthLabels: labeledFrameCount > 0,
    labelGranularity: labeledFrameCount > 0 ? "sample_level" : "none",
    labeledFrameCount,
    cohortNote: catalog.cohort.demographicsNote,
    includesElderly: false,
    allParticipantsElderly: false,
    provenanceNote: `Public research recording (${catalog.name}) — NOT a SmartCare clinical patient. ${catalog.cohort.demographicsNote}`,
    warnings,
    frames,
  };
}
