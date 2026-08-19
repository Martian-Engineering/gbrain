import type { BrainEngine } from './engine.ts';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const OPEN_LOOP_KINDS = ['commitment', 'intro'] as const;

/** The Chronicle event kinds that can remain open on the Desk. */
export type OpenLoopKind = typeof OPEN_LOOP_KINDS[number];

/** Stable database boundary encoded inside an opaque open-loop cursor. */
export interface OpenLoopCursor {
  version: typeof CURSOR_VERSION;
  date: string;
  eventPageId: number;
  sourceId: string;
}

/** One unresolved Chronicle event projected into one authorized source. */
export interface OpenLoopItem {
  date: string;
  summary: string;
  event_page_id: number;
  event_source_id: string;
  event_slug: string;
  source_id: string;
  source_page_slugs: string[];
  kind: OpenLoopKind;
  owner: string | null;
  who: string[] | null;
  effective_date: string | null;
}

/** Cursor-paginated unresolved Chronicle events ordered oldest first. */
export interface OpenLoopPage {
  schema_version: 1;
  items: OpenLoopItem[];
  next_cursor: string | null;
}

/** Inputs accepted by the open-loop query. */
export interface ListOpenLoopsInput {
  since: string;
  until: string;
  cursor?: string;
  limit?: number;
  sourceId?: string;
  sourceIds?: string[];
}

/** Validation failure raised by open-loop request helpers. */
export class OpenLoopValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenLoopValidationError';
  }
}

interface OpenLoopRow {
  date: string;
  summary: string;
  event_page_id: number | string;
  event_source_id: string;
  event_slug: string;
  source_id: string;
  source_page_slugs: string[];
  kind: string;
  owner: string | null;
  who: unknown;
  effective_date: string | Date | null;
}

/** Encode an open-loop boundary without exposing its fields as API structure. */
export function encodeOpenLoopCursor(cursor: OpenLoopCursor): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode and fail-closed validate an opaque open-loop cursor. */
export function decodeOpenLoopCursor(encoded: string): OpenLoopCursor {
  if (
    typeof encoded !== 'string'
    || encoded.length === 0
    || encoded.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new OpenLoopValidationError('Invalid open-loop cursor');
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    validateCursor(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof OpenLoopValidationError) throw error;
    throw new OpenLoopValidationError('Invalid open-loop cursor');
  }
}

/** List unresolved commitment and intro events after applying Desk resolution state. */
export async function listOpenLoops(
  engine: BrainEngine,
  input: ListOpenLoopsInput,
): Promise<OpenLoopPage> {
  validateInput(input);
  const limit = normalizeLimit(input.limit);
  const cursor = input.cursor ? decodeOpenLoopCursor(input.cursor) : null;
  const params: unknown[] = [input.since, input.until, [...OPEN_LOOP_KINDS]];
  const scope = buildSourceScope(input, params);
  const boundary = cursor
    ? buildCursorBoundary(cursor, params)
    : '';

  params.push(limit + 1);
  const rows = await engine.executeRaw<OpenLoopRow>(
    `WITH open_events AS (
       SELECT
         COALESCE(ep.effective_date::date, MIN(te.date)) AS event_date,
         COALESCE(NULLIF(ep.frontmatter->'event'->>'what', ''), MIN(te.summary)) AS summary,
         ep.id AS event_page_id,
         ep.source_id AS event_source_id,
         ep.slug AS event_slug,
         p.source_id,
         ARRAY_AGG(DISTINCT p.slug ORDER BY p.slug) AS source_page_slugs,
         ep.frontmatter->'event'->>'kind' AS kind,
         NULLIF(ep.frontmatter->'event'->>'owner', '') AS owner,
         ep.frontmatter->'event'->'who' AS who,
         ep.effective_date
       FROM timeline_entries te
       JOIN pages ep ON ep.id = te.event_page_id
       JOIN pages p ON p.id = te.page_id
       WHERE ep.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND ep.frontmatter->'event'->>'kind' = ANY($3::text[])
         AND COALESCE(ep.effective_date::date, te.date) >= $1::date
         AND COALESCE(ep.effective_date::date, te.date) <= $2::date
         AND NOT EXISTS (
           SELECT 1
             FROM tags resolution
            WHERE resolution.page_id = ep.id
              AND resolution.tag IN ('desk:done', 'desk:let-go')
         )
         ${scope}
       GROUP BY ep.id, ep.source_id, ep.slug, ep.frontmatter, ep.effective_date, p.source_id
     )
     SELECT
       to_char(event_date, 'YYYY-MM-DD') AS date,
       summary,
       event_page_id,
       event_source_id,
       event_slug,
       source_id,
       source_page_slugs,
       kind,
       owner,
       who,
       effective_date
     FROM open_events
     WHERE TRUE ${boundary}
     ORDER BY event_date ASC, event_page_id ASC, source_id ASC
     LIMIT $${params.length}`,
    params,
  );

  const overflow = rows.length > limit;
  const selected = rows.slice(0, limit);
  const items = selected.map(normalizeRow);
  const last = items.at(-1);

  return {
    schema_version: 1,
    items,
    next_cursor: overflow && last
      ? encodeOpenLoopCursor({
        version: CURSOR_VERSION,
        date: last.date,
        eventPageId: last.event_page_id,
        sourceId: last.source_id,
      })
      : null,
  };
}

/** Add source predicates for both the event page and its projected depth page. */
function buildSourceScope(input: ListOpenLoopsInput, params: unknown[]): string {
  if (input.sourceIds !== undefined) {
    params.push(input.sourceIds);
    const position = params.length;
    return `AND ep.source_id = ANY($${position}::text[])
            AND p.source_id = ANY($${position}::text[])`;
  }
  if (input.sourceId !== undefined) {
    params.push(input.sourceId);
    const position = params.length;
    return `AND ep.source_id = $${position}
            AND p.source_id = $${position}`;
  }
  return '';
}

/** Add a strict oldest-first keyset boundary. */
function buildCursorBoundary(cursor: OpenLoopCursor, params: unknown[]): string {
  params.push(cursor.date, cursor.eventPageId, cursor.sourceId);
  const datePosition = params.length - 2;
  const idPosition = params.length - 1;
  const sourcePosition = params.length;
  return `AND (event_date, event_page_id, source_id)
              > ($${datePosition}::date, $${idPosition}::bigint, $${sourcePosition}::text)`;
}

/** Normalize database values into the stable public response shape. */
function normalizeRow(row: OpenLoopRow): OpenLoopItem {
  if (!isOpenLoopKind(row.kind)) {
    throw new OpenLoopValidationError('Database returned an invalid open-loop kind');
  }

  return {
    date: row.date,
    summary: row.summary,
    event_page_id: Number(row.event_page_id),
    event_source_id: row.event_source_id,
    event_slug: row.event_slug,
    source_id: row.source_id,
    source_page_slugs: row.source_page_slugs,
    kind: row.kind,
    owner: row.owner,
    who: normalizeWho(row.who),
    effective_date: row.effective_date === null
      ? null
      : row.effective_date instanceof Date
        ? row.effective_date.toISOString()
        : row.effective_date,
  };
}

/** Preserve only well-formed participant slug arrays. */
function normalizeWho(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : null;
}

/** Validate the operation request before constructing SQL. */
function validateInput(input: ListOpenLoopsInput): void {
  validateDate(input.since, 'since');
  validateDate(input.until, 'until');
  if (input.since > input.until) {
    throw new OpenLoopValidationError('since must be on or before until');
  }
  if (input.sourceId !== undefined && input.sourceIds !== undefined) {
    throw new OpenLoopValidationError('sourceId and sourceIds are mutually exclusive');
  }
  if (input.sourceId !== undefined && input.sourceId.length === 0) {
    throw new OpenLoopValidationError('sourceId cannot be empty');
  }
  if (input.sourceIds !== undefined && input.sourceIds.length === 0) {
    throw new OpenLoopValidationError('sourceIds cannot be empty');
  }
  if (input.sourceIds?.some(sourceId => typeof sourceId !== 'string' || sourceId.length === 0)) {
    throw new OpenLoopValidationError('sourceIds must contain non-empty strings');
  }
}

/** Validate one calendar date without accepting timestamp-shaped values. */
function validateDate(value: string, name: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
  if (parsed === null || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new OpenLoopValidationError(`${name} must be a valid YYYY-MM-DD date`);
  }
}

/** Bound query size so callers must use the cursor for complete reads. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new OpenLoopValidationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

/** Validate an opaque cursor's decoded structure. */
function validateCursor(value: unknown): asserts value is OpenLoopCursor {
  if (
    !isRecord(value)
    || value.version !== CURSOR_VERSION
    || typeof value.date !== 'string'
    || typeof value.eventPageId !== 'number'
    || !Number.isSafeInteger(value.eventPageId)
    || value.eventPageId < 1
    || typeof value.sourceId !== 'string'
    || value.sourceId.length === 0
  ) {
    throw new OpenLoopValidationError('Invalid open-loop cursor');
  }
  validateDate(value.date, 'cursor date');
}

/** Return whether a database kind belongs to the closed open-loop set. */
function isOpenLoopKind(value: string): value is OpenLoopKind {
  return (OPEN_LOOP_KINDS as readonly string[]).includes(value);
}

/** Narrow unknown JSON values before field inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
