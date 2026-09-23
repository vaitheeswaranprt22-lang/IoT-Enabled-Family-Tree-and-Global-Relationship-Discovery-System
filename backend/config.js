/**
 * Configuration loader.
 *
 * Reads `.env` from the repository root (no external dependency) and exposes a
 * validated, typed config object. Secrets are NEVER hard-coded here -- every
 * sensitive value must come from the environment.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal `.env` parser: `KEY=value`, `#` comments, optional quotes. */
function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadDotEnv(path.join(ROOT, '.env'));
// Real environment variables always win over the `.env` file.
const env = { ...fileEnv, ...process.env };

const str = (k, d = '') => (env[k] !== undefined && env[k] !== '' ? String(env[k]) : d);
const num = (k, d) => {
  const v = Number(env[k]);
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d = false) => {
  const v = str(k, '').toLowerCase();
  if (v === '') return d;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
};

const NODE_ENV = str('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

/**
 * APP_SECRET is mandatory in production. In development we derive a stable
 * per-machine fallback so the app runs out of the box, and we say so loudly.
 */
let appSecret = str('APP_SECRET', '');
const warnings = [];
if (!appSecret) {
  if (isProd) {
    console.error(
      '\n[FATAL] APP_SECRET is not set. Refusing to start in production.\n' +
        '        Generate one with:\n' +
        '        node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n'
    );
    process.exit(1);
  }
  appSecret = crypto
    .createHash('sha256')
    .update(`dev-insecure-secret::${ROOT}`)
    .digest('base64url');
  warnings.push(
    'APP_SECRET is not set -- using an INSECURE development fallback. Set it in .env before deploying.'
  );
}

if (isProd && bool('DEMO_ALLOW_SIMULATED_DEVICE', true)) {
  warnings.push(
    'DEMO_ALLOW_SIMULATED_DEVICE is enabled in production. Simulated scanners bypass physical hardware possession -- set it to false.'
  );
}

export const config = {
  env: NODE_ENV,
  isProd,
  root: ROOT,
  warnings,

  server: {
    port: num('PORT', 4000),
    host: str('HOST', '0.0.0.0'),
    publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 4000)}`),
    corsOrigins: str('CORS_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: bool('TRUST_PROXY', false),
  },

  db: {
    file: path.resolve(ROOT, str('DATABASE_FILE', 'storage/familytree.db')),
    schemaFile: path.join(ROOT, 'database', 'schema.sql'),
  },

  security: {
    appSecret,
    sessionTtlMinutes: num('SESSION_TTL_MINUTES', 720),
    biometricSessionTtlMinutes: num('BIOMETRIC_SESSION_TTL_MINUTES', 60),
    resetTtlMinutes: num('RESET_TTL_MINUTES', 30),
    scryptCost: num('SCRYPT_COST', 16384),
    forceSecureCookies: bool('FORCE_SECURE_COOKIES', false) || isProd,
    maxFailedLogins: 8,
    lockoutMinutes: 15,
  },

  rateLimit: {
    windowSeconds: num('RATE_LIMIT_WINDOW_SECONDS', 60),
    general: num('RATE_LIMIT_GENERAL', 300),
    auth: num('RATE_LIMIT_AUTH', 10),
    device: num('RATE_LIMIT_DEVICE', 60),
  },

  biometric: {
    challengeTtlSeconds: num('BIOMETRIC_CHALLENGE_TTL_SECONDS', 90),
    clockSkewSeconds: num('DEVICE_CLOCK_SKEW_SECONDS', 120),
    maxFailures: num('BIOMETRIC_MAX_FAILURES', 5),
    minConfidence: num('BIOMETRIC_MIN_CONFIDENCE', 50),
    allowSimulatedDevice: bool('DEMO_ALLOW_SIMULATED_DEVICE', true),
  },

  engine: {
    maxPathDepth: num('MAX_PATH_DEPTH', 14),
    maxPathsReturned: num('MAX_PATHS_RETURNED', 5),
    traversalNodeBudget: num('TRAVERSAL_NODE_BUDGET', 60000),
  },

  matching: {
    minScore: num('MATCH_MIN_SCORE', 0.55),
    strongScore: num('MATCH_STRONG_SCORE', 0.88),
    dobToleranceYears: num('MATCH_DOB_TOLERANCE_YEARS', 2),
  },

  ai: {
    enabled: bool('AI_ENABLED', false),
    provider: str('AI_PROVIDER', 'anthropic'),
    apiKey: str('ANTHROPIC_API_KEY', ''),
    model: str('AI_MODEL', 'claude-sonnet-5'),
    maxCandidates: num('AI_MAX_CANDIDATES', 25),
    timeoutMs: num('AI_TIMEOUT_MS', 20000),
  },

  mail: {
    transport: str('MAIL_TRANSPORT', 'console'),
    host: str('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    user: str('SMTP_USER', ''),
    pass: str('SMTP_PASS', ''),
    from: str('MAIL_FROM', 'no-reply@familytree.local'),
  },

  uploads: {
    dir: path.resolve(ROOT, str('UPLOAD_DIR', 'storage/uploads')),
    maxBytes: num('MAX_UPLOAD_BYTES', 3 * 1024 * 1024),
  },

  logging: {
    level: str('LOG_LEVEL', 'info'),
    auditRetentionDays: num('AUDIT_RETENTION_DAYS', 365),
  },

  /** Label stamped on every generated demo record. */
  syntheticLabel: 'SYNTHETIC / DEMONSTRATION DATA',
};

export default config;
