import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
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

function ctx(
  sourceId = 'default',
  opts: {
    allowedSources?: string[];
    takesHoldersAllowList?: string[];
  } = {},
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    auth: opts.allowedSources
      ? {
          token: 'test-token',
          clientId: 'test-client',
          scopes: ['read'],
          sourceId,
          allowedSources: opts.allowedSources,
        }
      : undefined,
  };
}

async function seedSource(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name)
     VALUES ($1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
}

async function seedProposal(opts: {
  sourceId?: string;
  pageSlug: string;
  claimText: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'superseded';
  holder?: string;
  runId?: string;
  proposedAt: string;
}): Promise<number> {
  const sourceId = opts.sourceId ?? 'default';
  const claimHash = createHash('sha256')
    .update(opts.claimText.trim())
    .digest('hex');
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, proposal_run_id,
       status, claim_text, claim_hash, kind, holder, weight, domain,
       dedup_against_fence_rows, model_id, proposed_at
     ) VALUES (
       $1, $2, $3, 'prompt-v1', $4, $5, $6, $7, 'take', $8, 0.6,
       'strategy', '[]'::jsonb, 'test-model', $9::timestamptz
     )
     RETURNING id`,
    [
      sourceId,
      opts.pageSlug,
      `content-${opts.pageSlug}-${opts.claimText}`,
      opts.runId ?? 'run-default',
      opts.status ?? 'pending',
      opts.claimText,
      claimHash,
      opts.holder ?? 'world',
      opts.proposedAt,
    ],
  );
  return rows[0]!.id;
}

type ProposalListResult = {
  proposals: Array<{
    id: number;
    source_id: string;
    page_slug: string;
    claim_text: string;
    holder: string;
    status: string;
    resolution_note: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
};

async function list(
  operationCtx: OperationContext,
  params: Record<string, unknown> = {},
): Promise<ProposalListResult> {
  return operationsByName.list_take_proposals.handler(
    operationCtx,
    params,
  ) as Promise<ProposalListResult>;
}

describe('take proposal operation registration', () => {
  test('list_take_proposals is a remote-capable non-mutating read operation', () => {
    const op = operationsByName.list_take_proposals;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.mutating).not.toBe(true);
    expect(op.localOnly).not.toBe(true);
  });
});

describe('list_take_proposals', () => {
  test('defaults to pending rows ordered newest-first with a full filtered total', async () => {
    const oldestId = await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Old pending',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    const tiedOlderId = await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'New pending A',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    const newestId = await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'New pending B',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/gamma',
      claimText: 'Already accepted',
      status: 'accepted',
      proposedAt: '2026-07-23T10:00:00Z',
    });

    const result = await list(ctx(), { limit: 2 });

    expect(result).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(result.proposals.map(row => row.id)).toEqual([
      newestId,
      tiedOlderId,
    ]);
    expect(result.proposals[0]).toMatchObject({
      source_id: 'default',
      page_slug: 'writing/beta',
      status: 'pending',
      resolution_note: null,
    });
    expect(result.proposals[0]!.id).not.toBe(oldestId);
  });

  test('applies status, page, run, limit, and offset filters without truncating total', async () => {
    await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Alpha accepted old',
      status: 'accepted',
      runId: 'run-a',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    const newestId = await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Alpha accepted new',
      status: 'accepted',
      runId: 'run-a',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'Beta accepted',
      status: 'accepted',
      runId: 'run-b',
      proposedAt: '2026-07-23T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'Beta pending',
      runId: 'run-b',
      proposedAt: '2026-07-24T10:00:00Z',
    });

    const result = await list(ctx(), {
      status: 'accepted',
      page_slug: 'writing/alpha',
      proposal_run_id: 'run-a',
      limit: 1,
      offset: 0,
    });

    expect(result).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(result.proposals.map(row => row.id)).toEqual([newestId]);
    const allStatuses = await list(ctx(), { status: 'all' });
    expect(allStatuses.total).toBe(4);
  });

  test('clamps limit to 1..200 and offset to zero or greater', async () => {
    const low = await list(ctx(), { limit: 0, offset: -8 });
    expect(low).toMatchObject({ limit: 1, offset: 0 });

    const high = await list(ctx(), { limit: 500, offset: 3 });
    expect(high).toMatchObject({ limit: 200, offset: 3 });
  });

  test('isolates scalar source reads and gives federated grants precedence', async () => {
    await seedSource('source-a');
    await seedSource('source-b');
    await seedProposal({
      sourceId: 'source-a',
      pageSlug: 'writing/shared',
      claimText: 'Source A claim',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    await seedProposal({
      sourceId: 'source-b',
      pageSlug: 'writing/shared',
      claimText: 'Source B claim',
      proposedAt: '2026-07-21T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/shared',
      claimText: 'Default claim',
      proposedAt: '2026-07-22T10:00:00Z',
    });

    const scalar = await list(ctx('source-a'));
    expect(scalar.proposals.map(row => row.source_id)).toEqual(['source-a']);
    expect(scalar.total).toBe(1);

    const federated = await list(ctx('default', {
      allowedSources: ['source-a', 'source-b'],
    }));
    expect(federated.proposals.map(row => row.source_id).sort()).toEqual([
      'source-a',
      'source-b',
    ]);
    expect(federated.total).toBe(2);
  });

  test('applies the takes holder allow-list to rows and total', async () => {
    await seedProposal({
      pageSlug: 'writing/public',
      claimText: 'World claim',
      holder: 'world',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/private',
      claimText: 'Brain claim',
      holder: 'brain',
      proposedAt: '2026-07-21T10:00:00Z',
    });

    const result = await list(ctx('default', {
      takesHoldersAllowList: ['world'],
    }));

    expect(result.total).toBe(1);
    expect(result.proposals.map(row => row.holder)).toEqual(['world']);
  });
});
