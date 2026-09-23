# API reference

97 endpoints under `/api`. Every response is JSON.

- **Base URL:** `http://localhost:4000/api` (configurable via `PUBLIC_BASE_URL`)
- **Authentication:** an HttpOnly session cookie (`gft_session`), or
  `Authorization: Bearer <token>`
- **Identifiers:** clients only ever see UUID `public_id` values. Internal row
  ids are never exposed.

---

## Conventions

### Errors

Every failure uses the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields need attention.",
    "details": { "password": "Use at least 10 characters." }
  }
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `BAD_REQUEST` | Malformed request |
| 401 | `UNAUTHORIZED` | No valid session, or bad credentials |
| 403 | `FORBIDDEN` | Authenticated, but not permitted |
| 404 | `NOT_FOUND` | Missing — **or present but not visible to you** |
| 409 | `CONFLICT` | Duplicate, or would violate a constraint |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 422 | `VALIDATION_FAILED` | Field errors in `details` |
| 429 | `RATE_LIMITED` | Over budget; `Retry-After` header set |
| 500 | `SERVER_ERROR` | Internal fault; details are logged, not returned |

> **404 versus 403.** A record you may not see returns **404**. Returning 403
> would confirm it exists, which is itself a disclosure.

### Rate limits

Per IP, per route class, in a sliding window (`RATE_LIMIT_WINDOW_SECONDS`,
default 60 s):

| Class | Routes | Default |
|-------|--------|---------|
| `auth` | `/api/auth/*`, `/api/biometric/challenge` | 10 |
| `device` | `/api/biometric/device/*` | 60 |
| `general` | everything else | 300 |

### Pagination

List endpoints accept `?page=` and `?pageSize=` and return
`{ page, pageSize, total, totalPages }`.

---

## Authentication

### `POST /api/auth/register` · public

Creates an account **and** the separate person record representing it.

```json
{
  "email": "you@example.com",
  "password": "at least 10 characters",
  "displayName": "Your Name",
  "gender": "female",
  "birthDate": "1992-07-03",
  "birthPlace": "Chennai"
}
```

**201**

```json
{
  "user": {
    "id": "6f1c…", "email": "you@example.com", "displayName": "Your Name",
    "role": "user",
    "selfPerson": { "id": "a92d…", "name": "Your Name" }
  },
  "session": { "token": "…", "expiresAt": "2026-09-24 09:00:00", "authMethod": "password" }
}
```

The account and the person are deliberately different entities: the account
signs you in, the person is the node other family trees can link to.

### `POST /api/auth/login` · public

`{ "email": "…", "password": "…" }` → the same shape as register.

An unknown email and a wrong password return the **same** message and take the
same time to answer. The account locks for `lockoutMinutes` after
`maxFailedLogins` consecutive failures.

### Other authentication endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/logout` | End this session |
| `POST /api/auth/logout-all` | End every session for the account |
| `GET /api/auth/me` | Current user, person record, session and privacy settings |
| `PATCH /api/auth/profile` | Change display name or email |
| `POST /api/auth/change-password` | Requires the current password; revokes all other sessions |
| `POST /api/auth/forgot-password` · public | Always the same response. In development the reset link is returned as `devResetLink` and printed to the server log |
| `POST /api/auth/reset-password` · public | `{ token, newPassword }`. Single use |
| `POST /api/auth/check-password` · public | Live strength feedback for the registration form |
| `GET /api/auth/sessions` | List active sessions |
| `DELETE /api/auth/sessions/:id` | End one session |

---

## People

### `GET /api/persons`

| Query | Meaning |
|-------|---------|
| `q` | Name search (normalised and phonetic) |
| `scope` | `mine` (default) or trees shared with you |
| `gender`, `living`, `visibility` | Filters |
| `birthFrom`, `birthTo` | Birth-year range |
| `sort` | `name` \| `birth` \| `created` \| `updated` |
| `order` | `asc` \| `desc` |

Returns only people you may see, already redacted by the privacy layer.

### `POST /api/persons`

```json
{
  "givenName": "Meenakshi", "familyName": "Raghavan",
  "gender": "female", "birthDate": "1940-09-05",
  "birthPlace": "Chennai", "visibility": "family",

  "relateTo": "<personId>",
  "relationType": "parent",
  "relationSubtype": "biological"
}
```

Only `givenName` is required. When `relateTo` and `relationType` are supplied
the relationship is created in the same transaction — as **unverified**.

`relationType` accepts `parent`, `child`, `spouse`, `sibling`. `child` is stored
as a parent edge pointing the other way.

### `GET /api/persons/:id`

Returns the person, their immediate family grouped by kind (each with the
correct term — *father*, *half-sister*, *adoptive mother*), and their events.

### Other person endpoints

| Endpoint | Purpose |
|----------|---------|
| `PATCH /api/persons/:id` | Update; writes one history row per changed field |
| `DELETE /api/persons/:id` | Delete. Refuses while relationships exist unless `?force=true`. Never deletes a person that represents a user account |
| `GET /api/persons/:id/relatives` | Raw relationship edges |
| `GET /api/persons/:id/history` | Change history for this person |
| `POST /api/persons/:id/photo` | `{ "image": "data:image/png;base64,…" }`, validated by magic number |
| `GET /api/persons/:id/photo` | The image, subject to the same privacy rules |
| `DELETE /api/persons/:id/photo` | Remove the photo |

---

## Relationships

Only three edge types are stored. Everything else is computed.

| Type | Direction | Subtypes |
|------|-----------|----------|
| `parent` | `from` is the parent of `to` | `biological`, `adoptive`, `step`, `foster`, `guardian` |
| `spouse` | symmetric, stored once | `married`, `partner`, `divorced`, `widowed` |
| `sibling` | symmetric, stored once | `full`, `half`, `step`, `adoptive` |

`sibling` is only for when the shared parents are unknown. Two children of the
same parent are connected through that parent, which is what lets the engine
tell a half sibling from a full one.

### `POST /api/relationships`

```json
{ "fromPersonId": "…", "toPersonId": "…", "type": "parent", "subtype": "biological" }
```

Always created as `unverified`. Creating one directly as `verified` is refused.

Rejected with **409** when it would make someone their own ancestor, or when
the edge already exists (in either direction, for symmetric types).

### `PATCH /api/relationships/:id`

```json
{ "status": "verified" }
```

Verifying needs **verifier standing on both trees**. Where that does not hold,
use the request below.

### `POST /api/relationships/:id/request-verification`

Opens a verification request addressed to the other tree's owner, and moves the
edge to `verification_requested`.

### `DELETE /api/relationships/:id`

Removing a **verified** edge needs verifier standing.

---

## Tree

### `GET /api/tree`

| Query | Default | Meaning |
|-------|---------|---------|
| `focus` | your own person | Centre of the window |
| `up`, `down` | 3 | Generations either way |
| `limit` | 600 | Node cap |
| `include` | `verified` | `verified` \| `unverified` \| `all` |
| `spouses`, `siblings` | `true` | Include them |

```json
{
  "focus": { "id": "…", "displayName": "Arjun Raghavan" },
  "nodes": [
    { "id": "…", "displayName": "Murugan Raghavan", "generation": 1,
      "role": "ancestor", "hasMoreAncestors": true, "hasMoreDescendants": false }
  ],
  "edges": [ { "from": "…", "to": "…", "type": "parent", "subtype": "biological", "status": "verified" } ],
  "counts": { "nodes": 10, "edges": 14 },
  "truncated": false
}
```

`generation` is positive upward. `hasMoreAncestors` / `hasMoreDescendants` tell
the client where an expand control is worth drawing.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tree/neighbors/:id` | One person's immediate family — the progressive-loading call |
| `GET /api/tree/ancestors/:id?generations=6` | Ancestors grouped by generation |
| `GET /api/tree/descendants/:id?generations=6` | Descendants grouped by generation |
| `GET /api/tree/stats` | People, relationships by status, generation span, open items |

---

## Search and relationship discovery

### `POST /api/search/relationship` — the headline endpoint

```json
{
  "toPersonId": "…",
  "toUserId": "…",
  "fromPersonId": "…",
  "includeUnverified": false,
  "maxPaths": 5
}
```

Give **one** of `toPersonId` or `toUserId`. `fromPersonId` defaults to your own
person record.

**Found:**

```json
{
  "found": true,
  "summary": "Priya Iyer is your second cousin.",
  "relationship": {
    "label": "second cousin",
    "reciprocal": "second cousin",
    "category": "biological",
    "isBiological": true,
    "viaMarriage": false,
    "degreeOfSeparation": 6,
    "verificationStatus": "VERIFIED"
  },
  "explanation": "This is a blood relationship… The branches meet at Venkatesh Raghavan.",
  "paths": [
    {
      "rank": 1,
      "label": "second cousin",
      "narrative": "your father (Murugan) → his father (Subramanian) → …",
      "chain": [
        { "toName": "Murugan Raghavan", "direction": "up",
          "term": "father", "subtype": "biological", "status": "verified" }
      ],
      "fullyVerified": true
    }
  ],
  "commonAncestors": [
    { "person": { "displayName": "Venkatesh Raghavan" },
      "generationsFromA": 3, "generationsFromB": 3,
      "relationToYou": "great-grandfather", "biological": true }
  ],
  "multiplePathsFound": false,
  "usedUnverifiedEdges": false
}
```

**Not found:**

```json
{
  "found": false,
  "message": "No verified relationship path was found between Arjun Raghavan and Chidi Okafor. …",
  "suggestion": "Run a possible-match scan to see whether the two trees share a person who has been entered twice.",
  "paths": []
}
```

`verificationStatus` is `VERIFIED` only when **every** edge on the path has been
confirmed by a person; otherwise `PROVISIONAL`.

A `GET /api/search/relationship?from=&to=&toUser=&includeUnverified=` form
exists so a result can be shared as a link.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/search/persons?q=&scope=` | `mine` \| `shared` \| `global` |
| `GET /api/search/users?q=` | Registered users who appear in the directory |
| `GET /api/search/trees` | Trees available to compare against |

---

## Possible matches

### `GET /api/matches`

`?status=possible&kind=duplicate&band=strong`

Each match carries the two person records, the score, the **evidence array**,
the **conflict array**, the rationale, and `requiresHumanVerification: true`.

### `POST /api/matches/scan`

`{ "crossTree": true, "limit": 25 }`

Compares your people against every tree whose owner allows discovery.

```json
{
  "suggestions": [ … ],
  "scanned": 11,
  "mode": "local-heuristics",
  "aiUsed": false,
  "requiresHumanVerification": true,
  "message": "3 possible match(es) recorded. None of them have been connected…"
}
```

**A scan can only ever write `status: "possible"`.** There is no code path from
a scan to a verified relationship.

### `POST /api/matches/compare`

Scores any two visible people without storing anything — useful for checking a
hunch, and for demonstrating conflict suppression.

### `POST /api/matches/:id/accept`

```json
{ "note": "Same date of birth and birthplace.", "survivingPersonId": "…" }
```

```json
{
  "status": "verification_requested",
  "merged": false,
  "connected": false,
  "message": "Recorded. The other tree owner has been asked to confirm before anything is connected."
}
```

Accepting **records an opinion and opens a verification request**. It does not
merge or connect.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/matches/:id/reject` | Record that these are different people |
| `POST /api/matches/:id/dismiss` | Hide without judging; will not resurface |
| `GET /api/matches/:id` | Full evidence, with each person's parents, spouses and children |
| `GET /api/matches/suggestions/links` | Structural gaps: a child with one parent, co-parents with no partnership, impossible dates |
| `GET /api/matches/suggestions/trees` | Which other trees are worth comparing against |
| `GET /api/matches/ai/status` | Whether the AI layer is model-assisted or heuristic |

---

## Verification

The only route from *possible* to *verified*.

### `GET /api/verifications`

`?box=incoming|outgoing|all&status=open`

### `POST /api/verifications/:id/approve`

```json
{
  "note": "Confirmed against the family bible.",
  "survivingPersonId": "…",
  "relationshipType": "sibling"
}
```

- **Duplicate** → merges the two records. Edges are repointed, events moved,
  blank fields on the survivor filled in, and a reversible snapshot stored.
- **Relationship** → promotes the edge to `verified`.

Only the assignee may decide. A cross-tree merge additionally requires that the
requester and the approver **between them** cover both trees — which is exactly
what the two-step workflow establishes.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/verifications/:id/reject` | Requires a reason; recorded in the audit trail |
| `POST /api/verifications/:id/withdraw` | The requester cancels; the subject reverts |

---

## Biometric and hardware

### Browser side

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/biometric/challenge` | public | Start a sign-in. Returns `challengeId` and a 6-character `code` |
| `GET /api/biometric/challenge/:id` | public | Poll. On `fulfilled`, returns the session **once** and sets the cookie |
| `GET /api/biometric/devices/available` | public | Scanners the sign-in page may offer |

### Device side

All four require the signed headers below.

| Endpoint | Method | Signed payload |
|----------|--------|----------------|
| `/api/biometric/device/poll` | GET | `poll` |
| `/api/biometric/device/heartbeat` | POST | `heartbeat` |
| `/api/biometric/device/scan` | POST | `scan\|<slot>\|<confidence>\|<CODE>` |
| `/api/biometric/device/enroll-result` | POST | `enroll\|<slot>\|<CODE>` |

```
X-Device-Id:        ESP32-LAB-01
X-Device-Timestamp: 1758300000
X-Device-Nonce:     a3f19c…            (24 hex chars, accepted once)
X-Device-Signature: 9b1e4f…            (lower-case hex)
```

```
signature = HMAC-SHA256(DEVICE_KEY, "<id>|<timestamp>|<nonce>|<payload>")
```

`DEVICE_KEY` is used as an **ASCII string**, not hex-decoded.

`POST /device/scan` responds with an `outcome` and an `lcd` string the firmware
prints directly:

| `outcome` | `lcd` | Meaning |
|-----------|-------|---------|
| `success` | `User Verified` | Slot matched an account; the browser can complete sign-in |
| `unknown_slot` | `User Not Found` | The slot is not linked to any account |
| `low_confidence` | `Try Again` | Below `BIOMETRIC_MIN_CONFIDENCE` |
| `no_challenge` | `No Request` | Nothing waiting, or it expired |
| `locked` | `Access Denied` | Enrolment or account disabled |

**The device never receives a session token.** On success the server attaches
the identified account to the *browser's* pending challenge.

### Management

| Endpoint | Purpose |
|----------|---------|
| `GET /api/biometric/status` | Devices, enrolments, recent activity, policy in force |
| `POST /api/biometric/devices` | Register a scanner. **Returns the signing key once** |
| `DELETE /api/biometric/devices/:id` | Revoke |
| `POST /api/biometric/enroll` | Link a sensor slot to your account |
| `POST /api/biometric/enroll/start` | Guided enrolment at the scanner |
| `DELETE /api/biometric/enroll/:id` | Unlink a slot |
| `GET /api/biometric/log` | Authentication log |

---

## Timeline, collaboration, privacy, notifications, history

| Endpoint | Purpose |
|----------|---------|
| `GET /api/timeline?scope=&type=&from=&to=` | Events plus births, deaths and marriages derived from the records |
| `POST /api/timeline/events` | Add an event |
| `PATCH` / `DELETE /api/timeline/events/:id` | Edit or remove |
| `GET /api/collaborators` | Access granted and received, with role descriptions |
| `POST /api/collaborators` | Invite by email or user id, with a role |
| `POST /api/collaborators/:id/accept` \| `/decline` | Respond to an invitation |
| `PATCH /api/collaborators/:id` | Change a role |
| `DELETE /api/collaborators/:id` | Revoke, or leave |
| `GET` / `PUT /api/privacy` | Read and update privacy settings, with an impact summary |
| `POST /api/privacy/apply-to-all` | Bulk visibility change |
| `GET /api/notifications` | Inbox |
| `GET /api/notifications/count` | Unread badge |
| `POST /api/notifications/:id/read`, `/read-all` | Mark read |
| `GET /api/history?group=&actor=&since=` | Audit trail with old and new values |
| `GET /api/history/recent` | Dashboard feed |
| `GET /api/history/security` | Sign-ins, password changes, device events |

---

## Export

| Endpoint | Format |
|----------|--------|
| `GET /api/export/tree.json` | Structured JSON snapshot |
| `GET /api/export/tree.ged` | **GEDCOM 5.5.1**, readable by other genealogy software |
| `GET /api/export/tree.svg?focus=&up=&down=` | Rendered SVG; the client converts it to PNG or PDF |
| `GET /api/export/backup` | Full restorable archive of your own tree |
| `POST /api/export/restore` | `{ backup, mode: "merge"\|"replace", keepStatus, confirm }` |

Every export applies the privacy layer: a collaborator exporting a shared tree
receives exactly the fields they can see on screen.

Restored relationships return as **unverified** unless `keepStatus` is set — an
import is a claim about the data, not a verification of it.

---

## System

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/health` | public | Status, uptime, database check |
| `GET /api/info` | public | Deployment stats, features, stated principles |
| `GET /api/dashboard` | session | Everything the dashboard needs in one call |
