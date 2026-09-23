/* ===========================================================================
 *  GLOBAL FAMILY TREE & ANCESTRY MAPPING SYSTEM
 *  ESP32 biometric authentication node  --  main firmware
 * ---------------------------------------------------------------------------
 *  WHAT THIS DEVICE DOES
 *    It identifies which REGISTERED ACCOUNT is standing at the scanner.
 *    That is all. It is never treated as evidence of a biological
 *    relationship -- family relationships come only from verified tree data.
 *
 *  FLOW
 *    1. Boot, connect to Wi-Fi, sync the clock over NTP.
 *    2. Poll the backend: "is anyone waiting to sign in at me?"
 *    3. If yes, show the six-character code on the LCD and ask for a finger.
 *       The user checks that code against the one on their screen, which is
 *       what stops a scanner somewhere else answering their sign-in.
 *    4. The sensor compares the finger against templates stored IN THE SENSOR
 *       and returns the slot number it matched. No image or template ever
 *       leaves the module.
 *    5. Send {slot, confidence, code} to the backend, signed.
 *    6. The backend maps the slot to an account and releases the session to
 *       the browser that started the request. This device never receives a
 *       session token.
 *
 *  REQUEST SIGNING
 *    Every request carries:
 *        X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature
 *    signature = HMAC-SHA256(DEVICE_KEY, "<id>|<timestamp>|<nonce>|<payload>")
 *    hex-encoded, lower case. DEVICE_KEY is used as an ASCII string.
 *
 *    The timestamp is Unix seconds and must be within DEVICE_CLOCK_SKEW_SECONDS
 *    of the server's clock, which is why NTP is not optional. The nonce is
 *    accepted once per device, so a captured request cannot be replayed.
 *
 *  HARDWARE  (see docs/hardware-wiring.md for the full guide)
 *    ESP32 DevKit V1 (ESP32-WROOM-32)
 *    R307 / FPM10A fingerprint sensor   -> UART2, GPIO16 (RX) / GPIO17 (TX)
 *    16x2 LCD with PCF8574 I2C backpack -> GPIO21 (SDA) / GPIO22 (SCL)
 *    Status LED on GPIO2, optional buzzer on GPIO4
 *
 *  LIBRARIES (Library Manager)
 *    Adafruit Fingerprint Sensor Library   by Adafruit      >= 2.1.0
 *    LiquidCrystal I2C                     by Frank de Brabander  1.1.2
 *    ArduinoJson                           by Benoit Blanchon     >= 7.0.0
 *  Everything else (WiFi, HTTPClient, mbedTLS) ships with the ESP32 core.
 * ===========================================================================*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_Fingerprint.h>
#include <ArduinoJson.h>
#include <time.h>
#include "mbedtls/md.h"

#include "secrets.h"

/* ----------------------------------------------------------- pin mapping ---
 * GPIO16/17 are free on ESP32-WROOM-32. On ESP32-WROVER they are wired to the
 * PSRAM and must not be used -- move the sensor to GPIO25/26 on that module.
 * GPIO6-11 are the internal SPI flash and must never be used on any variant.
 */
#define FINGERPRINT_RX_PIN   16   // ESP32 receives  <- sensor TX (yellow)
#define FINGERPRINT_TX_PIN   17   // ESP32 transmits -> sensor RX (green)
#define FINGERPRINT_BAUD     57600

#define I2C_SDA_PIN          21
#define I2C_SCL_PIN          22
#define LCD_I2C_ADDRESS      0x27 // 0x27 for PCF8574, 0x3F for PCF8574A.
#define LCD_COLUMNS          16
#define LCD_ROWS             2

#define STATUS_LED_PIN        2   // onboard LED on most DevKit V1 boards
#define BUZZER_PIN            4   // optional; leave unconnected if unused
#define HAS_BUZZER            0   // set to 1 once a buzzer is fitted

/* -------------------------------------------------------------- timings ---*/
#define POLL_INTERVAL_MS          2000UL   // how often to ask for a request
#define HEARTBEAT_INTERVAL_MS    30000UL   // keep-alive to the backend
#define WIFI_CONNECT_TIMEOUT_MS  20000UL
#define HTTP_TIMEOUT_MS          10000UL
#define RESULT_DISPLAY_MS         3500UL
#define MIN_CONFIDENCE              50     // mirror BIOMETRIC_MIN_CONFIDENCE

#define FIRMWARE_VERSION  "node-1.0.0"

/* ------------------------------------------------------------- hardware ---*/
HardwareSerial fingerprintSerial(2);                       // UART2
Adafruit_Fingerprint finger(&fingerprintSerial);
LiquidCrystal_I2C lcd(LCD_I2C_ADDRESS, LCD_COLUMNS, LCD_ROWS);

/* ---------------------------------------------------------------- state ---*/
String   pendingCode   = "";       // challenge code currently displayed
bool     sensorReady   = false;
bool     lcdReady      = false;
uint32_t lastPollAt    = 0;
uint32_t lastBeatAt    = 0;
uint32_t resultUntil   = 0;        // suppress polling while showing a result
String   lastError     = "";

/* ===========================================================================
 *  LCD helpers
 * ===========================================================================*/

void lcdShow(const String& line1, const String& line2 = "") {
  Serial.printf("[LCD] %-16s | %s\n", line1.c_str(), line2.c_str());
  if (!lcdReady) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, LCD_COLUMNS));
  if (line2.length()) {
    lcd.setCursor(0, 1);
    lcd.print(line2.substring(0, LCD_COLUMNS));
  }
}

void beep(uint16_t ms, uint8_t times = 1) {
#if HAS_BUZZER
  for (uint8_t i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(ms);
    digitalWrite(BUZZER_PIN, LOW);
    if (i + 1 < times) delay(ms);
  }
#else
  (void)ms; (void)times;
#endif
}

void blink(uint8_t times, uint16_t ms) {
  for (uint8_t i = 0; i < times; i++) {
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(ms);
    digitalWrite(STATUS_LED_PIN, LOW);
    if (i + 1 < times) delay(ms);
  }
}

/* ===========================================================================
 *  Crypto: HMAC-SHA256 over the canonical request string
 * ===========================================================================*/

String hmacSha256Hex(const String& key, const String& message) {
  byte result[32];

  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);

  mbedtls_md_setup(&ctx, info, 1 /* HMAC */);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)key.c_str(), key.length());
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)message.c_str(), message.length());
  mbedtls_md_hmac_finish(&ctx, result);
  mbedtls_md_free(&ctx);

  // Lower-case hex; the server compares against exactly this form.
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + (i * 2), "%02x", result[i]);
  hex[64] = '\0';
  return String(hex);
}

/** 24 hex characters of randomness. Each nonce is accepted once per device. */
String makeNonce() {
  char buffer[25];
  for (int i = 0; i < 24; i += 8) {
    sprintf(buffer + i, "%08x", (unsigned int)esp_random());
  }
  buffer[24] = '\0';
  return String(buffer);
}

/* ===========================================================================
 *  Networking
 * ===========================================================================*/

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  lcdShow("WiFi", "Connecting...");
  Serial.printf("[wifi] connecting to \"%s\"\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);              // steadier latency for a request/response device
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS) {
    delay(400);
    Serial.print('.');
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
  }
  Serial.println();
  digitalWrite(STATUS_LED_PIN, LOW);

  if (WiFi.status() != WL_CONNECTED) {
    lcdShow("WiFi", "Disconnected");
    Serial.println("[wifi] FAILED. Check the SSID/password, and that the network is 2.4 GHz.");
    lastError = "wifi_connect_failed";
    return false;
  }

  Serial.printf("[wifi] connected, IP %s, RSSI %d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  lcdShow("WiFi Connected", WiFi.localIP().toString());
  delay(900);
  return true;
}

/**
 * The signature covers a Unix timestamp, so the clock has to be right.
 * Without this every request is rejected for clock skew.
 */
bool syncClock() {
  lcdShow("Sync clock", "NTP...");
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  uint32_t startedAt = millis();
  time_t now = 0;
  while (millis() - startedAt < 15000UL) {
    now = time(nullptr);
    if (now > 1700000000) {              // any plausible post-2023 time
      Serial.printf("[time] synced: %ld\n", (long)now);
      return true;
    }
    delay(300);
  }

  Serial.println("[time] NTP sync FAILED -- requests will be rejected for clock skew.");
  lcdShow("Clock Error", "NTP failed");
  lastError = "ntp_sync_failed";
  return false;
}

/** Prepares an HTTPClient for `path`, attaching the signed headers. */
bool beginRequest(HTTPClient& http, WiFiClientSecure& tls, WiFiClient& plain,
                  const String& path, const String& payload) {
  String url = String(API_BASE_URL) + path;
  bool secure = url.startsWith("https://");

  if (secure) {
#if ALLOW_INSECURE_TLS
    tls.setInsecure();
#else
    tls.setCACert(API_ROOT_CA);
#endif
    if (!http.begin(tls, url)) return false;
  } else {
    if (!http.begin(plain, url)) return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  String timestamp = String((long)time(nullptr));
  String nonce     = makeNonce();
  String canonical = String(DEVICE_ID) + "|" + timestamp + "|" + nonce + "|" + payload;
  String signature = hmacSha256Hex(String(DEVICE_KEY), canonical);

  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Timestamp", timestamp);
  http.addHeader("X-Device-Nonce", nonce);
  http.addHeader("X-Device-Signature", signature);
  http.addHeader("Accept", "application/json");

  return true;
}

/** Turns an HTTP status into a short message suitable for a 16-character line. */
String describeHttpError(int code, const String& body) {
  if (code == 401) return "Auth rejected";
  if (code == 403) return "Device blocked";
  if (code == 429) return "Rate limited";
  if (code == 404) return "Bad endpoint";
  if (code < 0)    return "No server";
  if (code >= 500) return "Server error";
  (void)body;
  return "HTTP " + String(code);
}

/* ===========================================================================
 *  Backend calls
 * ===========================================================================*/

/** POST /api/biometric/device/heartbeat  --  payload "heartbeat" */
bool sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClientSecure tls;
  WiFiClient plain;

  if (!beginRequest(http, tls, plain, "/api/biometric/device/heartbeat", "heartbeat")) {
    Serial.println("[beat] could not start the request");
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  JsonDocument body;
  body["firmwareVersion"] = FIRMWARE_VERSION;
  if (lastError.length()) body["lastError"] = lastError;
  String payload;
  serializeJson(body, payload);

  int status = http.POST(payload);
  String response = http.getString();
  http.end();

  if (status != 200) {
    Serial.printf("[beat] failed: %d %s\n", status, response.c_str());
    lcdShow("Server Error", describeHttpError(status, response));
    return false;
  }

  lastError = "";
  return true;
}

/**
 * GET /api/biometric/device/poll  --  payload "poll"
 * Returns true when a challenge is waiting; `pendingCode` then holds its code.
 */
bool pollForChallenge() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClientSecure tls;
  WiFiClient plain;

  if (!beginRequest(http, tls, plain, "/api/biometric/device/poll", "poll")) return false;

  int status = http.GET();
  String response = http.getString();
  http.end();

  if (status != 200) {
    Serial.printf("[poll] failed: %d %s\n", status, response.c_str());
    lcdShow("Server Error", describeHttpError(status, response));
    lastError = "poll_http_" + String(status);
    delay(1500);
    return false;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, response);
  if (error) {
    Serial.printf("[poll] bad JSON: %s\n", error.c_str());
    return false;
  }

  if (doc["challenge"].isNull()) {
    pendingCode = "";
    return false;
  }

  pendingCode = doc["challenge"]["code"].as<String>();
  Serial.printf("[poll] challenge %s\n", pendingCode.c_str());
  lcdShow("Place Finger", "Code " + pendingCode);
  beep(60);
  return true;
}

/**
 * POST /api/biometric/device/scan
 * payload "scan|<slot>|<confidence>|<CODE>"
 */
void reportScan(uint16_t slot, uint16_t confidence) {
  HTTPClient http;
  WiFiClientSecure tls;
  WiFiClient plain;

  String payload = "scan|" + String(slot) + "|" + String(confidence) + "|" + pendingCode;
  if (!beginRequest(http, tls, plain, "/api/biometric/device/scan", payload)) {
    lcdShow("Server Error", "Request failed");
    return;
  }
  http.addHeader("Content-Type", "application/json");

  JsonDocument body;
  body["sensorSlotId"]  = slot;
  body["confidence"]    = confidence;
  body["challengeCode"] = pendingCode;
  String json;
  serializeJson(body, json);

  int status = http.POST(json);
  String response = http.getString();
  http.end();

  if (status != 200) {
    Serial.printf("[scan] failed: %d %s\n", status, response.c_str());
    lcdShow("Server Error", describeHttpError(status, response));
    lastError = "scan_http_" + String(status);
    beep(400, 2);
    resultUntil = millis() + RESULT_DISPLAY_MS;
    pendingCode = "";
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    lcdShow("Server Error", "Bad response");
    resultUntil = millis() + RESULT_DISPLAY_MS;
    pendingCode = "";
    return;
  }

  String outcome = doc["outcome"].as<String>();
  String lcdLine = doc["lcd"] | "Done";
  String name    = doc["displayName"] | "";

  Serial.printf("[scan] outcome=%s message=%s\n",
                outcome.c_str(), (doc["message"] | "").c_str());

  if (outcome == "success") {
    lcdShow(lcdLine, name);
    blink(3, 90);
    beep(90, 2);
  } else {
    lcdShow(lcdLine, outcome == "unknown_slot" ? "Not enrolled" : "Try again");
    beep(350, 2);
  }

  pendingCode = "";
  resultUntil = millis() + RESULT_DISPLAY_MS;
}

/* ===========================================================================
 *  Fingerprint sensor
 * ===========================================================================*/

bool initFingerprintSensor() {
  fingerprintSerial.begin(FINGERPRINT_BAUD, SERIAL_8N1, FINGERPRINT_RX_PIN, FINGERPRINT_TX_PIN);
  delay(120);

  if (!finger.verifyPassword()) {
    Serial.println("[fp ] sensor NOT FOUND.");
    Serial.println("      Check: 1) TX/RX are crossed (sensor TX -> GPIO16, sensor RX -> GPIO17)");
    Serial.println("             2) the sensor has 5 V and a COMMON GROUND with the ESP32");
    Serial.println("             3) the baud rate is 57600 (some modules ship at 9600)");
    return false;
  }

  finger.getParameters();
  finger.getTemplateCount();
  Serial.printf("[fp ] sensor OK. capacity=%u stored=%u security=%u\n",
                finger.capacity, finger.templateCount, finger.security_level);
  return true;
}

/**
 * Attempts one identification.
 * @return the matched slot, or -1 when no finger is present / no match.
 *         `confidence` is filled in on a match.
 */
int16_t identifyFinger(uint16_t& confidence) {
  uint8_t result = finger.getImage();

  if (result == FINGERPRINT_NOFINGER) return -1;

  if (result == FINGERPRINT_IMAGEFAIL || result == FINGERPRINT_PACKETRECIEVEERR) {
    Serial.println("[fp ] imaging error");
    return -1;
  }
  if (result != FINGERPRINT_OK) return -1;

  lcdShow("Scanning...", "Hold still");

  result = finger.image2Tz();
  if (result != FINGERPRINT_OK) {
    // Usually a smudged or partial print rather than a fault.
    lcdShow("Try Again", "Clean finger");
    delay(1200);
    if (pendingCode.length()) lcdShow("Place Finger", "Code " + pendingCode);
    return -1;
  }

  lcdShow("Verifying...", "");

  result = finger.fingerSearch();
  if (result == FINGERPRINT_NOTFOUND) {
    Serial.println("[fp ] no matching template on this sensor");
    confidence = 0;
    return -2;                                   // distinct from "no finger"
  }
  if (result != FINGERPRINT_OK) {
    Serial.printf("[fp ] search error 0x%02X\n", result);
    return -1;
  }

  confidence = finger.confidence;
  Serial.printf("[fp ] matched slot #%u with confidence %u\n", finger.fingerID, finger.confidence);
  return (int16_t)finger.fingerID;
}

/* ===========================================================================
 *  Setup and loop
 * ===========================================================================*/

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("====================================================");
  Serial.println(" Global Family Tree -- ESP32 biometric node");
  Serial.printf(" firmware %s\n", FIRMWARE_VERSION);
  Serial.printf(" device   %s\n", DEVICE_ID);
  Serial.printf(" server   %s\n", API_BASE_URL);
  Serial.println("====================================================");

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
#if HAS_BUZZER
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
#endif

  // ---- LCD ----
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.beginTransmission(LCD_I2C_ADDRESS);
  lcdReady = (Wire.endTransmission() == 0);
  if (lcdReady) {
    lcd.init();
    lcd.backlight();
  } else {
    Serial.printf("[lcd] no device at 0x%02X. Try 0x3F, or run the I2C scanner "
                  "in docs/hardware-wiring.md. The node still works without a display.\n",
                  LCD_I2C_ADDRESS);
  }
  lcdShow("Family Tree", "Starting...");

  // ---- fingerprint sensor ----
  sensorReady = initFingerprintSensor();
  if (!sensorReady) {
    lcdShow("Sensor Error", "Check wiring");
    lastError = "fingerprint_sensor_not_found";
  }

  // ---- network ----
  if (connectWiFi()) {
    syncClock();
    if (sendHeartbeat()) {
      Serial.println("[net ] registered with the backend");
    }
  }

  lcdShow(sensorReady ? "Ready" : "Sensor Error",
          sensorReady ? "Waiting..." : "Check wiring");
}

void loop() {
  // --- keep the network up -------------------------------------------------
  if (WiFi.status() != WL_CONNECTED) {
    lcdShow("WiFi", "Disconnected");
    lastError = "wifi_lost";
    if (connectWiFi()) {
      syncClock();
      sendHeartbeat();
      lcdShow("Ready", "Waiting...");
    } else {
      delay(3000);
      return;
    }
  }

  uint32_t now = millis();

  // --- heartbeat -----------------------------------------------------------
  if (now - lastBeatAt >= HEARTBEAT_INTERVAL_MS) {
    lastBeatAt = now;
    sendHeartbeat();
  }

  // --- hold the last result on screen for a moment -------------------------
  if (resultUntil && now < resultUntil) {
    delay(50);
    return;
  }
  if (resultUntil && now >= resultUntil) {
    resultUntil = 0;
    lcdShow("Ready", "Waiting...");
  }

  // --- ask whether anyone is signing in ------------------------------------
  if (pendingCode.length() == 0 && now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    pollForChallenge();
  }

  // --- read the sensor -----------------------------------------------------
  if (sensorReady && pendingCode.length() > 0) {
    uint16_t confidence = 0;
    int16_t slot = identifyFinger(confidence);

    if (slot == -2) {
      // A finger was read cleanly but matches no template on this sensor.
      // Report it anyway: the backend logs the failure and tells the waiting
      // browser, which is more useful than silently doing nothing.
      lcdShow("User Not Found", "Not enrolled");
      beep(350, 2);
      reportScan(0xFFFF, 0);
      return;
    }

    if (slot >= 0) {
      if (confidence < MIN_CONFIDENCE) {
        Serial.printf("[fp ] confidence %u below the %u floor; asking again\n",
                      confidence, MIN_CONFIDENCE);
        lcdShow("Try Again", "Press firmly");
        beep(250);
        delay(1400);
        lcdShow("Place Finger", "Code " + pendingCode);
        return;
      }
      reportScan((uint16_t)slot, confidence);
      return;
    }
  }

  delay(60);
}
