from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from alert_engine import AlertDecisionConfig
from detector import AnomalyDetectorRegistry
from ecg_features import EcgFeatureSummary, extract_ecg_features_from_batch
from evaluation import (
    DEFAULT_GRAPH_DIR,
    SAFE_GRAPH_FILENAME_RE,
    evaluate_model_outputs,
    generate_patient_graphs,
)
from features import WindowReading, parse_timestamp_sec


app = FastAPI(
    title="AROVA AI — Isolation Forest Anomaly & Baseline Intelligence Service",
    version="4.0.0",
    description="Personalized source-separated baseline learning (mean/median/std), Pandas preprocessing, scikit-learn Isolation Forest scoring, evaluation metrics, and Matplotlib graph generation.",
)

registry = AnomalyDetectorRegistry()


class BaselineSample(BaseModel):
    heart_rate: Optional[float] = Field(default=None, ge=20, le=260)
    spo2: Optional[float] = Field(default=None, ge=40, le=100)
    temperature_c: Optional[float] = Field(default=None, ge=20, le=45)
    accel_magnitude: float = Field(default=1.0, ge=0, le=100)
    gyro_magnitude: float = Field(default=5.0, ge=0, le=5000)
    movement_status: str = "resting"
    signal_quality: str = "good"
    timestamp: Optional[str] = None
    ecg_bpm: Optional[float] = None
    ecg_rri_ms: Optional[float] = None
    ecg_hrv_ms: Optional[float] = None
    ecg_signal_quality: str = "unavailable"
    ecg_lead_off: bool = False


class BaselineFitRequest(BaseModel):
    patient_id: str
    samples: List[BaselineSample]
    source: str = "simulator"
    contamination: float = Field(default=0.05, gt=0.0, lt=0.5)
    min_samples: int = Field(default=20, ge=5, le=5000)
    available_modalities: Optional[Dict[str, bool]] = None
    temperature_site: Optional[str] = None


class BaselineCollectRequest(BaseModel):
    patient_id: str
    sample: BaselineSample
    source: str = "simulator"
    min_samples: int = Field(default=20, ge=5, le=5000)
    auto_fit: bool = True
    available_modalities: Optional[Dict[str, bool]] = None
    temperature_site: Optional[str] = None


class EcgFeaturesPayload(BaseModel):
    sampling_rate_hz: int = Field(default=200, ge=25, le=1000)
    sample_count: int = Field(default=0, ge=0, le=2000)
    r_peak_count: int = Field(default=0, ge=0, le=200)
    estimated_ecg_bpm: Optional[float] = None
    rr_interval_mean_ms: Optional[float] = None
    rr_variability_ms: Optional[float] = None
    amplitude_range: float = 0.0
    signal_quality: str = "unavailable"


class AnalyzeRequest(BaseModel):
    patient_id: str
    source: str = "simulator"
    timestamp: Optional[str] = None
    heart_rate: Optional[float] = Field(default=None, ge=0, le=260)
    spo2: Optional[float] = Field(default=None, ge=0, le=100)
    temperature_c: Optional[float] = Field(default=None, ge=20, le=45)
    accel_magnitude: float = Field(default=1.0, ge=0, le=100)
    gyro_magnitude: float = Field(default=5.0, ge=0, le=5000)
    movement_status: str = "resting"
    possible_fall_detected: bool = False
    ir_signal_ok: bool = True
    finger_detected: bool = True
    ecg_features: Optional[EcgFeaturesPayload] = None
    ecg_samples: Optional[List[float]] = None
    ecg_sampling_rate: int = Field(default=200, ge=25, le=1000)
    ecg_lead_off: bool = False
    baseline_min_samples: int = Field(default=20, ge=5, le=5000)
    warning_persistence_windows: int = Field(default=2, ge=1, le=10)
    critical_persistence_windows: int = Field(default=3, ge=1, le=15)
    anomaly_score_warning: float = Field(default=-0.05, ge=-1.0, le=0.5)
    available_modalities: Optional[Dict[str, bool]] = None
    temperature_site: Optional[str] = None
    respiratory_rate_bpm: Optional[float] = None
    sleep_stage: Optional[str] = None
    accel_x: Optional[float] = None
    accel_y: Optional[float] = None
    accel_z: Optional[float] = None
    gyro_x: Optional[float] = None
    gyro_y: Optional[float] = None
    gyro_z: Optional[float] = None
    imu_sampling_rate: Optional[float] = None
    fall_metrics: Optional[Dict[str, Any]] = None
    allow_baseline_training: bool = True


class ConfigUpdateRequest(BaseModel):
    contamination: Optional[float] = Field(default=None, gt=0.0, lt=0.5)
    n_estimators: Optional[int] = Field(default=None, ge=25, le=500)
    baseline_min_samples: Optional[int] = Field(default=None, ge=5, le=5000)
    warning_persistence_windows: Optional[int] = Field(default=None, ge=1, le=10)
    critical_persistence_windows: Optional[int] = Field(default=None, ge=1, le=15)
    anomaly_score_warning: Optional[float] = Field(default=None, ge=-1.0, le=0.5)
    anomaly_score_critical: Optional[float] = Field(default=None, ge=-1.0, le=0.5)
    z_score_warning: Optional[float] = Field(default=None, ge=1.0, le=6.0)
    z_score_critical: Optional[float] = Field(default=None, ge=1.5, le=8.0)
    retrain_interval: Optional[int] = Field(default=None, ge=3, le=100)


class EvaluateRequest(BaseModel):
    patient_id: str
    source: Optional[str] = None
    readings: Optional[List[Dict[str, Any]]] = None
    labels: Optional[List[Any]] = None


class GraphGenerateRequest(BaseModel):
    patient_id: str
    source: str = "simulator"
    readings: Optional[List[Dict[str, Any]]] = None


def _to_window_reading(s: BaselineSample, source: str = "simulator") -> WindowReading:
    return WindowReading(
        timestamp_sec=parse_timestamp_sec(s.timestamp),
        heart_rate=s.heart_rate,
        spo2=s.spo2,
        temperature_c=s.temperature_c,
        accel_magnitude=s.accel_magnitude,
        gyro_magnitude=s.gyro_magnitude,
        movement_status=s.movement_status,
        signal_quality=s.signal_quality,
        ecg_bpm=s.ecg_bpm,
        ecg_rri_ms=s.ecg_rri_ms,
        ecg_hrv_ms=s.ecg_hrv_ms,
        ecg_signal_quality=s.ecg_signal_quality,
        ecg_lead_off=s.ecg_lead_off,
        source=source,
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "engine": "scikit-learn IsolationForest",
        "version": "4.0.0",
        "pretrained_global_model": False,
        "ecg_model_trained": False,
        "ecg_feature_extraction": "modular_ready",
        "persistence_enabled": True,
        "pandas_enabled": True,
        "matplotlib_enabled": True,
    }


@app.get("/config")
def get_config() -> dict:
    return {"ok": True, "config": registry.get_config()}


@app.put("/config")
def update_config(req: ConfigUpdateRequest) -> dict:
    updated = registry.update_config(req.model_dump(exclude_none=True))
    return {"ok": True, "config": updated}


@app.get("/model/status/{patient_id}")
def model_status(patient_id: str, source: Optional[str] = None) -> dict:
    return registry.get_status(patient_id, source=source)


@app.get("/model/history/{patient_id}")
def model_history(patient_id: str, source: Optional[str] = None, limit: int = 200) -> dict:
    clamped_limit = max(1, min(500, limit))
    items = registry.get_history(patient_id, source=source, limit=clamped_limit)
    return {
        "patient_id": patient_id,
        "source": source,
        "count": len(items),
        "readings": items,
    }


@app.post("/baseline/collect")
def collect_baseline(req: BaselineCollectRequest) -> dict:
    return registry.collect_baseline_sample(
        patient_id=req.patient_id,
        sample=_to_window_reading(req.sample, source=req.source),
        source=req.source,
        min_samples=req.min_samples,
        auto_fit=req.auto_fit,
        available_modalities=req.available_modalities,
        temperature_site=req.temperature_site,
    )


class BaselineResetRequest(BaseModel):
    patient_id: str
    source: Optional[str] = None


@app.post("/baseline/reset")
def reset_baseline(req: BaselineResetRequest) -> dict:
    removed = registry.reset_patient(req.patient_id, source=req.source)
    return {"ok": True, "patient_id": req.patient_id, "removed_models": removed}


@app.post("/baseline/fit")
def fit_baseline(req: BaselineFitRequest) -> dict:
    samples = [_to_window_reading(s, source=req.source) for s in req.samples]
    try:
        model = registry.fit_patient_baseline(
            patient_id=req.patient_id,
            samples=samples,
            source=req.source,
            contamination=req.contamination,
            min_samples=req.min_samples,
            available_modalities=req.available_modalities,
            temperature_site=req.temperature_site,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "patient_id": model.patient_id,
        "source": model.source,
        "trained": True,
        "ecg_model_trained": False,
        "sample_count": model.sample_count,
        "model_version": model.model_version,
        "trained_at": model.trained_at,
        "updated_at": model.updated_at or model.trained_at,
        "contamination": model.contamination,
        "means": model.baseline.overall_means,
        "medians": model.baseline.overall_medians,
        "stds": model.baseline.overall_stds,
        "resting_means": model.baseline.resting.means if model.baseline.resting else None,
        "resting_medians": model.baseline.resting.medians if model.baseline.resting else None,
        "active_means": model.baseline.active.means if model.baseline.active else None,
        "active_medians": model.baseline.active.medians if model.baseline.active else None,
    }


@app.post("/analyze")
def analyze_reading(req: AnalyzeRequest) -> dict:
    ecg_summary: Optional[EcgFeatureSummary] = None
    if req.ecg_features is not None:
        ecg_summary = EcgFeatureSummary(
            sampling_rate_hz=req.ecg_features.sampling_rate_hz,
            sample_count=req.ecg_features.sample_count,
            r_peak_count=req.ecg_features.r_peak_count,
            estimated_ecg_bpm=req.ecg_features.estimated_ecg_bpm,
            rr_interval_mean_ms=req.ecg_features.rr_interval_mean_ms,
            rr_variability_ms=req.ecg_features.rr_variability_ms,
            amplitude_range=req.ecg_features.amplitude_range,
            signal_quality=req.ecg_features.signal_quality,
        )
    elif req.ecg_samples is not None:
        ecg_summary = extract_ecg_features_from_batch(
            samples=req.ecg_samples,
            sampling_rate_hz=req.ecg_sampling_rate,
            lead_off=req.ecg_lead_off,
        )

    cfg = AlertDecisionConfig(
        baseline_min_samples=req.baseline_min_samples,
        warning_persistence_windows=req.warning_persistence_windows,
        critical_persistence_windows=req.critical_persistence_windows,
        anomaly_score_warning=req.anomaly_score_warning,
        anomaly_score_critical=registry.config.anomaly_score_critical,
        z_score_warning=registry.config.z_score_warning,
        z_score_critical=registry.config.z_score_critical,
    )

    return registry.analyze(
        patient_id=req.patient_id,
        heart_rate=req.heart_rate,
        spo2=req.spo2,
        temperature_c=req.temperature_c,
        accel_magnitude=req.accel_magnitude,
        gyro_magnitude=req.gyro_magnitude,
        movement_status=req.movement_status,
        possible_fall_detected=req.possible_fall_detected,
        ir_signal_ok=req.ir_signal_ok,
        finger_detected=req.finger_detected,
        ecg_summary=ecg_summary,
        source=req.source,
        timestamp=req.timestamp,
        config=cfg,
        available_modalities=req.available_modalities,
        temperature_site=req.temperature_site,
        allow_baseline_training=req.allow_baseline_training,
    )


@app.post("/evaluate")
def evaluate_model(req: EvaluateRequest) -> dict:
    status = registry.get_status(req.patient_id, source=req.source)
    eff_source = req.source or (status["source"] if isinstance(status.get("source"), str) else None)
    readings = (
        req.readings
        if req.readings is not None
        else registry.get_history(req.patient_id, source=req.source, limit=300)
    )
    baseline = registry.get_baseline_summary(req.patient_id, source=eff_source)
    return evaluate_model_outputs(
        readings=readings,
        labels=req.labels,
        baseline=baseline,
        model_version=status.get("model_version") if isinstance(status.get("model_version"), str) else None,
        source=eff_source,
    )


@app.post("/graphs/generate")
def generate_graphs(req: GraphGenerateRequest) -> dict:
    status = registry.get_status(req.patient_id, source=req.source)
    eff_source = req.source or "simulator"
    readings = (
        req.readings
        if req.readings is not None
        else registry.get_history(req.patient_id, source=eff_source, limit=300)
    )
    baseline = registry.get_baseline_summary(req.patient_id, source=eff_source)
    graphs = generate_patient_graphs(
        patient_id=req.patient_id,
        source=eff_source,
        readings=readings,
        baseline=baseline,
        anomaly_warning_threshold=registry.config.anomaly_score_warning,
        anomaly_critical_threshold=registry.config.anomaly_score_critical,
    )
    return {
        "ok": True,
        "patient_id": req.patient_id,
        "source": eff_source,
        "trained": bool(status.get("trained")),
        "graphs": graphs,
    }


@app.get("/graphs/list/{patient_id}")
def list_graphs(patient_id: str, source: Optional[str] = None) -> dict:
    DEFAULT_GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    safe_pid = "".join(c if c.isalnum() or c in "_-" else "_" for c in patient_id)[:64] or "unknown"
    prefix = f"{safe_pid}__{source}__" if source else f"{safe_pid}__"
    files = sorted(p.name for p in DEFAULT_GRAPH_DIR.glob(f"{prefix}*.png"))
    return {
        "patient_id": patient_id,
        "source": source,
        "graphs": [
            {
                "filename": name,
                "id": name.split("__")[-1].replace(".png", ""),
            }
            for name in files
        ],
    }


@app.get("/graphs/file/{filename}")
def serve_graph_file(filename: str) -> FileResponse:
    if not SAFE_GRAPH_FILENAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid graph filename.")
    root = DEFAULT_GRAPH_DIR.resolve()
    target = (root / filename).resolve()
    if target.parent != root or not target.exists():
        raise HTTPException(status_code=404, detail="Graph file not found.")
    return FileResponse(path=target, media_type="image/png")
