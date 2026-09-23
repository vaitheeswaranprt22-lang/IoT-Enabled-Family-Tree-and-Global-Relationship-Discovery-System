/* ===========================================================================
 *  GLOBAL FAMILY TREE & ANCESTRY MAPPING SYSTEM
 *  ESP32 fingerprint ENROLMENT utility
 * ---------------------------------------------------------------------------
 *  Run this sketch once per finger you want to register. It stores the
 *  fingerprint template INSIDE THE SENSOR and prints the slot number the
 *  sensor assigned. You then type that slot number into the web application
 *  (Biometric & Hardware -> Enrol a finger) to link it to your account.
 *
 *  WHY IT IS A SEPARATE SKETCH
 *    Enrolment is a deliberate, supervised act. Keeping it out of the main
 *    firmware means a device in normal service cannot quietly add a new
 *    fingerprint to the sensor.
 *
 *  WHAT LEAVES THE SENSOR
 *    Nothing but the slot number. The image and the template stay in the
 *    module's own flash and are never transmitted or stored by the server.
 *
 *  HOW TO USE
 *    1. Wire the sensor exactly as for the main firmware.
 *    2. Flash this sketch.
 *    3. Open Serial Monitor at 115200 baud, line ending "Newline".
 *    4. Follow the menu.
 *
 *  WIRING (ESP32 DevKit V1 / WROOM-32)
 *    sensor TX (yellow) -> GPIO16      sensor RX (green) -> GPIO17
 *    sensor VCC (red)   -> 5V (VIN)    sensor GND (black) -> GND
 *    LCD SDA -> GPIO21, LCD SCL -> GPIO22   (optional; serial works alone)
 * ===========================================================================*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_Fingerprint.h>

#define FINGERPRINT_RX_PIN   16
#define FINGERPRINT_TX_PIN   17
#define FINGERPRINT_BAUD     57600

#define I2C_SDA_PIN          21
#define I2C_SCL_PIN          22
#define LCD_I2C_ADDRESS      0x27
#define LCD_COLUMNS          16
#define LCD_ROWS             2

HardwareSerial fingerprintSerial(2);
Adafruit_Fingerprint finger(&fingerprintSerial);
LiquidCrystal_I2C lcd(LCD_I2C_ADDRESS, LCD_COLUMNS, LCD_ROWS);

bool lcdReady = false;

/* ------------------------------------------------------------- utilities ---*/

void lcdShow(const String& line1, const String& line2 = "") {
  if (!lcdReady) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, LCD_COLUMNS));
  if (line2.length()) {
    lcd.setCursor(0, 1);
    lcd.print(line2.substring(0, LCD_COLUMNS));
  }
}

void say(const String& serialText, const String& lcd1, const String& lcd2 = "") {
  Serial.println(serialText);
  lcdShow(lcd1, lcd2);
}

/** Blocks until a whole line arrives on the serial port. */
String readLine() {
  String buffer = "";
  while (true) {
    while (!Serial.available()) delay(20);
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (buffer.length()) return buffer;
      continue;
    }
    buffer += c;
  }
}

int readNumber(const String& prompt, int minimum, int maximum) {
  while (true) {
    Serial.print(prompt);
    String line = readLine();
    line.trim();
    int value = line.toInt();
    if (value == 0 && line != "0") {
      Serial.println("  Not a number. Try again.");
      continue;
    }
    if (value < minimum || value > maximum) {
      Serial.printf("  Out of range (%d-%d). Try again.\n", minimum, maximum);
      continue;
    }
    return value;
  }
}

/** Waits for the finger to be lifted, so the second capture is a fresh press. */
void waitForRemoval() {
  Serial.println("  Remove your finger.");
  lcdShow("Remove finger", "");
  delay(800);
  while (finger.getImage() != FINGERPRINT_NOFINGER) delay(120);
}

/* -------------------------------------------------------------- actions ---*/

/**
 * Captures the same finger twice, builds a model and stores it in `slot`.
 * Two captures are required by the sensor: it merges them into one template,
 * which is what makes later matching reliable.
 */
bool enrolFinger(uint16_t slot) {
  int result;

  // ---- first capture ----
  say("\n  Place the finger on the sensor...", "Place Finger", "Slot " + String(slot));
  while ((result = finger.getImage()) != FINGERPRINT_OK) {
    if (result == FINGERPRINT_NOFINGER) { delay(120); continue; }
    if (result == FINGERPRINT_IMAGEFAIL) {
      Serial.println("  Imaging error -- try again.");
      delay(600);
      continue;
    }
    delay(120);
  }
  Serial.println("  Image taken.");
  lcdShow("Scanning...", "1 of 2");

  result = finger.image2Tz(1);
  if (result != FINGERPRINT_OK) {
    say("  Could not process that image. Clean the sensor and the finger, then retry.",
        "Try Again", "Too smudged");
    return false;
  }

  waitForRemoval();

  // ---- second capture ----
  say("\n  Place the SAME finger again...", "Place Again", "Slot " + String(slot));
  while ((result = finger.getImage()) != FINGERPRINT_OK) {
    if (result == FINGERPRINT_NOFINGER) { delay(120); continue; }
    delay(120);
  }
  Serial.println("  Image taken.");
  lcdShow("Scanning...", "2 of 2");

  result = finger.image2Tz(2);
  if (result != FINGERPRINT_OK) {
    say("  Could not process the second image.", "Try Again", "Second scan");
    return false;
  }

  // ---- merge ----
  Serial.println("  Building the model...");
  result = finger.createModel();
  if (result == FINGERPRINT_ENROLLMISMATCH) {
    say("  The two scans did not match. Use the same finger, in the same position.",
        "Mismatch", "Same finger!");
    return false;
  }
  if (result != FINGERPRINT_OK) {
    say("  Model creation failed.", "Error", "Model failed");
    return false;
  }

  // ---- store ----
  result = finger.storeModel(slot);
  if (result == FINGERPRINT_BADLOCATION) {
    say("  That slot number is outside the sensor's range.", "Error", "Bad slot");
    return false;
  }
  if (result != FINGERPRINT_OK) {
    say("  Could not write to the sensor.", "Error", "Write failed");
    return false;
  }

  Serial.println();
  Serial.println("  ================================================");
  Serial.printf("   ENROLLED. Slot number: %u\n", slot);
  Serial.println("   Type this number into the web application:");
  Serial.println("     Biometric & Hardware -> Enrol a finger");
  Serial.println("  ================================================");
  lcdShow("Enrolled OK", "Slot " + String(slot));
  return true;
}

void listTemplates() {
  finger.getTemplateCount();
  Serial.printf("\n  The sensor holds %u template(s), capacity %u.\n",
                finger.templateCount, finger.capacity);

  if (finger.templateCount == 0) {
    Serial.println("  Nothing enrolled yet.");
    return;
  }

  Serial.print("  Occupied slots:");
  int found = 0;
  // loadModel() is the portable way to test whether a slot holds a template.
  for (uint16_t slot = 0; slot < finger.capacity && found < finger.templateCount; slot++) {
    if (finger.loadModel(slot) == FINGERPRINT_OK) {
      Serial.printf(" %u", slot);
      found++;
    }
  }
  Serial.println();
  lcdShow("Templates", String(finger.templateCount) + " stored");
}

void deleteTemplate(uint16_t slot) {
  int result = finger.deleteModel(slot);
  if (result == FINGERPRINT_OK) {
    Serial.printf("  Slot %u deleted from the sensor.\n", slot);
    Serial.println("  Remember to remove the matching enrolment in the web application too.");
    lcdShow("Deleted", "Slot " + String(slot));
  } else {
    Serial.printf("  Could not delete slot %u (code 0x%02X).\n", slot, result);
    lcdShow("Delete failed", "Slot " + String(slot));
  }
}

void emptyDatabase() {
  Serial.println("\n  This erases EVERY fingerprint stored on this sensor.");
  Serial.print("  Type ERASE to confirm: ");
  String answer = readLine();
  answer.trim();
  if (answer != "ERASE") {
    Serial.println("  Cancelled.");
    return;
  }
  if (finger.emptyDatabase() == FINGERPRINT_OK) {
    Serial.println("  All templates erased.");
    Serial.println("  The enrolments in the web application now point at nothing -- remove them there as well.");
    lcdShow("Sensor erased", "");
  } else {
    Serial.println("  Erase failed.");
  }
}

/** Reads a finger and reports which slot it matches -- useful for checking. */
void testMatch() {
  say("\n  Place a finger to identify it...", "Place Finger", "Test mode");
  int result;
  uint32_t startedAt = millis();
  while ((result = finger.getImage()) != FINGERPRINT_OK) {
    if (millis() - startedAt > 12000UL) {
      Serial.println("  Timed out.");
      lcdShow("Timed out", "");
      return;
    }
    delay(120);
  }
  if (finger.image2Tz() != FINGERPRINT_OK) {
    Serial.println("  Could not process the image.");
    return;
  }
  result = finger.fingerSearch();
  if (result == FINGERPRINT_OK) {
    Serial.printf("  MATCH: slot %u, confidence %u\n", finger.fingerID, finger.confidence);
    lcdShow("Match: " + String(finger.fingerID), "Conf " + String(finger.confidence));
  } else if (result == FINGERPRINT_NOTFOUND) {
    Serial.println("  No match -- this finger is not enrolled on this sensor.");
    lcdShow("No match", "Not enrolled");
  } else {
    Serial.printf("  Search error 0x%02X\n", result);
  }
}

void printMenu() {
  Serial.println();
  Serial.println("  --------------------------------------------");
  Serial.println("   1  Enrol a new finger");
  Serial.println("   2  List enrolled slots");
  Serial.println("   3  Delete one slot");
  Serial.println("   4  Erase every template on the sensor");
  Serial.println("   5  Test: identify a finger");
  Serial.println("  --------------------------------------------");
  Serial.print("  Choose 1-5: ");
}

/* ----------------------------------------------------------------- main ---*/

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.println("==================================================");
  Serial.println(" Global Family Tree -- fingerprint enrolment tool");
  Serial.println("==================================================");

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.beginTransmission(LCD_I2C_ADDRESS);
  lcdReady = (Wire.endTransmission() == 0);
  if (lcdReady) { lcd.init(); lcd.backlight(); }
  else Serial.printf(" [lcd] no display at 0x%02X -- continuing on serial only.\n", LCD_I2C_ADDRESS);

  lcdShow("Enrolment tool", "Starting...");

  fingerprintSerial.begin(FINGERPRINT_BAUD, SERIAL_8N1, FINGERPRINT_RX_PIN, FINGERPRINT_TX_PIN);
  delay(150);

  if (!finger.verifyPassword()) {
    Serial.println();
    Serial.println(" SENSOR NOT FOUND.");
    Serial.println("   1. Are TX and RX crossed?  sensor TX -> GPIO16, sensor RX -> GPIO17");
    Serial.println("   2. Does the sensor have 5 V, and a COMMON GROUND with the ESP32?");
    Serial.println("   3. Is the baud rate right? Most R307 modules use 57600; some ship at 9600.");
    Serial.println("   4. Is the ESP32 a WROVER? GPIO16/17 are taken by its PSRAM -- use 25/26.");
    lcdShow("Sensor Error", "Check wiring");
    while (true) delay(1000);
  }

  finger.getParameters();
  finger.getTemplateCount();
  Serial.println();
  Serial.printf(" Sensor ready. Capacity %u, currently stored %u, security level %u.\n",
                finger.capacity, finger.templateCount, finger.security_level);
  Serial.printf(" Valid slot numbers: 0 to %u.\n", finger.capacity - 1);
  lcdShow("Sensor ready", String(finger.templateCount) + " enrolled");

  printMenu();
}

void loop() {
  if (!Serial.available()) { delay(50); return; }

  String choice = readLine();
  choice.trim();
  Serial.println(choice);

  if (choice == "1") {
    int slot = readNumber("  Slot number to use (0-" + String(finger.capacity - 1) + "): ",
                          0, finger.capacity - 1);
    if (finger.loadModel(slot) == FINGERPRINT_OK) {
      Serial.printf("  Slot %d is already in use. Overwrite it? (yes/no): ", slot);
      String answer = readLine();
      answer.trim();
      answer.toLowerCase();
      if (answer != "yes" && answer != "y") { Serial.println("  Cancelled."); printMenu(); return; }
    }
    enrolFinger((uint16_t)slot);
  } else if (choice == "2") {
    listTemplates();
  } else if (choice == "3") {
    int slot = readNumber("  Slot number to delete: ", 0, finger.capacity - 1);
    deleteTemplate((uint16_t)slot);
  } else if (choice == "4") {
    emptyDatabase();
  } else if (choice == "5") {
    testMatch();
  } else {
    Serial.println("  Unrecognised choice.");
  }

  printMenu();
}
