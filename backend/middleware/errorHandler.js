export function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`
    }
  });
}

export function errorHandler(err, req, res, _next) {
  const rid = req.id || '-';
  // Log server-side with the request id; never log request bodies/headers (may hold secrets).
  console.error(`[Error ${rid}] ${req.method} ${req.path}: ${err.message}`, err.stack ? `\n${err.stack}` : '');

  let status = err.status || err.statusCode || 500;
  let code = err.code || 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'An internal server error occurred.';

  // PostgreSQL unique violation
  if (err.code === '23505') {
    status = 409;
    code = 'DUPLICATE_RECORD';
    message = 'A record with this identifier or unique attribute already exists.';
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    status = 400;
    code = 'FOREIGN_KEY_VIOLATION';
    message = 'Referenced resource does not exist.';
  }

  // PostgreSQL invalid text representation (e.g. invalid UUID format)
  if (err.code === '22P02') {
    status = 400;
    code = 'INVALID_SYNTAX';
    message = 'Invalid identifier syntax.';
  }

  // Do not leak internal error text to clients on 5xx unless explicitly marked safe.
  const knownSafe = status < 500 || err.expose === true || ['DUPLICATE_RECORD', 'FOREIGN_KEY_VIOLATION', 'INVALID_SYNTAX'].includes(code);
  const clientMessage = knownSafe ? message : 'An internal server error occurred.';
  const clientCode = knownSafe ? code : 'INTERNAL_SERVER_ERROR';

  res.status(status).json({
    error: {
      code: clientCode,
      message: clientMessage
    },
    message: clientMessage, // backwards compat
    requestId: rid
  });
}
