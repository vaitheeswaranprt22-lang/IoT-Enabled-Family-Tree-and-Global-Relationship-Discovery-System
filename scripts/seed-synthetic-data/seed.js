#!/usr/bin/env node
/**
 * Loads the synthetic demonstration dataset.
 *
 *   node scripts/seed-synthetic-data/seed.js            add demo data
 *   node scripts/seed-synthetic-data/seed.js --reset    wipe everything first
 *   node scripts/seed-synthetic-data/seed.js --stats    report, change nothing
 *
 * Every record it writes is flagged `is_synthetic = 1` and carries the label
 * "SYNTHETIC / DEMONSTRATION DATA", so demo data can always be told apart from
 * anything a real user enters.
 */
import config from '../../backend/config.js';
import {
  applySchema, dropAll, getDb, all, get, run, newPublicId, transaction, closeDb,
} from '../../backend/db/index.js';
import { hashPassword, sha256, hmac } from '../../backend/lib/auth.js';
import { createPerson, createRelationship } from '../../backend/lib/person-service.js';
import { bumpGraphVersion, loadGraph, findPaths } from '../../backend/engine/graph.js';
import { describePath } from '../../backend/engine/relationship.js';
import { scanForMatches } from '../../backend/ai/suggest.js';
import {
  ALL_TREES, CROSS_TREE_RELATIONSHIPS, ENROLLMENTS, DEVICES, COLLABORATIONS, DEMO_PASSWORD,
} from './families.js';

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const STATS_ONLY = args.includes('--stats');
const QUIET = args.includes('--quiet');

const log = (...parts) => { if (!QUIET) console.log(...parts); };
const rule = (char = '-') => log(char.repeat(74));

/** Maps the friendly keys used in families.js to database ids. */
const personIdByKey = new Map();
const userIdByKey = new Map();

const META = { isSynthetic: true, dataLabel: config.syntheticLabel };

// ---------------------------------------------------------------- reporting ---

function reportStats() {
  const rows = {
    users: get(`SELECT COUNT(*) AS n FROM users`)?.n ?? 0,
    syntheticUsers: get(`SELECT COUNT(*) AS n FROM users WHERE is_synthetic = 1`)?.n ?? 0,
    persons: get(`SELECT COUNT(*) AS n FROM persons WHERE merged_into_id IS NULL`)?.n ?? 0,
    merged: get(`SELECT COUNT(*) AS n FROM persons WHERE merged_into_id IS NOT NULL`)?.n ?? 0,
    relationships: get(`SELECT COUNT(*) AS n FROM relationships`)?.n ?? 0,
    verified: get(`SELECT COUNT(*) AS n FROM relationships WHERE status = 'verified'`)?.n ?? 0,
    events: get(`SELECT COUNT(*) AS n FROM events`)?.n ?? 0,
    matches: get(`SELECT COUNT(*) AS n FROM match_suggestions`)?.n ?? 0,
    possible: get(`SELECT COUNT(*) AS n FROM match_suggestions WHERE status = 'possible'`)?.n ?? 0,
    devices: get(`SELECT COUNT(*) AS n FROM devices`)?.n ?? 0,
    enrollments: get(`SELECT COUNT(*) AS n FROM biometric_mappings`)?.n ?? 0,
    collaborators: get(`SELECT COUNT(*) AS n FROM tree_collaborators`)?.n ?? 0,
    history: get(`SELECT COUNT(*) AS n FROM change_history`)?.n ?? 0,
  };

  rule('=');
  log('  DATABASE CONTENTS');
  rule('=');
  for (const [key, value] of Object.entries(rows)) {
    log(`  ${key.padEnd(18)} ${value}`);
  }
  rule('=');
  return rows;
}

// -------------------------------------------------------------------- seed ---

function createDemoUser(tree) {
  const publicId = newPublicId();
  const result = run(
    `INSERT INTO users (public_id, email, password_hash, display_name, is_synthetic, email_verified_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`,
    publicId, tree.user.email, hashPassword(DEMO_PASSWORD), tree.user.displayName
  );
  const userId = Number(result.lastInsertRowid);
  userIdByKey.set(tree.user.key, userId);

  run(
    `INSERT INTO privacy_settings (user_id, default_person_visibility, hide_living_details,
                                   allow_match_discovery, allow_relationship_search, show_in_directory)
     VALUES (?, 'family', 1, 1, 1, 1)`,
    userId
  );

  return userId;
}

function seedTree(tree) {
  const userId = createDemoUser(tree);
  const actor = { id: userId, displayName: tree.user.displayName };

  for (const spec of tree.persons) {
    const { key, ...columns } = spec;
    const person = createPerson(columns, {
      ownerUserId: userId,
      actor,
      ...META,
      detail: 'Loaded from the synthetic demonstration dataset.',
    });
    personIdByKey.set(key, person.id);
  }

  // Link the account to its own person record.
  const selfId = personIdByKey.get(tree.user.selfPersonKey);
  run(`UPDATE users SET self_person_id = ? WHERE id = ?`, selfId, userId);

  // Relationships inside a family are the owner's own data, so they are seeded
  // as verified. Cross-tree links are handled separately and deliberately.
  for (const [fromKey, type, toKey, subtype, extra = {}] of tree.relationships) {
    createRelationship(
      {
        fromPersonId: personIdByKey.get(fromKey),
        toPersonId: personIdByKey.get(toKey),
        type,
        subtype,
        status: 'verified',
        startDate: extra.startDate ?? null,
        endDate: extra.endDate ?? null,
        notes: extra.note ?? null,
      },
      { actor, source: 'seed', allowDirectVerify: true }
    );
  }

  for (const [personKey, type, title, date, place] of tree.events ?? []) {
    run(
      `INSERT INTO events (public_id, person_id, type, title, event_date, date_precision,
                           event_year, place, visibility, created_by, is_synthetic)
       VALUES (?, ?, ?, ?, ?, 'exact', ?, ?, 'family', ?, 1)`,
      newPublicId(), personIdByKey.get(personKey), type, title, date,
      Number.parseInt(String(date).slice(0, 4), 10), place, userId
    );
  }

  log(`  [tree] ${tree.user.displayName.padEnd(18)} ${tree.persons.length} people, ${tree.relationships.length} relationships`);
  return userId;
}

function seedCrossTreeRelationships() {
  for (const spec of CROSS_TREE_RELATIONSHIPS) {
    const fromId = personIdByKey.get(spec.from);
    const toId = personIdByKey.get(spec.to);
    if (!fromId || !toId) continue;
    const owner = get(`SELECT created_by_user_id FROM persons WHERE id = ?`, fromId);
    const ownerUser = get(`SELECT id, display_name FROM users WHERE id = ?`, owner.created_by_user_id);

    createRelationship(
      {
        fromPersonId: fromId,
        toPersonId: toId,
        type: spec.type,
        subtype: spec.subtype,
        status: spec.status,
        startDate: spec.startDate ?? null,
        notes: spec.note ?? null,
      },
      {
        actor: { id: ownerUser.id, displayName: ownerUser.display_name },
        source: 'seed',
        allowDirectVerify: true,
      }
    );
  }
  log(`  [link] ${CROSS_TREE_RELATIONSHIPS.length} verified cross-tree relationship(s)`);
}

/**
 * Registers the demonstration scanners.
 *
 * The signing key is derived deterministically from APP_SECRET so that
 * re-seeding does not invalidate a firmware build that is already flashed.
 * A real deployment uses `POST /api/biometric/devices`, which generates a
 * random key instead.
 */
function seedDevices(adminUserId) {
  const keys = [];
  for (const device of DEVICES) {
    const plaintextKey = hmac(`seed-device:${device.deviceId}`, config.security.appSecret);
    const apiKeyHash = sha256(plaintextKey);
    run(
      `INSERT INTO devices (device_id, name, api_key_hash, location, owner_user_id, is_simulated, firmware_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      device.deviceId, device.name, apiKeyHash, device.location,
      adminUserId, device.simulated ? 1 : 0, device.simulated ? 'simulator-1.0' : null
    );
    keys.push({
      deviceId: device.deviceId,
      name: device.name,
      simulated: device.simulated,
      // This is what goes into the firmware's secrets.h.
      signingKey: hmac(apiKeyHash, config.security.appSecret),
    });
  }
  log(`  [hw]   ${DEVICES.length} scanner(s) registered`);
  return keys;
}

function seedEnrollments() {
  let count = 0;
  for (const enrollment of ENROLLMENTS) {
    const userId = userIdByKey.get(enrollment.userKey);
    const device = get(`SELECT id, device_id FROM devices WHERE device_id = ?`, enrollment.deviceId);
    if (!userId || !device) continue;
    run(
      `INSERT INTO biometric_mappings
         (public_id, user_id, device_id, sensor_slot_id, credential_hash, label, enrolled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newPublicId(), userId, device.id, enrollment.slot,
      hmac(`${device.device_id}:${enrollment.slot}:${userId}`),
      enrollment.label, userId
    );
    count += 1;
  }
  log(`  [hw]   ${count} fingerprint slot(s) mapped to accounts`);
}

function seedCollaborations() {
  for (const c of COLLABORATIONS) {
    const ownerId = userIdByKey.get(c.owner);
    const granteeId = userIdByKey.get(c.grantee);
    if (!ownerId || !granteeId) continue;
    run(
      `INSERT INTO tree_collaborators (owner_user_id, grantee_user_id, role, status, invited_by, message, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ownerId, granteeId, c.role, c.status, ownerId, c.message,
      c.status === 'active' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
    );
  }
  log(`  [perm] ${COLLABORATIONS.length} collaboration grant(s)`);
}

function seedAdmin() {
  const publicId = newPublicId();
  const result = run(
    `INSERT INTO users (public_id, email, password_hash, display_name, role, is_synthetic, email_verified_at)
     VALUES (?, ?, ?, ?, 'admin', 1, datetime('now'))`,
    publicId, 'admin@demo.familytree.local', hashPassword(DEMO_PASSWORD), 'Demo Administrator'
  );
  const userId = Number(result.lastInsertRowid);
  userIdByKey.set('admin', userId);
  run(
    `INSERT INTO privacy_settings (user_id, show_in_directory) VALUES (?, 0)`,
    userId
  );
  return userId;
}

function seedNotifications() {
  const welcome = [
    ['arjun', 'match', 'info', 'Possible matches are waiting for review',
      'A scan found records in other family trees that may be the same people as yours. Nothing has been connected.', '#/matches'],
    ['priya', 'collaboration', 'info', 'Arjun Raghavan invited you to view his family tree',
      'He thinks your families may be connected through the Raghavan side.', '#/collaborators'],
    ['rohit', 'system', 'success', 'Your tree is connected to the D’Souza family',
      'Neha Sharma’s marriage to Anthony D’Souza links the two trees.', '#/tree'],
  ];
  for (const [userKey, type, severity, title, body, link] of welcome) {
    const userId = userIdByKey.get(userKey);
    if (!userId) continue;
    run(
      `INSERT INTO notifications (public_id, user_id, type, severity, title, body, link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newPublicId(), userId, type, severity, title, body, link
    );
  }
}

// ------------------------------------------------------------ verification ---

/**
 * Confirms that the dataset actually demonstrates what it claims to.
 * A seed that silently stops exercising the interesting cases is worse than
 * no seed at all, so this runs every time.
 */
async function verifyDataset() {
  rule();
  log('  DATASET SELF-CHECK');
  rule();

  const graph = loadGraph({ statuses: ['verified'] });
  const checks = [];

  const arjun = personIdByKey.get('a_arjun');
  const priya = personIdByKey.get('b_priya');
  const maria = personIdByKey.get('d_maria');
  const rohit = personIdByKey.get('c_rohit');
  const chidi = personIdByKey.get('e_chidi');

  const genderOf = (id) => get(`SELECT gender FROM persons WHERE id = ?`, id)?.gender ?? 'unknown';
  const nameOf = (id) => get(`SELECT display_name FROM persons WHERE id = ?`, id)?.display_name ?? '?';

  // 1. Arjun and Priya must NOT yet be connected -- that is the whole demo.
  const before = findPaths(graph, arjun, priya);
  checks.push({
    name: 'Raghavan and Iyer trees start unconnected',
    pass: !before.found,
    detail: before.found ? 'A path already exists -- the merge demo will not work.' : 'No path, as intended.',
  });

  // 2. Rohit and Maria are connected by marriage, not by blood.
  const rohitMaria = findPaths(graph, rohit, maria);
  let marriageLabel = 'none';
  let isBlood = null;
  if (rohitMaria.found) {
    const described = describePath(graph, rohitMaria.paths[0].steps, genderOf, nameOf);
    marriageLabel = described.label;
    isBlood = described.isBiological;
  }
  checks.push({
    name: 'Sharma and D’Souza connect through a marriage',
    pass: rohitMaria.found && isBlood === false,
    detail: rohitMaria.found ? `"${marriageLabel}", biological = ${isBlood}` : 'No path found.',
  });

  // 3. The Okafor tree is isolated.
  const isolated = findPaths(graph, arjun, chidi);
  checks.push({
    name: 'Okafor tree has no path to any other tree',
    pass: !isolated.found,
    detail: isolated.found ? 'Unexpected connection found.' : 'Correctly isolated.',
  });

  // 4. After a hypothetical merge of Venkatesh, Arjun and Priya are second
  //    cousins. Verified here by temporarily bridging the two records.
  const aVenkatesh = personIdByKey.get('a_venkatesh');
  const bVenkatesh = personIdByKey.get('b_venkatesh');
  const bridge = { adj: new Map(graph.adj) };
  const copy = (id) => [...(graph.adj.get(id) ?? [])];
  bridge.adj.set(aVenkatesh, [...copy(aVenkatesh), ...copy(bVenkatesh)]);
  bridge.adj.set(bVenkatesh, [...copy(bVenkatesh), ...copy(aVenkatesh)]);
  for (const [id, edges] of graph.adj) {
    if (id === aVenkatesh || id === bVenkatesh) continue;
    bridge.adj.set(id, edges.map((e) => (e.to === bVenkatesh ? { ...e, to: aVenkatesh } : e)));
  }
  const afterMerge = findPaths(bridge, arjun, priya, { maxPaths: 1 });
  let mergedLabel = 'none';
  if (afterMerge.found) {
    mergedLabel = describePath(bridge, afterMerge.paths[0].steps, genderOf, nameOf).label;
  }
  checks.push({
    name: 'Merging the duplicate ancestor makes Arjun and Priya second cousins',
    pass: mergedLabel === 'second cousin',
    detail: `Computed relationship after merge: "${mergedLabel}"`,
  });

  // 5. The deliberate name collision must not be offered as a likely match.
  const scan = await scanForMatches(
    { id: userIdByKey.get('rohit'), displayName: 'Rohit Sharma', role: 'user' },
    { crossTree: true, persist: false, limit: 50 }
  );
  const nameCollision = scan.suggestions.find(
    (s) =>
      (s.personA.name === 'Ramesh Iyer' && s.personB.name === 'Ramesh Iyer')
  );
  checks.push({
    name: 'Two different people named "Ramesh Iyer" are not offered as a likely match',
    pass: !nameCollision || nameCollision.band !== 'strong',
    detail: nameCollision
      ? `Surfaced at score ${nameCollision.score} in band "${nameCollision.band}" -- must never be "strong".`
      : 'Correctly suppressed by conflicting dates of birth.',
  });

  // 6. The duplicate ancestors ARE found.
  const arjunScan = await scanForMatches(
    { id: userIdByKey.get('arjun'), displayName: 'Arjun Raghavan', role: 'user' },
    { crossTree: true, persist: true, limit: 50 }
  );
  const venkateshMatch = arjunScan.suggestions.find(
    (s) => s.personA.name === 'Venkatesh Raghavan' && s.personB.name === 'Venkatesh Raghavan'
  );
  checks.push({
    name: 'The duplicate great-grandfather is detected across the two trees',
    pass: Boolean(venkateshMatch),
    detail: venkateshMatch
      ? `Found at score ${venkateshMatch.score} (band "${venkateshMatch.band}"), status "${venkateshMatch.status}".`
      : 'NOT FOUND -- the cross-tree merge demo will not work.',
  });

  // 7. The within-tree duplicate grandmother is detected.
  const meenakshiMatch = arjunScan.suggestions.find(
    (s) => s.personA.name.startsWith('Meenakshi') && s.personB.name.startsWith('Meenakshi')
  );
  checks.push({
    name: 'The grandmother entered twice in one tree is detected as a duplicate',
    pass: Boolean(meenakshiMatch),
    detail: meenakshiMatch ? `Found at score ${meenakshiMatch.score}.` : 'Not detected.',
  });

  let failures = 0;
  for (const check of checks) {
    log(`  ${check.pass ? '[ok]  ' : '[FAIL]'} ${check.name}`);
    log(`         ${check.detail}`);
    if (!check.pass) failures += 1;
  }
  rule();
  return { checks, failures };
}

// -------------------------------------------------------------------- main ---

async function main() {
  if (STATS_ONLY) {
    applySchema();
    reportStats();
    closeDb();
    return;
  }

  rule('=');
  log('  LOADING SYNTHETIC DEMONSTRATION DATA');
  log(`  Database: ${config.db.file}`);
  rule('=');

  if (RESET) {
    log('  [reset] Dropping every table.');
    getDb();
    dropAll();
  }
  applySchema();

  const existing = get(`SELECT COUNT(*) AS n FROM users WHERE is_synthetic = 1`)?.n ?? 0;
  if (existing > 0 && !RESET) {
    console.error(
      `\n  Synthetic data is already loaded (${existing} demo account(s)).\n` +
      '  Run with --reset to wipe the database and load it again:\n' +
      '      npm run db:reset\n'
    );
    closeDb();
    process.exitCode = 1;
    return;
  }

  let deviceKeys = [];

  transaction(() => {
    const adminId = seedAdmin();
    for (const tree of ALL_TREES) seedTree(tree);
    seedCrossTreeRelationships();
    deviceKeys = seedDevices(adminId);
    seedEnrollments();
    seedCollaborations();
    seedNotifications();
  });

  bumpGraphVersion();

  const { failures } = await verifyDataset();
  const stats = reportStats();

  rule('=');
  log('  DEMONSTRATION ACCOUNTS');
  rule('=');
  log(`  Password for every account below: ${DEMO_PASSWORD}`);
  log('');
  for (const tree of ALL_TREES) {
    const people = tree.persons.length;
    log(`  ${tree.user.email.padEnd(36)} ${tree.user.displayName.padEnd(20)} ${people} people`);
  }
  log(`  ${'admin@demo.familytree.local'.padEnd(36)} ${'Demo Administrator'.padEnd(20)} (admin role)`);

  rule('=');
  log('  HARDWARE SIGNING KEYS  --  copy into esp32-firmware/.../secrets.h');
  rule('=');
  for (const key of deviceKeys) {
    log(`  Device : ${key.deviceId}${key.simulated ? '  (browser simulator)' : ''}`);
    log(`  Key    : ${key.signingKey}`);
    log('');
  }
  log('  These keys are derived from APP_SECRET, so re-seeding produces the same');
  log('  values as long as APP_SECRET does not change.');

  rule('=');
  log('  SUGGESTED DEMONSTRATION SCRIPT');
  rule('=');
  log('  1. Sign in as arjun@demo.familytree.local and open the Family Tree.');
  log('  2. Search "How am I related to Priya Iyer?"  ->  no verified path yet.');
  log('  3. Open Possible Matches and run a scan.');
  log('     Venkatesh Raghavan appears twice, once in each tree.');
  log('  4. Accept the match -- note that nothing merges; a verification');
  log('     request goes to Priya instead.');
  log('  5. Sign in as priya@demo.familytree.local and approve it.');
  log('  6. Search again  ->  Arjun and Priya are second cousins, with the');
  log('     full path through Venkatesh Raghavan.');
  log('  7. Open Change History to see every step recorded.');
  rule('=');

  if (failures > 0) {
    console.error(`\n  ${failures} dataset self-check(s) FAILED. See the report above.\n`);
    process.exitCode = 1;
  } else {
    log(`\n  Seed complete: ${stats.persons} people, ${stats.relationships} relationships, ${stats.possible} possible match(es).\n`);
  }

  closeDb();
}

main().catch((err) => {
  console.error('\n[seed] Failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
  closeDb();
});
