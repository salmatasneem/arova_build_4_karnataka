/*
 * ============================================================================
 * AROVA – Wearable-Based Early Warning System
 * Complete ESP32 DevKit Wearable Firmware (Phase 3 IoT Integration)
 * ============================================================================
 *
 * HARDWARE STACK:
 *   1. ESP32 DevKit (3.3V logic, dual-core Wi-Fi MCU)
 *   2. MAX30102 Pulse Oximeter (default) OR MAX30100 (selectable via PULSEOX_MODEL)
 *   3. MPU6050 6-Axis Accelerometer & Gyroscope (I2C 0x68) -> accel_x/y/z + gyro_x/y/z
 *   4. Temperature Sensor (DS18B20 / TMP117 / MLX90614 / NONE configurable)
 *   5. 0.96-inch SSD1306 I2C OLED Display (128x64, I2C 0x3C) -> AROVA UI
 *   6. Vibration Motor via NPN/MOSFET driver + flyback diode (GPIO 25)
 *   7. AD8232 Single-Lead ECG (Provisional, ADC1 GPIO 34 + LO+ 32 + LO- 33)
 *   8. Li-ion / LiPo Battery + TP4056 / Protection + 3.3V LDO/Buck + ADC divider
 *
 * PROPOSED ESP32 DEVKIT PINOUT (Confirm on physical PCB/breakout before soldering):
 *   - Shared I2C Bus (SDA = GPIO 21, SCL = GPIO 22):
 *       * SSD1306 OLED : 0x3C
 *       * MAX30102 / MAX30100 : 0x57
 *       * MPU6050      : 0x68 (AD0 = GND)
 *       * Optional TMP117 (0x48) or MLX90614 (0x5A, forces 100 kHz I2C)
 *   - DS18B20 1-Wire Temperature -> GPIO 4 (with 4.7k external pull-up to 3.3V)
 *   - Vibration Motor Driver Gate/Base -> GPIO 25 (1k series resistor + flyback diode)
 *   - AD8232 ECG (ADC1 only, Wi-Fi safe) -> OUT GPIO 34, LO+ GPIO 32, LO- GPIO 33
 *   - Optional Battery Voltage Divider (ADC1) -> GPIO 35
 *
 * ARDUINO LIBRARIES:
 *   - Board Core: esp32 by Espressif Systems (v2.0.x or v3.x)
 *   - MAX30102 (default): "SparkFun MAX3010x Pulse and Proximity Sensor Library"
 *     (<MAX30105.h>, <heartRate.h>, <spo2_algorithm.h>)
 *   - OR MAX30100: "MAX30100lib" by OXullo Intersecans (<MAX30100_PulseOximeter.h>)
 *   - "Adafruit MPU6050" + "Adafruit Unified Sensor"
 *   - "Adafruit SSD1306" + "Adafruit GFX Library"
 *   - "ArduinoJson" by Benoit Blanchon (v6.x or v7.x)
 *   - Optional Temp: "OneWire" + "DallasTemperature", "Adafruit TMP117", or "Adafruit MLX90614"
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

// Load private secrets from arova_secrets.h if present; otherwise use placeholders below
#if __has_include("arova_secrets.h")
  #include "arova_secrets.h"
#endif

// ----------------------------------------------------------------------------
// 1. SELECTABLE PULSE OXIMETER & TEMPERATURE HARDWARE DRIVERS
// ----------------------------------------------------------------------------
#define PULSEOX_MAX30102      1
#define PULSEOX_MAX30100      2
#define PULSEOX_MODEL         PULSEOX_MAX30102

#define TEMP_SENSOR_NONE      0
#define TEMP_SENSOR_DS18B20   1
#define TEMP_SENSOR_TMP117    2
#define TEMP_SENSOR_MLX90614  3
#define TEMP_SENSOR_MODEL     TEMP_SENSOR_DS18B20

#if PULSEOX_MODEL == PULSEOX_MAX30102
  #include <MAX30105.h>
  #include <heartRate.h>
  #include <spo2_algorithm.h>
  MAX30105 particleSensor;
#else
  #include <MAX30100_PulseOximeter.h>
  PulseOximeter pox;
#endif

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

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
// 2. PINOUT & SAMPLING INTERVALS
// ----------------------------------------------------------------------------
#define I2C_SDA_PIN               21
#define I2C_SCL_PIN               22

// Provisional AD8232 Single-Lead ECG (ADC1 only)
#define ECG_ENABLED               false
#define ECG_LEAD_OFF_ENABLED      true
#define ECG_OUTPUT_PIN            34
#define ECG_LO_PLUS_PIN           32
#define ECG_LO_MINUS_PIN          33
#define ECG_SAMPLING_RATE_HZ      200
#define ECG_BATCH_SIZE            250

// Vibration Motor Driver (Transistor / Logic-Level MOSFET + flyback diode)
#define VIBRATION_PIN             25
#define VIBRATION_PWM_CHANNEL     0
#define VIBRATION_PWM_FREQ        2000
#define VIBRATION_PWM_RES         8
#define VIBRATION_DUTY            215

// Battery Voltage Divider (2x 100k resistors -> Vbat / 2 on ADC1 GPIO 35)
#define BATTERY_ADC_ENABLED       false
#define BATTERY_ADC_PIN           35
#define BATTERY_DIVIDER_RATIO     2.0f

// SSD1306 OLED (0.96" 128x64 I2C)
#define OLED_WIDTH                128
#define OLED_HEIGHT               64
#define OLED_I2C_ADDR             0x3C

// Sampling & Upload Timers
#define IMU_SAMPLE_MS             100
#define TEMP_SAMPLE_MS            2000
#define OLED_REFRESH_MS           500
#define TELEMETRY_UPLOAD_MS       2000
#define WIFI_RETRY_BASE_MS        5000
#define WIFI_RETRY_MAX_MS         30000
#define MAX_SPO2_BUFFER_LEN       100
#define RETRY_QUEUE_CAP           6

// ----------------------------------------------------------------------------
// 3. NETWORK & AUTHENTICATION CONFIGURATION
// ----------------------------------------------------------------------------
#ifndef SECRET_WIFI_SSID
  #define SECRET_WIFI_SSID       "YOUR_24GHZ_WIFI_SSID"
#endif
#ifndef SECRET_WIFI_PASSWORD
  #define SECRET_WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"
#endif
#ifndef SECRET_INGEST_ENDPOINT
  #define SECRET_INGEST_ENDPOINT "https://YOUR_AROVA_DOMAIN/api/wearable/ingest"
#endif
#ifndef SECRET_DEVICE_ID
  #define SECRET_DEVICE_ID       "esp32-arova-01"
#endif
#ifndef SECRET_PATIENT_ID
  #define SECRET_PATIENT_ID      "YOUR_PATIENT_ID"
#endif
#ifndef SECRET_DEVICE_KEY
  #define SECRET_DEVICE_KEY      "YOUR_X_DEVICE_KEY"
#endif
#ifndef SECRET_ROOT_CA_PEM
  #define SECRET_ROOT_CA_PEM \
    "-----BEGIN CERTIFICATE-----\n" \
    "PASTE_YOUR_ROOT_CA_PEM_HERE\n" \
    "-----END CERTIFICATE-----\n"
#endif

const char* WIFI_SSID        = SECRET_WIFI_SSID;
const char* WIFI_PASSWORD    = SECRET_WIFI_PASSWORD;
const char* INGEST_ENDPOINT  = SECRET_INGEST_ENDPOINT;
const char* DEVICE_ID        = SECRET_DEVICE_ID;
const char* PATIENT_ID       = SECRET_PATIENT_ID;
const char* DEVICE_KEY       = SECRET_DEVICE_KEY;
const char* FIRMWARE_VERSION = "arova-esp32-v3.0";

// Keep false in production so HTTPS certificates are strictly verified
#define ALLOW_INSECURE_TLS_DEV false
const char* ROOT_CA_PEM = SECRET_ROOT_CA_PEM;

// ----------------------------------------------------------------------------
// 4. SENSOR INSTANCES & SHARED TELEMETRY STATE
// ----------------------------------------------------------------------------
Adafruit_MPU6050 mpu;
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

bool pulseOxReady = false;
bool mpuReady = false;
bool oledReady = false;
bool tempSensorReady = false;
bool ntpSynced = false;
bool backendHealthy = false;
int lastHttpCode = 0;

// Optical Sensor State (MAX30102 / MAX30100)
float latestHr = NAN;
float latestSpo2 = NAN;
bool fingerDetected = false;
bool irSignalOk = false;
uint32_t latestIrRaw = 0;

#if PULSEOX_MODEL == PULSEOX_MAX30102
  uint32_t irBuffer[MAX_SPO2_BUFFER_LEN];
  uint32_t redBuffer[MAX_SPO2_BUFFER_LEN];
  int max30102Idx = 0;
  const byte RATE_SIZE = 4;
  byte rates[RATE_SIZE];
  byte rateSpot = 0;
  long lastBeatTimeMs = 0;
  float beatsPerMinute = 0.0f;
  int beatAvg = 0;
#else
  volatile unsigned long max100LastBeatMs = 0;
  void onMax100Beat() { max100LastBeatMs = millis(); }
#endif

// MPU6050 State
float latestAccelX = 0.0f;
float latestAccelY = 0.0f;
float latestAccelZ = 1.0f;
float latestAccelMagG = 1.0f;
float latestGyroX = 0.0f;
float latestGyroY = 0.0f;
float latestGyroZ = 0.0f;
float latestGyroMagDps = 0.0f;
const char* latestMovementStatus = "resting";
bool possibleFallFlag = false;
unsigned long highImpactMs = 0;

// Temperature State
float latestTempC = NAN;

// Battery State
bool batteryValid = false;
float latestBatteryPct = 100.0f;

// Provisional ECG Buffers
float ecgBuffers[2][ECG_BATCH_SIZE];
int activeEcgBuf = 0;
int ecgSampleIdx = 0;
unsigned long lastEcgSampleUs = 0;
const unsigned long ecgSamplePeriodUs = 1000000UL / ECG_SAMPLING_RATE_HZ;
bool ecgLeadOffLatched = false;

// Retry Queue on Core 0
struct QueuedPacket {
  bool used;
  String jsonPayload;
};
QueuedPacket retryQueue[RETRY_QUEUE_CAP];
portMUX_TYPE sharedMux = portMUX_INITIALIZER_UNLOCKED;

// Haptic Motor Non-Blocking State Machine
enum HapticMode { HAPTIC_IDLE, HAPTIC_CONTINUOUS, HAPTIC_SINGLE, HAPTIC_TRIPLE };
HapticMode hapticMode = HAPTIC_IDLE;
int hapticStep = 0;
unsigned long hapticStepStartMs = 0;
unsigned long hapticTargetDurationMs = 250;
bool hapticMotorOn = false;

struct PendingCommandState {
  bool pending;
  bool deactivate;
  char pattern[24];
  unsigned long durationMs;
};
PendingCommandState pendingCmd = {false, false, "none", 0};
char lastAlertLevel[16] = "Normal";

unsigned long lastImuMs = 0;
unsigned long lastTempMs = 0;
unsigned long lastOledMs = 0;
unsigned long lastUploadMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long wifiBackoffMs = WIFI_RETRY_BASE_MS;

// ----------------------------------------------------------------------------
// 5. VIBRATION MOTOR DRIVER (TRANSISTOR/MOSFET + NON-BLOCKING PWM)
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

void stopHapticMotor() {
  setVibrationOutput(false);
  hapticMode = HAPTIC_IDLE;
  hapticStep = 0;
}

void startHapticCommand(bool deactivate, const char* pattern, unsigned long durationMs) {
  if (deactivate || !pattern || strcmp(pattern, "none") == 0) {
    stopHapticMotor();
    return;
  }
  unsigned long safeDur = (durationMs >= 100 && durationMs <= 5000) ? durationMs : 250;
  if (strcmp(pattern, "triple_alert") == 0 || strcmp(pattern, "triple_urgent") == 0) {
    hapticMode = HAPTIC_TRIPLE;
    hapticStep = 0;
    hapticStepStartMs = millis();
    setVibrationOutput(true);
  } else if (safeDur > 450 && strcmp(pattern, "single_pulse") == 0) {
    hapticMode = HAPTIC_CONTINUOUS;
    hapticTargetDurationMs = safeDur;
    hapticStepStartMs = millis();
    setVibrationOutput(true);
  } else {
    hapticMode = HAPTIC_SINGLE;
    hapticTargetDurationMs = safeDur;
    hapticStepStartMs = millis();
    setVibrationOutput(true);
  }
}

void updateHapticMotor(unsigned long nowMs) {
  PendingCommandState cmdCopy = {false, false, "none", 0};
  portENTER_CRITICAL(&sharedMux);
  if (pendingCmd.pending) {
    cmdCopy = pendingCmd;
    pendingCmd.pending = false;
  }
  portEXIT_CRITICAL(&sharedMux);

  if (cmdCopy.pending) {
    startHapticCommand(cmdCopy.deactivate, cmdCopy.pattern, cmdCopy.durationMs);
  }

  if (hapticMode == HAPTIC_IDLE) return;
  unsigned long elapsed = nowMs - hapticStepStartMs;

  if (hapticMode == HAPTIC_SINGLE || hapticMode == HAPTIC_CONTINUOUS) {
    if (elapsed >= hapticTargetDurationMs) {
      stopHapticMotor();
    }
    return;
  }

  if (hapticMode == HAPTIC_TRIPLE) {
    bool shouldBeOn = (hapticStep % 2 == 0);
    unsigned long phaseMs = shouldBeOn ? 220UL : 140UL;
    if (elapsed >= phaseMs) {
      hapticStep++;
      hapticStepStartMs = nowMs;
      if (hapticStep >= 6) {
        stopHapticMotor();
      } else {
        setVibrationOutput(hapticStep % 2 == 0);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 6. PULSE OXIMETER INITIALIZATION & SIGNAL QUALITY VALIDATION
// ----------------------------------------------------------------------------
const char* getPulseOxChipName() {
  #if PULSEOX_MODEL == PULSEOX_MAX30102
    return "MAX30102";
  #else
    return "MAX30100";
  #endif
}

void initPulseOximeter() {
  #if PULSEOX_MODEL == PULSEOX_MAX30102
    pulseOxReady = particleSensor.begin(Wire, I2C_SPEED_FAST);
    if (pulseOxReady) {
      byte ledBrightness = 60;
      byte sampleAverage = 4;
      byte ledMode = 2; // Red + IR for SpO2
      int sampleRate = 100;
      int pulseWidth = 411;
      int adcRange = 4096;
      particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
      particleSensor.setPulseAmplitudeRed(0x24);
      particleSensor.setPulseAmplitudeGreen(0);
    } else {
      Serial.println("[AROVA] MAX30102 init failed (check I2C 0x57 wiring).");
    }
  #else
    pulseOxReady = pox.begin();
    Wire.setClock(400000);
    if (pulseOxReady) {
      pox.setIRLedCurrent(MAX30100_LED_CURR_7_6MA);
      pox.setOnBeatDetectedCallback(onMax100Beat);
    } else {
      Serial.println("[AROVA] MAX30100 init failed (check 3.3V pull-ups on I2C 0x57).");
    }
  #endif
}

void pollPulseOximeter(unsigned long nowMs) {
  if (!pulseOxReady) {
    fingerDetected = false;
    irSignalOk = false;
    latestHr = NAN;
    latestSpo2 = NAN;
    return;
  }

  #if PULSEOX_MODEL == PULSEOX_MAX30102
    particleSensor.check();
    while (particleSensor.available()) {
      uint32_t redVal = particleSensor.getFIFOUnclippedRed();
      uint32_t irVal = particleSensor.getFIFOUnclippedIR();
      latestIrRaw = irVal;
      particleSensor.nextSample();

      // Finger threshold validation (no-finger IR values typically < 50,000)
      if (irVal < 50000UL) {
        fingerDetected = false;
        irSignalOk = false;
        latestHr = NAN;
        latestSpo2 = NAN;
        max30102Idx = 0;
        beatAvg = 0;
        continue;
      }

      fingerDetected = true;
      irSignalOk = true;

      if (checkForBeat((long)irVal)) {
        long delta = (long)(nowMs - lastBeatTimeMs);
        lastBeatTimeMs = (long)nowMs;
        if (delta > 250 && delta < 2000) {
          beatsPerMinute = 60.0f / (delta / 1000.0f);
          if (beatsPerMinute >= 30.0f && beatsPerMinute <= 230.0f) {
            rates[rateSpot++] = (byte)roundf(beatsPerMinute);
            rateSpot %= RATE_SIZE;
            int total = 0;
            int count = 0;
            for (byte i = 0; i < RATE_SIZE; i++) {
              if (rates[i] >= 30) {
                total += rates[i];
                count++;
              }
            }
            if (count > 0) {
              beatAvg = total / count;
              latestHr = (float)beatAvg;
            }
          }
        }
      }

      redBuffer[max30102Idx] = redVal;
      irBuffer[max30102Idx] = irVal;
      max30102Idx++;

      if (max30102Idx >= MAX_SPO2_BUFFER_LEN) {
        int32_t spo2Calc = 0;
        int8_t spo2ValidFlag = 0;
        int32_t hrCalc = 0;
        int8_t hrValidFlag = 0;
        maxim_heart_rate_and_oxygen_saturation(
          irBuffer, MAX_SPO2_BUFFER_LEN, redBuffer,
          &spo2Calc, &spo2ValidFlag, &hrCalc, &hrValidFlag
        );
        if (spo2ValidFlag == 1 && spo2Calc >= 50 && spo2Calc <= 100) {
          latestSpo2 = (float)spo2Calc;
        }
        if (hrValidFlag == 1 && hrCalc >= 30 && hrCalc <= 230 && !isfinite(latestHr)) {
          latestHr = (float)hrCalc;
        }
        // Shift window by 25 samples for continuous updates
        for (int i = 25; i < MAX_SPO2_BUFFER_LEN; i++) {
          redBuffer[i - 25] = redBuffer[i];
          irBuffer[i - 25] = irBuffer[i];
        }
        max30102Idx = 75;
      }
    }
  #else
    pox.update();
    float hr = pox.getHeartRate();
    uint8_t spo2Raw = pox.getSpO2();
    bool beatRecent = (max100LastBeatMs > 0) && ((nowMs - max100LastBeatMs) <= 4500UL);
    bool hrValid = isfinite(hr) && hr >= 30.0f && hr <= 240.0f;
    bool spo2Valid = spo2Raw >= 50 && spo2Raw <= 100;
    if (beatRecent && hrValid && spo2Valid) {
      latestHr = hr;
      latestSpo2 = (float)spo2Raw;
      fingerDetected = true;
      irSignalOk = true;
    } else {
      latestHr = NAN;
      latestSpo2 = NAN;
      fingerDetected = false;
      irSignalOk = false;
    }
  #endif
}

const char* evaluateSensorQuality() {
  if (!pulseOxReady && !mpuReady) return "unavailable";
  if (!fingerDetected || !irSignalOk) return "poor_contact";
  if (!isfinite(latestHr) || !isfinite(latestSpo2)) return "noisy";
  return "good";
}

// ----------------------------------------------------------------------------
// 7. MPU6050 TRIAXIAL ACCELEROMETER & GYROSCOPE READER
// ----------------------------------------------------------------------------
void readMpu6050Sample(unsigned long nowMs) {
  if (!mpuReady) {
    latestAccelX = 0.0f;
    latestAccelY = 0.0f;
    latestAccelZ = 1.0f;
    latestAccelMagG = 1.0f;
    latestGyroX = 0.0f;
    latestGyroY = 0.0f;
    latestGyroZ = 0.0f;
    latestGyroMagDps = 0.0f;
    latestMovementStatus = "resting";
    possibleFallFlag = false;
    return;
  }

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  latestAccelX = a.acceleration.x / 9.80665f;
  latestAccelY = a.acceleration.y / 9.80665f;
  latestAccelZ = a.acceleration.z / 9.80665f;
  latestAccelMagG = sqrtf(
    latestAccelX * latestAccelX +
    latestAccelY * latestAccelY +
    latestAccelZ * latestAccelZ
  );

  latestGyroX = g.gyro.x * 57.29578f;
  latestGyroY = g.gyro.y * 57.29578f;
  latestGyroZ = g.gyro.z * 57.29578f;
  latestGyroMagDps = sqrtf(
    latestGyroX * latestGyroX +
    latestGyroY * latestGyroY +
    latestGyroZ * latestGyroZ
  );

  // Experimental impact threshold indicator (not a clinical fall detector)
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
// 8. TEMPERATURE SENSOR & BATTERY READERS (REJECTS INVALID SENTINELS)
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
    // Reject DS18B20 error sentinels (-127 C disconnected, +85 C power-on reset)
    latestTempC = (isfinite(c) && c >= 20.0f && c <= 45.0f) ? c : NAN;
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_TMP117
    if (!tempSensorReady) { latestTempC = NAN; return; }
    sensors_event_t t;
    tmp117.getEvent(&t);
    latestTempC = (isfinite(t.temperature) && t.temperature >= 20.0f && t.temperature <= 45.0f)
      ? t.temperature
      : NAN;
  #elif TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    if (!tempSensorReady) { latestTempC = NAN; return; }
    float c = mlx90614.readObjectTempC();
    latestTempC = (isfinite(c) && c >= 20.0f && c <= 45.0f) ? c : NAN;
  #else
    latestTempC = NAN;
  #endif
}

void readBatteryLevel() {
  if (!BATTERY_ADC_ENABLED) {
    batteryValid = false;
    return;
  }
  float mv = (float)analogReadMilliVolts(BATTERY_ADC_PIN) * BATTERY_DIVIDER_RATIO;
  // Map Li-ion 3.30V (0%) .. 4.20V (100%)
  float pct = ((mv - 3300.0f) / 900.0f) * 100.0f;
  latestBatteryPct = constrain(pct, 0.0f, 100.0f);
  batteryValid = true;
}

// ----------------------------------------------------------------------------
// 9. OPTIONAL PROVISIONAL AD8232 ECG ACQUISITION
// ----------------------------------------------------------------------------
bool readEcgLeadOffPins() {
  if (!ECG_ENABLED || !ECG_LEAD_OFF_ENABLED) return false;
  return (digitalRead(ECG_LO_PLUS_PIN) == HIGH) || (digitalRead(ECG_LO_MINUS_PIN) == HIGH);
}

void pollEcgBatch(unsigned long nowUs) {
  if (!ECG_ENABLED) return;
  if ((unsigned long)(nowUs - lastEcgSampleUs) < ecgSamplePeriodUs) return;
  lastEcgSampleUs += ecgSamplePeriodUs;
  if ((unsigned long)(nowUs - lastEcgSampleUs) >= (ecgSamplePeriodUs * 4)) {
    lastEcgSampleUs = nowUs;
  }
  bool leadOffNow = readEcgLeadOffPins();
  if (leadOffNow) ecgLeadOffLatched = true;
  if (ecgSampleIdx < ECG_BATCH_SIZE) {
    if (leadOffNow) {
      ecgBuffers[activeEcgBuf][ecgSampleIdx++] = 0.0f;
    } else {
      float mv = (float)analogReadMilliVolts(ECG_OUTPUT_PIN);
      ecgBuffers[activeEcgBuf][ecgSampleIdx++] = mv - 1650.0f;
    }
  }
}

// ----------------------------------------------------------------------------
// 10. SSD1306 OLED RENDERER (AROVA BRANDING + VITAL TELEMETRY)
// ----------------------------------------------------------------------------
void refreshOledDisplay() {
  if (!oledReady) return;

  char alertCopy[16];
  portENTER_CRITICAL(&sharedMux);
  strncpy(alertCopy, lastAlertLevel, sizeof(alertCopy) - 1);
  alertCopy[sizeof(alertCopy) - 1] = '\0';
  portEXIT_CRITICAL(&sharedMux);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Header Row: AROVA + Wi-Fi Link + Alert State
  display.setCursor(0, 0);
  display.print("AROVA ");
  if (WiFi.status() == WL_CONNECTED) {
    display.print(backendHealthy ? "LIVE " : "WF:OK ");
  } else {
    display.print("NoWF ");
  }
  display.println(alertCopy);

  // Row 2: Heart Rate & SpO2
  display.setCursor(0, 14);
  if (!pulseOxReady) {
    display.println("PulseOx: ERR (0x57)");
  } else if (!fingerDetected || !irSignalOk) {
    display.println("HR:--  SpO2:-- NoFing");
  } else {
    display.print("HR:");
    if (isfinite(latestHr)) display.print((int)roundf(latestHr));
    else display.print("--");
    display.print("  SpO2:");
    if (isfinite(latestSpo2)) {
      display.print((int)roundf(latestSpo2));
      display.println("%");
    } else {
      display.println("--%");
    }
  }

  // Row 3: Skin Temperature
  display.setCursor(0, 26);
  display.print("Temp: ");
  if (isfinite(latestTempC)) {
    display.print(latestTempC, 1);
    display.println(" C");
  } else {
    display.println("-- (N/A)");
  }

  // Row 4: Movement & Monitoring State
  display.setCursor(0, 38);
  display.print("Act:");
  display.print(latestMovementStatus);
  display.print(" ");
  display.println(hapticMotorOn ? "[VIB]" : (WiFi.status() == WL_CONNECTED ? "[MON]" : "[OFF]"));

  // Row 5: Sensor Health & Battery
  display.setCursor(0, 52);
  display.print("OX:");
  display.print(pulseOxReady ? "1 " : "0 ");
  display.print("IMU:");
  display.print(mpuReady ? "1 " : "0 ");
  display.print("T:");
  display.print(tempSensorReady ? "1" : "0");
  if (batteryValid) {
    display.print(" B:");
    display.print((int)roundf(latestBatteryPct));
    display.print("%");
  }

  display.display();
}

// ----------------------------------------------------------------------------
// 11. NON-BLOCKING WIFI + RETRY RING QUEUE + HTTPS UPLOAD TASK (CORE 0)
// ----------------------------------------------------------------------------
void formatIsoTimestamp(char* outBuf, size_t outSize) {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 0) && timeinfo.tm_year > (2020 - 1900)) {
    ntpSynced = true;
    strftime(outBuf, outSize, "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  } else {
    // Fallback monotonic tag when NTP is not yet synced
    snprintf(outBuf, outSize, "1970-01-01T00:00:%02luZ", (millis() / 1000UL) % 60UL);
  }
}

void enqueuePayloadJson(const String& json) {
  portENTER_CRITICAL(&sharedMux);
  for (int i = 0; i < RETRY_QUEUE_CAP; i++) {
    if (!retryQueue[i].used) {
      retryQueue[i].used = true;
      retryQueue[i].jsonPayload = json;
      portEXIT_CRITICAL(&sharedMux);
      return;
    }
  }
  // Ring overwrite oldest slot (index 0) when queue is full offline
  for (int i = 1; i < RETRY_QUEUE_CAP; i++) {
    retryQueue[i - 1] = retryQueue[i];
  }
  retryQueue[RETRY_QUEUE_CAP - 1].used = true;
  retryQueue[RETRY_QUEUE_CAP - 1].jsonPayload = json;
  portEXIT_CRITICAL(&sharedMux);
}

void buildAndEnqueueTelemetryPacket() {
  int bufToSend = activeEcgBuf;
  int capturedCount = ecgSampleIdx;
  bool leadOff = ecgLeadOffLatched || readEcgLeadOffPins();
  activeEcgBuf = 1 - activeEcgBuf;
  ecgSampleIdx = 0;
  ecgLeadOffLatched = false;

  char tsBuf[32];
  formatIsoTimestamp(tsBuf, sizeof(tsBuf));

  #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
  #else
    DynamicJsonDocument doc(6144);
  #endif

  // Phase 3 standardized snake_case contract + full hardware diagnostics
  doc["device_id"] = DEVICE_ID;
  doc["patient_id"] = PATIENT_ID;
  doc["timestamp"] = tsBuf;
  doc["source"] = "real";
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["pulseOxVariant"] = getPulseOxChipName();

  const char* tModel = getTempModelName();
  doc["tempSensorModel"] = tModel ? tModel : "NONE";

  bool hrSpo2Valid = fingerDetected && irSignalOk && isfinite(latestHr) && isfinite(latestSpo2);
  if (hrSpo2Valid) {
    doc["heart_rate_bpm"] = roundf(latestHr * 10.0f) / 10.0f;
    doc["spo2_percent"] = roundf(latestSpo2 * 10.0f) / 10.0f;
  } else {
    doc["heart_rate_bpm"] = (const char*)nullptr;
    doc["spo2_percent"] = (const char*)nullptr;
  }

  if (isfinite(latestTempC)) {
    doc["temperature_c"] = roundf(latestTempC * 10.0f) / 10.0f;
  } else {
    doc["temperature_c"] = (const char*)nullptr;
  }

  doc["accel_x"] = roundf(latestAccelX * 1000.0f) / 1000.0f;
  doc["accel_y"] = roundf(latestAccelY * 1000.0f) / 1000.0f;
  doc["accel_z"] = roundf(latestAccelZ * 1000.0f) / 1000.0f;
  doc["gyro_x"] = roundf(latestGyroX * 10.0f) / 10.0f;
  doc["gyro_y"] = roundf(latestGyroY * 10.0f) / 10.0f;
  doc["gyro_z"] = roundf(latestGyroZ * 10.0f) / 10.0f;
  doc["accelMagnitude"] = roundf(latestAccelMagG * 100.0f) / 100.0f;
  doc["gyroMagnitude"] = roundf(latestGyroMagDps * 10.0f) / 10.0f;
  doc["movementStatus"] = latestMovementStatus;
  doc["possibleFallDetected"] = possibleFallFlag;
  doc["sensor_quality"] = evaluateSensorQuality();
  doc["fingerDetected"] = fingerDetected;
  doc["irSignalOk"] = irSignalOk;
  doc["oledActive"] = oledReady;

  if (batteryValid) {
    doc["batteryPct"] = roundf(latestBatteryPct);
  } else {
    doc["batteryPct"] = (const char*)nullptr;
  }

  #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
    JsonObject avail = doc["sensorAvailability"].to<JsonObject>();
  #else
    JsonObject avail = doc.createNestedObject("sensorAvailability");
  #endif
  avail["pulseOximeter"] = pulseOxReady && fingerDetected && irSignalOk;
  avail["temperature"] = tempSensorReady && isfinite(latestTempC);
  avail["imu"] = mpuReady;
  avail["ecg"] = ECG_ENABLED && !leadOff && capturedCount > 0;
  avail["oled"] = oledReady;
  avail["vibrationMotor"] = true;

  if (ECG_ENABLED && capturedCount > 0) {
    #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
      JsonArray ecgArr = doc["ecgSamples"].to<JsonArray>();
    #else
      JsonArray ecgArr = doc.createNestedArray("ecgSamples");
    #endif
    for (int i = 0; i < capturedCount; i++) {
      ecgArr.add(roundf(ecgBuffers[bufToSend][i] * 100.0f) / 100.0f);
    }
    doc["ecgSamplingRate"] = ECG_SAMPLING_RATE_HZ;
    doc["ecgLeadOff"] = leadOff;
    doc["ecgSignalQuality"] = leadOff ? "lead_off" : "good";
  }

  String out;
  serializeJson(doc, out);
  enqueuePayloadJson(out);
}

bool hasValidRootCa() {
  return (ROOT_CA_PEM != nullptr) && (strstr(ROOT_CA_PEM, "PASTE_YOUR_ROOT_CA_PEM_HERE") == nullptr);
}

void networkUploadTask(void* /*pvParams*/) {
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setReuse(true);

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      backendHealthy = false;
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    String nextPayload;
    bool found = false;
    portENTER_CRITICAL(&sharedMux);
    if (retryQueue[0].used) {
      nextPayload = retryQueue[0].jsonPayload;
      found = true;
    }
    portEXIT_CRITICAL(&sharedMux);

    if (!found) {
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    bool began = false;
    if (strncmp(INGEST_ENDPOINT, "https://", 8) == 0) {
      if (hasValidRootCa()) {
        secureClient.setCACert(ROOT_CA_PEM);
        began = http.begin(secureClient, INGEST_ENDPOINT);
      } else if (ALLOW_INSECURE_TLS_DEV) {
        secureClient.setInsecure();
        began = http.begin(secureClient, INGEST_ENDPOINT);
      } else {
        Serial.println("[AROVA] HTTPS blocked: paste ROOT_CA_PEM in arova_secrets.h.");
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
    } else {
      began = http.begin(plainClient, INGEST_ENDPOINT);
    }

    if (!began) {
      backendHealthy = false;
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }

    http.setTimeout(5000);
    http.addHeader("Content-Type", "application/json");
    if (strlen(DEVICE_KEY) > 0 && strcmp(DEVICE_KEY, "YOUR_X_DEVICE_KEY") != 0) {
      http.addHeader("X-Device-Key", DEVICE_KEY);
    }

    int statusCode = http.POST(nextPayload);
    lastHttpCode = statusCode;
    if (statusCode == 200 || statusCode == 409) {
      backendHealthy = true;
      // Pop delivered item from head of retry queue
      portENTER_CRITICAL(&sharedMux);
      for (int i = 1; i < RETRY_QUEUE_CAP; i++) {
        retryQueue[i - 1] = retryQueue[i];
      }
      retryQueue[RETRY_QUEUE_CAP - 1].used = false;
      retryQueue[RETRY_QUEUE_CAP - 1].jsonPayload = "";
      portEXIT_CRITICAL(&sharedMux);

      if (statusCode == 200) {
        String resp = http.getString();
        #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
          JsonDocument resDoc;
        #else
          StaticJsonDocument<768> resDoc;
        #endif
        if (!deserializeJson(resDoc, resp)) {
          const char* lvl = resDoc["alertLevel"] | "Normal";
          const char* cmdAction = resDoc["deviceCommand"]["action"] | "";
          const char* cmdPattern = resDoc["deviceCommand"]["pattern"] | (resDoc["hapticPattern"] | "none");
          unsigned long cmdDuration = resDoc["deviceCommand"]["durationMs"] | 250;
          bool shouldDeactivate = (strcmp(cmdAction, "deactivate") == 0);

          portENTER_CRITICAL(&sharedMux);
          strncpy(lastAlertLevel, lvl, sizeof(lastAlertLevel) - 1);
          lastAlertLevel[sizeof(lastAlertLevel) - 1] = '\0';
          if (shouldDeactivate || strcmp(cmdPattern, "none") != 0) {
            pendingCmd.pending = true;
            pendingCmd.deactivate = shouldDeactivate;
            strncpy(pendingCmd.pattern, cmdPattern, sizeof(pendingCmd.pattern) - 1);
            pendingCmd.pattern[sizeof(pendingCmd.pattern) - 1] = '\0';
            pendingCmd.durationMs = cmdDuration;
          }
          portEXIT_CRITICAL(&sharedMux);
        }
      }
    } else {
      backendHealthy = false;
      Serial.printf("[AROVA] Backend ingest returned HTTP %d — retrying automatically.\n", statusCode);
      vTaskDelay(pdMS_TO_TICKS(1500));
    }
    http.end();
  }
}

// ----------------------------------------------------------------------------
// 12. SETUP & NON-BLOCKING MAIN LOOP (CORE 1)
// ----------------------------------------------------------------------------
void configureI2CBus() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  #if TEMP_SENSOR_MODEL == TEMP_SENSOR_MLX90614
    Wire.setClock(100000);
  #else
    Wire.setClock(400000);
  #endif
}

void setup() {
  Serial.begin(115200);
  initVibrationPwm();
  configureI2CBus();

  if (ECG_ENABLED) {
    analogReadResolution(12);
    analogSetPinAttenuation(ECG_OUTPUT_PIN, ADC_11db);
    if (ECG_LEAD_OFF_ENABLED) {
      pinMode(ECG_LO_PLUS_PIN, INPUT);
      pinMode(ECG_LO_MINUS_PIN, INPUT);
    }
  }

  oledReady = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR);
  if (oledReady) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 16);
    display.println("AROVA Health");
    display.println("Early Warning System");
    display.println("Initializing...");
    display.display();
  }

  mpuReady = mpu.begin();
  if (mpuReady) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  } else {
    Serial.println("[AROVA] MPU6050 not found on I2C 0x68.");
  }

  initPulseOximeter();
  initTemperatureSensor();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  for (int i = 0; i < RETRY_QUEUE_CAP; i++) {
    retryQueue[i].used = false;
  }

  xTaskCreatePinnedToCore(
    networkUploadTask,
    "ArovaNetTask",
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

  // 1. Optical Pulse Oximeter + ECG + Haptics run continuously on Core 1
  pollPulseOximeter(nowMs);
  pollEcgBatch(nowUs);
  updateHapticMotor(nowMs);

  // 2. Non-blocking Wi-Fi reconnect with exponential backoff
  if (WiFi.status() == WL_CONNECTED) {
    wifiBackoffMs = WIFI_RETRY_BASE_MS;
  } else if (nowMs - lastWifiAttemptMs >= wifiBackoffMs) {
    lastWifiAttemptMs = nowMs;
    Serial.println("[AROVA] Wi-Fi disconnected — attempting reconnect...");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    wifiBackoffMs = min((unsigned long)WIFI_RETRY_MAX_MS, wifiBackoffMs * 2UL);
  }

  // 3. IMU Triaxial Read (10 Hz)
  if (nowMs - lastImuMs >= IMU_SAMPLE_MS) {
    lastImuMs = nowMs;
    readMpu6050Sample(nowMs);
  }

  // 4. Temperature & Battery Read (0.5 Hz)
  if (nowMs - lastTempMs >= TEMP_SAMPLE_MS) {
    lastTempMs = nowMs;
    readTemperatureSensor();
    readBatteryLevel();
  }

  // 5. OLED Display Update (2 Hz)
  if (nowMs - lastOledMs >= OLED_REFRESH_MS) {
    lastOledMs = nowMs;
    refreshOledDisplay();
  }

  // 6. Enqueue JSON packet for Core 0 authenticated backend upload
  if (nowMs - lastUploadMs >= TELEMETRY_UPLOAD_MS) {
    lastUploadMs = nowMs;
    buildAndEnqueueTelemetryPacket();
  }
}
