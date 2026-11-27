import { getDatasetCatalogEntry } from "../catalog.ts";
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

function inferUmaFallMeta(filename: string): {
  participantId: string | null;
  recordId: string;
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
} {
  const stem = filename.replace(/\.[^.]+$/, "");
  const subjMatch = /Subject[_-]?(\d+)/i.exec(stem);
  const lower = stem.toLowerCase();

  let groundTruthLabel: string | null = null;
  let groundTruthIsAnomalous: boolean | null = null;
  if (lower.includes("fall")) {
    groundTruthLabel = "fall";
    groundTruthIsAnomalous = true;
  } else if (
    lower.includes("adl") ||
    lower.includes("walking") ||
    lower.includes("sitting") ||
    lower.includes("lying") ||
    lower.includes("bending") ||
    lower.includes("hopping") ||
    lower.includes("jogging")
  ) {
    groundTruthLabel = "adl";
    groundTruthIsAnomalous = false;
  }

  return {
    participantId: subjMatch ? `SUBJ_${subjMatch[1].padStart(2, "0")}` : null,
    recordId: stem,
    groundTruthLabel,
    groundTruthIsAnomalous,
  };
}

function parseLabel(raw: string | undefined): { label: string | null; isAnomalous: boolean | null } {
  if (!raw) return { label: null, isAnomalous: null };
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned === "na" || cleaned === "null") return { label: null, isAnomalous: null };
  if (cleaned === "1" || cleaned === "true" || cleaned.includes("fall") || cleaned === "anomalous") {
    return { label: raw.trim(), isAnomalous: true };
  }
  if (cleaned === "0" || cleaned === "false" || cleaned.includes("adl") || cleaned === "normal" || cleaned === "walking" || cleaned === "sitting") {
    return { label: raw.trim(), isAnomalous: false };
  }
  return { label: raw.trim(), isAnomalous: null };
}

export function parseUmaFallDataset(input: DatasetAdapterInput): ParsedDatasetRecording {
  const filename = sanitizeFilename(input.filename);
  checkUnsupportedBinaryOrArchive(filename, input.content);

  const catalog = getDatasetCatalogEntry("umafall")!;
  const fileMeta = inferUmaFallMeta(filename);
  const participantId = input.participantId?.trim() || fileMeta.participantId || "UMAFALL_SUBJ";
  const recordId = input.recordId?.trim() || fileMeta.recordId;

  const table = parseCsvWithHeaders(input.content, filename, "%");
  const timeIdx = findColumnIndex(table.headers, ["timestamp", "time_stamp", "time", "time_s", "t"]);

  // Format A: Official UMAFall multi-sensor rows (TimeStamp; Sample No; X-Axis; Y-Axis; Z-Axis; Sensor Type; Sensor ID)
  const xAxisIdx = findColumnIndex(table.headers, ["x_axis", "x"]);
  const yAxisIdx = findColumnIndex(table.headers, ["y_axis", "y"]);
  const zAxisIdx = findColumnIndex(table.headers, ["z_axis", "z"]);
  const sensorTypeIdx = findColumnIndex(table.headers, ["sensor_type"]);

  // Format B: Merged CSV (ax/ay/az + optional gx/gy/gz)
  const axIdx = findColumnIndex(table.headers, ["ax", "acc_x", "accel_x"]);
  const ayIdx = findColumnIndex(table.headers, ["ay", "acc_y", "accel_y"]);
  const azIdx = findColumnIndex(table.headers, ["az", "acc_z", "accel_z"]);
  const gxIdx = findColumnIndex(table.headers, ["gx", "gyro_x"]);
  const gyIdx = findColumnIndex(table.headers, ["gy", "gyro_y"]);
  const gzIdx = findColumnIndex(table.headers, ["gz", "gyro_z"]);
  const labelIdx = findColumnIndex(table.headers, ["label", "activity", "fall", "ground_truth"]);

  const isMultiSensorLongFormat =
    sensorTypeIdx !== -1 && xAxisIdx !== -1 && yAxisIdx !== -1 && zAxisIdx !== -1;
  const isMergedFormat = axIdx !== -1 && ayIdx !== -1 && azIdx !== -1;

  if (!isMultiSensorLongFormat && !isMergedFormat) {
    throw new DatasetValidationError(
      `UMAFall file '${filename}' is missing required IMU columns. Expected either official UMAFall columns ('TimeStamp; Sample No; X-Axis; Y-Axis; Z-Axis; Sensor Type; Sensor ID') or merged columns ('ax, ay, az[, gx, gy, gz]'); found: ${table.rawHeaders.join(", ")}.`,
      "MISSING_REQUIRED_COLUMNS"
    );
  }

  interface MergedImuRow {
    timeParsed: { ms: number; isAbsoluteEpoch: boolean } | null;
    ax: number;
    ay: number;
    az: number;
    gx: number | null;
    gy: number | null;
    gz: number | null;
    label: string | null;
    isAnomalous: boolean | null;
  }

  const mergedRows: MergedImuRow[] = [];
  let hasGyro = false;
  let hasSampleLevelLabels = false;

  if (isMultiSensorLongFormat) {
    // Group by rounded 20ms timestamp bucket or Sample No when accelerometer + gyroscope coexist
    const sampleNoIdx = findColumnIndex(table.headers, ["sample_no", "sample"]);
    const buckets = new Map<
      string,
      {
        timeParsed: { ms: number; isAbsoluteEpoch: boolean } | null;
        ax?: number;
        ay?: number;
        az?: number;
        gx?: number;
        gy?: number;
        gz?: number;
        label: string | null;
        isAnomalous: boolean | null;
      }
    >();

    for (let i = 0; i < table.rows.length; i++) {
      const r = table.rows[i];
      const sensorType = parseNullableNumber(r[sensorTypeIdx]);
      const x = parseNullableNumber(r[xAxisIdx]);
      const y = parseNullableNumber(r[yAxisIdx]);
      const z = parseNullableNumber(r[zAxisIdx]);
      if (sensorType === null || x === null || y === null || z === null) continue;
      if (sensorType !== 0 && sensorType !== 1) continue; // Ignore magnetometer (type 2)

      const timeParsed = timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null;
      const sampleNo = sampleNoIdx !== -1 ? (r[sampleNoIdx] ?? "").trim() : "";
      const bucketKey = timeParsed
        ? `t:${Math.round(timeParsed.ms / 10) * 10}`
        : sampleNo
        ? `s:${sampleNo}`
        : `r:${i}`;

      const existing = buckets.get(bucketKey) ?? {
        timeParsed,
        label: fileMeta.groundTruthLabel,
        isAnomalous: fileMeta.groundTruthIsAnomalous,
      };
      if (labelIdx !== -1 && r[labelIdx]) {
        const lbl = parseLabel(r[labelIdx]);
        if (lbl.label !== null) existing.label = lbl.label;
        if (lbl.isAnomalous !== null) {
          existing.isAnomalous = lbl.isAnomalous;
          hasSampleLevelLabels = true;
        }
      }

      if (sensorType === 0) {
        existing.ax = x;
        existing.ay = y;
        existing.az = z;
      } else if (sensorType === 1) {
        existing.gx = x;
        existing.gy = y;
        existing.gz = z;
        hasGyro = true;
      }
      buckets.set(bucketKey, existing);
    }

    for (const b of buckets.values()) {
      if (b.ax === undefined || b.ay === undefined || b.az === undefined) continue;
      mergedRows.push({
        timeParsed: b.timeParsed,
        ax: b.ax,
        ay: b.ay,
        az: b.az,
        gx: b.gx ?? null,
        gy: b.gy ?? null,
        gz: b.gz ?? null,
        label: b.label,
        isAnomalous: b.isAnomalous,
      });
    }
  } else {
    for (const r of table.rows) {
      const ax = parseNullableNumber(r[axIdx]);
      const ay = parseNullableNumber(r[ayIdx]);
      const az = parseNullableNumber(r[azIdx]);
      if (ax === null || ay === null || az === null) continue;

      const gx = gxIdx !== -1 ? parseNullableNumber(r[gxIdx]) : null;
      const gy = gyIdx !== -1 ? parseNullableNumber(r[gyIdx]) : null;
      const gz = gzIdx !== -1 ? parseNullableNumber(r[gzIdx]) : null;
      if (gx !== null && gy !== null && gz !== null) hasGyro = true;

      const rowLbl = labelIdx !== -1 && r[labelIdx] ? parseLabel(r[labelIdx]) : null;
      if (rowLbl && rowLbl.isAnomalous !== null) {
        hasSampleLevelLabels = true;
      }
      const lbl = rowLbl ?? {
        label: fileMeta.groundTruthLabel,
        isAnomalous: fileMeta.groundTruthIsAnomalous,
      };

      mergedRows.push({
        timeParsed: timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null,
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        label: lbl.label,
        isAnomalous: lbl.isAnomalous,
      });
    }
  }

  if (mergedRows.length === 0) {
    throw new DatasetValidationError(
      `UMAFall file '${filename}' contained no valid accelerometer rows (Sensor Type 0 or ax/ay/az).`,
      "NO_VALID_SAMPLES"
    );
  }

  let samplingRateHz = 20;
  if (mergedRows.length >= 2 && mergedRows[0].timeParsed && mergedRows[1].timeParsed) {
    const dt = mergedRows[1].timeParsed.ms - mergedRows[0].timeParsed.ms;
    if (dt > 0) samplingRateHz = Math.max(1, Math.round(1000 / dt));
  }

  const parsedTimes = mergedRows.map((m) => m.timeParsed);
  const fallbackStepMs = Math.round(1000 / samplingRateHz);

  const frames: NormalizedDatasetFrame[] = mergedRows.map((m, idx) => {
    const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
      parsedTimes,
      idx,
      fallbackStepMs
    );
    const accelMagnitude = Number(Math.sqrt(m.ax * m.ax + m.ay * m.ay + m.az * m.az).toFixed(3));
    const gyroMagnitude =
      m.gx !== null && m.gy !== null && m.gz !== null
        ? Number(Math.sqrt(m.gx * m.gx + m.gy * m.gy + m.gz * m.gz).toFixed(2))
        : 0;
    const movementStatus =
      accelMagnitude >= 2.8
        ? "fall_suspect"
        : accelMagnitude >= 1.25 || gyroMagnitude >= 45
        ? "active"
        : "resting";

    return {
      frameIndex: idx,
      relativeOffsetMs,
      timestampIso,
      groundTruthLabel: m.label,
      groundTruthIsAnomalous: m.isAnomalous,
      telemetry: {
        patientId: `ds_umafall_${participantId}_${recordId}`,
        deviceId: `DATASET-UMAFALL-${participantId}`,
        timestamp: timestampIso,
        heartRate: null,
        spo2: null,
        temperatureC: null,
        movementStatus,
        accelMagnitude,
        gyroMagnitude,
        possibleFallDetected: accelMagnitude >= 2.8,
        irSignalOk: true,
        fingerDetected: true,
        source: "dataset_playback",
        accelX: m.ax,
        accelY: m.ay,
        accelZ: m.az,
        gyroX: m.gx,
        gyroY: m.gy,
        gyroZ: m.gz,
        imuSamplingRate: samplingRateHz,
        fallMetrics: {
          impactPeakG: accelMagnitude,
          groundTruthFallLabel: m.label,
        },
        availableModalities: {
          heartRate: false,
          spo2: false,
          temperatureC: false,
          imu: true,
          ecg: false,
        },
        datasetContext: {
          datasetId: "umafall",
          recordId,
          groundTruthLabel: m.label,
          virtualTimestamp: timestampIso,
        },
      },
    };
  });

  const labeledFrameCount = frames.filter((f) => f.groundTruthIsAnomalous !== null).length;
  const labelGranularity =
    labeledFrameCount === 0
      ? "none"
      : hasSampleLevelLabels
      ? "sample_level"
      : "trial_level";

  return {
    datasetId: "umafall",
    datasetName: catalog.name,
    sourcePlatform: catalog.sourcePlatform,
    participantId,
    recordId,
    originalFilename: filename,
    samplingRateHz,
    availableModalities: {
      heartRate: false,
      spo2: false,
      temperatureC: false,
      imu: true,
      ecg: false,
    },
    temperatureSite: null,
    hasGroundTruthLabels: labeledFrameCount > 0,
    labelGranularity,
    labeledFrameCount,
    cohortNote: catalog.cohort.demographicsNote,
    includesElderly: catalog.cohort.includesElderly,
    allParticipantsElderly: false,
    provenanceNote: `Public research recording (${catalog.name}, ${hasGyro ? "Accel + Gyro" : "Accel"}) — NOT a SmartCare clinical patient. ${catalog.cohort.demographicsNote}`,
    warnings: [],
    frames,
  };
}
