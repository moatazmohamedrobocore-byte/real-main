import crypto from 'node:crypto';

// Centralized JWT secret resolution with fail-closed validation.
// Import and call validateSecrets() at server startup BEFORE any route mounts.
// Replaces the three weak fallback strings that previously lived in
// routes/auth.js, middleware/auth.js, and routes/meetings.js.

const MIN_SECRET_LENGTH = 32;

const WEAK_FALLBACKS = new Set([
  'access-secret-32-chars-minimum-here',
  'refresh-secret-32-chars-minimum-here',
  'fallback-secret',
  'jwt-jitsi-secret-32-chars-long',
  'replace-with-a-unique-secret-of-at-least-32-characters',
  'replace-with-a-different-unique-secret-of-at-least-32-characters',
  'replace-with-a-third-unique-secret-of-at-least-32-characters'
]);

function reject(name, value) {
  if (value === undefined || value === null || value === '') {
    return `${name} is not set.`;
  }
  if (typeof value !== 'string') {
    return `${name} must be a string.`;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} must be at least ${MIN_SECRET_LENGTH} characters (got ${value.length}).`;
  }
  if (WEAK_FALLBACKS.has(value)) {
    return `${name} is a known weak/placeholder value. Generate a fresh secret (e.g. \`openssl rand -hex 32\`).`;
  }
  return null;
}

export function resolveSecrets() {
  const access = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  const refresh = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  return { access, refresh };
}

export function validateSecrets() {
  const { access, refresh } = resolveSecrets();
  const errors = [];
  const accessErr = reject('JWT_ACCESS_SECRET (or JWT_SECRET)', access);
  if (accessErr) errors.push(accessErr);
  const refreshErr = reject('JWT_REFRESH_SECRET (or JWT_SECRET)', refresh);
  if (refreshErr) errors.push(refreshErr);
  if (access && refresh && access === refresh && process.env.JWT_ACCESS_SECRET && process.env.JWT_REFRESH_SECRET) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }
  const jitsi = process.env.JITSI_JWT_SECRET;
  if (jitsi && (jitsi === access || jitsi === refresh)) {
    errors.push('JITSI_JWT_SECRET must differ from the API JWT secrets (a join token must never be a valid API token).');
  }
  if (errors.length > 0) {
    throw new Error(`JWT secret configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return { access, refresh };
}

export function getAccessSecret() {
  return resolveSecrets().access;
}

export function getRefreshSecret() {
  return resolveSecrets().refresh;
}

// F-08: signing key for Jitsi join tokens. Always distinct from the API access secret: either an
// explicit JITSI_JWT_SECRET, or a key derived from the access secret with a fixed label, so
// existing deployments keep working without new configuration.
export function getJitsiSecret() {
  if (process.env.JITSI_JWT_SECRET) return process.env.JITSI_JWT_SECRET;
  return crypto.createHmac('sha256', getAccessSecret()).update('real-i/jitsi-join-token/v1').digest('hex');
}
