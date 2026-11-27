import type { EcgFeatures, EcgSignalQuality } from "./types.ts";

/**
 * Modular signal-feature extractor for provisional AD8232 ECG waveform batches.
 * Computes basic waveform statistics (amplitude range, simple R-peak intervals)
 * for visualization and ML feature preparation only. Does NOT perform clinical ECG diagnosis.
 */
export function extractEcgFeatures(params: {
  samples?: number[];
  samplingRateHz?: number;
  leadOff?: boolean;
  reportedQuality?: EcgSignalQuality;
}): EcgFeatures {
  const rate =
    typeof params.samplingRateHz === "number" &&
    Number.isFinite(params.samplingRateHz) &&
    params.samplingRateHz >= 25 &&
    params.samplingRateHz <= 1000
      ? Math.round(params.samplingRateHz)
      : 200;

  if (params.leadOff) {
    return {
      samplingRateHz: rate,
      sampleCount: params.samples?.length ?? 0,
      rPeakCount: 0,
      estimatedEcgBpm: null,
      rrIntervalMeanMs: null,
      rrVariabilityMs: null,
      amplitudeRange: 0,
      signalQuality: "lead_off",
    };
  }

  const samples = Array.isArray(params.samples) ? params.samples : [];
  if (samples.length < 10) {
    return {
      samplingRateHz: rate,
      sampleCount: samples.length,
      rPeakCount: 0,
      estimatedEcgBpm: null,
      rrIntervalMeanMs: null,
      rrVariabilityMs: null,
      amplitudeRange: 0,
      signalQuality: params.reportedQuality ?? "unavailable",
    };
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  let sum = 0;
  for (const v of samples) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
    sum += v;
  }
  const mean = sum / samples.length;
  const range = Number((maxVal - minVal).toFixed(2));

  // Detect flatline/saturation across 3 scales:
  // 1) Normalized mV (~ -2..+2), 2) Centered ESP32 mV (~ -1650..+1650), 3) Raw 12-bit ADC (0..4095)
  const isCenteredMv = minVal < -5;
  const isRawAdc = !isCenteredMv && maxVal > 10;
  const minMeaningfulRange = isRawAdc ? 30 : isCenteredMv ? 15 : 0.08;
  const saturatedCount = isRawAdc
    ? samples.filter((v) => v <= 20 || v >= 4075).length
    : isCenteredMv
    ? samples.filter((v) => v <= -1620 || v >= 1620).length
    : 0;

  if (range < minMeaningfulRange || saturatedCount > samples.length * 0.4) {
    return {
      samplingRateHz: rate,
      sampleCount: samples.length,
      rPeakCount: 0,
      estimatedEcgBpm: null,
      rrIntervalMeanMs: null,
      rrVariabilityMs: null,
      amplitudeRange: range,
      signalQuality: "noisy",
    };
  }

  // Simple adaptive peak finder with 260ms refractory window for heart-rate rhythm estimation
  const deviations = samples.map((v) => v - mean);
  const std = Math.sqrt(
    deviations.reduce((acc, d) => acc + d * d, 0) / deviations.length
  );
  const threshold = Math.max(std * 1.65, range * 0.25);
  const refractorySamples = Math.max(1, Math.round((0.26 * rate)));

  const peakIndices: number[] = [];
  let lastPeakIdx = -refractorySamples;

  for (let i = 1; i < deviations.length - 1; i++) {
    if (
      i - lastPeakIdx >= refractorySamples &&
      deviations[i] > threshold &&
      deviations[i] >= deviations[i - 1] &&
      deviations[i] >= deviations[i + 1]
    ) {
      peakIndices.push(i);
      lastPeakIdx = i;
    }
  }

  let rrMeanMs: number | null = null;
  let rrVarMs: number | null = null;
  let estBpm: number | null = null;

  if (peakIndices.length >= 2) {
    const rrList: number[] = [];
    for (let i = 1; i < peakIndices.length; i++) {
      const rrMs = ((peakIndices[i] - peakIndices[i - 1]) / rate) * 1000;
      if (rrMs >= 260 && rrMs <= 2000) {
        rrList.push(rrMs);
      }
    }
    if (rrList.length > 0) {
      const meanRr = rrList.reduce((a, b) => a + b, 0) / rrList.length;
      const variance =
        rrList.reduce((acc, r) => acc + (r - meanRr) * (r - meanRr), 0) / rrList.length;
      rrMeanMs = Number(meanRr.toFixed(1));
      rrVarMs = Number(Math.sqrt(variance).toFixed(1));
      const bpm = 60000 / meanRr;
      if (bpm >= 30 && bpm <= 220) {
        estBpm = Number(bpm.toFixed(1));
      }
    }
  }

  const quality: EcgSignalQuality =
    params.reportedQuality === "noisy"
      ? "noisy"
      : estBpm !== null || peakIndices.length >= 1
      ? "good"
      : "noisy";

  return {
    samplingRateHz: rate,
    sampleCount: samples.length,
    rPeakCount: peakIndices.length,
    estimatedEcgBpm: estBpm,
    rrIntervalMeanMs: rrMeanMs,
    rrVariabilityMs: rrVarMs,
    amplitudeRange: range,
    signalQuality: quality,
  };
}
