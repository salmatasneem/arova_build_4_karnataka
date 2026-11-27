from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional
import numpy as np


@dataclass
class EcgFeatureSummary:
    sampling_rate_hz: int
    sample_count: int
    r_peak_count: int
    estimated_ecg_bpm: Optional[float]
    rr_interval_mean_ms: Optional[float]
    rr_variability_ms: Optional[float]
    amplitude_range: float
    signal_quality: str


def extract_ecg_features_from_batch(
    samples: List[float],
    sampling_rate_hz: int = 200,
    lead_off: bool = False,
) -> EcgFeatureSummary:
    """
    Modular AD8232 ECG signal-feature extractor for ML feature preparation.
    Computes basic waveform statistics and RR interval spacing only.
    Does NOT diagnose cardiac disease or replace clinical ECG interpretation.
    """
    if lead_off:
        return EcgFeatureSummary(
            sampling_rate_hz=sampling_rate_hz,
            sample_count=len(samples),
            r_peak_count=0,
            estimated_ecg_bpm=None,
            rr_interval_mean_ms=None,
            rr_variability_ms=None,
            amplitude_range=0.0,
            signal_quality="lead_off",
        )

    if len(samples) < 10:
        return EcgFeatureSummary(
            sampling_rate_hz=sampling_rate_hz,
            sample_count=len(samples),
            r_peak_count=0,
            estimated_ecg_bpm=None,
            rr_interval_mean_ms=None,
            rr_variability_ms=None,
            amplitude_range=0.0,
            signal_quality="unavailable",
        )

    arr = np.asarray(samples, dtype=float)
    amp_range = float(round(np.max(arr) - np.min(arr), 2))
    is_adc = float(np.max(arr)) > 10.0
    min_range = 30.0 if is_adc else 0.08

    if amp_range < min_range:
        return EcgFeatureSummary(
            sampling_rate_hz=sampling_rate_hz,
            sample_count=len(samples),
            r_peak_count=0,
            estimated_ecg_bpm=None,
            rr_interval_mean_ms=None,
            rr_variability_ms=None,
            amplitude_range=amp_range,
            signal_quality="noisy",
        )

    centered = arr - np.mean(arr)
    threshold = max(float(np.std(centered)) * 1.65, amp_range * 0.25)
    refractory = max(1, int(round(0.26 * sampling_rate_hz)))

    peaks: List[int] = []
    last_idx = -refractory
    for idx in range(1, len(centered) - 1):
        if (
            idx - last_idx >= refractory
            and centered[idx] > threshold
            and centered[idx] >= centered[idx - 1]
            and centered[idx] >= centered[idx + 1]
        ):
            peaks.append(idx)
            last_idx = idx

    rr_mean: Optional[float] = None
    rr_std: Optional[float] = None
    est_bpm: Optional[float] = None

    if len(peaks) >= 2:
        rr_ms = [
            ((peaks[i] - peaks[i - 1]) / sampling_rate_hz) * 1000.0
            for i in range(1, len(peaks))
        ]
        valid_rr = [r for r in rr_ms if 260.0 <= r <= 2000.0]
        if valid_rr:
            rr_mean = float(round(np.mean(valid_rr), 1))
            rr_std = float(round(np.std(valid_rr), 1))
            bpm = 60000.0 / rr_mean
            if 30.0 <= bpm <= 220.0:
                est_bpm = float(round(bpm, 1))

    quality = "good" if (est_bpm is not None or len(peaks) >= 1) else "noisy"
    return EcgFeatureSummary(
        sampling_rate_hz=sampling_rate_hz,
        sample_count=len(samples),
        r_peak_count=len(peaks),
        estimated_ecg_bpm=est_bpm,
        rr_interval_mean_ms=rr_mean,
        rr_variability_ms=rr_std,
        amplitude_range=amp_range,
        signal_quality=quality,
    )
