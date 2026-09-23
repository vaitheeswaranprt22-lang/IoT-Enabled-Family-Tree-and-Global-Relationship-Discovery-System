# Architecture

How the system is put together, and why it is put together that way.

---

## 1. Shape of the system

```
┌─────────────────────────────────────────────────────────────────────────┐
│  HARDWARE                                                                │
│                                                                          │
│   ┌──────────────┐   UART    ┌─────────────┐   I²C    ┌──────────────┐  │
│   │ R307 sensor  │◄─────────►│    ESP32    │◄────────►│  16×2 LCD    │  │
│   │ templates    │  57600    │  WROOM-32   │  (via    │  status      │  │
│   │ stay HERE    │           │             │  shifter)│              │  │
│   └──────────────┘           └──────┬──────┘          └──────────────┘  │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │ Wi-Fi, HMAC-signed HTTP
┌─────────────────────────────────────▼───────────────────────────────────┐
│  BACKEND  (Node 22, zero dependencies)                                   │
│                                                                          │
│   server.js ── router ── rate limit ── auth context ── handler           │
│                                                    │                     │
│        ┌───────────────────────────────────────────┼──────────────┐      │
│        │                    │                      │              │      │
│   ┌────▼─────┐   ┌──────────▼────────┐   ┌─────────▼──────┐  ┌────▼───┐ │
│   │ engine/  │   │ lib/privacy.js    │   │ ai/suggest.js  │  │ audit  │ │
│   │ graph    │   │ THE GATE for      │   │ advisory only  │  │ every  │ │
│   │ kinship  │   │ every person read │   │                │  │ change │ │
│   │ matching │   └──────────┬────────┘   └────────────────┘  └────┬───┘ │
│   └────┬─────┘              │                                     │     │
│        └────────────────────┼─────────────────────────────────────┘     │
│                    ┌────────▼─────────┐                                  │
│                    │  node:sqlite     │  20 tables, FKs, CHECKs, indexes │
│                    └──────────────────┘                                  │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ JSON over HTTP
┌─────────────────────────────────────▼───────────────────────────────────┐
│  FRONTEND  (vanilla ES modules, no build step)                           │
│   app.js router ── views/*.js ── tree-render.js (SVG) ── export-pdf.js   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Why zero dependencies

Node 22 provides `node:sqlite`, `node:crypto` and `node:http`. Together they
cover storage, password hashing, HMAC and the server. The frontend is ES modules
the browser loads directly.

The result is that `git clone && node backend/server.js` works on any machine
with Node 22.5+. There is no `npm install` to fail on a lab machine, no lockfile
drift, no transitive supply-chain surface, and no build step between the source
and what runs.

The cost is that some things are hand-written which a library would otherwise
provide: the router, the validator, the PDF writer, the tree renderer. Each is
small, each is commented, and each does only what this project needs.

---

## 3. The data model

### 3.1 User and Person are different things

```
users                                persons
┌────────────────┐                   ┌──────────────────┐
│ id             │                   │ id               │
│ email          │                   │ created_by_user  │
│ password_hash  │   self_person_id  │ given_name       │
│ role           │──────────────────►│ family_name      │
└────────────────┘                   │ birth_date       │
                                     │ visibility       │
                                     └──────────────────┘
```

A **user** is a login. A **person** is a node in the family graph.

This separation is what makes cross-tree connection possible. When two families
turn out to share a great-grandfather, the merge operates on *persons*. Nobody's
login is touched, and nobody gains access to anyone else's account. It is also
what lets several users eventually reference the same real-world person — after
verification — without that meaning anything about authentication.

### 3.2 Three stored edges, everything else computed

```
parent   P ──────► C      directed
spouse   A ◄─────► B      symmetric, stored once, canonical low→high id
sibling  A ◄─────► B      symmetric, ONLY when the shared parents are unknown
```

Grandparent, uncle, cousin, in-law, great-great-niece: none of these are stored.
They are computed by walking the edges.

The alternative — storing a `relationship_type` string on each row — fails as
soon as the data changes. Add a parent and every derived label that depended on
it is silently stale. Deriving on read makes that impossible: a label cannot
contradict the graph, because it *is* the graph.

**Siblings are deliberately not stored.** Two children of one parent are
connected up-then-down through that parent. This costs one extra hop and buys
two things: half siblings and full siblings are distinguishable by counting
shared parents, and adding a parent automatically creates the right sibling
relationships without a backfill.

### 3.3 Status, not deletion

```
unverified ──► verification_requested ──► verified
     │                    │
     └────────────────────┴──► rejected  (kept, with a reason)
```

Only `verified` edges are traversed by default. A rejected relationship is kept
so the record shows that the question was asked and answered.

---

## 4. The relationship engine

`backend/engine/graph.js` and `backend/engine/relationship.js`.

### 4.1 Loading

Edges are loaded into an in-memory adjacency map, cached and invalidated by a
version counter that every write bumps. A stored `parent` edge becomes two
traversal directions:

```
parent(P, C)  →  C --up--> P      and      P --down--> C
```

For the scale this targets — tens of thousands of people — an adjacency map is
far faster than recursive SQL, and it is rebuilt only when the graph changes.

### 4.2 Path finding

Bidirectional BFS from both endpoints produces distance labels, which give the
exact shortest distance `d`. Paths are then enumerated by **iterative
deepening**: one depth-first pass per exact length, shortest first, pruned by
the backward distance label (`depth + 1 + distToTarget ≤ limit`).

> A plain depth-bounded DFS explores in neighbour order, so it can find a long
> path before a short one. Asked for a single path, it would hand back a detour
> and call it the shortest. That is not a theoretical concern — it produced
> *"great-grandfather's wife's daughter's husband's granddaughter"* where the
> correct answer was *"second cousin"*, and it is what the deepening loop exists
> to prevent.

### 4.3 Naming

A path is split into segments at every marriage and at every direction reversal.
Each consanguineous segment is a "V" through a common ancestor and is named from
the standard table:

| Up | Down | Term |
|----|------|------|
| 1 | 0 | father / mother |
| n | 0 | (n−2)× great- grandparent |
| 1 | 1 | brother / sister — *half* when only one parent is shared |
| k≥2 | 1 | (k−2)× great- uncle / aunt |
| 1 | k≥2 | (k−2)× great- nephew / niece |
| ≥2 | ≥2 | cousin, degree `min(up,down) − 1`, removed `\|up − down\|` |

Segments are then composed with possessives and simplified into the familiar
English idioms — *wife's mother* → **mother-in-law**, *father's wife* →
**step-mother**, *sibling's spouse* → **brother-in-law**.

A single-edge segment is named by `stepTerm` rather than the table, so an
adoptive mother is not flattened to "mother".

**Classification is separate from naming**, and it is what the UI shows as a
badge:

| Category | When |
|----------|------|
| `biological` | Only parent-child edges, all biological |
| `marital` | The path crosses a marriage — **never reported as blood** |
| `adoptive` | Includes an adoptive link |
| `step` | Includes a step or foster link |
| `mixed` | Marriage plus adoption or step |

### 4.4 Common ancestors

Ancestor sets are computed by following only `up` edges — marriage can never
turn an in-law into an ancestor — and intersected. Only the **most recent**
common ancestors are reported: an ancestor that is itself an ancestor of another
common ancestor is dropped, because naming a great-grandparent when the couple
actually share a parent would be misleading.

---

## 5. The matching engine

`backend/engine/matching.js`. This is where the project's central promise is
kept: similarity must never create a connection.

### 5.1 Retrieval, then scoring

Scoring is expensive, so a cheap indexed pass narrows the field first — same
normalised name, same phonetic key, same family name in a plausible birth-year
window, same given name and birth year, or an identical exact date of birth.

> The given-name-plus-year and exact-date clauses matter more than they look.
> A record abbreviated as *"Meenakshi R"* shares neither a normalised name nor a
> family name with *"Meenakshi Raghavan"* — without those clauses the commonest
> kind of duplicate would never even be compared.

### 5.2 Scoring

Weighted evidence with **present-weight normalisation**: a factor contributes
only when *both* records carry that information, and the score is damped when
little was comparable. Two records that share only a name cannot reach the top
of the scale by default.

| Factor | Weight |
|--------|--------|
| Full name | 0.30 |
| Date of birth | 0.20 |
| Parent names | 0.18 |
| Family name | 0.11 |
| Given name | 0.09 |
| Spouse names | 0.09 |
| Birthplace | 0.07 |
| Children names | 0.06 |
| Date of death | 0.06 |
| Gender | 0.04 |

Name similarity uses Jaro-Winkler over best-paired tokens, so reordered names
still match, with a penalty when one name has far more tokens than the other.
Name weight is reduced further when that exact name is common in the database.

### 5.3 Conflicts are decisive

Agreement raises a score. Disagreement can end it.

| Conflict | Effect |
|----------|--------|
| Two exact but different dates of birth | `× 0.12` — suppressed |
| Two known but different genders | `× 0.12` — suppressed |
| Birth years differing beyond tolerance | `× 0.55` |
| Both name parents, none matching | `× 0.55` |
| One died, the other is living | `× 0.55` |

This is what keeps the two unrelated men named *Ramesh Iyer* apart no matter how
well their names agree.

### 5.4 Bands, and what "strong" does not mean

```
score < 0.55            weak       discarded
0.55 ≤ score < 0.88     possible   Possible Match
score ≥ 0.88            strong     Possible Match  ← still
  AND ≥2 corroborating non-name factors
```

A pair can reach `strong` only with **two independent non-name factors** in
agreement. A name alone never gets there.

And `strong` changes nothing procedurally: it is still a Possible Match, still
requires human verification, and still merges nothing. The band affects how
prominently the card is presented, not what the system is permitted to do.

---

## 6. The verification workflow

```
Possible Match  ──accept──►  verification_requested  ──approve──►  MERGED
      │                              │
      └──reject──► rejected          └──reject──► rejected, with a reason
```

Everything about this is deliberate:

- **A scan can only write `possible`.** There is no code path from a scan to a
  verified relationship.
- **Accepting is an opinion, not an action.** The response literally reports
  `merged: false, connected: false`.
- **The requester cannot approve their own request.** It is assigned to the
  other tree's owner.
- **A cross-tree merge needs both families.** Authorisation rests on the
  requester and the approver *between them* covering both trees — which is what
  proposing and approving establishes. Requiring the approver to separately hold
  editor rights on a stranger's tree would make the workflow impossible in
  exactly the case it exists to serve.
- **A merge is reversible in principle.** `person_merges` stores a full snapshot
  of the record that was merged away.

---

## 7. Privacy enforcement

`backend/lib/privacy.js` is the single gate through which person data reaches a
client. Routes never serialise a raw row; they call `viewPerson()`.

```
accessLevel(viewer, owner) →  owner > verifier > editor > suggester > viewer > public > none

visibility = private  →  owner only
visibility = family   →  active collaborators
visibility = public   →  any signed-in user
```

On top of that, `hide_living_details` withholds exact dates, places and notes for
people who are alive from anyone who cannot edit the tree. The name and the
graph position remain — you can see that a relative exists and how they connect,
without their address.

Two decisions worth calling out:

- **A private record returns 404, not 403.** Confirming that a record exists is
  itself a disclosure.
- **A consenting account holder's own record is reachable as a search target.**
  `allow_relationship_search` (on by default, and described in the UI as exactly
  that) is the consent. Without honouring it, a new account — whose own record
  defaults to Family Only — could never be the target of a relationship search,
  making the headline feature unusable between people who have not already met.
  The consent is narrow: it covers that one record, and living-person hiding
  still applies.

---

## 8. The biometric gateway

### 8.1 Why the browser starts the handshake

```
BROWSER                    SERVER                      ESP32
   │                          │                          │
   │──POST /challenge────────►│                          │
   │◄──{ challengeId, code }──│                          │
   │   shows code             │◄──GET /device/poll───────│  signed
   │                          │───{ code }──────────────►│  shows code on LCD
   │                          │                          │
   │                          │      user compares the two codes,
   │                          │      then places a finger
   │                          │                          │
   │                          │◄──POST /device/scan──────│  signed
   │                          │   { slot, confidence,    │
   │                          │     code }               │
   │                          │──{ outcome, lcd }───────►│
   │──GET /challenge/:id─────►│                          │
   │◄──{ session token }──────│                          │
```

The session is released to **the browser that asked for it**. A scanner on its
own can never mint a session for someone else's browser, and the six-character
code shown in both places is what stops a scanner in another room answering your
sign-in.

**The device never receives a session token.** A stolen scanner cannot sign
anyone in anywhere.

### 8.2 Request signing

```
HMAC-SHA256(DEVICE_KEY, "<deviceId>|<timestamp>|<nonce>|<payload>")
```

The payload is a short canonical string per endpoint rather than the raw JSON,
so the firmware does not need a JSON serialiser to reproduce it byte for byte.

Two independent defences against replay: the timestamp must be within the
clock-skew window (which is why NTP sync is mandatory on the device), and each
nonce is accepted exactly once per device.

### 8.3 What is stored

| Where | What |
|-------|------|
| Sensor flash | The fingerprint template. Never transmitted. |
| Database | The slot number, its device, and `HMAC(APP_SECRET, device:slot:user)` |
| Anywhere else | Nothing |

The sensor performs the comparison itself and returns a slot number. No image or
template ever reaches the network or the application.

---

## 9. The AI layer

`backend/ai/` produces four kinds of suggestion: possible duplicates, cross-tree
connections, missing links the data implies, and data-quality observations such
as a parent who would have been eleven years old.

Two modes:

| `AI_ENABLED` | Behaviour |
|--------------|-----------|
| `false` (default) | Local deterministic heuristics. No network, no key, works offline. |
| `true` | The same heuristics run first, then Claude reviews the shortlist and writes the rationale. |

The constraints are structural, not advisory:

- The model sees **only the evidence the rule engine already computed** — never
  the raw database.
- It can change ranking and wording. It **cannot** create, verify or delete a
  relationship, and it cannot raise a suggestion past `possible`.
- **It cannot promote a suppressed pair.** The rule engine's conflict decisions
  stand regardless of what the model says.
- A failed or slow call degrades to the heuristic result. The feature never
  blocks the application.

---

## 10. The frontend

A hash router with lazily imported views. No framework, no build step.

**The tree renderer** (`tree-render.js`) is plain SVG:

- Nodes are grouped into generation bands; within each band, four passes of the
  barycentre heuristic order people by their parents' positions to reduce edge
  crossings, then spouses are pulled adjacent.
- Parent links are orthogonal connectors, marriages a direct bar. Verified links
  are solid, unverified dashed — always, so nobody has to consult a legend to
  know whether a link is confirmed.
- Zoom, pan and pinch operate on a single group transform.
- Colours go through the inline `style` attribute, not presentation attributes,
  because `var()` does not resolve in a presentation attribute — that is what
  lets the tree follow the light/dark theme.
- The client never loads the whole graph: it requests a window around a focus
  person and pulls in branches on demand.

**Export** renders the server's SVG to a canvas and writes a single-page PDF by
hand (~60 lines) rather than shipping a PDF library for one feature.

---

## 11. Request lifecycle

```
request
  → security headers, CORS
  → route match (404 / 405)
  → rate limit by class and IP        → 429
  → resolve session from cookie/bearer
  → public route? no, and no session  → 401
  → parse and size-check the JSON body → 413 / 400
  → handler
      → validate(body, schema)         → 422  (unknown keys dropped)
      → privacy gate on every read     → 404
      → transaction for writes
      → audit entry
      → graph cache invalidation
  → JSON response
```

Anything thrown that is not an `AppError` is logged server-side and returned as a
generic 500. Internal details never reach the client.

---

## 12. Scaling

Honest limits, and what each one needs.

| Component | Holds to | Then |
|-----------|----------|------|
| SQLite | ~50k people, single writer | PostgreSQL; Neo4j for very large graphs |
| In-memory graph | ~100k edges per process | Partitioned loading, or a graph database |
| In-memory rate limits | One process | Redis |
| Full-graph reload on write | Frequent writes | Incremental adjacency updates |
| BFS traversal | Fine — `O(V+E)` with a node budget | Precomputed ancestor tables |

The structure anticipates this: `loadGraph()` already takes a status filter and
could take an owner partition; the rate limiter's interface is a single
`consume()` call; and the engine works on a plain graph object, which is why it
can be tested without a database at all.
