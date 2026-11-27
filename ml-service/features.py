from __future__ import annotations

# Backward-compatible facade re-exporting modular Phase 4 preprocessing and baseline APIs.
from baseline import (
    ACTIVE_MOVEMENTS,
    ActivityBaselineStats,
    PersonalBaselineSummary,
    WindowReading,
    compute_personal_baseline_stats,
    parse_timestamp_sec,
    should_include_for_baseline_update,
)
from preprocessing import (
    MODEL_FEATURE_NAMES,
    ExtractedFeatureWindow,
    PatientWindowStore,
    build_feature_dataframe,
    extract_windowed_features,
    readings_to_dataframe,
)

__all__ = [
    "ACTIVE_MOVEMENTS",
    "ActivityBaselineStats",
    "ExtractedFeatureWindow",
    "MODEL_FEATURE_NAMES",
    "PatientWindowStore",
    "PersonalBaselineSummary",
    "WindowReading",
    "build_feature_dataframe",
    "compute_personal_baseline_stats",
    "extract_windowed_features",
    "parse_timestamp_sec",
    "readings_to_dataframe",
    "should_include_for_baseline_update",
]
