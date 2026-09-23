/**
 * In-memory sliding-window rate limiter.
 *
 * Buckets live in the process, which is correct for the single-node deployment
 * this project targets. Behind a load balancer this should move to Redis -- the
 * interface (`consume`) is intentionally swappable.
 */
import config from '../config.js';
import { tooManyRequests } from './errors.js';

const buckets = new Map(); // key -> { count, resetAt }

/** Removes expired buckets so the map cannot grow without bound. */
function sweep(now) {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Records one hit against `key`.
 * @returns {{allowed:boolean, remaining:number, retryAfter:number}}
 */
export function consume(key, limit, windowSeconds = config.rateLimit.windowSeconds) {
  const now = Date.now();
  sweep(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter,
    limit,
  };
}

/** Throws 429 when the caller is over budget; otherwise returns headers to set. */
export function enforce(key, limit, windowSeconds) {
  const result = consume(key, limit, windowSeconds);
  if (!result.allowed) {
    throw tooManyRequests(
      `Too many requests. Try again in ${result.retryAfter} second(s).`,
      result.retryAfter
    );
  }
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
}

/** Clears a bucket after a successful login so one typo does not cost a lockout. */
export function reset(key) {
  buckets.delete(key);
}

export function clearAll() {
  buckets.clear();
}

/** Picks the right budget for a route class. */
export function limitFor(routeClass) {
  switch (routeClass) {
    case 'auth': return config.rateLimit.auth;
    case 'device': return config.rateLimit.device;
    default: return config.rateLimit.general;
  }
}
