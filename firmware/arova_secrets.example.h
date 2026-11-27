/*
 * ============================================================================
 * AROVA – Wearable-Based Early Warning System
 * Secret & Network Configuration Template (/firmware/arova_secrets.example.h)
 * ============================================================================
 * INSTRUCTIONS:
 *   1. Copy this file to "arova_secrets.h" inside /firmware/.
 *   2. Fill in your local Wi-Fi credentials, backend endpoint, and per-device
 *      X-Device-Key generated in AROVA > Device Setup (or WEARABLE_INGEST_TOKEN).
 *   3. NEVER commit arova_secrets.h or real credentials to Git.
 * ============================================================================
 */

#ifndef AROVA_SECRETS_H
#define AROVA_SECRETS_H

// 2.4 GHz Wi-Fi credentials (ESP32 DevKit supports 2.4 GHz 802.11 b/g/n)
#define SECRET_WIFI_SSID       "YOUR_24GHZ_WIFI_SSID"
#define SECRET_WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

// Backend Ingestion URL:
// Local dev example: "http://192.168.1.50:3000/api/wearable/ingest"
// Production HTTPS:  "https://YOUR_AROVA_DOMAIN/api/wearable/ingest"
#define SECRET_INGEST_ENDPOINT "https://YOUR_AROVA_DOMAIN/api/wearable/ingest"

// Device & Patient Identity (must match AROVA Device Management)
#define SECRET_DEVICE_ID       "esp32-arova-01"
#define SECRET_PATIENT_ID      "YOUR_PATIENT_ID"

// Per-device key from AROVA Device Registration OR server WEARABLE_INGEST_TOKEN
#define SECRET_DEVICE_KEY      "YOUR_X_DEVICE_KEY"

// Root CA PEM for TLS certificate verification when using HTTPS
#define SECRET_ROOT_CA_PEM \
  "-----BEGIN CERTIFICATE-----\n" \
  "PASTE_YOUR_ROOT_CA_PEM_HERE\n" \
  "-----END CERTIFICATE-----\n"

#endif // AROVA_SECRETS_H
