/* ===========================================================================
 *  secrets.example.h
 *  ---------------------------------------------------------------------------
 *  COPY THIS FILE TO  secrets.h  AND FILL IN YOUR OWN VALUES.
 *
 *      cp secrets.example.h secrets.h          (macOS / Linux)
 *      copy secrets.example.h secrets.h        (Windows)
 *
 *  `secrets.h` is listed in .gitignore, so your Wi-Fi password and device key
 *  never reach the repository. This example file contains no real secrets and
 *  is safe to commit.
 * ===========================================================================*/

#ifndef SECRETS_H
#define SECRETS_H

/* ---------------------------------------------------------------- Wi-Fi ---
 * The ESP32 radio is 2.4 GHz only. It cannot join a 5 GHz network.
 * If your router broadcasts one name for both bands, either split them or
 * connect to the 2.4 GHz SSID explicitly.
 */
#define WIFI_SSID       "YourNetworkName"
#define WIFI_PASSWORD   "YourNetworkPassword"

/* ------------------------------------------------------------ API server ---
 * Where the backend is reachable FROM THE ESP32.
 *
 *   - "localhost" and "127.0.0.1" will NOT work: to the ESP32 those mean the
 *     ESP32 itself. Use the LAN IP of the machine running the server.
 *   - Find it with `ipconfig` (Windows) or `ip addr` / `ifconfig` (macOS,
 *     Linux). It usually looks like 192.168.x.x.
 *   - No trailing slash.
 *
 * For a local demo over plain HTTP:
 *     #define API_BASE_URL "http://192.168.1.42:4000"
 * For a deployment behind TLS:
 *     #define API_BASE_URL "https://familytree.example.com"
 */
#define API_BASE_URL    "http://192.168.1.42:4000"

/* ------------------------------------------------------------ device keys ---
 * DEVICE_ID must match a device registered in the application.
 * DEVICE_KEY is the signing key shown once when the device is registered
 * (Biometric & Hardware -> Register a device), or printed by the seed script.
 *
 * The key is used as an ASCII string for HMAC-SHA256. Do not hex-decode it.
 */
#define DEVICE_ID       "ESP32-LAB-01"
#define DEVICE_KEY      "paste-the-signing-key-here"

/* ------------------------------------------------------------------- TLS ---
 * Only used when API_BASE_URL starts with https://.
 *
 * ALLOW_INSECURE_TLS = 1 skips certificate validation. That is acceptable on a
 * closed lab network with a self-signed certificate, and unacceptable anywhere
 * else -- it removes the protection TLS is there to provide.
 *
 * For production set it to 0 and paste the server's root CA below.
 */
#define ALLOW_INSECURE_TLS  1

static const char API_ROOT_CA[] PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
Paste the PEM root certificate of your server here when ALLOW_INSECURE_TLS is 0.
-----END CERTIFICATE-----
)CERT";

#endif  /* SECRETS_H */
