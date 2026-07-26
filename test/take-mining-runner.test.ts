import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { estimateMaxCostUsd } from '../src/core/anthropic-pricing.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  TakeMiningRunnerError,
  runTakeMiningWork,
  type ProposeTakesExtractor,
  type TakeMiningRunnerOptions,
} from '../src/core/cycle/propose-takes.ts';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const MODEL_ID = 'anthropic:claude-haiku-4-5';
const NOTE_TYPES = ['note'] as const;
const ESTIMATED_PAGE_SPEND = estimateMaxCostUsd(MODEL_ID, 1_500, 500) ?? 0;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  configureGateway({
    chat_model: MODEL_ID,
    env: { ANTHROPIC_API_KEY: 'test-key' },
  });
});

function ctx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function queueWork(
  slug: string,
  body: string,
  admission: 'immediate' | 'deferred',
  batchId?: string,
): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: body,
  }, {
    writeContext: {
      actor: 'test',
      writeIntent: admission === 'immediate' ? 'user_edit' : 'maintenance',
      batchId,
    },
  });
  await engine.executeRaw(
    `UPDATE take_mining_work
        SET admission = $2, batch_id = $3
      WHERE source_id = 'default' AND page_slug = $1`,
    [slug, admission, batchId ?? null],
  );
}

function deferredOpts(
  batchId: string,
  extractor: ProposeTakesExtractor,
  overrides: Partial<DeferredRunnerOptions> = {},
): DeferredRunnerOptions {
  return {
    admission: 'deferred' as const,
    sourceId: 'default',
    batchId,
    promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
    pageCap: 10,
    proposalCap: 50,
    maxEstimatedSpendUsd: 1,
    model: MODEL_ID,
    extractor,
    _extractableTypes: NOTE_TYPES,
    ...overrides,
  };
}

type DeferredRunnerOptions = Extract<
  TakeMiningRunnerOptions,
  { admission: 'deferred' }
>;

async function tableCount(table: 'take_mining_work' | 'take_proposal_scans' | 'take_proposals') {
  const [row] = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table}`,
  );
  return row?.count ?? 0;
}

describe('shared take-mining runner', () => {
  test('processes only the exact deferred source/batch without promotion', async () => {
    await queueWork('notes/batch-a', 'Batch A prose.', 'deferred', 'batch-a');
    await queueWork('notes/batch-b', 'Batch B prose.', 'deferred', 'batch-b');
    await queueWork('notes/immediate', 'Immediate prose.', 'immediate');
    const paths: string[] = [];

    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async input => {
        paths.push(input.pagePath);
        return [];
      },
    ));

    expect(paths).toEqual(['notes/batch-a']);
    expect(result).toMatchObject({
      admission: 'deferred',
      batch_id: 'batch-a',
      pages_scanned: 1,
      remaining_work: 0,
      stopped: false,
    });
    const remaining = await engine.executeRaw<{
      page_slug: string;
      admission: string;
      batch_id: string | null;
    }>(
      `SELECT page_slug, admission, batch_id
         FROM take_mining_work
        ORDER BY page_slug`,
    );
    expect(remaining).toEqual([
      { page_slug: 'notes/batch-b', admission: 'deferred', batch_id: 'batch-b' },
      { page_slug: 'notes/immediate', admission: 'immediate', batch_id: null },
    ]);
  });

  test('rejects prompt drift and missing deferred caps before claims or spend', async () => {
    await queueWork('notes/pinned', 'Pinned prose.', 'deferred', 'batch-a');
    const extractor: ProposeTakesExtractor = async () => [];

    await expect(runTakeMiningWork(ctx(), deferredOpts('batch-a', extractor, {
      promptVersion: 'old-prompt',
    }))).rejects.toMatchObject({
      code: 'prompt_version_mismatch',
    });
    await expect(runTakeMiningWork(ctx(), {
      admission: 'deferred',
      sourceId: 'default',
      batchId: 'batch-a',
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 1,
      extractor,
      _extractableTypes: NOTE_TYPES,
    } as never)).rejects.toBeInstanceOf(TakeMiningRunnerError);
    await expect(runTakeMiningWork(ctx(), deferredOpts('batch-a', extractor, {
      pageCap: 101,
    }))).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(runTakeMiningWork(ctx(), deferredOpts('batch-a', extractor, {
      proposalCap: 501,
    }))).rejects.toMatchObject({ code: 'invalid_options' });

    expect(await tableCount('take_proposal_scans')).toBe(0);
    const reservations = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM budget_reservations`,
    );
    expect(reservations).toEqual([{ count: 0 }]);
  });

  test('stops cleanly at per-run page, proposal, and estimated-spend caps', async () => {
    await queueWork('notes/page-a', 'Page A prose.', 'deferred', 'page-cap');
    await queueWork('notes/page-b', 'Page B prose.', 'deferred', 'page-cap');
    const pageResult = await runTakeMiningWork(ctx(), deferredOpts(
      'page-cap',
      async () => [],
      { pageCap: 1 },
    ));
    expect(pageResult).toMatchObject({
      pages_scanned: 1,
      stopped: true,
      stop_reason: 'page_cap',
      remaining_work: 1,
    });

    await resetPgliteState(engine);
    await queueWork('notes/proposal-a', 'Proposal A.', 'deferred', 'proposal-cap');
    await queueWork('notes/proposal-b', 'Proposal B.', 'deferred', 'proposal-cap');
    const proposalResult = await runTakeMiningWork(ctx(), deferredOpts(
      'proposal-cap',
      async input => [{
        claim_text: `Claim from ${input.pagePath}`,
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }],
      { proposalCap: 1 },
    ));
    expect(proposalResult).toMatchObject({
      pages_scanned: 1,
      proposals_inserted: 1,
      stopped: true,
      stop_reason: 'proposal_cap',
      remaining_work: 1,
    });

    await resetPgliteState(engine);
    await queueWork('notes/spend-a', 'Spend A.', 'deferred', 'spend-cap');
    await queueWork('notes/spend-b', 'Spend B.', 'deferred', 'spend-cap');
    const spendResult = await runTakeMiningWork(ctx(), deferredOpts(
      'spend-cap',
      async () => [],
      { maxEstimatedSpendUsd: ESTIMATED_PAGE_SPEND * 1.5 },
    ));
    expect(spendResult).toMatchObject({
      pages_scanned: 1,
      stopped: true,
      stop_reason: 'estimated_spend_cap',
      remaining_work: 1,
    });
    expect(spendResult.estimated_spend_usd).toBeCloseTo(ESTIMATED_PAGE_SPEND);
  });

  test('applies brain-wide daily page, proposal, and spend guards', async () => {
    await engine.setConfig('take_mining.daily_page_cap', '1');
    await queueWork('notes/daily-a', 'Daily A.', 'deferred', 'daily');
    await queueWork('notes/daily-b', 'Daily B.', 'deferred', 'daily');
    const pageResult = await runTakeMiningWork(
      ctx(),
      deferredOpts('daily', async () => []),
    );
    expect(pageResult).toMatchObject({
      pages_scanned: 1,
      stopped: true,
      stop_reason: 'daily_page_cap',
      remaining_work: 1,
    });

    await resetPgliteState(engine);
    await engine.setConfig('take_mining.daily_proposal_cap', '0');
    await queueWork('notes/proposal-stop', 'Proposal stop.', 'deferred', 'daily');
    const proposalResult = await runTakeMiningWork(
      ctx(),
      deferredOpts('daily', async () => []),
    );
    expect(proposalResult).toMatchObject({
      pages_scanned: 0,
      stopped: true,
      stop_reason: 'daily_proposal_cap',
      remaining_work: 1,
    });

    await resetPgliteState(engine);
    await engine.setConfig('take_mining.daily_proposal_cap', '1');
    await queueWork('notes/overshoot-a', 'Overshoot A.', 'deferred', 'daily');
    await queueWork('notes/overshoot-b', 'Overshoot B.', 'deferred', 'daily');
    const overshootResult = await runTakeMiningWork(
      ctx(),
      deferredOpts('daily', async input => [1, 2].map(index => ({
        claim_text: `Claim ${index} from ${input.pagePath}`,
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }))),
    );
    expect(overshootResult).toMatchObject({
      pages_scanned: 1,
      proposals_inserted: 2,
      stopped: true,
      stop_reason: 'daily_proposal_cap',
      remaining_work: 1,
    });

    await resetPgliteState(engine);
    await engine.setConfig(
      'take_mining.daily_estimated_spend_usd',
      String(ESTIMATED_PAGE_SPEND / 2),
    );
    await queueWork('notes/spend-stop', 'Spend stop.', 'deferred', 'daily');
    const spendResult = await runTakeMiningWork(
      ctx(),
      deferredOpts('daily', async () => []),
    );
    expect(spendResult).toMatchObject({
      pages_scanned: 0,
      stopped: true,
      stop_reason: 'daily_estimated_spend_cap',
      remaining_work: 1,
    });
  });

  test('fails closed on unknown pricing without claiming or calling the model', async () => {
    await queueWork('notes/unpriced', 'Unpriced prose.', 'deferred', 'batch-a');
    let calls = 0;
    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async () => {
        calls++;
        return [];
      },
      { model: 'openrouter:anthropic/claude-sonnet-4-6' },
    ));

    expect(result).toMatchObject({
      pages_scanned: 0,
      stopped: true,
      stop_reason: 'unknown_model_pricing',
      remaining_work: 1,
    });
    expect(calls).toBe(0);
    expect(await tableCount('take_proposal_scans')).toBe(0);
  });

  test('commits attempted spend but releases owned claim on extractor failure', async () => {
    await queueWork('notes/failure', 'Failure prose.', 'deferred', 'batch-a');
    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async () => {
        throw new Error('provider failed after submit');
      },
    ));

    expect(result.pages_scanned).toBe(1);
    expect(result.estimated_spend_usd).toBeCloseTo(ESTIMATED_PAGE_SPEND);
    expect(result.warnings).toContain(
      'extractor failed on notes/failure: provider failed after submit',
    );
    expect(result.remaining_work).toBe(1);
    expect(await tableCount('take_proposal_scans')).toBe(0);
    const reservations = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM budget_reservations`,
    );
    expect(reservations).toEqual([{ status: 'committed' }]);
  });

  test('releases its owned claim when an in-flight extraction is aborted', async () => {
    await queueWork('notes/abort', 'Abort prose.', 'deferred', 'abort');
    const controller = new AbortController();
    let extractionStarted!: () => void;
    const started = new Promise<void>(resolve => {
      extractionStarted = resolve;
    });
    const run = runTakeMiningWork(ctx(), deferredOpts(
      'abort',
      async () => {
        extractionStarted();
        return new Promise<never>(() => {});
      },
      { signal: controller.signal },
    ));

    await started;
    controller.abort(new Error('worker timed out'));
    await expect(run).rejects.toThrow('worker timed out');

    expect(await tableCount('take_proposal_scans')).toBe(0);
    expect(await tableCount('take_mining_work')).toBe(1);
    const committed = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM budget_reservations
        WHERE status = 'committed'`,
    );
    expect(committed).toEqual([{ count: 1 }]);
  });

  test('dry-run reports exact deferred eligibility without writes', async () => {
    await queueWork('notes/dry', 'Dry prose.', 'deferred', 'batch-a');
    const beforeHash = buildTakeMiningInput('Dry prose.').mining_input_hash;
    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async () => {
        throw new Error('must not call');
      },
      { dryRun: true },
    ));

    expect(result).toMatchObject({
      dry_run: true,
      eligible_pages: 1,
      pages_scanned: 0,
      remaining_work: 1,
    });
    expect(await tableCount('take_proposal_scans')).toBe(0);
    expect(await engine.executeRaw<{ mining_input_hash: string }>(
      `SELECT mining_input_hash FROM take_mining_work`,
    )).toEqual([{ mining_input_hash: beforeHash }]);
  });

  test('retires successful work only inside the exact deferred batch', async () => {
    await queueWork('notes/cached-a', 'Cached A prose.', 'deferred', 'batch-a');
    await queueWork('notes/cached-b', 'Cached B prose.', 'deferred', 'batch-b');
    const rows = await engine.executeRaw<{
      page_slug: string;
      mining_input_hash: string;
    }>(
      `SELECT page_slug, mining_input_hash
         FROM take_mining_work
        ORDER BY page_slug`,
    );
    for (const row of rows) {
      await engine.executeRaw(
        `INSERT INTO take_proposal_scans (
           source_id, page_slug, mining_input_hash, prompt_version,
           status, attempt_id, proposal_run_id, model_id,
           proposal_count, completed_at
         ) VALUES (
           'default', $1, $2, $3,
           'succeeded', $4, 'cached-run', $5,
           0, now()
         )`,
        [
          row.page_slug,
          row.mining_input_hash,
          PROPOSE_TAKES_PROMPT_VERSION,
          `cached-${row.page_slug}`,
          MODEL_ID,
        ],
      );
    }

    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async () => {
        throw new Error('must not call');
      },
    ));

    expect(result).toMatchObject({
      eligible_pages: 0,
      pages_scanned: 0,
      cache_hits: 1,
      remaining_work: 0,
    });
    expect(await engine.executeRaw<{ page_slug: string; batch_id: string }>(
      `SELECT page_slug, batch_id
         FROM take_mining_work`,
    )).toEqual([{ page_slug: 'notes/cached-b', batch_id: 'batch-b' }]);
  });

  test('preserves a newer queued hash when only the previous hash succeeded', async () => {
    const slug = 'notes/newer-hash';
    const originalBody = 'Original semantic prose.';
    await queueWork(slug, originalBody, 'deferred', 'batch-a');
    const originalHash = buildTakeMiningInput(originalBody).mining_input_hash;
    await engine.executeRaw(
      `INSERT INTO take_proposal_scans (
         source_id, page_slug, mining_input_hash, prompt_version,
         status, attempt_id, proposal_run_id, model_id,
         proposal_count, completed_at
       ) VALUES (
         'default', $1, $2, $3,
         'succeeded', 'old-attempt', 'old-run', $4,
         0, now()
       )`,
      [slug, originalHash, PROPOSE_TAKES_PROMPT_VERSION, MODEL_ID],
    );

    const newerBody = 'Newer semantic prose.';
    await queueWork(slug, newerBody, 'deferred', 'batch-a');
    const newerHash = buildTakeMiningInput(newerBody).mining_input_hash;
    const result = await runTakeMiningWork(ctx(), deferredOpts(
      'batch-a',
      async () => {
        throw new Error('must not call');
      },
      { _extractableTypes: [] },
    ));

    expect(result.cache_hits).toBe(0);
    expect(result.remaining_work).toBe(1);
    expect(await engine.executeRaw<{ mining_input_hash: string }>(
      `SELECT mining_input_hash
         FROM take_mining_work
        WHERE source_id = 'default' AND page_slug = $1`,
      [slug],
    )).toEqual([{ mining_input_hash: newerHash }]);
  });
});
