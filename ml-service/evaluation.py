from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Tuple

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)

from baseline import PersonalBaselineSummary
from preprocessing import readings_to_dataframe


DEFAULT_GRAPH_DIR = Path(
    os.environ.get("SMARTCARE_GRAPH_DIR", Path(__file__).parent / "graphs")
)

SAFE_GRAPH_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_.\-]+\.png$")


def _safe_key(val: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", val)[:64] or "unknown"


def _parse_binary_label(raw: Any) -> Optional[int]:
    if raw is None or isinstance(raw, float) and np.isnan(raw):
        return None
    if isinstance(raw, bool):
        return 1 if raw else 0
    if isinstance(raw, (int, np.integer)):
        return 1 if int(raw) != 0 else 0
    if isinstance(raw, str):
        norm = raw.strip().lower()
        if norm in {"1", "true", "anomalous", "anomaly", "abnormal", "fall", "warning", "critical"}:
            return 1
        if norm in {"0", "false", "normal", "adl", "baseline"}:
            return 0
    return None


def evaluate_model_outputs(
    readings: List[Dict[str, Any]],
    labels: Optional[List[Any]] = None,
    baseline: Optional[PersonalBaselineSummary] = None,
    model_version: Optional[str] = None,
    source: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Evaluate anomaly detection output honestly:
    - Computes Accuracy, Precision, Recall, F1-score, and Confusion Matrix ONLY when ground-truth labels exist.
    - When ground-truth labels are unavailable, omits fabricated supervised metrics, explicitly documents
      which metrics require labels, and computes unsupervised anomaly score & deviation diagnostics instead.
    """
    df = readings_to_dataframe(readings)
    total = int(len(df))
    evaluated_at = datetime.now(timezone.utc).isoformat()

    if total == 0:
        return {
            "evaluated_at": evaluated_at,
            "source": source,
            "model_version": model_version,
            "sample_count": 0,
            "labeled_data_available": False,
            "supervised_metrics": None,
            "metrics_requiring_labels": [
                "Accuracy",
                "Precision",
                "Recall",
                "F1-score",
                "Confusion Matrix",
            ],
            "unsupervised_metrics": {
                "valid_quality_count": 0,
                "poor_quality_count": 0,
                "noisy_quality_count": 0,
                "anomalous_count": 0,
                "normal_count": 0,
                "insufficient_baseline_count": 0,
                "flagged_rate": 0.0,
                "anomaly_score_mean": None,
                "anomaly_score_median": None,
                "anomaly_score_std": None,
                "anomaly_score_min": None,
                "anomaly_score_max": None,
                "anomaly_score_iqr": None,
                "normal_vs_anomalous_score_gap": None,
            },
            "evaluation_note": "No readings available yet to evaluate. Stream or supply sensor readings to run evaluation.",
            "disclaimer": "Non-diagnostic statistical anomaly evaluation; outputs do not constitute medical diagnosis.",
        }

    valid_mask = df["signal_quality"] == "good"
    noisy_mask = df["signal_quality"] == "noisy"
    poor_mask = df["signal_quality"] == "poor_contact"

    anomalous_mask = (df["anomaly_status"] == "anomalous") | (df["alert_level"].isin(["Warning", "Critical"]))
    insufficient_mask = df["anomaly_status"] == "insufficient_baseline"
    normal_mask = (~anomalous_mask) & (~poor_mask) & (~insufficient_mask)

    scores = pd.to_numeric(df["anomaly_score"], errors="coerce").dropna()
    scored_norm = pd.to_numeric(df.loc[normal_mask, "anomaly_score"], errors="coerce").dropna()
    scored_anom = pd.to_numeric(df.loc[anomalous_mask, "anomaly_score"], errors="coerce").dropna()

    score_gap: Optional[float] = None
    if not scored_norm.empty and not scored_anom.empty:
        score_gap = round(float(scored_norm.mean() - scored_anom.mean()), 4)

    q25 = float(scores.quantile(0.25)) if not scores.empty else None
    q75 = float(scores.quantile(0.75)) if not scores.empty else None
    iqr = round(q75 - q25, 4) if (q25 is not None and q75 is not None) else None

    unsupervised = {
        "valid_quality_count": int(valid_mask.sum()),
        "noisy_quality_count": int(noisy_mask.sum()),
        "poor_quality_count": int(poor_mask.sum()),
        "anomalous_count": int(anomalous_mask.sum()),
        "normal_count": int(normal_mask.sum()),
        "insufficient_baseline_count": int(insufficient_mask.sum()),
        "flagged_rate": round(float(anomalous_mask.sum()) / total, 4),
        "anomaly_score_mean": round(float(scores.mean()), 4) if not scores.empty else None,
        "anomaly_score_median": round(float(scores.median()), 4) if not scores.empty else None,
        "anomaly_score_std": round(float(scores.std(ddof=0)), 4) if len(scores) >= 2 else None,
        "anomaly_score_min": round(float(scores.min()), 4) if not scores.empty else None,
        "anomaly_score_max": round(float(scores.max()), 4) if not scores.empty else None,
        "anomaly_score_iqr": iqr,
        "normal_vs_anomalous_score_gap": score_gap,
        "baseline_sample_count": baseline.sample_count if baseline else 0,
    }

    # Resolve ground-truth labels if explicitly passed in `labels` or attached to readings
    parsed_labels: List[Optional[int]] = []
    if labels is not None and len(labels) == len(readings):
        parsed_labels = [_parse_binary_label(lbl) for lbl in labels]
    else:
        parsed_labels = [
            _parse_binary_label(
                item.get("label", item.get("ground_truth_label", item.get("is_anomalous")))
            )
            for item in readings
        ]

    paired: List[Tuple[int, int]] = []
    preds = anomalous_mask.astype(int).tolist()
    for y_true, y_pred in zip(parsed_labels, preds):
        if y_true is not None:
            paired.append((y_true, y_pred))

    supervised_metrics: Optional[Dict[str, Any]] = None
    labeled_available = len(paired) > 0
    if labeled_available:
        y_true_arr = [p[0] for p in paired]
        y_pred_arr = [p[1] for p in paired]
        cm = confusion_matrix(y_true_arr, y_pred_arr, labels=[0, 1])
        tn, fp, fn, tp = (int(cm[0, 0]), int(cm[0, 1]), int(cm[1, 0]), int(cm[1, 1]))
        supervised_metrics = {
            "labeled_count": len(paired),
            "accuracy": round(float(accuracy_score(y_true_arr, y_pred_arr)), 4),
            "precision": round(float(precision_score(y_true_arr, y_pred_arr, zero_division=0)), 4),
            "recall": round(float(recall_score(y_true_arr, y_pred_arr, zero_division=0)), 4),
            "f1_score": round(float(f1_score(y_true_arr, y_pred_arr, zero_division=0)), 4),
            "confusion_matrix": {
                "tn": tn,
                "fp": fp,
                "fn": fn,
                "tp": tp,
                "matrix": [[tn, fp], [fn, tp]],
            },
        }
        note = (
            f"Computed supervised classification metrics across {len(paired)} ground-truth labeled readings "
            f"alongside unsupervised Isolation Forest score distributions."
        )
    else:
        note = (
            "Ground-truth anomaly labels are not available for these live/simulated readings. "
            "Accuracy, Precision, Recall, F1-score, and Confusion Matrix require labeled test data and are intentionally omitted; "
            "unsupervised anomaly score statistics and baseline stability are reported instead."
        )

    return {
        "evaluated_at": evaluated_at,
        "source": source,
        "model_version": model_version,
        "sample_count": total,
        "labeled_data_available": labeled_available,
        "supervised_metrics": supervised_metrics,
        "metrics_requiring_labels": [
            "Accuracy",
            "Precision",
            "Recall",
            "F1-score",
            "Confusion Matrix",
        ],
        "unsupervised_metrics": unsupervised,
        "evaluation_note": note,
        "disclaimer": "Non-diagnostic statistical anomaly evaluation; outputs do not constitute medical diagnosis.",
    }


def _apply_arova_plot_style(ax: plt.Axes, title: str, ylabel: str) -> None:
    ax.set_title(title, fontsize=11, fontweight="bold", color="#182C21", pad=10)
    ax.set_ylabel(ylabel, fontsize=9.5, color="#334D3F")
    ax.grid(True, linestyle="--", alpha=0.35, color="#B7D2C0")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(colors="#425C4E", labelsize=8.5)


def _format_time_axis(ax: plt.Axes) -> None:
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
    plt.setp(ax.get_xticklabels(), rotation=25, ha="right")


def _plot_vital_trend(
    df: pd.DataFrame,
    col: str,
    title: str,
    ylabel: str,
    out_path: Path,
    baseline_mean: Optional[float],
    baseline_median: Optional[float],
    baseline_std: Optional[float],
    line_color: str,
) -> int:
    fig, ax = plt.subplots(figsize=(7.4, 3.6), dpi=130)
    fig.patch.set_facecolor("#FFFFFF")
    ax.set_facecolor("#F9FCFA")

    valid = df[df[col].notna()].copy()
    _apply_arova_plot_style(ax, title, ylabel)

    if valid.empty:
        ax.text(
            0.5,
            0.5,
            f"No valid {col.replace('_', ' ')} readings recorded yet.\n(No fabricated values generated.)",
            ha="center",
            va="center",
            transform=ax.transAxes,
            fontsize=9.5,
            color="#52685B",
        )
        fig.tight_layout()
        fig.savefig(out_path, dpi=130)
        plt.close(fig)
        return 0

    times = pd.to_datetime(valid["timestamp_sec"], unit="s", utc=True)
    vals = pd.to_numeric(valid[col], errors="coerce")
    anom_mask = (valid["anomaly_status"] == "anomalous") | (valid["alert_level"].isin(["Warning", "Critical"]))

    ax.plot(times, vals, color=line_color, linewidth=2.0, label="Measured Value", zorder=3)
    ax.scatter(
        times[~anom_mask],
        vals[~anom_mask],
        color=line_color,
        s=24,
        alpha=0.85,
        label="Normal Reading",
        zorder=4,
    )
    if anom_mask.any():
        ax.scatter(
            times[anom_mask],
            vals[anom_mask],
            color="#DC2626",
            s=58,
            marker="D",
            edgecolor="#FFFFFF",
            linewidth=0.8,
            label="Anomalous Reading",
            zorder=5,
        )

    if baseline_mean is not None:
        ax.axhline(baseline_mean, color="#1D4ED8", linestyle="--", linewidth=1.3, label=f"Baseline Mean ({baseline_mean:.2f})")
        if baseline_std is not None and baseline_std > 0:
            ax.axhspan(
                baseline_mean - baseline_std,
                baseline_mean + baseline_std,
                color="#93C5FD",
                alpha=0.18,
                label=f"±1σ Band (±{baseline_std:.2f})",
            )
    if baseline_median is not None:
        ax.axhline(baseline_median, color="#0F766E", linestyle=":", linewidth=1.2, label=f"Baseline Median ({baseline_median:.2f})")

    _format_time_axis(ax)
    ax.legend(loc="best", fontsize=8, frameon=True, facecolor="#FFFFFF", edgecolor="#DCE9DF")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)
    return int(len(valid))


def generate_patient_graphs(
    patient_id: str,
    source: str,
    readings: List[Dict[str, Any]],
    baseline: Optional[PersonalBaselineSummary] = None,
    anomaly_warning_threshold: float = -0.05,
    anomaly_critical_threshold: float = -0.18,
    output_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """
    Generate and persist 7 evaluation & telemetry Matplotlib PNG graphs into an organized directory.
    """
    out_dir = Path(output_dir) if output_dir else DEFAULT_GRAPH_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    df = readings_to_dataframe(readings)
    prefix = f"{_safe_key(patient_id)}__{_safe_key(source)}"
    generated_at = datetime.now(timezone.utc).isoformat()
    origin_tag = "Simulated / Dataset" if source != "esp32_hardware" else "ESP32 Hardware"

    means = baseline.overall_means if baseline else {}
    medians = baseline.overall_medians if baseline else {}
    stds = baseline.overall_stds if baseline else {}

    specs: List[Dict[str, Any]] = []

    # 1. Heart Rate Trend
    hr_file = f"{prefix}__heart_rate_trend.png"
    hr_pts = _plot_vital_trend(
        df=df,
        col="heart_rate",
        title=f"Heart-Rate Trend ({origin_tag})",
        ylabel="Heart Rate (BPM)",
        out_path=out_dir / hr_file,
        baseline_mean=means.get("heart_rate"),
        baseline_median=medians.get("heart_rate"),
        baseline_std=stds.get("heart_rate"),
        line_color="#16834A",
    )
    specs.append({
        "id": "heart_rate_trend",
        "title": "Heart-Rate Trend",
        "metric": "heart_rate",
        "filename": hr_file,
        "point_count": hr_pts,
        "generated_at": generated_at,
    })

    # 2. SpO2 Trend
    spo2_file = f"{prefix}__spo2_trend.png"
    spo2_pts = _plot_vital_trend(
        df=df,
        col="spo2",
        title=f"SpO₂ Oxygenation Trend ({origin_tag})",
        ylabel="SpO₂ (%)",
        out_path=out_dir / spo2_file,
        baseline_mean=means.get("spo2"),
        baseline_median=medians.get("spo2"),
        baseline_std=stds.get("spo2"),
        line_color="#0F766E",
    )
    specs.append({
        "id": "spo2_trend",
        "title": "SpO₂ Trend",
        "metric": "spo2",
        "filename": spo2_file,
        "point_count": spo2_pts,
        "generated_at": generated_at,
    })

    # 3. Temperature Trend
    temp_file = f"{prefix}__temperature_trend.png"
    temp_pts = _plot_vital_trend(
        df=df,
        col="temperature_c",
        title=f"Temperature Trend ({origin_tag})",
        ylabel="Temperature (°C)",
        out_path=out_dir / temp_file,
        baseline_mean=means.get("temperature_c"),
        baseline_median=medians.get("temperature_c"),
        baseline_std=stds.get("temperature_c"),
        line_color="#D97706",
    )
    specs.append({
        "id": "temperature_trend",
        "title": "Temperature Trend",
        "metric": "temperature_c",
        "filename": temp_file,
        "point_count": temp_pts,
        "generated_at": generated_at,
    })

    # 4. Motion / Activity Trend
    motion_file = f"{prefix}__motion_trend.png"
    fig, ax = plt.subplots(figsize=(7.4, 3.6), dpi=130)
    fig.patch.set_facecolor("#FFFFFF")
    ax.set_facecolor("#F9FCFA")
    _apply_arova_plot_style(ax, f"Motion & Activity Trend ({origin_tag})", "Accel Magnitude (g)")
    valid_motion = df[df["accel_magnitude"].notna()].copy()
    if valid_motion.empty:
        ax.text(
            0.5,
            0.5,
            "No MPU6050 movement readings recorded yet.",
            ha="center",
            va="center",
            transform=ax.transAxes,
            fontsize=9.5,
            color="#52685B",
        )
    else:
        times = pd.to_datetime(valid_motion["timestamp_sec"], unit="s", utc=True)
        accel_vals = pd.to_numeric(valid_motion["accel_magnitude"], errors="coerce")
        ax.plot(times, accel_vals, color="#2563EB", linewidth=1.9, label="Accel Magnitude (g)")
        anom_m = (valid_motion["anomaly_status"] == "anomalous") | (valid_motion["accel_magnitude"] > 2.6)
        if anom_m.any():
            ax.scatter(
                times[anom_m],
                accel_vals[anom_m],
                color="#DC2626",
                s=52,
                marker="^",
                label="High Impact / Flagged Motion",
                zorder=5,
            )
        ax.axhline(2.6, color="#DC2626", linestyle="--", linewidth=1.1, alpha=0.7, label="Motion Noise Gate (2.6g)")
        _format_time_axis(ax)
        ax.legend(loc="best", fontsize=8, frameon=True, facecolor="#FFFFFF", edgecolor="#DCE9DF")
    fig.tight_layout()
    fig.savefig(out_dir / motion_file, dpi=130)
    plt.close(fig)
    specs.append({
        "id": "motion_trend",
        "title": "Motion / Activity Trend",
        "metric": "accel_magnitude",
        "filename": motion_file,
        "point_count": int(len(valid_motion)),
        "generated_at": generated_at,
    })

    # 5. Personalized Baseline Comparison (Current Mean vs Learned Mean & Median with ±1σ)
    base_file = f"{prefix}__baseline_comparison.png"
    fig, axes = plt.subplots(1, 3, figsize=(8.2, 3.5), dpi=130)
    fig.patch.set_facecolor("#FFFFFF")
    metrics_cmp = [
        ("heart_rate", "Heart Rate (BPM)", "#16834A"),
        ("spo2", "SpO₂ (%)", "#0F766E"),
        ("temperature_c", "Temp (°C)", "#D97706"),
    ]
    for ax_sub, (col, label, clr) in zip(axes, metrics_cmp):
        ax_sub.set_facecolor("#F9FCFA")
        _apply_arova_plot_style(ax_sub, label, "")
        col_vals = pd.to_numeric(df[col], errors="coerce").dropna() if not df.empty else pd.Series(dtype=float)
        learned_m = means.get(col)
        learned_med = medians.get(col)
        learned_sd = stds.get(col, 0.0)
        bars_labels: List[str] = []
        bars_vals: List[float] = []
        bars_colors: List[str] = []
        if learned_m is not None:
            bars_labels.extend(["Base Mean", "Base Med"])
            bars_vals.extend([learned_m, learned_med if learned_med is not None else learned_m])
            bars_colors.extend(["#1D4ED8", "#0F766E"])
        if not col_vals.empty:
            bars_labels.append("Recent")
            bars_vals.append(float(col_vals.tail(5).mean()))
            bars_colors.append(clr)
        if not bars_vals:
            ax_sub.text(0.5, 0.5, "Pending data", ha="center", va="center", transform=ax_sub.transAxes, fontsize=8.5, color="#52685B")
        else:
            x_pos = np.arange(len(bars_labels))
            ax_sub.bar(x_pos, bars_vals, color=bars_colors, width=0.55, alpha=0.88)
            if learned_m is not None and learned_sd:
                ax_sub.errorbar([0], [learned_m], yerr=[learned_sd], fmt="none", ecolor="#1E3A8A", elinewidth=1.5, capsize=4)
            ax_sub.set_xticks(x_pos)
            ax_sub.set_xticklabels(bars_labels, fontsize=8)
            lo = min(bars_vals) - max(learned_sd * 1.5, 1.5)
            hi = max(bars_vals) + max(learned_sd * 1.5, 1.5)
            ax_sub.set_ylim(lo, hi)
    fig.suptitle(f"Personalized Baseline Comparison ({origin_tag})", fontsize=11.5, fontweight="bold", color="#182C21")
    fig.tight_layout()
    fig.savefig(out_dir / base_file, dpi=130)
    plt.close(fig)
    specs.append({
        "id": "baseline_comparison",
        "title": "Personalized Baseline Comparison",
        "metric": "baseline",
        "filename": base_file,
        "point_count": int(len(df)),
        "generated_at": generated_at,
    })

    # 6. Normal vs Anomalous Readings Scatter
    nva_file = f"{prefix}__normal_vs_anomalous.png"
    fig, ax = plt.subplots(figsize=(7.4, 3.6), dpi=130)
    fig.patch.set_facecolor("#FFFFFF")
    ax.set_facecolor("#F9FCFA")
    _apply_arova_plot_style(ax, f"Normal vs Anomalous Readings ({origin_tag})", "SpO₂ (%)")
    ax.set_xlabel("Heart Rate (BPM)", fontsize=9.5, color="#334D3F")
    scatter_df = df[df["heart_rate"].notna() & df["spo2"].notna()].copy()
    if scatter_df.empty:
        ax.text(
            0.5,
            0.5,
            "Need valid Heart Rate + SpO₂ readings to plot normal vs anomalous separation.",
            ha="center",
            va="center",
            transform=ax.transAxes,
            fontsize=9.5,
            color="#52685B",
        )
    else:
        anom_s = (scatter_df["anomaly_status"] == "anomalous") | (scatter_df["alert_level"].isin(["Warning", "Critical"]))
        norm_s = ~anom_s
        if norm_s.any():
            ax.scatter(
                scatter_df.loc[norm_s, "heart_rate"],
                scatter_df.loc[norm_s, "spo2"],
                color="#16834A",
                s=45,
                alpha=0.8,
                label=f"Normal ({int(norm_s.sum())})",
            )
        if anom_s.any():
            ax.scatter(
                scatter_df.loc[anom_s, "heart_rate"],
                scatter_df.loc[anom_s, "spo2"],
                color="#DC2626",
                s=72,
                marker="X",
                label=f"Anomalous ({int(anom_s.sum())})",
            )
        if "heart_rate" in means and "spo2" in means:
            ax.scatter(
                [means["heart_rate"]],
                [means["spo2"]],
                color="#1D4ED8",
                s=110,
                marker="*",
                label="Learned Baseline Center",
                zorder=6,
            )
        ax.legend(loc="best", fontsize=8.5, frameon=True, facecolor="#FFFFFF", edgecolor="#DCE9DF")
    fig.tight_layout()
    fig.savefig(out_dir / nva_file, dpi=130)
    plt.close(fig)
    specs.append({
        "id": "normal_vs_anomalous",
        "title": "Normal vs Anomalous Readings",
        "metric": "classification",
        "filename": nva_file,
        "point_count": int(len(scatter_df)),
        "generated_at": generated_at,
    })

    # 7. Anomaly Score Over Time
    score_file = f"{prefix}__anomaly_score_trend.png"
    fig, ax = plt.subplots(figsize=(7.4, 3.6), dpi=130)
    fig.patch.set_facecolor("#FFFFFF")
    ax.set_facecolor("#F9FCFA")
    _apply_arova_plot_style(ax, f"Isolation Forest Anomaly Score Over Time ({origin_tag})", "Anomaly Score")
    score_df = df[df["anomaly_score"].notna()].copy()
    if score_df.empty:
        ax.text(
            0.5,
            0.5,
            "No Isolation Forest scores recorded yet.",
            ha="center",
            va="center",
            transform=ax.transAxes,
            fontsize=9.5,
            color="#52685B",
        )
    else:
        times = pd.to_datetime(score_df["timestamp_sec"], unit="s", utc=True)
        sc_vals = pd.to_numeric(score_df["anomaly_score"], errors="coerce")
        ax.plot(times, sc_vals, color="#334155", linewidth=1.8, label="Anomaly Score")
        anom_sc = (score_df["anomaly_status"] == "anomalous") | (score_df["alert_level"].isin(["Warning", "Critical"]))
        ax.scatter(times[~anom_sc], sc_vals[~anom_sc], color="#16834A", s=26, label="Normal Window")
        if anom_sc.any():
            ax.scatter(times[anom_sc], sc_vals[anom_sc], color="#DC2626", s=56, marker="D", label="Flagged Window")
        ax.axhline(anomaly_warning_threshold, color="#D97706", linestyle="--", linewidth=1.2, label=f"Warning Threshold ({anomaly_warning_threshold:.2f})")
        ax.axhline(anomaly_critical_threshold, color="#DC2626", linestyle=":", linewidth=1.2, label=f"Critical Threshold ({anomaly_critical_threshold:.2f})")
        _format_time_axis(ax)
        ax.legend(loc="best", fontsize=8, frameon=True, facecolor="#FFFFFF", edgecolor="#DCE9DF")
    fig.tight_layout()
    fig.savefig(out_dir / score_file, dpi=130)
    plt.close(fig)
    specs.append({
        "id": "anomaly_score_trend",
        "title": "Anomaly Score Over Time",
        "metric": "anomaly_score",
        "filename": score_file,
        "point_count": int(len(score_df)),
        "generated_at": generated_at,
    })

    return specs
