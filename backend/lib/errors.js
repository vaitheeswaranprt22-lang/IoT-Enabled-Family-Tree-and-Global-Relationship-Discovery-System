/**
 * Typed application errors.
 *
 * Handlers throw these; the router turns them into a consistent JSON body:
 *   { error: { code, message, details? } }
 * Anything that is NOT an AppError is logged server-side and reported to the
 * client as a generic 500 -- internal details never leak to the browser.
 */
export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (msg = 'Invalid request', details = null) =>
  new AppError(400, 'BAD_REQUEST', msg, details);

export const validationError = (details) =>
  new AppError(422, 'VALIDATION_FAILED', 'Some fields need attention.', details);

export const unauthorized = (msg = 'Authentication required.') =>
  new AppError(401, 'UNAUTHORIZED', msg);

export const forbidden = (msg = 'You do not have permission to do that.') =>
  new AppError(403, 'FORBIDDEN', msg);

export const notFound = (msg = 'Not found.') => new AppError(404, 'NOT_FOUND', msg);

export const conflict = (msg = 'That conflicts with existing data.', details = null) =>
  new AppError(409, 'CONFLICT', msg, details);

export const tooManyRequests = (msg = 'Too many requests. Please slow down.', retryAfter = 60) => {
  const e = new AppError(429, 'RATE_LIMITED', msg);
  e.retryAfter = retryAfter;
  return e;
};

export const payloadTooLarge = (msg = 'Payload too large.') =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', msg);

export const serverError = (msg = 'Something went wrong on our side.') =>
  new AppError(500, 'SERVER_ERROR', msg);

export const serviceUnavailable = (msg = 'Service temporarily unavailable.') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', msg);
