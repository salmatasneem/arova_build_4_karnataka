# SmartCare AI — SisFall Local Import & Validation Guide

> **Scope & Provenance**: SisFall recordings are imported strictly under `source: "dataset_playback"` (`ds_sisfall_<participantId>_<recordId>`). Participant and recording isolation is strictly enforced: SisFall data never modifies clinical Firestore records, ESP32 hardware baselines, or simulator baselines.

---

## 1. Official SisFall Dataset Sources & File Structure

- **Reference**: Sucerquia, López & Vargas-Bonilla, *"SisFall: A Fall and Movement Dataset"*, *Sensors* 2017 (`DOI: 10.3390/s17010198`).
- **Downloading One Official Recording Locally** *(no large datasets are bundled in SmartCare AI)*:
  1. **Primary open mirror (recommended)**: Open `https://huggingface.co/datasets/abys7315/Sisfall_Dataset` in your browser, go to **Files and versions**, open a participant folder (for example `SE06/` or `SA01/`), and download a single `.txt` file such as:
     - `F01_SE06_R01.txt` (forward slip fall trial, `~15 s` at `200 Hz`, ~3,000 rows, ~160 KB), or
     - `D01_SE06_R01.txt` (slow-walking ADL trial, `~100 s` at `200 Hz`, ~20,000 rows, ~1.1 MB).
  2. **Original university portal**: `https://sistemic.udea.edu.co/en/research/projects/english-falls/` (intermittently offline; contains the same `.txt` directory layout by participant `SA01`–`SA23`, `SE01`–`SE15`).
- **Participants (`38` total — mixed age cohort)**:
  - `SA01`–`SA23`: 23 young adults (19–30 years) performing both ADLs (`D01`–`D19`) and falls (`F01`–`F15`).
  - `SE01`–`SE15` (excluding `SE06`): 14 elderly adults (`> 62` years) performing **ADLs only** (`Dxx`).
  - `SE06`: 1 participant (60 years) performing both ADLs (`Dxx`) and falls (`Fxx`).

### Raw `.txt` Column Order & Physical Unit Conversion
Official SisFall `.txt` files have **no header row**, **9 comma-separated signed integer ADC columns**, and a trailing `;` at the end of each line (`200 Hz`):

| Columns | Sensor | Range & Resolution | SmartCare Conversion Applied |
| :--- | :--- | :--- | :--- |
| `1 – 3` (`ax, ay, az`) | **ADXL345** (primary accel) | `±16 g`, 13-bit signed | `raw * (32 / 8192) = raw * 0.00390625 g` |
| `4 – 6` (`gx, gy, gz`) | **ITG3200** (gyroscope) | `±2000 °/s`, 16-bit signed | `raw * (4000 / 65536) ≈ raw * 0.06103516 °/s` |
| `7 – 9` | **MMA8451Q** (secondary accel) | `±8 g`, 14-bit signed | Validated in raw row check; primary IMU features use ADXL345 + ITG3200 |

### Named CSV Format (Sample-Labeled ADL + Fall Exports)
If you convert or concatenate SisFall trials into a `.csv` with headers and sample-level labels:
- **Required acceleration columns**: `ax, ay, az` (also accepts `adxl345_x/y/z`, `adxl_x/y/z`, `acc_x/y/z`, `accel_x/y/z`). Values must be either **normalized `g`** or **raw ADXL345 integer ADC counts** (NOT `m/s²`).
- **Optional columns**: `gx, gy, gz` (`itg3200_x/y/z`, `gyro_x/y/z`), `timestamp` / `time_s`, and sample-level `label` (`adl`/`0`/`normal` vs `fall`/`1`/`anomalous`).

---

## 2. Step-by-Step Upload & Playback in Dataset Lab

1. Open SmartCare AI and click **Dataset Lab** in the left navigation bar.
2. Check the top status strip:
   - `Active Mode: Public Research Dataset` (`dataset_playback`)
   - `ML Engine: ● Live Python Isolation Forest (:18000)` (or Demo Mode fallback if Python service is stopped).
3. Under **1. Import & Validate Dataset Trace**:
   - **Target Dataset Adapter**: Select `SisFall: A Fall and Movement Dataset (.txt, .csv)`.
   - **Participant ID / Record ID**: Leave blank to auto-parse from official filenames (`F01_SE06_R01.txt` → `Participant: SE06`, `Record: F01`; `D01_SE06_R01.txt` → `Participant: SE06`, `Record: D01`).
   - **Prefit Normal Prefix & Min Baseline Samples**:
     - For a **raw `Fxx_*.txt` file** alone: all windows carry `fall:Fxx`, so SmartCare strictly **disables baseline training** (`baselineIndependence: "no_baseline_trained"`) rather than fitting on fall data.
     - For a **raw `Dxx_*.txt` ADL file**: establishes a non-fall ADL baseline isolated to `ds_sisfall_<participant>_Dxx`.
     - For a **sample-labeled ADL + Fall CSV** with at least 20 leading `adl` windows, set `Prefit Normal Prefix = 20 normal frames`. Those 20 training frames are automatically **excluded** from evaluation metrics, and the remaining frames are explicitly marked `within_recording_split_not_independent`.
   - Click **Select Dataset File** (or drag and drop your `.txt` / `.csv` file; max JSON payload `10 MB`).
4. Confirm in **Validated Trace Loaded**:
   - Rate (`200 Hz`), downsampled `200 ms` frames, and **Active Sensor Channels** (`IMU (Accel / Gyro)` only — Heart Rate, SpO₂, Temperature, and ECG stay `null` and are never fabricated).
5. Use **2. Time-Preserving Playback Controller** (**Start**, **Pause**, **Step**, **Reset**, **Speed**).

---

## 3. Prediction Semantics, Evaluation Metrics & Limitations

### Three Distinct Prediction Tiers
1. **`Anomalous Sensor Window`** (`anomalousWindow`): `anomalyStatus === "anomalous"` — any single 200 ms window whose Isolation Forest score or feature/impact check flags a deviation, including transient 1-window spikes.
2. **`Potential Fall Alert`** (`potentialFallAlert`): A frame exhibiting fall kinematic cues (`possibleFallDetected`, `fall_suspect`, `accelMagnitude >= 2.8 g`, or Movement indicator) *before* multi-window persistence or post-impact confirmation confirms an alert.
3. **`Confirmed Fall Event`** (`confirmedFallEvent`): Requires **both** persistence-confirmed alert status (`alertLevel` is `"Warning"` or `"Critical"`, respecting `warningPersistenceWindows`) **and** an active fall/movement indicator. A single-window spike (`alertLevel === "Normal"`) or a physiological-only alert (`confirmed_physiological_alert`) is **never** counted as a confirmed fall event.

### Frame-Level vs. Event-Level Evaluation
- **Frame-Level Alert Evaluation (`metrics` / `frameEvaluation.alertLevel`)**: Evaluates persistence-confirmed alerts (`Warning` / `Critical`) per scored labeled frame (`TP, FP, TN, FN, Precision, Recall, F1`). Separate matrices are also reported for `anomalousWindow` and `confirmedFallEvent`, alongside exact `labeledCount`, `unlabeledCount`, `skippedPoorQualityCount`, and `excludedBaselineTrainingCount`.
- **Event-Level Evaluation (`eventEvaluation`)**: Computed **only when genuine sample-level event boundaries exist** (`labelGranularity === "sample_level"`). Contiguous runs of positive ground-truth frames define events; an event counts as detected when overlapped by at least one persistence-confirmed alert / confirmed-fall window.
- **Trial-Level Limitation on Raw SisFall `.txt` Files (`labelGranularity === "trial_level"`)**: Official `.txt` files omit fall onset/offset timestamps, so every frame inherits the filename label (`fall:F01`). Frame-level recall is naturally depressed (pre-fall walking and post-fall stillness register as `FN`), and `eventEvaluation` is omitted (`available: false`) rather than manufacturing fall timestamps.
- **Current ML Fall Detection Scope (Pre-Stage 4)**: Because SisFall is IMU-only, 8 of the 11 Isolation Forest features use neutral imputed defaults (`HR/SpO2/Temp/HRV`), and Stage 4 fall-kinematics features (free-fall dip, jerk, tilt, post-fall stillness) are not yet added. Fall detection currently relies primarily on the `>= 2.8 g` impact indicator plus multi-window alert persistence.
