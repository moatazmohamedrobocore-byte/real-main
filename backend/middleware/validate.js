// Lightweight input validators. Return `null` on success or an { code, message } error.
// Keeping it dependency-free so we don't add zod/joi weight for the current surface.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNonEmptyString(v, { max = 500 } = {}) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

export function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// NIST 800-63B: length matters more than symbol-class rules; min 8, max 128.
export function validatePassword(pw) {
  if (typeof pw !== 'string') return { code: 'INVALID_INPUT', message: 'Password must be a string.' };
  if (pw.length < 8) return { code: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters.' };
  if (pw.length > 128) return { code: 'INVALID_INPUT', message: 'Password is too long.' };
  if (/\s/.test(pw) && pw.trim() !== pw) return { code: 'INVALID_INPUT', message: 'Password cannot start or end with whitespace.' };
  return null;
}

export function validateName(name) {
  if (!isNonEmptyString(name, { max: 80 })) {
    return { code: 'INVALID_INPUT', message: 'Name must be 1-80 characters.' };
  }
  if (!/^[\p{L}\p{N} _.'\-]+$/u.test(name)) {
    return { code: 'INVALID_INPUT', message: 'Name contains unsupported characters.' };
  }
  return null;
}

export function validateEmail(email) {
  if (!isEmail(email)) return { code: 'INVALID_INPUT', message: 'A valid email is required.' };
  return null;
}

export function send400(res, err) {
  return res.status(400).json({ error: err });
}
