import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { FallDetectionState } from "../types/smartcare.ts";
import type { PoseLandmarkPoint } from "../utils/fallDetectionEngine.ts";

// Official lightweight MediaPipe Pose Landmarker float16 task asset
const POSE_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// Skeletal bone pairs covering head, shoulders, arms, torso, hips, knees, ankles
const POSE_CONNECTIONS: Array<[number, number]> = [
  [0, 11],
  [0, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];

const KEY_JOINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

let sharedLandmarkerPromise: Promise<PoseLandmarker> | null = null;

export async function getOrCreatePoseLandmarker(): Promise<PoseLandmarker> {
  if (!sharedLandmarkerPromise) {
    sharedLandmarkerPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: POSE_LANDMARKER_MODEL_URL,
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numPoses: 2,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    })().catch((err) => {
      sharedLandmarkerPromise = null;
      throw err;
    });
  }
  return sharedLandmarkerPromise;
}

export function drawPoseSkeletonOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  poses: PoseLandmarkPoint[][],
  state: FallDetectionState,
  options?: {
    mirror?: boolean;
    demoBannerText?: string | null;
  }
): void {
  ctx.clearRect(0, 0, width, height);

  const mirror = Boolean(options?.mirror);
  const lineColor =
    state === "Possible Fall"
      ? "#EF4444"
      : state === "Warning"
      ? "#F59E0B"
      : "#00D800";
  const secondaryBoneColor =
    state === "Possible Fall" ? "#38BDF8" : "#00B800";

  for (let pIdx = 0; pIdx < poses.length; pIdx++) {
    const lms = poses[pIdx];
    const isPrimary = pIdx === 0;
    ctx.lineWidth = isPrimary ? 2.5 : 1.8;
    ctx.strokeStyle = isPrimary
      ? state === "Possible Fall"
        ? secondaryBoneColor
        : lineColor
      : "rgba(148, 163, 184, 0.75)";

    for (const [startIdx, endIdx] of POSE_CONNECTIONS) {
      const a = lms[startIdx];
      const b = lms[endIdx];
      if (!a || !b) continue;
      if ((a.visibility ?? 1) < 0.15 || (b.visibility ?? 1) < 0.15) continue;

      const ax = (mirror ? 1 - a.x : a.x) * width;
      const ay = a.y * height;
      const bx = (mirror ? 1 - b.x : b.x) * width;
      const by = b.y * height;

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    for (const jointIdx of KEY_JOINTS) {
      const pt = lms[jointIdx];
      if (!pt || (pt.visibility ?? 1) < 0.15) continue;
      const px = (mirror ? 1 - pt.x : pt.x) * width;
      const py = pt.y * height;

      ctx.beginPath();
      ctx.arc(px, py, isPrimary ? 4.2 : 3, 0, Math.PI * 2);
      ctx.fillStyle =
        state === "Possible Fall"
          ? "#EF4444"
          : state === "Warning"
          ? "#F59E0B"
          : "#00B800";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#FFFFFF";
      ctx.stroke();
    }
  }

  // Prominent visual alert overlay inspired by the reference image
  if (state === "Possible Fall") {
    ctx.save();
    ctx.font = "700 28px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(8, 11, 11, 0.55)";
    ctx.fillText("FALL ALERT", 18, 42);
    ctx.fillStyle = "#EF4444";
    ctx.fillText("FALL ALERT", 16, 40);
    ctx.restore();
  } else if (state === "Warning") {
    ctx.save();
    ctx.font = "700 18px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
    ctx.fillText("POSTURE WARNING", 16, 32);
    ctx.restore();
  }

  if (options?.demoBannerText) {
    ctx.save();
    const label = options.demoBannerText;
    ctx.font = "600 11px monospace";
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8, 11, 11, 0.72)";
    ctx.fillRect(14, height - 30, textW + 16, 20);
    ctx.fillStyle = "#4CE64C";
    ctx.fillText(label, 22, height - 16);
    ctx.restore();
  }
}
