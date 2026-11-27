from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any, Deque, Dict, List, Optional, Tuple

import joblib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from alert_engine import AlertDecisionConfig, AlertDecisionEngine
from baseline import (
    PersonalBaselineSummary,
    WindowReading,
    compute_personal_baseline_stats,
    parse_timestamp_sec,
    should_include_for_baseline_update,
)
from ecg_features import EcgFeatureSummary
from preprocessing import (
    MODEL_FEATURE_NAMES,
    PatientWindowStore,
    build_feature_dataframe,
    extract_windowed_features,
)
from validation import (
    ALLOWED_BASELINE_SOURCES,
    SIMULATED_SOURCES,
    is_clean_baseline_candidate,
    validate_sensor_quality as _validate_sensor_quality,
)


DEFAULT_MODEL_DIR = Path(os.environ.get("SMARTCARE_MODEL_DIR", Path(__file__).parent / "models"))


def _safe_key(val: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", val)[:64] or "unknown"


@dataclass
class DetectionConfig:
    contamination: float = 0.05
    n_estimators: int = 150
    baseline_min_samples: int = 20
    warning_persistence_windows: int = 2
    critical_persistence_windows: int = 3
    anomaly_score_warning: float = -0.05
    anomaly_score_critical: float = -0.18
    z_score_warning: float = 2.0
    z_score_critical: float = 3.0
    retrain_interval: int = 10


@dataclass
class PatientBaselineModel:
    patient_id: str
    source: str
    scaler: StandardScaler
    model: IsolationForest
    baseline: PersonalBaselineSummary
    sample_count: int
    contamination: float
    model_version: str
    trained_at: str
    feature_names: List[str]
    updated_at: Optional[str] = None
    n_estimators: int = 150
    retrain_count: int = 0


def _build_plain_language_explanations(
    triggered_metrics: List[str],
    anomaly_status: str,
    signal_quality: str,
    matched_context: str,
) -> List[str]:
    if anomaly_status == "paused_poor_quality" or signal_quality == "poor_contact":
        return [
            "Sensor contact or signal quality is insufficient; anomaly detection is paused until clean readings resume."
        ]
    if anomaly_status == "insufficient_baseline":
        return [
            "Still learning this patient's personal baseline from clean historical readings."
        ]
    if anomaly_status != "anomalous":
        return [
            f"Readings align with this patient's learned {matched_context} baseline."
        ]

    explanations: List[str] = []
    for metric in triggered_metrics:
        low = metric.lower()
        if "heart rate" in low and "ecg" not in low:
            explanations.append("Heart-rate reading differs from this patient's learned baseline.")
        elif "spo2" in low:
            explanations.append("Blood oxygen (SpO2) reading differs from this patient's learned baseline.")
        elif "temperature" in low:
            explanations.append("Temperature reading differs from this patient's learned baseline.")
        elif "movement" in low or "fall" in low:
            explanations.append("Movement pattern differs from this patient's learned baseline.")
        elif "ecg" in low:
            explanations.append("AD8232 ECG rate differs from this patient's learned baseline.")

    if not explanations:
        explanations.append(
            "Combined sensor measurements form an unusual pattern compared with this patient's learned baseline."
        )
    return explanations


class AnomalyDetectorRegistry:
    """
    Per-patient, source-separated personalized Isolation Forest registry with:
    - Quality-filtered incremental baseline collection (esp32_hardware kept strictly separate from simulator; sample_demo excluded)
    - Mean, median, and standard deviation personal baseline tracking (excluding invalid & anomalous readings)
    - Pandas + scikit-learn windowed feature extraction and IsolationForest scoring
    - Joblib + JSON disk persistence & model versioning
    - Separate AlertDecisionEngine with multi-window persistence and non-diagnostic explanations
    """

    MIN_IFOREST_TRAINING_SAMPLES = 20

    def __init__(self, model_dir: Optional[Path] = None, config: Optional[DetectionConfig] = None) -> None:
        self.model_dir = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.config = config or DetectionConfig()
        self._models: Dict[Tuple[str, str], PatientBaselineModel] = {}
        self._pending_samples: Dict[Tuple[str, str], List[WindowReading]] = {}
        self._incremental_since_fit: Dict[Tuple[str, str], int] = {}
        self._history: Dict[Tuple[str, str], Deque[Dict[str, Any]]] = {}
        self.window_store = PatientWindowStore()
        self.alert_engine = AlertDecisionEngine()
        self._load_persisted_models()

    def _model_paths(self, patient_id: str, source: str) -> Tuple[Path, Path]:
        stem = f"{_safe_key(patient_id)}__{_safe_key(source)}"
        return self.model_dir / f"{stem}.joblib", self.model_dir / f"{stem}.meta.json"

    def _load_persisted_models(self) -> None:
        for meta_path in self.model_dir.glob("*.meta.json"):
            bundle_path = meta_path.with_name(meta_path.name.replace(".meta.json", ".joblib"))
            if not bundle_path.exists():
                continue
            try:
                payload = joblib.load(bundle_path)
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                baseline = payload["baseline"]
                # Backfill overall_medians for any legacy persisted models
                if not getattr(baseline, "overall_medians", None):
                    baseline.overall_medians = dict(baseline.overall_means)
                entry = PatientBaselineModel(
                    patient_id=meta["patient_id"],
                    source=meta["source"],
                    scaler=payload["scaler"],
                    model=payload["model"],
                    baseline=baseline,
                    sample_count=int(meta["sample_count"]),
                    contamination=float(meta["contamination"]),
                    model_version=meta["model_version"],
                    trained_at=meta["trained_at"],
                    updated_at=meta.get("updated_at") or meta["trained_at"],
                    n_estimators=int(meta.get("n_estimators", 150)),
                    retrain_count=int(meta.get("retrain_count", 0)),
                    feature_names=list(meta.get("feature_names", MODEL_FEATURE_NAMES)),
                )
                self._models[(entry.patient_id, entry.source)] = entry
            except Exception:
                continue

    def _persist_model(self, entry: PatientBaselineModel) -> None:
        bundle_path, meta_path = self._model_paths(entry.patient_id, entry.source)
        joblib.dump(
            {
                "scaler": entry.scaler,
                "model": entry.model,
                "baseline": entry.baseline,
            },
            bundle_path,
        )
        meta = {
            "patient_id": entry.patient_id,
            "source": entry.source,
            "sample_count": entry.sample_count,
            "contamination": entry.contamination,
            "n_estimators": entry.n_estimators,
            "retrain_count": entry.retrain_count,
            "model_version": entry.model_version,
            "trained_at": entry.trained_at,
            "updated_at": entry.updated_at or entry.trained_at,
            "feature_names": entry.feature_names,
            "overall_means": entry.baseline.overall_means,
            "overall_medians": entry.baseline.overall_medians,
            "overall_stds": entry.baseline.overall_stds,
            "resting_samples": entry.baseline.resting.sample_count if entry.baseline.resting else 0,
            "active_samples": entry.baseline.active.sample_count if entry.baseline.active else 0,
            "ecg_sample_count": entry.baseline.ecg_sample_count,
            "ecg_model_trained": False,
        }
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def get_config(self) -> Dict[str, Any]:
        return asdict(self.config)

    def update_config(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        if "contamination" in patch and patch["contamination"] is not None:
            val = float(patch["contamination"])
            if 0.0 < val < 0.5:
                self.config.contamination = val
        if "n_estimators" in patch and patch["n_estimators"] is not None:
            self.config.n_estimators = max(25, min(500, int(patch["n_estimators"])))
        if "baseline_min_samples" in patch and patch["baseline_min_samples"] is not None:
            self.config.baseline_min_samples = max(5, min(5000, int(patch["baseline_min_samples"])))
        if "warning_persistence_windows" in patch and patch["warning_persistence_windows"] is not None:
            self.config.warning_persistence_windows = max(1, min(10, int(patch["warning_persistence_windows"])))
        if "critical_persistence_windows" in patch and patch["critical_persistence_windows"] is not None:
            self.config.critical_persistence_windows = max(1, min(15, int(patch["critical_persistence_windows"])))
        if "anomaly_score_warning" in patch and patch["anomaly_score_warning"] is not None:
            self.config.anomaly_score_warning = max(-1.0, min(0.5, float(patch["anomaly_score_warning"])))
        if "anomaly_score_critical" in patch and patch["anomaly_score_critical"] is not None:
            self.config.anomaly_score_critical = max(-1.0, min(0.5, float(patch["anomaly_score_critical"])))
        if "z_score_warning" in patch and patch["z_score_warning"] is not None:
            self.config.z_score_warning = max(1.0, min(6.0, float(patch["z_score_warning"])))
        if "z_score_critical" in patch and patch["z_score_critical"] is not None:
            self.config.z_score_critical = max(1.5, min(8.0, float(patch["z_score_critical"])))
        if "retrain_interval" in patch and patch["retrain_interval"] is not None:
            self.config.retrain_interval = max(3, min(100, int(patch["retrain_interval"])))
        return self.get_config()

    def reset_patient(self, patient_id: str, source: Optional[str] = None) -> int:
        sources = [source] if source else list(ALLOWED_BASELINE_SOURCES)
        removed = 0
        for src in sources:
            key = (patient_id, src)
            if key in self._models:
                del self._models[key]
                removed += 1
            self._pending_samples.pop(key, None)
            self._incremental_since_fit.pop(key, None)
            self._history.pop(key, None)
            bundle_path, meta_path = self._model_paths(patient_id, src)
            bundle_path.unlink(missing_ok=True)
            meta_path.unlink(missing_ok=True)
        self.window_store.clear(patient_id)
        self.alert_engine.clear(patient_id)
        return removed

    def get_history(self, patient_id: str, source: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
        if source is not None:
            items = list(self._history.get((patient_id, source), []))
            return items[-limit:]
        merged: List[Dict[str, Any]] = []
        for (pid, src), dq in self._history.items():
            if pid == patient_id and src != "dataset_playback":
                merged.extend(dq)
        merged.sort(key=lambda r: float(r.get("timestamp_sec", 0.0)))
        return merged[-limit:]

    def get_baseline_summary(self, patient_id: str, source: Optional[str] = None) -> Optional[PersonalBaselineSummary]:
        if source is not None:
            entry = self._models.get((patient_id, source))
            return entry.baseline if entry else None
        priority = {"esp32_hardware": 0, "simulator": 1, "dataset_playback": 2}
        entries = [
            v for (pid, src), v in self._models.items() if pid == patient_id and src != "dataset_playback"
        ]
        if not entries:
            return None
        return sorted(entries, key=lambda e: priority.get(e.source, 3))[0].baseline

    def get_status(self, patient_id: str, source: Optional[str] = None) -> Dict[str, object]:
        if source is not None:
            entries = [self._models[(patient_id, source)]] if (patient_id, source) in self._models else []
        else:
            entries = [
                v
                for (pid, src), v in self._models.items()
                if pid == patient_id and src != "dataset_playback"
            ]
        pending_count = sum(
            len(v)
            for (pid, src), v in self._pending_samples.items()
            if pid == patient_id and (source is None or src == source)
        )
        history_count = len(self.get_history(patient_id, source=source))

        if not entries:
            return {
                "patient_id": patient_id,
                "source": source,
                "trained": False,
                "ecg_model_trained": False,
                "sample_count": pending_count,
                "min_training_samples": self.MIN_IFOREST_TRAINING_SAMPLES,
                "model_version": None,
                "trained_at": None,
                "updated_at": None,
                "contamination": self.config.contamination,
                "means": None,
                "medians": None,
                "stds": None,
                "history_count": history_count,
                "config": self.get_config(),
            }

        priority = {"esp32_hardware": 0, "simulator": 1, "dataset_playback": 2}
        entry = sorted(entries, key=lambda e: priority.get(e.source, 3))[0]
        return {
            "patient_id": patient_id,
            "source": entry.source,
            "trained": True,
            "ecg_model_trained": False,
            "sample_count": entry.sample_count,
            "min_training_samples": self.MIN_IFOREST_TRAINING_SAMPLES,
            "model_version": entry.model_version,
            "trained_at": entry.trained_at,
            "updated_at": entry.updated_at or entry.trained_at,
            "contamination": entry.contamination,
            "n_estimators": entry.n_estimators,
            "retrain_count": entry.retrain_count,
            "means": entry.baseline.overall_means,
            "medians": entry.baseline.overall_medians,
            "stds": entry.baseline.overall_stds,
            "resting_means": entry.baseline.resting.means if entry.baseline.resting else None,
            "resting_medians": entry.baseline.resting.medians if entry.baseline.resting else None,
            "resting_stds": entry.baseline.resting.stds if entry.baseline.resting else None,
            "active_means": entry.baseline.active.means if entry.baseline.active else None,
            "active_medians": entry.baseline.active.medians if entry.baseline.active else None,
            "active_stds": entry.baseline.active.stds if entry.baseline.active else None,
            "ecg_bpm_mean": entry.baseline.ecg_bpm_mean,
            "history_count": history_count,
            "config": self.get_config(),
        }

    def validate_sensor_quality(
        self,
        heart_rate: Optional[float],
        spo2: Optional[float],
        temperature_c: Optional[float],
        accel_magnitude: float,
        ir_signal_ok: bool = True,
        finger_detected: bool = True,
        source: str = "simulator",
        available_modalities: Optional[Dict[str, bool]] = None,
        temperature_site: Optional[str] = None,
    ) -> Tuple[str, List[str]]:
        return _validate_sensor_quality(
            heart_rate=heart_rate,
            spo2=spo2,
            temperature_c=temperature_c,
            accel_magnitude=accel_magnitude,
            ir_signal_ok=ir_signal_ok,
            finger_detected=finger_detected,
            source=source,
            available_modalities=available_modalities,
            temperature_site=temperature_site,
        )

    def _is_clean_baseline_sample(
        self,
        s: WindowReading,
        source: str = "simulator",
        available_modalities: Optional[Dict[str, bool]] = None,
        temperature_site: Optional[str] = None,
    ) -> bool:
        return is_clean_baseline_candidate(
            heart_rate=s.heart_rate,
            spo2=s.spo2,
            temperature_c=s.temperature_c,
            accel_magnitude=s.accel_magnitude,
            signal_quality=s.signal_quality,
            source=source,
            available_modalities=available_modalities,
            temperature_site=temperature_site,
        )

    def fit_patient_baseline(
        self,
        patient_id: str,
        samples: List[WindowReading],
        source: str = "simulator",
        contamination: Optional[float] = None,
        min_samples: int = 20,
        available_modalities: Optional[Dict[str, bool]] = None,
        temperature_site: Optional[str] = None,
        retrain_count: int = 0,
    ) -> PatientBaselineModel:
        if source not in ALLOWED_BASELINE_SOURCES:
            raise ValueError(
                f"Source '{source}' cannot train a personalized baseline. Only esp32_hardware, simulator, or dataset_playback readings are allowed."
            )

        clean_samples = [
            s
            for s in samples
            if self._is_clean_baseline_sample(
                s,
                source=source,
                available_modalities=available_modalities if source == "dataset_playback" else None,
                temperature_site=temperature_site if source == "dataset_playback" else None,
            )
        ]

        required = max(self.MIN_IFOREST_TRAINING_SAMPLES, min_samples)
        if len(clean_samples) < required:
            raise ValueError(
                f"At least {required} quality-filtered ('good') baseline samples are required to fit the 11-feature Isolation Forest (got {len(clean_samples)})."
            )

        eff_contamination = float(contamination if contamination is not None else self.config.contamination)
        clean_samples.sort(key=lambda s: s.timestamp_sec)
        baseline_summary = compute_personal_baseline_stats(clean_samples)

        feature_df = build_feature_dataframe(
            patient_id=patient_id,
            source=source,
            samples=clean_samples,
            baseline=baseline_summary,
        )
        matrix = feature_df.to_numpy(dtype=float)

        scaler = StandardScaler()
        scaled = scaler.fit_transform(matrix)

        model = IsolationForest(
            n_estimators=self.config.n_estimators,
            contamination=eff_contamination,
            random_state=42,
        )
        model.fit(scaled)

        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()
        existing = self._models.get((patient_id, source))
        version = f"iforest-v2-{source}-{now.strftime('%Y%m%d%H%M%S')}"
        entry = PatientBaselineModel(
            patient_id=patient_id,
            source=source,
            scaler=scaler,
            model=model,
            baseline=baseline_summary,
            sample_count=len(clean_samples),
            contamination=eff_contamination,
            model_version=version,
            trained_at=existing.trained_at if (existing and retrain_count > 0) else now_iso,
            updated_at=now_iso,
            n_estimators=self.config.n_estimators,
            retrain_count=retrain_count,
            feature_names=list(MODEL_FEATURE_NAMES),
        )
        self._models[(patient_id, source)] = entry
        self._pending_samples[(patient_id, source)] = list(clean_samples[-500:])
        self._incremental_since_fit[(patient_id, source)] = 0
        self._persist_model(entry)
        return entry

    def collect_baseline_sample(
        self,
        patient_id: str,
        sample: WindowReading,
        source: str,
        min_samples: int = 20,
        auto_fit: bool = True,
        available_modalities: Optional[Dict[str, bool]] = None,
        temperature_site: Optional[str] = None,
    ) -> Dict[str, object]:
        effective_min = max(self.MIN_IFOREST_TRAINING_SAMPLES, min_samples)
        if source not in ALLOWED_BASELINE_SOURCES:
            return {
                "accepted": False,
                "reason": f"Source '{source}' ignored for personalized baseline collection.",
                "collected_count": len(self._pending_samples.get((patient_id, source), [])),
                "required_samples": effective_min,
                "trained": (patient_id, source) in self._models,
            }

        eff_modalities = available_modalities if source == "dataset_playback" else None
        eff_temp_site = temperature_site if source == "dataset_playback" else None

        if not self._is_clean_baseline_sample(
            sample,
            source=source,
            available_modalities=eff_modalities,
            temperature_site=eff_temp_site,
        ):
            return {
                "accepted": False,
                "reason": "Sample excluded because sensor signal_quality is not 'good' or values are invalid/null.",
                "collected_count": len(self._pending_samples.get((patient_id, source), [])),
                "required_samples": effective_min,
                "trained": (patient_id, source) in self._models,
            }

        key = (patient_id, source)
        buf = self._pending_samples.setdefault(key, [])
        buf.append(sample)
        if len(buf) > 500:
            del buf[:-500]

        if auto_fit and len(buf) >= effective_min and key not in self._models:
            fitted = self.fit_patient_baseline(
                patient_id=patient_id,
                samples=buf,
                source=source,
                min_samples=effective_min,
                available_modalities=eff_modalities,
                temperature_site=eff_temp_site,
            )
            return {
                "accepted": True,
                "collected_count": len(buf),
                "required_samples": effective_min,
                "trained": True,
                "model_version": fitted.model_version,
                "means": fitted.baseline.overall_means,
                "medians": fitted.baseline.overall_medians,
                "stds": fitted.baseline.overall_stds,
            }

        return {
            "accepted": True,
            "collected_count": len(buf),
            "required_samples": effective_min,
            "trained": key in self._models,
            "model_version": self._models[key].model_version if key in self._models else None,
        }

    def analyze(
        self,
        patient_id: str,
        heart_rate: Optional[float],
        spo2: Optional[float],
        temperature_c: Optional[float],
        accel_magnitude: float,
        gyro_magnitude: float,
        movement_status: str = "resting",
        possible_fall_detected: bool = False,
        ir_signal_ok: bool = True,
        finger_detected: bool = True,
        ecg_summary: Optional[EcgFeatureSummary] = None,
        source: str = "simulator",
        timestamp: Optional[str] = None,
        config: Optional[AlertDecisionConfig] = None,
        available_modalities: Optional[Dict[str, bool]] = None,
        temperature_site: Optional[str] = None,
        allow_baseline_training: bool = True,
    ) -> Dict[str, object]:
        cfg = config or AlertDecisionConfig(
            baseline_min_samples=self.config.baseline_min_samples,
            warning_persistence_windows=self.config.warning_persistence_windows,
            critical_persistence_windows=self.config.critical_persistence_windows,
            anomaly_score_warning=self.config.anomaly_score_warning,
            anomaly_score_critical=self.config.anomaly_score_critical,
            z_score_warning=self.config.z_score_warning,
            z_score_critical=self.config.z_score_critical,
        )
        is_dataset = source == "dataset_playback"
        eff_modalities = available_modalities if is_dataset else None
        eff_temp_site = temperature_site if is_dataset else None
        hr_expected = (not is_dataset) or ((eff_modalities or {}).get("heartRate", True) is not False)
        spo2_expected = (not is_dataset) or ((eff_modalities or {}).get("spo2", True) is not False)

        quality, quality_notes = self.validate_sensor_quality(
            heart_rate=heart_rate,
            spo2=spo2,
            temperature_c=temperature_c,
            accel_magnitude=accel_magnitude,
            ir_signal_ok=ir_signal_ok,
            finger_detected=finger_detected,
            source=source,
            available_modalities=eff_modalities,
            temperature_site=eff_temp_site,
        )

        ecg_lead_off = bool(ecg_summary and ecg_summary.signal_quality == "lead_off")
        ecg_note = " AD8232 ECG electrodes report lead-off." if ecg_lead_off else ""
        ts_sec = parse_timestamp_sec(timestamp)
        ts_iso = timestamp or datetime.fromtimestamp(ts_sec, tz=timezone.utc).isoformat()

        reading = WindowReading(
            timestamp_sec=ts_sec,
            heart_rate=heart_rate,
            spo2=spo2,
            temperature_c=temperature_c,
            accel_magnitude=accel_magnitude,
            gyro_magnitude=gyro_magnitude,
            movement_status=movement_status,
            signal_quality=quality,
            ecg_bpm=ecg_summary.estimated_ecg_bpm if ecg_summary else None,
            ecg_rri_ms=ecg_summary.rr_interval_mean_ms if ecg_summary else None,
            ecg_hrv_ms=ecg_summary.rr_variability_ms if ecg_summary else None,
            ecg_signal_quality=ecg_summary.signal_quality if ecg_summary else "unavailable",
            ecg_lead_off=ecg_lead_off,
            source=source,
        )

        window = self.window_store.append_and_get(patient_id, source, reading)
        entry = self._models.get((patient_id, source))
        pending_count = len(self._pending_samples.get((patient_id, source), []))

        extracted = extract_windowed_features(
            window=window,
            baseline=entry.baseline if entry else None,
            ecg_summary=ecg_summary,
        )

        raw_score: Optional[float] = None
        prediction: Optional[int] = None
        if (
            entry is not None
            and quality != "poor_contact"
            and (not hr_expected or heart_rate is not None)
            and (not spo2_expected or spo2 is not None)
        ):
            vec = np.array([extracted.feature_vector], dtype=float)
            scaled = entry.scaler.transform(vec)
            raw_score = float(entry.model.decision_function(scaled)[0])
            prediction = int(entry.model.predict(scaled)[0])

        decision = self.alert_engine.evaluate(
            patient_id=patient_id,
            source=source,
            signal_quality=quality,
            quality_notes=quality_notes,
            ecg_note=ecg_note,
            model_trained=entry is not None,
            collected_baseline_samples=entry.sample_count if entry else pending_count,
            heart_rate=heart_rate,
            spo2=spo2,
            temperature_c=temperature_c,
            accel_magnitude=accel_magnitude,
            movement_status=movement_status,
            possible_fall_detected=possible_fall_detected,
            raw_anomaly_score=raw_score,
            iforest_prediction=prediction,
            features=extracted,
            config=cfg,
            hr_expected=hr_expected,
            spo2_expected=spo2_expected,
        )

        # Incremental baseline learning ONLY on clean normal readings (never invalid/noisy/anomalous)
        if entry is not None and should_include_for_baseline_update(
            reading=reading,
            source=source,
            anomaly_status=decision.anomaly_status,
            alert_level=decision.alert_level,
            possible_fall_detected=possible_fall_detected,
            allow_baseline_training=allow_baseline_training,
            available_modalities=eff_modalities,
            temperature_site=eff_temp_site,
        ):
            key = (patient_id, source)
            buf = self._pending_samples.setdefault(key, [])
            buf.append(reading)
            if len(buf) > 500:
                del buf[:-500]
            if len(buf) >= self.MIN_IFOREST_TRAINING_SAMPLES:
                entry.baseline = compute_personal_baseline_stats(buf)
                entry.sample_count = len(buf)
                entry.updated_at = datetime.now(timezone.utc).isoformat()
                inc = self._incremental_since_fit.get(key, 0) + 1
                self._incremental_since_fit[key] = inc
                if inc >= self.config.retrain_interval:
                    entry = self.fit_patient_baseline(
                        patient_id=patient_id,
                        samples=buf,
                        source=source,
                        contamination=entry.contamination,
                        min_samples=self.MIN_IFOREST_TRAINING_SAMPLES,
                        available_modalities=eff_modalities,
                        temperature_site=eff_temp_site,
                        retrain_count=entry.retrain_count + 1,
                    )

        plain_explanations = _build_plain_language_explanations(
            triggered_metrics=decision.triggered_metrics,
            anomaly_status=decision.anomaly_status,
            signal_quality=quality,
            matched_context=extracted.matched_baseline_context,
        )

        scored_val = round(raw_score, 4) if raw_score is not None else 0.0
        history_entry: Dict[str, Any] = {
            "patient_id": patient_id,
            "source": source,
            "is_simulated": source in SIMULATED_SOURCES,
            "timestamp": ts_iso,
            "timestamp_sec": ts_sec,
            "heart_rate": heart_rate,
            "spo2": spo2,
            "temperature_c": temperature_c,
            "accel_magnitude": accel_magnitude,
            "gyro_magnitude": gyro_magnitude,
            "movement_status": movement_status,
            "signal_quality": quality,
            "anomaly_score": scored_val,
            "anomaly_status": decision.anomaly_status,
            "alert_level": decision.alert_level,
            "contributing_features": decision.contributing_summary,
            "plain_language_explanations": plain_explanations,
        }
        hist_dq = self._history.setdefault((patient_id, source), deque(maxlen=300))
        hist_dq.append(history_entry)

        return {
            "patient_id": patient_id,
            "timestamp": ts_iso,
            "source": source,
            "is_simulated": source in SIMULATED_SOURCES,
            "sensor_values": {
                "heart_rate": heart_rate,
                "spo2": spo2,
                "temperature_c": temperature_c,
                "accel_magnitude": accel_magnitude,
                "gyro_magnitude": gyro_magnitude,
                "movement_status": movement_status,
            },
            "model_trained": entry is not None,
            "model_version": entry.model_version if entry else None,
            "model_metadata": (
                {
                    "model_version": entry.model_version,
                    "trained_at": entry.trained_at,
                    "updated_at": entry.updated_at or entry.trained_at,
                    "contamination": entry.contamination,
                    "n_estimators": entry.n_estimators,
                    "sample_count": entry.sample_count,
                    "retrain_count": entry.retrain_count,
                    "source": entry.source,
                    "engine": "scikit-learn IsolationForest",
                }
                if entry is not None
                else None
            ),
            "baseline_stats": (
                {
                    "means": entry.baseline.overall_means,
                    "medians": entry.baseline.overall_medians,
                    "stds": entry.baseline.overall_stds,
                    "sample_count": entry.sample_count,
                    "updated_at": entry.baseline.updated_at,
                }
                if entry is not None
                else None
            ),
            "ecg_model_trained": False,
            "signal_quality": quality,
            "anomaly_status": decision.anomaly_status,
            "anomaly_score": scored_val,
            "alert_level": decision.alert_level,
            "triggered_metrics": decision.triggered_metrics,
            "contributing_features": decision.contributing_summary,
            "contributing_details": extracted.contributing_features[:5],
            "plain_language_explanations": plain_explanations,
            "persistence_count": decision.persistence_count,
            "persistence_required": decision.persistence_required,
            "matched_baseline_context": extracted.matched_baseline_context,
            "window_size": extracted.window_size,
            "explanation": decision.explanation,
        }
