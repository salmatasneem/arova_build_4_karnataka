import { useMemo, useState } from "react";
import { Play, Power, Search, SlidersHorizontal, Sparkles, Square, Wifi } from "lucide-react";
import { AnimatedNumber } from "../components/AnimatedNumber.tsx";
import { EcgWaveformPanel } from "../components/EcgWaveformPanel.tsx";
import { MlIntelligencePanel } from "../components/MlIntelligencePanel.tsx";
import { AlertLevelLabel } from "../components/StatusIndicator.tsx";
import { TelemetryCharts } from "../components/TelemetryCharts.tsx";
import { useSmartCare } from "../context/SmartCareContext.tsx";
import type { AlertLevel, MovementStatus, SimSensorErrorMode } from "../types/smartcare.ts";

function buildSimulatedEcgBatch(
  hrBpm: number | null,
  leadOff: boolean,
  samplingRate = 200,
  sampleCount = 100
): number[] {
  if (leadOff) {
    return Array.from({ length: sampleCount }, (_, i) =>
      Number((2048 + Math.sin(i * 0.4) * 3).toFixed(1))
    );
  }
  const effectiveHr = hrBpm && hrBpm > 35 ? hrBpm : 72;
  const beatPeriodSec = 60 / effectiveHr;
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = i / samplingRate;
    const phase = (t % beatPeriodSec) / beatPeriodSec;
    let mv = 0.02 * Math.sin(2 * Math.PI * 0.35 * t);
    if (phase > 0.12 && phase < 0.2) {
      mv += 0.14 * Math.sin(((phase - 0.12) / 0.08) * Math.PI);
    } else if (phase >= 0.26 && phase < 0.29) {
      mv -= 0.16;
    } else if (phase >= 0.29 && phase < 0.33) {
      mv += 1.05 * Math.sin(((phase - 0.29) / 0.04) * Math.PI);
    } else if (phase >= 0.33 && phase < 0.37) {
      mv -= 0.24;
    } else if (phase >= 0.48 && phase < 0.62) {
      mv += 0.26 * Math.sin(((phase - 0.48) / 0.14) * Math.PI);
    }
    samples.push(Number(mv.toFixed(3)));
  }
  return samples;
}

export function TrendsAndBaselinePage() {
  const {
    selectedPatient,
    readings,
    ecgSegments,
    baselineStatusSummary,
    baselines,
    anomalyEvents,
    integrations,
    isAdminUser,
    liveHardwareSnapshot,
    injectSimulatorReading,
    fitBaselineForSelectedPatient,
    systemSettings,
    simRunning,
    simMode,
    simDeviceConnected,
    simSensorError,
    simLastPacketSummary,
    startSimulation,
    stopSimulation,
    setSimSensorError,
    generateNormalReading,
    generateUnusualReading,
    disconnectSimulatedDevice,
    reconnectSimulatedDevice,
  } = useSmartCare();

  const [filterLevel, setFilterLevel] = useState<"All" | AlertLevel>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [baselineFeedback, setBaselineFeedback] = useState<string | null>(null);
  const [fittingBaseline, setFittingBaseline] = useState(false);

  // Simulator controls (explicitly labeled as test simulator)
  const [simHr, setSimHr] = useState<number | null>(76);
  const [simSpo2, setSimSpo2] = useState<number | null>(97.8);
  const [simTemp, setSimTemp] = useState<number | null>(36.7);
  const [simAccel, setSimAccel] = useState(1.02);
  const [simMovement, setSimMovement] = useState<MovementStatus>("resting");
  const [simFingerOk, setSimFingerOk] = useState(true);
  const [simIncludeEcg, setSimIncludeEcg] = useState(true);
  const [simEcgLeadOff, setSimEcgLeadOff] = useState(false);
  const [simSubmitting, setSimSubmitting] = useState(false);
  const [simResultMessage, setSimResultMessage] = useState<string | null>(null);

  const filteredReadings = useMemo(() => {
    return [...readings]
      .reverse()
      .filter((r) => {
        if (filterLevel !== "All" && r.alertLevel !== filterLevel) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            r.explanation.toLowerCase().includes(q) ||
            r.movementStatus.toLowerCase().includes(q) ||
            r.source.toLowerCase().includes(q)
          );
        }
        return true;
      });
  }, [readings, filterLevel, searchQuery]);

  const applyPreset = (
    preset: "normal" | "warning_hr" | "critical_hypoxia" | "poor_contact"
  ) => {
    if (preset === "normal") {
      setSimHr(74);
      setSimSpo2(98.0);
      setSimTemp(36.6);
      setSimAccel(1.01);
      setSimMovement("resting");
      setSimFingerOk(true);
      setSimIncludeEcg(true);
      setSimEcgLeadOff(false);
    } else if (preset === "warning_hr") {
      setSimHr(112);
      setSimSpo2(94.2);
      setSimTemp(37.9);
      setSimAccel(1.05);
      setSimMovement("resting");
      setSimFingerOk(true);
      setSimIncludeEcg(true);
      setSimEcgLeadOff(false);
    } else if (preset === "critical_hypoxia") {
      setSimHr(136);
      setSimSpo2(87.5);
      setSimTemp(38.5);
      setSimAccel(3.2);
      setSimMovement("fall_suspect");
      setSimFingerOk(true);
      setSimIncludeEcg(true);
      setSimEcgLeadOff(false);
    } else {
      setSimHr(null);
      setSimSpo2(null);
      setSimTemp(null);
      setSimAccel(0.98);
      setSimMovement("resting");
      setSimFingerOk(false);
      setSimIncludeEcg(true);
      setSimEcgLeadOff(true);
    }
  };

  const handleSendSim = async () => {
    setSimSubmitting(true);
    setSimResultMessage(null);
    try {
      const ecgSamplingRate = 200;
      const ecgSamples = simIncludeEcg
        ? buildSimulatedEcgBatch(simHr, simEcgLeadOff, ecgSamplingRate, 100)
        : undefined;

      const created = await injectSimulatorReading({
        heartRate: simFingerOk ? simHr : null,
        spo2: simFingerOk ? simSpo2 : null,
        temperatureC: simTemp,
        accelMagnitude: simAccel,
        gyroMagnitude: simAccel * 10,
        movementStatus: simMovement,
        possibleFallDetected: simMovement === "fall_suspect",
        irSignalOk: simFingerOk,
        fingerDetected: simFingerOk,
        ecgSamples,
        ecgSamplingRate: simIncludeEcg ? ecgSamplingRate : undefined,
        ecgLeadOff: simIncludeEcg ? simEcgLeadOff : undefined,
        ecgSignalQuality: simIncludeEcg
          ? simEcgLeadOff
            ? "lead_off"
            : "good"
          : undefined,
        ecgTimestamp: simIncludeEcg ? new Date().toISOString() : undefined,
        source: "simulator",
      });
      setSimResultMessage(
        `Processed via /api/wearable/ingest (${created.alertLevel} · score ${created.anomalyScore.toFixed(3)}): ${created.explanation}`
      );
    } catch (err) {
      setSimResultMessage(err instanceof Error ? err.message : "Simulator request failed.");
    } finally {
      setSimSubmitting(false);
    }
  };

  const handleFitBaseline = async () => {
    setFittingBaseline(true);
    setBaselineFeedback(null);
    try {
      const res = await fitBaselineForSelectedPatient();
      setBaselineFeedback(res.message);
    } catch (err) {
      setBaselineFeedback(err instanceof Error ? err.message : "Failed to compute baseline.");
    } finally {
      setFittingBaseline(false);
    }
  };

  return (
    <div className="space-y-6">
      <TelemetryCharts readings={readings} patient={selectedPatient} />

      <MlIntelligencePanel
        patient={selectedPatient}
        readings={readings}
        latestReading={liveHardwareSnapshot ?? readings[readings.length - 1] ?? null}
        baselines={baselines}
        anomalyEvents={anomalyEvents}
        mlConnected={Boolean(integrations?.mlService.reachable)}
        isAdminUser={isAdminUser}
      />

      <EcgWaveformPanel
        segments={ecgSegments}
        title="AD8232 Historical & Live ECG Waveform Segments"
      />

      <div className="arova-float-grid grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Personal Baseline Learning Panel */}
        <section className="arova-float-card-subtle arova-float-delay-1 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[#202525]">Personalized Baseline Learning</h3>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Fits an individual Isolation Forest baseline once{" "}
                {systemSettings.baselineMinSamples}+ clean readings exist
              </p>
            </div>
            <button
              type="button"
              onClick={handleFitBaseline}
              disabled={fittingBaseline}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {fittingBaseline ? "Fitting..." : "Recompute Baseline"}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-1">
            <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
              <div className="text-xs text-[#737B7B]">Resting HR Mean</div>
              <div className="text-lg font-semibold text-[#008F00] font-mono tabular-nums mt-0.5">
                {selectedPatient.baselineHeartRateMean ? (
                  <AnimatedNumber
                    value={selectedPatient.baselineHeartRateMean}
                    decimals={1}
                    suffix=" BPM"
                  />
                ) : (
                  "--"
                )}
              </div>
            </div>
            <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
              <div className="text-xs text-[#737B7B]">SpO₂ Mean</div>
              <div className="text-lg font-semibold text-[#202525] font-mono tabular-nums mt-0.5">
                {selectedPatient.baselineSpo2Mean ? (
                  <AnimatedNumber value={selectedPatient.baselineSpo2Mean} decimals={1} suffix="%" />
                ) : (
                  "--"
                )}
              </div>
            </div>
            <div className="bg-[#F7F9F9] border border-[#D9E0E0] rounded-xl p-3">
              <div className="text-xs text-[#737B7B]">Temp / Active HR</div>
              <div className="text-lg font-semibold text-[#202525] font-mono tabular-nums mt-0.5">
                {selectedPatient.baselineTempMean ? (
                  <AnimatedNumber
                    value={selectedPatient.baselineTempMean}
                    decimals={1}
                    suffix=" °C"
                  />
                ) : (
                  "--"
                )}
                {selectedPatient.baselineActiveHrMean
                  ? ` · ${selectedPatient.baselineActiveHrMean.toFixed(0)}`
                  : ""}
              </div>
            </div>
          </div>

          <div className="text-xs text-[#737B7B] flex flex-wrap items-center justify-between gap-2 pt-1">
            <span>
              Source separation: HW {baselineStatusSummary?.esp32Hardware.collectedSamples ?? 0} ·
              Sim {baselineStatusSummary?.simulator.collectedSamples ?? 0} clean samples
            </span>
            {selectedPatient.baselineModelVersion && (
              <span className="font-mono text-[#008F00] font-medium">
                {selectedPatient.baselineModelVersion}
              </span>
            )}
          </div>

          {baselineFeedback && (
            <p className="text-xs text-[#202525] bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-3 leading-relaxed">
              {baselineFeedback}
            </p>
          )}
        </section>

        {/* Pipeline Simulator (Clearly Labeled Not Real Hardware) */}
        <section className="arova-float-card-subtle arova-float-delay-3 arova-glass-card rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[#202525]">
                Telemetry Pipeline Simulator (Test Only)
              </h3>
              <p className="text-xs text-[#737B7B] mt-0.5">
                Tagged as <span className="font-mono text-[#008F00] font-medium">source: &quot;simulator&quot;</span>{" "}
                · Tests MAX30100, nullable temp, and batched AD8232 ECG ingest
              </p>
            </div>
            <SlidersHorizontal className="w-4 h-4 text-[#00B800] shrink-0" />
          </div>

          <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-[#EEF2F2]">
            {!simRunning ? (
              <button
                type="button"
                onClick={() => startSimulation(simMode)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-md cursor-pointer transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                Start Simulation
              </button>
            ) : (
              <button
                type="button"
                onClick={stopSimulation}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 cursor-pointer transition-colors"
              >
                <Square className="w-3.5 h-3.5" />
                Stop Simulation
              </button>
            )}
            <button
              type="button"
              onClick={() => void generateNormalReading()}
              className="px-2.5 py-1.5 text-xs font-medium bg-white border border-[#D9E0E0] hover:border-[#00B800] text-[#008F00] rounded-md cursor-pointer transition-colors"
            >
              Generate Normal
            </button>
            <button
              type="button"
              onClick={() => void generateUnusualReading()}
              className="px-2.5 py-1.5 text-xs font-medium bg-amber-50 border border-amber-300 hover:bg-amber-100 text-amber-800 rounded-md cursor-pointer transition-colors"
            >
              Generate Unusual
            </button>
            <select
              value={simSensorError}
              onChange={(e) => setSimSensorError(e.target.value as SimSensorErrorMode)}
              className="px-2 py-1.5 text-xs border border-[#D9E0E0] rounded-md bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
            >
              <option value="none">Error Sim: None</option>
              <option value="poor_contact">Error Sim: Poor Contact</option>
              <option value="temp_disconnected">Error Sim: Temp Null</option>
              <option value="ecg_lead_off">Error Sim: ECG Lead-Off</option>
            </select>
            {simDeviceConnected ? (
              <button
                type="button"
                onClick={() => void disconnectSimulatedDevice()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white border border-[#D9E0E0] rounded-md text-[#202525] hover:border-[#00B800] cursor-pointer"
              >
                <Power className="w-3 h-3" />
                Disconnect Sim
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void reconnectSimulatedDevice()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[#00B800]/12 border border-[#00B800]/35 rounded-md text-[#008F00] cursor-pointer"
              >
                <Wifi className="w-3 h-3" />
                Reconnect Sim
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applyPreset("normal")}
              className="px-2.5 py-1.5 text-xs font-medium bg-[#00B800]/10 border border-[#00B800]/30 hover:bg-[#00B800]/18 text-[#008F00] rounded-md transition-colors cursor-pointer"
            >
              Normal Resting
            </button>
            <button
              type="button"
              onClick={() => applyPreset("warning_hr")}
              className="px-2.5 py-1.5 text-xs font-medium bg-amber-50 border border-amber-300 hover:bg-amber-100 text-amber-800 rounded-md transition-colors cursor-pointer"
            >
              Warning (Tachycardia)
            </button>
            <button
              type="button"
              onClick={() => applyPreset("critical_hypoxia")}
              className="px-2.5 py-1.5 text-xs font-medium bg-red-50 border border-red-300 hover:bg-red-100 text-red-800 rounded-md transition-colors cursor-pointer"
            >
              Critical (Low SpO₂ + Fall)
            </button>
            <button
              type="button"
              onClick={() => applyPreset("poor_contact")}
              className="px-2.5 py-1.5 text-xs font-medium bg-[#F7F9F9] hover:bg-[#EEF2F2] border border-[#D9E0E0] text-[#202525] rounded-md transition-colors cursor-pointer"
            >
              No Finger / Lead-Off (null)
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-[#737B7B] block">HR (BPM)</span>
              <input
                type="number"
                value={simHr ?? ""}
                placeholder="null"
                onChange={(e) =>
                  setSimHr(e.target.value === "" ? null : Number(e.target.value))
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">SpO₂ (%)</span>
              <input
                type="number"
                step="0.1"
                value={simSpo2 ?? ""}
                placeholder="null"
                onChange={(e) =>
                  setSimSpo2(e.target.value === "" ? null : Number(e.target.value))
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Temp (°C, optional)</span>
              <input
                type="number"
                step="0.1"
                value={simTemp ?? ""}
                placeholder="null (pending)"
                onChange={(e) =>
                  setSimTemp(e.target.value === "" ? null : Number(e.target.value))
                }
                className="w-full px-2.5 py-1.5 bg-white border border-[#D9E0E0] rounded-lg font-mono tabular-nums text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#737B7B] block">Movement</span>
              <select
                value={simMovement}
                onChange={(e) => setSimMovement(e.target.value as MovementStatus)}
                className="w-full px-2 py-1.5 border border-[#D9E0E0] rounded-lg bg-white text-[#202525] focus:outline-none focus:border-[#00B800]"
              >
                <option value="resting">resting</option>
                <option value="walking">walking</option>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="fall_suspect">fall_suspect</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-4 text-xs text-[#202525]">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={simFingerOk}
                  onChange={(e) => setSimFingerOk(e.target.checked)}
                  className="rounded border-[#D9E0E0] accent-[#00B800]"
                />
                MAX30100 finger valid
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={simIncludeEcg}
                  onChange={(e) => setSimIncludeEcg(e.target.checked)}
                  className="rounded border-[#D9E0E0] accent-[#00B800]"
                />
                Batch ECG (100 pts)
              </label>
              {simIncludeEcg && (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={simEcgLeadOff}
                    onChange={(e) => setSimEcgLeadOff(e.target.checked)}
                    className="rounded border-[#D9E0E0] accent-red-600"
                  />
                  AD8232 Lead-Off
                </label>
              )}
            </div>

            <button
              type="button"
              onClick={handleSendSim}
              disabled={simSubmitting}
              className="arova-cta-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#00B800] hover:bg-[#009900] rounded-lg disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {simSubmitting ? "Evaluating..." : "Run Pipeline Check"}
            </button>
          </div>

          {(simResultMessage || simLastPacketSummary) && (
            <p className="text-xs text-[#202525] bg-[#F7F9F9] border border-[#D9E0E0] rounded-lg p-3 leading-relaxed">
              {simResultMessage || simLastPacketSummary}
            </p>
          )}
        </section>
      </div>

      {/* Historical Telemetry Table */}
      <section className="arova-float-card-subtle arova-float-delay-5 arova-glass-card rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[#202525]">Recorded Telemetry History</h3>
            <p className="text-xs text-[#737B7B] mt-0.5">
              Complete log with MAX30100 contact quality, AD8232 ECG status, source origin, and ML attribution
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#737B7B] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter readings..."
                className="pl-8 pr-3 py-1.5 text-xs bg-white border border-[#D9E0E0] rounded-lg w-44 text-[#202525] placeholder:text-[#737B7B] focus:outline-none focus:border-[#00B800]"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#EEF2F2] border border-[#D9E0E0] rounded-lg">
              {(["All", "Normal", "Warning", "Critical"] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setFilterLevel(lvl)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    filterLevel === lvl
                      ? "bg-[#00B800] text-white font-semibold"
                      : "text-[#737B7B] hover:text-[#202525]"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#D9E0E0] text-xs font-medium text-[#737B7B]">
                <th className="py-2.5 pr-4">Time</th>
                <th className="py-2.5 pr-4 text-right">HR</th>
                <th className="py-2.5 pr-4 text-right">SpO₂</th>
                <th className="py-2.5 pr-4 text-right">Temp</th>
                <th className="py-2.5 pr-4">Movement</th>
                <th className="py-2.5 pr-4">Quality / ECG</th>
                <th className="py-2.5 pr-4">Level</th>
                <th className="py-2.5 pr-4">Source</th>
                <th className="py-2.5">Explanation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF2F2] text-xs">
              {filteredReadings.map((r) => (
                <tr key={r.readingId} className="hover:bg-[#F7F9F9] transition-colors">
                  <td className="py-2.5 pr-4 font-mono tabular-nums text-[#737B7B] whitespace-nowrap">
                    {new Date(r.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono tabular-nums font-medium text-[#202525] whitespace-nowrap">
                    {typeof r.heartRate === "number" ? `${Math.round(r.heartRate)} BPM` : "--"}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-[#202525] whitespace-nowrap">
                    {typeof r.spo2 === "number" ? `${r.spo2.toFixed(1)}%` : "--"}
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-[#202525] whitespace-nowrap">
                    {typeof r.temperatureC === "number" ? `${r.temperatureC.toFixed(1)} °C` : "--"}
                  </td>
                  <td className="py-2.5 pr-4 text-[#202525] whitespace-nowrap">
                    {r.movementStatus}
                    {r.possibleFallDetected ? " (exp. fall)" : ""}
                  </td>
                  <td className="py-2.5 pr-4 text-[#737B7B] whitespace-nowrap">
                    {r.signalQuality}
                    {r.ecgSignalQuality ? ` · ECG ${r.ecgSignalQuality}` : ""}
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    <div className="space-y-0.5">
                      <AlertLevelLabel level={r.alertLevel} />
                      <div className="font-mono text-[#737B7B]">
                        {r.anomalyScore.toFixed(2)}
                        {r.anomalyStatus ? ` · ${r.anomalyStatus}` : ""}
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[#008F00] font-medium whitespace-nowrap">
                    {r.source}
                  </td>
                  <td className="py-2.5 text-[#202525] min-w-[240px]">
                    <div>{r.explanation}</div>
                    {r.plainLanguageExplanations && r.plainLanguageExplanations.length > 0 && (
                      <div className="text-[11px] text-[#737B7B] mt-0.5">
                        {r.plainLanguageExplanations[0]}
                      </div>
                    )}
                    {r.contributingFeatures && r.contributingFeatures.length > 0 && (
                      <div className="font-mono text-[#008F00] mt-0.5">
                        Drivers: {r.contributingFeatures.join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
