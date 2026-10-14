import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Every error response from this API has the same shape:
 *
 *   { "error": { "code": "not_found", "message": "Feed XYZ not found" } }
 *
 * A consistent shape means the front end can handle errors in one place,
 * and `code` gives programs something stable to check (messages may change).
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Runs when no route matched the request. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
};

/**
 * Express recognizes error handlers by their four arguments. In Express 5,
 * errors thrown inside async route handlers land here automatically.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Anything else is a bug or an outage. Log the details for us, but don't
  // leak internals (stack traces, SQL) to the client.
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
};
