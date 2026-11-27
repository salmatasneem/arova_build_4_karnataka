from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alert_engine import AlertDecisionConfig
from detector import AnomalyDetectorRegistry
from ecg_features import extract_ecg_features_from_batch
from features import WindowReading


def _build_clean_baseline_samples(
    count: int = 24,
    resting_hr: float = 70.0,
    active_hr: float = 98.0,
    spo2: float = 98.0,
    temp_c: float | None = 36.6,
    with_ecg: bool = True,
) -> list[WindowReading]:
    t0 = datetime(2026, 11, 25, 10, 0, tzinfo=timezone.utc)
    samples: list[WindowReading] = []
    for i in range(count):
        ts = (t0 + timedelta(minutes=i * 2)).timestamp()
        is_active = (i % 3 == 2)
        hr = (active_hr if is_active else resting_hr) + ((i % 3) - 1) * 1.5
        samples.append(
            WindowReading(
                timestamp_sec=ts,
                heart_rate=hr,
                spo2=spo2 - (i % 2) * 0.2,
                temperature_c=temp_c,
                accel_magnitude=1.35 if is_active else 1.01,
                gyro_magnitude=22.0 if is_active else 3.0,
                movement_status="walking" if is_active else "resting",
                signal_quality="good",
                ecg_bpm=hr if with_ecg else None,
                ecg_rri_ms=round(60000.0 / hr, 1) if with_ecg else None,
                ecg_hrv_ms=34.0 if with_ecg else None,
                ecg_signal_quality="good" if with_ecg else "unavailable",
                ecg_lead_off=False,
            )
        )
    return samples


def test_source_separation_and_sample_demo_rejection(tmp_path: Path) -> None:
    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    samples = _build_clean_baseline_samples(22)

    with pytest.raises(ValueError, match="sample_demo"):
        registry.fit_patient_baseline("pt_1", samples, source="sample_demo")

    model = registry.fit_patient_baseline("pt_1", samples, source="esp32_hardware")
    assert model.source == "esp32_hardware"
    assert model.sample_count == 22

    # Simulator readings must NOT read or pollute esp32_hardware baseline
    sim_res = registry.analyze(
        patient_id="pt_1",
        heart_rate=72.0,
        spo2=98.0,
        temperature_c=36.6,
        accel_magnitude=1.01,
        gyro_magnitude=3.0,
        source="simulator",
    )
    assert sim_res["model_trained"] is False
    assert sim_res["anomaly_status"] == "insufficient_baseline"


def test_disk_persistence_across_restart(tmp_path: Path) -> None:
    reg1 = AnomalyDetectorRegistry(model_dir=tmp_path)
    samples = _build_clean_baseline_samples(25)
    fitted = reg1.fit_patient_baseline("pt_persist", samples, source="esp32_hardware")

    reg2 = AnomalyDetectorRegistry(model_dir=tmp_path)
    status = reg2.get_status("pt_persist", source="esp32_hardware")
    assert status["trained"] is True
    assert status["model_version"] == fitted.model_version
    assert status["sample_count"] == 25


def test_insufficient_baseline_vs_normal_vs_acute_guardrail(tmp_path: Path) -> None:
    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    res_insufficient = registry.analyze(
        patient_id="pt_new",
        heart_rate=84.0,
        spo2=97.5,
        temperature_c=36.7,
        accel_magnitude=1.0,
        gyro_magnitude=3.0,
        source="simulator",
    )
    assert res_insufficient["anomaly_status"] == "insufficient_baseline"
    assert res_insufficient["alert_level"] == "Normal"

    # Acute critical safety guardrail still fires when SpO2 <= 88%
    res_acute = registry.analyze(
        patient_id="pt_new",
        heart_rate=132.0,
        spo2=86.0,
        temperature_c=37.0,
        accel_magnitude=1.0,
        gyro_magnitude=3.0,
        source="simulator",
    )
    assert res_acute["anomaly_status"] == "insufficient_baseline"
    assert res_acute["alert_level"] == "Critical"


def test_poor_contact_and_ecg_leadoff_and_null_temp(tmp_path: Path) -> None:
    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    registry.fit_patient_baseline("pt_q", _build_clean_baseline_samples(24, temp_c=None), source="esp32_hardware")

    # Missing optical / no finger -> paused_poor_quality, never false alert
    poor = registry.analyze(
        patient_id="pt_q",
        heart_rate=None,
        spo2=None,
        temperature_c=None,
        accel_magnitude=1.0,
        gyro_magnitude=2.0,
        finger_detected=False,
        ir_signal_ok=False,
        ecg_summary=extract_ecg_features_from_batch([2048.0] * 40, 200, lead_off=True),
        source="esp32_hardware",
    )
    assert poor["anomaly_status"] == "paused_poor_quality"
    assert poor["alert_level"] == "Normal"
    assert "lead-off" in str(poor["explanation"]).lower()

    # Normal reading with null temperature still scores cleanly using personal baseline
    normal_null_temp = registry.analyze(
        patient_id="pt_q",
        heart_rate=71.0,
        spo2=98.0,
        temperature_c=None,
        accel_magnitude=1.01,
        gyro_magnitude=3.0,
        movement_status="resting",
        source="esp32_hardware",
    )
    assert normal_null_temp["anomaly_status"] == "normal"
    assert normal_null_temp["alert_level"] == "Normal"


def test_activity_context_and_multi_window_persistence_and_synthetic_eval(tmp_path: Path) -> None:
    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    registry.fit_patient_baseline("pt_eval", _build_clean_baseline_samples(30, resting_hr=68.0, active_hr=102.0), source="simulator")
    cfg = AlertDecisionConfig(warning_persistence_windows=2, critical_persistence_windows=3)
    t_base = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)

    # Walking HR ~100 BPM aligns with patient's active context (no false alarm)
    walking_ok = registry.analyze(
        patient_id="pt_eval",
        heart_rate=101.0,
        spo2=97.9,
        temperature_c=36.6,
        accel_magnitude=1.35,
        gyro_magnitude=20.0,
        movement_status="walking",
        source="simulator",
        timestamp=t_base.isoformat(),
        config=cfg,
    )
    assert walking_ok["alert_level"] == "Normal"

    # Single-packet moderate spike should stay Normal (pending 1/2 confirmation) -> suppresses transient false alarm
    spike_1 = registry.analyze(
        patient_id="pt_eval",
        heart_rate=106.0,
        spo2=94.5,
        temperature_c=37.4,
        accel_magnitude=1.01,
        gyro_magnitude=2.0,
        movement_status="resting",
        source="simulator",
        timestamp=(t_base + timedelta(minutes=1)).isoformat(),
        config=cfg,
    )
    assert spike_1["anomaly_status"] == "anomalous"
    assert spike_1["persistence_count"] == 1
    assert spike_1["alert_level"] == "Normal"

    # Second consecutive anomalous window confirms Warning
    spike_2 = registry.analyze(
        patient_id="pt_eval",
        heart_rate=108.0,
        spo2=94.0,
        temperature_c=37.7,
        accel_magnitude=1.01,
        gyro_magnitude=2.0,
        movement_status="resting",
        source="simulator",
        timestamp=(t_base + timedelta(minutes=2)).isoformat(),
        config=cfg,
    )
    assert spike_2["anomaly_status"] == "anomalous"
    assert spike_2["persistence_count"] == 2
    assert spike_2["alert_level"] in ("Warning", "Critical")

    # Reset via normal reading, then test synthetic labeled dataset precision/recall
    for step in range(2):
        registry.analyze(
            patient_id="pt_eval",
            heart_rate=68.0,
            spo2=98.0,
            temperature_c=36.6,
            accel_magnitude=1.01,
            gyro_magnitude=3.0,
            movement_status="resting",
            source="simulator",
            timestamp=(t_base + timedelta(minutes=3 + step)).isoformat(),
            config=cfg,
        )

    synthetic_normal = [
        (68.0, 98.1, 36.6, "resting"),
        (70.0, 97.9, 36.6, "resting"),
        (100.0, 97.8, 36.6, "walking"),
        (67.0, 98.0, 36.5, "resting"),
    ]
    synthetic_abnormal = [
        (114.0, 92.8, 38.0, "resting"),
        (118.0, 91.5, 38.2, "resting"),
        (126.0, 89.0, 38.4, "resting"),
        (129.0, 88.4, 38.5, "resting"),
    ]

    fp = 0
    tp = 0
    for idx, (hr, sp, tmp, mv) in enumerate(synthetic_normal):
        out = registry.analyze(
            patient_id="pt_eval",
            heart_rate=hr,
            spo2=sp,
            temperature_c=tmp,
            accel_magnitude=1.3 if mv == "walking" else 1.0,
            gyro_magnitude=20.0 if mv == "walking" else 3.0,
            movement_status=mv,
            source="simulator",
            timestamp=(t_base + timedelta(minutes=10 + idx)).isoformat(),
            config=cfg,
        )
        if out["alert_level"] != "Normal":
            fp += 1

    for idx, (hr, sp, tmp, mv) in enumerate(synthetic_abnormal):
        out = registry.analyze(
            patient_id="pt_eval",
            heart_rate=hr,
            spo2=sp,
            temperature_c=tmp,
            accel_magnitude=1.0,
            gyro_magnitude=3.0,
            movement_status=mv,
            source="simulator",
            timestamp=(t_base + timedelta(minutes=20 + idx)).isoformat(),
            config=cfg,
        )
        if out["alert_level"] != "Normal":
            tp += 1

    assert fp == 0
    assert tp >= 3


def test_minimum_sample_guard_prevents_undetrained_iforest(tmp_path: Path) -> None:
    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    too_few = _build_clean_baseline_samples(10)
    with pytest.raises(ValueError, match="At least 20"):
        registry.fit_patient_baseline("pt_small", too_few, source="simulator", min_samples=10)
    status = registry.get_status("pt_small", source="simulator")
    assert status["trained"] is False


def test_fastapi_endpoints_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient
    import main as main_mod

    isolated_registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    monkeypatch.setattr(main_mod, "registry", isolated_registry)
    client = TestClient(main_mod.app)

    # 1. Health endpoint
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["pretrained_global_model"] is False

    # 2. Incremental baseline collection (19 clean + 1 poor_contact ignored -> not yet trained)
    t0 = datetime(2026, 11, 25, 14, 0, tzinfo=timezone.utc)
    poor_resp = client.post(
        "/baseline/collect",
        json={
            "patient_id": "api_pt_1",
            "source": "esp32_hardware",
            "min_samples": 20,
            "sample": {
                "heart_rate": 72,
                "spo2": 98,
                "temperature_c": None,
                "signal_quality": "poor_contact",
                "timestamp": t0.isoformat(),
            },
        },
    )
    assert poor_resp.status_code == 200
    assert poor_resp.json()["accepted"] is False

    for i in range(19):
        is_walk = i % 4 == 3
        c = client.post(
            "/baseline/collect",
            json={
                "patient_id": "api_pt_1",
                "source": "esp32_hardware",
                "min_samples": 20,
                "sample": {
                    "heart_rate": 98 if is_walk else 70 + (i % 3),
                    "spo2": 98.2,
                    "temperature_c": 36.6,
                    "accel_magnitude": 1.35 if is_walk else 1.0,
                    "gyro_magnitude": 20.0 if is_walk else 3.0,
                    "movement_status": "walking" if is_walk else "resting",
                    "signal_quality": "good",
                    "timestamp": (t0 + timedelta(minutes=i)).isoformat(),
                },
            },
        )
        assert c.status_code == 200
        assert c.json()["trained"] is False

    # 20th clean sample triggers auto-fit of IsolationForest
    c20 = client.post(
        "/baseline/collect",
        json={
            "patient_id": "api_pt_1",
            "source": "esp32_hardware",
            "min_samples": 20,
            "sample": {
                "heart_rate": 71,
                "spo2": 98.3,
                "temperature_c": 36.6,
                "movement_status": "resting",
                "signal_quality": "good",
                "timestamp": (t0 + timedelta(minutes=19)).isoformat(),
            },
        },
    )
    assert c20.status_code == 200
    assert c20.json()["trained"] is True
    assert str(c20.json()["model_version"]).startswith("iforest-v2-esp32_hardware-")

    # 3. Model status endpoint
    st = client.get("/model/status/api_pt_1", params={"source": "esp32_hardware"})
    assert st.status_code == 200
    assert st.json()["trained"] is True
    assert st.json()["sample_count"] == 20

    # 4. Normal window + missing temp + ECG lead-off
    norm = client.post(
        "/analyze",
        json={
            "patient_id": "api_pt_1",
            "source": "esp32_hardware",
            "timestamp": (t0 + timedelta(minutes=20)).isoformat(),
            "heart_rate": 71.0,
            "spo2": 98.2,
            "temperature_c": None,
            "movement_status": "resting",
            "ecg_samples": [2048.0] * 40,
            "ecg_lead_off": True,
        },
    )
    assert norm.status_code == 200
    assert norm.json()["anomaly_status"] == "normal"
    assert norm.json()["alert_level"] == "Normal"
    assert "lead-off" in norm.json()["explanation"].lower()

    # 5. Poor signal quality pauses scoring
    poor_an = client.post(
        "/analyze",
        json={
            "patient_id": "api_pt_1",
            "source": "esp32_hardware",
            "timestamp": (t0 + timedelta(minutes=21)).isoformat(),
            "heart_rate": None,
            "spo2": None,
            "finger_detected": False,
            "ir_signal_ok": False,
        },
    )
    assert poor_an.status_code == 200
    assert poor_an.json()["anomaly_status"] == "paused_poor_quality"
    assert poor_an.json()["alert_level"] == "Normal"

    # 6. Sustained anomalous window triggers Warning/Critical
    for step in range(2):
        abn = client.post(
            "/analyze",
            json={
                "patient_id": "api_pt_1",
                "source": "esp32_hardware",
                "timestamp": (t0 + timedelta(minutes=22 + step)).isoformat(),
                "heart_rate": 118.0,
                "spo2": 92.2,
                "temperature_c": 38.4,
                "movement_status": "resting",
            },
        )
        assert abn.status_code == 200
    assert abn.json()["anomaly_status"] == "anomalous"
    assert abn.json()["alert_level"] in ("Warning", "Critical")

    # 7. Reset endpoint clears model & disk bundle
    rst = client.post("/baseline/reset", json={"patient_id": "api_pt_1"})
    assert rst.status_code == 200
    assert rst.json()["removed_models"] == 1
    assert client.get("/model/status/api_pt_1").json()["trained"] is False


def test_stage1_11_feature_contract_and_dataset_playback_isolation(tmp_path: Path) -> None:
    from features import MODEL_FEATURE_NAMES

    assert MODEL_FEATURE_NAMES == [
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
    assert len(MODEL_FEATURE_NAMES) == 11

    registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    t0 = datetime(2026, 11, 26, 8, 0, tzinfo=timezone.utc)

    # 1. Real esp32_hardware MUST keep strict optical quality gate even if available_modalities is passed
    hw_missing_optical = registry.analyze(
        patient_id="pt_stage1",
        heart_rate=None,
        spo2=None,
        temperature_c=36.6,
        accel_magnitude=1.0,
        gyro_magnitude=3.0,
        source="esp32_hardware",
        available_modalities={"heartRate": False, "spo2": False, "imu": True},
    )
    assert hw_missing_optical["signal_quality"] == "poor_contact"
    assert hw_missing_optical["anomaly_status"] == "paused_poor_quality"

    # 2. dataset_playback IMU-only (e.g. SisFall/UMAFall) fits 11-feature Isolation Forest cleanly without HR/SpO2
    imu_modalities = {"heartRate": False, "spo2": False, "imu": True, "temperatureC": False}
    imu_samples = [
        WindowReading(
            timestamp_sec=(t0 + timedelta(seconds=i * 10)).timestamp(),
            heart_rate=None,
            spo2=None,
            temperature_c=None,
            accel_magnitude=1.0 + (i % 3) * 0.04,
            gyro_magnitude=4.0 + (i % 2) * 1.5,
            movement_status="resting" if i % 4 != 3 else "walking",
            signal_quality="good",
        )
        for i in range(24)
    ]
    ds_model = registry.fit_patient_baseline(
        patient_id="pt_stage1",
        samples=imu_samples,
        source="dataset_playback",
        min_samples=20,
        available_modalities=imu_modalities,
    )
    assert ds_model.source == "dataset_playback"
    assert len(ds_model.feature_names) == 11

    # 3. dataset_playback baseline is strictly isolated from esp32_hardware and simulator
    assert registry.get_status("pt_stage1", source="esp32_hardware")["trained"] is False
    assert registry.get_status("pt_stage1", source="simulator")["trained"] is False
    assert registry.get_status("pt_stage1", source="dataset_playback")["trained"] is True

    # 4. IMU-only dataset_playback scores normal resting reading cleanly (not paused_poor_quality)
    ds_normal = registry.analyze(
        patient_id="pt_stage1",
        heart_rate=None,
        spo2=None,
        temperature_c=None,
        accel_magnitude=1.02,
        gyro_magnitude=4.5,
        movement_status="resting",
        source="dataset_playback",
        timestamp=(t0 + timedelta(minutes=10)).isoformat(),
        available_modalities=imu_modalities,
    )
    assert ds_normal["signal_quality"] == "good"
    assert ds_normal["model_trained"] is True
    assert ds_normal["anomaly_status"] == "normal"
    assert ds_normal["alert_level"] == "Normal"

    # 5. Wrist skin temperature (e.g., 28.5 C) accepted for dataset_playback with temperature_site='skin_wrist'
    wrist_quality, _ = registry.validate_sensor_quality(
        heart_rate=72.0,
        spo2=None,
        temperature_c=28.5,
        accel_magnitude=1.0,
        source="dataset_playback",
        available_modalities={"heartRate": True, "spo2": False, "temperatureC": True},
        temperature_site="skin_wrist",
    )
    assert wrist_quality == "good"

    # Whereas 28.5 C on esp32_hardware remains poor_contact
    hw_temp_quality, _ = registry.validate_sensor_quality(
        heart_rate=72.0,
        spo2=98.0,
        temperature_c=28.5,
        accel_magnitude=1.0,
        source="esp32_hardware",
        temperature_site="skin_wrist",
    )
    assert hw_temp_quality == "poor_contact"


def test_high_gyro_vector_magnitude_accepted_in_fastapi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient
    import main as main_mod

    isolated_registry = AnomalyDetectorRegistry(model_dir=tmp_path)
    monkeypatch.setattr(main_mod, "registry", isolated_registry)
    client = TestClient(main_mod.app)

    # 3-axis ITG3200 (±2000 deg/s per axis) vector magnitude can reach ~3464 deg/s during rapid falls
    res = client.post(
        "/analyze",
        json={
            "patient_id": "ds_sisfall_SA01_F01",
            "source": "dataset_playback",
            "heart_rate": None,
            "spo2": None,
            "temperature_c": None,
            "accel_magnitude": 4.2,
            "gyro_magnitude": 2450.0,
            "movement_status": "fall_suspect",
            "possible_fall_detected": True,
            "available_modalities": {
                "heartRate": False,
                "spo2": False,
                "temperatureC": False,
                "imu": True,
                "ecg": False,
            },
        },
    )
    assert res.status_code == 200
    assert res.json()["signal_quality"] in ("good", "noisy")



