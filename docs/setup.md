# Setup and installation

---

## 1. Requirements

| Requirement | Version | Why |
|-------------|---------|-----|
| **Node.js** | **22.5 or newer** | `node:sqlite` is built in from 22.5 |
| Git | any | To clone |
| A modern browser | Chrome 111+, Firefox 113+, Safari 16.4+ | The CSS uses `color-mix()` and `:has()` |

There are **no npm dependencies.** Nothing to install, nothing to keep up to
date, nothing that can fail on a lab machine the night before a demonstration.

```bash
node --version      # must print v22.5.0 or higher
```

If it is older, get the current LTS from <https://nodejs.org>. On Linux,
`nvm install 22 && nvm use 22`.

---

## 2. Install

```bash
git clone <your-repository-url>
cd global-family-tree

cp .env.example .env        # Windows: copy .env.example .env

npm run db:seed             # creates the database and loads the demo data
npm start
```

Open **<http://localhost:4000>**.

The seed prints the demonstration accounts, the hardware signing keys, and a
suggested demonstration script.

### Starting empty instead

```bash
npm run db:migrate          # schema only, no demo data
npm start
```

Then register an account through the web interface.

---

## 3. Configuration

Every setting lives in `.env`. `.env.example` documents all of them; this
section covers the ones that matter in practice.

### Essential

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `4000` | |
| `HOST` | `0.0.0.0` | Keep as-is so the ESP32 can reach the server |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | Used in password-reset links |
| `DATABASE_FILE` | `storage/familytree.db` | Relative to the repository root |

### Security

| Variable | Default | Notes |
|----------|---------|-------|
| `APP_SECRET` | *(dev fallback)* | **Required in production** — the server refuses to start without it. Signs sessions, reset tokens and device keys. |
| `SESSION_TTL_MINUTES` | `720` | Password sessions |
| `BIOMETRIC_SESSION_TTL_MINUTES` | `60` | Shorter — a shared kiosk is a weaker context |
| `SCRYPT_COST` | `16384` | Raise for production. The stored format records the cost, so existing hashes stay valid |
| `FORCE_SECURE_COOKIES` | `false` | Automatic when `NODE_ENV=production` |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy you control |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Biometric

| Variable | Default | Notes |
|----------|---------|-------|
| `DEMO_ALLOW_SIMULATED_DEVICE` | `true` | **Set `false` in production.** A simulated scanner has no physical possession factor |
| `BIOMETRIC_CHALLENGE_TTL_SECONDS` | `90` | How long a sign-in request stays open |
| `DEVICE_CLOCK_SKEW_SECONDS` | `120` | Replay window; the ESP32 must have NTP time |
| `BIOMETRIC_MIN_CONFIDENCE` | `50` | R307 reports roughly 0–200 |

### Matching

| Variable | Default | Notes |
|----------|---------|-------|
| `MATCH_MIN_SCORE` | `0.55` | Below this, a candidate is discarded |
| `MATCH_STRONG_SCORE` | `0.88` | "Strong" also needs two corroborating non-name factors — and is still only a Possible Match |
| `MATCH_DOB_TOLERANCE_YEARS` | `2` | Beyond this, differing birth years count as a conflict |

### AI

| Variable | Default | Notes |
|----------|---------|-------|
| `AI_ENABLED` | `false` | Off means local heuristics: no network, no key, fully offline |
| `ANTHROPIC_API_KEY` | — | Needed only when enabled |
| `AI_MODEL` | `claude-sonnet-5` | |
| `AI_TIMEOUT_MS` | `20000` | A timeout degrades to heuristics; it never blocks the app |

### Email

`MAIL_TRANSPORT=console` (the default) prints password-reset links to the server
log and returns them to the browser in development. That is correct for a local
demonstration and must not be used in production.

---

## 4. Verifying the installation

```bash
npm test
```

Expected:

```
# tests 51
# pass 51
# fail 0
```

Then check the seed's own self-checks:

```bash
npm run db:reset
```

All seven must report `[ok]`. They confirm the demo data still exercises the
hard cases — two trees that start unconnected, a duplicate ancestor that is
found, and a name collision that is correctly refused.

Finally:

```bash
curl http://localhost:4000/api/health
```

```json
{ "status": "ok", "database": { "ok": true }, "version": "1.0.0" }
```

---

## 5. Hardware

Full guide: **[hardware-wiring.md](hardware-wiring.md)**.

Short version:

1. Wire it up — parts list and pin table in §1 and §2 of that guide.
2. Get the device key:

   ```bash
   npm run db:seed                                   # prints keys for the demo devices
   node scripts/register-device.js --key ESP32-LAB-01   # or re-print one
   node scripts/register-device.js ESP32-LAB-02 "Second scanner"   # register a new one
   ```

3. Copy `esp32-firmware/global_family_tree_node/secrets.example.h` to
   `secrets.h` and fill in the Wi-Fi details, the server's **LAN IP**, the
   device id and the key.
4. Flash the enrolment sketch, enrol a finger, note the slot number.
5. Link the slot in the web app: **Biometric & Hardware → Enrol a finger**.
6. Flash the main firmware.

### No hardware yet

Use the **Virtual ESP32 Scanner** (sidebar → *Hardware demo*). It speaks the
identical signed protocol, so the entire flow can be built and demonstrated
without any components.

---

## 6. Deployment

### Behind a reverse proxy (recommended)

`nginx`:

```nginx
server {
    listen 443 ssl http2;
    server_name familytree.example.com;

    ssl_certificate     /etc/letsencrypt/live/familytree.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/familytree.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Matching `.env`:

```ini
NODE_ENV=production
TRUST_PROXY=true
FORCE_SECURE_COOKIES=true
PUBLIC_BASE_URL=https://familytree.example.com
CORS_ORIGINS=https://familytree.example.com
APP_SECRET=<48 random bytes>
DEMO_ALLOW_SIMULATED_DEVICE=false
SCRYPT_COST=32768
MAIL_TRANSPORT=smtp
```

`TRUST_PROXY=true` makes the server read `X-Forwarded-For`. Only enable it when
a proxy you control actually sets that header — otherwise a client can forge its
own IP and defeat the rate limiter.

### As a systemd service

```ini
[Unit]
Description=Global Family Tree
After=network.target

[Service]
Type=simple
User=familytree
WorkingDirectory=/opt/global-family-tree
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning backend/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/global-family-tree/.env

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/global-family-tree/storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now global-family-tree
sudo journalctl -u global-family-tree -f
```

### Production checklist

- [ ] `APP_SECRET` set to 48 random bytes
- [ ] `NODE_ENV=production`
- [ ] `DEMO_ALLOW_SIMULATED_DEVICE=false`
- [ ] TLS terminated at the proxy
- [ ] `TRUST_PROXY=true` **only** behind a proxy that sets the header
- [ ] `SCRYPT_COST` raised
- [ ] Real SMTP configured
- [ ] `CORS_ORIGINS` restricted to your domain
- [ ] `storage/` backed up on a schedule
- [ ] Synthetic demo data removed (`npm run db:migrate` on a fresh database)

---

## 7. Troubleshooting

### Server

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module 'node:sqlite'` | Node older than 22.5 | Upgrade |
| `[FATAL] APP_SECRET is not set` | Production without a secret | Set it in `.env` |
| `EADDRINUSE` | Port 4000 taken | `PORT=4001`, or stop the other process |
| `SQLITE_CANTOPEN` | `storage/` missing or unwritable | `mkdir -p storage`; check permissions |
| `database is locked` | Another process has it open | Close the other one; WAL handles normal concurrency |
| Experimental SQLite warning | Expected | The npm scripts already pass `--no-warnings=ExperimentalWarning` |

### Data

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Synthetic data is already loaded" | Guard against a double seed | `npm run db:reset` |
| Seed self-checks fail | The dataset no longer demonstrates what it claims | Read which check failed — it names the problem |
| A relationship search finds nothing | The edges are unverified | Verify them, or tick "also follow unverified relationships" |
| A scan finds no matches | Nothing similar, or discovery is off | Check **Privacy → allow match discovery** on both sides |
| A person shows as "Private person" | Their visibility excludes you | Expected. Ask the owner for collaborator access |

### Browser

| Symptom | Cause | Fix |
|---------|-------|-----|
| Blank page | Stale cached JavaScript | Hard reload (Ctrl/Cmd+Shift+R) |
| "Could not reach the server" | Server not running | `npm start` |
| Tree renders empty | No people yet, or none visible | Add a person, or widen the generation range |
| Signed out unexpectedly | Session expired, or the password was changed elsewhere | Sign in again |

### Hardware

See the troubleshooting table in
[hardware-wiring.md §12](hardware-wiring.md#12-troubleshooting), which covers the
sensor, the display, the network and the board separately.

---

## 8. Development

```bash
npm run dev          # restarts on file changes
npm run test:watch   # re-runs tests on change
```

Set `LOG_LEVEL=debug` in `.env` to log every request with its status and timing.

### Where things live

| Task | File |
|------|------|
| Add an endpoint | `backend/routes/*.js`, then mount it in `backend/server.js` |
| Change how relationships are named | `backend/engine/relationship.js` |
| Change path finding | `backend/engine/graph.js` |
| Change match scoring | `backend/engine/matching.js` — weights are at the top |
| Change what a viewer may see | `backend/lib/privacy.js` |
| Add a page | `frontend/js/views/*.js`, then add it to `routes` in `frontend/js/app.js` |
| Change the tree drawing | `frontend/js/tree-render.js` |
| Change the schema | `database/schema.sql`, then `npm run db:reset` |

### A note on restarting

Node does not hot-reload. After changing anything under `backend/`, restart the
server — or use `npm run dev`. Testing a backend change against a stale process
is a reliable way to lose an hour.
