from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, List, Optional, Tuple

from features import ExtractedFeatureWindow


@dataclass
class AlertDecisionConfig:
    baseline_min_samples: int = 20
    warning_persistence_windows: int = 2
    critical_persistence_windows: int = 3
    anomaly_score_warning: float = -0.05
    anomaly_score_critical: float = -0.18
    z_score_warning: float = 2.0
    z_score_critical: float = 3.0


@dataclass
class AlertDecisionOutput:
    anomaly_status: str  # "insufficient_baseline" | "paused_poor_quality" | "normal" | "anomalous"
    alert_level: str     # "Normal" | "Warning" | "Critical"
    triggered_metrics: List[str]
    contributing_summary: List[str]
    persistence_count: int
    persistence_required: int
    explanation: str


class AlertDecisionEngine:
    """
    Separate rule + persistence decision layer decoupled from raw Isolation Forest scoring.
    Requires multi-window persistence to suppress transient single-packet false alerts,
    while enforcing immediate acute safety guardrails on severe vital hazards.
    """

    def __init__(self, max_history: int = 10) -> None:
        self._anomaly_streak: Dict[Tuple[str, str], Deque[bool]] = {}
        self.max_history = max_history

    def clear(self, patient_id: Optional[str] = None) -> None:
        if patient_id is None:
            self._anomaly_streak.clear()
            return
        for key in [k for k in self._anomaly_streak if k[0] == patient_id]:
            del self._anomaly_streak[key]

    def _record_streak(self, patient_id: str, source: str, is_anomalous: bool) -> int:
        key = (patient_id, source)
        hist = self._anomaly_streak.setdefault(key, deque(maxlen=self.max_history))
        hist.append(is_anomalous)
        streak = 0
        for flag in reversed(hist):
            if flag:
                streak += 1
            else:
                break
        return streak

    def evaluate(
        self,
        patient_id: str,
        source: str,
        signal_quality: str,
        quality_notes: List[str],
        ecg_note: str,
        model_trained: bool,
        collected_baseline_samples: int,
        heart_rate: Optional[float],
        spo2: Optional[float],
        temperature_c: Optional[float],
        accel_magnitude: float,
        movement_status: str,
        possible_fall_detected: bool,
        raw_anomaly_score: Optional[float],
        iforest_prediction: Optional[int],
        features: ExtractedFeatureWindow,
        config: AlertDecisionConfig,
        hr_expected: bool = True,
        spo2_expected: bool = True,
    ) -> AlertDecisionOutput:
        # 1. Sensor quality gate (strictly unchanged when hr_expected and spo2_expected are True)
        if signal_quality == "poor_contact" or (hr_expected and heart_rate is None) or (spo2_expected and spo2 is None):
            return AlertDecisionOutput(
                anomaly_status="paused_poor_quality",
                alert_level="Normal",
                triggered_metrics=[],
                contributing_summary=[],
                persistence_count=0,
                persistence_required=config.warning_persistence_windows,
                explanation=(
                    f"{' '.join(quality_notes)}{ecg_note} "
                    "Anomaly scoring paused until optical sensor contact stabilizes."
                ).strip(),
            )

        # Evaluate acute life-safety guardrails independently of baseline readiness
        acute_critical = (
            (spo2 is not None and spo2 <= 88.0)
            or (heart_rate is not None and (heart_rate >= 145.0 or heart_rate <= 38.0))
            or (temperature_c is not None and (temperature_c >= 39.5 or temperature_c <= 34.5))
        )
        fall_flag = possible_fall_detected or movement_status == "fall_suspect" or accel_magnitude >= 2.8

        # 2. Baseline availability gate
        if not model_trained:
            self._record_streak(patient_id, source, False)
            if acute_critical or (
                fall_flag
                and ((heart_rate is not None and heart_rate >= 120.0) or (spo2 is not None and spo2 <= 92.0))
            ):
                metrics = []
                if spo2 is not None and spo2 <= 92.0:
                    metrics.append("SpO2")
                if heart_rate is not None and (heart_rate >= 120.0 or heart_rate <= 38.0):
                    metrics.append("Heart Rate")
                if fall_flag:
                    metrics.append("Movement (Experimental Fall Indicator)")
                if temperature_c is not None and (temperature_c >= 39.5 or temperature_c <= 34.5):
                    metrics.append("Temperature")
                return AlertDecisionOutput(
                    anomaly_status="insufficient_baseline",
                    alert_level="Critical",
                    triggered_metrics=metrics,
                    contributing_summary=[f"{m} (acute safety guardrail)" for m in metrics],
                    persistence_count=1,
                    persistence_required=1,
                    explanation=(
                        f"Insufficient personal baseline ({collected_baseline_samples}/{config.baseline_min_samples} clean samples), "
                        f"but acute physiological safety threshold triggered ({', '.join(metrics)}).{ecg_note}"
                    ),
                )

            return AlertDecisionOutput(
                anomaly_status="insufficient_baseline",
                alert_level="Normal",
                triggered_metrics=[],
                contributing_summary=[],
                persistence_count=0,
                persistence_required=config.warning_persistence_windows,
                explanation=(
                    f"Insufficient personal baseline data ({collected_baseline_samples}/{config.baseline_min_samples} clean samples). "
                    f"Personalized Isolation Forest scoring begins once baseline learning completes.{ecg_note}"
                ).strip(),
            )

        # 3. Feature deviation & Isolation Forest evaluation
        z = features.z_scores
        triggered: List[str] = []
        reasons: List[str] = []
        contributing_summary: List[str] = []

        if heart_rate is not None and (abs(z["heart_rate"]) >= config.z_score_warning or heart_rate >= 125.0 or heart_rate <= 45.0):
            triggered.append("Heart Rate")
            reasons.append(f"heart rate {heart_rate:.0f} BPM (z={z['heart_rate']:+.1f}, {features.matched_baseline_context} context)")
            contributing_summary.append(f"Heart Rate ({z['heart_rate']:+.1f}σ)")

        if spo2 is not None and (z["spo2"] <= -config.z_score_warning or spo2 <= 93.0):
            triggered.append("SpO2")
            min_spo2_val = features.spo2_min if features.spo2_min is not None else spo2
            reasons.append(f"SpO2 {spo2:.1f}% (z={z['spo2']:+.1f}, window min {min_spo2_val:.1f}%)")
            contributing_summary.append(f"SpO2 ({z['spo2']:+.1f}σ)")

        if temperature_c is not None and (
            abs(z["temperature_c"]) >= config.z_score_warning
            or temperature_c >= 38.0
            or temperature_c <= 35.3
            or features.temp_slope_c_per_min >= 0.08
        ):
            triggered.append("Temperature")
            slope_note = f", slope {features.temp_slope_c_per_min:+.2f}°C/min" if abs(features.temp_slope_c_per_min) >= 0.03 else ""
            reasons.append(f"temperature {temperature_c:.1f} °C (z={z['temperature_c']:+.1f}{slope_note})")
            contributing_summary.append(f"Temperature ({z['temperature_c']:+.1f}σ)")

        if fall_flag or abs(z["accel_magnitude"]) >= 2.8:
            triggered.append("Movement (Experimental Fall Indicator)")
            reasons.append(f"IMU acceleration {accel_magnitude:.2f} g (z={z['accel_magnitude']:+.1f})")
            contributing_summary.append(f"Movement ({accel_magnitude:.2f}g)")

        if features.ecg_available and abs(z.get("ecg_bpm", 0.0)) >= config.z_score_warning:
            triggered.append("AD8232 ECG Rate")
            reasons.append(f"ECG-derived rate deviated (z={z['ecg_bpm']:+.1f}, non-diagnostic)")
            contributing_summary.append(f"ECG Rate ({z['ecg_bpm']:+.1f}σ)")

        score = raw_anomaly_score if raw_anomaly_score is not None else 0.0
        is_iforest_outlier = score <= config.anomaly_score_warning
        has_metric_deviation = len(triggered) >= 1
        noisy_penalty = signal_quality == "noisy" and not acute_critical and len(triggered) <= 1 and not fall_flag

        # Noisy optical signal during heavy movement requires stronger multi-signal or sustained evidence
        raw_anomalous = (is_iforest_outlier or has_metric_deviation) and not (noisy_penalty and score > config.anomaly_score_critical)
        streak = self._record_streak(patient_id, source, raw_anomalous)

        if not raw_anomalous:
            return AlertDecisionOutput(
                anomaly_status="normal",
                alert_level="Normal",
                triggered_metrics=[],
                contributing_summary=[],
                persistence_count=0,
                persistence_required=config.warning_persistence_windows,
                explanation=(
                    f"Readings align with {patient_id}'s {features.matched_baseline_context} Isolation Forest baseline "
                    f"(score {score:.3f}, window={features.window_size}).{ecg_note}"
                ).strip(),
            )

        # 4. Separate Alert Decision Layer: Severity + Multi-Window Persistence
        sustained_warning = streak >= config.warning_persistence_windows
        severe_multi_signal = (
            sustained_warning
            and len(triggered) >= 2
            and (score <= config.anomaly_score_critical or any(abs(z[k]) >= config.z_score_critical for k in ("heart_rate", "spo2")))
        )
        sustained_critical = streak >= config.critical_persistence_windows and (
            score <= config.anomaly_score_critical or len(triggered) >= 2
        )

        if acute_critical or (fall_flag and len(triggered) >= 2) or sustained_critical or severe_multi_signal:
            alert_level = "Critical"
            detail = ", ".join(reasons) if reasons else "multi-feature Isolation Forest outlier"
            explanation = (
                f"Critical alert (score {score:.3f}, persistence {streak}/{config.critical_persistence_windows} windows): "
                f"{detail}.{ecg_note}"
            ).strip()
        elif sustained_warning:
            alert_level = "Warning"
            detail = ", ".join(reasons) if reasons else "sustained multi-feature Isolation Forest deviation"
            explanation = (
                f"Warning confirmed across {streak} consecutive windows (score {score:.3f}): "
                f"{detail}.{ecg_note}"
            ).strip()
        else:
            # Suppress transient 1-packet spike until persistence threshold is met
            alert_level = "Normal"
            detail = ", ".join(reasons) if reasons else "transient multi-feature outlier"
            explanation = (
                f"Transient deviation detected ({detail}; score {score:.3f}) — "
                f"awaiting multi-window persistence ({streak}/{config.warning_persistence_windows}) before emitting alert.{ecg_note}"
            ).strip()

        return AlertDecisionOutput(
            anomaly_status="anomalous",
            alert_level=alert_level,
            triggered_metrics=triggered,
            contributing_summary=contributing_summary[:6],
            persistence_count=streak,
            persistence_required=config.warning_persistence_windows,
            explanation=explanation,
        )
