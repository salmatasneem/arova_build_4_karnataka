from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from validation import is_clean_baseline_candidate


ACTIVE_MOVEMENTS = {"walking", "active"}


def parse_timestamp_sec(ts: Optional[str]) -> float:
    if not ts:
        return datetime.now(timezone.utc).timestamp()
    try:
        normalized = ts.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return datetime.now(timezone.utc).timestamp()


@dataclass
class WindowReading:
    timestamp_sec: float
    heart_rate: Optional[float]
    spo2: Optional[float]
    temperature_c: Optional[float]
    accel_magnitude: float
    gyro_magnitude: float
    movement_status: str
    signal_quality: str
    ecg_bpm: Optional[float] = None
    ecg_rri_ms: Optional[float] = None
    ecg_hrv_ms: Optional[float] = None
    ecg_signal_quality: str = "unavailable"
    ecg_lead_off: bool = False
    source: str = "simulator"


@dataclass
class ActivityBaselineStats:
    means: Dict[str, float]
    stds: Dict[str, float]
    sample_count: int
    medians: Dict[str, float] = field(default_factory=dict)


@dataclass
class PersonalBaselineSummary:
    overall_means: Dict[str, float]
    overall_stds: Dict[str, float]
    overall_medians: Dict[str, float] = field(default_factory=dict)
    resting: Optional[ActivityBaselineStats] = None
    active: Optional[ActivityBaselineStats] = None
    ecg_bpm_mean: Optional[float] = None
    ecg_hrv_mean: Optional[float] = None
    ecg_sample_count: int = 0
    sample_count: int = 0
    updated_at: Optional[str] = None


def _series_stat_mean(series: pd.Series, default: float, decimals: int = 3) -> float:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if clean.empty:
        return default
    return round(float(clean.mean()), decimals)


def _series_stat_median(series: pd.Series, default: float, decimals: int = 3) -> float:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if clean.empty:
        return default
    return round(float(clean.median()), decimals)


def _series_stat_std(series: pd.Series, min_floor: float, default: float, decimals: int = 3) -> float:
    clean = pd.to_numeric(series, errors="coerce").dropna()
    if len(clean) < 2:
        return default
    return round(max(float(clean.std(ddof=0)), min_floor), decimals)


def compute_personal_baseline_stats(samples: List[WindowReading]) -> PersonalBaselineSummary:
    """
    Compute personalized mean, median, and standard deviation statistics from a single
    patient's clean historical readings using Pandas & NumPy. Never mixes patients or sources.
    """
    df = pd.DataFrame(
        [
            {
                "heart_rate": s.heart_rate,
                "spo2": s.spo2,
                "temperature_c": s.temperature_c,
                "accel_magnitude": s.accel_magnitude,
                "gyro_magnitude": s.gyro_magnitude,
                "movement_status": s.movement_status,
                "ecg_bpm": s.ecg_bpm if (s.ecg_signal_quality == "good" and not s.ecg_lead_off) else None,
                "ecg_hrv_ms": s.ecg_hrv_ms if (s.ecg_signal_quality == "good" and not s.ecg_lead_off) else None,
            }
            for s in samples
        ]
    )

    if df.empty:
        overall_means = {
            "heart_rate": 72.0,
            "spo2": 98.0,
            "temperature_c": 36.6,
            "accel_magnitude": 1.0,
            "gyro_magnitude": 5.0,
        }
        overall_medians = dict(overall_means)
        overall_stds = {
            "heart_rate": 6.0,
            "spo2": 1.0,
            "temperature_c": 0.35,
            "accel_magnitude": 0.25,
            "gyro_magnitude": 4.0,
        }
        return PersonalBaselineSummary(
            overall_means=overall_means,
            overall_medians=overall_medians,
            overall_stds=overall_stds,
            sample_count=0,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )

    overall_means = {
        "heart_rate": _series_stat_mean(df["heart_rate"], 72.0),
        "spo2": _series_stat_mean(df["spo2"], 98.0),
        "temperature_c": _series_stat_mean(df["temperature_c"], 36.6),
        "accel_magnitude": _series_stat_mean(df["accel_magnitude"], 1.0),
        "gyro_magnitude": _series_stat_mean(df["gyro_magnitude"], 5.0),
    }
    overall_medians = {
        "heart_rate": _series_stat_median(df["heart_rate"], overall_means["heart_rate"]),
        "spo2": _series_stat_median(df["spo2"], overall_means["spo2"]),
        "temperature_c": _series_stat_median(df["temperature_c"], overall_means["temperature_c"]),
        "accel_magnitude": _series_stat_median(df["accel_magnitude"], overall_means["accel_magnitude"]),
        "gyro_magnitude": _series_stat_median(df["gyro_magnitude"], overall_means["gyro_magnitude"]),
    }
    overall_stds = {
        "heart_rate": _series_stat_std(df["heart_rate"], 2.5, 6.0),
        "spo2": _series_stat_std(df["spo2"], 0.6, 1.0),
        "temperature_c": _series_stat_std(df["temperature_c"], 0.25, 0.35),
        "accel_magnitude": _series_stat_std(df["accel_magnitude"], 0.12, 0.25),
        "gyro_magnitude": _series_stat_std(df["gyro_magnitude"], 2.0, 4.0),
    }

    resting_df = df[~df["movement_status"].isin(ACTIVE_MOVEMENTS)]
    active_df = df[df["movement_status"].isin(ACTIVE_MOVEMENTS)]

    resting_stats: Optional[ActivityBaselineStats] = None
    if len(resting_df) >= 5:
        resting_stats = ActivityBaselineStats(
            means={
                "heart_rate": _series_stat_mean(resting_df["heart_rate"], overall_means["heart_rate"]),
                "spo2": _series_stat_mean(resting_df["spo2"], overall_means["spo2"]),
            },
            medians={
                "heart_rate": _series_stat_median(resting_df["heart_rate"], overall_medians["heart_rate"]),
                "spo2": _series_stat_median(resting_df["spo2"], overall_medians["spo2"]),
            },
            stds={
                "heart_rate": _series_stat_std(resting_df["heart_rate"], 2.5, overall_stds["heart_rate"]),
                "spo2": _series_stat_std(resting_df["spo2"], 0.6, overall_stds["spo2"]),
            },
            sample_count=int(len(resting_df)),
        )

    active_stats: Optional[ActivityBaselineStats] = None
    if len(active_df) >= 5:
        active_stats = ActivityBaselineStats(
            means={
                "heart_rate": _series_stat_mean(active_df["heart_rate"], 92.0),
                "spo2": _series_stat_mean(active_df["spo2"], 97.5),
            },
            medians={
                "heart_rate": _series_stat_median(active_df["heart_rate"], 92.0),
                "spo2": _series_stat_median(active_df["spo2"], 97.5),
            },
            stds={
                "heart_rate": _series_stat_std(active_df["heart_rate"], 3.5, 8.0),
                "spo2": _series_stat_std(active_df["spo2"], 0.7, 1.0),
            },
            sample_count=int(len(active_df)),
        )

    ecg_bpms = pd.to_numeric(df["ecg_bpm"], errors="coerce").dropna()
    ecg_hrvs = pd.to_numeric(df["ecg_hrv_ms"], errors="coerce").dropna()

    return PersonalBaselineSummary(
        overall_means=overall_means,
        overall_medians=overall_medians,
        overall_stds=overall_stds,
        resting=resting_stats,
        active=active_stats,
        ecg_bpm_mean=round(float(ecg_bpms.mean()), 2) if not ecg_bpms.empty else None,
        ecg_hrv_mean=round(float(ecg_hrvs.mean()), 2) if not ecg_hrvs.empty else None,
        ecg_sample_count=int(len(ecg_bpms)),
        sample_count=int(len(df)),
        updated_at=datetime.now(timezone.utc).isoformat(),
    )


def should_include_for_baseline_update(
    reading: WindowReading,
    source: str,
    anomaly_status: str,
    alert_level: str,
    possible_fall_detected: bool,
    allow_baseline_training: bool = True,
    available_modalities: Optional[Dict[str, bool]] = None,
    temperature_site: Optional[str] = None,
) -> bool:
    """
    Guardrail ensuring incremental baseline learning excludes invalid/noisy readings,
    fall events, and confirmed anomalous/warning/critical periods.
    """
    if not allow_baseline_training:
        return False
    if possible_fall_detected or reading.movement_status == "fall_suspect":
        return False
    if anomaly_status == "anomalous" or alert_level != "Normal":
        return False
    return is_clean_baseline_candidate(
        heart_rate=reading.heart_rate,
        spo2=reading.spo2,
        temperature_c=reading.temperature_c,
        accel_magnitude=reading.accel_magnitude,
        signal_quality=reading.signal_quality,
        source=source,
        available_modalities=available_modalities,
        temperature_site=temperature_site,
    )
