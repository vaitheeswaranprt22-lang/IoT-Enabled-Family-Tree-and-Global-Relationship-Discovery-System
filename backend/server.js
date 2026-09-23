/**
 * Global Family Tree & Ancestry Mapping System -- HTTP server.
 *
 * Zero external dependencies: `node:http` for the server, `node:sqlite` for
 * storage, `node:crypto` for hashing. Start with:
 *     node backend/server.js
 */
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';

import config from './config.js';
import { applySchema, closeDb } from './db/index.js';
import {
  Router, sendJson, sendError, readJsonBody, applySecurityHeaders,
  applyCors, serveStatic, clientIp,
} from './lib/http.js';
import { buildAuthContext, purgeExpired } from './lib/auth.js';
import { enforce, limitFor } from './lib/ratelimit.js';
import { logSecurity } from './lib/audit.js';
import { notFound } from './lib/errors.js';
import { clearAccessCache } from './lib/privacy.js';

import authRoutes from './routes/auth.js';
import personRoutes from './routes/persons.js';
import relationshipRoutes from './routes/relationships.js';
import treeRoutes from './routes/tree.js';
import searchRoutes from './routes/search.js';
import matchRoutes from './routes/matches.js';
import verificationRoutes from './routes/verification.js';
import timelineRoutes from './routes/timeline.js';
import collaboratorRoutes from './routes/collaborators.js';
import privacyRoutes from './routes/privacy.js';
import notificationRoutes from './routes/notifications.js';
import historyRoutes from './routes/history.js';
import biometricRoutes from './routes/biometric.js';
import exportRoutes from './routes/export.js';
import systemRoutes from './routes/system.js';

const FRONTEND_DIR = path.join(config.root, 'frontend');

// --------------------------------------------------------------- routing ---

const api = new Router();
api.use('/api/auth', authRoutes);
api.use('/api/persons', personRoutes);
api.use('/api/relationships', relationshipRoutes);
api.use('/api/tree', treeRoutes);
api.use('/api/search', searchRoutes);
api.use('/api/matches', matchRoutes);
api.use('/api/verifications', verificationRoutes);
api.use('/api/timeline', timelineRoutes);
api.use('/api/collaborators', collaboratorRoutes);
api.use('/api/privacy', privacyRoutes);
api.use('/api/notifications', notificationRoutes);
api.use('/api/history', historyRoutes);
api.use('/api/biometric', biometricRoutes);
api.use('/api/export', exportRoutes);
api.use('/api', systemRoutes);

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_ROUTES = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'GET /api/health',
  'GET /api/info',
  // The biometric handshake runs before a session exists, by design.
  'POST /api/biometric/challenge',
  'GET /api/biometric/challenge/:id',
  'POST /api/biometric/device/scan',
  'GET /api/biometric/device/poll',
  'POST /api/biometric/device/heartbeat',
  'POST /api/biometric/device/status',
]);

/** Route classes that get a tighter rate-limit budget. */
function rateLimitClass(method, pattern) {
  if (pattern.startsWith('/api/auth/')) return 'auth';
  if (pattern.startsWith('/api/biometric/device')) return 'device';
  if (pattern === '/api/biometric/challenge') return 'auth';
  return 'general';
}

// -------------------------------------------------------------- handling ---

async function handleApi(req, res, url) {
  const matched = api.match(req.method, url.pathname);

  if (!matched) throw notFound(`No API route for ${req.method} ${url.pathname}`);
  if (matched.methodMismatch) {
    return sendJson(res, 405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed on this endpoint.` },
    });
  }

  const { route, params } = matched;
  const ip = clientIp(req);
  const routeKey = `${route.method} ${route.pattern}`;

  // Rate limiting, per IP per route class.
  const cls = rateLimitClass(route.method, route.pattern);
  const headers = enforce(`${cls}:${ip}`, limitFor(cls));

  // Auth context is built for every request; routes decide whether it matters.
  const auth = buildAuthContext(req);

  if (!PUBLIC_ROUTES.has(routeKey) && !route.options?.public && !auth.user) {
    logSecurity({ event: 'unauthenticated_api_access', severity: 'info', ip, route: routeKey });
    return sendJson(res, 401, {
      error: { code: 'UNAUTHORIZED', message: 'Please sign in to continue.' },
    });
  }

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};

  const ctx = {
    req, res, params, body, ip,
    query: Object.fromEntries(url.searchParams),
    url,
    user: auth.user,
    session: auth.session,
    token: auth.token,
    route: routeKey,
  };

  const result = await route.handler(ctx);

  // A handler that already wrote to the socket returns undefined.
  if (res.writableEnded) return undefined;
  if (result === undefined || result === null) return sendJson(res, 204, {});
  const status = result.__status ?? 200;
  if (result.__status) delete result.__status;
  return sendJson(res, status, result, headers);
}

const server = http.createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Malformed URL.' } });
  }

  applySecurityHeaders(res);
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      // Static assets, then SPA fallback so client-side routes deep-link.
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const candidate = path.join(FRONTEND_DIR, rel);
      if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
        serveStatic(res, FRONTEND_DIR, rel);
      } else {
        serveStatic(res, FRONTEND_DIR, 'index.html');
      }
    } else {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Not allowed.' } });
    }
  } catch (err) {
    sendError(res, err, { route: `${req.method} ${url.pathname}` });
  } finally {
    if (config.logging.level === 'debug') {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
    }
  }
});

// -------------------------------------------------------------- lifecycle ---

function banner() {
  const line = '='.repeat(74);
  console.log(`\n${line}`);
  console.log('  GLOBAL FAMILY TREE & ANCESTRY MAPPING SYSTEM');
  console.log(line);
  console.log(`  Web app      : ${config.server.publicBaseUrl}`);
  console.log(`  API base     : ${config.server.publicBaseUrl}/api`);
  console.log(`  Environment  : ${config.env}`);
  console.log(`  Database     : ${path.relative(config.root, config.db.file)}`);
  console.log(`  AI layer     : ${config.ai.enabled && config.ai.apiKey ? `model-assisted (${config.ai.model})` : 'local heuristics'}`);
  console.log(`  Simulated ESP32 allowed : ${config.biometric.allowSimulatedDevice ? 'yes' : 'no'}`);
  if (config.warnings.length) {
    console.log(`${'-'.repeat(74)}`);
    for (const w of config.warnings) console.log(`  [warning] ${w}`);
  }
  console.log(`${line}\n`);
}

function start() {
  applySchema();

  // Housekeeping: expire sessions, challenges and nonces every five minutes.
  const housekeeping = setInterval(() => {
    try {
      purgeExpired();
      clearAccessCache();
    } catch (err) {
      console.error('[housekeeping]', err.message);
    }
  }, 5 * 60 * 1000);
  housekeeping.unref();

  server.listen(config.server.port, config.server.host, banner);
}

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down.`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Only auto-start when run directly, so tests can import the app.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  start();
}

export { server, start, api };
