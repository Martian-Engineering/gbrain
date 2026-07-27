import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { PageWriteContext } from '../src/core/engine.ts';
import {
  operations,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildOperationContext,
  type DispatchOpts,
} from '../src/mcp/dispatch.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
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
  resetGateway();
  await resetPgliteState(engine);
});

interface Receipt {
  actor: string;
  write_intent: string;
  batch_id: string | null;
}

async function latestReceipt(slug: string): Promise<Receipt> {
  const rows = await engine.executeRaw<Receipt>(
    `SELECT actor, write_intent, batch_id
       FROM page_mutations
      WHERE source_id = 'default' AND page_slug = $1
      ORDER BY id DESC
      LIMIT 1`,
    [slug],
  );
  return rows[0]!;
}

async function putThroughOperation(
  slug: string,
  context: Partial<OperationContext>,
  extraParams: Record<string, unknown> = {},
): Promise<void> {
  const operation = operations.find(candidate => candidate.name === 'put_page');
  if (!operation) throw new Error('put_page operation missing');

  await operation.handler({
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...context,
  } as OperationContext, {
    slug,
    content: `---\ntype: note\ntitle: ${slug}\n---\nSemantic prose.`,
    ...extraParams,
  });
}

describe('server-owned put_page write intent', () => {
  test('does not expose write attribution as caller-controlled parameters', () => {
    expect(operationsByName.put_page.params).not.toHaveProperty('actor');
    expect(operationsByName.put_page.params).not.toHaveProperty('write_intent');
    expect(operationsByName.put_page.params).not.toHaveProperty('batch_id');
  });

  test('classifies a trusted local operation as a user edit', async () => {
    await putThroughOperation('writing/local', { remote: false });

    expect(await latestReceipt('writing/local')).toEqual({
      actor: 'cli:put_page',
      write_intent: 'user_edit',
      batch_id: null,
    });
  });

  test('classifies authenticated remote input from server auth identity', async () => {
    await putThroughOperation('writing/remote-auth', {
      remote: true,
      auth: {
        token: 'fixture-auth-value',
        clientId: 'gbrain_cl_test_client',
        scopes: ['write'],
      },
    }, {
      actor: 'human:spoofed',
      write_intent: 'user_edit',
      batch_id: 'spoofed-batch',
    });

    expect(await latestReceipt('writing/remote-auth')).toEqual({
      actor: 'mcp:gbrain_cl_test_client',
      write_intent: 'live_ingest',
      batch_id: null,
    });
  });

  test('attributes a principal-bound remote write to the principal', async () => {
    await putThroughOperation('writing/remote-principal', {
      remote: true,
      auth: {
        token: 'fixture-auth-value',
        clientId: 'gbrain_cl_test_client',
        scopes: ['write'],
        boundPrincipal: 'people/alice-example',
      },
    });

    expect(await latestReceipt('writing/remote-principal')).toEqual({
      actor: 'principal:people/alice-example',
      write_intent: 'live_ingest',
      batch_id: null,
    });
  });

  test('classifies unauthenticated remote transport as stdio ingestion', async () => {
    await putThroughOperation('writing/remote-stdio', { remote: true });

    expect(await latestReceipt('writing/remote-stdio')).toEqual({
      actor: 'mcp:stdio',
      write_intent: 'live_ingest',
      batch_id: null,
    });
  });

  test('classifies subagent writes from trusted runtime ids', async () => {
    await putThroughOperation('wiki/agents/42/derived', {
      remote: true,
      viaSubagent: true,
      subagentId: 42,
      jobId: 99,
    });

    expect(await latestReceipt('wiki/agents/42/derived')).toEqual({
      actor: 'subagent:42',
      write_intent: 'derived',
      batch_id: 'job:99',
    });
  });

  test('honors an explicit server context before runtime inference', async () => {
    const writeContext: PageWriteContext = {
      actor: 'cli:capture',
      writeIntent: 'user_edit',
      batchId: 'capture-batch',
    };
    await putThroughOperation('wiki/agents/42/capture', {
      writeContext,
      remote: true,
      viaSubagent: true,
      subagentId: 42,
      jobId: 99,
    } as Partial<OperationContext>);

    expect(await latestReceipt('wiki/agents/42/capture')).toEqual({
      actor: 'cli:capture',
      write_intent: 'user_edit',
      batch_id: 'capture-batch',
    });
  });

  test('buildOperationContext only accepts trusted context from dispatch options', () => {
    const writeContext: PageWriteContext = {
      actor: 'test:server',
      writeIntent: 'maintenance',
    };
    const ctx = buildOperationContext(engine, {
      writeContext: {
        actor: 'input:spoofed',
        writeIntent: 'user_edit',
      },
    }, {
      remote: true,
      writeContext,
    } as DispatchOpts);

    expect((ctx as OperationContext & {
      writeContext?: PageWriteContext;
    }).writeContext).toEqual(writeContext);
  });

  test('publishes a source-authorized admin operation for historical writes', () => {
    expect(operationsByName.put_historical_page).toMatchObject({
      scope: 'admin',
      mutating: true,
      localOnly: false,
    });
    expect(operationsByName.put_historical_page.params).toEqual(expect.objectContaining({
      source_id: expect.objectContaining({ required: true }),
      batch_id: expect.objectContaining({ required: true }),
      slug: expect.objectContaining({ required: true }),
      content: expect.objectContaining({ required: true }),
    }));
    expect(operationsByName.put_historical_page.params).not.toHaveProperty('actor');
    expect(operationsByName.put_historical_page.params).not.toHaveProperty('write_intent');
  });

  test('historical admin writes use authenticated identity and defer take mining', async () => {
    const result = await operationsByName.put_historical_page.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'stale-context-source',
      auth: {
        token: 'fixture-auth-value',
        clientId: 'historical-loader',
        scopes: ['admin'],
        sourceId: 'default',
      },
    } as OperationContext, {
      source_id: 'default',
      batch_id: 'archive-2026-07',
      slug: 'history/admin-import',
      content: '---\ntype: note\ntitle: Admin import\n---\nHistorical semantic prose.',
      actor: 'human:spoofed',
      write_intent: 'user_edit',
    });

    expect(result).toMatchObject({ slug: 'history/admin-import' });
    expect(await latestReceipt('history/admin-import')).toEqual({
      actor: 'mcp:historical-loader',
      write_intent: 'backfill',
      batch_id: 'archive-2026-07',
    });
    expect(await engine.executeRaw<{ admission: string; batch_id: string }>(
      `SELECT admission, batch_id
         FROM take_mining_work
        WHERE source_id = 'default' AND page_slug = 'history/admin-import'`,
    )).toEqual([{
      admission: 'deferred',
      batch_id: 'archive-2026-07',
    }]);
  });

  test('historical admin writes reject a source outside the authenticated write grant', async () => {
    const promise = operationsByName.put_historical_page.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'neighbor',
      auth: {
        token: 'fixture-auth-value',
        clientId: 'historical-loader',
        scopes: ['admin'],
        sourceId: 'default',
      },
    } as OperationContext, {
      source_id: 'neighbor',
      batch_id: 'archive-2026-07',
      slug: 'history/forbidden',
      content: '---\ntype: note\n---\nForbidden.',
    });

    await expect(promise).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('revert_version stamps the server-owned human action context', async () => {
    const slug = 'writing/reverted';
    const setupContext: PageWriteContext = {
      actor: 'test:setup',
      writeIntent: 'maintenance',
    };
    await engine.putPage(slug, {
      type: 'note',
      title: 'Reverted',
      compiled_truth: 'Original semantic prose.',
    }, { writeContext: setupContext });
    await engine.createVersion(slug);
    await engine.putPage(slug, {
      type: 'note',
      title: 'Reverted',
      compiled_truth: 'Replacement semantic prose.',
    }, { writeContext: setupContext });
    const version = (await engine.getVersions(slug))[0];
    if (!version) throw new Error('expected setup page version');

    const operation = operations.find(candidate => candidate.name === 'revert_version');
    if (!operation) throw new Error('revert_version operation missing');
    await operation.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    }, {
      slug,
      version_id: version.id,
    });

    expect(await latestReceipt(slug)).toEqual({
      actor: 'operation:revert_page',
      write_intent: 'user_edit',
      batch_id: null,
    });
  });
});
