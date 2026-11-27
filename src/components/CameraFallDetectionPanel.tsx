import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Eye,
  Lock,
  MapPin,
  Play,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Video,
} from "lucide-react";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import {
  drawPoseSkeletonOverlay,
  getOrCreatePoseLandmarker,
} from "../services/poseLandmarkerService.ts";
import type {
  CameraMonitoringStatus,
  FallDetectionLocation,
  FallDetectionState,
} from "../types/smartcare.ts";
import {
  combineWebcamAndWearableSignals,
  DEFAULT_FALL_DETECTION_SETTINGS,
  generateSimulatedPoseSequence,
  TemporalFallDetector,
  type DemoFallScenario,
  type FallDetectionSettings,
  type FallEvaluationResult,
  type SensorFusionEvaluation,
} from "../utils/fallDetectionEngine.ts";

interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

const DEMO_SCENARIOS: Array<{ id: DemoFallScenario; label: string; badge: string }> = [
  { id: "sudden_fall", label: "Simulate Sudden Fall", badge: "Possible Fall" },
  { id: "standing", label: "Standing Upright", badge: "Normal" },
  { id: "walking", label: "Walking Normally", badge: "Normal" },
  { id: "sitting", label: "Sitting Down", badge: "Normal" },
  { id: "bending", label: "Bending Down", badge: "Normal" },
  { id: "intentional_lying", label: "Intentional Bed Lying", badge: "Normal" },
  { id: "out_of_frame", label: "Out of Frame", badge: "Not Detected" },
  { id: "low_confidence", label: "Poor Lighting / Occluded", badge: "Low Visibility" },
  { id: "multiple_people", label: "Multiple People", badge: "Ambiguous" },
];

export function CameraFallDetectionPanel() {
  const {
    selectedPatient,
    readings,
    liveHardwareSnapshot,
    fallEvents,
    activeEmergencyFallEvent,
    reportWebcamFallDetection,
    cancelFallAlertSafe,
    postCameraStatusTelemetry,
  } = useSmartCare();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const demoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectorRef = useRef<TemporalFallDetector>(new TemporalFallDetector());
  const lastReportTimestampRef = useRef<number>(0);
  const lastStateRef = useRef<FallDetectionState>("Normal");
  const lastTelemetrySentMsRef = useRef<number>(0);

  const [consentChecked, setConsentChecked] = useState(false);
  const [monitoringActive, setMonitoringActive] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [activeDemoLabel, setActiveDemoLabel] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState<CameraMonitoringStatus>("standby");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [devices, setDevices] = useState<CameraDeviceOption[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<FallDetectionSettings>(
    DEFAULT_FALL_DETECTION_SETTINGS
  );

  // Explicit opt-in location state — never requested unless user clicks button
  const [locationOptIn, setLocationOptIn] = useState(false);
  const [locationStatusText, setLocationStatusText] = useState<string>("Location unavailable");
  const [currentLocation, setCurrentLocation] = useState<FallDetectionLocation | null>(null);

  const [latestPoseEval, setLatestPoseEval] = useState<FallEvaluationResult | null>(null);
  const [latestFusion, setLatestFusion] = useState<SensorFusionEvaluation | null>(null);
  const [eventMessage, setEventMessage] = useState<string | null>(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const hadActiveEmergencyRef = useRef(false);

  const latestWearable = liveHardwareSnapshot ?? readings[readings.length - 1] ?? null;
  const latestWearableRef = useRef(latestWearable);
  latestWearableRef.current = latestWearable;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const locationRef = useRef(currentLocation);
  locationRef.current = currentLocation;

  const stopCameraTracks = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (demoTimerRef.current !== null) {
      clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const refreshCameraList = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = all
        .filter((d) => d.kind === "videoinput")
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${idx + 1}`,
        }));
      setDevices(videoInputs);
      if (videoInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(videoInputs[0].deviceId);
      }
    } catch {
      // Enumeration optional if restricted before permission grant
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    void refreshCameraList();
    return () => {
      stopCameraTracks();
    };
  }, [refreshCameraList, stopCameraTracks]);

  // Resume monitoring cleanly without reload when emergency overlay clears
  useEffect(() => {
    if (activeEmergencyFallEvent) {
      hadActiveEmergencyRef.current = true;
      return;
    }
    if (hadActiveEmergencyRef.current) {
      hadActiveEmergencyRef.current = false;
      detectorRef.current.reset();
      lastStateRef.current = "Normal";
      lastReportTimestampRef.current = 0;
      if (monitoringActive) {
        setEventMessage("Alert cleared — live camera monitoring resumed normally.");
      }
    }
  }, [activeEmergencyFallEvent, monitoringActive]);

  const handleStopMonitoring = useCallback(
    (nextStatus: CameraMonitoringStatus = "standby", statusMsg?: string) => {
      stopCameraTracks();
      setMonitoringActive(false);
      setDemoRunning(false);
      setActiveDemoLabel(null);
      setCameraStatus(nextStatus);
      if (statusMsg) setCameraError(statusMsg);
      detectorRef.current.reset();
      void postCameraStatusTelemetry({
        cameraStatus: nextStatus,
        peopleCount: 0,
        poseConfidence: 0,
        errorMessage: statusMsg,
      });
    },
    [postCameraStatusTelemetry, stopCameraTracks]
  );

  const handlePoseEvaluationStep = useCallback(
    async (
      poseEval: FallEvaluationResult,
      mode: "webcam_pose" | "demo_simulation"
    ) => {
      const fusion = combineWebcamAndWearableSignals(poseEval, latestWearableRef.current);
      setLatestPoseEval(poseEval);
      setLatestFusion(fusion);
      setLastAnalyzedAt(new Date().toISOString());

      const nowMs = Date.now();
      const derivedCamStatus: CameraMonitoringStatus =
        poseEval.activity === "low_confidence"
          ? "low_confidence"
          : poseEval.activity === "out_of_frame"
          ? "out_of_frame"
          : "active";

      if (mode === "webcam_pose") {
        setCameraStatus(derivedCamStatus);
      }

      if (nowMs - lastTelemetrySentMsRef.current > 4000) {
        lastTelemetrySentMsRef.current = nowMs;
        void postCameraStatusTelemetry({
          cameraStatus: mode === "demo_simulation" ? "active" : derivedCamStatus,
          deviceLabel: mode === "demo_simulation" ? "Demonstration Mode" : "Webcam",
          peopleCount: poseEval.peopleCount,
          poseConfidence: poseEval.confidence,
          sensorDisagreement: fusion.sensorDisagreement,
        });
      }

      // Report Possible Fall or sustained Warning (with cooldown so frames don't spam server)
      const stateChangedToAlert =
        (fusion.finalState === "Possible Fall" && lastStateRef.current !== "Possible Fall") ||
        (fusion.finalState === "Warning" && lastStateRef.current === "Normal");
      const cooldownElapsed = nowMs - lastReportTimestampRef.current > 6000;

      if (
        (fusion.finalState === "Possible Fall" ||
          (fusion.finalState === "Warning" && fusion.sensorDisagreement)) &&
        (stateChangedToAlert || cooldownElapsed)
      ) {
        lastReportTimestampRef.current = nowMs;
        lastStateRef.current = fusion.finalState;
        try {
          const res = await reportWebcamFallDetection({
            detectionMode: mode,
            state: fusion.finalState,
            reason: fusion.explanation,
            confidence: poseEval.confidence,
            torsoAngleDeg: poseEval.torsoAngleDeg,
            verticalVelocity: poseEval.verticalVelocity,
            horizontalDurationSec: poseEval.horizontalDurationSec,
            peopleCount: poseEval.peopleCount,
            sensorFusionStatus: fusion.sensorFusionStatus,
            wearableSummary: fusion.wearableSummary,
            location: locationRef.current,
            confirmationCountdownSec: settingsRef.current.confirmationCountdownSec,
          });
          if (res.eventCreated) {
            setEventMessage(
              fusion.finalState === "Possible Fall"
                ? "Possible Fall triggered emergency confirmation countdown."
                : "Posture/sensor warning logged for caregiver awareness."
            );
          } else if (res.duplicateSuppressed) {
            setEventMessage("Duplicate alert suppressed cleanly for active incident.");
          }
        } catch (err) {
          setEventMessage(err instanceof Error ? err.message : "Could not record fall event.");
        }
      } else if (fusion.finalState === "Normal") {
        lastStateRef.current = "Normal";
      }
    },
    [postCameraStatusTelemetry, reportWebcamFallDetection]
  );

  const handleRequestOptionalLocation = () => {
    if (!navigator.geolocation) {
      setLocationOptIn(false);
      setCurrentLocation(null);
      setLocationStatusText("Location unavailable (browser does not support geolocation)");
      return;
    }
    setLocationStatusText("Requesting browser location permission...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationOptIn(true);
        const loc: FallDetectionLocation = {
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          accuracyMeters: Number.isFinite(pos.coords.accuracy)
            ? Math.round(pos.coords.accuracy)
            : undefined,
          capturedAt: new Date().toISOString(),
        };
        setCurrentLocation(loc);
        setLocationStatusText(
          `Authorized: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`
        );
      },
      () => {
        setLocationOptIn(false);
        setCurrentLocation(null);
        setLocationStatusText("Location unavailable (permission denied or timed out)");
      },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 60_000 }
    );
  };

  const handleStartMonitoring = async () => {
    if (!consentChecked) {
      setCameraError("Please confirm explicit consent before activating webcam monitoring.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStatus("unavailable");
      setCameraError(
        "Webcam API (navigator.mediaDevices.getUserMedia) is unavailable in this browser context. You can test all scenarios using Demonstration Mode below."
      );
      void postCameraStatusTelemetry({
        cameraStatus: "unavailable",
        peopleCount: 0,
        poseConfidence: 0,
        errorMessage: "MediaDevices API unavailable",
      });
      return;
    }

    stopCameraTracks();
    setDemoRunning(false);
    setActiveDemoLabel(null);
    setCameraError(null);
    setEventMessage(null);
    detectorRef.current.reset();
    lastStateRef.current = "Normal";

    let stream: MediaStream | null = null;
    try {
      const videoConstraints: MediaTrackConstraints = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch (constraintErr) {
        const errName = (constraintErr as { name?: string })?.name ?? "";
        if (errName === "OverconstrainedError" || errName === "NotFoundError") {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } else {
          throw constraintErr;
        }
      }
    } catch (err) {
      const name = (err as { name?: string })?.name ?? "";
      const isDenied =
        name === "NotAllowedError" ||
        name === "PermissionDeniedError" ||
        name === "SecurityError";
      const nextStatus: CameraMonitoringStatus = isDenied ? "denied" : "unavailable";
      const msg = isDenied
        ? "Camera permission denied by user or browser policy. Click the browser address bar camera icon to allow webcam access."
        : "No available camera detected or camera is busy in another application.";
      setCameraStatus(nextStatus);
      setCameraError(msg);
      void postCameraStatusTelemetry({
        cameraStatus: nextStatus,
        peopleCount: 0,
        poseConfidence: 0,
        errorMessage: msg,
      });
      return;
    }

    streamRef.current = stream;
    void refreshCameraList();

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        handleStopMonitoring(
          "disconnected",
          "Camera disconnected — webcam stream ended during monitoring. Reconnect your camera and click START MONITORING."
        );
      };
    }

    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.srcObject = stream;
      await videoEl.play().catch(() => {});
    }

    setMonitoringActive(true);
    setCameraStatus("active");
    setModelLoading(true);
    setModelReady(false);

    let landmarker;
    try {
      landmarker = await getOrCreatePoseLandmarker();
      setModelLoading(false);
      setModelReady(true);
    } catch {
      setModelLoading(false);
      setModelReady(false);
      handleStopMonitoring(
        "unavailable",
        "Could not load MediaPipe Pose Landmarker model in this environment. Use Demonstration Mode below to evaluate fall detection without downloading the pose model."
      );
      return;
    }

    void postCameraStatusTelemetry({
      cameraStatus: "active",
      deviceLabel: videoTrack?.label || "Webcam",
      peopleCount: 0,
      poseConfidence: 0,
    });

    let lastVideoTime = -1;
    let lastFrameProcessMs = 0;

    const processLoop = (nowPerf: number) => {
      if (!streamRef.current || !videoRef.current) return;
      const vid = videoRef.current;
      const canvas = canvasRef.current;

      if (vid.readyState >= 2 && vid.videoWidth > 0 && vid.videoHeight > 0 && canvas) {
        if (canvas.width !== vid.videoWidth || canvas.height !== vid.videoHeight) {
          canvas.width = vid.videoWidth;
          canvas.height = vid.videoHeight;
        }
        // Throttle pose inference to ~12 FPS to keep CPU responsive
        if (vid.currentTime !== lastVideoTime && nowPerf - lastFrameProcessMs >= 80) {
          lastVideoTime = vid.currentTime;
          lastFrameProcessMs = nowPerf;
          try {
            const result = landmarker.detectForVideo(vid, nowPerf);
            const poses = result.landmarks ?? [];
            const poseEval = detectorRef.current.evaluateFrame(
              poses,
              Date.now(),
              settingsRef.current
            );
            const fusion = combineWebcamAndWearableSignals(poseEval, latestWearableRef.current);
            const ctx = canvas.getContext("2d");
            if (ctx) {
              drawPoseSkeletonOverlay(ctx, canvas.width, canvas.height, poses, fusion.finalState, {
                mirror: false,
              });
            }
            void handlePoseEvaluationStep(poseEval, "webcam_pose");
          } catch {
            // Skip single transient inference frame cleanly
          }
        }
      }
      rafRef.current = requestAnimationFrame(processLoop);
    };

    rafRef.current = requestAnimationFrame(processLoop);
  };

  const handleRunDemoScenario = (scenario: DemoFallScenario, label: string) => {
    stopCameraTracks();
    setMonitoringActive(false);
    setCameraError(null);
    setEventMessage(null);
    detectorRef.current.reset();
    lastStateRef.current = "Normal";
    lastReportTimestampRef.current = 0;

    setDemoRunning(true);
    setActiveDemoLabel(label);
    setCameraStatus("active");

    const frames = generateSimulatedPoseSequence(scenario, Date.now());
    let idx = 0;

    const renderFrame = () => {
      const frame = frames[idx];
      if (!frame) {
        if (demoTimerRef.current) {
          clearInterval(demoTimerRef.current);
          demoTimerRef.current = null;
        }
        setDemoRunning(false);
        return;
      }

      const poseEval = detectorRef.current.evaluateFrame(
        frame.poses,
        frame.timestampMs,
        settingsRef.current
      );
      const fusion = combineWebcamAndWearableSignals(poseEval, latestWearableRef.current);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          drawPoseSkeletonOverlay(ctx, canvas.width, canvas.height, frame.poses, fusion.finalState, {
            demoBannerText: `SIMULATED DEMO · ${frame.label}`,
          });
        }
      }
      void handlePoseEvaluationStep(poseEval, "demo_simulation");
      idx += 1;
    };

    renderFrame();
    demoTimerRef.current = setInterval(renderFrame, 280);
  };

  const patientFallEvents = fallEvents.filter(
    (e) => e.patientId === selectedPatient.patientId
  );

  const displayState: FallDetectionState = latestFusion?.finalState ?? latestPoseEval?.state ?? "Normal";

  return (
    <section
      aria-label="Camera-Based Fall Detection"
      className="arova-glass-card rounded-3xl bg-white border border-[#D9E0E0] shadow-sm overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-5 py-4 sm:px-6 border-b border-[#D9E0E0] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-[#F7F9F9]">
        <div className="flex items-start sm:items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#00B800]/12 border border-[#00B800]/30 text-[#008F00] flex items-center justify-center shrink-0">
            <Video className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-[#202525]">
                Camera-Based Fall Detection
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[11px] font-semibold rounded-md border ${
                  monitoringActive
                    ? "bg-[#00B800]/12 border-[#00B800]/40 text-[#008F00]"
                    : demoRunning
                    ? "bg-amber-50 border-amber-300 text-amber-800"
                    : cameraStatus === "denied" ||
                      cameraStatus === "unavailable" ||
                      cameraStatus === "disconnected"
                    ? "bg-red-50 border-red-300 text-red-800"
                    : "bg-white border-[#D9E0E0] text-[#737B7B]"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    monitoringActive
                      ? "bg-[#00B800] animate-ping"
                      : demoRunning
                      ? "bg-amber-500 animate-pulse"
                      : cameraStatus === "denied" ||
                        cameraStatus === "unavailable" ||
                        cameraStatus === "disconnected"
                      ? "bg-red-500"
                      : "bg-[#737B7B]"
                  }`}
                />
                {monitoringActive
                  ? "ACTIVE · LIVE WEBCAM"
                  : demoRunning
                  ? `SIMULATED DEMO (${activeDemoLabel ?? "Running"})`
                  : cameraStatus === "denied"
                  ? "Permission Denied"
                  : cameraStatus === "unavailable"
                  ? "Camera Unavailable"
                  : cameraStatus === "disconnected"
                  ? "Camera disconnected"
                  : "STANDBY"}
              </span>
            </div>
            <p className="text-xs text-[#737B7B] mt-0.5">
              On-device MediaPipe pose landmark tracking &amp; temporal fall intelligence paired with wearable IMU fusion
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#202525] bg-white border border-[#D9E0E0] hover:border-[#00B800] hover:text-[#008F00] rounded-xl cursor-pointer transition-colors"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-[#00B800]" />
            <span>Thresholds</span>
          </button>
          {!monitoringActive ? (
            <button
              type="button"
              disabled={!consentChecked}
              onClick={() => void handleStartMonitoring()}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold tracking-wide text-white bg-[#00B800] hover:bg-[#009900] disabled:opacity-50 rounded-xl shadow-xs cursor-pointer transition-colors"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>START MONITORING</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleStopMonitoring("standby")}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold tracking-wide text-white bg-red-600 hover:bg-red-700 rounded-xl shadow-xs cursor-pointer transition-colors"
            >
              <Square className="w-3.5 h-3.5" />
              <span>STOP MONITORING</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Content Split */}
      <div className="p-5 sm:p-6 space-y-5">
        {/* Privacy Consent + Camera Device Selector + Optional Location Opt-in */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 p-3.5 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-2.5 text-xs">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => {
                  setConsentChecked(e.target.checked);
                  if (!e.target.checked && monitoringActive) {
                    handleStopMonitoring("standby");
                  }
                }}
                className="mt-0.5 accent-[#00B800] cursor-pointer"
              />
              <span className="text-[#202525] leading-relaxed">
                <strong className="font-semibold">Explicit Camera Consent:</strong> I consent to
                local pose estimation inside my browser.{" "}
                <span className="text-[#737B7B]">
                  Raw webcam frames are never recorded, saved, or uploaded.
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <div className="flex items-center gap-1.5 text-[11px] text-[#737B7B]">
                <Lock className="w-3.5 h-3.5 text-[#00B800]" />
                <span>Local Pose Processing Only</span>
              </div>
              <span className="text-[#D9E0E0]">|</span>
              <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                <select
                  aria-label="Select available camera"
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  disabled={monitoringActive}
                  className="flex-1 px-2.5 py-1.5 text-xs bg-white border border-[#D9E0E0] rounded-lg text-[#202525] disabled:bg-[#EEF2F2] focus:outline-none focus:border-[#00B800]"
                >
                  {devices.length === 0 ? (
                    <option value="">Default Camera (Permission required for labels)</option>
                  ) : (
                    devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => void refreshCameraList()}
                  title="Refresh camera list"
                  className="p-1.5 bg-white border border-[#D9E0E0] rounded-lg text-[#737B7B] hover:border-[#00B800] hover:text-[#008F00] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Optional Geolocation Opt-In Card */}
          <div className="p-3.5 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] flex flex-col justify-between gap-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[#202525] flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-[#00B800]" />
                Optional Location Sharing
              </span>
              <span
                className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                  locationOptIn && currentLocation
                    ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                    : "bg-white border-[#D9E0E0] text-[#737B7B]"
                }`}
              >
                {locationOptIn && currentLocation ? "Enabled" : "Off"}
              </span>
            </div>
            <p className="text-[11px] text-[#737B7B] leading-snug">{locationStatusText}</p>
            <button
              type="button"
              onClick={handleRequestOptionalLocation}
              className="w-full py-1.5 px-2.5 text-[11px] font-semibold text-[#202525] bg-white border border-[#D9E0E0] hover:border-[#00B800] hover:text-[#008F00] rounded-lg cursor-pointer transition-colors"
            >
              {currentLocation ? "Refresh Location Permission" : "Enable Optional Location Tagging"}
            </button>
          </div>
        </div>

        {/* Configurable Sensitivity Controls */}
        {showSettings && (
          <div className="p-4 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[#202525]">
                Configurable Fall Detection Thresholds
              </span>
              <button
                type="button"
                onClick={() => setSettings(DEFAULT_FALL_DETECTION_SETTINGS)}
                className="text-[11px] font-medium text-[#008F00] hover:underline cursor-pointer"
              >
                Reset Defaults
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Min Confidence</span>
                <input
                  type="number"
                  step="0.05"
                  min={0.2}
                  max={0.9}
                  value={settings.confidenceThreshold}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, confidenceThreshold: Number(e.target.value) }))
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Drop Velocity (/s)</span>
                <input
                  type="number"
                  step="0.05"
                  min={0.2}
                  max={1.5}
                  value={settings.downwardVelocityThreshold}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      downwardVelocityThreshold: Number(e.target.value),
                    }))
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Horizontal Angle (°)</span>
                <input
                  type="number"
                  step="2"
                  min={40}
                  max={82}
                  value={settings.horizontalAngleDeg}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, horizontalAngleDeg: Number(e.target.value) }))
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Lying Hold (sec)</span>
                <input
                  type="number"
                  step="0.2"
                  min={0.4}
                  max={10}
                  value={settings.lyingHoldDurationSec}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, lyingHoldDurationSec: Number(e.target.value) }))
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[#737B7B] block">Escalation Wait (s)</span>
                <input
                  type="number"
                  step="1"
                  min={5}
                  max={120}
                  value={settings.confirmationCountdownSec}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      confirmationCountdownSec: Number(e.target.value),
                    }))
                  }
                  className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono text-[#202525]"
                />
              </label>
            </div>
          </div>
        )}

        {cameraError && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-300 text-xs text-red-900 space-y-2">
            <div className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{cameraError}</span>
            </div>
            {cameraStatus === "denied" && (
              <ol className="list-decimal list-inside space-y-1 text-[11px] text-red-800 pl-6">
                <li>Click the lock or camera icon in your browser&apos;s address bar.</li>
                <li>Change Camera permission for this site to <strong>Allow</strong>.</li>
                <li>Ensure the Explicit Camera Consent box is checked and click <strong>START MONITORING</strong> again.</li>
              </ol>
            )}
          </div>
        )}

        {eventMessage && (
          <div className="p-3 rounded-xl bg-[#00B800]/10 border border-[#00B800]/30 text-xs text-[#008F00] font-medium flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{eventMessage}</span>
          </div>
        )}

        {/* Monitoring Readout Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
          <div className="p-2.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#737B7B]">
              Monitoring Status
            </div>
            <div
              className={`font-bold ${
                monitoringActive
                  ? "text-[#008F00]"
                  : demoRunning
                  ? "text-amber-700"
                  : cameraStatus === "disconnected" || cameraStatus === "denied"
                  ? "text-red-700"
                  : "text-[#202525]"
              }`}
            >
              {monitoringActive
                ? "ACTIVE (Live)"
                : demoRunning
                ? "SIMULATED DEMO"
                : cameraStatus === "disconnected"
                ? "Camera disconnected"
                : "STANDBY"}
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#737B7B]">
              Person Detection
            </div>
            <div
              className={`font-semibold ${
                !latestPoseEval
                  ? "text-[#737B7B]"
                  : latestPoseEval.activity === "out_of_frame"
                  ? "text-amber-700"
                  : latestPoseEval.peopleCount > 1
                  ? "text-amber-700"
                  : "text-[#008F00]"
              }`}
            >
              {!latestPoseEval
                ? "Awaiting frame"
                : latestPoseEval.activity === "out_of_frame"
                ? "Not detected"
                : latestPoseEval.peopleCount > 1
                ? `${latestPoseEval.peopleCount} People (Ambiguous)`
                : "Person Visible"}
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#737B7B]">
              Pose Estimation
            </div>
            <div
              className={`font-semibold ${
                latestPoseEval?.activity === "low_confidence"
                  ? "text-amber-700"
                  : monitoringActive && modelReady
                  ? "text-[#008F00]"
                  : "text-[#202525]"
              }`}
            >
              {modelLoading
                ? "Initializing..."
                : latestPoseEval?.activity === "low_confidence"
                ? "Low Visibility"
                : monitoringActive && modelReady
                ? "MediaPipe Active"
                : demoRunning
                ? "Simulated Sequence"
                : "Model Standby"}
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#737B7B]">
              Detection State
            </div>
            <div
              className={`font-bold ${
                displayState === "Possible Fall"
                  ? "text-red-700"
                  : displayState === "Warning"
                  ? "text-amber-700"
                  : "text-[#008F00]"
              }`}
            >
              {displayState === "Possible Fall"
                ? "⚠ POSSIBLE FALL"
                : displayState === "Warning"
                ? "Unusual Movement"
                : "Monitoring Normally"}
            </div>
          </div>

          <div className="p-2.5 rounded-xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#737B7B]">
              Last Analyzed
            </div>
            <div className="font-mono font-semibold text-[#202525]">
              {lastAnalyzedAt
                ? new Date(lastAnalyzedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "--"}
            </div>
          </div>
        </div>

        {/* Live Video + Skeleton Canvas Grid & Real-Time Posture Diagnostics */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left: Webcam Feed / Pose Canvas */}
          <div className="lg:col-span-7 space-y-3">
            <div className="relative rounded-2xl overflow-hidden bg-[#080B0B] border border-[#242D2D] aspect-video flex items-center justify-center">
              <video
                ref={videoRef}
                playsInline
                muted
                className={`w-full h-full object-cover ${
                  monitoringActive ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              />

              {!monitoringActive && !demoRunning && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-[#141A1A] border border-[#283232] flex items-center justify-center text-[#00B800]">
                    <CameraOff className="w-6 h-6" />
                  </div>
                  <div className="space-y-1 max-w-sm">
                    <p className="text-sm font-semibold text-white">
                      Webcam Monitoring Is Off
                    </p>
                    <p className="text-xs text-[#A3ACAC] leading-relaxed">
                      Confirm consent and press <strong className="text-white">Start Monitoring</strong> for real-time local skeletal tracking, or test safely using Demonstration Mode below.
                    </p>
                  </div>
                </div>
              )}

              {modelLoading && (
                <div className="absolute inset-0 bg-[#080B0B]/75 flex items-center justify-center text-xs font-medium text-white">
                  Loading MediaPipe Pose Landmarker...
                </div>
              )}
            </div>

            {/* Demonstration Mode Controls */}
            <div className="p-4 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#202525]">
                  <Play className="w-3.5 h-3.5 text-[#00B800]" />
                  <span>Demonstration Mode (Simulated Pose Sequences)</span>
                </div>
                <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-amber-50 text-amber-800 border border-amber-300">
                  SIMULATED DEMO · NO WEBCAM NEEDED
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DEMO_SCENARIOS.map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => handleRunDemoScenario(sc.id, sc.label)}
                    className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors cursor-pointer ${
                      sc.id === "sudden_fall"
                        ? "bg-red-50 border-red-300 text-red-800 hover:bg-red-100"
                        : "bg-white border-[#D9E0E0] text-[#202525] hover:border-[#00B800] hover:text-[#008F00]"
                    }`}
                  >
                    {sc.label}
                  </button>
                ))}
                {demoRunning && (
                  <button
                    type="button"
                    onClick={() => handleStopMonitoring("standby")}
                    className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-[#202525] text-white cursor-pointer"
                  >
                    Stop Demo
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Right: Live Pose State, Temporal Metrics & Sensor Fusion */}
          <div className="lg:col-span-5 space-y-4">
            <div
              className={`p-4 rounded-2xl border space-y-3 ${
                displayState === "Possible Fall"
                  ? "bg-red-50 border-red-300"
                  : displayState === "Warning"
                  ? "bg-amber-50 border-amber-300"
                  : "bg-[#F7F9F9] border-[#D9E0E0]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#737B7B] flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5 text-[#00B800]" />
                  Current Fall Detection State
                </span>
                <span
                  className={`px-2.5 py-0.5 text-xs font-bold rounded-lg border ${
                    displayState === "Possible Fall"
                      ? "bg-red-600 text-white border-red-700"
                      : displayState === "Warning"
                      ? "bg-amber-500 text-white border-amber-600"
                      : "bg-[#00B800] text-white border-[#008F00]"
                  }`}
                >
                  {displayState === "Possible Fall"
                    ? "⚠ POSSIBLE FALL DETECTED"
                    : displayState === "Warning"
                    ? "Unusual Movement Detected"
                    : "Monitoring Normally"}
                </span>
              </div>

              <p className="text-xs text-[#202525] leading-relaxed">
                {latestFusion?.explanation ??
                  latestPoseEval?.reason ??
                  "Standby — no camera frame evaluated yet."}
              </p>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-white border border-[#D9E0E0]">
                  <div className="text-[11px] text-[#737B7B]">Torso Angle</div>
                  <div className="font-mono font-semibold text-[#202525]">
                    {latestPoseEval ? `${latestPoseEval.torsoAngleDeg.toFixed(1)}°` : "--"}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-[#D9E0E0]">
                  <div className="text-[11px] text-[#737B7B]">Drop Velocity</div>
                  <div className="font-mono font-semibold text-[#202525]">
                    {latestPoseEval ? `${latestPoseEval.verticalVelocity.toFixed(2)}/s` : "--"}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-[#D9E0E0]">
                  <div className="text-[11px] text-[#737B7B]">Horizontal Hold</div>
                  <div className="font-mono font-semibold text-[#202525]">
                    {latestPoseEval ? `${latestPoseEval.horizontalDurationSec.toFixed(1)}s` : "--"}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-[#D9E0E0]">
                  <div className="text-[11px] text-[#737B7B]">Confidence · People</div>
                  <div className="font-mono font-semibold text-[#202525]">
                    {latestPoseEval
                      ? `${Math.round(latestPoseEval.confidence * 100)}% · ${latestPoseEval.peopleCount}`
                      : "--"}
                  </div>
                </div>
              </div>

              {latestPoseEval && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                  <span className="px-2 py-0.5 rounded bg-white border border-[#D9E0E0] text-[#202525]">
                    activity: {latestPoseEval.activity}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-white border border-[#D9E0E0] text-[#737B7B]">
                    frame: {latestPoseEval.framePositionStatus}
                  </span>
                </div>
              )}
            </div>

            {/* Wearable Sensor Fusion Status */}
            <div className="p-4 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-[#202525] flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-[#00B800]" />
                  Wearable Sensor Fusion
                </span>
                <span
                  className={`px-2 py-0.5 text-[10px] font-mono rounded border ${
                    latestFusion?.sensorFusionStatus === "corroborated"
                      ? "bg-[#00B800]/12 border-[#00B800]/30 text-[#008F00]"
                      : latestFusion?.sensorFusionStatus === "sensor_disagreement"
                      ? "bg-amber-50 border-amber-300 text-amber-800"
                      : "bg-white border-[#D9E0E0] text-[#737B7B]"
                  }`}
                >
                  {latestFusion?.sensorFusionStatus ??
                    (latestWearable ? "standby" : "webcam_only")}
                </span>
              </div>
              <p className="text-[11px] text-[#737B7B] leading-relaxed">
                {latestFusion?.wearableSummary ??
                  (latestWearable
                    ? `Wearable ready (${latestWearable.source}) — IMU ${
                        latestWearable.accelMagnitude?.toFixed(2) ?? "1.00"
                      }g, HR ${latestWearable.heartRate ?? "--"} BPM`
                    : "Wearable hardware/simulator offline — webcam fall detection operates standalone.")}
              </p>
            </div>

            {/* Recent Camera Fall Events */}
            <div className="p-4 rounded-2xl bg-[#F7F9F9] border border-[#D9E0E0] space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#202525] flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-[#00B800]" />
                  Recent Camera Fall Events
                </span>
                <span className="font-mono text-[11px] text-[#737B7B]">
                  {patientFallEvents.length} logged
                </span>
              </div>
              {patientFallEvents.length === 0 ? (
                <p className="text-[11px] text-[#737B7B]">
                  No camera fall events recorded for this patient yet.
                </p>
              ) : (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {patientFallEvents.slice(0, 4).map((evt) => (
                    <div
                      key={evt.eventId}
                      className="p-2.5 rounded-xl bg-white border border-[#D9E0E0] space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-semibold ${
                            evt.state === "Possible Fall" ? "text-red-700" : "text-amber-700"
                          }`}
                        >
                          {evt.state} ({evt.status.replace("_", " ")})
                        </span>
                        <span className="font-mono text-[10px] text-[#737B7B]">
                          {new Date(evt.detectedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#737B7B] truncate">{evt.reason}</div>
                      {(evt.status === "pending_confirmation" || evt.status === "escalated") && (
                        <button
                          type="button"
                          onClick={() => void cancelFallAlertSafe(evt.eventId)}
                          className="mt-1 px-2 py-0.5 text-[10px] font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded cursor-pointer"
                        >
                          I&apos;m Safe – Cancel
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
