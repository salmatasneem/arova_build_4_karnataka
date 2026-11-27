import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { clearWearableStoreForTests, createWearableRouter } from "../esp32Ingest.ts";

async function startTestServer() {
  clearWearableStoreForTests();
  const app = express();
  app.use(express.json());
  app.use("/api/wearable", createWearableRouter());

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}/api/wearable`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Phase 3 wearable /config exposes AROVA Phase 3 hardware metadata", async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.baseUrl}/config`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.ingestEndpoint, "/api/wearable/ingest");
    assert.equal(data.perDeviceRegistrationSupported, true);
  } finally {
    await srv.close();
  }
});

test("Phase 3 /devices endpoints require Firebase authentication (fail closed 401)", async () => {
  const srv = await startTestServer();
  try {
    const listRes = await fetch(`${srv.baseUrl}/devices`);
    assert.equal(listRes.status, 401);

    const regRes = await fetch(`${srv.baseUrl}/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "esp32_test_01", patientId: "pt_01" }),
    });
    assert.equal(regRes.status, 401);
  } finally {
    await srv.close();
  }
});

test("Phase 3 /ingest enforces global WEARABLE_INGEST_TOKEN when set and accepts valid X-Device-Key", async () => {
  const prevToken = process.env.WEARABLE_INGEST_TOKEN;
  process.env.WEARABLE_INGEST_TOKEN = "arova-phase3-secret-token";
  const srv = await startTestServer();
  try {
    // Missing token on real hardware -> 401
    const unauth = await fetch(`${srv.baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "esp32-arova-01",
        patient_id: "pt_phase3",
        timestamp: "2026-11-27T12:00:00Z",
        heart_rate_bpm: 74,
        spo2_percent: 98,
        temperature_c: 36.6,
        accel_x: 0.02,
        accel_y: -0.01,
        accel_z: 0.99,
        sensor_quality: "good",
        source: "real",
      }),
    });
    assert.equal(unauth.status, 401);

    // Valid token + snake_case Phase 3 payload -> 200 normalized
    const okRes = await fetch(`${srv.baseUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Key": "arova-phase3-secret-token",
      },
      body: JSON.stringify({
        device_id: "esp32-arova-01",
        patient_id: "pt_phase3",
        timestamp: "2026-11-27T12:00:02Z",
        heart_rate_bpm: 74,
        spo2_percent: 98,
        temperature_c: 36.6,
        accel_x: 0.02,
        accel_y: -0.01,
        accel_z: 0.99,
        sensor_quality: "good",
        source: "real",
      }),
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.source, "esp32_hardware");
    assert.equal(body.heartRate, 74);
    assert.equal(body.spo2, 98);
    assert.equal(body.temperatureC, 36.6);
    assert.equal(body.accelX, 0.02);
    assert.equal(body.accelY, -0.01);
    assert.equal(body.accelZ, 0.99);
    assert.equal(body.signalQuality, "good");
  } finally {
    if (prevToken === undefined) delete process.env.WEARABLE_INGEST_TOKEN;
    else process.env.WEARABLE_INGEST_TOKEN = prevToken;
    await srv.close();
  }
});

test("Phase 3 /ingest rejects invalid/poor_contact readings instead of treating them as healthy vitals", async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "sim_node_01",
        patient_id: "pt_sim_err",
        timestamp: "2026-11-27T12:05:00Z",
        heart_rate_bpm: 0,
        spo2_percent: 0,
        temperature_c: -127,
        accel_x: 0.0,
        accel_y: 0.0,
        accel_z: 1.0,
        sensor_quality: "poor_contact",
        source: "simulated",
      }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.source, "simulator");
    assert.equal(data.heartRate, null);
    assert.equal(data.spo2, null);
    assert.equal(data.temperatureC, null);
    assert.equal(data.signalQuality, "poor_contact");
    assert.equal(data.anomalyStatus, "paused_poor_quality");
  } finally {
    await srv.close();
  }
});
