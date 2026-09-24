import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request } from 'express';
import type { Database } from '../db/connection.js';
import {
  DEFAULT_EXPORT_LIMITS,
  EXPORT_INTERVALS,
  type ExportFormat,
  type ExportIntervalSeconds,
  type ExportLimits,
  type ExportSelection,
} from '../export/types.js';
import { isCanonicalUtc, seconds } from '../export/time.js';
import { listRuns, prepareExport } from '../export/dataset.js';
import { exportFilename, iterateCsvChunks, iterateJsonChunks } from '../export/serialize.js';
import { objectBody } from '../http/body.js';
import { ApiError } from '../http/errors.js';

export interface ExportDatabaseProvider {
  open(): Database;
  /** Close only provider-owned connections. Omit for an injected shared test connection. */
  close?(db: Database): void;
}

const EXPORT_KEYS = ['run_id', 'format', 'from', 'to', 'interval_seconds'];

function invalid(message: string, field?: string): never {
  throw new ApiError(400, 'VALIDATION_ERROR', message, field);
}

function oneQueryValue(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must appear exactly once.`, field);
  return value;
}

function parsePage(raw: unknown, field: string, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const text = oneQueryValue(raw, field);
  if (!/^\d+$/.test(text)) invalid(`${field} must be a positive integer.`, field);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(`${field} must be between 1 and ${maximum}.`, field);
  }
  return value;
}

function parseSelection(raw: Record<string, unknown>, query: boolean): ExportSelection {
  for (const key of Object.keys(raw)) {
    if (!EXPORT_KEYS.includes(key)) invalid(`Unknown export field "${key}".`, key);
  }
  const runId = oneQueryValue(raw.run_id, 'run_id');
  if (runId.length < 1 || runId.length > 128) invalid('run_id must contain 1 to 128 characters.', 'run_id');
  const format = oneQueryValue(raw.format, 'format');
  if (format !== 'json' && format !== 'csv') invalid('format must be json or csv.', 'format');

  const fromUtc = oneQueryValue(raw.from, 'from');
  const toUtc = oneQueryValue(raw.to, 'to');
  if (!isCanonicalUtc(fromUtc)) invalid('from must be a real UTC timestamp in YYYY-MM-DDTHH:MM:SSZ form.', 'from');
  if (!isCanonicalUtc(toUtc)) invalid('to must be a real UTC timestamp in YYYY-MM-DDTHH:MM:SSZ form.', 'to');
  if (seconds(toUtc) <= seconds(fromUtc)) invalid('to must be after from.', 'to');

  const intervalRaw = raw.interval_seconds;
  let intervalNumber: number;
  if (query) {
    intervalNumber = Number(oneQueryValue(intervalRaw, 'interval_seconds'));
  } else {
    if (typeof intervalRaw !== 'number' || !Number.isInteger(intervalRaw)) {
      invalid('interval_seconds must be an integer.', 'interval_seconds');
    }
    intervalNumber = intervalRaw;
  }
  if (!EXPORT_INTERVALS.includes(intervalNumber as ExportIntervalSeconds)) {
    invalid('interval_seconds must be one of 60, 300, 600, 900, 1800, 3600.', 'interval_seconds');
  }
  return {
    runId,
    format: format as ExportFormat,
    fromUtc,
    toUtc,
    intervalSeconds: intervalNumber as ExportIntervalSeconds,
  };
}

function selectionFromRequest(req: Request): ExportSelection {
  if (req.method === 'GET') {
    return parseSelection(req.query as Record<string, unknown>, true);
  }
  return parseSelection(objectBody(req, EXPORT_KEYS), false);
}

function beginSnapshot(db: Database): void {
  db.exec('BEGIN');
}

function endSnapshot(db: Database): void {
  if (db.isTransaction) db.exec('ROLLBACK');
}

export function exportsRouter(provider: ExportDatabaseProvider, limits: ExportLimits = DEFAULT_EXPORT_LIMITS): Router {
  const router = Router();
  let activeExports = 0;

  router.get('/runs', (req, res) => {
    const allowed = ['page', 'page_size'];
    for (const key of Object.keys(req.query)) if (!allowed.includes(key)) invalid(`Unknown run-list field "${key}".`, key);
    const page = parsePage(req.query.page, 'page', 1, 1_000_000);
    const pageSize = parsePage(req.query.page_size, 'page_size', 50, 200);
    const db = provider.open();
    try {
      beginSnapshot(db);
      const result = listRuns(db, page, pageSize);
      endSnapshot(db);
      res.status(200).json({
        data: { runs: result.runs },
        meta: {
          request_id: res.locals.requestId as string,
          pagination: {
            page,
            page_size: pageSize,
            total_items: result.total,
            total_pages: Math.max(1, Math.ceil(result.total / pageSize)),
          },
        },
      });
    } catch (error) {
      endSnapshot(db);
      throw error;
    } finally {
      provider.close?.(db);
    }
  });

  const handleExport = async (req: Request, res: import('express').Response): Promise<void> => {
    const selection = selectionFromRequest(req);
    if (activeExports >= 2) {
      throw new ApiError(503, 'CONFLICT', 'Too many exports are already in progress; retry shortly.');
    }
    activeExports += 1;
    let db: Database | undefined;
    try {
      // Opening inside the protected region is deliberate: a reader-open failure
      // must release capacity just like every later preflight/stream failure.
      db = provider.open();
      beginSnapshot(db);
      const prepared = prepareExport(db, selection, limits);

      const filename = exportFilename(prepared);
      res.status(200);
      res.setHeader('Content-Type', selection.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const chunks = selection.format === 'csv'
        ? iterateCsvChunks(db, prepared)
        : iterateJsonChunks(db, prepared);
      await pipeline(Readable.from(chunks), res);
    } catch (error) {
      if (!res.headersSent) throw error;
      if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      try {
        if (db) endSnapshot(db);
      } finally {
        try {
          if (db) provider.close?.(db);
        } finally {
          // Capacity is released even if rollback or provider cleanup fails.
          activeExports -= 1;
        }
      }
    }
  };

  router.get('/export', (req, res, next) => {
    void handleExport(req, res).catch(next);
  });
  router.post('/export', (req, res, next) => {
    void handleExport(req, res).catch(next);
  });

  return router;
}
