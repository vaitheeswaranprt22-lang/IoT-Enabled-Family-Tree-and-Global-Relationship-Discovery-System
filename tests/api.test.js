/**
 * End-to-end API tests.
 *
 * The centrepiece is `discovery flow`, which walks the exact scenario the
 * project is built around: two users independently record the same ancestor,
 * the system finds a Possible Match, refuses to act on it alone, and only
 * after a human approves does the relationship between the two users appear.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let harness;
before(async () => { harness = await startTestServer(); });
after(async () => { await harness?.close(); });

/** Adds a person to the signed-in user's tree, returning the created record. */
async function addPerson(client, fields) {
  const result = await client.post('/api/persons', fields);
  assert.ok(result.ok, `could not add ${fields.givenName}: ${JSON.stringify(result.body)}`);
  return result.body.person;
}

/** Creates a relationship and immediately verifies it (owner acting on own tree). */
async function link(client, fromId, toId, type, subtype) {
  const created = await client.post('/api/relationships', {
    fromPersonId: fromId, toPersonId: toId, type, subtype,
  });
  assert.ok(created.ok, `could not link: ${JSON.stringify(created.body)}`);
  const verified = await client.patch(`/api/relationships/${created.body.relationship.id}`, {
    status: 'verified',
  });
  assert.ok(verified.ok, `could not verify: ${JSON.stringify(verified.body)}`);
  return verified.body.relationship;
}

// ============================================================ auth basics ===

describe('authentication', () => {
  test('registration creates a user AND a separate person record', async () => {
    const client = harness.client();
    const result = await client.register('alice@test.local', 'Alice Anderson');

    assert.equal(result.user.email, 'alice@test.local');
    assert.ok(result.user.selfPerson, 'the account should get its own person record');
    assert.notEqual(result.user.id, result.user.selfPerson.id,
      'the user id and the person id must be different entities');

    const me = await client.get('/api/auth/me');
    assert.ok(me.ok);
    assert.equal(me.body.user.email, 'alice@test.local');
    assert.equal(me.body.person.displayName, 'Alice Anderson');
  });

  test('passwords are never stored or returned in plain text', async () => {
    const client = harness.client();
    await client.register('bob@test.local', 'Bob Brown');
    const me = await client.get('/api/auth/me');
    const serialized = JSON.stringify(me.body);
    assert.ok(!serialized.includes('Tr0ubadour'), 'the password must not appear in any response');
    assert.ok(!serialized.includes('password_hash'), 'the hash must not be exposed either');
  });

  test('a weak password is rejected with a helpful message', async () => {
    const client = harness.client();
    const result = await client.post('/api/auth/register', {
      email: 'weak@test.local', displayName: 'Weak', password: 'abc',
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'VALIDATION_FAILED');
    assert.ok(result.body.error.details.password);
  });

  test('a duplicate email is refused', async () => {
    const client = harness.client();
    const result = await client.post('/api/auth/register', {
      email: 'alice@test.local', displayName: 'Impostor', password: 'Tr0ubadour#Vault92',
    });
    assert.equal(result.status, 409);
  });

  test('a wrong password is refused, and the message does not reveal whether the email exists', async () => {
    const client = harness.client();
    const wrongPassword = await client.post('/api/auth/login', {
      email: 'alice@test.local', password: 'NotThePassword#1',
    });
    const unknownEmail = await client.post('/api/auth/login', {
      email: 'nobody@test.local', password: 'NotThePassword#1',
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error.message, unknownEmail.body.error.message);
  });

  test('protected endpoints refuse anonymous callers', async () => {
    const anon = harness.client();
    for (const path of ['/api/persons', '/api/tree', '/api/matches', '/api/dashboard', '/api/history']) {
      const result = await anon.get(path);
      assert.equal(result.status, 401, `${path} should require a session`);
    }
  });

  test('logout ends the session', async () => {
    const client = harness.client();
    await client.register('carol@test.local', 'Carol Clark');
    assert.ok((await client.get('/api/auth/me')).ok);
    await client.post('/api/auth/logout');
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });

  test('password reset issues a single-use token', async () => {
    const client = harness.client();
    await client.register('dave@test.local', 'Dave Davis');
    await client.post('/api/auth/logout');

    const requested = await client.post('/api/auth/forgot-password', { email: 'dave@test.local' });
    assert.ok(requested.ok);
    const token = new URL(requested.body.devResetLink, 'http://x').hash.split('token=')[1];
    assert.ok(token, 'a reset token should be issued in development mode');

    const first = await client.post('/api/auth/reset-password', { token, newPassword: 'BrandNewPass#99' });
    assert.ok(first.ok);

    const replay = await client.post('/api/auth/reset-password', { token, newPassword: 'AnotherPass#99' });
    assert.equal(replay.status, 400, 'a reset token must not work twice');

    await client.login('dave@test.local', 'BrandNewPass#99');
  });
});

// ======================================================= people and edges ===

describe('people and relationships', () => {
  test('a person can be created and read back', async () => {
    const client = harness.client();
    await client.register('erin@test.local', 'Erin Evans');

    const person = await addPerson(client, {
      givenName: 'Frank', familyName: 'Evans', gender: 'male',
      birthDate: '1950-04-12', birthPlace: 'Leeds',
    });

    assert.equal(person.displayName, 'Frank Evans');
    assert.equal(person.birthYear, 1950);

    const fetched = await client.get(`/api/persons/${person.id}`);
    assert.ok(fetched.ok);
    assert.equal(fetched.body.person.birthPlace, 'Leeds');
  });

  test('a relationship starts unverified and cannot be created as verified', async () => {
    const client = harness.client();
    const registration = await client.register('gina@test.local', 'Gina Green');
    const parent = await addPerson(client, { givenName: 'Harold', familyName: 'Green' });

    const created = await client.post('/api/relationships', {
      fromPersonId: parent.id, toPersonId: registration.user.selfPerson.id, type: 'parent',
    });
    assert.ok(created.ok);
    assert.equal(created.body.relationship.status, 'unverified',
      'a new relationship must not be verified on creation');

    const sneaky = await client.post('/api/relationships', {
      fromPersonId: registration.user.selfPerson.id, toPersonId: parent.id,
      type: 'spouse', status: 'verified',
    });
    // Either rejected outright, or accepted but not as verified.
    if (sneaky.ok) {
      assert.notEqual(sneaky.body.relationship.status, 'verified');
    }
  });

  test('a relationship that would make someone their own ancestor is refused', async () => {
    const client = harness.client();
    await client.register('hank@test.local', 'Hank Hill');
    const a = await addPerson(client, { givenName: 'Aaa' });
    const b = await addPerson(client, { givenName: 'Bbb' });
    const c = await addPerson(client, { givenName: 'Ccc' });

    await link(client, a.id, b.id, 'parent');
    await link(client, b.id, c.id, 'parent');

    const cycle = await client.post('/api/relationships', {
      fromPersonId: c.id, toPersonId: a.id, type: 'parent',
    });
    assert.equal(cycle.status, 409, 'closing an ancestry loop must be refused');
    assert.match(cycle.body.error.message, /own ancestor/i);
  });

  test('the same relationship cannot be added twice', async () => {
    const client = harness.client();
    await client.register('ivy@test.local', 'Ivy Irwin');
    const a = await addPerson(client, { givenName: 'Parent' });
    const b = await addPerson(client, { givenName: 'Child' });
    await client.post('/api/relationships', { fromPersonId: a.id, toPersonId: b.id, type: 'parent' });
    const duplicate = await client.post('/api/relationships', {
      fromPersonId: a.id, toPersonId: b.id, type: 'parent',
    });
    assert.equal(duplicate.status, 409);
  });

  test('a spouse edge is stored once, whichever direction it is given in', async () => {
    const client = harness.client();
    await client.register('jack@test.local', 'Jack Jones');
    const a = await addPerson(client, { givenName: 'Spouse', familyName: 'One' });
    const b = await addPerson(client, { givenName: 'Spouse', familyName: 'Two' });

    const first = await client.post('/api/relationships', { fromPersonId: a.id, toPersonId: b.id, type: 'spouse' });
    assert.ok(first.ok);
    const reversed = await client.post('/api/relationships', { fromPersonId: b.id, toPersonId: a.id, type: 'spouse' });
    assert.equal(reversed.status, 409, 'the reverse direction is the same edge');
  });
});

// ========================================================== relationships ===

describe('relationship discovery', () => {
  let client;
  let ids = {};

  before(async () => {
    client = harness.client();
    await client.register('kim@test.local', 'Kim King');

    // grandpa + grandma -> dad -> me, and -> aunt -> cousin
    ids.grandpa = (await addPerson(client, { givenName: 'Gerald', familyName: 'King', gender: 'male', birthDate: '1930-01-01' })).id;
    ids.grandma = (await addPerson(client, { givenName: 'Greta', familyName: 'King', gender: 'female', birthDate: '1933-01-01' })).id;
    ids.dad = (await addPerson(client, { givenName: 'Dennis', familyName: 'King', gender: 'male', birthDate: '1958-01-01' })).id;
    ids.aunt = (await addPerson(client, { givenName: 'Alma', familyName: 'King', gender: 'female', birthDate: '1961-01-01' })).id;
    ids.cousin = (await addPerson(client, { givenName: 'Cody', familyName: 'King', gender: 'male', birthDate: '1990-01-01' })).id;
    ids.me = (await client.get('/api/auth/me')).body.user.selfPerson.id;

    await link(client, ids.grandpa, ids.dad, 'parent');
    await link(client, ids.grandma, ids.dad, 'parent');
    await link(client, ids.grandpa, ids.aunt, 'parent');
    await link(client, ids.grandma, ids.aunt, 'parent');
    await link(client, ids.dad, ids.me, 'parent');
    await link(client, ids.aunt, ids.cousin, 'parent');
    await link(client, ids.grandpa, ids.grandma, 'spouse');
  });

  test('names a grandparent, an aunt and a first cousin', async () => {
    const grandfather = await client.post('/api/search/relationship', { toPersonId: ids.grandpa });
    assert.ok(grandfather.body.found);
    assert.equal(grandfather.body.relationship.label, 'grandfather');
    assert.equal(grandfather.body.relationship.isBiological, true);
    assert.equal(grandfather.body.relationship.verificationStatus, 'VERIFIED');

    const aunt = await client.post('/api/search/relationship', { toPersonId: ids.aunt });
    assert.equal(aunt.body.relationship.label, 'aunt');

    const cousin = await client.post('/api/search/relationship', { toPersonId: ids.cousin });
    assert.equal(cousin.body.relationship.label, 'first cousin');
    assert.equal(cousin.body.relationship.degreeOfSeparation, 4);
  });

  test('reports the common ancestor and the full path', async () => {
    const result = await client.post('/api/search/relationship', { toPersonId: ids.cousin });
    assert.ok(result.body.commonAncestors.length >= 1);
    const names = result.body.commonAncestors.map((c) => c.person.displayName);
    assert.ok(names.includes('Gerald King') || names.includes('Greta King'));

    const path = result.body.paths[0];
    assert.equal(path.chain.length, 4);
    assert.equal(path.chain[0].term, 'father');
    assert.match(path.narrative, /your father/);
  });

  test('says so plainly when no path exists', async () => {
    const stranger = harness.client();
    await stranger.register('leo@test.local', 'Leo Lane');
    const leoSelf = (await stranger.get('/api/auth/me')).body.user.selfPerson.id;

    const result = await client.post('/api/search/relationship', { toPersonId: leoSelf });
    assert.equal(result.body.found, false);
    assert.equal(result.body.paths.length, 0);
    assert.match(result.body.message, /No verified relationship path/i);
  });

  test('an unverified link is excluded until it is verified', async () => {
    const extra = await addPerson(client, { givenName: 'Unverified', familyName: 'King' });
    const created = await client.post('/api/relationships', {
      fromPersonId: ids.me, toPersonId: extra.id, type: 'parent',
    });

    const strict = await client.post('/api/search/relationship', { toPersonId: extra.id });
    assert.equal(strict.body.found, false, 'an unverified edge must not be traversed by default');

    const permissive = await client.post('/api/search/relationship', {
      toPersonId: extra.id, includeUnverified: true,
    });
    assert.equal(permissive.body.found, true);
    assert.equal(permissive.body.relationship.verificationStatus, 'PROVISIONAL');
    assert.equal(permissive.body.usedUnverifiedEdges, true);

    await client.patch(`/api/relationships/${created.body.relationship.id}`, { status: 'verified' });
    const now = await client.post('/api/search/relationship', { toPersonId: extra.id });
    assert.equal(now.body.found, true);
    assert.equal(now.body.relationship.verificationStatus, 'VERIFIED');
  });
});

// ====================================== the flow the whole project is for ===

describe('discovery flow: two trees connect only after human verification', () => {
  let ann;
  let ben;
  let annAncestor;
  let benAncestor;
  let annSelf;
  let benSelf;

  before(async () => {
    ann = harness.client();
    ben = harness.client();
    await ann.register('ann@flow.local', 'Ann Archer');
    await ben.register('ben@flow.local', 'Ben Archer');

    annSelf = (await ann.get('/api/auth/me')).body.user.selfPerson.id;
    benSelf = (await ben.get('/api/auth/me')).body.user.selfPerson.id;

    // Both record the SAME great-grandfather, independently and publicly.
    const shared = {
      givenName: 'Wilfred', familyName: 'Archer', gender: 'male',
      birthDate: '1901-03-09', birthPlace: 'Bristol', deathDate: '1978-11-02',
      visibility: 'public',
    };
    annAncestor = await addPerson(ann, shared);
    benAncestor = await addPerson(ben, shared);

    // Ann: Wilfred -> Alan -> Ann
    const alan = await addPerson(ann, { givenName: 'Alan', familyName: 'Archer', gender: 'male', birthDate: '1935-01-01', visibility: 'public' });
    await link(ann, annAncestor.id, alan.id, 'parent');
    await link(ann, alan.id, annSelf, 'parent');

    // Ben: Wilfred -> Brian -> Ben
    const brian = await addPerson(ben, { givenName: 'Brian', familyName: 'Archer', gender: 'male', birthDate: '1938-01-01', visibility: 'public' });
    await link(ben, benAncestor.id, brian.id, 'parent');
    await link(ben, brian.id, benSelf, 'parent');
  });

  test('step 1: before anything is verified, the two users are not related', async () => {
    const result = await ann.post('/api/search/relationship', { toPersonId: benSelf });
    assert.equal(result.body.found, false,
      'independent trees must start unconnected, however similar their records');
  });

  test('step 2: a scan finds the duplicate ancestor as a POSSIBLE match, and merges nothing', async () => {
    const scan = await ann.post('/api/matches/scan', { crossTree: true });
    assert.ok(scan.ok, JSON.stringify(scan.body));

    const match = scan.body.suggestions.find(
      (s) => s.personA.name === 'Wilfred Archer' && s.personB.name === 'Wilfred Archer'
    );
    assert.ok(match, 'the duplicated ancestor should be surfaced');
    assert.equal(match.status, 'possible', 'a scan may only ever produce a Possible Match');
    assert.equal(match.requiresHumanVerification, true);
    assert.ok(match.score > 0.8, `expected a high score, got ${match.score}`);

    // Crucially: still no relationship between the two users.
    const stillApart = await ann.post('/api/search/relationship', { toPersonId: benSelf });
    assert.equal(stillApart.body.found, false,
      'finding a match must not connect anything by itself');
  });

  test('step 3: accepting the match opens a verification request -- it does not merge', async () => {
    const matches = await ann.get('/api/matches?status=possible');
    const match = matches.body.matches.find((m) => m.personA.displayName === 'Wilfred Archer');
    assert.ok(match);

    const accepted = await ann.post(`/api/matches/${match.id}/accept`, { note: 'Same dates and birthplace.' });
    assert.ok(accepted.ok, JSON.stringify(accepted.body));
    assert.equal(accepted.body.merged, false, 'accepting must not merge');
    assert.equal(accepted.body.connected, false, 'accepting must not connect');
    assert.equal(accepted.body.status, 'verification_requested');

    const stillApart = await ann.post('/api/search/relationship', { toPersonId: benSelf });
    assert.equal(stillApart.body.found, false);
  });

  test('step 4: the request lands with the OTHER tree owner, who alone can approve it', async () => {
    const annInbox = await ann.get('/api/verifications?box=incoming&status=open');
    const benInbox = await ben.get('/api/verifications?box=incoming&status=open');

    assert.equal(annInbox.body.requests.length, 0, 'the requester must not be able to approve their own request');
    assert.equal(benInbox.body.requests.length, 1, 'the other tree owner receives it');

    const request = benInbox.body.requests[0];
    assert.equal(request.canDecide, true);
    assert.equal(request.subjectType, 'match');

    // Ann tries to approve it anyway.
    const forbidden = await ann.post(`/api/verifications/${request.id}/approve`, {});
    assert.equal(forbidden.status, 403, 'only the assignee may decide');
  });

  test('step 5: after approval the trees merge and the relationship appears', async () => {
    const inbox = await ben.get('/api/verifications?box=incoming&status=open');
    const request = inbox.body.requests[0];

    const approved = await ben.post(`/api/verifications/${request.id}/approve`, {
      note: 'Confirmed against the family bible.',
      survivingPersonId: benAncestor.id,
    });
    assert.ok(approved.ok, JSON.stringify(approved.body));
    assert.equal(approved.body.merged, true);

    // THE PAYOFF: Ann and Ben are now second cousins... or rather, sharing a
    // grandfather at two generations each makes them first cousins once the
    // records are one. Assert the computed value rather than assuming.
    const result = await ann.post('/api/search/relationship', { toPersonId: benSelf });
    assert.equal(result.body.found, true, 'the trees should now be connected');
    assert.equal(result.body.relationship.isBiological, true);
    assert.equal(result.body.relationship.verificationStatus, 'VERIFIED');
    assert.equal(result.body.relationship.label, 'first cousin');

    const ancestors = result.body.commonAncestors.map((c) => c.person.displayName);
    assert.ok(ancestors.includes('Wilfred Archer'), 'the shared ancestor should be named');
  });

  test('step 6: every step of that is in the change history', async () => {
    const history = await ben.get('/api/history?pageSize=100');
    const actions = history.body.history.map((h) => h.action);
    assert.ok(actions.includes('Verification Approved'), 'the approval must be recorded');
    assert.ok(actions.includes('Duplicate Merged'), 'the merge must be recorded');
  });
});

// =============================================== matching safety guarantee ===

describe('matching never acts on similarity alone', () => {
  test('two different people with the same name are not treated as a likely match', async () => {
    const client = harness.client();
    await client.register('mia@test.local', 'Mia Moss');

    const older = await addPerson(client, {
      givenName: 'John', familyName: 'Smith', gender: 'male',
      birthDate: '1940-06-15', birthPlace: 'Manchester',
    });
    const younger = await addPerson(client, {
      givenName: 'John', familyName: 'Smith', gender: 'male',
      birthDate: '1975-02-20', birthPlace: 'Cardiff',
    });

    const comparison = await client.post('/api/matches/compare', {
      personAId: older.id, personBId: younger.id,
    });
    assert.ok(comparison.ok);
    assert.notEqual(comparison.body.band, 'strong',
      'identical names with conflicting dates must never reach the strong band');
    assert.ok(comparison.body.conflicts.length > 0, 'the date conflict should be reported');
    assert.equal(comparison.body.requiresHumanVerification, true);
  });

  test('records with conflicting genders are suppressed', async () => {
    const client = harness.client();
    await client.register('nora@test.local', 'Nora Noble');
    const a = await addPerson(client, { givenName: 'Alex', familyName: 'Ray', gender: 'male', birthDate: '1980-01-01' });
    const b = await addPerson(client, { givenName: 'Alex', familyName: 'Ray', gender: 'female', birthDate: '1980-01-01' });

    const comparison = await client.post('/api/matches/compare', { personAId: a.id, personBId: b.id });
    assert.equal(comparison.body.suppressed, true);
    assert.ok(comparison.body.score < 0.55, `expected suppression, got ${comparison.body.score}`);
  });

  test('a genuine duplicate does score highly -- but still only as a Possible Match', async () => {
    const client = harness.client();
    await client.register('omar@test.local', 'Omar Osei');
    const a = await addPerson(client, {
      givenName: 'Patricia', familyName: 'Quinn', gender: 'female',
      birthDate: '1952-08-30', birthPlace: 'Dublin', deathDate: '2019-04-04',
    });
    const b = await addPerson(client, {
      givenName: 'Patricia', familyName: 'Quinn', gender: 'female',
      birthDate: '1952-08-30', birthPlace: 'Dublin', deathDate: '2019-04-04',
    });

    const comparison = await client.post('/api/matches/compare', { personAId: a.id, personBId: b.id });
    assert.ok(comparison.body.score > 0.85, `expected a high score, got ${comparison.body.score}`);
    assert.equal(comparison.body.requiresHumanVerification, true);

    const scan = await client.post('/api/matches/scan', { crossTree: false });
    const found = scan.body.suggestions.find((s) => s.personA.name === 'Patricia Quinn');
    assert.ok(found);
    assert.equal(found.status, 'possible', 'even a perfect score stays a Possible Match');
  });
});

// ================================================================ privacy ===

describe('privacy is enforced at the data layer', () => {
  let owner;
  let outsider;
  let privatePerson;
  let publicPerson;

  before(async () => {
    owner = harness.client();
    outsider = harness.client();
    await owner.register('pat@priv.local', 'Pat Private');
    await outsider.register('sam@priv.local', 'Sam Stranger');

    privatePerson = await addPerson(owner, {
      givenName: 'Secret', familyName: 'Person', visibility: 'private',
      birthDate: '1960-01-01', notes: 'Confidential note',
    });
    publicPerson = await addPerson(owner, {
      givenName: 'Open', familyName: 'Person', visibility: 'public',
      birthDate: '1900-01-01', deathDate: '1980-01-01',
    });
  });

  test('a private person is invisible to an outsider', async () => {
    const result = await outsider.get(`/api/persons/${privatePerson.id}`);
    assert.equal(result.status, 404,
      'a private record must be indistinguishable from a missing one');
  });

  test('a public person is visible, but a private one never appears in search', async () => {
    const visible = await outsider.get(`/api/persons/${publicPerson.id}`);
    assert.ok(visible.ok);

    const search = await outsider.get('/api/search/persons?q=Person&scope=global');
    const names = search.body.results.map((r) => r.displayName);
    assert.ok(names.includes('Open Person'));
    assert.ok(!names.includes('Secret Person'), 'a private record must not leak through search');
  });

  test('an outsider cannot edit or delete another tree’s records', async () => {
    const edit = await outsider.patch(`/api/persons/${publicPerson.id}`, { occupation: 'Hacked' });
    assert.ok(edit.status === 403 || edit.status === 404, `expected refusal, got ${edit.status}`);

    const remove = await outsider.delete(`/api/persons/${publicPerson.id}`);
    assert.ok(remove.status === 403 || remove.status === 404);

    const unchanged = await owner.get(`/api/persons/${publicPerson.id}`);
    assert.notEqual(unchanged.body.person.occupation, 'Hacked');
  });

  test('living-person details are hidden from people who cannot edit the tree', async () => {
    const living = await addPerson(owner, {
      givenName: 'Alive', familyName: 'Today', visibility: 'public',
      birthDate: '1990-05-05', birthPlace: 'Exact Address', notes: 'Private detail',
    });

    const asOutsider = await outsider.get(`/api/persons/${living.id}`);
    assert.ok(asOutsider.ok);
    assert.equal(asOutsider.body.person.detailsHidden, true);
    assert.equal(asOutsider.body.person.birthDate, null, 'the exact date must be withheld');
    assert.equal(asOutsider.body.person.birthPlace, null);
    assert.equal(asOutsider.body.person.notes, null);
    assert.equal(asOutsider.body.person.displayName, 'Alive Today', 'the name itself is still shown');

    const asOwner = await owner.get(`/api/persons/${living.id}`);
    assert.equal(asOwner.body.person.birthDate, '1990-05-05');
  });

  test('turning off relationship search blocks lookups into that tree', async () => {
    await owner.put('/api/privacy', { allowRelationshipSearch: false });
    const blocked = await outsider.post('/api/search/relationship', { toPersonId: publicPerson.id });
    assert.equal(blocked.status, 403);
    await owner.put('/api/privacy', { allowRelationshipSearch: true });
  });
});

// =============================================================== the tree ===

describe('tree and export endpoints', () => {
  test('the tree endpoint returns nodes, edges and a focus', async () => {
    const client = harness.client();
    await client.register('tina@test.local', 'Tina Torres');
    const self = (await client.get('/api/auth/me')).body.user.selfPerson.id;
    const parent = await addPerson(client, { givenName: 'Terry', familyName: 'Torres' });
    await link(client, parent.id, self, 'parent');

    const tree = await client.get('/api/tree');
    assert.ok(tree.ok);
    assert.equal(tree.body.focus.id, self);
    assert.ok(tree.body.nodes.length >= 2);
    assert.ok(tree.body.edges.length >= 1);
    assert.equal(tree.body.edges[0].type, 'parent');

    const stats = await client.get('/api/tree/stats');
    assert.ok(stats.body.people >= 2);
    assert.equal(stats.body.relationships.verified, 1);
  });

  test('GEDCOM and JSON exports are produced', async () => {
    const client = harness.client();
    await client.register('ugo@test.local', 'Ugo Udo');
    await addPerson(client, { givenName: 'Ada', familyName: 'Udo', birthDate: '1920-01-01' });

    const json = await client.get('/api/export/tree.json');
    assert.ok(json.ok);
    assert.equal(json.body.format, 'global-family-tree/v1');
    assert.ok(json.body.persons.length >= 2);

    const gedcom = await client.get('/api/export/tree.ged');
    assert.ok(gedcom.ok);
    assert.match(gedcom.body, /^0 HEAD/);
    assert.match(gedcom.body, /2 VERS 5\.5\.1/);
    assert.match(gedcom.body, /0 TRLR/);
    assert.match(gedcom.body, /1 NAME Ada \/Udo\//);
  });

  test('a backup can be exported and restored', async () => {
    const client = harness.client();
    await client.register('vera@test.local', 'Vera Vance');
    const a = await addPerson(client, { givenName: 'Victor', familyName: 'Vance', birthDate: '1945-03-03' });
    const b = await addPerson(client, { givenName: 'Violet', familyName: 'Vance', birthDate: '1948-07-07' });
    await link(client, a.id, b.id, 'spouse');

    const backup = await client.get('/api/export/backup');
    assert.ok(backup.ok);
    assert.ok(backup.body.persons.length >= 3);

    const target = harness.client();
    await target.register('wes@test.local', 'Wes Ward');
    const restored = await target.post('/api/export/restore', {
      backup: backup.body, mode: 'merge',
    });
    assert.ok(restored.ok, JSON.stringify(restored.body));
    assert.ok(restored.body.created >= 3);
    assert.match(restored.body.note, /unverified/i);
  });
});

// ============================================================ system info ===

describe('system', () => {
  test('health and info are public', async () => {
    const anon = harness.client();
    const health = await anon.get('/api/health');
    assert.ok(health.ok);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.database.ok, true);

    const info = await anon.get('/api/info');
    assert.ok(info.ok);
    assert.ok(Array.isArray(info.body.principles));
    assert.match(info.body.principles.join(' '), /never treated as evidence of a biological relationship/i);
  });

  test('an unknown route returns a clean 404', async () => {
    const anon = harness.client();
    const result = await anon.get('/api/does-not-exist');
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  });

  test('a malformed JSON body is rejected without leaking internals', async () => {
    const result = await fetch(`${harness.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(result.status, 400);
    const body = await result.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.ok(!JSON.stringify(body).includes('at JSON.parse'), 'no stack trace should reach the client');
  });
});
