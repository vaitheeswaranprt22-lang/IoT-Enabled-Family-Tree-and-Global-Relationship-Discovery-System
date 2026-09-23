/**
 * Minimal HTTP router and request/response helpers built on `node:http`.
 *
 * Supports path parameters (`/api/persons/:id`), JSON bodies, cookies, CORS,
 * security headers and static file serving -- everything the app needs without
 * pulling in a framework.
 */
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { AppError, notFound, payloadTooLarge, badRequest, serverError } from './errors.js';
import config from '../config.js';

const MAX_JSON_BYTES = 1024 * 1024; // 1 MB ceiling on JSON request bodies

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
};

// ---------------------------------------------------------------- router ---

export class Router {
  constructor() {
    /** @type {{method:string, segments:string[], handler:Function, options:object}[]} */
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      pattern,
      handler,
      options,
    });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Mounts another router's routes under `prefix`. */
  use(prefix, router) {
    for (const r of router.routes) {
      this.routes.push({
        ...r,
        segments: [...prefix.split('/').filter(Boolean), ...r.segments],
        pattern: `${prefix}${r.pattern}`,
      });
    }
    return this;
  }

  /** Finds the route matching `method` + `pathname`, extracting `:params`. */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? { methodMismatch: true } : null;
  }
}

// ------------------------------------------------------------- utilities ---

/** Client IP, honouring X-Forwarded-For only when TRUST_PROXY is enabled. */
export function clientIp(req) {
  if (config.server.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) bits.push(`Expires=${opts.expires.toUTCString()}`);
  bits.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure ?? config.security.forceSecureCookies) bits.push('Secure');

  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/** Reads and JSON-parses the request body, enforcing a size ceiling. */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_JSON_BYTES) return reject(payloadTooLarge());

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(payloadTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(badRequest('Request body must be a JSON object.'));
        }
        resolve(parsed);
      } catch {
        reject(badRequest('Request body is not valid JSON.'));
      }
    });
  });
}

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Headers applied to every response. */
export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
}

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = config.server.corsOrigins;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Device-Id,X-Device-Timestamp,X-Device-Nonce,X-Device-Signature'
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

/** Serves a file from `rootDir`, blocking any path traversal attempt. */
export function serveStatic(res, rootDir, relPath) {
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(rootDir, safeRel);
  if (!full.startsWith(path.resolve(rootDir))) throw notFound();
  if (!existsSync(full)) throw notFound();

  const st = statSync(full);
  if (st.isDirectory()) throw notFound();

  const ext = path.extname(full).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    // The SPA shell must never be cached, or a deploy leaves stale JS
    // references. In development nothing is cached, so an edit to a stylesheet
    // or a view shows up on the next reload rather than five minutes later.
    'Cache-Control': isHtml || !config.isProd ? 'no-cache' : 'public, max-age=300',
    'Last-Modified': st.mtime.toUTCString(),
  });
  createReadStream(full).pipe(res);
}

/** Converts any thrown value into the standard JSON error envelope. */
export function sendError(res, err, { route = '', log = true } = {}) {
  if (err instanceof AppError) {
    const headers = {};
    if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
    return sendJson(
      res,
      err.status,
      { error: { code: err.code, message: err.message, details: err.details ?? undefined } },
      headers
    );
  }
  if (log) console.error(`[error] ${route}`, err);
  const generic = serverError();
  return sendJson(res, generic.status, {
    error: { code: generic.code, message: generic.message },
  });
}

export { AppError };
