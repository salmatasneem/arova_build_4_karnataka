# AROVA – Wearable-Based Early Warning System
## Complete ESP32 Hardware & IoT Integration Guide (`/HARDWARE_GUIDE.md`)

> **Important Honesty & Safety Note**: Pin numbers listed below are **proposed defaults** defined in `/firmware/arova_wearable_esp32.ino`. Always confirm exact pinouts against your physical ESP32 DevKit silkscreen, breakout boards, and multimeter continuity checks before powering or soldering. Never claim physical hardware is streaming when running Simulation Mode.

---

## 1. Required Hardware Components

| Component | Recommended Model | Role in AROVA | Notes / Verification |
| --- | --- | --- | --- |
| **Microcontroller** | ESP32 DevKit v1 (3.3V, Dual-Core Wi-Fi) | Sensor polling (Core 1), Wi-Fi & HTTPS POST (Core 0) | Supports 2.4 GHz Wi-Fi only (no 5 GHz). |
| **Pulse Oximeter** | **MAX30102** (Default) or **MAX30100** | Heart Rate (BPM), Est. SpO₂ (%), optical finger detection | Set `#define PULSEOX_MODEL PULSEOX_MAX30102` or `PULSEOX_MAX30100`. |
| **6-Axis IMU** | **MPU6050** (Accelerometer + Gyroscope) | Triaxial acceleration (`accel_x/y/z`), `gyro_x/y/z`, movement state, experimental impact indicator | I²C address `0x68` (`AD0 = GND`). |
| **Temperature Probe** | **DS18B20** (Default), **TMP117**, or **MLX90614** | Skin temperature (°C) with sentinel rejection (`-127`, `85`, `NAN` -> `null`) | DS18B20 requires a `4.7 kΩ` pull-up resistor to `3.3V`. |
| **Wearable Display** | **0.96" SSD1306 I²C OLED** (`128×64`, `0x3C`) | Displays **AROVA** branding, Wi-Fi/Backend status, HR, SpO₂, Temp, Activity, Sensor Health | Uses `Adafruit_SSD1306` + `Adafruit_GFX`. |
| **Haptic Alert Motor** | 3V Coin/ERM Vibration Motor + Transistor/MOSFET + Flyback Diode | Non-blocking alert vibration (`single_pulse`, `triple_alert`, `deactivate`) | **Never** wire motor directly to an ESP32 GPIO pin. |
| **Provisional ECG (Optional)** | **AD8232** Single-Lead ECG + `LO+` / `LO-` | Optional 200 Hz batched ECG waveforms (`ECG_ENABLED true`) | **Battery-isolated operation only** during skin contact. |
| **Power Management** | 3.7V Li-ion/LiPo Cell + TP4056 Charger/Protection + 3.3V LDO/Buck | Portable power for wearable operation | Optional voltage divider (`2× 100 kΩ`) on `GPIO 35` (`BATTERY_ADC_ENABLED`). |

---

## 2. Proposed Wiring & Pin Connections (Confirm on Physical Hardware)

> **Warning**: Verify I²C pull-up voltage (`3.3V`) and ESP32 ADC1 pin restrictions (`GPIO 32–39`) before wiring. **Do not use ADC2 pins for analog sensors while Wi-Fi is active.**

| Sensor / Actuator Pin | ESP32 DevKit GPIO *(Proposed)* | Bus / Electrical Spec |
| --- | --- | --- |
| **MAX30102 / MAX30100 `VIN`, `GND`, `SDA`, `SCL`** | `3.3V`, `GND`, `GPIO 21 (SDA)`, `GPIO 22 (SCL)` | I²C `0x57` (`400 kHz`; `100 kHz` if paired with MLX90614) |
| **MPU6050 `VCC`, `GND`, `SDA`, `SCL`, `AD0`** | `3.3V`, `GND`, `GPIO 21`, `GPIO 22`, `GND` | I²C `0x68` |
| **0.96" SSD1306 OLED `VCC`, `GND`, `SDA`, `SCL`** | `3.3V`, `GND`, `GPIO 21`, `GPIO 22` | I²C `0x3C` |
| **DS18B20 `VCC`, `GND`, `DQ`** | `3.3V`, `GND`, `GPIO 4` | 1-Wire + **`4.7 kΩ` resistor between `GPIO 4` and `3.3V`** |
| **Vibration Motor Driver (`Gate/Base`)** | `GPIO 25` -> `1 kΩ` -> **NPN (2N2222) / Logic MOSFET (2N7000 / IRLZ44N)** | Flyback diode (`1N5819` / `1N4007`) across motor (`3.3V` to collector/drain); emitter/source to `GND` |
| **AD8232 ECG *(Optional)* `OUTPUT`, `LO+`, `LO-`** | `GPIO 34 (ADC1)`, `GPIO 32`, `GPIO 33` | `3.3V` / `GND` only on **isolated battery** |
| **Battery Monitor *(Optional)*** | `GPIO 35 (ADC1)` | Midpoint of `100 kΩ` (to `VBAT+`) and `100 kΩ` (to `GND`) |

---

## 3. Arduino IDE & Library Setup

1. Install **Arduino IDE 2.x** (or PlatformIO) and add the **ESP32 Board Core** by Espressif Systems (`esp32` v2.0.x or v3.x).
2. Install required libraries via Arduino Library Manager:
   - **MAX30102 (Default)**: `SparkFun MAX3010x Pulse and Proximity Sensor Library`
   - **OR MAX30100**: `MAX30100lib` by OXullo Intersecans
   - **IMU**: `Adafruit MPU6050` + `Adafruit Unified Sensor`
   - **OLED**: `Adafruit SSD1306` + `Adafruit GFX Library`
   - **JSON**: `ArduinoJson` by Benoit Blanchon (`v6.x` or `v7.x`)
   - **Temperature**: `OneWire` + `DallasTemperature` (for DS18B20), `Adafruit TMP117`, or `Adafruit MLX90614 Library`

---

## 4. Wi-Fi & Secrets Configuration

1. Open **AROVA > Device Setup** (`HardwareIntegrationPage`), confirm your `Device ID` and `Patient ID`, and click **Register & Generate X-Device-Key**.
2. Copy `/firmware/arova_secrets.example.h` to `/firmware/arova_secrets.h` (which is git-ignored / never committed).
3. Set inside `/firmware/arova_secrets.h`:
   - `SECRET_WIFI_SSID` & `SECRET_WIFI_PASSWORD` (must be **2.4 GHz** Wi-Fi)
   - `SECRET_INGEST_ENDPOINT` (e.g., `https://your-arova-host/api/wearable/ingest` or local `http://<LAN_IP>:3000/api/wearable/ingest`)
   - `SECRET_DEVICE_ID` & `SECRET_PATIENT_ID`
   - `SECRET_DEVICE_KEY` (the `arova_dev_...` key generated in Device Setup, or server `WEARABLE_INGEST_TOKEN`)
   - `SECRET_ROOT_CA_PEM` (your server's Root CA certificate when using HTTPS)

> **Security Rule**: Never place Firebase Admin SDK credentials or database service accounts in ESP32 firmware. The ESP32 authenticates solely to the AROVA Express backend via `X-Device-Key`.

---

## 5. Backend Connection & Authentication Architecture

```text
ESP32 Sensors (MAX30102/100, MPU6050, Temp, AD8232)
   └─► Core 1 Sensor & OLED Loop + Non-Blocking Haptics
         └─► Core 0 Retry Queue (HTTP/HTTPS POST + X-Device-Key)
               └─► Express Backend (/api/wearable/ingest)
                     ├─► Device Key Verification (SHA-256)
                     ├─► Signal Quality & Sentinel Validation
                     ├─► Queued Vibration Command Delivery
                     └─► Dashboard Gateway -> Cloud Firestore -> Live Patient UI
```

---

## 6. OLED Display Guide

The 0.96" SSD1306 OLED renders 5 status lines at 2 Hz:
1. **Header**: `AROVA LIVE Normal` (shows `WF:OK` when Wi-Fi connected without backend ACK, `NoWF` when disconnected, and active alert severity).
2. **Pulse Oximeter**: `HR:74  SpO2:98%` (or `HR:--  SpO2:-- NoFing` when finger is removed, or `PulseOx: ERR (0x57)` if sensor disconnected).
3. **Temperature**: `Temp: 36.7 C` (or `-- (N/A)` when probe is missing/erroring).
4. **Activity & Motor**: `Act:resting [MON]` (`[VIB]` while motor pulses, `[OFF]` when Wi-Fi offline).
5. **Bus Health & Battery**: `OX:1 IMU:1 T:1 B:86%` (`1` = healthy, `0` = unavailable).

---

## 7. Vibration Motor Alert Operation & Circuit Diagram

```text
ESP32 GPIO 25 ──[ 1 kΩ ]──► Gate/Base (MOSFET / NPN)
                                │
3.3V Supply ──► Vibration Motor ┼──► Drain/Collector
                  ▲  (1N5819 diode cathode to 3.3V, anode to Drain/Collector)
GND ────────────────────────────┴──► Source/Emitter
```

- Automatic alerts (`Warning` -> `single_pulse`, `Critical` -> `triple_alert`) and manual dashboard commands (`POST /api/wearable/devices/:deviceId/command`) return inside `deviceCommand` on `/api/wearable/ingest` and run asynchronously via `millis()`.

---

## 8. Power & Battery Guidelines

1. **Isolated Battery for Body Contact**: When wearing skin sensors (especially AD8232 ECG electrodes), disconnect laptop USB and mains chargers; run solely on the LiPo/Li-ion battery.
2. **Current Budget**: ESP32 Wi-Fi TX peaks (~240 mA) + MAX30102 LEDs (~30 mA) + OLED (~20 mA) + Vibration motor (~70 mA) require a `3.3V` regulator rated for at least **600 mA–1 A** continuous output with a `100 µF` decoupling capacitor near `3V3`/`GND`.

---

## 9. Testing Procedure

1. **Software Pipeline Test (No Hardware Required)**: Open **Device Setup** or **Trends & Baseline**, click **Start Simulation**, test **Generate Normal**, **Generate Unusual**, **Sensor Error Injection**, and **Disconnect/Reconnect Simulated Device**, confirming timestamps, badges (`Simulated`), and charts update in real time.
2. **Hardware Bench Test**: Flash `/firmware/arova_wearable_esp32.ino`, open Serial Monitor (`115200`), verify `AROVA LIVE` on OLED, place finger on MAX30102/100, verify **Patient Overview** switches to **`Real Hardware · ESP32`**, and trigger a **Single Pulse** test in **Vibration Motor Alert Control**.

---

## 10. Troubleshooting Tips

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| OLED blank / `MPU6050 not found` | Swapped SDA/SCL or wrong I²C address | Verify `SDA=GPIO 21`, `SCL=GPIO 22`, `0x3C` (OLED), `0x68` (MPU6050). |
| `MAX30100/MAX30102 init failed` | Board pull-ups tied to 1.8V LDO (common on green/purple RCWL-0530 boards) | Inspect PCB pull-up resistors and rework to `3.3V`, or verify `0x57` via I²C scanner. |
| `HR:-- SpO2:-- NoFing` | Insufficient finger pressure or ambient light leak | Rest finger gently (do not press hard enough to blanch capillaries) over optical window. |
| `Temp: -- (N/A)` | Missing `4.7 kΩ` pull-up on DS18B20 or `-127`/`85` sentinel | Add `4.7 kΩ` resistor from `GPIO 4` to `3.3V` and confirm `TEMP_SENSOR_MODEL` matches probe. |
| `HTTP ingest returned 401` | Mismatched `SECRET_DEVICE_KEY` | Re-generate key in **Device Setup**, update `arova_secrets.h`, and re-flash. |
| Wi-Fi never connects | 5 GHz SSID configured | ESP32 supports **2.4 GHz** Wi-Fi only; switch to a 2.4 GHz network. |
