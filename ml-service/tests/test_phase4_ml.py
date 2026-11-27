from pathlib import Path
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from detector import AnomalyDetectorRegistry, DetectionConfig  # noqa: E402
from features import WindowReading  # noqa: E402
import main as ml_main  # noqa: E402


def _make_baseline_samples(count: int = 25, base_hr: float = 70.0, base_spo2: float = 98.0, base_temp: float = 36.6):
    samples = []
    for i in range(count):
        movement = "active" if i >= count - 6 else "resting"
        hr = base_hr + (14.0 if movement == "active" else (i % 5) - 2)
        samples.append(
            WindowReading(
                timestamp_sec=1700000000.0 + i * 5.0,
                heart_rate=hr,
                spo2=base_spo2 - (0.3 if i % 4 == 0 else 0.0),
                temperature_c=base_temp + (0.05 if i % 2 == 0 else -0.05),
                accel_magnitude=1.22 if movement == "active" else 1.0,
                gyro_magnitude=32.0 if movement == "active" else 4.0,
                movement_status=movement,
                signal_quality="good",
                source="simulator",
            )
        )
    return samples


def test_normal_vs_unusual_explanations_and_anomaly_exclusion():
    with tempfile.TemporaryDirectory() as tmp:
        reg = AnomalyDetectorRegistry(
            model_dir=Path(tmp) / "models",
            config=DetectionConfig(retrain_interval=5),
        )
        reg.fit_patient_baseline("pt_p4", _make_baseline_samples(24), source="simulator", min_samples=20)
        before = reg.get_baseline_summary("pt_p4", source="simulator")
        assert before is not None
        assert "heart_rate" in before.overall_means
        assert "heart_rate" in before.overall_medians
        assert "heart_rate" in before.overall_stds
        hr_mean_before = before.overall_means["heart_rate"]
        count_before = before.sample_count

        # Normal reading updates baseline incrementally
        res_norm = reg.analyze(
            patient_id="pt_p4",
            heart_rate=70.5,
            spo2=98.1,
            temperature_c=36.6,
            accel_magnitude=1.01,
            gyro_magnitude=4.2,
            movement_status="resting",
            source="simulator",
            timestamp="2026-11-27T10:00:00Z",
        )
        assert res_norm["anomaly_status"] == "normal"
        assert res_norm["signal_quality"] == "good"
        assert res_norm["is_simulated"] is True
        assert res_norm["baseline_stats"] is not None
        assert "medians" in res_norm["baseline_stats"]
        assert "diagnosis" not in res_norm["explanation"].lower()
        assert reg.get_baseline_summary("pt_p4", source="simulator").sample_count == count_before + 1

        # Unusual reading across 3 windows must flag anomalous + generate plain-language explanation
        # AND must NEVER be absorbed into baseline statistics
        for idx in range(3):
            res_anom = reg.analyze(
                patient_id="pt_p4",
                heart_rate=142.0,
                spo2=88.0,
                temperature_c=38.6,
                accel_magnitude=1.05,
                gyro_magnitude=5.0,
                movement_status="resting",
                source="simulator",
                timestamp=f"2026-11-27T10:01:0{idx}Z",
            )
        assert res_anom["anomaly_status"] == "anomalous"
        assert res_anom["alert_level"] in {"Warning", "Critical"}
        explanations = res_anom["plain_language_explanations"]
        assert any("differs from this patient's learned baseline" in e for e in explanations)
        after = reg.get_baseline_summary("pt_p4", source="simulator")
        assert after.sample_count == count_before + 1
        assert abs(after.overall_means["heart_rate"] - hr_mean_before) < 1.0


def test_missing_invalid_noisy_insufficient_and_multi_patient_isolation():
    with tempfile.TemporaryDirectory() as tmp:
        reg = AnomalyDetectorRegistry(model_dir=Path(tmp) / "models")

        # Insufficient historical data (<20 samples)
        res_insuff = reg.analyze(
            patient_id="pt_new",
            heart_rate=74.0,
            spo2=98.0,
            temperature_c=36.7,
            accel_magnitude=1.0,
            gyro_magnitude=3.0,
            source="esp32_hardware",
        )
        assert res_insuff["anomaly_status"] == "insufficient_baseline"
        assert res_insuff["is_simulated"] is False

        # Missing optical readings -> paused_poor_quality
        res_missing = reg.analyze(
            patient_id="pt_new",
            heart_rate=None,
            spo2=None,
            temperature_c=None,
            accel_magnitude=1.0,
            gyro_magnitude=3.0,
            finger_detected=False,
            ir_signal_ok=False,
            source="esp32_hardware",
        )
        assert res_missing["signal_quality"] == "poor_contact"
        assert res_missing["anomaly_status"] == "paused_poor_quality"

        # Invalid out-of-range temperature -> paused_poor_quality
        res_invalid = reg.analyze(
            patient_id="pt_new",
            heart_rate=72.0,
            spo2=98.0,
            temperature_c=15.0,
            accel_magnitude=1.0,
            gyro_magnitude=3.0,
            source="esp32_hardware",
        )
        assert res_invalid["signal_quality"] == "poor_contact"

        # High movement artifact -> noisy + excluded from baseline collection
        res_noisy = reg.analyze(
            patient_id="pt_new",
            heart_rate=85.0,
            spo2=96.0,
            temperature_c=36.6,
            accel_magnitude=3.1,
            gyro_magnitude=90.0,
            movement_status="active",
            source="esp32_hardware",
        )
        assert res_noisy["signal_quality"] == "noisy"
        status_new = reg.get_status("pt_new", source="esp32_hardware")
        assert status_new["sample_count"] == 0

        # Multi-patient isolation: pt_alpha baseline (~58 bpm) vs pt_beta (~94 bpm)
        reg.fit_patient_baseline("pt_alpha", _make_baseline_samples(22, base_hr=58.0), source="simulator")
        reg.fit_patient_baseline("pt_beta", _make_baseline_samples(22, base_hr=94.0), source="simulator")
        assert reg.get_baseline_summary("pt_alpha", "simulator").overall_means["heart_rate"] < 70.0
        assert reg.get_baseline_summary("pt_beta", "simulator").overall_means["heart_rate"] > 85.0


def test_evaluation_labeled_vs_unlabeled_and_matplotlib_graphs(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        isolated = AnomalyDetectorRegistry(model_dir=tmp_path / "models")
        monkeypatch.setattr(ml_main, "registry", isolated)
        monkeypatch.setattr(ml_main, "DEFAULT_GRAPH_DIR", tmp_path / "graphs")
        import evaluation as eval_mod
        monkeypatch.setattr(eval_mod, "DEFAULT_GRAPH_DIR", tmp_path / "graphs")

        client = TestClient(ml_main.app)

        # Update config & verify
        cfg_res = client.put("/config", json={"retrain_interval": 8, "z_score_warning": 2.2})
        assert cfg_res.status_code == 200
        assert cfg_res.json()["config"]["retrain_interval"] == 8

        # Fit baseline + stream normal & anomalous readings
        samples = [
            {
                "heart_rate": 70.0 + (i % 4),
                "spo2": 98.0,
                "temperature_c": 36.6,
                "accel_magnitude": 1.0,
                "gyro_magnitude": 4.0,
                "movement_status": "resting",
                "signal_quality": "good",
                "timestamp": f"2026-11-27T11:00:{i:02d}Z",
            }
            for i in range(22)
        ]
        fit_res = client.post("/baseline/fit", json={"patient_id": "pt_eval", "source": "simulator", "samples": samples})
        assert fit_res.status_code == 200
        assert "medians" in fit_res.json()

        for i in range(4):
            client.post(
                "/analyze",
                json={
                    "patient_id": "pt_eval",
                    "source": "simulator",
                    "heart_rate": 71.0,
                    "spo2": 98.0,
                    "temperature_c": 36.6,
                    "accel_magnitude": 1.0,
                    "gyro_magnitude": 4.0,
                    "timestamp": f"2026-11-27T11:01:{i:02d}Z",
                },
            )
        for i in range(3):
            client.post(
                "/analyze",
                json={
                    "patient_id": "pt_eval",
                    "source": "simulator",
                    "heart_rate": 146.0,
                    "spo2": 87.0,
                    "temperature_c": 38.7,
                    "accel_magnitude": 1.05,
                    "gyro_magnitude": 6.0,
                    "timestamp": f"2026-11-27T11:02:{i:02d}Z",
                },
            )

        # Unlabeled evaluation must NOT fabricate supervised metrics
        eval_unlabeled = client.post("/evaluate", json={"patient_id": "pt_eval", "source": "simulator"})
        assert eval_unlabeled.status_code == 200
        u_data = eval_unlabeled.json()
        assert u_data["labeled_data_available"] is False
        assert u_data["supervised_metrics"] is None
        assert "Accuracy" in u_data["metrics_requiring_labels"]
        assert u_data["unsupervised_metrics"]["anomalous_count"] >= 1

        # Labeled evaluation computes real metrics from ground truth
        hist = client.get("/model/history/pt_eval", params={"source": "simulator"}).json()["readings"]
        labels = [1 if (r.get("heart_rate") or 0) > 120 else 0 for r in hist]
        eval_labeled = client.post(
            "/evaluate",
            json={"patient_id": "pt_eval", "source": "simulator", "readings": hist, "labels": labels},
        )
        assert eval_labeled.status_code == 200
        l_data = eval_labeled.json()
        assert l_data["labeled_data_available"] is True
        assert l_data["supervised_metrics"] is not None
        for key in ("accuracy", "precision", "recall", "f1_score", "confusion_matrix"):
            assert key in l_data["supervised_metrics"]

        # Generate all 7 Matplotlib PNG graphs and verify file serving + path traversal rejection
        graph_res = client.post("/graphs/generate", json={"patient_id": "pt_eval", "source": "simulator"})
        assert graph_res.status_code == 200
        graphs = graph_res.json()["graphs"]
        assert len(graphs) == 7
        for g in graphs:
            file_res = client.get(f"/graphs/file/{g['filename']}")
            assert file_res.status_code == 200
            assert file_res.headers["content-type"] == "image/png"
            assert len(file_res.content) > 1000

        bad_path = client.get("/graphs/file/..%2Fmain.py")
        assert bad_path.status_code in {400, 404}
