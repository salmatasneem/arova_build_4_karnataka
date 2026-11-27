from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import math


ALLOWED_BASELINE_SOURCES = {"esp32_hardware", "simulator", "dataset_playback"}
SIMULATED_SOURCES = {"simulator", "dataset_playback", "sample_demo"}


@dataclass
class SensorValidationResult:
    signal_quality: str  # "good" | "noisy" | "poor_contact"
    issues: List[str]
    missing_fields: List[str]
    invalid_fields: List[str]
    is_valid_for_baseline: bool
    is_simulated: bool


def _is_finite_number(val: Optional[float]) -> bool:
    if val is None:
        return False
    try:
        return math.isfinite(float(val))
    except (TypeError, ValueError):
        return False


def sanitize_numeric(val: Optional[float]) -> Optional[float]:
    if val is None:
        return None
    try:
        num = float(val)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def validate_sensor_quality(
    heart_rate: Optional[float],
    spo2: Optional[float],
    temperature_c: Optional[float],
    accel_magnitude: Optional[float],
    ir_signal_ok: bool = True,
    finger_detected: bool = True,
    source: str = "simulator",
    available_modalities: Optional[Dict[str, bool]] = None,
    temperature_site: Optional[str] = None,
    gyro_magnitude: Optional[float] = None,
) -> Tuple[str, List[str]]:
    """
    Validate MAX30102/MAX30100 optical pulse-oximeter, configurable temperature probe,
    and MPU6050 IMU readings without inventing or imputing missing values.
    """
    result = validate_sensor_reading(
        heart_rate=heart_rate,
        spo2=spo2,
        temperature_c=temperature_c,
        accel_magnitude=accel_magnitude,
        gyro_magnitude=gyro_magnitude,
        ir_signal_ok=ir_signal_ok,
        finger_detected=finger_detected,
        source=source,
        available_modalities=available_modalities,
        temperature_site=temperature_site,
    )
    return result.signal_quality, result.issues


def validate_sensor_reading(
    heart_rate: Optional[float],
    spo2: Optional[float],
    temperature_c: Optional[float],
    accel_magnitude: Optional[float],
    gyro_magnitude: Optional[float] = None,
    ir_signal_ok: bool = True,
    finger_detected: bool = True,
    source: str = "simulator",
    available_modalities: Optional[Dict[str, bool]] = None,
    temperature_site: Optional[str] = None,
) -> SensorValidationResult:
    issues: List[str] = []
    missing_fields: List[str] = []
    invalid_fields: List[str] = []

    is_dataset = source == "dataset_playback"
    is_simulated = source in SIMULATED_SOURCES
    hr_expected = (not is_dataset) or ((available_modalities or {}).get("heartRate", True) is not False)
    spo2_expected = (not is_dataset) or ((available_modalities or {}).get("spo2", True) is not False)

    hr_val = sanitize_numeric(heart_rate)
    spo2_val = sanitize_numeric(spo2)
    temp_val = sanitize_numeric(temperature_c)
    accel_val = sanitize_numeric(accel_magnitude)
    gyro_val = sanitize_numeric(gyro_magnitude) if gyro_magnitude is not None else 0.0

    if not finger_detected or not ir_signal_ok:
        issues.append("MAX30100/MAX30102 optical sensor reports no finger detected or low IR perfusion.")
        if hr_expected:
            missing_fields.append("heart_rate")
        if spo2_expected:
            missing_fields.append("spo2")
    else:
        if hr_expected and (hr_val is None or hr_val == 0):
            issues.append("MAX30100/MAX30102 optical sensor reports no finger detected or low IR perfusion.")
            missing_fields.append("heart_rate")
        elif hr_val is not None and (hr_val < 30.0 or hr_val > 230.0):
            issues.append(f"Heart rate reading ({hr_val} BPM) outside physiological sensor bounds (30-230 BPM).")
            invalid_fields.append("heart_rate")

        if spo2_expected and (spo2_val is None or spo2_val == 0):
            issues.append("MAX30100/MAX30102 optical sensor reports missing or invalid SpO2 optical signal.")
            missing_fields.append("spo2")
        elif spo2_val is not None and (spo2_val < 50.0 or spo2_val > 100.0):
            issues.append(f"SpO2 reading ({spo2_val}%) outside pulse oximetry bounds (50-100%).")
            invalid_fields.append("spo2")

    min_temp = 25.0 if (is_dataset and temperature_site == "skin_wrist") else 30.0
    if temp_val is None:
        missing_fields.append("temperature_c")
    elif temp_val < min_temp or temp_val > 43.0:
        issues.append(f"Temperature ({temp_val} °C) indicates detached probe or out-of-range artifact.")
        invalid_fields.append("temperature_c")

    if accel_val is None or accel_val < 0.0 or accel_val > 100.0:
        issues.append("MPU6050 accelerometer magnitude is missing or out of valid bounds.")
        invalid_fields.append("accel_magnitude")

    if gyro_val is None or gyro_val < 0.0 or gyro_val > 5000.0:
        issues.append("MPU6050 gyroscope magnitude is out of valid bounds.")
        invalid_fields.append("gyro_magnitude")

    if issues:
        return SensorValidationResult(
            signal_quality="poor_contact",
            issues=issues,
            missing_fields=missing_fields,
            invalid_fields=invalid_fields,
            is_valid_for_baseline=False,
            is_simulated=is_simulated,
        )

    if accel_val is not None and accel_val > 2.6:
        return SensorValidationResult(
            signal_quality="noisy",
            issues=["High MPU6050 motion artifact detected; optical PPG readings may carry movement noise."],
            missing_fields=missing_fields,
            invalid_fields=invalid_fields,
            is_valid_for_baseline=False,
            is_simulated=is_simulated,
        )

    return SensorValidationResult(
        signal_quality="good",
        issues=[],
        missing_fields=missing_fields,
        invalid_fields=invalid_fields,
        is_valid_for_baseline=source in ALLOWED_BASELINE_SOURCES,
        is_simulated=is_simulated,
    )


def is_clean_baseline_candidate(
    heart_rate: Optional[float],
    spo2: Optional[float],
    temperature_c: Optional[float],
    accel_magnitude: Optional[float],
    signal_quality: str,
    source: str = "simulator",
    available_modalities: Optional[Dict[str, bool]] = None,
    temperature_site: Optional[str] = None,
) -> bool:
    if source not in ALLOWED_BASELINE_SOURCES:
        return False
    if signal_quality != "good":
        return False

    is_dataset = source == "dataset_playback"
    hr_expected = (not is_dataset) or ((available_modalities or {}).get("heartRate", True) is not False)
    spo2_expected = (not is_dataset) or ((available_modalities or {}).get("spo2", True) is not False)

    if hr_expected and (not _is_finite_number(heart_rate) or not (30.0 <= float(heart_rate) <= 230.0)):
        return False
    if not hr_expected and heart_rate is not None and (not _is_finite_number(heart_rate) or not (30.0 <= float(heart_rate) <= 230.0)):
        return False

    if spo2_expected and (not _is_finite_number(spo2) or not (50.0 <= float(spo2) <= 100.0)):
        return False
    if not spo2_expected and spo2 is not None and (not _is_finite_number(spo2) or not (50.0 <= float(spo2) <= 100.0)):
        return False

    min_temp = 25.0 if (is_dataset and temperature_site == "skin_wrist") else 30.0
    if temperature_c is not None and (not _is_finite_number(temperature_c) or not (min_temp <= float(temperature_c) <= 43.0)):
        return False

    if accel_magnitude is not None and (not _is_finite_number(accel_magnitude) or float(accel_magnitude) > 2.6 or float(accel_magnitude) < 0.0):
        return False

    return True
