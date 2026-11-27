import fs from "node:fs";
import path from "node:path";
import type {
  AvailableModalities,
  BaselineProgress,
  EcgSignalQuality,
  MovementStatus,
  SignalQuality,
  TelemetrySource,
  TemperatureSite,
} from "./types.ts";

export interface BaselineSampleInput {
  timestampMs: number;
  heartRate: number | null;
  spo2: number | null;
  temperatureC: number | null;
  accelMagnitude: number;
  gyroMagnitude: number;
  movementStatus: MovementStatus;
  signalQuality: SignalQuality;
  ecgBpm?: number | null;
  ecgRriMs?: number | null;
  ecgHrvMs?: number | null;
  ecgSignalQuality?: EcgSignalQuality;
  ecgLeadOff?: boolean;
  temperatureSite?: TemperatureSite | null;
  availableModalities?: AvailableModalities;
}

export interface ActivitySubBaseline {
  sampleCount: number;
  heartRateMean: number;
  heartRateMedian: number;
  heartRateStd: number;
  spo2Mean: number;
  spo2Median: number;
  spo2Std: number;
}

export interface PatientBaselineProfile {
  patientId: string;
  source: TelemetrySource;
  modelVersion: string;
  trainedAt: string;
  updatedAt: string;
  requiredSamples: number;
  sampleCount: number;
  means: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
    accelMagnitude: number;
    gyroMagnitude: number;
  };
  medians: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
    accelMagnitude: number;
    gyroMagnitude: number;
  };
  stds: {
    heartRate: number;
    spo2: number;
    temperatureC: number;
    accelMagnitude: number;
    gyroMagnitude: number;
  };
  resting: ActivitySubBaseline | null;
  active: ActivitySubBaseline | null;
  ecgBpmMean: number | null;
  ecgHrvMean: number | null;
  ecgBaselineSamples: number;
  remotePythonTrained: boolean;
}

const ALLOWED_SOURCES = new Set<TelemetrySource>(["esp32_hardware", "simulator", "dataset_playback"]);
const ACTIVE_MOVEMENTS = new Set<MovementStatus>(["walking", "active"]);

function mean(vals: number[]): number {
  return vals.reduce((acc, v) => acc + v, 0) / vals.length;
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function std(vals: number[], minFloor: number): number {
  if (vals.length < 2) return minFloor;
  const m = mean(vals);
  const variance = vals.reduce((acc, v) => acc + (v - m) ** 2, 0) / vals.length;
  return Math.max(Math.sqrt(variance), minFloor);
}

function round(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

export class BaselineTracker {
  private readonly samplesByKey = new Map<string, BaselineSampleInput[]>();
  private readonly profilesByKey = new Map<string, PatientBaselineProfile>();
  private readonly persistFile: string | null;

  constructor(persistPath?: string) {
    this.persistFile =
      persistPath !== undefined
        ? persistPath
        : path.resolve(process.cwd(), "data", "patient_baselines.json");
    this.loadFromDisk();
  }

  private makeKey(patientId: string, source: TelemetrySource): string {
    return `${patientId}::${source}`;
  }

  private loadFromDisk(): void {
    if (!this.persistFile) return;
    try {
      if (!fs.existsSync(this.persistFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistFile, "utf-8")) as {
        profiles?: Record<string, PatientBaselineProfile>;
        samples?: Record<string, BaselineSampleInput[]>;
      };
      if (raw.profiles) {
        for (const [k, v] of Object.entries(raw.profiles)) {
          if (v && !v.medians && v.means) {
            v.medians = { ...v.means };
          }
          if (v && !v.updatedAt) {
            v.updatedAt = v.trainedAt;
          }
          if (v?.resting && typeof v.resting.heartRateMedian !== "number") {
            v.resting.heartRateMedian = v.resting.heartRateMean;
            v.resting.spo2Median = v.resting.spo2Mean;
          }
          if (v?.active && typeof v.active.heartRateMedian !== "number") {
            v.active.heartRateMedian = v.active.heartRateMean;
            v.active.spo2Median = v.active.spo2Mean;
          }
          this.profilesByKey.set(k, v);
        }
      }
      if (raw.samples) {
        for (const [k, v] of Object.entries(raw.samples)) {
          if (Array.isArray(v)) {
            this.samplesByKey.set(k, v.slice(-200));
          }
        }
      }
    } catch {
      // Ignore corrupt or unavailable disk state cleanly
    }
  }

  private saveToDisk(): void {
    if (!this.persistFile) return;
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      const payload = {
        profiles: Object.fromEntries(this.profilesByKey.entries()),
        samples: Object.fromEntries(
          Array.from(this.samplesByKey.entries()).map(([k, v]) => [k, v.slice(-200)])
        ),
      };
      fs.writeFileSync(this.persistFile, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Non-fatal in read-only environments
    }
  }

  public isCleanBaselineCandidate(s: {
    heartRate: number | null;
    spo2: number | null;
    temperatureC: number | null;
    signalQuality: SignalQuality;
    source: TelemetrySource;
    temperatureSite?: TemperatureSite | null;
    availableModalities?: AvailableModalities;
  }): boolean {
    if (!ALLOWED_SOURCES.has(s.source)) return false;
    if (s.signalQuality !== "good") return false;

    const isDataset = s.source === "dataset_playback";
    const hrExpected = !isDataset || s.availableModalities?.heartRate !== false;
    const spo2Expected = !isDataset || s.availableModalities?.spo2 !== false;

    if (hrExpected && (typeof s.heartRate !== "number" || s.heartRate < 30 || s.heartRate > 230)) {
      return false;
    }
    if (!hrExpected && s.heartRate !== null && (typeof s.heartRate !== "number" || s.heartRate < 30 || s.heartRate > 230)) {
      return false;
    }
    if (spo2Expected && (typeof s.spo2 !== "number" || s.spo2 < 50 || s.spo2 > 100)) {
      return false;
    }
    if (!spo2Expected && s.spo2 !== null && (typeof s.spo2 !== "number" || s.spo2 < 50 || s.spo2 > 100)) {
      return false;
    }

    const minTemp = isDataset && s.temperatureSite === "skin_wrist" ? 25 : 30;
    if (s.temperatureC !== null && (s.temperatureC < minTemp || s.temperatureC > 43)) return false;
    return true;
  }

  public recordCleanSample(
    patientId: string,
    source: TelemetrySource,
    sample: BaselineSampleInput,
    requiredSamples = 20
  ): {
    accepted: boolean;
    reason?: string;
    progress: BaselineProgress;
    profile: PatientBaselineProfile | null;
  } {
    if (!ALLOWED_SOURCES.has(source)) {
      return {
        accepted: false,
        reason: `Telemetry source '${source}' is excluded from personalized baseline learning.`,
        progress: this.getProgress(patientId, source, requiredSamples),
        profile: this.getProfile(patientId, source),
      };
    }

    if (
      !this.isCleanBaselineCandidate({
        heartRate: sample.heartRate,
        spo2: sample.spo2,
        temperatureC: sample.temperatureC,
        signalQuality: sample.signalQuality,
        source,
        temperatureSite: sample.temperatureSite,
        availableModalities: sample.availableModalities,
      })
    ) {
      return {
        accepted: false,
        reason: "Sample excluded by sensor quality gate.",
        progress: this.getProgress(patientId, source, requiredSamples),
        profile: this.getProfile(patientId, source),
      };
    }

    const key = this.makeKey(patientId, source);
    const list = this.samplesByKey.get(key) ?? [];
    list.push(sample);
    if (list.length > 200) list.shift();
    this.samplesByKey.set(key, list);

    let profile = this.profilesByKey.get(key) ?? null;
    const minReq = Math.max(5, requiredSamples);
    if (list.length >= minReq) {
      profile = this.computeProfile(patientId, source, list, minReq, profile?.remotePythonTrained ?? false);
      this.profilesByKey.set(key, profile);
    }

    this.saveToDisk();
    return {
      accepted: true,
      progress: this.getProgress(patientId, source, minReq),
      profile,
    };
  }

  public fitBaseline(
    patientId: string,
    source: TelemetrySource,
    samples: BaselineSampleInput[],
    requiredSamples = 20,
    remotePythonTrained = false,
    remoteModelVersion?: string | null
  ): PatientBaselineProfile {
    if (!ALLOWED_SOURCES.has(source)) {
      throw new Error(
        `Source '${source}' cannot be used to fit a personalized baseline. Only esp32_hardware or simulator readings are allowed.`
      );
    }

    const clean = samples.filter((s) =>
      this.isCleanBaselineCandidate({
        heartRate: s.heartRate,
        spo2: s.spo2,
        temperatureC: s.temperatureC,
        signalQuality: s.signalQuality,
        source,
        temperatureSite: s.temperatureSite,
        availableModalities: s.availableModalities,
      })
    );

    const minReq = Math.max(5, requiredSamples);
    if (clean.length < 5) {
      throw new Error(
        `At least 5 quality-filtered ('good') readings are required to compute baseline statistics (received ${clean.length}).`
      );
    }

    const key = this.makeKey(patientId, source);
    this.samplesByKey.set(key, [...clean]);
    const profile = this.computeProfile(
      patientId,
      source,
      clean,
      minReq,
      remotePythonTrained,
      remoteModelVersion
    );
    if (clean.length >= minReq) {
      this.profilesByKey.set(key, profile);
    }
    this.saveToDisk();
    return profile;
  }

  private computeProfile(
    patientId: string,
    source: TelemetrySource,
    clean: BaselineSampleInput[],
    requiredSamples: number,
    remotePythonTrained: boolean,
    remoteModelVersion?: string | null
  ): PatientBaselineProfile {
    const hrs = clean
      .map((s) => s.heartRate)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const spo2s = clean
      .map((s) => s.spo2)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const temps = clean
      .map((s) => s.temperatureC)
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    const accels = clean.map((s) => s.accelMagnitude);
    const gyros = clean.map((s) => s.gyroMagnitude);

    const restingClean = clean.filter((s) => !ACTIVE_MOVEMENTS.has(s.movementStatus));
    const activeClean = clean.filter((s) => ACTIVE_MOVEMENTS.has(s.movementStatus));

    const restingHrs = restingClean
      .map((s) => s.heartRate)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const restingSpo2s = restingClean
      .map((s) => s.spo2)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const resting: ActivitySubBaseline | null =
      restingClean.length >= 5
        ? {
            sampleCount: restingClean.length,
            heartRateMean: restingHrs.length > 0 ? round(mean(restingHrs), 2) : 72,
            heartRateMedian: restingHrs.length > 0 ? round(median(restingHrs), 2) : 72,
            heartRateStd: restingHrs.length > 0 ? round(std(restingHrs, 2.5), 2) : 6.0,
            spo2Mean: restingSpo2s.length > 0 ? round(mean(restingSpo2s), 2) : 98,
            spo2Median: restingSpo2s.length > 0 ? round(median(restingSpo2s), 2) : 98,
            spo2Std: restingSpo2s.length > 0 ? round(std(restingSpo2s, 0.6), 2) : 1.0,
          }
        : null;

    const activeHrs = activeClean
      .map((s) => s.heartRate)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const activeSpo2s = activeClean
      .map((s) => s.spo2)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const active: ActivitySubBaseline | null =
      activeClean.length >= 5
        ? {
            sampleCount: activeClean.length,
            heartRateMean: activeHrs.length > 0 ? round(mean(activeHrs), 2) : 92,
            heartRateMedian: activeHrs.length > 0 ? round(median(activeHrs), 2) : 92,
            heartRateStd: activeHrs.length > 0 ? round(std(activeHrs, 3.5), 2) : 8.0,
            spo2Mean: activeSpo2s.length > 0 ? round(mean(activeSpo2s), 2) : 97.5,
            spo2Median: activeSpo2s.length > 0 ? round(median(activeSpo2s), 2) : 97.5,
            spo2Std: activeSpo2s.length > 0 ? round(std(activeSpo2s, 0.7), 2) : 1.0,
          }
        : null;

    const ecgBpms = clean
      .filter((s) => s.ecgSignalQuality === "good" && !s.ecgLeadOff && typeof s.ecgBpm === "number")
      .map((s) => s.ecgBpm as number);
    const ecgHrvs = clean
      .filter((s) => s.ecgSignalQuality === "good" && !s.ecgLeadOff && typeof s.ecgHrvMs === "number")
      .map((s) => s.ecgHrvMs as number);

    const now = new Date();
    const nowIso = now.toISOString();
    const version =
      remoteModelVersion ||
      `baseline-v2-${source}-${nowIso.replace(/[-:T.]/g, "").slice(0, 14)}`;

    return {
      patientId,
      source,
      modelVersion: version,
      trainedAt: nowIso,
      updatedAt: nowIso,
      requiredSamples,
      sampleCount: clean.length,
      means: {
        heartRate: hrs.length > 0 ? round(mean(hrs), 2) : 72,
        spo2: spo2s.length > 0 ? round(mean(spo2s), 2) : 98,
        temperatureC: temps.length > 0 ? round(mean(temps), 2) : 36.6,
        accelMagnitude: round(mean(accels), 3),
        gyroMagnitude: round(mean(gyros), 2),
      },
      medians: {
        heartRate: hrs.length > 0 ? round(median(hrs), 2) : 72,
        spo2: spo2s.length > 0 ? round(median(spo2s), 2) : 98,
        temperatureC: temps.length > 0 ? round(median(temps), 2) : 36.6,
        accelMagnitude: round(median(accels), 3),
        gyroMagnitude: round(median(gyros), 2),
      },
      stds: {
        heartRate: hrs.length > 0 ? round(std(hrs, 2.5), 2) : 6.0,
        spo2: spo2s.length > 0 ? round(std(spo2s, 0.6), 2) : 1.0,
        temperatureC: temps.length >= 2 ? round(std(temps, 0.25), 2) : 0.35,
        accelMagnitude: round(std(accels, 0.15), 3),
        gyroMagnitude: round(std(gyros, 2.0), 2),
      },
      resting,
      active,
      ecgBpmMean: ecgBpms.length > 0 ? round(mean(ecgBpms), 1) : null,
      ecgHrvMean: ecgHrvs.length > 0 ? round(mean(ecgHrvs), 1) : null,
      ecgBaselineSamples: ecgBpms.length,
      remotePythonTrained,
    };
  }

  public getProfile(patientId: string, source: TelemetrySource): PatientBaselineProfile | null {
    if (!ALLOWED_SOURCES.has(source)) return null;
    return this.profilesByKey.get(this.makeKey(patientId, source)) ?? null;
  }

  public getProgress(
    patientId: string,
    source: TelemetrySource,
    requiredSamples = 20
  ): BaselineProgress {
    if (!ALLOWED_SOURCES.has(source)) {
      return {
        collectedSamples: 0,
        requiredSamples,
        status: "not_started",
        source: null,
        modelVersion: null,
        restingSamples: 0,
        activeSamples: 0,
        ecgBaselineSamples: 0,
      };
    }

    const key = this.makeKey(patientId, source);
    const profile = this.profilesByKey.get(key) ?? null;
    const samples = this.samplesByKey.get(key) ?? [];
    const collected = profile ? Math.max(profile.sampleCount, samples.length) : samples.length;
    const isReady = Boolean(profile && collected >= requiredSamples);

    return {
      collectedSamples: collected,
      requiredSamples,
      status: isReady ? "ready" : collected > 0 ? "collecting" : "not_started",
      source,
      modelVersion: profile?.modelVersion ?? null,
      restingSamples:
        profile?.resting?.sampleCount ??
        samples.filter((s) => !ACTIVE_MOVEMENTS.has(s.movementStatus)).length,
      activeSamples:
        profile?.active?.sampleCount ??
        samples.filter((s) => ACTIVE_MOVEMENTS.has(s.movementStatus)).length,
      ecgBaselineSamples:
        profile?.ecgBaselineSamples ??
        samples.filter((s) => s.ecgSignalQuality === "good" && !s.ecgLeadOff && typeof s.ecgBpm === "number").length,
      ...(profile
        ? {
            means: profile.means,
            medians: profile.medians,
            stds: profile.stds,
            updatedAt: profile.updatedAt ?? profile.trainedAt,
          }
        : {}),
    };
  }

  public getSamples(patientId: string, source: TelemetrySource): BaselineSampleInput[] {
    return [...(this.samplesByKey.get(this.makeKey(patientId, source)) ?? [])];
  }

  public resetPatient(patientId: string, source?: TelemetrySource): void {
    const sources: TelemetrySource[] = source ? [source] : ["esp32_hardware", "simulator", "dataset_playback"];
    for (const src of sources) {
      const key = this.makeKey(patientId, src);
      this.samplesByKey.delete(key);
      this.profilesByKey.delete(key);
    }
    this.saveToDisk();
  }
}

export const sharedBaselineTracker = new BaselineTracker();
