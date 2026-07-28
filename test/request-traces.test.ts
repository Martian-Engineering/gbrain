import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  decodeRequestTraceCursor,
  encodeRequestTraceCursor,
  RequestTraceValidationError,
  type RequestTracePage,
} from '../src/core/request-traces.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function context(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    auth: {
      token: 'keeper-token',
      clientId: 'keeper-client',
      scopes: ['admin'],
    },
  };
}

async function insertTrace(input: {
  clientId?: string;
  operation: string;
  status?: string;
  params?: unknown;
  createdAt: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO mcp_request_log (
       token_name, agent_name, operation, latency_ms, status, params,
       error_message, created_at
     ) VALUES ($1, 'Trace fixture', $2, 7, $3, $4::jsonb, 'private error', $5)
     RETURNING id`,
    [
      input.clientId ?? 'target-client',
      input.operation,
      input.status ?? 'success',
      JSON.stringify(input.params ?? null),
      input.createdAt,
    ],
  );
  return rows[0]!.id;
}

async function list(params: Record<string, unknown>): Promise<RequestTracePage> {
  return operationsByName.list_request_traces.handler(
    context(),
    params,
  ) as Promise<RequestTracePage>;
}

describe('request trace cursors', () => {
  test('round-trips an opaque timestamp/id boundary', () => {
    const encoded = encodeRequestTraceCursor({
      createdAt: '2026-07-28T17:00:00.000000Z',
      id: 42,
    });
    expect(encoded).not.toContain('2026-07-28');
    expect(decodeRequestTraceCursor(encoded)).toEqual({
      createdAt: '2026-07-28T17:00:00.000000Z',
      id: 42,
    });
  });

  test('rejects malformed, oversized, and structurally unexpected cursors', () => {
    expect(() => decodeRequestTraceCursor('not-json')).toThrow(RequestTraceValidationError);
    expect(() => decodeRequestTraceCursor('x'.repeat(513))).toThrow(RequestTraceValidationError);
    const unexpected = Buffer.from(JSON.stringify({
      createdAt: '2026-07-28T17:00:00.000000Z',
      id: 42,
      clientId: 'other-client',
    })).toString('base64url');
    expect(() => decodeRequestTraceCursor(unexpected)).toThrow(RequestTraceValidationError);
  });
});

describe('list_request_traces', () => {
  test('uses id as the stable tie-breaker for equal timestamps', async () => {
    const createdAt = '2026-07-28T17:00:00.000Z';
    const first = await insertTrace({ operation: 'get_page', createdAt });
    const second = await insertTrace({ operation: 'put_page', createdAt });
    const third = await insertTrace({ operation: 'delete_page', createdAt });
    await insertTrace({
      clientId: 'other-client',
      operation: 'private_other_client_op',
      createdAt,
    });

    const page = await list({ client_id: 'target-client', limit: 10 });
    expect(page.entries.map(entry => entry.id)).toEqual([third, second, first]);
    expect(JSON.stringify(page)).not.toContain('private_other_client_op');
  });

  test('preserves microsecond timestamp precision across page boundaries', async () => {
    await insertTrace({
      operation: 'oldest-microsecond',
      createdAt: '2026-07-28T17:00:00.123001Z',
    });
    await insertTrace({
      operation: 'middle-microsecond',
      createdAt: '2026-07-28T17:00:00.123456Z',
    });
    await insertTrace({
      operation: 'newest-microsecond',
      createdAt: '2026-07-28T17:00:00.123999Z',
    });

    const newest = await list({ client_id: 'target-client', limit: 1 });
    const middle = await list({
      client_id: 'target-client',
      limit: 1,
      before: newest.older_cursor,
    });
    const oldest = await list({
      client_id: 'target-client',
      limit: 1,
      before: middle.older_cursor,
    });

    expect(newest.entries[0]?.operation).toBe('newest-microsecond');
    expect(middle.entries[0]?.operation).toBe('middle-microsecond');
    expect(oldest.entries[0]?.operation).toBe('oldest-microsecond');
  });

  test('installs the client/time/id keyset index', async () => {
    const rows = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE indexname = 'idx_mcp_log_token_time_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('(token_name, created_at DESC, id DESC)');
  });

  test('pages older and newer without duplicates across a concurrent insert', async () => {
    for (let minute = 0; minute < 6; minute++) {
      await insertTrace({
        operation: `op-${minute}`,
        createdAt: `2026-07-28T17:0${minute}:00.000Z`,
      });
    }

    const newest = await list({ client_id: 'target-client', limit: 2 });
    expect(newest.entries.map(entry => entry.operation)).toEqual(['op-5', 'op-4']);
    expect(newest.has_older).toBe(true);
    expect(newest.has_newer).toBe(false);

    const older = await list({
      client_id: 'target-client',
      limit: 2,
      before: newest.older_cursor,
    });
    expect(older.entries.map(entry => entry.operation)).toEqual(['op-3', 'op-2']);

    await insertTrace({
      operation: 'concurrent-new',
      createdAt: '2026-07-28T17:06:00.000Z',
    });

    const newer = await list({
      client_id: 'target-client',
      limit: 2,
      after: older.newer_cursor,
    });
    expect(newer.entries.map(entry => entry.operation)).toEqual(['op-5', 'op-4']);
    expect(newer.has_newer).toBe(true);
    expect(new Set([
      ...older.entries.map(entry => entry.id),
      ...newer.entries.map(entry => entry.id),
    ]).size).toBe(4);
  });

  test('filters outcomes and never returns raw params or error messages', async () => {
    await insertTrace({
      operation: 'put_page',
      status: 'success',
      createdAt: '2026-07-28T17:00:00.000Z',
      params: {
        redacted: true,
        version: 2,
        kind: 'object',
        declared_keys: ['content', 'slug'],
        display_fields: [
          { name: 'slug', kind: 'page', value: 'projects/trace-example' },
        ],
      },
    });
    await insertTrace({
      operation: 'query',
      status: 'error',
      createdAt: '2026-07-28T17:01:00.000Z',
      params: {
        redacted: true,
        version: 2,
        kind: 'object',
        question: 'raw private question',
        display_fields: [
          { name: 'question', kind: 'page', value: 'raw private question' },
        ],
      },
    });

    const failed = await list({
      client_id: 'target-client',
      outcome: 'failed',
      limit: 10,
    });
    expect(failed.entries).toHaveLength(1);
    expect(failed.entries[0]).toEqual(expect.objectContaining({
      operation: 'query',
      outcome: 'failed',
    }));
    expect(failed.entries[0]?.request?.display_fields).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('raw private question');
    expect(JSON.stringify(failed)).not.toContain('private error');

    const successful = await list({
      client_id: 'target-client',
      outcome: 'success',
      limit: 10,
    });
    expect(successful.entries[0]?.request?.display_fields).toEqual([
      { name: 'slug', kind: 'page', value: 'projects/trace-example' },
    ]);
  });

  test('rejects conflicting cursors', async () => {
    const cursor = encodeRequestTraceCursor({
      createdAt: '2026-07-28T17:00:00.000000Z',
      id: 1,
    });
    await expect(list({
      client_id: 'target-client',
      before: cursor,
      after: cursor,
    })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
