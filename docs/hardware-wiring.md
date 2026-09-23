# Hardware guide — ESP32 biometric authentication node

Everything needed to build, wire, flash and demonstrate the fingerprint scanner,
from the parts list to the troubleshooting table.

> **What this hardware does, precisely.** It identifies *which registered
> account* is standing at the scanner. A fingerprint is **never** treated as
> evidence of a biological relationship. Family relationships come only from
> the tree data and the human verification workflow. This distinction is
> enforced in the software and stated on every screen that shows a scan result.

> **You can build and demonstrate the entire system before the parts arrive.**
> The web application includes a **Virtual ESP32 Scanner** (sidebar → Hardware
> demo) that speaks the identical signed protocol — same HMAC signature, same
> nonces, same endpoints. Anything that works there works on the board.

---

## 1. Bill of materials

### Required

| # | Component | Specification | Qty | Notes |
|---|-----------|---------------|-----|-------|
| 1 | **ESP32 development board** | ESP32-WROOM-32, DevKit V1 (30-pin) or DOIT DevKit v1 | 1 | Must be **WROOM**, not WROVER — see §3.3 |
| 2 | **Optical fingerprint sensor** | R307 (or FPM10A / ZFM-20 family), UART, 3.3 V logic | 1 | 1000-template capacity |
| 3 | **Character LCD with I²C backpack** | 16×2 HD44780 + PCF8574 module | 1 | Address 0x27 or 0x3F |
| 4 | **Bidirectional logic-level converter** | 4-channel, BSS138-based | 1 | **Not optional** — see §3.1 |
| 5 | **Breadboard** | 830-point (full size) | 1 | The DevKit V1 is wide; see §3.4 |
| 6 | **Jumper wires** | male–male and male–female, 10–20 cm | ~25 | |
| 7 | **Micro-USB cable** | **data** cable, not charge-only | 1 | A charge-only cable is a very common time-waster |
| 8 | **5 V power supply** | 5 V, 2 A, barrel or USB | 1 | See the power budget in §4 |

### Optional but useful

| # | Component | Purpose |
|---|-----------|---------|
| 9 | Electrolytic capacitor, 470 µF / 10 V | Bulk decoupling across the 5 V rail near the sensor |
| 10 | Ceramic capacitor, 100 nF | High-frequency decoupling at the sensor |
| 11 | Active buzzer, 5 V | Audible feedback (set `HAS_BUZZER 1` in the firmware) |
| 12 | Push button, momentary | Manual "cancel"/reset |
| 13 | Resistor, 10 kΩ | Pull-up for the button |
| 14 | Multimeter | Identifying the sensor's VCC/GND wires with certainty |

### Substitutions that work

| Instead of | You can use | What changes |
|------------|-------------|--------------|
| R307 | **AS608 / JM-101B** | 3.3 V supply — connect VCC to **3V3, not VIN**. Smaller capacity (~127–162 templates). No firmware change. |
| 16×2 I²C LCD | **SSD1306 0.96″ OLED (I²C)** | Native 3.3 V, so **no level converter needed**. Requires swapping `LiquidCrystal_I2C` for `Adafruit_SSD1306` + `Adafruit_GFX` and rewriting `lcdShow()`. |
| ESP32 DevKit V1 | ESP32-S3 / ESP32-C3 board | Re-check the pin numbers; UART2 and I²C default pins differ. |
| Breadboard | Perfboard + soldered headers | More reliable for a demo that has to survive being carried. |

---

## 2. Pin mapping

### 2.1 Master connection table

| ESP32 pin | Direction | Connects to | Wire colour (typical) | Notes |
|-----------|-----------|-------------|----------------------|-------|
| `GPIO16` (RX2) | input | Fingerprint **TXD** | yellow | Sensor talks, ESP32 listens |
| `GPIO17` (TX2) | output | Fingerprint **RXD** | green | ESP32 talks, sensor listens |
| `VIN` (5 V) | power out | Fingerprint **VCC** | red | 4.2–6.0 V on R307 |
| `GND` | ground | Fingerprint **GND** | black | **Common ground is mandatory** |
| `GPIO21` (SDA) | bidirectional | Level converter `LV1` | — | → LCD SDA on the HV side |
| `GPIO22` (SCL) | bidirectional | Level converter `LV2` | — | → LCD SCL on the HV side |
| `3V3` | power out | Level converter `LV` | — | Low-voltage reference |
| `VIN` (5 V) | power out | Level converter `HV` + LCD **VCC** | — | High-voltage side |
| `GND` | ground | Level converter both `GND` + LCD **GND** | — | |
| `GPIO2` | output | Onboard status LED | — | Already fitted on most boards |
| `GPIO4` | output | Buzzer **+** *(optional)* | — | Buzzer − to GND |

### 2.2 Fingerprint sensor connector

The R307 uses a 6-pin JST connector. **Wire colours vary between production
batches — verify before powering up.**

| Pin | Signal | Typical colour | Required? |
|-----|--------|----------------|-----------|
| 1 | VCC (4.2–6.0 V) | red | yes |
| 2 | GND | black or white | yes |
| 3 | TXD (sensor → MCU, 3.3 V) | yellow | yes |
| 4 | RXD (MCU → sensor, 3.3 V) | green or brown | yes |
| 5 | WAKEUP / touch-detect output | blue | no — leave unconnected |
| 6 | V-touch (3.3 V for the touch ring) | white | no — leave unconnected |

**How to verify before applying power:**

1. Set a multimeter to continuity. The GND wire has continuity with the metal
   ring / mounting bracket on most modules.
2. VCC and GND are usually the outermost two pins of the connector.
3. If you cannot identify TX and RX with certainty: **connect them either way
   round and run the enrolment sketch.** If it reports "sensor not found",
   power down and swap those two wires. Swapping TX and RX cannot damage
   anything, because both sides are 3.3 V logic.

> **The R307's UART is 3.3 V even when VCC is 5 V** — the module regulates
> internally. That is why the sensor connects **directly** to the ESP32 with no
> level shifting, while the LCD does not.

### 2.3 Level converter → LCD

| Level converter | Connects to |
|-----------------|-------------|
| `LV` | ESP32 `3V3` |
| `GND` (low side) | ESP32 `GND` |
| `LV1` | ESP32 `GPIO21` (SDA) |
| `LV2` | ESP32 `GPIO22` (SCL) |
| `HV` | 5 V rail (ESP32 `VIN`) |
| `GND` (high side) | `GND` |
| `HV1` | LCD backpack `SDA` |
| `HV2` | LCD backpack `SCL` |

LCD backpack `VCC` → 5 V, `GND` → GND.

---

## 3. Electrical notes that actually matter

### 3.1 The 5 V I²C problem — read this before wiring the LCD

This is the single most common way to damage an ESP32 in this project.

A 16×2 HD44780 display needs roughly **5 V** to produce readable contrast. The
PCF8574 backpack is powered from the same rail, and it carries **pull-up
resistors (typically 4.7 kΩ) tied to that rail**. So when the LCD runs at 5 V,
the SDA and SCL lines idle at **5 V**.

The ESP32's absolute maximum input voltage on a GPIO is **3.6 V**. Its pins are
**not** 5 V tolerant. Connecting a 5 V-powered I²C backpack directly puts 5 V
onto GPIO21 and GPIO22.

It very often appears to work. It is still outside the datasheet, and it
degrades or destroys the pin — sometimes immediately, more often after days of
intermittent behaviour that is then blamed on the software.

**Three correct options, in order of preference:**

| Option | How | Trade-off |
|--------|-----|-----------|
| **A. Level converter** (recommended) | LCD at 5 V, BSS138 module between it and the ESP32 (§2.3) | One extra part; full brightness and contrast |
| **B. 3.3 V OLED** | Replace the LCD with an SSD1306; connect I²C directly | No converter, crisper display; needs a library and `lcdShow()` change |
| **C. Run the LCD at 3.3 V** | LCD `VCC` → `3V3`, I²C direct, contrast trimmer turned fully | No extra parts, and electrically safe — but the display is **dim**, and some modules show nothing at all. Acceptable on a bench, not for a demo you care about. |

Option **C** is safe for the ESP32 (everything is then 3.3 V). It is only the
*readability* that suffers. What is unsafe is 5 V on the backpack with a direct
connection.

### 3.2 Common ground

The ESP32, the sensor and the display must share a ground. UART and I²C are
referenced to ground; without a shared return, signals float and behave
randomly. If the sensor is powered from a separate supply, **tie the two
grounds together.**

### 3.3 Pins you must not use

| Pins | Why |
|------|-----|
| `GPIO6`–`GPIO11` | Wired to the internal SPI flash. Using them crashes the chip. |
| `GPIO16`, `GPIO17` **on ESP32-WROVER** | Used by the WROVER's PSRAM. On **WROOM-32** they are free, which is why this project specifies WROOM. If you only have a WROVER, move the sensor to `GPIO25`/`GPIO26` and change `FINGERPRINT_RX_PIN`/`FINGERPRINT_TX_PIN`. |
| `GPIO34`–`GPIO39` | Input only, no internal pull-ups. Fine for buttons, useless for driving anything. |
| `GPIO0`, `GPIO2`, `GPIO5`, `GPIO12`, `GPIO15` | Strapping pins — their level at power-up selects the boot mode. Loading them can stop the board booting. `GPIO2` is used here only for the onboard LED, which is safe. |

### 3.4 Breadboard width

The DevKit V1 is wide enough to cover a standard breadboard's centre channel,
leaving no free holes on one side. Either use a **full-size 830-point
breadboard** (which leaves one usable row) or bring the ESP32's pins out with
male-to-female jumpers and leave the board off the breadboard entirely.

---

## 4. Power budget

| Load | Idle | Peak |
|------|------|------|
| ESP32 (Wi-Fi active) | ~80 mA | ~240 mA during transmit bursts |
| R307 fingerprint sensor | ~50 mA | ~150 mA while imaging |
| 16×2 LCD + backlight | ~25 mA | ~30 mA |
| Level converter | <1 mA | <1 mA |
| **Total** | **~155 mA** | **~420 mA** |

**What this means in practice:**

- A laptop USB 2.0 port supplies 500 mA. That is enough, but only just — and
  the peaks coincide (the ESP32 transmits the scan result while the sensor is
  still settling). Brownouts show up as random reboots with
  `Brownout detector was triggered` on the serial monitor.
- **Recommended:** a dedicated **5 V / 2 A** supply into `VIN` and `GND`.
- The DevKit V1 has a protection diode on `VIN`, so having USB and an external
  5 V supply connected at the same time is safe on that board. If you are using
  a different board, check before doing it — or simply power from one source at
  a time.
- Fit a **470 µF** electrolytic across the 5 V rail close to the sensor, plus a
  **100 nF** ceramic beside it. The imaging LED switching on is a sharp current
  step, and the bulk capacitor is what keeps that from dragging the rail down.
- **Never** power the R307 from the `3V3` pin. The onboard regulator is not
  sized for it, and the sensor will behave erratically under load.

---

## 5. Wiring diagram

```
                      ┌──────────────────────────────┐
                      │      ESP32 DevKit V1         │
                      │      (ESP32-WROOM-32)        │
                      │                              │
   ┌──────────────────┤ VIN (5V)          GPIO16 ├───────────────┐
   │              ┌───┤ GND               GPIO17 ├─────────────┐ │
   │              │   │                          │             │ │
   │              │   │ 3V3               GPIO21 ├──┐          │ │
   │              │   │                   GPIO22 ├─┐│          │ │
   │              │   │                   GPIO2  ├─┼┼── onboard LED
   │              │   └──────────┬───────────────┘ ││          │ │
   │              │              │                 ││          │ │
   │              │              │ 3V3             ││          │ │
   │              │              │                 ││          │ │
   │              │   ┌──────────▼─────────────────▼▼──┐       │ │
   │              │   │   BIDIRECTIONAL LEVEL SHIFTER  │       │ │
   │              ├───┤ GND                        LV  │       │ │
   │              │   │                            LV1 │◄──────┼─┼─ SDA (3.3V)
   │              │   │                            LV2 │◄──────┼─┼─ SCL (3.3V)
   │              │   │                                │       │ │
   ├──────────────┼───┤ HV                             │       │ │
   │              ├───┤ GND                            │       │ │
   │              │   │       HV1 ──── SDA (5V) ───┐   │       │ │
   │              │   │       HV2 ──── SCL (5V) ─┐ │   │       │ │
   │              │   └──────────────────────────┼─┼───┘       │ │
   │              │                              │ │           │ │
   │              │   ┌──────────────────────────▼─▼──┐        │ │
   │              │   │   16x2 LCD + PCF8574 backpack │        │ │
   ├──────────────┼───┤ VCC (5V)                      │        │ │
   │              ├───┤ GND                           │        │ │
   │              │   └───────────────────────────────┘        │ │
   │              │                                            │ │
   │              │   ┌────────────────────────────────┐       │ │
   ├──────────────┼───┤ VCC (red)   R307 FINGERPRINT   │       │ │
   │              ├───┤ GND (black)                    │       │ │
   │              │   │ TXD (yellow) ──────────────────┼───────┘ │
   │              │   │ RXD (green)  ──────────────────┼─────────┘
   │              │   │ WAKEUP (blue)  ── not used     │
   │              │   │ V-touch (white) ── not used    │
   │              │   └────────────────────────────────┘
   │              │
   │   5V rail ───┴── GND rail
   │        │
   │      ──┴──  470µF  (+ 100nF ceramic in parallel)
   │      ─────
   │        │
   └────────┘
```

**Note the crossover:** sensor **TX** → ESP32 **RX (GPIO16)**, sensor **RX** →
ESP32 **TX (GPIO17)**. Transmit always goes to receive. This catches people out
constantly.

---

## 6. Assembly, step by step

1. **Power off.** Unplug USB before changing any wiring.
2. **Build the power rails.** Run `VIN` to the breadboard's red rail and `GND`
   to the blue rail. Fit the 470 µF capacitor across them, **observing
   polarity** — the stripe marks the negative leg. A reversed electrolytic vents.
3. **Wire the fingerprint sensor** (4 wires): VCC → 5 V rail, GND → GND rail,
   TXD → `GPIO16`, RXD → `GPIO17`. Leave the blue and white wires unconnected;
   insulate them if they are bare.
4. **Wire the level converter.** Low side: `LV` → `3V3`, `GND` → GND rail.
   High side: `HV` → 5 V rail, `GND` → GND rail. Then `LV1` → `GPIO21`,
   `LV2` → `GPIO22`.
5. **Wire the LCD.** VCC → 5 V rail, GND → GND rail, SDA → `HV1`, SCL → `HV2`.
6. **Check before powering up:**
   - No 5 V wire touches `GPIO21` or `GPIO22` directly.
   - Every ground is on the same rail.
   - The capacitor's stripe is on the GND side.
   - Nothing is bridged across the breadboard's centre channel by accident.
7. **First power-up.** Plug in USB only. The LCD backlight should glow. If you
   see or smell anything unexpected, unplug immediately.
8. **Adjust the LCD contrast.** Turn the blue trimmer on the backpack until the
   top row of blocks is faintly visible, then back off slightly. A blank screen
   is almost always contrast, not wiring.

---

## 7. Software setup

### 7.1 Arduino IDE and the ESP32 core

1. Install the **Arduino IDE 2.x**.
2. **File → Preferences → Additional boards manager URLs**, add:

   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

3. **Tools → Board → Boards Manager**, search `esp32`, install
   **esp32 by Espressif Systems** (3.x).
4. Select **Tools → Board → ESP32 Arduino → ESP32 Dev Module**
   (or *DOIT ESP32 DEVKIT V1*).

**Board settings:**

| Setting | Value |
|---------|-------|
| Upload Speed | 921600 (drop to 115200 if uploads fail) |
| CPU Frequency | 240 MHz |
| Flash Frequency | 80 MHz |
| Flash Mode | QIO |
| Flash Size | 4 MB (32 Mb) |
| Partition Scheme | Default 4 MB with spiffs |
| Core Debug Level | None |
| Port | your board's COM/tty port |

### 7.2 Libraries

**Tools → Manage Libraries**, then install:

| Library | Author | Version |
|---------|--------|---------|
| **Adafruit Fingerprint Sensor Library** | Adafruit | ≥ 2.1.0 |
| **LiquidCrystal I2C** | Frank de Brabander | 1.1.2 |
| **ArduinoJson** | Benoit Blanchon | ≥ 7.0.0 |

`WiFi`, `HTTPClient`, `WiFiClientSecure`, `Wire` and mbedTLS ship with the ESP32
core — nothing to install.

> Several forks of `LiquidCrystal_I2C` exist with incompatible constructors.
> If `lcd.init()` will not compile, you have a different fork; either install
> the Frank de Brabander version or change `init()` to `begin()`.

### 7.3 Configure the secrets file

```bash
cd esp32-firmware/global_family_tree_node
cp secrets.example.h secrets.h        # Windows: copy secrets.example.h secrets.h
```

Edit `secrets.h`:

| Value | Where it comes from |
|-------|---------------------|
| `WIFI_SSID` / `WIFI_PASSWORD` | Your **2.4 GHz** network. The ESP32 has no 5 GHz radio. |
| `API_BASE_URL` | The **LAN IP** of the machine running the server, e.g. `http://192.168.1.42:4000`. Never `localhost` — to the ESP32 that means the ESP32. |
| `DEVICE_ID` | Must match a registered device. The seeded demo registers `ESP32-LAB-01`. |
| `DEVICE_KEY` | Printed by `npm run db:seed`, or shown once at **Biometric & Hardware → Register a device**. |

`secrets.h` is git-ignored, so the key and Wi-Fi password stay out of the
repository.

**Finding your server's LAN IP:**

```bash
ipconfig                 # Windows  -> "IPv4 Address" on your active adapter
ip addr show             # Linux
ipconfig getifaddr en0   # macOS
```

The server must listen on all interfaces (`HOST=0.0.0.0` in `.env`, which is
the default) and your firewall must allow inbound TCP on port 4000.

### 7.4 Flash

1. Connect the board over a **data** USB cable.
2. Select the port under **Tools → Port**. If none appears, install the USB
   driver your board needs: **CP2102** (Silicon Labs) or **CH340** (WCH) — the
   chip is printed on the board next to the USB socket.
3. Open `esp32-firmware/global_family_tree_node/global_family_tree_node.ino`
   and click **Upload**.
4. If it stalls at `Connecting........_____`, hold the **BOOT** button while
   the upload starts and release when it begins writing.
5. Open **Serial Monitor at 115200 baud**.

---

## 8. Finding the LCD's I²C address

If the LCD stays blank after adjusting the contrast, confirm its address. Flash
this sketch on its own:

```cpp
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);          // SDA, SCL
  delay(500);
  Serial.println("\nScanning the I2C bus...");

  int found = 0;
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device found at 0x%02X\n", address);
      found++;
    }
  }
  Serial.println(found ? "Done." : "No devices found - check SDA/SCL, power and ground.");
}

void loop() {}
```

Typical results: **0x27** (PCF8574) or **0x3F** (PCF8574A). Put whatever it
reports into `LCD_I2C_ADDRESS` in both sketches.

If nothing is found: the level converter is not powered, SDA/SCL are swapped,
or there is no common ground.

---

## 9. Enrolling a fingerprint

Enrolment is a separate sketch on purpose — a device in normal service should
not be able to quietly add a fingerprint to the sensor.

1. Flash `esp32-firmware/global_family_tree_enroll/global_family_tree_enroll.ino`.
2. Open the Serial Monitor at **115200 baud** and set the line ending to
   **Newline**.
3. Choose **1 — Enrol a new finger**.
4. Enter a slot number (start at 1 and count up; keep a written note).
5. Place the finger, lift it when told, place the **same** finger again.
6. The sketch prints:

   ```
   ================================================
    ENROLLED. Slot number: 1
    Type this number into the web application:
      Biometric & Hardware -> Enrol a finger
   ================================================
   ```

7. In the web application, sign in, go to **Biometric & Hardware → Enrol a
   finger**, choose the scanner and enter that slot number.
8. Re-flash the **main** firmware.

**Getting a good template:** clean, dry finger; press firmly enough to flatten
the ridges; cover the sensor window fully; use the same orientation both times.
Wipe the sensor glass — a smear from a previous finger is the usual cause of
"the two scans did not match".

Option **5 — Test: identify a finger** reads a finger and reports the slot and
confidence, which is the quickest way to confirm an enrolment took.

### What is stored, and where

| Where | What |
|-------|------|
| **Inside the sensor's flash** | The fingerprint template. Never transmitted. |
| **Application database** | The slot number, the device it belongs to, and `HMAC(APP_SECRET, device:slot:user)`. |
| **Anywhere else** | Nothing. No image, no template, no raw biometric data. |

Deleting an enrolment in the web application unlinks the slot from the account.
To erase the template from the hardware as well, use option **3** in the
enrolment sketch.

---

## 10. End-to-end demonstration

1. **Start the server** on the machine the ESP32 can reach:

   ```bash
   npm start
   ```

2. **Power the ESP32.** The serial monitor should show:

   ```
   [wifi] connected, IP 192.168.1.57, RSSI -52 dBm
   [time] synced: 1758...
   [fp ] sensor OK. capacity=1000 stored=3 security=3
   [net ] registered with the backend
   ```

   and the LCD: `Ready / Waiting...`

3. **Confirm the server sees it.** Sign in and open **Biometric & Hardware** —
   the device shows a green dot and "online".

4. **Start a fingerprint sign-in.** Open the sign-in page in a browser, pick
   the **Fingerprint** tab, choose the scanner, press **Start**. A
   six-character code appears.

5. **Check the code.** Within a couple of seconds the LCD shows
   `Place Finger / Code ABC123`. **It must match the code on screen.** That
   check is what stops a scanner elsewhere answering your sign-in.

6. **Present the finger.** The LCD walks through
   `Scanning... → Verifying... → User Verified` with the account's name, and
   the browser completes the sign-in on its own.

7. **The dashboard opens** on that account's family tree, with the header chip
   reading *Fingerprint verified*.

### The LCD's messages

| Display | Meaning |
|---------|---------|
| `Family Tree / Starting...` | Booting |
| `WiFi / Connecting...` | Joining the network |
| `WiFi Connected / 192.168.x.x` | Connected, showing its IP |
| `Sync clock / NTP...` | Getting the time — required for request signing |
| `Ready / Waiting...` | Idle, polling for sign-in requests |
| `Place Finger / Code ABC123` | Someone is signing in; compare the code |
| `Scanning... / Hold still` | Capturing the image |
| `Verifying...` | Searching the sensor's templates |
| `User Verified / <name>` | Identified; the browser can complete sign-in |
| `User Not Found / Not enrolled` | The finger matched nothing on this sensor |
| `Try Again / Clean finger` | Image too poor to process |
| `Try Again / Press firmly` | Matched, but below the confidence floor |
| `No Request / ...` | A finger was presented with nothing waiting |
| `WiFi / Disconnected` | Network lost; reconnecting |
| `Server Error / <reason>` | The backend refused or is unreachable |
| `Sensor Error / Check wiring` | The sensor did not answer at boot |
| `Clock Error / NTP failed` | No time sync — every request will be rejected |

---

## 11. The protocol, for reference

Every request the device makes carries four headers:

```
X-Device-Id:        ESP32-LAB-01
X-Device-Timestamp: 1758300000            (Unix seconds)
X-Device-Nonce:     a3f19c...             (24 hex chars, used once)
X-Device-Signature: 9b1e4f...             (HMAC-SHA256, lower-case hex)
```

The signature is computed over:

```
HMAC-SHA256(DEVICE_KEY, "<deviceId>|<timestamp>|<nonce>|<payload>")
```

`DEVICE_KEY` is used **as an ASCII string**, not hex-decoded. The payload is a
short canonical string per endpoint, so the firmware does not need a JSON
serialiser to reproduce it byte for byte:

| Endpoint | Method | Payload string |
|----------|--------|----------------|
| `/api/biometric/device/poll` | GET | `poll` |
| `/api/biometric/device/heartbeat` | POST | `heartbeat` |
| `/api/biometric/device/scan` | POST | `scan\|<slot>\|<confidence>\|<CODE>` |
| `/api/biometric/device/enroll-result` | POST | `enroll\|<slot>\|<CODE>` |

**Two defences against replay:**

- The timestamp must be within `DEVICE_CLOCK_SKEW_SECONDS` (default 120) of the
  server's clock. This is why NTP sync is mandatory.
- Each nonce is accepted **once per device**. A captured request cannot be
  resent.

**The device never receives a session token.** On a successful match the server
attaches the identified account to the *browser's* pending challenge; the
browser then collects the session itself. A stolen scanner cannot sign anyone
in anywhere.

---

## 12. Troubleshooting

### The sensor

| Symptom | Cause | Fix |
|---------|-------|-----|
| `sensor NOT FOUND` at boot | TX/RX not crossed | Sensor TX → `GPIO16`, sensor RX → `GPIO17`. Swap them and retry. |
| | No common ground | Tie every ground together. |
| | Wrong baud rate | Most R307s use 57600; some ship at 9600. Change `FINGERPRINT_BAUD`. |
| | Under-powered | Sensor on `3V3` instead of `VIN`; or a weak USB port. |
| | WROVER module | `GPIO16/17` are its PSRAM. Move to `GPIO25/26`. |
| Sensor LED never lights | No power | Check VCC/GND and the 5 V rail with a meter. |
| `imaging error` repeatedly | Dirty or wet sensor window | Wipe with a dry microfibre cloth. |
| "The two scans did not match" | Different finger, or a different position | Same finger, same orientation, firm even pressure. |
| Matches the wrong person | Security level too low | Raise it: `finger.setSecurityLevel(4)` before enrolling, then re-enrol. |
| Low confidence scores | Dry skin, light pressure | Press more firmly; re-enrol the finger. |

### The display

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backlight on, no characters | Contrast | Turn the blue trimmer on the backpack. This is the usual answer. |
| Nothing at all | Wrong I²C address | Run the scanner in §8; try `0x3F`. |
| | No power to the high side | `HV` must be on 5 V, both `GND` pins connected. |
| | SDA/SCL swapped | `GPIO21` → SDA, `GPIO22` → SCL, through the converter. |
| Garbled characters | Loose wire or no common ground | Reseat; check grounds. |
| Very dim at 3.3 V | Expected — see §3.1 option C | Fit the level converter and run the LCD at 5 V. |
| Compile error on `lcd.init()` | A different library fork | Install Frank de Brabander's 1.1.2, or change `init()` to `begin()`. |

### Network and server

| Symptom | Cause | Fix |
|---------|-------|-----|
| Stuck on `WiFi / Connecting...` | 5 GHz network | The ESP32 is 2.4 GHz only. Connect to the 2.4 GHz SSID. |
| | Typo in SSID/password | Both are case-sensitive. |
| | Weak signal | Check `RSSI` on the serial monitor; better than −70 dBm is comfortable. |
| | Captive-portal Wi-Fi | Campus and hotel networks usually cannot be joined by an ESP32. Use a phone hotspot. |
| `Server Error / No server` | Wrong `API_BASE_URL` | Use the LAN IP, not `localhost`. Include the port. |
| | Firewall | Allow inbound TCP 4000 on the server machine. |
| | Different subnets | The ESP32 and the server must be on the same network. A guest SSID is often isolated. |
| `Server Error / Auth rejected` (401) | Wrong `DEVICE_KEY` | Re-copy it, or re-register the device to get a fresh one. |
| | Clock skew | Confirm `[time] synced` on the serial monitor. Blocked NTP is common on locked-down networks. |
| | Device ID mismatch | `DEVICE_ID` must exactly match a registered device. |
| `Server Error / Device blocked` (403) | Device revoked | Re-register it in the web application. |
| | Simulated device, production server | `DEMO_ALLOW_SIMULATED_DEVICE=false` rejects simulators, by design. |
| `Server Error / Rate limited` (429) | Polling too fast | Raise `POLL_INTERVAL_MS`, or `RATE_LIMIT_DEVICE` in `.env`. |
| `No Request` on the LCD | No browser is waiting | Start the sign-in in the browser first; the challenge lasts 90 seconds. |
| Nonce replay rejection | Two devices sharing one `DEVICE_ID` | Each physical device needs its own registration and key. |

### The board itself

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Brownout detector was triggered` | Supply sagging | External 5 V / 2 A; fit the 470 µF capacitor; try a different USB cable. |
| Upload fails at `Connecting.....` | Not in bootloader | Hold **BOOT** as the upload starts. |
| | Charge-only USB cable | Use a data cable — this wastes more time than any other single cause. |
| | Missing driver | Install CP2102 or CH340 depending on the chip on your board. |
| No serial port listed | Driver or cable | As above. |
| Random reboots | Power, or a strapping pin loaded | See §3.3 and §4. |
| Garbage on the serial monitor | Wrong baud | Set 115200. |

---

## 13. Safety and good practice

- **Power down before rewiring.** Hot-plugging a 5 V wire onto a GPIO is the
  fastest way to end a project.
- **Observe capacitor polarity.** A reversed electrolytic can vent.
- **Do not exceed 12 mA per GPIO** (40 mA absolute). Drive relays and motors
  through a transistor, never straight from a pin.
- **Treat the device key as a credential.** Anyone holding it can impersonate
  the scanner. It lives in `secrets.h`, which is git-ignored — keep it that way,
  and re-register the device if you suspect it has leaked.
- **Turn off `DEMO_ALLOW_SIMULATED_DEVICE` outside development.** A simulated
  scanner has no physical possession factor.
- **Use HTTPS beyond a closed lab.** Over plain HTTP the request headers,
  including the signature, are visible on the network. The signature still
  prevents forgery and replay, but the traffic itself is not private.

---

## 14. Quick checklist

Before a demonstration:

- [ ] Server running and reachable at the IP in `secrets.h`
- [ ] Firewall allows inbound TCP 4000
- [ ] ESP32 and server on the same 2.4 GHz network
- [ ] Serial monitor shows `wifi connected`, `time synced`, `sensor OK`
- [ ] LCD reads `Ready / Waiting...`
- [ ] Device shows **online** on the Biometric & Hardware page
- [ ] At least one fingerprint enrolled **and linked to an account**
- [ ] Power supply comfortable (external 5 V preferred)
- [ ] Sensor window clean
- [ ] Virtual scanner ready as a fallback if the hardware misbehaves
