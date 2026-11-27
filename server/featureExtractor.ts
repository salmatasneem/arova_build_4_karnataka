import type { PatientBaselineProfile } from "./baselineTracker.ts";
import type {
  ContributingFeatureDetail,
  EcgFeatures,
  MovementStatus,
  SignalQuality,
  TelemetrySource,
} from "./types.ts";

export interface WindowTelemetryEntry {
  timestampMs: number;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  movementStatus: MovementStatus;
  signalQuality: SignalQuality;
  ecgFeatures?: EcgFeatures;
  ecgLeadOff: boolean;
}

export interface ExtractedWindowFeatures {
  windowSize: number;
  hrMean: number | null;
  hrMedian: number | null;
  hrDeltaFromBaseline: number;
  hrZScore: number;
  spo2Mean: number | null;
  spo2Min: number | null;
  spo2DeltaFromBaseline: number;
  spo2ZScore: number;
  tempMean: number | null;
  tempDeltaFromBaseline: number;
  tempZScore: number;
  tempSlopeCPerMin: number;
  accelMean: number;
  accelZScore: number;
  gyroMean: number;
  movementContext: MovementStatus;
  matchedBaselineContext: string;
  ecgAvailable: boolean;
  ecgLeadOff: boolean;
  ecgBpm: number | null;
  ecgHrvMs: number | null;
  ecgZScore: number;
  missingTemp: boolean;
  missingOptical: boolean;
  contributingDetails: ContributingFeatureDetail[];
}

const ACTIVE_MOVEMENTS = new Set<MovementStatus>(["walking", "active"]);

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function median(vals: number[]): number {
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function computeTempSlopeCPerMin(entries: WindowTelemetryEntry[]): number {
  const pts = entries
    .filter((e): e is WindowTelemetryEntry & { temperatureC: number } => typeof e.temperatureC === "number")
    .map((e) => ({ t: e.timestampMs, v: e.temperatureC }));
  if (pts.length < 2) return 0;

  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 60_000);
  const span = xs[xs.length - 1] - xs[0];
  if (span <= 0.05) {
    return round(pts[pts.length - 1].v - pts[0].v, 3);
  }
  const xMean = mean(xs);
  const yMean = mean(pts.map((p) => p.v));
  let num = 0;
  let den = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = xs[i] - xMean;
    num += dx * (pts[i].v - yMean);
    den += dx * dx;
  }
  return den > 0 ? round(num / den, 4) : 0;
}

export class SlidingWindowStore {
  private readonly windows = new Map<string, WindowTelemetryEntry[]>();
  private readonly maxLen: number;
  private readonly maxAgeMs: number;

  constructor(maxLen = 8, maxAgeMs = 15 * 60_000) {
    this.maxLen = maxLen;
    this.maxAgeMs = maxAgeMs;
  }

  private key(patientId: string, source: TelemetrySource): string {
    return `${patientId}::${source}`;
  }

  public append(
    patientId: string,
    source: TelemetrySource,
    entry: WindowTelemetryEntry
  ): WindowTelemetryEntry[] {
    const k = this.key(patientId, source);
    const list = this.windows.get(k) ?? [];
    list.push(entry);
    const cutoff = entry.timestampMs - this.maxAgeMs;
    const filtered = list.filter((item, idx) => idx === list.length - 1 || item.timestampMs >= cutoff);
    const trimmed = filtered.slice(-this.maxLen);
    this.windows.set(k, trimmed);
    return trimmed;
  }

  public clear(patientId?: string): void {
    if (!patientId) {
      this.windows.clear();
      return;
    }
    for (const k of this.windows.keys()) {
      if (k.startsWith(`${patientId}::`)) {
        this.windows.delete(k);
      }
    }
  }
}

export function extractWindowFeatures(params: {
  window: WindowTelemetryEntry[];
  profile: PatientBaselineProfile | null;
  fallbackBaselineMeans?: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
  };
}): ExtractedWindowFeatures {
  const { window, profile, fallbackBaselineMeans } = params;
  const current = window[window.length - 1];
  const validSlice = window.filter((e) => e.signalQuality !== "poor_contact");
  const recent = (validSlice.length > 0 ? validSlice : [current]).slice(-4);

  const hrs = recent.map((e) => e.heartRate).filter((v): v is number => typeof v === "number");
  const spo2s = recent.map((e) => e.spo2).filter((v): v is number => typeof v === "number");
  const temps = recent.map((e) => e.temperatureC).filter((v): v is number => typeof v === "number");

  const hrMean = hrs.length > 0 ? round(mean(hrs), 2) : current.heartRate;
  const hrMedian = hrs.length > 0 ? round(median(hrs), 2) : current.heartRate;
  const spo2Mean = spo2s.length > 0 ? round(mean(spo2s), 2) : current.spo2;
  const spo2Min = spo2s.length > 0 ? round(Math.min(...spo2s), 2) : current.spo2;
  const tempMean = temps.length > 0 ? round(mean(temps), 2) : current.temperatureC;
  const tempSlope = computeTempSlopeCPerMin(recent);
  const accelMean = round(mean(recent.map((e) => e.accelMagnitude)), 3);
  const gyroMean = round(mean(recent.map((e) => e.gyroMagnitude)), 2);

  const isActive = ACTIVE_MOVEMENTS.has(current.movementStatus);
  let matchedContext = "overall";
  let baseHr = profile?.means.heartRate ?? fallbackBaselineMeans?.heartRate ?? 74;
  let baseHrStd = profile?.stds.heartRate ?? 6.0;
  let baseSpo2 = profile?.means.spo2 ?? fallbackBaselineMeans?.spo2 ?? 98.0;
  let baseSpo2Std = profile?.stds.spo2 ?? 1.0;
  const baseTemp = profile?.means.temperatureC ?? fallbackBaselineMeans?.temperatureC ?? 36.6;
  const baseTempStd = profile?.stds.temperatureC ?? 0.35;
  const baseAccel = profile?.means.accelMagnitude ?? 1.05;
  const baseAccelStd = profile?.stds.accelMagnitude ?? 0.25;

  if (profile) {
    if (isActive && profile.active) {
      baseHr = profile.active.heartRateMean;
      baseHrStd = profile.active.heartRateStd;
      baseSpo2 = profile.active.spo2Mean;
      baseSpo2Std = profile.active.spo2Std;
      matchedContext = "active";
    } else if (!isActive && profile.resting) {
      baseHr = profile.resting.heartRateMean;
      baseHrStd = profile.resting.heartRateStd;
      baseSpo2 = profile.resting.spo2Mean;
      baseSpo2Std = profile.resting.spo2Std;
      matchedContext = "resting";
    } else if (isActive) {
      baseHr += 18;
      baseHrStd = Math.max(baseHrStd, 8.0);
      matchedContext = "active_compensated";
    }
  } else if (isActive) {
    baseHr += 18;
    baseHrStd = Math.max(baseHrStd, 8.0);
    matchedContext = "active_compensated";
  }

  const effHr = current.heartRate ?? hrMean ?? baseHr;
  const effSpo2 = current.spo2 ?? spo2Mean ?? baseSpo2;
  const effTemp = current.temperatureC ?? tempMean ?? baseTemp;

  const hrDelta = current.heartRate !== null ? round(effHr - baseHr, 2) : 0;
  const spo2Delta = current.spo2 !== null ? round(effSpo2 - baseSpo2, 2) : 0;
  const tempDelta = current.temperatureC !== null ? round(effTemp - baseTemp, 2) : 0;

  const hrZ = current.heartRate !== null ? round(hrDelta / Math.max(baseHrStd, 2.5), 2) : 0;
  const spo2Z = current.spo2 !== null ? round(spo2Delta / Math.max(baseSpo2Std, 0.6), 2) : 0;
  const tempZ = current.temperatureC !== null ? round(tempDelta / Math.max(baseTempStd, 0.25), 2) : 0;
  const accelZ = round((current.accelMagnitude - baseAccel) / Math.max(baseAccelStd, 0.15), 2);

  const ecgAvailable = Boolean(
    !current.ecgLeadOff &&
      current.ecgFeatures?.signalQuality === "good" &&
      typeof current.ecgFeatures?.estimatedEcgBpm === "number"
  );
  const ecgBpm = ecgAvailable ? (current.ecgFeatures?.estimatedEcgBpm ?? null) : null;
  const ecgHrvMs = ecgAvailable ? (current.ecgFeatures?.rrVariabilityMs ?? null) : null;
  const ecgBaseBpm = profile?.ecgBpmMean ?? baseHr;
  const ecgZ = ecgBpm !== null ? round((ecgBpm - ecgBaseBpm) / Math.max(baseHrStd, 3.0), 2) : 0;

  const details: ContributingFeatureDetail[] = [];
  if (current.heartRate !== null) {
    details.push({
      feature: "Heart Rate",
      currentValue: round(effHr, 1),
      baselineValue: round(baseHr, 1),
      zScore: hrZ,
      context: matchedContext,
      unit: "BPM",
    });
  }
  if (current.spo2 !== null) {
    details.push({
      feature: "SpO2",
      currentValue: round(effSpo2, 1),
      baselineValue: round(baseSpo2, 1),
      zScore: spo2Z,
      context: matchedContext,
      unit: "%",
    });
  }
  if (current.temperatureC !== null) {
    details.push({
      feature: "Skin Temperature",
      currentValue: round(effTemp, 2),
      baselineValue: round(baseTemp, 2),
      zScore: tempZ,
      context: "overall",
      unit: "°C",
    });
  }
  details.push({
    feature: "IMU Movement",
    currentValue: round(current.accelMagnitude, 2),
    baselineValue: round(baseAccel, 2),
    zScore: accelZ,
    context: current.movementStatus,
    unit: "g",
  });
  if (ecgBpm !== null) {
    details.push({
      feature: "AD8232 ECG Rate",
      currentValue: round(ecgBpm, 1),
      baselineValue: round(ecgBaseBpm, 1),
      zScore: ecgZ,
      context: "good_signal",
      unit: "BPM",
    });
  }

  details.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    windowSize: recent.length,
    hrMean,
    hrMedian,
    hrDeltaFromBaseline: hrDelta,
    hrZScore: hrZ,
    spo2Mean,
    spo2Min,
    spo2DeltaFromBaseline: spo2Delta,
    spo2ZScore: spo2Z,
    tempMean,
    tempDeltaFromBaseline: tempDelta,
    tempZScore: tempZ,
    tempSlopeCPerMin: tempSlope,
    accelMean,
    accelZScore: accelZ,
    gyroMean,
    movementContext: current.movementStatus,
    matchedBaselineContext: matchedContext,
    ecgAvailable,
    ecgLeadOff: current.ecgLeadOff,
    ecgBpm,
    ecgHrvMs,
    ecgZScore: ecgZ,
    missingTemp: current.temperatureC === null,
    missingOptical: current.heartRate === null || current.spo2 === null,
    contributingDetails: details,
  };
}

export const sharedWindowStore = new SlidingWindowStore();
