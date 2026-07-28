import type { BrainEngine } from './engine.ts';
import type { ParamSummary, TraceDisplayField } from '../mcp/dispatch.ts';

const MAX_CURSOR_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_PAGE_SIZE = 100;
const MAX_SUMMARY_ITEMS = 32;
const TRACE_FIELD_KINDS = new Set([
  'action',
  'client',
  'filter',
  'job',
  'link_type',
  'page',
  'proposal',
  'source',
  'take',
]);

/** Stable database boundary encoded inside an opaque pagination cursor. */
export interface RequestTraceCursor {
  createdAt: string;
  id: number;
}

/** One privacy-normalized request-log entry returned to admin clients. */
export interface RequestTraceEntry {
  id: number;
  operation: string;
  outcome: 'success' | 'failed';
  latency_ms: number | null;
  created_at: string;
  request: ParamSummary | null;
}

/** Cursor-paginated request history ordered newest first. */
export interface RequestTracePage {
  entries: RequestTraceEntry[];
  older_cursor: string | null;
  newer_cursor: string | null;
  has_older: boolean;
  has_newer: boolean;
}

/** Inputs accepted by the request-history query. */
export interface ListRequestTracesInput {
  clientId: string;
  outcome?: 'all' | 'success' | 'failed';
  pageOnly?: boolean;
  limit?: number;
  before?: string;
  after?: string;
}

/** Trace-safe parameter metadata resolved from an operation definition. */
export interface RequestTraceFieldDefinition {
  params: Record<string, { trace?: { kind: TraceDisplayField['kind'] } }>;
}

/** Resolves the canonical trace allowlist for one logged operation. */
export type RequestTraceFieldResolver =
  (operation: string) => RequestTraceFieldDefinition | undefined;

/** Validation failure raised by cursor and request-history helpers. */
export class RequestTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestTraceValidationError';
  }
}

interface RequestTraceRow {
  id: number | string;
  operation: string;
  latency_ms: number | string | null;
  status: string;
  params: unknown;
  created_at: string | Date;
  cursor_created_at: string;
}

/** Encode a trace boundary without exposing its timestamp or row id directly. */
export function encodeRequestTraceCursor(cursor: RequestTraceCursor): string {
  validateCursorShape(cursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode and fail-closed validate an opaque request-trace cursor. */
export function decodeRequestTraceCursor(encoded: string): RequestTraceCursor {
  if (
    typeof encoded !== 'string'
    || encoded.length === 0
    || encoded.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    validateCursorShape(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof RequestTraceValidationError) throw error;
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }
}

/** Query one OAuth client's trace history with stable keyset pagination. */
export async function listRequestTraces(
  engine: BrainEngine,
  input: ListRequestTracesInput,
  resolveFields: RequestTraceFieldResolver = () => undefined,
): Promise<RequestTracePage> {
  validateListInput(input);
  const outcome = input.outcome ?? 'all';
  const limit = normalizeLimit(input.limit);

  // A cursor is a strict row boundary. "before" walks toward older rows;
  // "after" walks toward newer rows and reverses the ascending SQL slice
  // before returning it so every response remains newest first.
  const boundary = input.before
    ? decodeRequestTraceCursor(input.before)
    : input.after
      ? decodeRequestTraceCursor(input.after)
      : null;
  const direction = input.after ? 'after' : input.before ? 'before' : 'initial';
  const where = ['token_name = $1'];
  const params: unknown[] = [input.clientId];

  // Outcome fragments are closed constants. All caller-controlled values stay
  // in positional parameters, including the client id and cursor boundary.
  if (outcome === 'success') {
    where.push(`status = 'success'`);
  } else if (outcome === 'failed') {
    where.push(`status <> 'success'`);
  }
  if (input.pageOnly) {
    where.push(`params->'display_fields' @> '[{"kind":"page"}]'::jsonb`);
  }

  if (boundary) {
    params.push(boundary.createdAt, boundary.id);
    const comparator = direction === 'after' ? '>' : '<';
    where.push(
      `(created_at ${comparator} $${params.length - 1}::timestamptz
        OR (created_at = $${params.length - 1}::timestamptz
            AND id ${comparator} $${params.length}::bigint))`,
    );
  }

  params.push(limit + 1);
  const rows = await engine.executeRaw<RequestTraceRow>(
    `SELECT id, operation, latency_ms, status, params, created_at,
            to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS cursor_created_at
       FROM mcp_request_log
      WHERE ${where.join(' AND ')}
      ORDER BY created_at ${direction === 'after' ? 'ASC' : 'DESC'},
               id ${direction === 'after' ? 'ASC' : 'DESC'}
      LIMIT $${params.length}`,
    params,
  );

  // Fetch one extra row to determine whether the requested direction has
  // another page without an offset count or a second database query.
  const overflow = rows.length > limit;
  const selected = rows.slice(0, limit);
  if (direction === 'after') selected.reverse();
  const entries = selected.map(row => normalizeTraceRow(row, resolveFields(row.operation)));
  const hasOlder = entries.length > 0 && (direction === 'after' || overflow);
  const hasNewer = entries.length > 0 && (direction === 'before' || (direction === 'after' && overflow));
  const oldest = selected.at(-1);
  const newest = selected[0];

  return {
    entries,
    older_cursor: hasOlder && oldest
      ? encodeRequestTraceCursor({
        createdAt: oldest.cursor_created_at,
        id: Number(oldest.id),
      })
      : null,
    newer_cursor: hasNewer && newest
      ? encodeRequestTraceCursor({
        createdAt: newest.cursor_created_at,
        id: Number(newest.id),
      })
      : null,
    has_older: hasOlder,
    has_newer: hasNewer,
  };
}

/** Strip raw or malformed params while preserving recognized redacted summaries. */
export function normalizeRequestTraceSummary(
  value: unknown,
  definition?: RequestTraceFieldDefinition,
): ParamSummary | null {
  // Older deployments briefly persisted JSON text inside JSONB. Parse that
  // one legacy layer, but reject anything that is not a redacted envelope.
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(candidate) || candidate.redacted !== true || typeof candidate.kind !== 'string') {
    return null;
  }

  const summary: ParamSummary = {
    redacted: true,
    kind: candidate.kind.slice(0, 32),
  };

  // Copy only bounded scalar diagnostics. No unknown properties from the
  // stored JSON object flow into the response.
  if (candidate.version === 2) summary.version = 2;
  if (Number.isSafeInteger(candidate.length) && (candidate.length as number) >= 0) {
    summary.length = candidate.length as number;
  }
  if (Number.isSafeInteger(candidate.approx_bytes) && (candidate.approx_bytes as number) >= 0) {
    summary.approx_bytes = candidate.approx_bytes as number;
  }
  if (Number.isSafeInteger(candidate.unknown_key_count) && (candidate.unknown_key_count as number) >= 0) {
    summary.unknown_key_count = candidate.unknown_key_count as number;
  }

  const allowedParamNames = new Set(Object.keys(definition?.params ?? {}));
  const declaredKeys = normalizeIdentifierArray(candidate.declared_keys)
    .filter(name => allowedParamNames.has(name));
  if (declaredKeys.length > 0) summary.declared_keys = declaredKeys;
  const sourceScope = normalizeIdentifierArray(candidate.source_scope);
  if (sourceScope.length > 0) summary.source_scope = sourceScope;

  const displayFields = Array.isArray(candidate.display_fields)
    ? candidate.display_fields
      .map(field => normalizeDisplayField(field, definition))
      .filter((field): field is TraceDisplayField => field !== null)
      .slice(0, MAX_SUMMARY_ITEMS)
    : [];

  // Display fields receive a second allowlist check at read time. This keeps a
  // raw or malformed stored payload from manufacturing free-form UI fields.
  if (displayFields.length > 0) summary.display_fields = displayFields;
  return summary;
}

function validateCursorShape(value: unknown): asserts value is RequestTraceCursor {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'createdAt,id') {
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }
  if (
    typeof value.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
  ) {
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }
  const milliseconds = `${value.createdAt.slice(0, -4)}Z`;
  if (Number.isNaN(new Date(milliseconds).getTime())) {
    throw new RequestTraceValidationError('Invalid request trace cursor');
  }
}

function validateListInput(input: ListRequestTracesInput): void {
  if (
    typeof input.clientId !== 'string'
    || input.clientId.length === 0
    || input.clientId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new RequestTraceValidationError('client_id must be a non-empty identifier');
  }
  if (input.before && input.after) {
    throw new RequestTraceValidationError('before and after are mutually exclusive');
  }
  if (input.outcome && !['all', 'success', 'failed'].includes(input.outcome)) {
    throw new RequestTraceValidationError('outcome must be all, success, or failed');
  }
  if (input.pageOnly !== undefined && typeof input.pageOnly !== 'boolean') {
    throw new RequestTraceValidationError('page_only must be a boolean');
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit)) {
    throw new RequestTraceValidationError('limit must be a finite number');
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(limit)));
}

function normalizeTraceRow(
  row: RequestTraceRow,
  definition?: RequestTraceFieldDefinition,
): RequestTraceEntry {
  // Drivers differ on BIGINT and TIMESTAMPTZ representation, so normalize the
  // database row before it crosses the MCP contract.
  const id = Number(row.id);
  const latency = row.latency_ms === null ? null : Number(row.latency_ms);
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  return {
    id,
    operation: row.operation,
    outcome: row.status === 'success' ? 'success' : 'failed',
    latency_ms: Number.isFinite(latency) ? latency : null,
    created_at: createdAt,
    request: normalizeRequestTraceSummary(row.params, definition),
  };
}

function normalizeIdentifierArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string =>
      typeof item === 'string'
      && item.length > 0
      && item.length <= MAX_IDENTIFIER_LENGTH
      && /^[A-Za-z0-9_.:/-]+$/.test(item)
    )
    .slice(0, MAX_SUMMARY_ITEMS);
}

function normalizeDisplayField(
  value: unknown,
  definition?: RequestTraceFieldDefinition,
): TraceDisplayField | null {
  // Validate the serialized shape before consulting operation metadata. This
  // also bounds work on malformed arrays read from historical rows.
  if (
    !isRecord(value)
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name.length > 64
    || !/^[a-z][a-z0-9_]*$/.test(value.name)
    || typeof value.kind !== 'string'
    || !TRACE_FIELD_KINDS.has(value.kind)
  ) {
    return null;
  }
  const expectedKind = definition?.params[value.name]?.trace?.kind;
  if (expectedKind !== value.kind) return null;

  // Even explicitly annotated fields remain scalar and bounded. Objects,
  // arrays, non-finite numbers, and oversized strings are discarded.
  const scalar = value.value;
  const validString = typeof scalar === 'string'
    && scalar.length > 0
    && scalar.length <= MAX_IDENTIFIER_LENGTH;
  const validScalar = validString
    || typeof scalar === 'boolean'
    || (typeof scalar === 'number' && Number.isFinite(scalar));
  if (!validScalar) return null;
  return {
    name: value.name,
    kind: value.kind as TraceDisplayField['kind'],
    value: scalar as TraceDisplayField['value'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
