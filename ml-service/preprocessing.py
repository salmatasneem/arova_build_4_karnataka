from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Any, Deque, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from baseline import (
    ACTIVE_MOVEMENTS,
    ActivityBaselineStats,
    PersonalBaselineSummary,
    WindowReading,
    compute_personal_baseline_stats,
    parse_timestamp_sec,
)
from ecg_features import EcgFeatureSummary
from validation import SIMULATED_SOURCES, sanitize_numeric, validate_sensor_quality


MODEL_FEATURE_NAMES: List[str] = [
    "hr_mean",
    "hr_delta_from_baseline",
    "spo2_mean",
    "spo2_delta_from_baseline",
    "temp_mean",
    "temp_trend_c_per_min",
    "accel_mean",
    "gyro_mean",
    "is_active_context",
    "ecg_bpm_or_hr",
    "ecg_hrv_ms",
]


@dataclass
class ExtractedFeatureWindow:
    feature_vector: List[float]
    feature_map: Dict[str, float]
    z_scores: Dict[str, float]
    contributing_features: List[Dict[str, object]]
    hr_mean: Optional[float]
    hr_median: Optional[float]
    spo2_mean: Optional[float]
    spo2_min: Optional[float]
    temp_mean: Optional[float]
    temp_slope_c_per_min: float
    accel_mean: float
    movement_context: str
    matched_baseline_context: str
    ecg_available: bool
    ecg_lead_off: bool
    missing_temp: bool
    window_size: int


def readings_to_dataframe(readings: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    Convert raw sensor telemetry dictionaries into a cleaned, timestamp-ordered Pandas DataFrame.
    Preserves missing sensor fields as NaN (never invents real sensor readings) and marks
    whether each row originates from simulated/dataset vs actual ESP32 hardware.
    """
    rows: List[Dict[str, Any]] = []
    for item in readings:
        src = str(item.get("source") or "simulator")
        ts_raw = item.get("timestamp") or item.get("createdAt") or item.get("created_at")
        ts_sec = (
            float(item["timestamp_sec"])
            if "timestamp_sec" in item and item["timestamp_sec"] is not None
            else parse_timestamp_sec(str(ts_raw) if ts_raw else None)
        )
        ts_iso = (
            str(ts_raw)
            if ts_raw
            else datetime.fromtimestamp(ts_sec, tz=timezone.utc).isoformat()
        )
        hr = sanitize_numeric(item.get("heart_rate", item.get("heartRate")))
        spo2 = sanitize_numeric(item.get("spo2"))
        temp = sanitize_numeric(item.get("temperature_c", item.get("temperatureC")))
        accel = sanitize_numeric(item.get("accel_magnitude", item.get("accelMagnitude")))
        gyro = sanitize_numeric(item.get("gyro_magnitude", item.get("gyroMagnitude")))
        mov = str(item.get("movement_status", item.get("movementStatus")) or "resting")
        qual = str(item.get("signal_quality", item.get("signalQuality")) or "good")
        score = sanitize_numeric(item.get("anomaly_score", item.get("anomalyScore")))
        anomaly_status = item.get("anomaly_status", item.get("anomalyStatus"))
        alert_level = str(item.get("alert_level", item.get("alertLevel")) or "Normal")

        rows.append(
            {
                "timestamp_sec": ts_sec,
                "timestamp": ts_iso,
                "source": src,
                "is_simulated": src in SIMULATED_SOURCES,
                "heart_rate": hr,
                "spo2": spo2,
                "temperature_c": temp,
                "accel_magnitude": accel if accel is not None else np.nan,
                "gyro_magnitude": gyro if gyro is not None else np.nan,
                "movement_status": mov,
                "signal_quality": qual,
                "anomaly_score": score if score is not None else np.nan,
                "anomaly_status": str(anomaly_status) if anomaly_status else None,
                "alert_level": alert_level,
            }
        )

    if not rows:
        return pd.DataFrame(
            columns=[
                "timestamp_sec",
                "timestamp",
                "source",
                "is_simulated",
                "heart_rate",
                "spo2",
                "temperature_c",
                "accel_magnitude",
                "gyro_magnitude",
                "movement_status",
                "signal_quality",
                "anomaly_score",
                "anomaly_status",
                "alert_level",
            ]
        )

    df = pd.DataFrame(rows)
    df = df.sort_values("timestamp_sec", kind="mergesort").reset_index(drop=True)
    return df


class PatientWindowStore:
    """
    Maintains timestamp-ordered rolling telemetry windows separated by (patient_id, source)
    so simulator readings never mix into physical hardware patient windows.
    """

    def __init__(self, max_window_len: int = 8, max_window_age_sec: float = 900.0) -> None:
        self.max_window_len = max_window_len
        self.max_window_age_sec = max_window_age_sec
        self._windows: Dict[Tuple[str, str], Deque[WindowReading]] = {}

    def clear(self, patient_id: Optional[str] = None) -> None:
        if patient_id is None:
            self._windows.clear()
            return
        keys = [k for k in self._windows if k[0] == patient_id]
        for k in keys:
            del self._windows[k]

    def append_and_get(
        self,
        patient_id: str,
        source: str,
        reading: WindowReading,
    ) -> List[WindowReading]:
        key = (patient_id, source)
        buf = self._windows.setdefault(key, deque(maxlen=self.max_window_len))
        buf.append(reading)
        cutoff = reading.timestamp_sec - self.max_window_age_sec
        while len(buf) > 1 and buf[0].timestamp_sec < cutoff:
            buf.popleft()
        return list(buf)


def _compute_temp_slope_per_min(readings: List[WindowReading]) -> float:
    pts = [(r.timestamp_sec, r.temperature_c) for r in readings if r.temperature_c is not None]
    if len(pts) < 2:
        return 0.0
    t0 = pts[0][0]
    dt_mins = [(t - t0) / 60.0 for t, _ in pts]
    span = dt_mins[-1] - dt_mins[0]
    if span <= 0.05:
        return float(round(pts[-1][1] - pts[0][1], 4))
    temps = [v for _, v in pts]
    slope = float(np.polyfit(dt_mins, temps, 1)[0])
    return round(slope, 4)


def extract_windowed_features(
    window: List[WindowReading],
    baseline: Optional[PersonalBaselineSummary],
    ecg_summary: Optional[EcgFeatureSummary] = None,
) -> ExtractedFeatureWindow:
    current = window[-1]
    valid_window = [r for r in window if r.signal_quality != "poor_contact"] or [current]
    recent_slice = valid_window[-4:]

    hrs = [r.heart_rate for r in recent_slice if r.heart_rate is not None]
    spo2s = [r.spo2 for r in recent_slice if r.spo2 is not None]
    temps = [r.temperature_c for r in recent_slice if r.temperature_c is not None]
    accels = [r.accel_magnitude for r in recent_slice]
    gyros = [r.gyro_magnitude for r in recent_slice]

    hr_mean = round(float(np.mean(hrs)), 3) if hrs else current.heart_rate
    hr_med = round(float(median(hrs)), 3) if hrs else current.heart_rate
    spo2_mean = round(float(np.mean(spo2s)), 3) if spo2s else current.spo2
    spo2_min = round(float(min(spo2s)), 3) if spo2s else current.spo2
    temp_mean = round(float(np.mean(temps)), 3) if temps else current.temperature_c
    temp_slope = _compute_temp_slope_per_min(recent_slice)
    accel_mean = round(float(np.mean(accels)), 3) if accels else current.accel_magnitude
    gyro_mean = round(float(np.mean(gyros)), 3) if gyros else current.gyro_magnitude

    is_active = current.movement_status in ACTIVE_MOVEMENTS
    matched_context = "overall"
    base_hr = baseline.overall_means["heart_rate"] if baseline else 74.0
    base_hr_std = baseline.overall_stds["heart_rate"] if baseline else 6.0
    base_spo2 = baseline.overall_means["spo2"] if baseline else 98.0
    base_spo2_std = baseline.overall_stds["spo2"] if baseline else 1.0
    base_temp = baseline.overall_means["temperature_c"] if baseline else 36.6
    base_temp_std = baseline.overall_stds["temperature_c"] if baseline else 0.35
    base_accel = baseline.overall_means["accel_magnitude"] if baseline else 1.05
    base_accel_std = baseline.overall_stds["accel_magnitude"] if baseline else 0.25

    if baseline:
        if is_active and baseline.active is not None:
            base_hr = baseline.active.means["heart_rate"]
            base_hr_std = baseline.active.stds["heart_rate"]
            base_spo2 = baseline.active.means["spo2"]
            base_spo2_std = baseline.active.stds["spo2"]
            matched_context = "active"
        elif not is_active and baseline.resting is not None:
            base_hr = baseline.resting.means["heart_rate"]
            base_hr_std = baseline.resting.stds["heart_rate"]
            base_spo2 = baseline.resting.means["spo2"]
            base_spo2_std = baseline.resting.stds["spo2"]
            matched_context = "resting"
        elif is_active:
            base_hr = base_hr + 18.0
            base_hr_std = max(base_hr_std, 8.0)
            matched_context = "active_compensated"

    eff_hr = current.heart_rate if current.heart_rate is not None else (hr_mean if hr_mean is not None else base_hr)
    eff_spo2 = current.spo2 if current.spo2 is not None else (spo2_mean if spo2_mean is not None else base_spo2)
    eff_temp = current.temperature_c if current.temperature_c is not None else (temp_mean if temp_mean is not None else base_temp)

    hr_delta = round(eff_hr - base_hr, 3) if current.heart_rate is not None else 0.0
    spo2_delta = round(eff_spo2 - base_spo2, 3) if current.spo2 is not None else 0.0
    temp_delta = round(eff_temp - base_temp, 3) if current.temperature_c is not None else 0.0

    hr_z = round(hr_delta / max(base_hr_std, 2.5), 3) if current.heart_rate is not None else 0.0
    spo2_z = round(spo2_delta / max(base_spo2_std, 0.6), 3) if current.spo2 is not None else 0.0
    temp_z = round(temp_delta / max(base_temp_std, 0.25), 3) if current.temperature_c is not None else 0.0
    accel_z = round((current.accel_magnitude - base_accel) / max(base_accel_std, 0.15), 3)

    ecg_lead_off = bool(
        current.ecg_lead_off or (ecg_summary is not None and ecg_summary.signal_quality == "lead_off")
    )
    ecg_available = bool(
        not ecg_lead_off
        and ecg_summary is not None
        and ecg_summary.signal_quality == "good"
        and ecg_summary.estimated_ecg_bpm is not None
    )
    eff_ecg_bpm = (
        float(ecg_summary.estimated_ecg_bpm)
        if ecg_available and ecg_summary and ecg_summary.estimated_ecg_bpm is not None
        else eff_hr
    )
    eff_ecg_hrv = (
        float(ecg_summary.rr_variability_ms)
        if ecg_available and ecg_summary and ecg_summary.rr_variability_ms is not None
        else (baseline.ecg_hrv_mean if baseline and baseline.ecg_hrv_mean is not None else 35.0)
    )
    ecg_z = 0.0
    if ecg_available and baseline and baseline.ecg_bpm_mean is not None:
        ecg_z = round((eff_ecg_bpm - baseline.ecg_bpm_mean) / max(base_hr_std, 3.0), 3)

    feature_map: Dict[str, float] = {
        "hr_mean": float(hr_mean if hr_mean is not None else eff_hr),
        "hr_delta_from_baseline": hr_delta,
        "spo2_mean": float(spo2_mean if spo2_mean is not None else eff_spo2),
        "spo2_delta_from_baseline": spo2_delta,
        "temp_mean": float(temp_mean if temp_mean is not None else eff_temp),
        "temp_trend_c_per_min": temp_slope,
        "accel_mean": float(accel_mean),
        "gyro_mean": float(gyro_mean),
        "is_active_context": 1.0 if is_active else 0.0,
        "ecg_bpm_or_hr": eff_ecg_bpm,
        "ecg_hrv_ms": eff_ecg_hrv,
        "missing_temp_flag": 1.0 if current.temperature_c is None else 0.0,
        "ecg_available_flag": 1.0 if ecg_available else 0.0,
    }
    feature_vector = [feature_map[name] for name in MODEL_FEATURE_NAMES]

    z_scores = {
        "heart_rate": hr_z,
        "spo2": spo2_z,
        "temperature_c": temp_z,
        "accel_magnitude": accel_z,
        "ecg_bpm": ecg_z,
    }

    contributing: List[Dict[str, object]] = []
    if current.heart_rate is not None:
        contributing.append({
            "feature": "Heart Rate",
            "current_value": round(eff_hr, 1),
            "baseline_value": round(base_hr, 1),
            "z_score": hr_z,
            "context": matched_context,
            "unit": "BPM",
        })
    if current.spo2 is not None:
        contributing.append({
            "feature": "SpO2",
            "current_value": round(eff_spo2, 1),
            "baseline_value": round(base_spo2, 1),
            "z_score": spo2_z,
            "context": matched_context,
            "unit": "%",
        })
    if current.temperature_c is not None:
        contributing.append({
            "feature": "Skin Temperature",
            "current_value": round(eff_temp, 2),
            "baseline_value": round(base_temp, 2),
            "z_score": temp_z,
            "context": "overall",
            "unit": "°C",
        })
    contributing.append({
        "feature": "IMU Movement",
        "current_value": round(current.accel_magnitude, 2),
        "baseline_value": round(base_accel, 2),
        "z_score": accel_z,
        "context": current.movement_status,
        "unit": "g",
    })
    if ecg_available:
        contributing.append({
            "feature": "AD8232 ECG Rate",
            "current_value": round(eff_ecg_bpm, 1),
            "baseline_value": round(baseline.ecg_bpm_mean, 1) if baseline and baseline.ecg_bpm_mean else round(base_hr, 1),
            "z_score": ecg_z,
            "context": "good_signal",
            "unit": "BPM",
        })

    contributing.sort(key=lambda item: abs(float(item["z_score"])), reverse=True)

    return ExtractedFeatureWindow(
        feature_vector=feature_vector,
        feature_map=feature_map,
        z_scores=z_scores,
        contributing_features=contributing,
        hr_mean=hr_mean,
        hr_median=hr_med,
        spo2_mean=spo2_mean,
        spo2_min=spo2_min,
        temp_mean=temp_mean,
        temp_slope_c_per_min=temp_slope,
        accel_mean=accel_mean,
        movement_context=current.movement_status,
        matched_baseline_context=matched_context,
        ecg_available=ecg_available,
        ecg_lead_off=ecg_lead_off,
        missing_temp=current.temperature_c is None,
        window_size=len(recent_slice),
    )


def build_feature_dataframe(
    patient_id: str,
    source: str,
    samples: List[WindowReading],
    baseline: PersonalBaselineSummary,
) -> pd.DataFrame:
    """
    Build a Pandas DataFrame of time-windowed 11-feature vectors from ordered clean samples.
    """
    temp_store = PatientWindowStore(max_window_len=8, max_window_age_sec=3600.0)
    rows: List[Dict[str, float]] = []
    for s in samples:
        win = temp_store.append_and_get(patient_id, source, s)
        ecg_sum = (
            EcgFeatureSummary(
                sampling_rate_hz=200,
                sample_count=100,
                r_peak_count=2,
                estimated_ecg_bpm=s.ecg_bpm,
                rr_interval_mean_ms=s.ecg_rri_ms,
                rr_variability_ms=s.ecg_hrv_ms,
                amplitude_range=1.0,
                signal_quality=s.ecg_signal_quality,
            )
            if s.ecg_signal_quality == "good" and not s.ecg_lead_off and s.ecg_bpm is not None
            else None
        )
        extracted = extract_windowed_features(win, baseline, ecg_sum)
        rows.append({name: extracted.feature_map[name] for name in MODEL_FEATURE_NAMES})

    return pd.DataFrame(rows, columns=MODEL_FEATURE_NAMES, dtype=float)
