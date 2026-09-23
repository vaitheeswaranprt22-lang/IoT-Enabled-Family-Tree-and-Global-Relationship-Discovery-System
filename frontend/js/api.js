/**
 * API client.
 *
 * The session lives in an HttpOnly cookie, so requests just need
 * `credentials: 'same-origin'`. A bearer token is also kept in memory for the
 * biometric hand-off, where the token arrives in a response body.
 */

let bearerToken = null;

export function setToken(token) { bearerToken = token; }
export function getToken() { return bearerToken; }

/** Thrown for any non-2xx response, carrying the server's error envelope. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
  /** Field-level validation messages, when the server sent them. */
  get fieldErrors() {
    return this.code === 'VALIDATION_FAILED' && this.details ? this.details : null;
  }
}

async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check that it is running.');
  }

  if (response.status === 204) return {};

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, 'HTTP_ERROR', `Request failed (${response.status}).`);
    }
    return response;
  }

  const payload = await response.json();

  if (!response.ok) {
    const error = payload.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'ERROR',
      error.message ?? `Request failed (${response.status}).`,
      error.details
    );
  }
  return payload;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  delete: (path, options) => request('DELETE', path, undefined, options),

  /** Builds a query string, skipping empty values. */
  qs(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const s = search.toString();
    return s ? `?${s}` : '';
  },
};

export default api;
