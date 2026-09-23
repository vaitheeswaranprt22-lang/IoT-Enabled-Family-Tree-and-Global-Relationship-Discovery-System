# ESP32 firmware

Two sketches. The full hardware guide — parts, wiring, power, troubleshooting —
is in [`../docs/hardware-wiring.md`](../docs/hardware-wiring.md).

| Sketch | Purpose |
|--------|---------|
| `global_family_tree_node/` | **Main firmware.** Polls for sign-in requests, reads the sensor, reports the result. |
| `global_family_tree_enroll/` | **Enrolment utility.** Stores a fingerprint on the sensor and prints its slot number. |

Enrolment is deliberately a separate sketch: a device in normal service should
not be able to quietly add a fingerprint to the sensor.

---

## Quick start

1. **Install the ESP32 core.** Arduino IDE → Preferences → *Additional boards
   manager URLs*:

   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

   Then Boards Manager → install **esp32 by Espressif Systems**.
   Select **ESP32 Dev Module**.

2. **Install three libraries** (Tools → Manage Libraries):

   | Library | Author | Version |
   |---------|--------|---------|
   | Adafruit Fingerprint Sensor Library | Adafruit | ≥ 2.1.0 |
   | LiquidCrystal I2C | Frank de Brabander | 1.1.2 |
   | ArduinoJson | Benoit Blanchon | ≥ 7.0.0 |

3. **Create `secrets.h`:**

   ```bash
   cd global_family_tree_node
   cp secrets.example.h secrets.h
   ```

   Fill in the Wi-Fi credentials, the server's **LAN IP** (never `localhost`),
   the device id and the signing key. `secrets.h` is git-ignored.

4. **Get a device key:**

   ```bash
   npm run db:seed                                      # prints keys for the demo devices
   node scripts/register-device.js --key ESP32-LAB-01   # re-print an existing one
   node scripts/register-device.js ESP32-LAB-02 "Second scanner"
   ```

   Or register from the web app: **Biometric & Hardware → Register a device**.
   The key is shown once.

5. **Enrol a finger:** flash `global_family_tree_enroll`, open the Serial
   Monitor at 115200 with line ending *Newline*, choose **1**, note the slot
   number, and link it in the web app.

6. **Flash `global_family_tree_node`** and watch the serial monitor.

---

## Pin map

| Signal | ESP32 pin |
|--------|-----------|
| Fingerprint TXD → | `GPIO16` (RX2) |
| Fingerprint RXD ← | `GPIO17` (TX2) |
| Fingerprint VCC | `VIN` (5 V) |
| LCD SDA (via level converter) | `GPIO21` |
| LCD SCL (via level converter) | `GPIO22` |
| Status LED | `GPIO2` |
| Buzzer (optional) | `GPIO4` |

**Transmit goes to receive.** Sensor TX → ESP32 RX. This catches everyone out at
least once.

**On an ESP32-WROVER, `GPIO16/17` belong to the PSRAM** — move the sensor to
`GPIO25/26` and change the two `#define`s.

---

## The two things that break this

**1. The LCD's 5 V I²C lines.** A 16×2 display needs ~5 V for readable contrast,
and its backpack pulls SDA/SCL up to that rail. ESP32 pins are **not** 5 V
tolerant. Use a bidirectional level converter, or run the LCD at 3.3 V and
accept a dim display.
[Full explanation](../docs/hardware-wiring.md#31-the-5-v-i²c-problem--read-this-before-wiring-the-lcd).

The **fingerprint sensor** connects directly — its UART is 3.3 V even when
powered from 5 V.

**2. Clock sync.** Every request is signed over a Unix timestamp that must be
within 120 seconds of the server's. The firmware syncs via NTP at boot; if that
fails, every request is rejected. Look for `[time] synced` on the serial
monitor.

---

## Serial output when it is working

```
====================================================
 Global Family Tree -- ESP32 biometric node
 firmware node-1.0.0
 device   ESP32-LAB-01
 server   http://192.168.1.42:4000
====================================================
[wifi] connecting to "MyNetwork"
.....
[wifi] connected, IP 192.168.1.57, RSSI -52 dBm
[time] synced: 1758300012
[fp ] sensor OK. capacity=1000 stored=3 security=3
[net ] registered with the backend
[LCD] Ready            | Waiting...
[poll] challenge 95AXE7
[LCD] Place Finger     | Code 95AXE7
[fp ] matched slot #1 with confidence 152
[scan] outcome=success message=Arjun Raghavan identified...
[LCD] User Verified    | Arjun Raghavan
```

---

## Protocol

Every request carries four headers:

```
X-Device-Id:        ESP32-LAB-01
X-Device-Timestamp: 1758300000          Unix seconds
X-Device-Nonce:     a3f19c…             24 hex chars, accepted once
X-Device-Signature: 9b1e4f…             lower-case hex
```

```
signature = HMAC-SHA256(DEVICE_KEY, "<id>|<timestamp>|<nonce>|<payload>")
```

`DEVICE_KEY` is used **as an ASCII string**, not hex-decoded.

| Endpoint | Method | Payload |
|----------|--------|---------|
| `/api/biometric/device/poll` | GET | `poll` |
| `/api/biometric/device/heartbeat` | POST | `heartbeat` |
| `/api/biometric/device/scan` | POST | `scan\|<slot>\|<confidence>\|<CODE>` |
| `/api/biometric/device/enroll-result` | POST | `enroll\|<slot>\|<CODE>` |

**The device never receives a session token.** On a successful match the server
attaches the identified account to the *browser's* pending challenge, and the
browser collects the session itself. A stolen scanner cannot sign anyone in.

---

## Customising

| Change | Where |
|--------|-------|
| Pins | The `#define`s at the top of each sketch |
| LCD address | `LCD_I2C_ADDRESS` — usually `0x27` or `0x3F` |
| Sensor baud rate | `FINGERPRINT_BAUD` — most R307s use 57600, some ship at 9600 |
| Poll rate | `POLL_INTERVAL_MS` — raise it if you hit the device rate limit |
| Confidence floor | `MIN_CONFIDENCE` — mirror `BIOMETRIC_MIN_CONFIDENCE` in `.env` |
| Buzzer | Set `HAS_BUZZER 1` |
| Swap the LCD for an OLED | Replace `LiquidCrystal_I2C` with `Adafruit_SSD1306` and rewrite `lcdShow()` — nothing else depends on the display |

---

## Testing without hardware

The web application's **Virtual ESP32 Scanner** (sidebar → *Hardware demo*)
implements this exact protocol in the browser, including the HMAC signature and
nonces. If a flow works there it works on the board — which also makes it a
useful way to tell a wiring fault apart from a server fault.
