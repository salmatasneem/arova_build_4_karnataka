import type {
  FallDetectionState,
  FallSensorFusionStatus,
  VitalReading,
} from "../types/smartcare.ts";

export interface PoseLandmarkPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export interface FallDetectionSettings {
  confidenceThreshold: number;
  downwardVelocityThreshold: number;
  horizontalAngleDeg: number;
  lyingHoldDurationSec: number;
  confirmationCountdownSec: number;
  allowWarningOnRapidChange: boolean;
}

export const DEFAULT_FALL_DETECTION_SETTINGS: FallDetectionSettings = {
  confidenceThreshold: 0.45,
  downwardVelocityThreshold: 0.42,
  horizontalAngleDeg: 58,
  lyingHoldDurationSec: 1.2,
  confirmationCountdownSec: 20,
  allowWarningOnRapidChange: true,
};

export type PoseActivityClassification =
  | "standing"
  | "walking"
  | "sitting"
  | "bending"
  | "exercising"
  | "intentional_lying"
  | "sudden_fall"
  | "low_confidence"
  | "out_of_frame"
  | "multiple_people";

export interface PoseFrameSample {
  timestampMs: number;
  torsoAngleDeg: number;
  headX: number;
  headY: number;
  hipY: number;
  kneeY: number;
  ankleY: number;
  bodyHeightNorm: number;
  confidence: number;
}

export interface FallEvaluationResult {
  state: FallDetectionState;
  activity: PoseActivityClassification;
  confidence: number;
  torsoAngleDeg: number;
  verticalVelocity: number;
  horizontalDurationSec: number;
  orientationChangeRateDegPerSec: number;
  framePositionStatus: "centered" | "partial_edge" | "out_of_frame";
  peopleCount: number;
  poseQualityOk: boolean;
  reason: string;
  indicators: string[];
  landmarksSummary: {
    head: { x: number; y: number } | null;
    shouldersMid: { x: number; y: number } | null;
    hipsMid: { x: number; y: number } | null;
    kneesMid: { x: number; y: number } | null;
    anklesMid: { x: number; y: number } | null;
  };
}

export interface SensorFusionEvaluation {
  finalState: FallDetectionState;
  sensorFusionStatus: FallSensorFusionStatus;
  wearableSummary: string;
  sensorDisagreement: boolean;
  explanation: string;
}

export type DemoFallScenario =
  | "standing"
  | "walking"
  | "sitting"
  | "bending"
  | "intentional_lying"
  | "sudden_fall"
  | "out_of_frame"
  | "low_confidence"
  | "multiple_people";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function getLmConfidence(lm?: PoseLandmarkPoint): number {
  if (!lm) return 0;
  const vis = typeof lm.visibility === "number" ? lm.visibility : 0.85;
  const pres = typeof lm.presence === "number" ? lm.presence : 0.85;
  return clamp((vis + pres) / 2, 0, 1);
}

function midpoint(a?: PoseLandmarkPoint, b?: PoseLandmarkPoint): PoseLandmarkPoint | null {
  if (!a && !b) return null;
  if (a && !b) return a;
  if (!a && b) return b;
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: typeof a.z === "number" && typeof b.z === "number" ? (a.z + b.z) / 2 : 0,
    visibility: (getLmConfidence(a) + getLmConfidence(b)) / 2,
    presence: (getLmConfidence(a) + getLmConfidence(b)) / 2,
  };
}

export class TemporalFallDetector {
  private history: PoseFrameSample[] = [];
  private horizontalStartMs: number | null = null;
  private warningStartMs: number | null = null;
  private lastHipYVelocitySamples: number[] = [];

  public reset(): void {
    this.history = [];
    this.horizontalStartMs = null;
    this.warningStartMs = null;
    this.lastHipYVelocitySamples = [];
  }

  public evaluateFrame(
    poses: PoseLandmarkPoint[][],
    timestampMs: number,
    settings: FallDetectionSettings = DEFAULT_FALL_DETECTION_SETTINGS
  ): FallEvaluationResult {
    const peopleCount = poses.length;

    if (peopleCount === 0 || !poses[0] || poses[0].length < 29) {
      this.horizontalStartMs = null;
      return {
        state: "Normal",
        activity: "out_of_frame",
        confidence: 0,
        torsoAngleDeg: 0,
        verticalVelocity: 0,
        horizontalDurationSec: 0,
        orientationChangeRateDegPerSec: 0,
        framePositionStatus: "out_of_frame",
        peopleCount,
        poseQualityOk: false,
        reason: "Person not detected – Please check camera positioning.",
        indicators: [],
        landmarksSummary: {
          head: null,
          shouldersMid: null,
          hipsMid: null,
          kneesMid: null,
          anklesMid: null,
        },
      };
    }

    // Track primary person (largest / most visible landmark spread)
    const primaryPose = [...poses].sort((a, b) => {
      const confA =
        (getLmConfidence(a[0]) +
          getLmConfidence(a[11]) +
          getLmConfidence(a[12]) +
          getLmConfidence(a[23]) +
          getLmConfidence(a[24])) /
        5;
      const confB =
        (getLmConfidence(b[0]) +
          getLmConfidence(b[11]) +
          getLmConfidence(b[12]) +
          getLmConfidence(b[23]) +
          getLmConfidence(b[24])) /
        5;
      return confB - confA;
    })[0];

    const nose = primaryPose[0];
    const leftEar = primaryPose[7];
    const rightEar = primaryPose[8];
    const head = nose ?? midpoint(leftEar, rightEar) ?? undefined;
    const shouldersMid = midpoint(primaryPose[11], primaryPose[12]);
    const hipsMid = midpoint(primaryPose[23], primaryPose[24]);
    const kneesMid = midpoint(primaryPose[25], primaryPose[26]);
    const anklesMid = midpoint(primaryPose[27], primaryPose[28]);

    const keyConfidences = [
      getLmConfidence(head),
      getLmConfidence(primaryPose[11]),
      getLmConfidence(primaryPose[12]),
      getLmConfidence(primaryPose[23]),
      getLmConfidence(primaryPose[24]),
      getLmConfidence(primaryPose[25]),
      getLmConfidence(primaryPose[26]),
    ];
    const avgConfidence = Number(
      (keyConfidences.reduce((sum, c) => sum + c, 0) / keyConfidences.length).toFixed(2)
    );

    const lowerConf =
      (getLmConfidence(primaryPose[25]) +
        getLmConfidence(primaryPose[26]) +
        getLmConfidence(primaryPose[27]) +
        getLmConfidence(primaryPose[28])) /
      4;

    const trackedPoints = [head, shouldersMid, hipsMid, kneesMid, anklesMid].filter(
      (p): p is PoseLandmarkPoint => Boolean(p)
    );
    const outOfBoundsCount = trackedPoints.filter(
      (p) => p.x < 0.04 || p.x > 0.96 || p.y < 0.04 || p.y > 0.97
    ).length;

    const framePositionStatus: FallEvaluationResult["framePositionStatus"] =
      trackedPoints.length < 3 || outOfBoundsCount >= 3
        ? "out_of_frame"
        : outOfBoundsCount >= 1
        ? "partial_edge"
        : "centered";

    // Calculate torso angle from vertical axis (0 = upright, 90 = horizontal)
    const upperAnchor = shouldersMid ?? head;
    const lowerAnchor = hipsMid;
    let torsoAngleDeg = 0;
    if (upperAnchor && lowerAnchor) {
      const dx = Math.abs(upperAnchor.x - lowerAnchor.x);
      const dy = Math.abs(lowerAnchor.y - upperAnchor.y);
      torsoAngleDeg = Number(((Math.atan2(dx, Math.max(0.01, dy)) * 180) / Math.PI).toFixed(1));
    }

    // Overall body vertical height normalized
    const bodyHeightNorm =
      head && (anklesMid || kneesMid || hipsMid)
        ? Math.abs((anklesMid ?? kneesMid ?? hipsMid)!.y - head.y)
        : 0.4;

    const currentSample: PoseFrameSample = {
      timestampMs,
      torsoAngleDeg,
      headX: head?.x ?? 0.5,
      headY: head?.y ?? 0.5,
      hipY: hipsMid?.y ?? 0.65,
      kneeY: kneesMid?.y ?? 0.8,
      ankleY: anklesMid?.y ?? 0.92,
      bodyHeightNorm,
      confidence: avgConfidence,
    };

    const landmarksSummary = {
      head: head ? { x: Number(head.x.toFixed(3)), y: Number(head.y.toFixed(3)) } : null,
      shouldersMid: shouldersMid
        ? { x: Number(shouldersMid.x.toFixed(3)), y: Number(shouldersMid.y.toFixed(3)) }
        : null,
      hipsMid: hipsMid ? { x: Number(hipsMid.x.toFixed(3)), y: Number(hipsMid.y.toFixed(3)) } : null,
      kneesMid: kneesMid ? { x: Number(kneesMid.x.toFixed(3)), y: Number(kneesMid.y.toFixed(3)) } : null,
      anklesMid: anklesMid
        ? { x: Number(anklesMid.x.toFixed(3)), y: Number(anklesMid.y.toFixed(3)) }
        : null,
    };

    // Handle poor lighting / low confidence -> Uncertain / Warning state (never false fall)
    if (avgConfidence < settings.confidenceThreshold) {
      this.horizontalStartMs = null;
      return {
        state: "Warning",
        activity: "low_confidence",
        confidence: avgConfidence,
        torsoAngleDeg,
        verticalVelocity: 0,
        horizontalDurationSec: 0,
        orientationChangeRateDegPerSec: 0,
        framePositionStatus,
        peopleCount,
        poseQualityOk: false,
        reason: `Low visibility – Fall detection accuracy may be reduced (${Math.round(
          avgConfidence * 100
        )}% landmark confidence).`,
        indicators: ["low_visibility"],
        landmarksSummary,
      };
    }

    if (framePositionStatus === "out_of_frame") {
      this.horizontalStartMs = null;
      return {
        state: "Normal",
        activity: "out_of_frame",
        confidence: avgConfidence,
        torsoAngleDeg,
        verticalVelocity: 0,
        horizontalDurationSec: 0,
        orientationChangeRateDegPerSec: 0,
        framePositionStatus,
        peopleCount,
        poseQualityOk: false,
        reason: "Person not detected – Please check camera positioning.",
        indicators: [],
        landmarksSummary,
      };
    }

    // Maintain sliding temporal window (~4 seconds)
    this.history.push(currentSample);
    this.history = this.history.filter((s) => timestampMs - s.timestampMs <= 4000);

    // Compute temporal deltas over recent window (300ms to 1200ms lookback)
    const lookbackSample =
      [...this.history]
        .reverse()
        .find((s) => timestampMs - s.timestampMs >= 250 && timestampMs - s.timestampMs <= 1400) ??
      this.history[0];

    const dtSec = Math.max(0.08, (timestampMs - lookbackSample.timestampMs) / 1000);
    // Positive y velocity in normalized screen coords = downward movement
    const headVel = (currentSample.headY - lookbackSample.headY) / dtSec;
    const hipVel = (currentSample.hipY - lookbackSample.hipY) / dtSec;
    const verticalVelocity = Number(Math.max(headVel, hipVel * 0.95).toFixed(3));
    const orientationChangeRate = Number(
      ((currentSample.torsoAngleDeg - lookbackSample.torsoAngleDeg) / dtSec).toFixed(1)
    );

    this.lastHipYVelocitySamples.push(verticalVelocity);
    if (this.lastHipYVelocitySamples.length > 10) {
      this.lastHipYVelocitySamples.shift();
    }

    // Track peak recent downward velocity & rapid angle shift in the past 2.5 seconds
    let peakDownwardVelocity = verticalVelocity;
    let peakOrientationRate = orientationChangeRate;
    let sawUprightRecently = lookbackSample.torsoAngleDeg < 35;

    for (let i = 1; i < this.history.length; i++) {
      const prev = this.history[i - 1];
      const curr = this.history[i];
      if (curr.torsoAngleDeg < 35 || prev.torsoAngleDeg < 35) {
        sawUprightRecently = true;
      }
      const stepDt = Math.max(0.08, (curr.timestampMs - prev.timestampMs) / 1000);
      const stepVel = Math.max(
        (curr.headY - prev.headY) / stepDt,
        ((curr.hipY - prev.hipY) / stepDt) * 0.95
      );
      const stepAngleRate = (curr.torsoAngleDeg - prev.torsoAngleDeg) / stepDt;
      if (stepVel > peakDownwardVelocity) peakDownwardVelocity = stepVel;
      if (stepAngleRate > peakOrientationRate) peakOrientationRate = stepAngleRate;
    }

    const isHorizontal = torsoAngleDeg >= settings.horizontalAngleDeg;
    if (isHorizontal) {
      if (this.horizontalStartMs === null) {
        this.horizontalStartMs = timestampMs;
      }
    } else {
      this.horizontalStartMs = null;
    }
    const horizontalDurationSec =
      this.horizontalStartMs !== null
        ? Number(((timestampMs - this.horizontalStartMs) / 1000).toFixed(2))
        : 0;

    // Check normal non-fall activities first to minimize false positives:
    // 1. Multiple people in frame -> ambiguity safeguard
    const multiplePeopleWarning = peopleCount > 1;

    // 2. Sitting: upright torso (< 38 deg), bent knees (hip-to-knee vertical drop smaller, hip lower in frame)
    const kneeHipGap = kneesMid && hipsMid ? Math.abs(kneesMid.y - hipsMid.y) : 0.2;
    const isSittingPosture =
      !isHorizontal &&
      torsoAngleDeg < 38 &&
      hipsMid !== null &&
      kneesMid !== null &&
      lowerConf >= 0.3 &&
      kneeHipGap < 0.16 &&
      peakDownwardVelocity < settings.downwardVelocityThreshold * 1.15;

    const legVerticalSpan =
      anklesMid && hipsMid ? Math.abs(anklesMid.y - hipsMid.y) : 0.3;

    // 3. Bending down cleanly: torso tilts forward (32-72 deg) briefly while hips stay near standing height, legs stay vertical, and downward velocity is controlled
    const isControlledBending =
      torsoAngleDeg >= 32 &&
      torsoAngleDeg <= 72 &&
      peakDownwardVelocity < settings.downwardVelocityThreshold &&
      (hipsMid?.y ?? 0.5) < 0.66 &&
      legVerticalSpan > 0.24 &&
      horizontalDurationSec < settings.lyingHoldDurationSec;

    // 4. Exercising: oscillating vertical movement (both upward & downward spikes without sustained horizontal lying)
    const hasOscillation =
      this.lastHipYVelocitySamples.some((v) => v > 0.25) &&
      this.lastHipYVelocitySamples.some((v) => v < -0.22);
    const isExercising = !isHorizontal && hasOscillation;

    // 5. Intentional slow lying down (e.g. bed rest): horizontal angle achieved gradually without sudden high downward drop velocity
    const isIntentionalLying =
      isHorizontal &&
      peakDownwardVelocity < settings.downwardVelocityThreshold &&
      peakOrientationRate < 55;

    const indicators: string[] = [];
    if (peakDownwardVelocity >= settings.downwardVelocityThreshold) {
      indicators.push(`sudden_downward_drop (${peakDownwardVelocity.toFixed(2)}/s)`);
    }
    if (peakOrientationRate >= 55) {
      indicators.push(`rapid_posture_shift (${peakOrientationRate.toFixed(0)} deg/s)`);
    }
    if (isHorizontal) {
      indicators.push(`horizontal_torso (${torsoAngleDeg.toFixed(0)} deg)`);
    }
    if (sawUprightRecently && isHorizontal) {
      indicators.push("upright_to_horizontal_transition");
    }
    if (horizontalDurationSec >= settings.lyingHoldDurationSec) {
      indicators.push(`sustained_horizontal (${horizontalDurationSec.toFixed(1)}s)`);
    }

    // Decision logic: multi-criteria confirmation
    let state: FallDetectionState = "Normal";
    let activity: PoseActivityClassification = "standing";
    let reason = "Normal upright or seated posture monitored.";

    const ankleStrideSpread =
      primaryPose[27] && primaryPose[28]
        ? Math.abs(primaryPose[27].x - primaryPose[28].x)
        : 0;
    const horizontalDisplacement = Math.abs(currentSample.headX - lookbackSample.headX);
    const isWalking =
      !isHorizontal &&
      torsoAngleDeg < 28 &&
      peakDownwardVelocity < settings.downwardVelocityThreshold &&
      (ankleStrideSpread >= 0.12 || horizontalDisplacement >= 0.025);

    if (
      isHorizontal &&
      horizontalDurationSec >= settings.lyingHoldDurationSec &&
      (peakDownwardVelocity >= settings.downwardVelocityThreshold || peakOrientationRate >= 55) &&
      sawUprightRecently &&
      !multiplePeopleWarning
    ) {
      state = "Possible Fall";
      activity = "sudden_fall";
      reason = `Multiple fall indicators detected: rapid downward transition (${peakDownwardVelocity.toFixed(
        2
      )}/s), torso at ${torsoAngleDeg.toFixed(0)}°, sustained horizontal posture (${horizontalDurationSec.toFixed(
        1
      )}s).`;
    } else if (multiplePeopleWarning) {
      state = "Warning";
      activity = "multiple_people";
      reason = `Multiple people (${peopleCount}) visible in camera frame — ambiguous tracking; automatic fall attribution paused to prevent assigning a fall to the wrong patient.`;
    } else if (isIntentionalLying) {
      state = "Normal";
      activity = "intentional_lying";
      reason = `Controlled horizontal posture (${torsoAngleDeg.toFixed(
        0
      )}°, gentle transition ${peakDownwardVelocity.toFixed(2)}/s) — classified as intentional resting/lying down, not a fall.`;
    } else if (isSittingPosture) {
      state = "Normal";
      activity = "sitting";
      reason = "Seated posture detected — controlled transition with upright torso.";
    } else if (isControlledBending) {
      state = "Normal";
      activity = "bending";
      reason = "Controlled forward bend detected — upright recovery posture maintained.";
    } else if (isExercising) {
      state = "Normal";
      activity = "exercising";
      reason = "Repetitive upward/downward motion detected — classified as active exercise.";
    } else if (isWalking) {
      state = "Normal";
      activity = "walking";
      reason = "Normal upright walking motion detected.";
    } else if (
      settings.allowWarningOnRapidChange &&
      (isHorizontal ||
        ((verticalVelocity >= settings.downwardVelocityThreshold * 0.65 ||
          orientationChangeRate >= 35) &&
          (peakDownwardVelocity >= settings.downwardVelocityThreshold ||
            peakOrientationRate >= 55)))
    ) {
      if (this.warningStartMs === null) {
        this.warningStartMs = timestampMs;
      }
      state = "Warning";
      activity = isHorizontal ? "sudden_fall" : "standing";
      reason = isHorizontal
        ? `Unusual horizontal posture (${torsoAngleDeg.toFixed(0)}°) observed (${horizontalDurationSec.toFixed(
            1
          )}s/${settings.lyingHoldDurationSec.toFixed(1)}s hold window) — monitoring subsequent frames.`
        : `Unusual Movement Detected: rapid downward shift or torso tilt (${peakDownwardVelocity.toFixed(
            2
          )}/s) — monitoring for recovery.`;
    } else {
      this.warningStartMs = null;
      state = "Normal";
      activity = torsoAngleDeg < 28 ? "standing" : "bending";
      reason = "Normal upright posture with stable landmarks.";
    }

    return {
      state,
      activity,
      confidence: avgConfidence,
      torsoAngleDeg,
      verticalVelocity: Number(peakDownwardVelocity.toFixed(3)),
      horizontalDurationSec,
      orientationChangeRateDegPerSec: Number(peakOrientationRate.toFixed(1)),
      framePositionStatus,
      peopleCount,
      poseQualityOk: true,
      reason,
      indicators,
      landmarksSummary,
    };
  }
}

export function combineWebcamAndWearableSignals(
  poseEval: FallEvaluationResult,
  latestWearableReading: VitalReading | null
): SensorFusionEvaluation {
  if (!latestWearableReading) {
    return {
      finalState: poseEval.state,
      sensorFusionStatus: "webcam_only",
      wearableSummary: "Wearable hardware/simulator offline — operating in standalone webcam mode.",
      sensorDisagreement: false,
      explanation: poseEval.reason,
    };
  }

  const ageMs = Date.now() - new Date(latestWearableReading.createdAt).getTime();
  const isFresh = Number.isFinite(ageMs) && ageMs <= 45_000;
  if (!isFresh) {
    return {
      finalState: poseEval.state,
      sensorFusionStatus: "webcam_only",
      wearableSummary: "Last wearable reading is stale (>45s) — operating in standalone webcam mode.",
      sensorDisagreement: false,
      explanation: poseEval.reason,
    };
  }

  const accelMag = latestWearableReading.accelMagnitude ?? 1.0;
  const gyroMag = latestWearableReading.gyroMagnitude ?? 0;
  const imuFallSuspect = Boolean(
    latestWearableReading.possibleFallDetected ||
      latestWearableReading.movementStatus === "fall_suspect" ||
      accelMag >= 2.1 ||
      gyroMag >= 45
  );
  const imuCalmStandingOrResting =
    !imuFallSuspect &&
    (latestWearableReading.movementStatus === "resting" ||
      latestWearableReading.movementStatus === "walking") &&
    accelMag >= 0.8 &&
    accelMag <= 1.25 &&
    gyroMag < 18;

  const hrText =
    typeof latestWearableReading.heartRate === "number"
      ? `${Math.round(latestWearableReading.heartRate)} BPM`
      : "-- BPM";
  const spo2Text =
    typeof latestWearableReading.spo2 === "number"
      ? `${latestWearableReading.spo2.toFixed(1)}%`
      : "--%";
  const wearableSummary = `Wearable (${latestWearableReading.source}): IMU ${accelMag.toFixed(
    2
  )}g (${latestWearableReading.movementStatus}), HR ${hrText}, SpO2 ${spo2Text}`;

  if (poseEval.state === "Possible Fall" && imuFallSuspect) {
    return {
      finalState: "Possible Fall",
      sensorFusionStatus: "corroborated",
      wearableSummary,
      sensorDisagreement: false,
      explanation: `${poseEval.reason} Corroborated by wearable MPU6050 impact/orientation spike (${accelMag.toFixed(
        2
      )}g).`,
    };
  }

  if (poseEval.state === "Possible Fall" && imuCalmStandingOrResting) {
    // Disagreement safety check: downgrade automated critical trigger to Warning so operator/user verifies directly
    return {
      finalState: "Warning",
      sensorFusionStatus: "sensor_disagreement",
      wearableSummary,
      sensorDisagreement: true,
      explanation: `Webcam & wearable signals disagree: pose estimation flagged a horizontal fall, while live wearable IMU remains steady (${accelMag.toFixed(
        2
      )}g, ${latestWearableReading.movementStatus}). Downgraded to Warning for verification.`,
    };
  }

  if (poseEval.state === "Normal" && imuFallSuspect) {
    return {
      finalState: "Warning",
      sensorFusionStatus: "sensor_disagreement",
      wearableSummary,
      sensorDisagreement: true,
      explanation: `Webcam & wearable signals disagree: wearable IMU flagged fall_suspect (${accelMag.toFixed(
        2
      )}g) while webcam posture appears normal/upright.`,
    };
  }

  return {
    finalState: poseEval.state,
    sensorFusionStatus: poseEval.state === "Normal" ? "corroborated" : "webcam_only",
    wearableSummary,
    sensorDisagreement: false,
    explanation: poseEval.reason,
  };
}

function buildPoseFromJointCoords(params: {
  headX: number;
  headY: number;
  shoulderWidth?: number;
  shoulderOffsetX?: number;
  shoulderY: number;
  hipX: number;
  hipY: number;
  kneeX: number;
  kneeY: number;
  ankleX: number;
  ankleY: number;
  confidence?: number;
}): PoseLandmarkPoint[] {
  const conf = params.confidence ?? 0.92;
  const sw = params.shoulderWidth ?? 0.12;
  const sx = params.shoulderOffsetX ?? params.headX;
  const arr: PoseLandmarkPoint[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: conf * 0.6,
    presence: conf * 0.6,
  }));

  const setPt = (idx: number, x: number, y: number, c = conf) => {
    arr[idx] = { x, y, z: 0, visibility: c, presence: c };
  };

  setPt(0, params.headX, params.headY); // Nose / Head
  setPt(7, params.headX - 0.025, params.headY + 0.005); // Left ear
  setPt(8, params.headX + 0.025, params.headY + 0.005); // Right ear

  setPt(11, sx - sw / 2, params.shoulderY); // Left shoulder
  setPt(12, sx + sw / 2, params.shoulderY); // Right shoulder
  setPt(13, sx - sw / 2 - 0.03, (params.shoulderY + params.hipY) / 2); // Left elbow
  setPt(14, sx + sw / 2 + 0.03, (params.shoulderY + params.hipY) / 2); // Right elbow
  setPt(15, sx - sw / 2 - 0.04, params.hipY + 0.02); // Left wrist
  setPt(16, sx + sw / 2 + 0.04, params.hipY + 0.02); // Right wrist

  setPt(23, params.hipX - sw * 0.38, params.hipY); // Left hip
  setPt(24, params.hipX + sw * 0.38, params.hipY); // Right hip
  setPt(25, params.kneeX - sw * 0.38, params.kneeY); // Left knee
  setPt(26, params.kneeX + sw * 0.38, params.kneeY); // Right knee
  setPt(27, params.ankleX - sw * 0.36, params.ankleY); // Left ankle
  setPt(28, params.ankleX + sw * 0.36, params.ankleY); // Right ankle

  return arr;
}

export interface SimulatedPoseFrame {
  timestampMs: number;
  poses: PoseLandmarkPoint[][];
  label: string;
}

export function generateSimulatedPoseSequence(
  scenario: DemoFallScenario,
  baseTimestampMs = 10_000
): SimulatedPoseFrame[] {
  const frames: SimulatedPoseFrame[] = [];

  if (scenario === "standing") {
    for (let i = 0; i < 8; i++) {
      frames.push({
        timestampMs: baseTimestampMs + i * 250,
        label: "Standing upright",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.5,
            headY: 0.16,
            shoulderY: 0.28,
            hipX: 0.5,
            hipY: 0.52,
            kneeX: 0.5,
            kneeY: 0.72,
            ankleX: 0.5,
            ankleY: 0.9,
          }),
        ],
      });
    }
    return frames;
  }

  if (scenario === "walking") {
    for (let i = 0; i < 10; i++) {
      const progress = i / 9;
      const cx = 0.36 + progress * 0.28;
      const stride = Math.sin(i * 1.1) * 0.05;
      const bob = Math.abs(Math.sin(i * 1.1)) * 0.015;
      const pose = buildPoseFromJointCoords({
        headX: cx,
        headY: 0.16 + bob,
        shoulderOffsetX: cx,
        shoulderY: 0.28 + bob,
        hipX: cx,
        hipY: 0.52 + bob,
        kneeX: cx + stride * 0.6,
        kneeY: 0.72,
        ankleX: cx,
        ankleY: 0.9,
      });
      // Give left and right ankles distinct stride separation so gait detects cleanly
      pose[27] = { x: cx - 0.075 - stride, y: 0.9, z: 0, visibility: 0.92, presence: 0.92 };
      pose[28] = { x: cx + 0.075 + stride, y: 0.9, z: 0, visibility: 0.92, presence: 0.92 };
      frames.push({
        timestampMs: baseTimestampMs + i * 250,
        label: "Walking normally",
        poses: [pose],
      });
    }
    return frames;
  }

  if (scenario === "sitting") {
    for (let i = 0; i < 10; i++) {
      const t = Math.min(1, i / 5);
      frames.push({
        timestampMs: baseTimestampMs + i * 350,
        label: t < 1 ? "Sitting down slowly" : "Seated calmly",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.5,
            headY: 0.18 + t * 0.12,
            shoulderY: 0.3 + t * 0.12,
            hipX: 0.5,
            hipY: 0.53 + t * 0.13,
            kneeX: 0.53,
            kneeY: 0.72 + t * 0.02,
            ankleX: 0.53,
            ankleY: 0.9,
          }),
        ],
      });
    }
    return frames;
  }

  if (scenario === "bending") {
    for (let i = 0; i < 10; i++) {
      const bendCurve = Math.sin((i / 9) * Math.PI);
      frames.push({
        timestampMs: baseTimestampMs + i * 300,
        label: "Bending down gently",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.5 + bendCurve * 0.1,
            headY: 0.16 + bendCurve * 0.24,
            shoulderOffsetX: 0.5 + bendCurve * 0.09,
            shoulderY: 0.28 + bendCurve * 0.19,
            hipX: 0.48,
            hipY: 0.53,
            kneeX: 0.5,
            kneeY: 0.73,
            ankleX: 0.5,
            ankleY: 0.9,
          }),
        ],
      });
    }
    return frames;
  }

  if (scenario === "intentional_lying") {
    // Gradual transition over ~4.2 seconds so downward velocity remains slow (< 0.25/s)
    for (let i = 0; i < 14; i++) {
      const t = clamp(i / 10, 0, 1);
      frames.push({
        timestampMs: baseTimestampMs + i * 350,
        label: t < 1 ? "Lying down intentionally on bed" : "Resting horizontally",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.5 - t * 0.25,
            headY: 0.2 + t * 0.5,
            shoulderOffsetX: 0.5 - t * 0.2,
            shoulderY: 0.3 + t * 0.41,
            hipX: 0.5,
            hipY: 0.54 + t * 0.19,
            kneeX: 0.5 + t * 0.15,
            kneeY: 0.72 + t * 0.03,
            ankleX: 0.5 + t * 0.28,
            ankleY: 0.88 - t * 0.12,
          }),
        ],
      });
    }
    return frames;
  }

  if (scenario === "sudden_fall") {
    // 3 upright frames, then rapid collapse within 0.45s, then sustained horizontal for 1.8s
    const uprightCount = 3;
    for (let i = 0; i < uprightCount; i++) {
      frames.push({
        timestampMs: baseTimestampMs + i * 250,
        label: "Standing prior to impact",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.5,
            headY: 0.16,
            shoulderOffsetX: 0.5,
            shoulderY: 0.28,
            hipX: 0.5,
            hipY: 0.52,
            kneeX: 0.5,
            kneeY: 0.72,
            ankleX: 0.5,
            ankleY: 0.9,
          }),
        ],
      });
    }
    const fallStartMs = baseTimestampMs + uprightCount * 250;
    // Rapid collapse (0ms -> 450ms)
    const dropSteps = [
      { dt: 150, headX: 0.43, headY: 0.4, sx: 0.45, sy: 0.46, hx: 0.5, hy: 0.62, kx: 0.55, ky: 0.77, ax: 0.62, ay: 0.88 },
      { dt: 300, headX: 0.31, headY: 0.68, sx: 0.35, sy: 0.71, hx: 0.52, hy: 0.76, kx: 0.66, ky: 0.8, ax: 0.78, ay: 0.84 },
      { dt: 450, headX: 0.22, headY: 0.79, sx: 0.28, sy: 0.8, hx: 0.52, hy: 0.81, kx: 0.68, ky: 0.82, ax: 0.82, ay: 0.83 },
    ];
    for (const s of dropSteps) {
      frames.push({
        timestampMs: fallStartMs + s.dt,
        label: "Sudden collapse in progress",
        poses: [
          buildPoseFromJointCoords({
            headX: s.headX,
            headY: s.headY,
            shoulderOffsetX: s.sx,
            shoulderY: s.sy,
            hipX: s.hx,
            hipY: s.hy,
            kneeX: s.kx,
            kneeY: s.ky,
            ankleX: s.ax,
            ankleY: s.ay,
          }),
        ],
      });
    }
    // Sustained horizontal on floor for 1.8s
    for (let k = 1; k <= 6; k++) {
      frames.push({
        timestampMs: fallStartMs + 450 + k * 300,
        label: "Horizontal posture sustained",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.22,
            headY: 0.79,
            shoulderOffsetX: 0.28,
            shoulderY: 0.8,
            hipX: 0.52,
            hipY: 0.81,
            kneeX: 0.68,
            kneeY: 0.82,
            ankleX: 0.82,
            ankleY: 0.83,
          }),
        ],
      });
    }
    return frames;
  }

  if (scenario === "out_of_frame") {
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestampMs: baseTimestampMs + i * 250,
        label: "Subject outside camera frame",
        poses: i < 2 ? [
          buildPoseFromJointCoords({
            headX: 0.98,
            headY: 0.25,
            shoulderOffsetX: 0.98,
            shoulderY: 0.36,
            hipX: 0.99,
            hipY: 0.6,
            kneeX: 0.99,
            kneeY: 0.8,
            ankleX: 0.99,
            ankleY: 0.99,
          }),
        ] : [],
      });
    }
    return frames;
  }

  if (scenario === "low_confidence") {
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestampMs: baseTimestampMs + i * 250,
        label: "Poor lighting / occluded landmarks",
        poses: [
          buildPoseFromJointCoords({
            headX: 0.45,
            headY: 0.55,
            shoulderOffsetX: 0.48,
            shoulderY: 0.6,
            hipX: 0.58,
            hipY: 0.68,
            kneeX: 0.66,
            kneeY: 0.75,
            ankleX: 0.72,
            ankleY: 0.8,
            confidence: 0.22,
          }),
        ],
      });
    }
    return frames;
  }

  // multiple_people
  for (let i = 0; i < 6; i++) {
    frames.push({
      timestampMs: baseTimestampMs + i * 250,
      label: "Two people in camera frame",
      poses: [
        buildPoseFromJointCoords({
          headX: 0.35,
          headY: 0.2,
          shoulderOffsetX: 0.35,
          shoulderY: 0.31,
          hipX: 0.35,
          hipY: 0.54,
          kneeX: 0.35,
          kneeY: 0.73,
          ankleX: 0.35,
          ankleY: 0.9,
        }),
        buildPoseFromJointCoords({
          headX: 0.72,
          headY: 0.24,
          shoulderOffsetX: 0.72,
          shoulderY: 0.35,
          hipX: 0.72,
          hipY: 0.57,
          kneeX: 0.72,
          kneeY: 0.75,
          ankleX: 0.72,
          ankleY: 0.91,
        }),
      ],
    });
  }
  return frames;
}
