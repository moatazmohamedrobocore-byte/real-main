import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { getAccessSecret } from '../config/secrets.js';

const getSecret = () => getAccessSecret();

// F-18: revoke every session (access + refresh tokens) for a user.
// Access tokens are stateless, so they are cut off by the `tokens_valid_after` watermark that
// `authenticate` compares each token's second-precision `iat` against. JWT only records whole
// seconds, so the watermark rounds up to the next second: everything issued at or before this
// second dies, and the client has to sign in again.
export async function revokeUserSessions(userId) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await query(
    `UPDATE users SET tokens_valid_after = date_trunc('second', now()) + interval '1 second' WHERE id = $1`,
    [userId]
  );
}

// F-08 / F-19: only genuine API access tokens are accepted. The algorithm is pinned and the
// `type` claim must be 'access', so a refresh token or a Jitsi join token (which carries no
// such claim and is signed with a different key) can never authenticate an API request.
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  if (decoded.type !== 'access' || !decoded.sub) {
    const err = new Error('Not an access token.');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
}

export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required. Missing Bearer token.' } });
  }

  const token = header.slice(7).trim();
  try {
    const decoded = verifyAccessToken(token);
    const userId = decoded.sub;

    const result = await query(
      `SELECT id, email, name, role,
              extract(epoch from tokens_valid_after)::bigint AS tokens_valid_after
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found or account deactivated.' } });
    }

    // F-18: a token minted before the account's revocation watermark is dead even though it
    // has not reached its own expiry. `>=` is compared on the raw value so a missing `iat`
    // (NaN-free check) cannot slip past.
    const { tokens_valid_after: validAfter, ...user } = result.rows[0];
    if (validAfter !== null && !(Number(decoded.iat) >= validAfter)) {
      return res.status(401).json({ error: { code: 'SESSION_REVOKED', message: 'Session revoked. Please sign in again.' } });
    }

    req.user = user;
    req.auth = {
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      tokenId: decoded.jti || null,
      familyId: decoded.fid || null
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Token expired.' } });
    }
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or malformed authentication token.' } });
  }
}

export async function authenticateOptional(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    req.auth = null;
    return next();
  }

  const token = header.slice(7).trim();
  try {
    const decoded = verifyAccessToken(token);
    const userId = decoded.sub;

    const result = await query(
      `SELECT id, email, name, role,
              extract(epoch from tokens_valid_after)::bigint AS tokens_valid_after
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    // F-18: revoked tokens authenticate nobody, not even optionally.
    const row = result.rows[0];
    const validAfter = row?.tokens_valid_after ?? null;
    const revoked = validAfter !== null && !(Number(decoded.iat) >= validAfter);

    if (row && !revoked) {
      const { tokens_valid_after: _drop, ...user } = row;
      req.user = user;
      req.auth = {
        userId: user.id,
        role: user.role,
        email: user.email,
        name: user.name,
        tokenId: decoded.jti || null,
        familyId: decoded.fid || null
      };
    }
  } catch (_) {
    req.user = null;
    req.auth = null;
  }
  next();
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Access forbidden: requires one of [${roles.join(', ')}], current role is '${req.user?.role || 'anonymous'}'`
        }
      });
    }
    next();
  };
}

export const allowAnonymous = (_req, _res, next) => next();
