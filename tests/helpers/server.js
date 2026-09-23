/**
 * Boots the real HTTP server against a throwaway database and returns a small
 * client with a cookie jar, so the API tests exercise the same code path a
 * browser does -- routing, rate limiting, auth and privacy included.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;

export async function startTestServer({ env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gft-test-'));
  const dbFile = path.join(dir, `test-${++counter}.db`);

  // Config is read when the module first loads, so the environment has to be
  // in place before the dynamic import below.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_FILE = dbFile;
  process.env.APP_SECRET = 'test-secret-only-for-the-test-suite-0123456789';
  process.env.PORT = '0';
  process.env.SCRYPT_COST = '1024';          // keep the suite fast
  process.env.RATE_LIMIT_AUTH = '1000';
  process.env.RATE_LIMIT_GENERAL = '10000';
  process.env.MAIL_TRANSPORT = 'console';
  process.env.LOG_LEVEL = 'silent';
  process.env.DEMO_ALLOW_SIMULATED_DEVICE = 'true';
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const { server } = await import('../../backend/server.js');
  const { applySchema, closeDb } = await import('../../backend/db/index.js');
  applySchema();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    client: () => createClient(baseUrl),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      closeDb();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    },
  };
}

/** Minimal API client with its own cookie jar, so several users can be driven. */
export function createClient(baseUrl) {
  const cookies = new Map();

  const jar = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(method, urlPath, body, extraHeaders = {}) {
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookieHeader = jar();
    if (cookieHeader) headers.Cookie = cookieHeader;

    const response = await fetch(`${baseUrl}${urlPath}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    absorb(response);

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    return { status: response.status, ok: response.ok, body: payload, headers: response.headers };
  }

  return {
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    put: (p, b, h) => request('PUT', p, b ?? {}, h),
    patch: (p, b, h) => request('PATCH', p, b ?? {}, h),
    delete: (p, h) => request('DELETE', p, undefined, h),
    cookies,
    /** Registers an account and leaves the client signed in as it. */
    async register(email, displayName, extra = {}) {
      const result = await this.post('/api/auth/register', {
        email, displayName, password: 'Tr0ubadour#Vault92', ...extra,
      });
      if (!result.ok) throw new Error(`register failed: ${JSON.stringify(result.body)}`);
      return result.body;
    },
    async login(email, password = 'Tr0ubadour#Vault92') {
      const result = await this.post('/api/auth/login', { email, password });
      if (!result.ok) throw new Error(`login failed: ${JSON.stringify(result.body)}`);
      return result.body;
    },
  };
}
