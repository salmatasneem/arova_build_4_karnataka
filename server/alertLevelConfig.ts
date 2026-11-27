import type { AlertLevel, AlertPolicyConfig, MlAnalysisResult } from "./types.ts";

export const ALERT_LEVEL_IDS = ["Low", "Medium", "High"] as const;
export type AlertLevelId = (typeof ALERT_LEVEL_IDS)[number];

export type EscalationActionMode =
  | "log_only"
  | "dashboard_notify"
  | "automated_voice_call"
  | "emergency_escalation_chain";

export type CaregiverTargetMode = "none" | "primary" | "all_ordered";
export type HapticAlertPattern = "none" | "single_pulse" | "triple_alert";

export interface AlertLevelDetectionCriteria {
  mappedMlAlertLevels: AlertLevel[];
  requireAnomalousStatus: boolean;
  anomalyScoreMaxThreshold: number;
  minZScore: number;
  minPersistenceWindows: number;
}

export interface AlertLevelEscalationWorkflow {
  action: EscalationActionMode;
  notifyCaregivers: boolean;
  triggerAutomatedVoiceCall: boolean;
  requireExplicitConsent: boolean;
  caregiverPriorityTarget: CaregiverTargetMode;
  maxCallAttempts: number;
  retryIntervalSec: number;
  escalateToNextCaregiver: boolean;
  duplicateSuppressionWindowSec: number;
  hapticPattern: HapticAlertPattern;
}

export interface AlertLevelRuleDefinition {
  level: AlertLevelId;
  label: string;
  description: string;
  enabled: boolean;
  detection: AlertLevelDetectionCriteria;
  escalation: AlertLevelEscalationWorkflow;
}

export interface AlertLevelsPolicyConfig {
  version: number;
  updatedAt: string;
  updatedByUid: string;
  levels: Record<AlertLevelId, AlertLevelRuleDefinition>;
}

const VALID_ML_ALERT_LEVELS = new Set<AlertLevel>(["Normal", "Warning", "Critical"]);
const VALID_ESCALATION_ACTIONS = new Set<EscalationActionMode>([
  "log_only",
  "dashboard_notify",
  "automated_voice_call",
  "emergency_escalation_chain",
]);
const VALID_CAREGIVER_TARGETS = new Set<CaregiverTargetMode>(["none", "primary", "all_ordered"]);
const VALID_HAPTIC_PATTERNS = new Set<HapticAlertPattern>(["none", "single_pulse", "triple_alert"]);

function clampNumber(val: unknown, min: number, max: number, fallback: number, decimals?: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  const clamped = Math.max(min, Math.min(max, val));
  if (typeof decimals === "number") {
    return Number(clamped.toFixed(decimals));
  }
  return Math.round(clamped);
}

function cleanString(val: unknown, fallback: string, maxLen: number): string {
  if (typeof val !== "string") return fallback;
  const trimmed = val.trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : fallback;
}

export function getDefaultAlertLevelsPolicy(): AlertLevelsPolicyConfig {
  const nowIso = new Date().toISOString();
  return {
    version: 1,
    updatedAt: nowIso,
    updatedByUid: "system_default",
    levels: {
      Low: {
        level: "Low",
        label: "Low Severity · Early Deviation",
        description:
          "Single-window or mild personalized baseline deviation. Logged passively for trend review without waking caregivers.",
        enabled: true,
        detection: {
          mappedMlAlertLevels: ["Normal"],
          requireAnomalousStatus: true,
          anomalyScoreMaxThreshold: 0.05,
          minZScore: 1.5,
          minPersistenceWindows: 1,
        },
        escalation: {
          action: "log_only",
          notifyCaregivers: false,
          triggerAutomatedVoiceCall: false,
          requireExplicitConsent: true,
          caregiverPriorityTarget: "none",
          maxCallAttempts: 0,
          retryIntervalSec: 60,
          escalateToNextCaregiver: false,
          duplicateSuppressionWindowSec: 300,
          hapticPattern: "none",
        },
      },
      Medium: {
        level: "Medium",
        label: "Medium Severity · Sustained Warning",
        description:
          "Multi-window physiological deviation or Warning-level Isolation Forest anomaly. Alerts dashboard & primary caregiver.",
        enabled: true,
        detection: {
          mappedMlAlertLevels: ["Warning"],
          requireAnomalousStatus: false,
          anomalyScoreMaxThreshold: -0.05,
          minZScore: 2.0,
          minPersistenceWindows: 2,
        },
        escalation: {
          action: "dashboard_notify",
          notifyCaregivers: true,
          triggerAutomatedVoiceCall: false,
          requireExplicitConsent: true,
          caregiverPriorityTarget: "primary",
          maxCallAttempts: 1,
          retryIntervalSec: 45,
          escalateToNextCaregiver: false,
          duplicateSuppressionWindowSec: 300,
          hapticPattern: "single_pulse",
        },
      },
      High: {
        level: "High",
        label: "High Severity · Critical Emergency",
        description:
          "Severe multi-signal deviation, acute threshold breach, or confirmed fall event. Triggers automated emergency escalation chain.",
        enabled: true,
        detection: {
          mappedMlAlertLevels: ["Critical"],
          requireAnomalousStatus: false,
          anomalyScoreMaxThreshold: -0.18,
          minZScore: 3.0,
          minPersistenceWindows: 3,
        },
        escalation: {
          action: "emergency_escalation_chain",
          notifyCaregivers: true,
          triggerAutomatedVoiceCall: true,
          requireExplicitConsent: true,
          caregiverPriorityTarget: "all_ordered",
          maxCallAttempts: 2,
          retryIntervalSec: 30,
          escalateToNextCaregiver: true,
          duplicateSuppressionWindowSec: 600,
          hapticPattern: "triple_alert",
        },
      },
    },
  };
}

function sanitizeRule(
  level: AlertLevelId,
  rawRule: unknown,
  fallback: AlertLevelRuleDefinition
): AlertLevelRuleDefinition {
  if (!rawRule || typeof rawRule !== "object") {
    return {
      ...fallback,
      detection: { ...fallback.detection, mappedMlAlertLevels: [...fallback.detection.mappedMlAlertLevels] },
      escalation: { ...fallback.escalation },
    };
  }

  const obj = rawRule as Record<string, unknown>;
  const rawDet = (obj.detection && typeof obj.detection === "object"
    ? obj.detection
    : {}) as Record<string, unknown>;
  const rawEsc = (obj.escalation && typeof obj.escalation === "object"
    ? obj.escalation
    : {}) as Record<string, unknown>;

  const rawMapped = Array.isArray(rawDet.mappedMlAlertLevels)
    ? rawDet.mappedMlAlertLevels.filter(
        (v): v is AlertLevel => typeof v === "string" && VALID_ML_ALERT_LEVELS.has(v as AlertLevel)
      )
    : [];
  const dedupedMapped = Array.from(new Set(rawMapped));

  const action: EscalationActionMode =
    typeof rawEsc.action === "string" && VALID_ESCALATION_ACTIONS.has(rawEsc.action as EscalationActionMode)
      ? (rawEsc.action as EscalationActionMode)
      : fallback.escalation.action;

  const caregiverPriorityTarget: CaregiverTargetMode =
    typeof rawEsc.caregiverPriorityTarget === "string" &&
    VALID_CAREGIVER_TARGETS.has(rawEsc.caregiverPriorityTarget as CaregiverTargetMode)
      ? (rawEsc.caregiverPriorityTarget as CaregiverTargetMode)
      : fallback.escalation.caregiverPriorityTarget;

  const hapticPattern: HapticAlertPattern =
    typeof rawEsc.hapticPattern === "string" &&
    VALID_HAPTIC_PATTERNS.has(rawEsc.hapticPattern as HapticAlertPattern)
      ? (rawEsc.hapticPattern as HapticAlertPattern)
      : fallback.escalation.hapticPattern;

  const triggerVoiceFromAction =
    action === "automated_voice_call" || action === "emergency_escalation_chain";

  return {
    level,
    label: cleanString(obj.label, fallback.label, 80),
    description: cleanString(obj.description, fallback.description, 300),
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : fallback.enabled,
    detection: {
      mappedMlAlertLevels:
        dedupedMapped.length > 0 ? dedupedMapped : [...fallback.detection.mappedMlAlertLevels],
      requireAnomalousStatus:
        typeof rawDet.requireAnomalousStatus === "boolean"
          ? rawDet.requireAnomalousStatus
          : fallback.detection.requireAnomalousStatus,
      anomalyScoreMaxThreshold: clampNumber(
        rawDet.anomalyScoreMaxThreshold,
        -1.0,
        0.5,
        fallback.detection.anomalyScoreMaxThreshold,
        3
      ),
      minZScore: clampNumber(rawDet.minZScore, 0.5, 8.0, fallback.detection.minZScore, 2),
      minPersistenceWindows: clampNumber(
        rawDet.minPersistenceWindows,
        1,
        15,
        fallback.detection.minPersistenceWindows
      ),
    },
    escalation: {
      action,
      notifyCaregivers:
        typeof rawEsc.notifyCaregivers === "boolean"
          ? rawEsc.notifyCaregivers
          : action !== "log_only",
      triggerAutomatedVoiceCall:
        typeof rawEsc.triggerAutomatedVoiceCall === "boolean"
          ? rawEsc.triggerAutomatedVoiceCall
          : triggerVoiceFromAction,
      requireExplicitConsent:
        typeof rawEsc.requireExplicitConsent === "boolean"
          ? rawEsc.requireExplicitConsent
          : fallback.escalation.requireExplicitConsent,
      caregiverPriorityTarget,
      maxCallAttempts: clampNumber(rawEsc.maxCallAttempts, 0, 5, fallback.escalation.maxCallAttempts),
      retryIntervalSec: clampNumber(rawEsc.retryIntervalSec, 10, 600, fallback.escalation.retryIntervalSec),
      escalateToNextCaregiver:
        typeof rawEsc.escalateToNextCaregiver === "boolean"
          ? rawEsc.escalateToNextCaregiver
          : action === "emergency_escalation_chain",
      duplicateSuppressionWindowSec: clampNumber(
        rawEsc.duplicateSuppressionWindowSec,
        0,
        3600,
        fallback.escalation.duplicateSuppressionWindowSec
      ),
      hapticPattern,
    },
  };
}

export function sanitizeAlertLevelsPolicy(
  input: unknown,
  actorUid = "system_admin",
  current?: AlertLevelsPolicyConfig
): AlertLevelsPolicyConfig {
  const base = current ?? getDefaultAlertLevelsPolicy();
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawLevels =
    obj.levels && typeof obj.levels === "object" ? (obj.levels as Record<string, unknown>) : obj;

  return {
    version:
      typeof obj.version === "number" && Number.isFinite(obj.version)
        ? Math.max(1, Math.round(obj.version))
        : base.version,
    updatedAt: new Date().toISOString(),
    updatedByUid: cleanString(actorUid, "system_admin", 128),
    levels: {
      Low: sanitizeRule("Low", rawLevels.Low, base.levels.Low),
      Medium: sanitizeRule("Medium", rawLevels.Medium, base.levels.Medium),
      High: sanitizeRule("High", rawLevels.High, base.levels.High),
    },
  };
}

export function buildPolicyConfigFromAlertLevels(
  policy: AlertLevelsPolicyConfig,
  baselineMinSamples = 20
): AlertPolicyConfig {
  const med = policy.levels.Medium.detection;
  const high = policy.levels.High.detection;
  return {
    baselineMinSamples: Math.max(5, Math.min(5000, Math.round(baselineMinSamples))),
    warningPersistenceWindows: Math.max(1, Math.min(10, med.minPersistenceWindows)),
    criticalPersistenceWindows: Math.max(1, Math.min(15, high.minPersistenceWindows)),
    anomalyScoreWarningThreshold: med.anomalyScoreMaxThreshold,
    anomalyScoreCriticalThreshold: high.anomalyScoreMaxThreshold,
    zScoreWarningThreshold: med.minZScore,
    zScoreCriticalThreshold: high.minZScore,
  };
}

export function classifyAnalysisWithAlertLevelsPolicy(
  analysis: Pick<MlAnalysisResult, "alertLevel" | "anomalyStatus" | "anomalyScore" | "persistenceCount">,
  policy: AlertLevelsPolicyConfig
): {
  severity: AlertLevelId | null;
  rule: AlertLevelRuleDefinition | null;
  escalationPlan: AlertLevelEscalationWorkflow | null;
} {
  if (analysis.anomalyStatus === "paused_poor_quality") {
    return { severity: null, rule: null, escalationPlan: null };
  }

  const orderedLevels: AlertLevelId[] = ["High", "Medium", "Low"];
  for (const level of orderedLevels) {
    const rule = policy.levels[level];
    if (!rule?.enabled) continue;

    const mlMatches = rule.detection.mappedMlAlertLevels.includes(analysis.alertLevel);
    const statusMatches = !rule.detection.requireAnomalousStatus || analysis.anomalyStatus === "anomalous";

    if (mlMatches && statusMatches) {
      return {
        severity: level,
        rule,
        escalationPlan: rule.escalation,
      };
    }
  }

  return { severity: null, rule: null, escalationPlan: null };
}
