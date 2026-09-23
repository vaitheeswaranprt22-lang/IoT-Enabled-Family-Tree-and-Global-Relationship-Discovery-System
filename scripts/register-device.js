#!/usr/bin/env node
/**
 * Registers an ESP32 scanner from the command line and prints the signing key.
 *
 *   node scripts/register-device.js ESP32-LAB-02 "Second lab scanner"
 *   node scripts/register-device.js ESP32-SIM-02 "Simulator" --simulated
 *   node scripts/register-device.js --list
 *   node scripts/register-device.js --key ESP32-LAB-01     (re-derive the key)
 *
 * Useful when the server is headless, or when you need the key again without
 * deleting and re-registering the device. The key is derivable from the stored
 * hash plus APP_SECRET, so `--key` does not weaken anything that a database
 * plus environment access would not already give away -- see the note in
 * backend/routes/biometric.js.
 */
import config from '../backend/config.js';
import { applySchema, all, get, run, closeDb } from '../backend/db/index.js';
import { sha256, hmac, randomToken } from '../backend/lib/auth.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

applySchema();

function listDevices() {
  const rows = all(
    `SELECT d.device_id, d.name, d.location, d.status, d.is_simulated, d.last_seen_at,
            d.firmware_version, u.email AS owner,
            (SELECT COUNT(*) FROM biometric_mappings bm WHERE bm.device_id = d.id) AS enrolled
     FROM devices d LEFT JOIN users u ON u.id = d.owner_user_id
     ORDER BY d.created_at`
  );

  if (!rows.length) {
    console.log('\n  No devices registered yet.\n');
    return;
  }

  console.log(`\n  ${rows.length} registered device(s):\n`);
  for (const row of rows) {
    console.log(`  ${row.device_id}`);
    console.log(`    name      : ${row.name}`);
    console.log(`    status    : ${row.status}${row.is_simulated ? '  (simulator)' : ''}`);
    console.log(`    location  : ${row.location ?? '-'}`);
    console.log(`    owner     : ${row.owner ?? '-'}`);
    console.log(`    enrolled  : ${row.enrolled} fingerprint(s)`);
    console.log(`    last seen : ${row.last_seen_at ?? 'never'}`);
    console.log(`    firmware  : ${row.firmware_version ?? '-'}`);
    console.log('');
  }
}

function showKey(deviceId) {
  const device = get(`SELECT * FROM devices WHERE device_id = ?`, deviceId);
  if (!device) {
    console.error(`\n  No device registered with the id "${deviceId}".\n`);
    process.exitCode = 1;
    return;
  }
  const key = hmac(device.api_key_hash, config.security.appSecret);
  console.log(`\n  Device : ${device.device_id}  (${device.name})`);
  console.log(`  Key    : ${key}\n`);
  console.log('  Put this in esp32-firmware/global_family_tree_node/secrets.h:\n');
  console.log(`      #define DEVICE_ID    "${device.device_id}"`);
  console.log(`      #define DEVICE_KEY   "${key}"\n`);
}

function registerDevice(deviceId, name) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
    console.error('\n  The device id must be 3-64 characters of letters, numbers, hyphens or underscores.\n');
    process.exitCode = 1;
    return;
  }
  if (get(`SELECT id FROM devices WHERE device_id = ?`, deviceId)) {
    console.error(`\n  "${deviceId}" is already registered. Use --key to print its signing key.\n`);
    process.exitCode = 1;
    return;
  }

  const simulated = flags.has('--simulated');
  const plaintextKey = randomToken(32);
  const apiKeyHash = sha256(plaintextKey);

  // Fall back to the first admin, then any user, so the device has an owner.
  const owner = get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)
    ?? get(`SELECT id FROM users ORDER BY id LIMIT 1`);

  run(
    `INSERT INTO devices (device_id, name, api_key_hash, location, owner_user_id, is_simulated)
     VALUES (?, ?, ?, ?, ?, ?)`,
    deviceId, name, apiKeyHash,
    positional[2] ?? null, owner?.id ?? null, simulated ? 1 : 0
  );

  const signingKey = hmac(apiKeyHash, config.security.appSecret);

  console.log('\n  ============================================================');
  console.log('   DEVICE REGISTERED');
  console.log('  ============================================================');
  console.log(`   Device ID : ${deviceId}`);
  console.log(`   Name      : ${name}`);
  console.log(`   Type      : ${simulated ? 'simulator (development only)' : 'physical scanner'}`);
  console.log('');
  console.log('   Put these two lines in secrets.h:');
  console.log('');
  console.log(`      #define DEVICE_ID    "${deviceId}"`);
  console.log(`      #define DEVICE_KEY   "${signingKey}"`);
  console.log('');
  console.log('   secrets.h is git-ignored, so the key stays out of the repository.');
  console.log('  ============================================================\n');
}

if (flags.has('--list')) {
  listDevices();
} else if (flags.has('--key')) {
  if (!positional.length) {
    console.error('\n  Usage: node scripts/register-device.js --key <DEVICE_ID>\n');
    process.exitCode = 1;
  } else {
    showKey(positional[0]);
  }
} else if (positional.length >= 2) {
  registerDevice(positional[0], positional[1]);
} else {
  console.log(`
  Register an ESP32 scanner.

    node scripts/register-device.js <DEVICE_ID> "<Name>" ["<Location>"]
    node scripts/register-device.js <DEVICE_ID> "<Name>" --simulated
    node scripts/register-device.js --list
    node scripts/register-device.js --key <DEVICE_ID>

  Examples:
    node scripts/register-device.js ESP32-LAB-02 "Second lab scanner" "Bench 3"
    node scripts/register-device.js ESP32-SIM-02 "Browser simulator" --simulated
`);
}

closeDb();
