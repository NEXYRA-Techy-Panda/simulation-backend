import type { ErrorRequestHandler, RequestHandler } from 'express';
import { type ErrorCode, sendError } from './envelope.js';

/** An error that maps directly to a contract error envelope. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly field?: string) {
    super(message);
  }
}

export const notFound: RequestHandler = (req, res) => {
  sendError(res, 404, { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
};

interface HttpishError {
  type?: string;
  status?: number;
  statusCode?: number;
}

/** Maps body-parser failures to contract codes; anything else is a 500 without internals. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    sendError(res, err.status, { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) });
    return;
  }
  const e = (typeof err === 'object' && err !== null ? err : {}) as HttpishError;
  if (e.type === 'entity.too.large') {
    sendError(res, 413, { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured limit' });
    return;
  }
  if (e.type === 'entity.parse.failed') {
    sendError(res, 400, { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' });
    return;
  }
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    sendError(res, status, { code: 'VALIDATION_ERROR', message: 'Invalid request' });
    return;
  }
  console.error(err);
  sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error' });
};
