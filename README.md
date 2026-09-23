# Global Family Tree & Ancestry Mapping System

A secure, biometric-enabled platform where individual family trees gradually
connect through **verified** common ancestors — so people can discover how they
are related without the system ever guessing on their behalf.

Sign in with a fingerprint over ESP32 hardware, build your tree, and ask
*"how am I related to this person?"* The answer comes from traversing a graph of
relationships that a human has confirmed. Nothing connects two families until
someone says so.

```
Fingerprint sensor → ESP32 → Wi-Fi → Backend API → Relationship engine → Dashboard
```

---

## The three rules this system is built around

1. **A fingerprint identifies an account. It is never evidence of a
   relationship.** Biometrics answer "who is standing here?" — nothing more.
   Family relationships come only from tree data that a person has verified.
2. **Similarity never creates a connection.** Two records that share a name and
   a birth year become a *Possible Match* with the evidence laid out. They are
   merged only after an authorised human approves it.
3. **AI suggests. People decide.** The assistant can rank candidates, spot
   likely duplicates and explain its reasoning. It cannot create, verify or
   delete a relationship.

---

## Quick start

**Requirements:** Node.js **22.5 or newer**. That is all — there are **no npm
dependencies**.

```bash
git clone <your-repository-url>
cd global-family-tree
cp .env.example .env          # Windows: copy .env.example .env
npm run db:seed               # creates the database and loads the demo data
npm start
```

Open **<http://localhost:4000>**.

Sign in with any demonstration account — the sign-in page lists them and fills
them in for you:

| Email | Who | Password |
|-------|-----|----------|
| `arjun@demo.familytree.local` | Arjun Raghavan, Chennai | `DemoPassword#2026` |
| `priya@demo.familytree.local` | Priya Iyer, Madurai | `DemoPassword#2026` |
| `rohit@demo.familytree.local` | Rohit Sharma, Delhi | `DemoPassword#2026` |
| `maria@demo.familytree.local` | Maria D'Souza, Goa | `DemoPassword#2026` |
| `chidi@demo.familytree.local` | Chidi Okafor, Lagos | `DemoPassword#2026` |
| `admin@demo.familytree.local` | Administrator | `DemoPassword#2026` |

Every record in the demo data is invented and flagged **SYNTHETIC /
DEMONSTRATION DATA**.

### No hardware? Everything still works

The application includes a **Virtual ESP32 Scanner** (sidebar → *Hardware demo*)
that speaks the identical signed protocol to the real firmware — same
HMAC-SHA256 signature, same nonces, same endpoints. You can build, test and
demonstrate the complete biometric flow before any components arrive.

---

## The demonstration, in seven steps

This is the scenario the whole project is designed around. It takes about three
minutes.

1. **Sign in as Arjun** and open **How am I related?**. Search for *Priya Iyer*
   and ask. The answer: **no verified relationship path**. Their trees are
   genuinely unconnected.
2. Open **Possible Matches** and press **Run a scan**. The system compares
   Arjun's people against every tree whose owner allows discovery.
3. It surfaces **Venkatesh Raghavan**, recorded independently by both Arjun and
   Priya, at **97% similarity** — same date of birth, same birthplace, same
   spouse. Status: **Possible Match**. Nothing has been connected.
4. Press **"These are the same — request verification"**. Note what the response
   says: *merged: false, connected: false*. A verification request has gone to
   Priya. The trees are still apart.
5. **Sign in as Priya.** The request is in her Verifications inbox with the full
   evidence. She approves it, choosing which record survives.
6. **Search again.** Arjun and Priya are now **second cousins**, with the path
   shown step by step and **Venkatesh Raghavan** named as the common ancestor,
   three generations from each of them.
7. Open **Change History**. Every step — the scan, the proposal, the approval,
   the merge — is recorded with who did it and when.

Then try the cases that are supposed to *fail*:

- Search for a relationship to **Chidi Okafor**. His tree connects to nothing,
  and the system says so plainly rather than inventing a link.
- Sign in as **Rohit** and look for *Ramesh Iyer*. Two different people share
  that name in two different trees, born 18 years apart. The engine refuses to
  rank them as a likely match — conflicting dates of birth are decisive.
- Ask how **Rohit** and **Maria** are related. They are connected, but through a
  marriage: *"sister's husband's sister"*, labelled **by marriage**, not blood.

---

## What is here

| Area | What it does |
|------|--------------|
| **Interactive family tree** | Custom SVG renderer. Zoom, pan, search, focus, progressive branch loading. Verified links solid, unverified dashed. |
| **Relationship engine** | Bidirectional BFS with iterative deepening over a graph of `parent` / `spouse` / `sibling` edges. Names cousins by degree and remove, distinguishes blood from in-law, keeps adoptive and step links labelled. |
| **Possible-match system** | Weighted evidence scoring with present-weight normalisation, name-frequency damping and decisive conflict suppression. |
| **Verification workflow** | The only path from *possible* to *verified*. Cross-tree merges need both families to consent. |
| **AI layer** | Local heuristics by default; optionally consults the Claude API to rank and explain. Advisory only. |
| **Biometric gateway** | Browser-initiated, challenge-bound device login. HMAC-signed, nonce-protected, clock-skew checked. |
| **Privacy** | Private / Family Only / Public, enforced when data is read from the database, not hidden in the UI. |
| **Collaboration** | Four roles — viewer, suggester, editor, verifier — checked server-side on every request. |
| **Audit trail** | Every mutation records actor, action, old value, new value and time. |
| **Timeline** | Births and deaths derived from person records, so they cannot drift out of step. |
| **Export** | JSON, **GEDCOM 5.5.1**, SVG, PNG and PDF. Backup and restore. |

---

## Project layout

```
global-family-tree/
├── backend/
│   ├── server.js              HTTP server, routing, static files
│   ├── config.js              environment loading and validation
│   ├── db/                    schema application, migrations, connection
│   ├── lib/                   http, auth, privacy, validation, audit, text
│   ├── engine/                graph traversal, kinship naming, matching
│   ├── ai/                    suggestion layer and the Claude provider
│   └── routes/                15 route modules, 97 endpoints
├── frontend/
│   ├── index.html             application shell
│   ├── css/app.css            design system, light and dark
│   └── js/
│       ├── app.js             hash router and navigation
│       ├── tree-render.js     the SVG family-tree renderer
│       ├── export-pdf.js      client-side PNG and PDF generation
│       └── views/             one module per page
├── database/schema.sql        20 tables, fully commented
├── esp32-firmware/
│   ├── global_family_tree_node/    main firmware
│   └── global_family_tree_enroll/  fingerprint enrolment utility
├── scripts/
│   ├── seed-synthetic-data/   demo dataset and its self-checks
│   └── register-device.js     register a scanner from the command line
├── tests/                     51 tests: engine, matching, API, privacy
└── docs/                      architecture, api, database, hardware, setup
```

---

## Commands

| Command | What it does |
|---------|--------------|
| `npm start` | Run the server |
| `npm run dev` | Run with automatic restart on file changes |
| `npm test` | Run all 51 tests |
| `npm run db:migrate` | Create or update the schema |
| `npm run db:seed` | Load the synthetic demonstration data |
| `npm run db:reset` | Wipe everything and reload the demo data |
| `npm run db:stats` | Report what is in the database |
| `npm run device:register` | Register an ESP32 scanner and print its key |

---

## Hardware

Full guide: **[docs/hardware-wiring.md](docs/hardware-wiring.md)** — parts list,
pin tables, wiring diagram, power budget, flashing, and a troubleshooting table.

**Parts:** ESP32 DevKit V1 (WROOM-32) · R307 fingerprint sensor · 16×2 I²C LCD ·
**bidirectional level converter** · 5 V 2 A supply.

**Pin map:**

| Connection | ESP32 pin |
|------------|-----------|
| Fingerprint TX → | `GPIO16` (RX2) |
| Fingerprint RX ← | `GPIO17` (TX2) |
| LCD SDA (via level converter) | `GPIO21` |
| LCD SCL (via level converter) | `GPIO22` |
| Status LED | `GPIO2` |

> **The one thing not to skip:** a 16×2 LCD needs 5 V for readable contrast, and
> its I²C backpack pulls SDA/SCL up to that rail. ESP32 pins are **not** 5 V
> tolerant. Use a level converter, or run the LCD at 3.3 V and accept a dim
> display. [Section 3.1](docs/hardware-wiring.md#31-the-5-v-i²c-problem--read-this-before-wiring-the-lcd)
> explains the three correct options.

**The fingerprint sensor connects directly** — the R307's UART is 3.3 V even
when powered from 5 V.

---

## Configuration

Everything is set in `.env`; `.env.example` documents every value. Nothing
sensitive is hard-coded anywhere in the source.

The settings that matter most:

| Variable | Default | Notes |
|----------|---------|-------|
| `APP_SECRET` | — | **Required in production.** Signs sessions, reset tokens and device keys. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `DEMO_ALLOW_SIMULATED_DEVICE` | `true` | Must be `false` in production — a simulated scanner has no physical possession factor. |
| `AI_ENABLED` | `false` | `true` plus `ANTHROPIC_API_KEY` adds model-assisted review. Works fully offline when off. |
| `MATCH_MIN_SCORE` | `0.55` | Below this a candidate is discarded. |
| `MATCH_STRONG_SCORE` | `0.88` | "Strong" also requires two corroborating non-name factors. Still only a Possible Match. |

---

## Security

- **scrypt** password hashing with self-describing parameters, so the cost can
  be raised later without invalidating existing hashes.
- **Session tokens** are random 32-byte values; only their SHA-256 hash is
  stored. HttpOnly, SameSite=Lax, Secure in production.
- **Device requests** are HMAC-SHA256 signed with a one-time nonce and a
  clock-skew window, so a captured request cannot be replayed.
- **Login timing is equalised** — an unknown email burns the same CPU as a real
  verification, so response time does not reveal which addresses are registered.
- **Rate limiting** per IP per route class; account lockout after repeated
  failures.
- **Privacy enforced at the data layer.** A private record returns 404, not 403 —
  confirming existence would itself leak information.
- **Parameterised SQL everywhere**; input validated and unknown keys dropped, so
  a client cannot smuggle `role: "admin"` into an update.
- **CSP, X-Frame-Options, nosniff** and a strict referrer policy on every
  response.
- **Uploads validated by magic number**, not by file extension.
- **No biometric data is stored.** Only the sensor's slot number and a keyed
  hash binding it to an account. No image or template ever leaves the sensor.

---

## Testing

```bash
npm test
```

51 tests across four areas:

- **Relationship engine** — the kinship table, cousin degrees and removes,
  in-law versus blood, half versus full siblings, adoptive and step links,
  cycle detection, multiple paths, no-path.
- **Matching** — identical names with conflicting dates must not rank as likely;
  conflicting genders are suppressed; a genuine duplicate scores high but stays
  a Possible Match.
- **API** — registration, login, reset, people, relationships, tree, export,
  GEDCOM, backup and restore.
- **The discovery flow** — the full six-step scenario above, asserting at each
  step that nothing has connected yet.

The seed script also runs **seven self-checks** every time it loads, confirming
the demo data still exercises the hard cases. If the dataset stops demonstrating
what it claims to, the seed fails loudly.

---

## Documentation

| Document | Contents |
|----------|----------|
| [docs/setup.md](docs/setup.md) | Installation, configuration, deployment, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | System design, data flow, engine internals, scaling |
| [docs/api.md](docs/api.md) | Every endpoint, with requests and responses |
| [docs/database.md](docs/database.md) | Schema, constraints, indexes, the graph model |
| [docs/hardware-wiring.md](docs/hardware-wiring.md) | Components, wiring, firmware, troubleshooting |

---

## What is production-ready, and what is not

Being straight about this matters more than a feature list.

**Production-shaped:**
the relationship engine · the matching engine and its conflict handling · the
verification workflow · the privacy enforcement layer · password hashing and
session management · the device signing protocol · the audit trail · schema
constraints and indexes · input validation.

**Prototype-grade, and why:**

| Component | Limitation | What production needs |
|-----------|-----------|----------------------|
| SQLite | Single-writer. Fine to tens of thousands of people. | PostgreSQL, or Neo4j for very large graphs |
| In-memory rate limiting | Per-process; resets on restart | Redis |
| In-memory graph cache | Rebuilt on every write; single-node | Partitioned loading or a graph database |
| Email | Writes reset links to the console | A real SMTP service |
| Simulated scanner | No physical possession factor | Disable it (`DEMO_ALLOW_SIMULATED_DEVICE=false`) |
| Plain HTTP by default | Fine on a lab network | TLS termination at a reverse proxy |
| Photo storage | Local filesystem | Object storage with signed URLs |

The boundary is drawn where correctness ends and operational scale begins. The
logic that decides *what is true about a family* is written to be correct; the
infrastructure around it is sized for a demonstration.

---

## Licence

MIT — see [LICENSE](LICENSE).

The synthetic dataset is entirely invented. It contains no real personal
information, and every record it creates is flagged as demonstration data.
