# AROVA – Wearable-Based Early Warning System
## External Integration & ESP32 Hardware Quick Reference

AROVA runs in full development mode without external ML, physical ESP32 hardware, or voice-calling credentials. When connecting live external services or flashing physical hardware, use the configuration guides below. Server-side secrets belong in **Settings > Secrets** (never in client `VITE_*` variables or committed firmware files).

## 1. Python FastAPI + scikit-learn Isolation Forest (`ML_SERVICE_URL`)
- **Development Default**: Optional. When unset or unreachable, the dashboard clearly indicates **Demo Mode (Rule-Based Pre-Check)** and never pretends an Isolation Forest model is connected.
- **Note on ECG**: Dedicated ECG arrhythmia/anomaly ML models are **not** trained (`ecgModelTrained: false`). ECG feature extraction (`estimatedEcgBpm`, `rrIntervalMeanMs`, `rrVariabilityMs`) runs modularly for telemetry inspection only.
- **When Ready**: Start `/ml-service` (`uvicorn main:app --host 127.0.0.1 --port 18000`) and set `ML_SERVICE_URL="http://127.0.0.1:18000"` on the Node backend (avoid port `8000`, which is used by the AI Studio container bridge).

## 2. ESP32 Wearable Authentication (`WEARABLE_INGEST_TOKEN` / Per-Device `X-Device-Key`)
- **Development Default**: Simulator packets (`source: "simulator"`) work without a token for testing.
- **Before Connecting a Real ESP32**:
  1. Register your device in **AROVA > Device Setup** (`POST /api/wearable/devices/register`) to obtain a per-device `arova_dev_...` key, **or** set a global `WEARABLE_INGEST_TOKEN` (`openssl rand -hex 32`) in server **Settings > Secrets**.
  2. Copy `/firmware/arova_secrets.example.h` to `/firmware/arova_secrets.h` and configure `SECRET_WIFI_SSID`, `SECRET_WIFI_PASSWORD`, `SECRET_INGEST_ENDPOINT`, `SECRET_DEVICE_ID`, `SECRET_PATIENT_ID`, and `SECRET_DEVICE_KEY`.
  3. Flash `/firmware/arova_wearable_esp32.ino` (see `/HARDWARE_GUIDE.md` for full wiring, OLED, vibration motor, battery, and troubleshooting details).

## 3. Confirmed ESP32 Hardware Stack, Libraries & Pinout
Firmware file: `/firmware/arova_wearable_esp32.ino` (legacy v2 fallback: `/firmware/esp32_smartcare_template.ino`)

| Module | Status | Proposed ESP32 DevKit Pins | Verified Arduino Library |
| --- | --- | --- | --- |
| **MAX30102 / MAX30100** | Confirmed | `SDA GPIO 21`, `SCL GPIO 22` (`0x57`) | SparkFun `MAX3010x` (`PULSEOX_MAX30102` default) or OXullo `MAX30100lib` (`PULSEOX_MAX30100`) |
| **MPU6050 IMU** | Confirmed | `SDA GPIO 21`, `SCL GPIO 22` (`0x68`) | `Adafruit MPU6050` + `Adafruit Unified Sensor` (`accel_x/y/z` + `gyro_x/y/z`) |
| **0.96" SSD1306 OLED** | Confirmed | `SDA GPIO 21`, `SCL GPIO 22` (`0x3C`) | `Adafruit SSD1306` + `Adafruit GFX Library` (AROVA UI) |
| **Temperature Probe** | Configurable | `GPIO 4` (DS18B20 + 4.7k pull-up) or I²C `0x48`/`0x5A` | `OneWire` + `DallasTemperature`, `Adafruit TMP117`, or `Adafruit MLX90614` (`-127`/`85` rejected as `null`) |
| **Vibration Motor** | Confirmed | `GPIO 25` -> Transistor/MOSFET driver | Non-blocking `millis()` PWM (`Single` / `Triple` / `Deactivate`) + flyback diode |
| **AD8232 ECG** | Provisional | `OUTPUT GPIO 34` (ADC1), `LO+ GPIO 32`, `LO- GPIO 33` | Built-in `analogReadMilliVolts()` at `200 Hz` batched (battery-isolated only) |

## 4. Automated Caregiver Voice Calling (`TWILIO_*` / `VOICE_*`)
- Configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `PUBLIC_BASE_URL` in server **Settings > Secrets** for real Twilio emergency voice calling.
