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
