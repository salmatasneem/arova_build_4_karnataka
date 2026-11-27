import { getDatasetCatalogEntry } from "../catalog.ts";
import {
  buildRelativeAndIsoTimestamp,
  checkUnsupportedBinaryOrArchive,
  DETERMINISTIC_PLAYBACK_ANCHOR_MS,
  detectDelimiter,
  findColumnIndex,
  parseCsvWithHeaders,
  parseNullableNumber,
  parseTimeValueMs,
  sanitizeFilename,
  splitDelimitedLine,
} from "./csvUtils.ts";
import {
  DatasetValidationError,
  type DatasetAdapterInput,
  type NormalizedDatasetFrame,
  type ParsedDatasetRecording,
} from "./types.ts";

const ADXL345_SCALE_G = 32.0 / 8192.0; // ±16g, 13-bit signed -> g
const ITG3200_SCALE_DPS = 4000.0 / 65536.0; // ±2000 °/s, 16-bit signed -> °/s

interface RawImuSample {
  ax: number;
  ay: number;
  az: number;
  gx: number | null;
  gy: number | null;
  gz: number | null;
  timeParsed: { ms: number; isAbsoluteEpoch: boolean } | null;
  labelRaw: string | null;
  isFall: boolean | null;
}

function inferSisFallMetadataFromFilename(filename: string): {
  participantId: string | null;
  trialCode: string | null;
  groundTruthLabel: string | null;
  groundTruthIsAnomalous: boolean | null;
} {
  const stem = filename.replace(/\.[^.]+$/, "");
  const participantMatch = /(?:^|[^a-zA-Z0-9])(S[AE]\d{2})(?=[^a-zA-Z0-9]|$)/i.exec(stem);
  const trialMatch = /(?:^|[^a-zA-Z0-9])([FD]\d{2})(?=[^a-zA-Z0-9]|$)/i.exec(stem);
  const trialCode = trialMatch ? trialMatch[1].toUpperCase() : null;
  let groundTruthLabel: string | null = null;
  let groundTruthIsAnomalous: boolean | null = null;
  if (trialCode?.startsWith("F")) {
    groundTruthLabel = `fall:${trialCode}`;
    groundTruthIsAnomalous = true;
  } else if (trialCode?.startsWith("D")) {
    groundTruthLabel = `adl:${trialCode}`;
    groundTruthIsAnomalous = false;
  }
  return {
    participantId: participantMatch ? participantMatch[1].toUpperCase() : null,
    trialCode,
    groundTruthLabel,
    groundTruthIsAnomalous,
  };
}

function parseLabelFlag(raw: string | null): { label: string | null; isAnomalous: boolean | null } {
  if (!raw) return { label: null, isAnomalous: null };
  const norm = raw.trim().toLowerCase();
  if (!norm || norm === "na" || norm === "null") return { label: null, isAnomalous: null };
  if (norm === "1" || norm === "true" || norm.includes("fall") || norm === "anomalous" || norm === "abnormal") {
    return { label: raw.trim(), isAnomalous: true };
  }
  if (norm === "0" || norm === "false" || norm.includes("adl") || norm === "normal" || norm === "resting" || norm === "walking") {
    return { label: raw.trim(), isAnomalous: false };
  }
  return { label: raw.trim(), isAnomalous: null };
}

function mag3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function parseSisFallDataset(input: DatasetAdapterInput): ParsedDatasetRecording {
  const filename = sanitizeFilename(input.filename);
  checkUnsupportedBinaryOrArchive(filename, input.content);

  const catalog = getDatasetCatalogEntry("sisfall")!;
  const fileMeta = inferSisFallMetadataFromFilename(filename);
  const participantId = input.participantId?.trim() || fileMeta.participantId || "SISFALL_SUBJ";
  const recordId = input.recordId?.trim() || fileMeta.trialCode || filename.replace(/\.[^.]+$/, "");

  const lines = input.content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("%"));

  if (lines.length === 0) {
    throw new DatasetValidationError(`SisFall file '${filename}' is empty.`, "EMPTY_FILE");
  }

  const firstTokens = splitDelimitedLine(lines[0].replace(/[;,\s]+$/, ""), detectDelimiter(lines[0]));
  const hasHeader = firstTokens.some((tok) => {
    const cleaned = tok.replace(/;$/, "").trim();
    return cleaned !== "" && !Number.isFinite(Number(cleaned));
  });

  const rawSamples: RawImuSample[] = [];
  let hasGyro = false;
  let samplingRateHz = 200;
  let hasSampleLevelLabels = false;
  const warnings: string[] = [];

  if (!hasHeader) {
    // Official SisFall raw .txt format: 9 integer ADC columns (ADXL345 xyz, ITG3200 xyz, MMA8451Q xyz) at 200 Hz
    if (firstTokens.length < 6) {
      throw new DatasetValidationError(
        `Headerless SisFall file '${filename}' has ${firstTokens.length} columns; expected 6 or 9 comma-separated integer ADC columns (ADXL345 X,Y,Z, ITG3200 X,Y,Z[, MMA8451Q X,Y,Z]).`,
        "INVALID_SISFALL_COLUMNS"
      );
    }
    if (fileMeta.trialCode?.startsWith("F")) {
      warnings.push(
        `Trial-level filename label ('${fileMeta.groundTruthLabel}') applies to all windows in this raw SisFall file because official .txt traces omit sample-level fall onset/offset timestamps; pre-fall walking and post-fall stillness frames will register as FN in frame-level metrics.`
      );
    }
    for (let i = 0; i < lines.length; i++) {
      const cleanedLine = lines[i].replace(/[;,\s]+$/, "");
      const cols = splitDelimitedLine(cleanedLine, detectDelimiter(cleanedLine));
      if (cols.length < 6) {
        throw new DatasetValidationError(
          `SisFall row ${i + 1} in '${filename}' has ${cols.length} columns; expected at least 6.`,
          "MALFORMED_ROW"
        );
      }
      const axRaw = parseNullableNumber(cols[0]);
      const ayRaw = parseNullableNumber(cols[1]);
      const azRaw = parseNullableNumber(cols[2]);
      const gxRaw = parseNullableNumber(cols[3]);
      const gyRaw = parseNullableNumber(cols[4]);
      const gzRaw = parseNullableNumber(cols[5]);

      if (axRaw === null || ayRaw === null || azRaw === null) {
        throw new DatasetValidationError(
          `SisFall row ${i + 1} in '${filename}' is missing required ADXL345 accelerometer values.`,
          "MISSING_REQUIRED_VALUES"
        );
      }
      const gx = gxRaw !== null ? Number((gxRaw * ITG3200_SCALE_DPS).toFixed(3)) : null;
      const gy = gyRaw !== null ? Number((gyRaw * ITG3200_SCALE_DPS).toFixed(3)) : null;
      const gz = gzRaw !== null ? Number((gzRaw * ITG3200_SCALE_DPS).toFixed(3)) : null;
      if (gx !== null && gy !== null && gz !== null) hasGyro = true;

      rawSamples.push({
        ax: Number((axRaw * ADXL345_SCALE_G).toFixed(4)),
        ay: Number((ayRaw * ADXL345_SCALE_G).toFixed(4)),
        az: Number((azRaw * ADXL345_SCALE_G).toFixed(4)),
        gx,
        gy,
        gz,
        timeParsed: null,
        labelRaw: fileMeta.groundTruthLabel,
        isFall: fileMeta.groundTruthIsAnomalous,
      });
    }
  } else {
    const table = parseCsvWithHeaders(input.content, filename, "%");
    const axIdx = findColumnIndex(table.headers, ["ax", "adxl_x", "adxl345_x", "acc_x", "accx", "accel_x", "x_axis", "x"]);
    const ayIdx = findColumnIndex(table.headers, ["ay", "adxl_y", "adxl345_y", "acc_y", "accy", "accel_y", "y_axis", "y"]);
    const azIdx = findColumnIndex(table.headers, ["az", "adxl_z", "adxl345_z", "acc_z", "accz", "accel_z", "z_axis", "z"]);
    if (axIdx === -1 || ayIdx === -1 || azIdx === -1) {
      throw new DatasetValidationError(
        `SisFall CSV '${filename}' is missing required accelerometer columns (expected ax/ay/az, adxl345_x/y/z, adxl_x/y/z, or acc_x/y/z; found: ${table.rawHeaders.join(", ")}).`,
        "MISSING_REQUIRED_COLUMNS"
      );
    }
    const gxIdx = findColumnIndex(table.headers, ["gx", "gyro_x", "gyrox", "itg_x", "itg3200_x"]);
    const gyIdx = findColumnIndex(table.headers, ["gy", "gyro_y", "gyroy", "itg_y", "itg3200_y"]);
    const gzIdx = findColumnIndex(table.headers, ["gz", "gyro_z", "gyroz", "itg_z", "itg3200_z"]);
    const timeIdx = findColumnIndex(table.headers, ["timestamp", "time", "time_s", "elapsed_s", "t"]);
    const labelIdx = findColumnIndex(table.headers, ["label", "fall", "activity", "ground_truth"]);

    // Detect whether named CSV columns are already in g or still raw ADC counts
    const sampleMags: number[] = [];
    for (let i = 0; i < Math.min(table.rows.length, 25); i++) {
      const r = table.rows[i];
      const ax = parseNullableNumber(r[axIdx]);
      const ay = parseNullableNumber(r[ayIdx]);
      const az = parseNullableNumber(r[azIdx]);
      if (ax !== null && ay !== null && az !== null) sampleMags.push(mag3(ax, ay, az));
    }
    sampleMags.sort((a, b) => a - b);
    const medianInitMag = sampleMags.length > 0 ? sampleMags[Math.floor(sampleMags.length / 2)] : 1;
    const isRawAdcCounts = medianInitMag > 40;
    if (isRawAdcCounts) {
      warnings.push("Detected integer ADC counts in SisFall CSV; converted ADXL345 (±16g) and ITG3200 (±2000°/s) to physical units.");
    }

    const parsedTimes = table.rows.map((r) => (timeIdx !== -1 ? parseTimeValueMs(r[timeIdx]) : null));
    if (parsedTimes.length >= 2 && parsedTimes[0] && parsedTimes[1]) {
      const dt = parsedTimes[1].ms - parsedTimes[0].ms;
      if (dt > 0) samplingRateHz = Math.max(1, Math.round(1000 / dt));
    }

    for (let i = 0; i < table.rows.length; i++) {
      const r = table.rows[i];
      const axRaw = parseNullableNumber(r[axIdx]);
      const ayRaw = parseNullableNumber(r[ayIdx]);
      const azRaw = parseNullableNumber(r[azIdx]);
      if (axRaw === null || ayRaw === null || azRaw === null) continue;

      const gxRaw = gxIdx !== -1 ? parseNullableNumber(r[gxIdx]) : null;
      const gyRaw = gyIdx !== -1 ? parseNullableNumber(r[gyIdx]) : null;
      const gzRaw = gzIdx !== -1 ? parseNullableNumber(r[gzIdx]) : null;

      const ax = isRawAdcCounts ? Number((axRaw * ADXL345_SCALE_G).toFixed(4)) : axRaw;
      const ay = isRawAdcCounts ? Number((ayRaw * ADXL345_SCALE_G).toFixed(4)) : ayRaw;
      const az = isRawAdcCounts ? Number((azRaw * ADXL345_SCALE_G).toFixed(4)) : azRaw;
      const gx = gxRaw !== null ? (isRawAdcCounts ? Number((gxRaw * ITG3200_SCALE_DPS).toFixed(3)) : gxRaw) : null;
      const gy = gyRaw !== null ? (isRawAdcCounts ? Number((gyRaw * ITG3200_SCALE_DPS).toFixed(3)) : gyRaw) : null;
      const gz = gzRaw !== null ? (isRawAdcCounts ? Number((gzRaw * ITG3200_SCALE_DPS).toFixed(3)) : gzRaw) : null;
      if (gx !== null && gy !== null && gz !== null) hasGyro = true;

      const rowLabel = labelIdx !== -1 ? (r[labelIdx] ?? "").trim() : "";
      const rowParsed = rowLabel ? parseLabelFlag(rowLabel) : null;
      if (rowParsed && rowParsed.isAnomalous !== null) {
        hasSampleLevelLabels = true;
      }
      const parsedLabel = rowParsed ?? {
        label: fileMeta.groundTruthLabel,
        isAnomalous: fileMeta.groundTruthIsAnomalous,
      };

      rawSamples.push({
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        timeParsed: parsedTimes[i],
        labelRaw: parsedLabel.label,
        isFall: parsedLabel.isAnomalous,
      });
    }

    if (rawSamples.length === 0) {
      throw new DatasetValidationError(
        `SisFall CSV '${filename}' contained no valid numeric accelerometer rows.`,
        "NO_VALID_SAMPLES"
      );
    }
  }

  // Group high-rate trials (>200 rows at >=50Hz) into compact playback windows preserving peak fall g & relative timestamps
  const shouldWindow = rawSamples.length > 200 && samplingRateHz >= 50;
  const windowStepMs = shouldWindow ? Math.max(50, Math.min(2000, input.windowMs ?? 200)) : 0;
  const samplesPerFrame = shouldWindow ? Math.max(1, Math.round((samplingRateHz * windowStepMs) / 1000)) : 1;

  const frames: NormalizedDatasetFrame[] = [];
  const stepFallbackMs = Math.round(1000 / Math.max(1, samplingRateHz));
  const rawTimes = rawSamples.map((s) => s.timeParsed);

  for (let start = 0; start < rawSamples.length; start += samplesPerFrame) {
    const slice = rawSamples.slice(start, start + samplesPerFrame);
    let peakIdx = 0;
    let peakAccMag = -1;
    let peakGyroMag = 0;

    for (let j = 0; j < slice.length; j++) {
      const s = slice[j];
      const aMag = mag3(s.ax, s.ay, s.az);
      if (aMag > peakAccMag) {
        peakAccMag = aMag;
        peakIdx = j;
      }
      if (s.gx !== null && s.gy !== null && s.gz !== null) {
        const gMag = mag3(s.gx, s.gy, s.gz);
        if (gMag > peakGyroMag) peakGyroMag = gMag;
      }
    }

    const rep = slice[peakIdx];
    const { relativeOffsetMs, timestampIso } = buildRelativeAndIsoTimestamp(
      rawTimes,
      start,
      stepFallbackMs
    );
    const accelMagnitude = Number(peakAccMag.toFixed(3));
    const gyroMagnitude = Number(peakGyroMag.toFixed(2));

    const anyFallLabel = slice.some((s) => s.isFall === true);
    const hasAdlLabel = slice.some((s) => s.isFall === false);
    const groundTruthIsAnomalous = anyFallLabel ? true : hasAdlLabel ? false : null;
    const groundTruthLabel =
      slice.find((s) => s.isFall === true)?.labelRaw ??
      slice.find((s) => s.labelRaw !== null)?.labelRaw ??
      null;

    const movementStatus =
      accelMagnitude >= 2.8
        ? "fall_suspect"
        : accelMagnitude >= 1.25 || gyroMagnitude >= 45
        ? "active"
        : "resting";

    frames.push({
      frameIndex: frames.length,
      relativeOffsetMs,
      timestampIso,
      groundTruthLabel,
      groundTruthIsAnomalous,
      telemetry: {
        patientId: `ds_sisfall_${participantId}_${recordId}`,
        deviceId: `DATASET-SISFALL-${participantId}`,
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
        accelX: rep.ax,
        accelY: rep.ay,
        accelZ: rep.az,
        gyroX: rep.gx,
        gyroY: rep.gy,
        gyroZ: rep.gz,
        imuSamplingRate: samplingRateHz,
        fallMetrics: {
          impactPeakG: accelMagnitude,
          groundTruthFallLabel: groundTruthLabel,
        },
        availableModalities: {
          heartRate: false,
          spo2: false,
          temperatureC: false,
          imu: true,
          ecg: false,
        },
        datasetContext: {
          datasetId: "sisfall",
          recordId,
          groundTruthLabel,
          virtualTimestamp: timestampIso || new Date(DETERMINISTIC_PLAYBACK_ANCHOR_MS + relativeOffsetMs).toISOString(),
        },
      },
    });
  }

  const labeledFrameCount = frames.filter((f) => f.groundTruthIsAnomalous !== null).length;
  const labelGranularity =
    labeledFrameCount === 0
      ? "none"
      : hasSampleLevelLabels
      ? "sample_level"
      : "trial_level";

  return {
    datasetId: "sisfall",
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
    warnings,
    frames,
  };
}
