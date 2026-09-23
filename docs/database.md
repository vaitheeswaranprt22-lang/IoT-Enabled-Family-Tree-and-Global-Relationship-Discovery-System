# Database

SQLite via Node's built-in `node:sqlite`. 20 tables, 2 views, full referential
integrity. The complete DDL is in [`database/schema.sql`](../database/schema.sql),
which is commented throughout.

```bash
npm run db:migrate    # create or update the schema
npm run db:seed       # load the synthetic demonstration data
npm run db:reset      # wipe everything and reload
npm run db:stats      # report what is in there
```

Connection settings applied on open:

```sql
PRAGMA journal_mode = WAL;    -- readers never block the writer
PRAGMA foreign_keys = ON;     -- off by default in SQLite; this project needs it
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

WAL matters here because the ESP32 polls while a browser is reading the tree.

---

## Entity relationships

```
                    ┌──────────────┐
                    │    users     │
                    │  (accounts)  │
                    └──────┬───────┘
         self_person_id    │    created_by_user_id
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌───────────────┐                     ┌───────────────┐
│    persons    │◄────────────────────│ relationships │
│ (graph nodes) │   from_/to_person   │ (graph edges) │
└───────┬───────┘                     └───────────────┘
        │
        ├──► events                 births, marriages, migrations
        ├──► person_merges          reversible record of merges
        └──► match_suggestions      possible duplicates

┌──────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   devices    │────►│ biometric_mappings   │     │ biometric_challenges│
│ (ESP32 nodes)│     │ slot ↔ account       │     │ browser ↔ device    │
└──────┬───────┘     └──────────────────────┘     └─────────────────────┘
       ├──► device_nonces          replay protection
       └──► biometric_auth_log     every scan, successful or not

users ──► sessions, password_resets, privacy_settings, tree_collaborators,
          notifications, verification_requests, change_history, security_log
```

---

## The graph model

Only **three** edge types are ever stored:

| `type` | Direction | Meaning |
|--------|-----------|---------|
| `parent` | directed | `from_person_id` is the parent of `to_person_id` |
| `spouse` | symmetric | Stored once, canonical low → high id |
| `sibling` | symmetric | **Only** when the shared parents are unknown |

Everything else — grandparent, aunt, cousin, in-law, great-great-niece — is
computed by the relationship engine from these three. Nothing derived is ever
persisted, so a stored label can never contradict the graph.

### Why siblings are normally not stored

Two children of the same parent are connected **up-then-down** through that
parent. That costs one hop and buys two things:

1. **Half versus full siblings fall out of the data.** Count the shared parents:
   one is half, two is full. A stored `sibling` row would have to be corrected
   by hand whenever a parent was added.
2. **Adding a parent creates the right sibling relationships automatically.** No
   backfill, no chance of the two representations disagreeing.

An explicit `sibling` edge exists for the genuine case where two people are
known to be siblings but neither parent has been recorded.

### The constraints that make this safe

```sql
CHECK (from_person_id <> to_person_id)          -- no self-loops
CHECK (type = 'parent' OR from_person_id < to_person_id)
UNIQUE (from_person_id, to_person_id, type)
```

The second line is the interesting one. Forcing symmetric edges into a canonical
low → high order means `UNIQUE` catches a duplicate **regardless of the
direction it was submitted in** — you cannot create A–B and then B–A as two
separate marriages.

A third `CHECK` ties each subtype to its edge type, so a `spouse` row cannot be
marked `biological` and a `parent` row cannot be marked `divorced`.

Cycle prevention (nobody may become their own ancestor) is a **runtime** check in
`wouldCreateCycle()` — it needs a graph traversal, which SQL constraints cannot
express.

---

## Tables

### `users` — login accounts

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Internal only; never exposed |
| `public_id` | TEXT UNIQUE | UUID given to clients |
| `email` | TEXT UNIQUE | Stored lower-cased |
| `password_hash` | TEXT | `scrypt$N$r$p$salt$hash` |
| `role` | TEXT | `user` \| `moderator` \| `admin` |
| `status` | TEXT | `active` \| `suspended` \| `deleted` |
| `self_person_id` | INTEGER UNIQUE → persons | The person this account represents |
| `failed_logins`, `locked_until` | | Lockout state |
| `is_synthetic` | INTEGER | 1 for demo accounts |

The self-person link is `UNIQUE`, so one person record can represent at most one
account.

### `persons` — the nodes

| Column | Notes |
|--------|-------|
| `created_by_user_id` | The owning tree |
| `given_name`, `middle_name`, `family_name`, `maiden_name` | |
| `display_name` | Rendered full name |
| `name_normalized` | Lower-cased, unaccented, punctuation-free — indexed for search |
| `name_phonetic` | Soundex key per token — catches spelling drift |
| `birth_date`, `birth_precision`, `birth_year` | Precision: `exact`/`month`/`year`/`about`/`unknown` |
| `death_date`, `death_precision`, `is_living` | |
| `visibility` | `private` \| `family` \| `public` |
| `merged_into_id` | Set when merged away; the row is kept, not deleted |
| `is_synthetic`, `data_label` | Demo records carry `SYNTHETIC / DEMONSTRATION DATA` |

```sql
CHECK (death_date IS NULL OR birth_date IS NULL OR death_date >= birth_date)
CHECK (merged_into_id IS NULL OR merged_into_id <> id)
```

`birth_year` is denormalised from `birth_date` because the matching engine
filters on it constantly and needs it indexed.

**Precision is stored separately from the date.** A record that says only "about
1890" must not be compared as though it said 1890-01-01 — the matching engine
treats an approximate date and an exact one very differently.

### `relationships` — the edges

Covered above. Also carries `status`, `confidence`, `source`
(`user`/`import`/`match`/`ai`/`seed`), `start_date` and `end_date` (marriage and
divorce), `created_by`, `verified_by`, `verified_at` and `rejected_reason`.

### `biometric_mappings` — slot ↔ account

| Column | Notes |
|--------|-------|
| `sensor_slot_id` | The integer the sensor assigned at enrolment |
| `credential_hash` | `HMAC(APP_SECRET, device:slot:user)` |
| `status` | `active` \| `locked` \| `revoked` |
| | `UNIQUE (device_id, sensor_slot_id)` |

**No fingerprint image or template is stored here or anywhere else.** The
template lives in the sensor's own flash; the sensor performs the comparison and
returns only a slot number. The `UNIQUE` constraint guarantees one physical
sensor slot can only ever point at one account.

### `biometric_challenges` — the handshake

Holds the six-character `code`, the `device_id` it is bound to, a `status`
(`pending` → `claimed` → `fulfilled` → `consumed`), the `user_id` filled in on a
successful match, and an `expires_at`. `session_token_hash` records the one-time
pickup so a challenge cannot be redeemed twice.

### `device_nonces` — replay protection

`UNIQUE (device_id, nonce)`. Inserting is the check: a duplicate nonce raises a
constraint violation, which the route turns into a 401. Rows older than an hour
are purged by the housekeeping task.

### `match_suggestions` — possible matches

| Column | Notes |
|--------|-------|
| `kind` | `duplicate` \| `connection` \| `relationship` |
| `score` | 0–1 |
| `band` | `weak` \| `possible` \| `strong` |
| `evidence` | JSON: the factor array and the conflict array |
| `rationale` | Plain-English explanation shown to the reviewer |
| `source` | `rule` \| `ai` \| `user` |
| `status` | `possible` \| `verification_requested` \| `accepted` \| `rejected` \| `dismissed` |
| | `CHECK (person_a_id < person_b_id)`, `UNIQUE (person_a_id, person_b_id, kind)` |

The ordering `CHECK` plus `UNIQUE` means the same pair cannot be suggested twice
under different orderings.

A scan writes `status = 'possible'` and nothing else. A rescan never overwrites a
decision a human has already made.

### `verification_requests` — the gate

`subject_type` is `relationship`, `match` or `person_merge`; `subject_id` points
at the row. `requested_by` and `assigned_to` are different people by
construction — the requester cannot approve their own request.

### `change_history` — the audit trail

Every mutation writes a row: actor, entity type and id, entity label *as it was
at the time*, action, field, old value, new value, IP and timestamp.

`actor_label` duplicates the actor's name so the history stays readable after an
account is deleted (the FK is `ON DELETE SET NULL`).

### `person_merges` — reversible merges

Stores a full JSON `snapshot` of the merged-away person together with their
relationships and events, so a merge can be reconstructed and audited.

### Supporting tables

| Table | Purpose |
|-------|---------|
| `sessions` | Only the SHA-256 of each token; `auth_method` separates password from biometric |
| `password_resets` | Hashed, single-use, time-limited |
| `privacy_settings` | One row per user; read on every person access |
| `tree_collaborators` | `viewer` / `suggester` / `editor` / `verifier`, with `UNIQUE (owner, grantee)` |
| `devices` | Registered scanners; stores only `SHA-256(secret)` |
| `biometric_auth_log` | Every scan attempt and its outcome |
| `events` | Timeline entries beyond birth and death |
| `notifications` | User inbox |
| `security_log` | Sign-ins, lockouts, device failures |
| `schema_version` | Migration bookkeeping |

---

## Views

```sql
CREATE VIEW v_verified_edges AS
  SELECT … FROM relationships WHERE status = 'verified';

CREATE VIEW v_active_persons AS
  SELECT * FROM persons WHERE merged_into_id IS NULL;
```

Both make the default intent explicit in SQL: only verified edges count as
confirmed, and merged-away records are not live people.

---

## Indexes

| Table | Index | Serves |
|-------|-------|--------|
| `persons` | `name_normalized` | Exact and prefix name search |
| | `name_phonetic` | Fuzzy retrieval |
| | `birth_year` | Date-window filtering |
| | `(given_name, birth_year)` | **Matching retrieval** — see below |
| | `birth_date` | Exact-date matching |
| | `created_by_user_id` | Tree scoping, on nearly every query |
| | `family_name`, `visibility`, `merged_into_id` | Filters |
| `relationships` | `(from_person_id, type, status)` | Downward traversal |
| | `(to_person_id, type, status)` | Upward traversal |
| | `status`, `type` | Filtering |
| `match_suggestions` | `status`, `score DESC`, `person_a_id`, `person_b_id` | Match lists |
| `sessions` | `token_hash` (UNIQUE), `user_id`, `expires_at` | Session lookup and purge |
| `change_history` | `(entity_type, entity_id)`, `created_at DESC` | History screens |

> **Why `(given_name, birth_year)` earns its place.** A record abbreviated as
> *"Meenakshi R"* shares neither a normalised name nor a family name with
> *"Meenakshi Raghavan"*. Without this index — and the retrieval clause that
> uses it — the commonest kind of duplicate would never even be compared. It was
> added because the seed's own self-check caught exactly that miss.

---

## Transactions

`transaction(fn)` in `backend/db/index.js` wraps a function, rolling back on any
throw. It supports nesting via `SAVEPOINT`, so route handlers compose freely.

Operations that must be atomic:

- Registration — user, privacy settings and self-person together.
- Adding a person with a relationship in one request.
- A merge — repoint edges, move events, fill blanks, mark merged, write the
  snapshot.
- Approving a verification — update the request, act on the subject, write the
  audit entry.

---

## Housekeeping

Every five minutes the server:

- deletes sessions expired more than 7 days ago
- deletes used or stale password resets
- expires overdue biometric challenges, then deletes them after a day
- deletes device nonces older than an hour
- clears the access-level cache

---

## Backup

The database is a single file at `DATABASE_FILE` (default
`storage/familytree.db`).

```bash
# Safe copy of a live database, WAL included
sqlite3 storage/familytree.db ".backup 'storage/backup-$(date +%F).db'"
```

Copying the `.db` file while the server is running **without** `.backup` can miss
WAL contents. Stop the server first, or use the command above.

Per-user backups are available through the API — `GET /api/export/backup` — and
respect the privacy layer.
