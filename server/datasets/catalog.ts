export type DatasetAccessTier =
  | "open_access"
  | "registration_required"
  | "restricted_dua"
  | "credentialed_required";

export type DatasetAgeCohort =
  | "mixed_young_and_elderly"
  | "wide_adult_including_elderly"
  | "general_adult"
  | "young_healthy_adults"
  | "adult_clinical_sleep"
  | "hospital_icu_mixed";

export interface PublicDatasetCatalogEntry {
  id: string;
  name: string;
  sourcePlatform: string;
  exactUrl: string;
  doiOrReference: string;
  accessTier: DatasetAccessTier;
  requiresManualDownload: boolean;
  accessInstructions: string;
  cohort: {
    ageGroup: DatasetAgeCohort;
    includesElderly: boolean;
    allParticipantsElderly: false;
    participantCountSummary: string;
    demographicsNote: string;
  };
  signalsAvailable: {
    ecg: boolean;
    ppgOrHr: boolean;
    spo2: boolean;
    temperature: boolean;
    temperatureSite: "skin_wrist" | "skin_chest" | "core_rectal" | "none";
    imuAccel: boolean;
    imuGyro: boolean;
    respiratoryRate: boolean;
    sleepStages: boolean;
    fallLabels: boolean;
  };
  samplingRatesNote: string;
  nativeFormats: string[];
  integratedLocally: false;
  stageStatus: "cataloged_stage1_adapter_pending_stage2";
}

export const PUBLIC_DATASET_CATALOG: PublicDatasetCatalogEntry[] = [
  {
    id: "bidmc_ppg_respiration",
    name: "BIDMC PPG and Respiration Dataset (v1.0.0)",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/bidmc/1.0.0/",
    doiOrReference: "Pimentel et al., IEEE TBME 2017; MIMIC-II matched subset",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on PhysioNet (no registration or DUA required). Download CSV or WFDB signal files manually and import in Stage 2.",
    cohort: {
      ageGroup: "wide_adult_including_elderly",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "53 adult ICU recordings (8 minutes each), ages ~19 to 90+ years",
      demographicsNote:
        "Hospitalized adult ICU cohort spanning young adults through elderly patients; not exclusively elderly.",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: true,
      spo2: true,
      temperature: false,
      temperatureSite: "none",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote: "125 Hz ECG/PPG/respiration waveforms; 1 Hz numeric HR, SpO2, RR CSVs",
    nativeFormats: ["CSV", "WFDB (.dat/.hea)"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "ppg_dalia",
    name: "PPG-DaLiA (PPG Dataset for Motion Compensation and Heart Rate Estimation in Daily Life Activities)",
    sourcePlatform: "UCI Machine Learning Repository (#495)",
    exactUrl: "https://archive.ics.uci.edu/dataset/495/ppg+dalia",
    doiOrReference: "Reiss et al., Sensors 2019; DOI: 10.24432/C53890",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on UCI ML Repository (no registration required). Download archive manually and import exported CSV frames in Stage 2.",
    cohort: {
      ageGroup: "general_adult",
      includesElderly: false,
      allParticipantsElderly: false,
      participantCountSummary: "15 subjects (8 female, 7 male), ages 21 to 55 years",
      demographicsNote:
        "Young to middle-aged healthy adults only; creators explicitly note the dataset lacks elderly participants and cardiovascular pathologies.",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: true,
      spo2: false,
      temperature: true,
      temperatureSite: "skin_wrist",
      imuAccel: true,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote:
      "Wrist Empatica E4 (BVP 64 Hz, ACC 32 Hz, EDA 4 Hz, skin temp 4 Hz); Chest RespiBAN (ECG/RESP/ACC 700 Hz)",
    nativeFormats: ["PKL", "CSV"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "wesad",
    name: "WESAD (Wearable Stress and Affect Detection)",
    sourcePlatform: "UCI Machine Learning Repository (#465)",
    exactUrl: "https://archive.ics.uci.edu/dataset/465/wesad+wearable+stress+and+affect+detection",
    doiOrReference: "Schmidt et al., ICMI 2018; DOI: 10.24432/C57K5T",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on UCI ML Repository (no registration required). Download manually and export subject CSVs for Stage 2 import.",
    cohort: {
      ageGroup: "young_healthy_adults",
      includesElderly: false,
      allParticipantsElderly: false,
      participantCountSummary: "15 subjects (12 male, 3 female), mean age 27.5 +/- 2.4 years (~24-35)",
      demographicsNote:
        "Exclusively young healthy university/graduate-aged adults; chronic illness and cardiovascular disease were excluded.",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: true,
      spo2: false,
      temperature: true,
      temperatureSite: "skin_wrist",
      imuAccel: true,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote: "Wrist E4 (BVP 64 Hz, ACC 32 Hz, temp 4 Hz); Chest RespiBAN (ECG/RESP/ACC/temp 700 Hz)",
    nativeFormats: ["PKL", "CSV"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "mitdb_arrhythmia",
    name: "MIT-BIH Arrhythmia Database",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/mitdb/",
    doiOrReference: "Moody & Mark, IEEE EMB Mag 2001; DOI: 10.13026/C2F305",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on PhysioNet (no registration required). Download WFDB records or LightWAVE CSV exports manually.",
    cohort: {
      ageGroup: "wide_adult_including_elderly",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "47 subjects (48 records): 25 men aged 32-89, 22 women aged 23-89",
      demographicsNote:
        "Clinical inpatient and outpatient adults spanning ages 23 to 89 (includes older/elderly cardiac patients alongside younger adults).",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: false,
      spo2: false,
      temperature: false,
      temperatureSite: "none",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: false,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote: "2-channel ambulatory ECG at 360 Hz with beat and rhythm annotations",
    nativeFormats: ["WFDB (.dat/.hea/.atr)", "CSV export"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "apnea_ecg",
    name: "Apnea-ECG Database (v1.0.0)",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/apnea-ecg/1.0.0/",
    doiOrReference: "Penzel et al., Computers in Cardiology 2000; DOI: 10.13026/C23W2R",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on PhysioNet (no registration required). Note that only the 8 '*r' records include SpO2 and respiration channels.",
    cohort: {
      ageGroup: "general_adult",
      includesElderly: false,
      allParticipantsElderly: false,
      participantCountSummary: "70 overnight ECG records from ~30-32 adult subjects (ages ~29-63 years)",
      demographicsNote:
        "General adult sleep-apnea evaluation cohort (typically middle-aged adults ~29-63 years; not an elderly-only cohort).",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: false,
      spo2: true,
      temperature: false,
      temperatureSite: "none",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote: "Single-lead ECG 100 Hz; SpO2 & respiratory channels at 100 Hz on 8 '*r' subset files",
    nativeFormats: ["WFDB (.dat/.hea/.apn)", "CSV export"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "sleep_edfx",
    name: "Sleep-EDF Database Expanded (v1.0.0)",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/sleep-edfx/1.0.0/",
    doiOrReference: "Kemp et al., IEEE TBME 2000; DOI: 10.13026/C2X676",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on PhysioNet (no registration required). Contains PSG EDF files (EEG/EOG/EMG/rectal temp/hypnograms); lacks SpO2, ECG, and IMU.",
    cohort: {
      ageGroup: "wide_adult_including_elderly",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "197 whole-night PSG recordings across SC (ages 25-101) and ST subsets",
      demographicsNote:
        "Healthy Sleep Cassette (SC) subset spans ages 25 to 101 years (includes both young/middle-aged adults and elderly adults).",
    },
    signalsAvailable: {
      ecg: false,
      ppgOrHr: false,
      spo2: false,
      temperature: true,
      temperatureSite: "core_rectal",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: true,
      fallLabels: false,
    },
    samplingRatesNote: "EEG/EOG 100 Hz; chin EMG, airflow, rectal body temperature 1 Hz; 30s hypnogram labels",
    nativeFormats: ["EDF (.edf)"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "sisfall",
    name: "SisFall: A Fall and Movement Dataset",
    sourcePlatform: "Univ. of Antioquia / Hugging Face Mirror",
    exactUrl: "https://huggingface.co/datasets/abys7315/Sisfall_Dataset",
    doiOrReference: "Sucerquia, Lopez & Vargas-Bonilla, Sensors 2017; DOI: 10.3390/s17010198",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open academic access (CC-BY citation). Download raw subject trial .txt files manually and import in Stage 2.",
    cohort: {
      ageGroup: "mixed_young_and_elderly",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary:
        "38 subjects total: 23 young adults (19-30y), 14 elderly adults (>62y) performing ADLs only, and 1 adult aged 60 performing ADLs + falls",
      demographicsNote:
        "Mixed cohort: 15 older/elderly participants (>60y) and 23 young adults; elderly participants performed ADLs (not falls), except one 60-year-old subject.",
    },
    signalsAvailable: {
      ecg: false,
      ppgOrHr: false,
      spo2: false,
      temperature: false,
      temperatureSite: "none",
      imuAccel: true,
      imuGyro: true,
      respiratoryRate: false,
      sleepStages: false,
      fallLabels: true,
    },
    samplingRatesNote: "200 Hz dual 3-axis accelerometers + 1 3-axis gyroscope; 19 ADLs & 15 fall types",
    nativeFormats: ["TXT (comma-delimited integer ADC columns)"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "umafall",
    name: "UMAFall Fall Detection Dataset",
    sourcePlatform: "Figshare (Universidad de Malaga)",
    exactUrl: "https://figshare.com/articles/dataset/UMAFall_Fall_Detection_Dataset_Universidad_de_Malaga_/6427357",
    doiOrReference: "Casilari, Santoyo-Ramon & Cano-Garcia, Sensors 2017",
    accessTier: "open_access",
    requiresManualDownload: true,
    accessInstructions:
      "Open access on Figshare (no registration required). Download zip archive manually and import CSV traces in Stage 2.",
    cohort: {
      ageGroup: "general_adult",
      includesElderly: false,
      allParticipantsElderly: false,
      participantCountSummary: "17-19 healthy volunteer subjects aged 18 to 55 years",
      demographicsNote:
        "Young to middle-aged healthy adults (18-55 years) simulating ADLs and falls; does not include an elderly cohort.",
    },
    signalsAvailable: {
      ecg: false,
      ppgOrHr: false,
      spo2: false,
      temperature: false,
      temperatureSite: "none",
      imuAccel: true,
      imuGyro: true,
      respiratoryRate: false,
      sleepStages: false,
      fallLabels: true,
    },
    samplingRatesNote: "20 Hz wearable nodes / 200 Hz smartphone 3-axis ACC, GYRO, MAG across 5 body nodes",
    nativeFormats: ["CSV"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "mobifall_v2",
    name: "MobiFall Dataset v2.0",
    sourcePlatform: "Kaggle Mirror (Biomedical Informatics & eHealth Lab, HMU)",
    exactUrl: "https://www.kaggle.com/datasets/shabytes/mobifall-dataset-v2.0",
    doiOrReference: "Vavoulas et al., IEEE BIBE 2013/2014",
    accessTier: "registration_required",
    requiresManualDownload: true,
    accessInstructions:
      "Free Kaggle account login required to download dataset archive manually before importing CSVs.",
    cohort: {
      ageGroup: "general_adult",
      includesElderly: false,
      allParticipantsElderly: false,
      participantCountSummary: "24 subjects (17 male, 7 female), ages 22 to 47 years",
      demographicsNote:
        "Young to middle-aged adults only (22-47 years); no elderly participants.",
    },
    signalsAvailable: {
      ecg: false,
      ppgOrHr: false,
      spo2: false,
      temperature: false,
      temperatureSite: "none",
      imuAccel: true,
      imuGyro: true,
      respiratoryRate: false,
      sleepStages: false,
      fallLabels: true,
    },
    samplingRatesNote: "Smartphone 3-axis accelerometer, gyroscope, and orientation logs",
    nativeFormats: ["TXT / CSV"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "dreamt",
    name: "DREAMT (Dataset for Real-time sleep stage EstimAtion using Multisensor wearable Technology)",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/dreamt/",
    doiOrReference: "DOI: 10.13026/3f7y-2d80 (Duke University Health System)",
    accessTier: "restricted_dua",
    requiresManualDownload: true,
    accessInstructions:
      "Restricted access: create a PhysioNet account and sign the PhysioNet Restricted Health Data License 1.5.0 / DUA, then download files manually.",
    cohort: {
      ageGroup: "adult_clinical_sleep",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "100 adult participants recruited from Duke Sleep Disorders Lab",
      demographicsNote:
        "Adult clinical sleep-disorders population (unselected adult clinic attendees spanning adult age ranges, not exclusively elderly).",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: true,
      spo2: true,
      temperature: true,
      temperatureSite: "skin_wrist",
      imuAccel: true,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: true,
      fallLabels: false,
    },
    samplingRatesNote: "Wrist Empatica E4 (BVP 64 Hz, ACC 32 Hz, skin temp 4 Hz, EDA 4 Hz) + clinical PSG (ECG, SpO2, EEG, sleep stages)",
    nativeFormats: ["CSV", "EDF"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "shhs_psg",
    name: "Sleep Heart Health Study (SHHS) PSG Database",
    sourcePlatform: "PhysioNet / NSRR",
    exactUrl: "https://physionet.org/content/shhs-psg/1.0.0/",
    doiOrReference: "Quan et al., Sleep 1997; NSRR / PhysioNet",
    accessTier: "restricted_dua",
    requiresManualDownload: true,
    accessInstructions:
      "Restricted / controlled access via NSRR or PhysioNet DUA approval. Download manually after approval.",
    cohort: {
      ageGroup: "wide_adult_including_elderly",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "Multi-center cohort of middle-aged and older adults aged >= 40 years",
      demographicsNote:
        "Community cohort of adults aged 40 years and older (includes middle-aged and elderly adults, not exclusively elderly).",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: false,
      spo2: true,
      temperature: false,
      temperatureSite: "none",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: true,
      fallLabels: false,
    },
    samplingRatesNote: "In-home PSG: ECG, finger oximetry (SpO2), airflow, respiratory effort, EEG/EOG/EMG, sleep staging",
    nativeFormats: ["EDF", "XML annotations"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
  {
    id: "mimic3wdb_matched",
    name: "MIMIC-III Waveform Database Matched Subset (v1.0)",
    sourcePlatform: "PhysioNet",
    exactUrl: "https://physionet.org/content/mimic3wdb-matched/1.0.0/",
    doiOrReference: "Moody et al.; Johnson et al., Scientific Data 2016",
    accessTier: "credentialed_required",
    requiresManualDownload: true,
    accessInstructions:
      "Credentialed PhysioNet access required (verified PhysioNet account + CITI human-subjects training + signed DUA). Must be downloaded manually.",
    cohort: {
      ageGroup: "hospital_icu_mixed",
      includesElderly: true,
      allParticipantsElderly: false,
      participantCountSummary: "22,317 waveform record sets across >10,000 ICU patients (adults & neonates)",
      demographicsNote:
        "Hospital ICU cohort spanning adult and neonatal critical care patients; includes older adults but is not an elderly-only dataset.",
    },
    signalsAvailable: {
      ecg: true,
      ppgOrHr: true,
      spo2: true,
      temperature: false,
      temperatureSite: "none",
      imuAccel: false,
      imuGyro: false,
      respiratoryRate: true,
      sleepStages: false,
      fallLabels: false,
    },
    samplingRatesNote: "125 Hz bedside waveforms (ECG, PPG, RESP, ABP) + 1 Hz numeric vital trends",
    nativeFormats: ["WFDB (.dat/.hea)"],
    integratedLocally: false,
    stageStatus: "cataloged_stage1_adapter_pending_stage2",
  },
];

export function getDatasetCatalog(): PublicDatasetCatalogEntry[] {
  return PUBLIC_DATASET_CATALOG;
}

export function getDatasetCatalogEntry(id: string): PublicDatasetCatalogEntry | undefined {
  return PUBLIC_DATASET_CATALOG.find((entry) => entry.id === id);
}
