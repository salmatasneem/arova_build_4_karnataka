/*
 * ============================================================================
 * AROVA – Wearable-Based Early Warning System
 * ESP32 DevKit Wearable Firmware (Legacy v2 Template — Prefer arova_wearable_esp32.ino)
 * ============================================================================
 *
 * CONFIRMED / PROVISIONAL HARDWARE STACK:
 *   1. ESP32 DevKit (3.3V logic, dual-core Wi-Fi MCU)
 *   2. MAX30100 Pulse Oximeter — CONFIRMED (use OXullo Arduino-MAX30100 ONLY;
 *      do NOT substitute SparkFun MAX3010x / MAX30102 / MAX30105 drivers)
 *   3. AD8232 Single-Lead ECG — PROVISIONAL (ESP32 ADC1 + LO+/LO- lead-off,
 *      continuous double-buffered 200 Hz batched waveform acquisition)
 *   4. MPU6050 6-axis IMU (I2C 0x68) — Movement + experimental possible-fall
 *   5. Temperature Sensor — CONFIGURABLE (default TEMP_SENSOR_NONE sends JSON
 *      null until physical sensor model is confirmed)
 *   6. 0.96" SSD1306 I2C OLED (I2C 0x3C, 128x64)
 *   7. Coin/ERM Vibration Motor via NPN/MOSFET driver + flyback diode (GPIO 25)
 *   8. Rechargeable Li-ion/LiPo battery + charging/protection + 3.3V regulation
 *
 * PROPOSED ESP32 DEVKIT PINOUT (Confirm/adjust before soldering):
 *   - Shared I2C Bus (SDA = GPIO 21, SCL = GPIO 22):
 *       * SSD1306 OLED : 0x3C (default)
 *       * MAX30100     : 0x57 (fixed)
 *       * MPU6050      : 0x68 (AD0=GND)
 *       * Optional TMP117 (0x48) or MLX90614 (0x5A, forces I2C 100 kHz)
 *   - AD8232 ECG (MUST use ADC1 because Wi-Fi disables ADC2):
 *       * OUTPUT -> GPIO 34 (ADC1_CH6, input-only)
 *       * LO+    -> GPIO 32 (digital input)
 *       * LO-    -> GPIO 33 (digital input)
 *   - Optional DS18B20 1-Wire Temp -> GPIO 4 (with external 4.7k pull-up to 3.3V)
 *   - Vibration Motor Transistor/MOSFET Gate/Base -> GPIO 25 (via 1k resistor)
 *   - Optional Battery Voltage Divider (ADC1)     -> GPIO 35 (disabled by default)
 *
 * DOCUMENTED CORE & LIBRARY VERSIONS:
 *   - Board Core: esp32 by Espressif Systems (v2.0.x or v3.x / v4.x compatible)
 *   - "MAX30100lib" by OXullo Intersecans (v1.2.1, <MAX30100_PulseOximeter.h>)
 *   - "Adafruit MPU6050" (v2.2.9) + "Adafruit Unified Sensor"
 *   - "Adafruit SSD1306" (v2.5.17) + "Adafruit GFX Library" (v1.13.0)
 *   - "ArduinoJson" by Benoit Blanchon (v6.x or v7.4.3 supported via #if guard)
 *   - Optional Temp: "OneWire" (v2.3.8) + "DallasTemperature" (v4.0.6),
 *     "Adafruit TMP117" (v1.0.5), or "Adafruit MLX90614 Library" (v2.1.7)
 *
 * ELECTRICAL & TIMING PRECAUTIONS:
 *   1. BATTERY-ISOLATED ECG ONLY: Power the wearable from an isolated battery
 *      when AD8232 skin electrodes are attached to a person. Never connect body
 *      electrodes while plugged into a mains-powered laptop USB or wall charger.
 *   2. MAX30100 RCWL-0530 PULL-UP ISSUE: Many green/purple MAX30100 breakouts
 *      tie I2C pull-ups to an onboard 1.8V regulator. If Wire scan fails to see
 *      0x57, verify/rework SDA/SCL pull-ups cleanly to 3.3V.
 *   3. DUAL-CORE NON-BLOCKING DESIGN: Core 1 runs pox.update(), 200 Hz ECG
 *      sampling, MPU6050, OLED, and PWM haptics. Core 0 handles HTTPS POSTs
 *      using double-buffered ECG batches so network latency never starves
 *      MAX30100 FIFO reads or drops 200 Hz ECG samples.
 * ============================================================================
 */

#include <Arduino.h>
#if __has_include(<esp_arduino_version.h>)
  #include <esp_arduino_version.h>
#endif
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <math.h>
#include <time.h>

#include <MAX30100_PulseOximeter.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ----------------------------------------------------------------------------
// 1. CONFIGURABLE TEMPERATURE SENSOR SELECTION
// ----------------------------------------------------------------------------
#define TEMP_SENSOR_NONE      0
#define TEMP_SENSOR_DS18B20   1
#define TEMP_SENSOR_TMP117    2
#define TEMP_SENSOR_MLX90614  3

// Default is NONE until physical temperature sensor model is confirmed.
// When NONE, firmware transmits JSON null and never fabricates a value.
#define TEMP_SENSOR_MODEL     TEMP_SENSOR_NONE

#if TEMP_SENSOR_MODEL == TEMP_SENSOR_DS18B20
  #include <OneWire.h>
  #include <DallasTemperature.h>
  #define TEMP_ONEWIRE_PIN 4
  OneWire oneWireBus(TEMP_ONEWIRE_PIN);
  DallasTemperature ds18b20(&oneWireBus);
#elif TEMP_SENSOR_MODEL == TEMP_SENSOR_TMP117
  #include <Adafruit_TMP117.h>
  Adafruit_TMP117 tmp117;
#elif TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
  #include <Adafruit_MLX90614.h>
  Adafruit_MLX90614 mlx90614;
#endif

// ----------------------------------------------------------------------------
// 2. PIN DEFINITIONS & SENSOR CONSTANTS (UNCHANGED)
// ----------------------------------------------------------------------------
#define I2C_SDA_PIN           21
#define I2C_SCL_PIN           22

// AD8232 ECG (Provisional — ADC1 only!)
#define ECG_ENABLED           true
#define ECG_LEAD_OFF_ENABLED  true
#define ECG_OUTPUT_PIN        34   // ADC1_CH6 (input-only)
#define ECG_LO_PLUS_PIN       32
#define ECG_LO_MINUS_PIN      33
#define ECG_SAMPLING_RATE_HZ  200
#define ECG_BATCH_SIZE        250  // 1.25s continuous window at 200 Hz (backend max 250)

// Vibration Motor Driver (Transistor / Logic-level MOSFET + flyback diode)
#define VIBRATION_PIN         25
#define VIBRATION_PWM_CHANNEL 0
#define VIBRATION_PWM_FREQ    2000
#define VIBRATION_PWM_RES     8
#define VIBRATION_DUTY        210  // 0..255 PWM drive

// Optional Battery Voltage Divider (disabled until hardware divider confirmed)
#define BATTERY_ADC_ENABLED   false
#define BATTERY_ADC_PIN       35

// OLED Display (0.96" SSD1306 128x64 I2C)
#define OLED_WIDTH            128
#define OLED_HEIGHT           64
#define OLED_I2C_ADDR         0x3C

// Timing Intervals
#define TELEMETRY_UPLOAD_MS   1250  // Matches 250 samples @ 200 Hz -> zero ECG gaps
#define OLED_REFRESH_MS       500
#define WIFI_RETRY_MS         10000
#define MAX30100_BEAT_TIMEOUT_MS 4500

// ----------------------------------------------------------------------------
// 3. NETWORK & TLS CERTIFICATE CONFIGURATION
// ----------------------------------------------------------------------------
const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

// Production HTTPS endpoint (replace YOUR_SMARTCARE_HOST before flashing)
const char* INGEST_ENDPOINT = "https://YOUR_SMARTCARE_HOST/api/wearable/ingest";
const char* DEVICE_ID       = "esp32-smartcare-01";
const char* PATIENT_ID      = "sample_patient_elena";
// Must match server-side WEARABLE_INGEST_TOKEN (sent via X-Device-Key header)
const char* DEVICE_KEY      = "YOUR_WEARABLE_INGEST_TOKEN";

// TLS Certificate Validation:
// Paste your server's Root CA PEM below (for example, obtain via:
//   openssl s_client -showcerts -connect YOUR_HOST:443 </dev/null
// and copy the final Root CA certificate block).
// Insecure TLS bypass is DISABLED by default.
#define ALLOW_INSECURE_TLS_DEV false
const char* ROOT_CA_PEM =
  "-----BEGIN CERTIFICATE-----\n"
  "PASTE_YOUR_ROOT_CA_PEM_HERE\n"
  "-----END CERTIFICATE-----\n";

// ----------------------------------------------------------------------------
// 4. HARDWARE OBJECTS & SHARED DUAL-CORE STATE
// ----------------------------------------------------------------------------
PulseOximeter pox;
Adafruit_MPU6050 mpu;
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

bool max30100Ready = false;
bool mpuReady = false;
bool oledReady = false;
bool tempSensorReady = false;
bool ntpSynced = false;

volatile unsigned long lastBeatMs = 0;
float latestHr = 0.0f;
float latestSpo2 = 0.0f;
bool maxFingerDetected = false;
bool maxIrSignalOk = false;

float latestTempC = NAN;
float latestAccelMagG = 1.0f;
float latestGyroMagDps = 0.0f;
const char* latestMovementStatus = "resting";
bool possibleFallFlag = false;
unsigned long highImpactMs = 0;

// Ping-pong double buffer for gapless 200 Hz AD8232 ECG capture
float ecgBuffers[2][ECG_BATCH_SIZE];
int activeEcgBuf = 0;
int ecgSampleIdx = 0;
unsigned long lastEcgSampleUs = 0;
const unsigned long ecgSamplePeriodUs = 1000000UL / ECG_SAMPLING_RATE_HZ;
bool ecgLeadOffLatched = false;

// Snapshot transferred from Core 1 -> Core 0 network upload task
struct TelemetrySnapshot {
  bool pending;
  bool maxFingerDetected;
  bool maxIrSignalOk;
  float heartRate;
  float spo2;
  float temperatureC;
  float accelMagnitude;
  float gyroMagnitude;
  char movementStatus[20];
  bool possibleFallDetected;
  bool oledActive;
  bool batteryValid;
  float batteryPct;
  int ecgCount;
  bool ecgLeadOff;
  char ecgSignalQuality[16];
  char ecgTimestamp[32];
  float ecgSamples[ECG_BATCH_SIZE];
};

TelemetrySnapshot uploadSnapshot;
portMUX_TYPE sharedMux = portMUX_INITIALIZER_UNLOCKED;

// Haptic non-blocking state machine (written/updated on Core 1, queued from Core 0)
enum HapticMode { HAPTIC_IDLE, HAPTIC_SINGLE, HAPTIC_TRIPLE };
HapticMode hapticMode = HAPTIC_IDLE;
int hapticStep = 0;
unsigned long hapticStepStartMs = 0;
bool hapticMotorOn = false;

char pendingHapticPattern[20] = "";
bool hasPendingHaptic = false;
char lastAlertLevel[16] = "Normal";

unsigned long lastUploadMs = 0;
unsigned long lastOledMs = 0;
unsigned long lastWifiCheckMs = 0;

// ----------------------------------------------------------------------------
// 5. ESP32 CORE v2 / v3 / v4 PWM COMPATIBILITY HELPERS
// ----------------------------------------------------------------------------
void initVibrationPwm() {
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);
  #if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(VIBRATION_PIN, VIBRATION_PWM_FREQ, VIBRATION_PWM_RES);
    ledcWrite(VIBRATION_PIN, 0);
  #else
    ledcSetup(VIBRATION_PWM_CHANNEL, VIBRATION_PWM_FREQ, VIBRATION_PWM_RES);
    ledcAttachPin(VIBRATION_PIN, VIBRATION_PWM_CHANNEL);
    ledcWrite(VIBRATION_PWM_CHANNEL, 0);
  #endif
}

void setVibrationOutput(bool active) {
  hapticMotorOn = active;
  uint8_t duty = active ? VIBRATION_DUTY : 0;
  #if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(VIBRATION_PIN, duty);
  #else
    ledcWrite(VIBRATION_PWM_CHANNEL, duty);
  #endif
}

void startHapticPattern(const char* pattern) {
  if (!pattern) return;
  if (strcmp(pattern, "triple_alert") == 0 || strcmp(pattern, "triple_urgent") == 0) {
    hapticMode = HAPTIC_TRIPLE;
    hapticStep = 0;
    hapticStepStartMs = millis();
    setVibrationOutput(true);
  } else if (strcmp(pattern, "single_pulse") == 0) {
    hapticMode = HAPTIC_SINGLE;
    hapticStep = 0;
    hapticStepStartMs = millis();
    setVibrationOutput(true);
  }
}

void updateHapticMotor(unsigned long nowMs) {
  // Consume any pattern queued by Core 0 network task
  char patternCopy[20] = "";
  portENTER_CRITICAL(&sharedMux);
  if (hasPendingHaptic) {
    strncpy(patternCopy, pendingHapticPattern, sizeof(patternCopy) - 1);
    patternCopy[sizeof(patternCopy) - 1] = '\0';
    hasPendingHaptic = false;
  }
  portEXIT_CRITICAL(&sharedMux);

  if (patternCopy[0] != '\0') {
    startHapticPattern(patternCopy);
  }

  if (hapticMode == HAPTIC_IDLE) return;
  unsigned long elapsed = nowMs - hapticStepStartMs;

  if (hapticMode == HAPTIC_SINGLE) {
    if (elapsed >= 200) {
      setVibrationOutput(false);
      hapticMode = HAPTIC_IDLE;
    }
    return;
  }

  if (hapticMode == HAPTIC_TRIPLE) {
    // 3x (220ms ON, 140ms OFF)
    bool shouldBeOn = (hapticStep % 2 == 0);
    unsigned long phaseDuration = shouldBeOn ? 220UL : 140UL;
    if (elapsed >= phaseDuration) {
      hapticStep++;
      hapticStepStartMs = nowMs;
      if (hapticStep >= 6) {
        setVibrationOutput(false);
        hapticMode = HAPTIC_IDLE;
      } else {
        setVibrationOutput(hapticStep % 2 == 0);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 6. MAX30100 CALLBACK & QUALITY VALIDATION
// ----------------------------------------------------------------------------
void onMax30100BeatDetected() {
  lastBeatMs = millis();
}

void updateMax30100Readings(unsigned long nowMs) {
  if (!max30100Ready) {
    maxFingerDetected = false;
    maxIrSignalOk = false;
    latestHr = 0.0f;
    latestSpo2 = 0.0f;
    return;
  }

  float hr = pox.getHeartRate();
  uint8_t spo2Raw = pox.getSpO2();
  bool beatRecent = (lastBeatMs > 0) && ((nowMs - lastBeatMs) <= MAX30100_BEAT_TIMEOUT_MS);

  bool hrValid = isfinite(hr) && hr >= 30.0f && hr <= 240.0f;
  bool spo2Valid = spo2Raw >= 50 && spo2Raw <= 100;

  if (beatRecent && hrValid && spo2Valid) {
    latestHr = hr;
    latestSpo2 = (float)spo2Raw;
    maxFingerDetected = true;
    maxIrSignalOk = true;
  } else {
    latestHr = 0.0f;
    latestSpo2 = 0.0f;
    maxFingerDetected = false;
    maxIrSignalOk = false;
  }
}

// ----------------------------------------------------------------------------
// 7. AD8232 BATCHED ECG ACQUISITION (NON-BLOCKING MICROS, DOUBLE-BUFFERED)
// ----------------------------------------------------------------------------
bool readEcgLeadOffPins() {
  if (!ECG_ENABLED || !ECG_LEAD_OFF_ENABLED) return false;
  return (digitalRead(ECG_LO_PLUS_PIN) == HIGH) || (digitalRead(ECG_LO_MINUS_PIN) == HIGH);
}

void pollEcgBatch(unsigned long nowUs) {
  if (!ECG_ENABLED) return;
  if ((unsigned long)(nowUs - lastEcgSampleUs) < ecgSamplePeriodUs) return;

  // Catch up cleanly without drift unless severely stalled
  lastEcgSampleUs += ecgSamplePeriodUs;
  if ((unsigned long)(nowUs - lastEcgSampleUs) >= (ecgSamplePeriodUs * 4)) {
    lastEcgSampleUs = nowUs;
  }

  bool leadOffNow = readEcgLeadOffPins();
  if (leadOffNow) {
    ecgLeadOffLatched = true;
  }

  if (ecgSampleIdx < ECG_BATCH_SIZE) {
    if (leadOffNow) {
      // Zero-centered flat sentinel when leads are off; backend suppresses metrics
      ecgBuffers[activeEcgBuf][ecgSampleIdx++] = 0.0f;
    } else {
      // Calibrated eFuse millivolt reading centered around ~1650 mV virtual ground
      float mv = (float)analogReadMilliVolts(ECG_OUTPUT_PIN);
      ecgBuffers[activeEcgBuf][ecgSampleIdx++] = mv - 1650.0f;
    }
  }
}

const char* assessEcgBatchQuality(const float* buf, int count, bool leadOff) {
  if (!ECG_ENABLED || count < 10) return "unavailable";
  if (leadOff) return "lead_off";

  float minVal = buf[0];
  float maxVal = buf[0];
  for (int i = 1; i < count; i++) {
    if (buf[i] < minVal) minVal = buf[i];
    if (buf[i] > maxVal) maxVal = buf[i];
  }
  float span = maxVal - minVal;
  if (span < 15.0f) return "unavailable";  // Flatline / unplugged AD8232 output
  if (span > 2800.0f) return "noisy";      // Saturated rail motion artifact
  return "good";
}

// ----------------------------------------------------------------------------
// 8. MPU6050 MOVEMENT & EXPERIMENTAL FALL INDICATOR
// ----------------------------------------------------------------------------
void readMpu6050Sample(unsigned long nowMs) {
  if (!mpuReady) {
    latestAccelMagG = 1.0f;
    latestGyroMagDps = 0.0f;
    latestMovementStatus = "resting";
    possibleFallFlag = false;
    return;
  }

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  float accelMs2 = sqrtf(
    a.acceleration.x * a.acceleration.x +
    a.acceleration.y * a.acceleration.y +
    a.acceleration.z * a.acceleration.z
  );
  latestAccelMagG = accelMs2 / 9.80665f;

  float gyroRad = sqrtf(
    g.gyro.x * g.gyro.x +
    g.gyro.y * g.gyro.y +
    g.gyro.z * g.gyro.z
  );
  latestGyroMagDps = gyroRad * 57.29578f;

  // Experimental impact indicator (NOT medically validated fall detection)
  if (latestAccelMagG >= 2.6f) {
    highImpactMs = nowMs;
  }

  if (highImpactMs > 0 && (nowMs - highImpactMs) <= 6000UL) {
    possibleFallFlag = true;
    latestMovementStatus = "fall_suspect";
  } else {
    possibleFallFlag = false;
    float dynG = fabsf(latestAccelMagG - 1.0f);
    if (dynG > 0.35f || latestGyroMagDps > 75.0f) {
      latestMovementStatus = "active";
    } else if (dynG > 0.12f || latestGyroMagDps > 20.0f) {
      latestMovementStatus = "walking";
    } else {
      latestMovementStatus = "resting";
    }
  }
}

// ----------------------------------------------------------------------------
// 9. CONFIGURABLE TEMPERATURE SENSOR READER
// ----------------------------------------------------------------------------
const char* getTempModelName() {
  #if TEMP_SENSOR_MODEL == TEMP_SENSOR_DS18B20
    return "DS18B20";
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_TMP117
    return "TMP117";
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    return "MLX90614";
  #else
    return nullptr;
  #endif
}

void initTemperatureSensor() {
  #if TEMP_SENSOR_MODEL == TEMP_SENSOR_DS18B20
    ds18b20.begin();
    ds18b20.setWaitForConversion(false);
    ds18b20.requestTemperatures();
    tempSensorReady = (ds18b20.getDeviceCount() > 0);
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_TMP117
    tempSensorReady = tmp117.begin();
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    tempSensorReady = mlx90614.begin();
  #else
    tempSensorReady = false;
  #endif
}

void readTemperatureSensor() {
  #if TEMP_SENSOR_MODEL == TEMP_SENSOR_DS18B20
    if (!tempSensorReady) { latestTempC = NAN; return; }
    float c = ds18b20.getTempCByIndex(0);
    ds18b20.requestTemperatures();
    latestTempC = (c > -50.0f && c < 85.0f && c != 85.0f) ? c : NAN;
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_TMP117
    if (!tempSensorReady) { latestTempC = NAN; return; }
    sensors_event_t t;
    tmp117.getEvent(&t);
    latestTempC = isfinite(t.temperature) ? t.temperature : NAN;
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    if (!tempSensorReady) { latestTempC = NAN; return; }
    float c = mlx90614.readObjectTempC();
    latestTempC = (isfinite(c) && c > 15.0f && c < 50.0f) ? c : NAN;
  #else
    latestTempC = NAN;
  #endif
}

// ----------------------------------------------------------------------------
// 10. SSD1306 OLED RENDERER (CORE 1)
// ----------------------------------------------------------------------------
void refreshOledDisplay(const char* ecgQualStr) {
  if (!oledReady) return;

  char alertCopy[16];
  portENTER_CRITICAL(&sharedMux);
  strncpy(alertCopy, lastAlertLevel, sizeof(alertCopy) - 1);
  alertCopy[sizeof(alertCopy) - 1] = '\0';
  portEXIT_CRITICAL(&sharedMux);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Line 1: Brand + WiFi + Alert
  display.setCursor(0, 0);
  display.print("AROVA ");
  display.print(WiFi.status() == WL_CONNECTED ? "WiFi " : "NoWF ");
  display.println(alertCopy);

  // Line 2: HR & SpO2 (MAX30100)
  display.setCursor(0, 14);
  if (!max30100Ready) {
    display.println("MAX30100: Init Error");
  } else if (!maxFingerDetected) {
    display.println("HR:--  SpO2:-- (NoFing)");
  } else {
    display.print("HR:");
    display.print((int)roundf(latestHr));
    display.print(" SpO2:");
    display.print((int)roundf(latestSpo2));
    display.println("%");
  }

  // Line 3: Temperature (Configurable)
  display.setCursor(0, 26);
  display.print("Temp: ");
  if (isfinite(latestTempC)) {
    display.print(latestTempC, 1);
    display.println(" C");
  } else {
    display.println("-- (Pending)");
  }

  // Line 4: ECG & Movement
  display.setCursor(0, 38);
  display.print("ECG:");
  display.print(ecgQualStr);
  display.print(" Mov:");
  display.println(latestMovementStatus);

  // Line 5: Sensor Bus Status
  display.setCursor(0, 52);
  display.print("MAX:");
  display.print(max30100Ready ? "OK " : "ERR ");
  display.print("MPU:");
  display.print(mpuReady ? "OK" : "ERR");
  if (possibleFallFlag) {
    display.print(" FALL?");
  }

  display.display();
}

// ----------------------------------------------------------------------------
// 11. CORE 1 HANDOFF & CORE 0 HTTPS/HTTP UPLOAD TASK
// ----------------------------------------------------------------------------
void formatIsoTimestamp(char* outBuf, size_t outSize) {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 0)) {
    ntpSynced = true;
    strftime(outBuf, outSize, "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  } else {
    outBuf[0] = '\0';
  }
}

void queueTelemetryBatchForUpload() {
  int bufToSend = activeEcgBuf;
  int capturedCount = ecgSampleIdx;
  bool leadOff = ecgLeadOffLatched || readEcgLeadOffPins();
  const char* ecgQuality = assessEcgBatchQuality(ecgBuffers[bufToSend], capturedCount, leadOff);

  // Immediately flip ping-pong buffer on Core 1 so 200 Hz sampling loses zero ticks
  activeEcgBuf = 1 - activeEcgBuf;
  ecgSampleIdx = 0;
  ecgLeadOffLatched = false;

  refreshOledDisplay(ecgQuality);

  if (WiFi.status() != WL_CONNECTED) return;

  char tsBuf[32];
  formatIsoTimestamp(tsBuf, sizeof(tsBuf));

  float battPct = 0.0f;
  bool battValid = false;
  if (BATTERY_ADC_ENABLED) {
    float mv = (float)analogReadMilliVolts(BATTERY_ADC_PIN);
    battPct = constrain((mv / 3300.0f) * 100.0f, 0.0f, 100.0f);
    battValid = true;
  }

  portENTER_CRITICAL(&sharedMux);
  uploadSnapshot.maxFingerDetected = maxFingerDetected;
  uploadSnapshot.maxIrSignalOk = maxIrSignalOk;
  uploadSnapshot.heartRate = latestHr;
  uploadSnapshot.spo2 = latestSpo2;
  uploadSnapshot.temperatureC = latestTempC;
  uploadSnapshot.accelMagnitude = latestAccelMagG;
  uploadSnapshot.gyroMagnitude = latestGyroMagDps;
  strncpy(uploadSnapshot.movementStatus, latestMovementStatus, sizeof(uploadSnapshot.movementStatus) - 1);
  uploadSnapshot.movementStatus[sizeof(uploadSnapshot.movementStatus) - 1] = '\0';
  uploadSnapshot.possibleFallDetected = possibleFallFlag;
  uploadSnapshot.oledActive = oledReady;
  uploadSnapshot.batteryValid = battValid;
  uploadSnapshot.batteryPct = battPct;
  uploadSnapshot.ecgCount = capturedCount;
  uploadSnapshot.ecgLeadOff = leadOff;
  strncpy(uploadSnapshot.ecgSignalQuality, ecgQuality, sizeof(uploadSnapshot.ecgSignalQuality) - 1);
  uploadSnapshot.ecgSignalQuality[sizeof(uploadSnapshot.ecgSignalQuality) - 1] = '\0';
  strncpy(uploadSnapshot.ecgTimestamp, tsBuf, sizeof(uploadSnapshot.ecgTimestamp) - 1);
  uploadSnapshot.ecgTimestamp[sizeof(uploadSnapshot.ecgTimestamp) - 1] = '\0';
  if (capturedCount > 0) {
    memcpy(uploadSnapshot.ecgSamples, ecgBuffers[bufToSend], sizeof(float) * capturedCount);
  }
  uploadSnapshot.pending = true;
  portEXIT_CRITICAL(&sharedMux);
}

bool hasValidRootCa() {
  return (ROOT_CA_PEM != nullptr) && (strstr(ROOT_CA_PEM, "PASTE_YOUR_ROOT_CA_PEM_HERE") == nullptr);
}

void networkUploadTask(void* /*pvParams*/) {
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setReuse(true);

  TelemetrySnapshot localSnap;
  String payload;
  payload.reserve(3200);

  for (;;) {
    bool shouldSend = false;
    portENTER_CRITICAL(&sharedMux);
    if (uploadSnapshot.pending) {
      localSnap = uploadSnapshot;
      uploadSnapshot.pending = false;
      shouldSend = true;
    }
    portEXIT_CRITICAL(&sharedMux);

    if (!shouldSend || WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(25));
      continue;
    }

    #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
      JsonDocument doc;
    #else
      DynamicJsonDocument doc(8192);
    #endif

    doc["deviceId"] = DEVICE_ID;
    doc["patientId"] = PATIENT_ID;
    doc["pulseOxVariant"] = "MAX30100";

    const char* tModel = getTempModelName();
    if (tModel != nullptr) {
      doc["tempSensorModel"] = tModel;
    } else {
      doc["tempSensorModel"] = (const char*)nullptr;
    }

    if (localSnap.maxFingerDetected && localSnap.maxIrSignalOk) {
      doc["heartRate"] = roundf(localSnap.heartRate * 10.0f) / 10.0f;
      doc["spo2"] = roundf(localSnap.spo2 * 10.0f) / 10.0f;
    } else {
      doc["heartRate"] = (const char*)nullptr;
      doc["spo2"] = (const char*)nullptr;
    }

    if (isfinite(localSnap.temperatureC)) {
      doc["temperatureC"] = roundf(localSnap.temperatureC * 10.0f) / 10.0f;
    } else {
      doc["temperatureC"] = (const char*)nullptr;
    }

    doc["accelMagnitude"] = roundf(localSnap.accelMagnitude * 100.0f) / 100.0f;
    doc["gyroMagnitude"] = roundf(localSnap.gyroMagnitude * 10.0f) / 10.0f;
    doc["movementStatus"] = localSnap.movementStatus;
    doc["possibleFallDetected"] = localSnap.possibleFallDetected;
    doc["irSignalOk"] = localSnap.maxIrSignalOk;
    doc["fingerDetected"] = localSnap.maxFingerDetected;
    doc["oledActive"] = localSnap.oledActive;

    if (localSnap.batteryValid) {
      doc["batteryPct"] = roundf(localSnap.batteryPct);
    } else {
      doc["batteryPct"] = (const char*)nullptr;
    }

    if (ECG_ENABLED && localSnap.ecgCount > 0) {
      #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
        JsonArray ecgArr = doc["ecgSamples"].to<JsonArray>();
      #else
        JsonArray ecgArr = doc.createNestedArray("ecgSamples");
      #endif
      for (int i = 0; i < localSnap.ecgCount; i++) {
        ecgArr.add(roundf(localSnap.ecgSamples[i] * 100.0f) / 100.0f);
      }
      doc["ecgSamplingRate"] = ECG_SAMPLING_RATE_HZ;
      doc["ecgSignalQuality"] = localSnap.ecgSignalQuality;
      doc["ecgLeadOff"] = localSnap.ecgLeadOff;
      if (localSnap.ecgTimestamp[0] != '\0') {
        doc["ecgTimestamp"] = localSnap.ecgTimestamp;
      }
    } else {
      doc["ecgSignalQuality"] = "unavailable";
      doc["ecgLeadOff"] = localSnap.ecgLeadOff;
    }

    if (doc.overflowed()) {
      Serial.println("[AROVA] JSON document overflowed — increase capacity.");
      continue;
    }

    payload = "";
    serializeJson(doc, payload);

    bool began = false;
    if (strncmp(INGEST_ENDPOINT, "https://", 8) == 0) {
      if (hasValidRootCa()) {
        secureClient.setCACert(ROOT_CA_PEM);
        began = http.begin(secureClient, INGEST_ENDPOINT);
      } else if (ALLOW_INSECURE_TLS_DEV) {
        secureClient.setInsecure();
        began = http.begin(secureClient, INGEST_ENDPOINT);
      } else {
        Serial.println("[AROVA] HTTPS blocked: configure ROOT_CA_PEM for TLS verification.");
        vTaskDelay(pdMS_TO_TICKS(1000));
        continue;
      }
    } else {
      began = http.begin(plainClient, INGEST_ENDPOINT);
    }

    if (!began) continue;
    http.setTimeout(5000);
    http.addHeader("Content-Type", "application/json");
    if (strlen(DEVICE_KEY) > 0 && strcmp(DEVICE_KEY, "YOUR_WEARABLE_INGEST_TOKEN") != 0) {
      http.addHeader("X-Device-Key", DEVICE_KEY);
    }

    int statusCode = http.POST(payload);
    if (statusCode == 200) {
      String resp = http.getString();
      #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
        JsonDocument resDoc;
      #else
        StaticJsonDocument<512> resDoc;
      #endif
      if (!deserializeJson(resDoc, resp)) {
        const char* lvl = resDoc["alertLevel"] | "Normal";
        const char* haptic = resDoc["hapticPattern"] | "none";
        portENTER_CRITICAL(&sharedMux);
        strncpy(lastAlertLevel, lvl, sizeof(lastAlertLevel) - 1);
        lastAlertLevel[sizeof(lastAlertLevel) - 1] = '\0';
        if (strcmp(haptic, "none") != 0) {
          strncpy(pendingHapticPattern, haptic, sizeof(pendingHapticPattern) - 1);
          pendingHapticPattern[sizeof(pendingHapticPattern) - 1] = '\0';
          hasPendingHaptic = true;
        }
        portEXIT_CRITICAL(&sharedMux);
      }
    } else {
      Serial.printf("[AROVA] HTTP ingest returned %d\n", statusCode);
    }
    http.end();
  }
}

// ----------------------------------------------------------------------------
// 12. ARDUINO SETUP & NON-BLOCKING CORE 1 LOOP
// ----------------------------------------------------------------------------
void configureI2CBus() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  #if TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    Wire.setClock(100000);  // MLX90614 SMBus max speed is 100 kHz
  #else
    Wire.setClock(400000);  // Fast Mode (400 kHz) keeps SSD1306 + MAX30100 non-stalling
  #endif
}

void setup() {
  Serial.begin(115200);
  initVibrationPwm();
  configureI2CBus();

  // ADC1 setup for AD8232 ECG
  if (ECG_ENABLED) {
    analogReadResolution(12);
    analogSetPinAttenuation(ECG_OUTPUT_PIN, ADC_11db);
    if (ECG_LEAD_OFF_ENABLED) {
      pinMode(ECG_LO_PLUS_PIN, INPUT);
      pinMode(ECG_LO_MINUS_PIN, INPUT);
    }
  }

  // SSD1306 OLED (0x3C)
  oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR);
  if (oledReady) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("AROVA Boot...");
    display.display();
  }

  // MPU6050 IMU (0x68)
  mpuReady = mpu.begin();
  if (mpuReady) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }

  // Confirmed MAX30100 Pulse Oximeter (OXullo library ONLY)
  // Note: OXullo begin() calls Wire.begin() & Wire.setClock(400000) internally,
  // so configureI2CBus() is re-applied immediately afterward.
  max30100Ready = pox.begin();
  configureI2CBus();
  if (max30100Ready) {
    pox.setIRLedCurrent(MAX30100_LED_CURR_7_6MA);
    pox.setOnBeatDetectedCallback(onMax30100BeatDetected);
  } else {
    Serial.println("[AROVA] MAX30100 init failed — check 3.3V I2C pull-ups!");
  }

  // Optional Configurable Temperature Sensor
  initTemperatureSensor();

  // Wi-Fi station mode + SNTP time sync (for TLS X.509 certificate expiry checks)
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  // Launch Core 0 HTTPS upload task so Core 1 sensor loop never blocks
  uploadSnapshot.pending = false;
  xTaskCreatePinnedToCore(
    networkUploadTask,
    "ArovaNet",
    10240,
    nullptr,
    1,
    nullptr,
    0
  );
}

void loop() {
  unsigned long nowMs = millis();
  unsigned long nowUs = micros();

  // 1. Keep MAX30100 FIFO drained continuously on Core 1
  if (max30100Ready) {
    pox.update();
  }

  // 2. Sample AD8232 ECG at 200 Hz into active ping-pong buffer
  pollEcgBatch(nowUs);

  // 3. Advance non-blocking vibration motor state machine
  updateHapticMotor(nowMs);

  // 4. Non-blocking Wi-Fi reconnect
  if (WiFi.status() != WL_CONNECTED && (nowMs - lastWifiCheckMs >= WIFI_RETRY_MS)) {
    lastWifiCheckMs = nowMs;
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  // 5. Refresh OLED at 2 Hz
  if (nowMs - lastOledMs >= OLED_REFRESH_MS) {
    lastOledMs = nowMs;
    updateMax30100Readings(nowMs);
    readMpu6050Sample(nowMs);
    readTemperatureSensor();
    const char* ecgQ = assessEcgBatchQuality(
      ecgBuffers[activeEcgBuf],
      ecgSampleIdx,
      ecgLeadOffLatched || readEcgLeadOffPins()
    );
    refreshOledDisplay(ecgQ);
  }

  // 6. Flip ping-pong ECG batch & hand off snapshot to Core 0 every 1250 ms
  if (nowMs - lastUploadMs >= TELEMETRY_UPLOAD_MS) {
    lastUploadMs = nowMs;
    updateMax30100Readings(nowMs);
    readMpu6050Sample(nowMs);
    readTemperatureSensor();
    queueTelemetryBatchForUpload();
  }
}
