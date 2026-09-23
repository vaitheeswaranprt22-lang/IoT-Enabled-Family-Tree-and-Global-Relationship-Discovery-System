/**
 * Input validation and sanitisation.
 *
 * Every route runs its body through `validate(body, schema)`. Unknown keys are
 * dropped rather than passed through, so a client cannot smuggle a field such
 * as `role: "admin"` into an UPDATE by adding it to the JSON payload.
 */
import { validationError } from './errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strips control characters and trims. Does NOT strip HTML -- output is escaped at render time. */
export function cleanString(value, { maxLength = 500 } = {}) {
  if (value === null || value === undefined) return null;
  let s = String(value);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.trim();
  if (s.length > maxLength) s = s.slice(0, maxLength);
  return s;
}

/** Escapes a string for safe inclusion in HTML/SVG/XML output. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Rejects 2023-02-31 style dates that Date() would silently roll over.
  return d.toISOString().slice(0, 10) === value;
}

/**
 * Password policy. Deliberately length-first rather than a symbol maze --
 * length is what actually resists offline cracking.
 */
export function checkPasswordStrength(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 10) {
    problems.push('Use at least 10 characters.');
  }
  if (password && password.length > 200) problems.push('Password is too long (max 200).');
  if (password && !/[a-zA-Z]/.test(password)) problems.push('Include at least one letter.');
  if (password && !/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    problems.push('Include at least one number or symbol.');
  }
  const common = ['password', '12345678', 'qwertyui', 'letmein', 'familytree', 'iloveyou'];
  if (password && common.some((c) => password.toLowerCase().includes(c))) {
    problems.push('That password contains a very common phrase.');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Field types understood by `validate`:
 *   string | email | password | int | number | bool | date | enum | json | array
 *
 * Schema entry: { type, required, min, max, maxLength, values, default, trim }
 */
export function validate(input, schema) {
  const out = {};
  const errors = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const [field, rule] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(source, field);
    let value = source[field];

    if (!present || value === '' || value === null || value === undefined) {
      if (rule.required) {
        errors[field] = rule.label ? `${rule.label} is required.` : 'This field is required.';
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(rule, 'default')) out[field] = rule.default;
      else if (present) out[field] = null;
      continue;
    }

    switch (rule.type) {
      case 'string': {
        value = cleanString(value, { maxLength: rule.maxLength ?? 500 });
        if (rule.minLength && value.length < rule.minLength) {
          errors[field] = `Must be at least ${rule.minLength} characters.`;
          continue;
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          errors[field] = rule.patternMessage ?? 'That format is not accepted.';
          continue;
        }
        out[field] = value;
        break;
      }
      case 'email': {
        value = cleanString(value, { maxLength: 320 }).toLowerCase();
        if (!EMAIL_RE.test(value)) { errors[field] = 'Enter a valid email address.'; continue; }
        out[field] = value;
        break;
      }
      case 'password': {
        const check = checkPasswordStrength(value);
        if (!check.ok) { errors[field] = check.problems.join(' '); continue; }
        out[field] = value;
        break;
      }
      case 'int': {
        const n = Number(value);
        if (!Number.isInteger(n)) { errors[field] = 'Must be a whole number.'; continue; }
        if (rule.min !== undefined && n < rule.min) { errors[field] = `Must be at least ${rule.min}.`; continue; }
        if (rule.max !== undefined && n > rule.max) { errors[field] = `Must be at most ${rule.max}.`; continue; }
        out[field] = n;
        break;
      }
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) { errors[field] = 'Must be a number.'; continue; }
        if (rule.min !== undefined && n < rule.min) { errors[field] = `Must be at least ${rule.min}.`; continue; }
        if (rule.max !== undefined && n > rule.max) { errors[field] = `Must be at most ${rule.max}.`; continue; }
        out[field] = n;
        break;
      }
      case 'bool': {
        if (typeof value === 'boolean') out[field] = value;
        else if (value === 'true' || value === 1 || value === '1') out[field] = true;
        else if (value === 'false' || value === 0 || value === '0') out[field] = false;
        else { errors[field] = 'Must be true or false.'; continue; }
        break;
      }
      case 'date': {
        value = cleanString(value, { maxLength: 10 });
        if (!isValidIsoDate(value)) { errors[field] = 'Use the format YYYY-MM-DD.'; continue; }
        if (rule.notFuture && value > new Date().toISOString().slice(0, 10)) {
          errors[field] = 'That date is in the future.';
          continue;
        }
        out[field] = value;
        break;
      }
      case 'enum': {
        value = cleanString(value, { maxLength: 60 });
        if (!rule.values.includes(value)) {
          errors[field] = `Must be one of: ${rule.values.join(', ')}.`;
          continue;
        }
        out[field] = value;
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) { errors[field] = 'Must be a list.'; continue; }
        if (rule.maxItems && value.length > rule.maxItems) {
          errors[field] = `At most ${rule.maxItems} items.`;
          continue;
        }
        out[field] = rule.itemType === 'int'
          ? value.map(Number).filter(Number.isInteger)
          : value.map((v) => cleanString(v, { maxLength: rule.maxLength ?? 200 }));
        break;
      }
      default:
        out[field] = value;
    }
  }

  if (Object.keys(errors).length) throw validationError(errors);
  return out;
}

/** Parses `?page=&pageSize=` into safe bounds. */
export function parsePagination(query, { defaultSize = 25, maxSize = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const rawSize = Number.parseInt(query.pageSize ?? String(defaultSize), 10) || defaultSize;
  const pageSize = Math.min(maxSize, Math.max(1, rawSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
