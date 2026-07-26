import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  enqueueTakeMiningWork,
  getTakeMiningStatus,
  previewTakeMiningEnrollment,
  type TakeMiningControlDependencies,
} from '../src/core/take-mining-control.ts';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';
import { renderTakeMiningRequest } from '../src/core/cycle/take-mining-request.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const dependencies: TakeMiningControlDependencies = {
  extractableTypes: new Set(['note']),
  promptVersion: 'prompt-v2',
  discoveryBatchSize: 2,
  maxDiscoveryRows: 20,
};

describe('take-mining enrollment control', () => {
  let engine: PGLiteEngine;
  let ctx: OperationContext;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ctx = {
      engine,
      config: {} as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('previews eligible canonical inputs without writing queue state', async () => {
    await insertPage(engine, 'notes/alpha', 'Alpha [[target|label]]', '2024-01-02');
    await insertPage(engine, 'notes/beta', 'Beta body', '2024-02-02');
    await insertPage(engine, 'notes/code', 'Code body', '2024-02-02', {
      type: 'code',
    });
    await insertPage(engine, 'notes/generated', 'Generated body', '2024-02-02', {
      frontmatter: { dream_generated: true },
    });
    await insertPage(engine, 'notes/empty', '   ', '2024-02-02');
    await insertPage(engine, 'other/outside', 'Outside prefix', '2024-02-02');
    const betaHash = buildTakeMiningInput('Beta body').mining_input_hash;
    await insertSuccessfulScan(engine, 'notes/beta', betaHash);

    const preview = await previewTakeMiningEnrollment(ctx, {
      sourceId: 'default',
      batchId: 'history-2024',
      reason: 'historical_backfill',
      pageCap: 10,
      slugPrefix: 'notes/',
      effectiveFrom: '2024-01-01',
      effectiveTo: '2024-12-31',
    }, dependencies);

    expect(preview.dryRun).toBe(true);
    expect(preview.items).toEqual([{
      slug: 'notes/alpha',
      type: 'note',
      effectiveDate: '2024-01-02T00:00:00.000Z',
      effectiveDateSource: 'test',
      miningInputHash: buildTakeMiningInput('Alpha label').mining_input_hash,
    }]);
    expect(preview.alreadyScannedPages).toBe(1);
    expect(preview.eligiblePages).toBe(1);
    expect(preview.estimatedInputTokens).toBe(
      renderTakeMiningRequest({
        pagePath: 'notes/alpha',
        pageBody: 'Alpha label',
        existingTakes: [],
      }).estimatedInputTokens,
    );
    expect(preview.nextAfterSlug).toBeNull();
    const queue = await engine.executeRaw<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM take_mining_work',
    );
    expect(queue).toEqual([{ count: 0 }]);
  });

  test('enqueues deferred null-intent work and repeats idempotently', async () => {
    await insertPage(engine, 'notes/alpha', 'Alpha body', '2023-01-02');
    await insertPage(engine, 'notes/beta', 'Beta body', '2023-01-03');
    const input = {
      sourceId: 'default',
      batchId: 'history-2023',
      reason: 'operator_remine' as const,
      pageCap: 10,
    };

    const first = await enqueueTakeMiningWork(ctx, input, dependencies);
    const second = await enqueueTakeMiningWork(ctx, input, dependencies);

    expect(first.enqueuedPages).toBe(2);
    expect(second.enqueuedPages).toBe(0);
    expect(second.alreadyEnrolledPages).toBe(2);
    const rows = await engine.executeRaw<{
      page_slug: string;
      admission: string;
      write_intent: string | null;
      actor: string;
      batch_id: string;
      reason: string;
    }>(
      `SELECT page_slug, admission, write_intent, actor, batch_id, reason
         FROM take_mining_work
        ORDER BY page_slug`,
    );
    expect(rows).toEqual([
      {
        page_slug: 'notes/alpha',
        admission: 'deferred',
        write_intent: null,
        actor: 'cli:take-mining',
        batch_id: 'history-2023',
        reason: 'operator_remine',
      },
      {
        page_slug: 'notes/beta',
        admission: 'deferred',
        write_intent: null,
        actor: 'cli:take-mining',
        batch_id: 'history-2023',
        reason: 'operator_remine',
      },
    ]);
  });

  test('preserves immediate and other-batch work while refreshing its own enrollment', async () => {
    await insertPage(engine, 'notes/immediate', 'Immediate body', '2023-01-02');
    await insertPage(engine, 'notes/other', 'Other body', '2023-01-03');
    await insertPage(engine, 'notes/refresh', 'Refresh body', '2023-01-04');
    await insertPage(engine, 'notes/write-triggered', 'Write body', '2023-01-05');
    await insertWork(engine, 'notes/immediate', 'old-immediate', 'immediate', 'live', 'user_edit');
    await insertWork(engine, 'notes/other', 'old-other', 'deferred', 'other-batch', null);
    await insertWork(engine, 'notes/refresh', 'old-refresh', 'deferred', 'history-2023', null);
    const mutationId = await insertMutation(engine, 'notes/write-triggered');
    await insertWork(
      engine,
      'notes/write-triggered',
      'old-write',
      'deferred',
      'history-2023',
      'user_edit',
      mutationId,
    );

    const result = await enqueueTakeMiningWork(ctx, {
      sourceId: 'default',
      batchId: 'history-2023',
      reason: 'prompt_upgrade',
      pageCap: 10,
    }, dependencies);

    expect(result.existingImmediatePages).toBe(1);
    expect(result.existingOtherBatchPages).toBe(1);
    expect(result.existingWriteTriggeredPages).toBe(1);
    expect(result.enqueuedPages).toBe(1);
    const rows = await engine.executeRaw<{ page_slug: string; mining_input_hash: string }>(
      `SELECT page_slug, mining_input_hash
         FROM take_mining_work
        ORDER BY page_slug`,
    );
    expect(rows).toEqual([
      { page_slug: 'notes/immediate', mining_input_hash: 'old-immediate' },
      { page_slug: 'notes/other', mining_input_hash: 'old-other' },
      {
        page_slug: 'notes/refresh',
        mining_input_hash: buildTakeMiningInput('Refresh body').mining_input_hash,
      },
      { page_slug: 'notes/write-triggered', mining_input_hash: 'old-write' },
    ]);
  });

  test('bounds discovery and resumes after the returned slug cursor', async () => {
    await insertPage(engine, 'notes/a', 'A body', '2022-01-01');
    await insertPage(engine, 'notes/b', 'B body', '2022-01-02');
    await insertPage(engine, 'notes/c', 'C body', '2022-01-03');

    const first = await previewTakeMiningEnrollment(ctx, {
      sourceId: 'default',
      batchId: 'bounded',
      reason: 'historical_backfill',
      pageCap: 2,
    }, dependencies);
    const second = await previewTakeMiningEnrollment(ctx, {
      sourceId: 'default',
      batchId: 'bounded',
      reason: 'historical_backfill',
      pageCap: 2,
      afterSlug: first.nextAfterSlug ?? undefined,
    }, dependencies);

    expect(first.items.map(item => item.slug)).toEqual(['notes/a', 'notes/b']);
    expect(first.truncated).toBe(true);
    expect(first.nextAfterSlug).toBe('notes/b');
    expect(second.items.map(item => item.slug)).toEqual(['notes/c']);
    expect(second.truncated).toBe(false);
    expect(second.nextAfterSlug).toBeNull();
  });

  test('reports queue and batch state without mutating it', async () => {
    await insertPage(engine, 'notes/immediate', 'Immediate', '2023-01-01');
    await insertPage(engine, 'notes/deferred', 'Deferred', '2023-01-02');
    await insertWork(engine, 'notes/immediate', 'hash-i', 'immediate', 'live', 'user_edit');
    await insertWork(engine, 'notes/deferred', 'hash-d', 'deferred', 'history', null);
    const timeZone = 'America/Los_Angeles';
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await engine.setConfig('budget.tz', timeZone);
    await engine.executeRaw(
      `INSERT INTO take_proposals (
         source_id, page_slug, content_hash, prompt_version, proposal_run_id,
         claim_text, claim_hash, kind, holder, weight, model_id, proposed_at
       ) VALUES
         (
           'default', 'notes/today', 'today-hash', 'prompt-v1', 'today-run',
           'today', 'today-claim', 'take', 'brain', 0.5, 'test-model',
           (($1::date + interval '30 minutes') AT TIME ZONE $2)
         ),
         (
           'default', 'notes/yesterday', 'yesterday-hash', 'prompt-v1', 'yesterday-run',
           'yesterday', 'yesterday-claim', 'take', 'brain', 0.5, 'test-model',
           (($1::date - interval '1 day' + interval '23 hours 30 minutes') AT TIME ZONE $2)
         )`,
      [localDate, timeZone],
    );

    const status = await getTakeMiningStatus(ctx, {
      sourceId: 'default',
      batchId: 'history',
    });

    expect(status.queue).toEqual({ total: 2, immediate: 1, deferred: 1 });
    expect(status.promptVersion.length).toBeGreaterThan(0);
    expect(status.batch?.queuedPages).toBe(1);
    expect(status.daily.configuredPageCap).toBe(100);
    expect(status.daily.configuredProposalCap).toBe(200);
    expect(status.daily.budgetCapUsd).toBe(5);
    expect(status.daily.proposals).toBe(1);
    const rows = await engine.executeRaw<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM take_mining_work',
    );
    expect(rows).toEqual([{ count: 2 }]);
  });
});

async function insertPage(
  engine: PGLiteEngine,
  slug: string,
  compiledTruth: string,
  effectiveDate: string,
  overrides: {
    type?: string;
    frontmatter?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (
       source_id, slug, type, title, compiled_truth, frontmatter,
       effective_date, effective_date_source
     ) VALUES ($1, $2, $3, $2, $4, $5::jsonb, $6::timestamptz, 'test')`,
    [
      'default',
      slug,
      overrides.type ?? 'note',
      compiledTruth,
      JSON.stringify(overrides.frontmatter ?? {}),
      effectiveDate,
    ],
  );
}

async function insertSuccessfulScan(
  engine: PGLiteEngine,
  slug: string,
  hash: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO take_proposal_scans (
       source_id, page_slug, mining_input_hash, prompt_version,
       status, attempt_id, proposal_run_id, model_id,
       proposal_count, completed_at
     ) VALUES (
       'default', $1, $2, 'prompt-v2',
       'succeeded', 'attempt-test', 'run-test', 'model-test',
       0, now()
     )`,
    [slug, hash],
  );
}

async function insertWork(
  engine: PGLiteEngine,
  slug: string,
  hash: string,
  admission: 'immediate' | 'deferred',
  batchId: string,
  writeIntent: 'user_edit' | null,
  pageMutationId: number | null = null,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO take_mining_work (
       source_id, page_slug, mining_input_hash, admission,
       write_intent, actor, batch_id, reason, page_mutation_id
     ) VALUES (
       'default', $1, $2, $3, $4, 'test:fixture', $5, 'test', $6
     )`,
    [slug, hash, admission, writeIntent, batchId, pageMutationId],
  );
}

async function insertMutation(
  engine: PGLiteEngine,
  slug: string,
): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO page_mutations (
       source_id, page_slug, actor, write_intent,
       new_mining_input_hash, semantic_changed
     ) VALUES (
       'default', $1, 'test:fixture', 'user_edit',
       'mutation-hash', true
     )
     RETURNING id`,
    [slug],
  );
  return row!.id;
}
