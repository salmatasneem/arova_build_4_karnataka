# SmartCare AI — Python Isolation Forest Microservice

Separate FastAPI + `scikit-learn` service responsible for:
1. Collecting and fitting **source-separated** (`esp32_hardware` vs `simulator`; `sample_demo` excluded), activity-context-aware (`resting` vs `active`) personalized `IsolationForest` + `StandardScaler` baselines persisted to disk (`joblib` + `.meta.json` sidecars with model versions).
2. Extracting **time-windowed features** (`features.py`: HR mean/delta/z-score, SpO2 mean/min/delta, temperature slope & delta, MPU6050 movement context, optional AD8232 ECG rate/HRV features when `signal_quality == 'good'`, and missing-data indicators).
3. Validating sensor quality (`MAX30100` optical contact, configurable temperature probe bounds, `MPU6050` motion noise, `AD8232` lead-off).
4. Applying a decoupled **Alert Decision Engine** (`alert_engine.py`) with sensor quality gating, explicit `insufficient_baseline` handling, acute safety guardrails, multi-window persistence suppression for transient spikes, and contributing-feature explanations.

> **Honesty Note**: Neither per-patient Isolation Forest baselines nor any ECG arrhythmia classifier (`ecg_model_trained: false`) are pre-trained globally. Models are trained per user from quality-filtered baseline readings.

## Local Startup & Testing

```bash
cd ml-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest -v
uvicorn main:app --host 127.0.0.1 --port 18000
```

Set `ML_SERVICE_URL="http://127.0.0.1:18000"` in your Node.js server environment so `/api/ml/analyze`, `/api/ml/baseline/fit`, and `/api/wearable/ingest` route to this Python microservice. (Port `18000` is used instead of `8000` because AI Studio's internal container control-plane bridge listens on `:8000`.)
