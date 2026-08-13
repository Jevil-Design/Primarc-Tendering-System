import { errors } from './lib/response.js';
import { num } from './lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Server-side validation.

   Nothing calculated in the browser is trusted: amounts, GST and totals are
   recomputed by the database (generated columns) regardless of what the client
   sends, and these checks reject malformed input before it lands.
   ═══════════════════════════════════════════════════════════════ */

export class Validator {
  constructor(body) { this.body = body || {}; this.errors = {}; this.out = {}; }

  _add(field, msg) { if (!this.errors[field]) this.errors[field] = msg; }

  string(field, { required = false, min = 0, max = 5000, trim = true, as } = {}) {
    let v = this.body[field];
    if (v === undefined || v === null) v = '';
    v = String(v);
    if (trim) v = v.trim();
    if (required && !v) this._add(field, 'This field is required.');
    else if (v && v.length < min) this._add(field, `Must be at least ${min} characters.`);
    else if (v.length > max) this._add(field, `Must be ${max} characters or fewer.`);
    this.out[as || field] = v || null;
    return this;
  }

  number(field, { required = false, min = null, max = null, as, default: def = 0 } = {}) {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this._add(field, 'This field is required.');
      this.out[as || field] = def;
      return this;
    }
    const n = num(raw, NaN);
    if (!Number.isFinite(n)) this._add(field, 'Must be a number.');
    else if (min !== null && n < min) this._add(field, `Must be at least ${min}.`);
    else if (max !== null && n > max) this._add(field, `Must be ${max} or less.`);
    this.out[as || field] = Number.isFinite(n) ? n : def;
    return this;
  }

  /** GST in India is one of a known set; anything else is a data-entry error. */
  gst(field, { as } = {}) {
    const n = num(this.body[field], 0);
    if (![0, 0.25, 3, 5, 12, 18, 28].includes(n)) {
      this._add(field, 'GST must be 0, 0.25, 3, 5, 12, 18 or 28 percent.');
    }
    this.out[as || field] = n;
    return this;
  }

  enum(field, allowed, { required = false, as, default: def = null } = {}) {
    const v = this.body[field];
    if (v === undefined || v === null || v === '') {
      if (required) this._add(field, 'This field is required.');
      this.out[as || field] = def;
      return this;
    }
    if (!allowed.includes(v)) this._add(field, `Must be one of: ${allowed.join(', ')}.`);
    this.out[as || field] = v;
    return this;
  }

  email(field, { required = false, as } = {}) {
    const v = String(this.body[field] || '').trim();
    if (!v) { if (required) this._add(field, 'This field is required.'); this.out[as || field] = null; return this; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) this._add(field, 'Enter a valid email address.');
    this.out[as || field] = v.toLowerCase();
    return this;
  }

  date(field, { required = false, as } = {}) {
    const v = this.body[field];
    if (!v) { if (required) this._add(field, 'This field is required.'); this.out[as || field] = null; return this; }
    const d = new Date(v);
    if (isNaN(d.getTime())) this._add(field, 'Enter a valid date.');
    this.out[as || field] = isNaN(d.getTime()) ? null : String(v);
    return this;
  }

  id(field, { required = false, as } = {}) {
    const v = String(this.body[field] || '').trim();
    if (!v) { if (required) this._add(field, 'This field is required.'); this.out[as || field] = null; return this; }
    if (!/^[a-f0-9-]{8,64}$/i.test(v)) this._add(field, 'Invalid identifier.');
    this.out[as || field] = v;
    return this;
  }

  bool(field, { as, default: def = false } = {}) {
    const v = this.body[field];
    this.out[as || field] = v === undefined ? def : !!v;
    return this;
  }

  json(field, { as, default: def = {} } = {}) {
    const v = this.body[field];
    this.out[as || field] = v === undefined || v === null ? def : v;
    return this;
  }

  /** Throws a 422 carrying per-field messages the UI can attach to inputs. */
  done() {
    if (Object.keys(this.errors).length) {
      throw errors.validation('Please correct the highlighted fields.', this.errors);
    }
    return this.out;
  }
}

export const validate = (body) => new Validator(body);

export function requirePassword(password, policy = {}) {
  const min = policy.password_min_length || 8;
  const p = String(password || '');
  if (p.length < min) throw errors.validation(`Password must be at least ${min} characters.`, { password: `At least ${min} characters.` });
  if ((policy.password_complexity || 'medium') !== 'low') {
    if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) {
      throw errors.validation('Password needs upper case, lower case and a digit.',
        { password: 'Include upper case, lower case and a number.' });
    }
  }
  return p;
}
