-- =============================================================================
--  GLOBAL FAMILY TREE & ANCESTRY MAPPING SYSTEM  --  SQLite schema  (v1)
-- =============================================================================
--  DESIGN NOTES
--  1. A USER (login account) and a PERSON (node in the family graph) are
--     deliberately separate entities. `users.self_person_id` links an account
--     to the person it represents. Several users may eventually reference the
--     same real-world person -- but only after human verification.
--  2. Relationships are stored as structured GRAPH EDGES, never as text labels.
--     Only three canonical edge types are persisted:
--         parent  : directed,   from_person_id = parent, to_person_id = child
--         spouse  : symmetric,  stored once, canonical order from < to
--         sibling : symmetric,  stored once, canonical order from < to
--                   (used only when the shared parents are unknown; otherwise
--                    siblinghood is DERIVED from shared parent edges)
--     Every other relationship (grandparent, uncle, cousin, in-law, ...) is
--     COMPUTED by the relationship engine. This keeps the graph normalized and
--     makes it impossible for a derived label to contradict the stored data.
--  3. Only rows with status = 'verified' are treated as confirmed graph edges.
--  4. Nothing in this schema stores a raw fingerprint image or template.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL
);

-- ================================= USERS ====================================
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT    NOT NULL UNIQUE,           -- UUID exposed to clients
  email             TEXT    NOT NULL UNIQUE,           -- stored lower-cased
  password_hash     TEXT    NOT NULL,                  -- scrypt$N$r$p$salt$hash
  display_name      TEXT    NOT NULL,
  role              TEXT    NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user','moderator','admin')),
  status            TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleted')),
  self_person_id    INTEGER UNIQUE REFERENCES persons(id) ON DELETE SET NULL,
  email_verified_at TEXT,
  last_login_at     TEXT,
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  is_synthetic      INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- =============================== SESSIONS ===================================
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,   -- SHA-256 of the bearer token
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_method  TEXT    NOT NULL DEFAULT 'password'
               CHECK (auth_method IN ('password','biometric')),
  device_id    INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,
  requested_ip TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

-- ================================ PERSONS ===================================
CREATE TABLE IF NOT EXISTS persons (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  given_name         TEXT    NOT NULL,
  middle_name        TEXT,
  family_name        TEXT,
  maiden_name        TEXT,
  display_name       TEXT    NOT NULL,        -- rendered full name
  name_normalized    TEXT    NOT NULL,        -- lower, unaccented, punct-free
  name_phonetic      TEXT,                    -- soundex key, for fuzzy search

  gender             TEXT    NOT NULL DEFAULT 'unknown'
                     CHECK (gender IN ('male','female','other','unknown')),

  birth_date         TEXT,                    -- ISO-8601 'YYYY-MM-DD'
  birth_precision    TEXT    NOT NULL DEFAULT 'exact'
                     CHECK (birth_precision IN ('exact','month','year','about','unknown')),
  birth_year         INTEGER,                 -- denormalized for fast matching
  birth_place        TEXT,

  death_date         TEXT,
  death_precision    TEXT    NOT NULL DEFAULT 'exact'
                     CHECK (death_precision IN ('exact','month','year','about','unknown')),
  death_place        TEXT,
  is_living          INTEGER NOT NULL DEFAULT 1 CHECK (is_living IN (0,1)),

  occupation         TEXT,
  current_place      TEXT,
  photo_path         TEXT,
  notes              TEXT,

  visibility         TEXT    NOT NULL DEFAULT 'family'
                     CHECK (visibility IN ('private','family','public')),
  -- Merge bookkeeping: a duplicate that was merged away points at the survivor.
  merged_into_id     INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  merged_at          TEXT,

  is_synthetic       INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  data_label         TEXT,                    -- e.g. 'SYNTHETIC / DEMONSTRATION DATA'
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (death_date IS NULL OR birth_date IS NULL OR death_date >= birth_date),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_persons_owner    ON persons(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_persons_norm     ON persons(name_normalized);
CREATE INDEX IF NOT EXISTS idx_persons_phonetic ON persons(name_phonetic);
CREATE INDEX IF NOT EXISTS idx_persons_byear    ON persons(birth_year);
CREATE INDEX IF NOT EXISTS idx_persons_vis      ON persons(visibility);
CREATE INDEX IF NOT EXISTS idx_persons_merged   ON persons(merged_into_id);
CREATE INDEX IF NOT EXISTS idx_persons_family   ON persons(family_name);
-- Retrieval indexes for the matching engine (see engine/matching.js).
CREATE INDEX IF NOT EXISTS idx_persons_given_year ON persons(given_name, birth_year);
CREATE INDEX IF NOT EXISTS idx_persons_birthdate  ON persons(birth_date);

-- ============================= RELATIONSHIPS ================================
CREATE TABLE IF NOT EXISTS relationships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  from_person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  to_person_id    INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,

  -- Canonical edge type. Everything else is computed by the engine.
  type            TEXT    NOT NULL CHECK (type IN ('parent','spouse','sibling')),

  -- Nature of the bond -- drives biological vs. non-biological path labelling.
  subtype         TEXT    NOT NULL DEFAULT 'biological'
                  CHECK (subtype IN ('biological','adoptive','step','foster',
                                     'guardian','married','partner','divorced',
                                     'widowed','full','half','unknown')),

  status          TEXT    NOT NULL DEFAULT 'unverified'
                  CHECK (status IN ('unverified','possible','verification_requested',
                                    'verified','rejected')),

  confidence      REAL    NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  source          TEXT    NOT NULL DEFAULT 'user'
                  CHECK (source IN ('user','import','match','ai','seed')),

  start_date      TEXT,                       -- e.g. marriage date
  end_date        TEXT,                       -- e.g. divorce date
  notes           TEXT,

  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at     TEXT,
  rejected_reason TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  -- No self-loops; symmetric edge types are stored exactly once in a
  -- canonical low-id -> high-id order so UNIQUE below cannot be bypassed.
  CHECK (from_person_id <> to_person_id),
  CHECK (type = 'parent' OR from_person_id < to_person_id),
  CHECK (
    (type = 'parent'  AND subtype IN ('biological','adoptive','step','foster','guardian','unknown')) OR
    (type = 'spouse'  AND subtype IN ('married','partner','divorced','widowed','unknown')) OR
    (type = 'sibling' AND subtype IN ('full','half','step','adoptive','unknown'))
  ),
  UNIQUE (from_person_id, to_person_id, type)
);
CREATE INDEX IF NOT EXISTS idx_rel_from   ON relationships(from_person_id, type, status);
CREATE INDEX IF NOT EXISTS idx_rel_to     ON relationships(to_person_id, type, status);
CREATE INDEX IF NOT EXISTS idx_rel_status ON relationships(status);
CREATE INDEX IF NOT EXISTS idx_rel_type   ON relationships(type);

-- ================================ EVENTS ====================================
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT    NOT NULL UNIQUE,
  person_id         INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  related_person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL, -- e.g. spouse
  type              TEXT    NOT NULL
                    CHECK (type IN ('birth','death','marriage','divorce','adoption',
                                    'graduation','migration','military','residence',
                                    'occupation','other')),
  title             TEXT    NOT NULL,
  description       TEXT,
  event_date        TEXT,
  date_precision    TEXT    NOT NULL DEFAULT 'exact'
                    CHECK (date_precision IN ('exact','month','year','about','unknown')),
  event_year        INTEGER,
  place             TEXT,
  visibility        TEXT    NOT NULL DEFAULT 'family'
                    CHECK (visibility IN ('private','family','public')),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_synthetic      INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_person ON events(person_id);
CREATE INDEX IF NOT EXISTS idx_events_year   ON events(event_year);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type);

-- =========================== PRIVACY SETTINGS ===============================
CREATE TABLE IF NOT EXISTS privacy_settings (
  user_id                   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_person_visibility TEXT NOT NULL DEFAULT 'family'
                            CHECK (default_person_visibility IN ('private','family','public')),
  profile_visibility        TEXT NOT NULL DEFAULT 'family'
                            CHECK (profile_visibility IN ('private','family','public')),
  -- Hide dates/places of people still alive, even from permitted viewers.
  hide_living_details       INTEGER NOT NULL DEFAULT 1 CHECK (hide_living_details IN (0,1)),
  -- Opt in/out of being offered as a candidate in cross-tree match discovery.
  allow_match_discovery     INTEGER NOT NULL DEFAULT 1 CHECK (allow_match_discovery IN (0,1)),
  -- Opt in/out of "How am I related to this person?" reaching this tree.
  allow_relationship_search INTEGER NOT NULL DEFAULT 1 CHECK (allow_relationship_search IN (0,1)),
  allow_ai_suggestions      INTEGER NOT NULL DEFAULT 1 CHECK (allow_ai_suggestions IN (0,1)),
  show_in_directory         INTEGER NOT NULL DEFAULT 1 CHECK (show_in_directory IN (0,1)),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== COLLABORATION / PERMISSIONS ==========================
CREATE TABLE IF NOT EXISTS tree_collaborators (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- viewer   : read the tree
  -- suggester: read + propose persons/relationships (created as 'unverified')
  -- editor   : read + create/edit persons and relationships
  -- verifier : editor + approve/reject verification requests
  role            TEXT    NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer','suggester','editor','verifier')),
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','revoked','declined')),
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at    TEXT,
  UNIQUE (owner_user_id, grantee_user_id),
  CHECK (owner_user_id <> grantee_user_id)
);
CREATE INDEX IF NOT EXISTS idx_collab_owner   ON tree_collaborators(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_collab_grantee ON tree_collaborators(grantee_user_id, status);

-- ======================= IoT DEVICES (ESP32 nodes) ==========================
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        TEXT    NOT NULL UNIQUE,   -- printed on the enclosure, e.g. ESP32-LAB-01
  name             TEXT    NOT NULL,
  api_key_hash     TEXT    NOT NULL,          -- SHA-256 of the shared device key
  location         TEXT,
  status           TEXT    NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','disabled','revoked')),
  owner_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  firmware_version TEXT,
  ip_address       TEXT,
  last_seen_at     TEXT,
  last_error       TEXT,
  is_simulated     INTEGER NOT NULL DEFAULT 0 CHECK (is_simulated IN (0,1)),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

-- Maps a fingerprint TEMPLATE SLOT on a specific sensor to an application user.
-- The raw fingerprint template never leaves the sensor; only the slot number
-- (an integer the sensor assigns at enrolment) is stored here, together with a
-- keyed hash so the mapping cannot be forged by guessing slot numbers alone.
CREATE TABLE IF NOT EXISTS biometric_mappings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT    NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sensor_slot_id  INTEGER NOT NULL CHECK (sensor_slot_id >= 0),
  credential_hash TEXT    NOT NULL,           -- HMAC(APP_SECRET, device||slot||user)
  label           TEXT    NOT NULL DEFAULT 'Right index finger',
  status          TEXT    NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','locked','revoked')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  enrolled_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  enrolled_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used_at    TEXT,
  -- One physical sensor slot can only ever point at one account.
  UNIQUE (device_id, sensor_slot_id)
);
CREATE INDEX IF NOT EXISTS idx_bio_user   ON biometric_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_bio_status ON biometric_mappings(status);

-- Browser-initiated challenge that the ESP32 answers. This keeps the session
-- token on the browser that started the login, so a scanner on its own can
-- never mint a session for an attacker's browser.
CREATE TABLE IF NOT EXISTS biometric_challenges (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT    NOT NULL UNIQUE,
  code               TEXT    NOT NULL,        -- 6 chars, shown on screen AND LCD
  device_id          INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  purpose            TEXT    NOT NULL DEFAULT 'login'
                     CHECK (purpose IN ('login','enroll','verify')),
  status             TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','claimed','fulfilled','consumed','failed','expired')),
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- filled on success
  session_token_hash TEXT,                    -- one-time pickup of the session
  browser_ip         TEXT,
  detail             TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  claimed_at         TEXT,
  fulfilled_at       TEXT,
  expires_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chal_device ON biometric_challenges(device_id, status);
CREATE INDEX IF NOT EXISTS idx_chal_exp    ON biometric_challenges(expires_at);

-- Replay protection: every signed device request carries a unique nonce.
CREATE TABLE IF NOT EXISTS device_nonces (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce     TEXT    NOT NULL,
  seen_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonce_seen ON device_nonces(seen_at);

CREATE TABLE IF NOT EXISTS biometric_auth_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sensor_slot_id INTEGER,
  outcome        TEXT    NOT NULL
                 CHECK (outcome IN ('success','unknown_slot','locked','low_confidence',
                                    'no_challenge','bad_signature','replay','device_disabled','error')),
  confidence     INTEGER,
  ip             TEXT,
  detail         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_biolog_created ON biometric_auth_log(created_at);
CREATE INDEX IF NOT EXISTS idx_biolog_device  ON biometric_auth_log(device_id);

-- ========================== MATCHING & VERIFICATION =========================
CREATE TABLE IF NOT EXISTS match_suggestions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id              TEXT    NOT NULL UNIQUE,
  -- duplicate   : the two person records may be the SAME human being
  -- connection  : two different people whose trees may join here
  -- relationship: a missing edge suggested between two known persons
  kind                   TEXT    NOT NULL
                         CHECK (kind IN ('duplicate','connection','relationship')),
  person_a_id            INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  person_b_id            INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  suggested_relationship TEXT,                -- for kind='relationship'
  score                  REAL    NOT NULL CHECK (score BETWEEN 0 AND 1),
  band                   TEXT    NOT NULL DEFAULT 'possible'
                         CHECK (band IN ('weak','possible','strong')),
  evidence               TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  rationale              TEXT,                -- human-readable explanation
  source                 TEXT    NOT NULL DEFAULT 'rule'
                         CHECK (source IN ('rule','ai','user')),
  ai_model               TEXT,
  status                 TEXT    NOT NULL DEFAULT 'possible'
                         CHECK (status IN ('possible','verification_requested','accepted','rejected','dismissed')),
  reviewed_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at            TEXT,
  review_note            TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (person_a_id < person_b_id),          -- canonical pair ordering
  UNIQUE (person_a_id, person_b_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_match_status ON match_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_match_a      ON match_suggestions(person_a_id);
CREATE INDEX IF NOT EXISTS idx_match_b      ON match_suggestions(person_b_id);
CREATE INDEX IF NOT EXISTS idx_match_score  ON match_suggestions(score DESC);

CREATE TABLE IF NOT EXISTS verification_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,
  subject_type  TEXT    NOT NULL
                CHECK (subject_type IN ('relationship','match','person_merge')),
  subject_id    INTEGER NOT NULL,             -- FK enforced in application layer
  requested_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','approved','rejected','withdrawn','expired')),
  message       TEXT,
  decision_note TEXT,
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vr_assigned  ON verification_requests(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_vr_subject   ON verification_requests(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_vr_requester ON verification_requests(requested_by);

-- Audit record of duplicate persons that were merged after verification.
CREATE TABLE IF NOT EXISTS person_merges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  surviving_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  merged_id    INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  match_id     INTEGER REFERENCES match_suggestions(id) ON DELETE SET NULL,
  approved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  snapshot     TEXT NOT NULL,                 -- JSON of the merged record, for undo
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================ CHANGE HISTORY ================================
CREATE TABLE IF NOT EXISTS change_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_label   TEXT,                         -- preserved if the user is deleted
  entity_type   TEXT    NOT NULL
                CHECK (entity_type IN ('person','relationship','event','match',
                                       'verification','user','privacy','collaborator',
                                       'device','biometric','session','export')),
  entity_id     INTEGER,
  entity_label  TEXT,                         -- e.g. the person's name at the time
  action        TEXT    NOT NULL,             -- 'Person Added', 'Relationship Verified', ...
  field         TEXT,
  old_value     TEXT,
  new_value     TEXT,
  detail        TEXT,
  ip            TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hist_entity  ON change_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_hist_actor   ON change_history(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_hist_created ON change_history(created_at DESC);

-- ============================= NOTIFICATIONS ================================
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id  TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL
             CHECK (type IN ('match','verification','collaboration','security',
                             'biometric','system','relationship')),
  severity   TEXT    NOT NULL DEFAULT 'info'
             CHECK (severity IN ('info','success','warning','critical')),
  title      TEXT    NOT NULL,
  body       TEXT,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

-- ============================== SECURITY LOG ================================
CREATE TABLE IF NOT EXISTS security_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT    NOT NULL,
  severity   TEXT    NOT NULL DEFAULT 'info'
             CHECK (severity IN ('info','warning','critical')),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip         TEXT,
  route      TEXT,
  detail     TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seclog_created ON security_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seclog_event   ON security_log(event);

-- ================================= VIEWS ====================================
-- Only verified edges may be treated as confirmed graph edges.
CREATE VIEW IF NOT EXISTS v_verified_edges AS
  SELECT r.id, r.from_person_id, r.to_person_id, r.type, r.subtype, r.status
  FROM relationships r
  WHERE r.status = 'verified';

-- Live persons excluding records that were merged away.
CREATE VIEW IF NOT EXISTS v_active_persons AS
  SELECT * FROM persons WHERE merged_into_id IS NULL;
