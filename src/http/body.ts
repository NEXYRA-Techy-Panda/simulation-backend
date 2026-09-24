import type { Request } from 'express';
import { ApiError } from './errors.js';

/** Returns the JSON object body (empty when absent), rejecting non-objects and unknown fields. */
export function objectBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, 'VALIDATION_ERROR', `Unknown field "${key}"`, key);
  }
  return body as Record<string, unknown>;
}
