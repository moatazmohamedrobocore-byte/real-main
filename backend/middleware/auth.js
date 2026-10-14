import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { getAccessSecret } from '../config/secrets.js';

const getSecret = () => getAccessSecret();

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
      'SELECT id, email, name, role FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found or account deactivated.' } });
    }

    const user = result.rows[0];
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
      'SELECT id, email, name, role FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
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
