import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { BudgetMeter } from '../src/core/cycle/budget-meter.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  __testing,
  runTakeMiningWork,
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getTakeMiningStatus } from '../src/core/take-mining-control.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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

afterEach(() => {
  __setChatTransportForTests(null);
});

beforeEach(async () => {
  await resetPgliteState(engine);
  configureGateway({
    chat_model: 'anthropic:claude-haiku-4-5',
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

interface QueuePageOpts {
  type?: string;
  frontmatter?: Record<string, unknown>;
  admission?: 'immediate' | 'deferred';
  priority?: number;
}

async function queuePage(
  slug: string,
  body: string,
  opts: QueuePageOpts = {},
): Promise<string> {
  const admission = opts.admission ?? 'immediate';
  await engine.putPage(slug, {
    type: opts.type ?? 'note',
    title: slug,
    compiled_truth: body,
    frontmatter: opts.frontmatter ?? {},
  }, {
    writeContext: {
      actor: 'test',
      writeIntent: admission === 'immediate' ? 'user_edit' : 'maintenance',
    },
  });
  const hash = buildTakeMiningInput(body).mining_input_hash;
  await engine.executeRaw(
    `UPDATE take_mining_work
        SET priority = $2
      WHERE source_id = 'default' AND page_slug = $1`,
    [slug, opts.priority ?? 0],
  );
  return hash;
}

async function count(table: string): Promise<number> {
  const safeTables = new Set([
    'take_mining_work',
    'take_proposal_scans',
    'take_proposals',
  ]);
  if (!safeTables.has(table)) throw new Error(`unsupported table: ${table}`);
  const rows = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table}`,
  );
  return rows[0]?.count ?? 0;
}

const noProposals: ProposeTakesExtractor = async () => [];
const NOTE_TYPES = ['note'] as const;

describe('propose_takes explicit work queue', () => {
  test('paginates past stale work without letting it consume the page limit', async () => {
    for (const slug of ['stale-a', 'stale-b', 'stale-c']) {
      await queuePage(`writing/${slug}`, `${slug} prose.`, { priority: 100 });
      await engine.executeRaw(
        `UPDATE take_mining_work
            SET mining_input_hash = 'stale-hash'
          WHERE source_id = 'default' AND page_slug = $1`,
        [`writing/${slug}`],
      );
    }
    await queuePage('writing/eligible-after-stale', 'Eligible prose.', {
      priority: 10,
    });

    const paths: string[] = [];
    const result = await runPhaseProposeTakes(ctx(), {
      pageLimit: 1,
      _workBatchSize: 2,
      _extractableTypes: NOTE_TYPES,
      extractor: async input => {
        paths.push(input.pagePath);
        return [];
      },
    });

    expect(paths).toEqual(['writing/eligible-after-stale']);
    expect(result.details.pages_scanned).toBe(1);
    expect(result.details.work_batches_read).toBe(2);
    expect(result.details.warnings).toContain(
      '3 take-mining work items had stale semantic hashes and were preserved',
    );
  });

  test('applies limit after queue admission, eligibility, and successful-scan filtering', async () => {
    await queuePage('writing/deferred', 'Deferred prose.', {
      admission: 'deferred',
      priority: 100,
    });
    await queuePage('writing/non-extractable', 'Metadata prose.', {
      type: 'metadata',
      priority: 90,
    });
    const cachedHash = await queuePage('writing/cached', 'Already scanned.', {
      priority: 80,
    });
    await engine.executeRaw(
      `INSERT INTO take_proposal_scans (
         source_id, page_slug, mining_input_hash, prompt_version,
         status, attempt_id, proposal_run_id, model_id,
         proposal_count, completed_at
       ) VALUES (
         'default', 'writing/cached', $1, $2,
         'succeeded', 'cached-attempt', 'cached-run', 'test-model',
         0, now()
       )`,
      [cachedHash, PROPOSE_TAKES_PROMPT_VERSION],
    );
    await queuePage('writing/eligible-first', 'First eligible prose.', { priority: 20 });
    await queuePage('writing/eligible-second', 'Second eligible prose.', { priority: 10 });

    const paths: string[] = [];
    const result = await runPhaseProposeTakes(ctx(), {
      pageLimit: 1,
      _extractableTypes: NOTE_TYPES,
      extractor: async input => {
        paths.push(input.pagePath);
        return [];
      },
    });

    expect(paths).toEqual(['writing/eligible-first']);
    expect(result.status).toBe('ok');
    expect(result.details.stopped).toBe(false);
    expect(result.details.pages_scanned).toBe(1);
    expect(result.details.ineligible_work_settled).toBe(1);
    expect(await count('take_mining_work')).toBe(2);
  });

  test('settles generated, deleted, non-extractable, whitespace-only, and canonically empty pages', async () => {
    await queuePage('writing/generated', 'Generated prose.', {
      frontmatter: { dream_generated: true },
    });
    await queuePage('writing/deleted', 'Deleted prose.');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now()
        WHERE source_id = 'default' AND slug = 'writing/deleted'`,
    );
    await queuePage('writing/wrong-type', 'Wrong type prose.', { type: 'metadata' });
    await queuePage('writing/whitespace-only', ' \n\t\n ');
    await queuePage(
      'writing/managed-only',
      '<!-- gbrain:backlinks:begin -->\nGenerated\n<!-- gbrain:backlinks:end -->',
    );
    expect(await count('take_mining_work')).toBe(4);

    let calls = 0;
    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        calls++;
        return [];
      },
    });

    expect(calls).toBe(0);
    expect(result.details.pages_scanned).toBe(0);
    expect(result.details.ineligible_work_settled).toBe(4);
    expect(result.details.remaining_work).toBe(0);
    expect(result.details.warnings).toContain(
      '2 take-mining work items had no canonical prose and were not eligible for mining',
    );
    expect(await count('take_mining_work')).toBe(0);
    expect((await getTakeMiningStatus(ctx(), {
      sourceId: 'default',
    })).queue).toEqual({
      total: 0,
      immediate: 0,
      deferred: 0,
    });
    expect(await engine.executeRaw<{ page_slug: string }>(
      `SELECT page_slug
         FROM page_mutations
        WHERE source_id = 'default'
          AND page_slug IN ('writing/managed-only', 'writing/whitespace-only')
        ORDER BY page_slug`,
    )).toEqual([
      { page_slug: 'writing/managed-only' },
      { page_slug: 'writing/whitespace-only' },
    ]);
  });

  test('canonical-empty cleanup preserves eligible and stale work', async () => {
    await queuePage('writing/eligible-retry', 'Eligible prose.');
    await queuePage('writing/stale-preserved', 'Current prose.');
    await engine.executeRaw(
      `UPDATE take_mining_work
          SET mining_input_hash = 'stale-hash'
        WHERE source_id = 'default'
          AND page_slug = 'writing/stale-preserved'`,
    );
    await queuePage(
      'writing/managed-only-cleanup',
      '<!-- gbrain:backlinks:begin -->\nGenerated\n<!-- gbrain:backlinks:end -->',
    );

    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        throw new Error('keep eligible work retryable');
      },
    });

    expect(result.details).toMatchObject({
      pages_scanned: 1,
      ineligible_work_settled: 1,
      remaining_work: 2,
    });
    expect(result.details.warnings).toContain(
      '1 take-mining work item had stale semantic hashes and was preserved',
    );
    expect(await engine.executeRaw<{ page_slug: string }>(
      `SELECT page_slug
         FROM take_mining_work
        ORDER BY page_slug`,
    )).toEqual([
      { page_slug: 'writing/eligible-retry' },
      { page_slug: 'writing/stale-preserved' },
    ]);
  });

  test('bounds canonical-empty cleanup by the configured work batch', async () => {
    const managedBody =
      '<!-- gbrain:backlinks:begin -->\n' +
      'x'.repeat(2_048) +
      '\n<!-- gbrain:backlinks:end -->';
    for (let index = 0; index < 40; index++) {
      await queuePage(`writing/managed-batch-${index.toString().padStart(2, '0')}`, managedBody);
    }
    await queuePage('writing/first-eligible', 'Mine this page first.', {
      priority: 100,
    });

    const firstMetrics: Array<{
      loadedRows: number;
      classifiedRows: number;
      canonicalEmptyRows: number;
      serializedBytes: number;
    }> = [];
    const first = await runPhaseProposeTakes(ctx(), {
      pageLimit: 1,
      _workBatchSize: 5,
      _extractableTypes: NOTE_TYPES,
      _onWorkBatch: metrics => firstMetrics.push(metrics),
      extractor: noProposals,
    });

    expect(first.details).toMatchObject({
      pages_scanned: 1,
      ineligible_work_settled: 0,
      remaining_work: 40,
    });
    expect(firstMetrics).toEqual([{
      loadedRows: 5,
      classifiedRows: 1,
      canonicalEmptyRows: 0,
      serializedBytes: 0,
    }]);

    const drainMetrics: typeof firstMetrics = [];
    const drained = await runPhaseProposeTakes(ctx(), {
      pageLimit: 1,
      _workBatchSize: 5,
      _extractableTypes: NOTE_TYPES,
      _onWorkBatch: metrics => drainMetrics.push(metrics),
      extractor: noProposals,
    });

    expect(drained.details).toMatchObject({
      pages_scanned: 0,
      ineligible_work_settled: 40,
      remaining_work: 0,
    });
    expect(drainMetrics).toHaveLength(8);
    expect(Math.max(...drainMetrics.map(metrics => metrics.loadedRows))).toBe(5);
    expect(Math.max(...drainMetrics.map(metrics => metrics.classifiedRows))).toBe(5);
    expect(Math.max(...drainMetrics.map(metrics => metrics.canonicalEmptyRows))).toBe(5);
    expect(Math.max(...drainMetrics.map(metrics => metrics.serializedBytes)))
      .toBeLessThan(managedBody.length * 6);
  });

  test('passes canonical prose while preserving fence rows as dedup context', async () => {
    const body = `Opening [Atlas](https://old.example/atlas).

## Takes
<!-- gbrain:takes:begin -->
| # | claim | kind | who | weight |
|---|-------|------|-----|--------|
| 1 | Existing claim | take | brain | 0.5 |
<!-- gbrain:takes:end -->`;
    await queuePage('writing/canonical', body);

    let receivedBody = '';
    let receivedClaim = '';
    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async input => {
        receivedBody = input.pageBody;
        receivedClaim = input.existingTakes[0]?.claim ?? '';
        return [];
      },
    });

    expect(receivedBody).toBe('Opening Atlas.');
    expect(receivedClaim).toBe('Existing claim');
  });

  test('caches a successful empty result and removes matching work', async () => {
    const hash = await queuePage('writing/no-takes', 'Pure fact with no take.');
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor,
    });
    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor,
    });

    expect(calls).toBe(1);
    expect(await count('take_mining_work')).toBe(0);
    const scans = await engine.executeRaw<{
      status: string;
      proposal_count: number;
      mining_input_hash: string;
    }>(
      `SELECT status, proposal_count, mining_input_hash
         FROM take_proposal_scans`,
    );
    expect(scans).toEqual([{
      status: 'succeeded',
      proposal_count: 0,
      mining_input_hash: hash,
    }]);
  });

  test('retires A work when an A to B to A edit returns to a successful scan', async () => {
    const slug = 'writing/semantic-revert';
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };
    await queuePage(slug, 'Semantic revision A.');
    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor,
    });

    await queuePage(slug, 'Semantic revision B.');
    await queuePage(slug, 'Semantic revision A.');
    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor,
    });

    expect(calls).toBe(1);
    expect(result.details).toMatchObject({
      eligible_pages: 0,
      pages_scanned: 0,
      cache_hits: 1,
      remaining_work: 0,
    });
    expect(await count('take_mining_work')).toBe(0);
  });

  test('dry-run reports satisfied revert work without retiring it', async () => {
    const slug = 'writing/semantic-revert-preview';
    await queuePage(slug, 'Semantic revision A.');
    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: noProposals,
    });
    await queuePage(slug, 'Semantic revision B.');
    await queuePage(slug, 'Semantic revision A.');

    const result = await runPhaseProposeTakes(ctx(), {
      dryRun: true,
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        throw new Error('must not call');
      },
    });

    expect(result.details).toMatchObject({
      dry_run: true,
      eligible_pages: 0,
      pages_scanned: 0,
      cache_hits: 1,
      remaining_work: 1,
    });
    expect(await count('take_mining_work')).toBe(1);
    expect(await count('take_proposal_scans')).toBe(1);
  });

  test('does not retire work satisfied only by a previous prompt version', async () => {
    const slug = 'writing/old-prompt';
    const hash = await queuePage(slug, 'Prompt-sensitive prose.');
    await engine.executeRaw(
      `INSERT INTO take_proposal_scans (
         source_id, page_slug, mining_input_hash, prompt_version,
         status, attempt_id, proposal_run_id, model_id,
         proposal_count, completed_at
       ) VALUES (
         'default', $1, $2, 'previous-prompt',
         'succeeded', 'old-attempt', 'old-run', 'test-model',
         0, now()
       )`,
      [slug, hash],
    );
    let calls = 0;

    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        calls++;
        return [];
      },
    });

    expect(calls).toBe(1);
    expect(result.details).toMatchObject({
      cache_hits: 0,
      cache_misses: 1,
      remaining_work: 0,
    });
    expect(await count('take_proposal_scans')).toBe(2);
  });

  test('extractor failure releases its claim and leaves work retryable', async () => {
    await queuePage('writing/retry', 'Retry this prose.');

    const failed = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        throw new Error('malformed output');
      },
    });
    expect(failed.details.warnings).toEqual([
      'extractor failed on writing/retry: malformed output',
    ]);
    expect(await count('take_proposal_scans')).toBe(0);
    expect(await count('take_mining_work')).toBe(1);

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: noProposals,
    });
    expect(await count('take_mining_work')).toBe(0);
    expect(await count('take_proposal_scans')).toBe(1);
  });

  test('only one concurrent worker claims a semantic input', async () => {
    await queuePage('writing/concurrent', 'Only one extractor may run.');
    let releaseClaims!: () => void;
    let notifyBothSelected!: () => void;
    const bothSelected = new Promise<void>(resolve => { notifyBothSelected = resolve; });
    const claimsReleased = new Promise<void>(resolve => { releaseClaims = resolve; });
    let selectedWorkers = 0;
    const beforeClaim = async () => {
      selectedWorkers++;
      if (selectedWorkers === 2) notifyBothSelected();
      await claimsReleased;
    };
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      return [];
    };

    const first = runTakeMiningWork(ctx(), {
      admission: 'immediate',
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 100,
      _extractableTypes: NOTE_TYPES,
      _beforeClaim: beforeClaim,
      extractor,
    });
    const second = runTakeMiningWork(ctx(), {
      admission: 'immediate',
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 100,
      _extractableTypes: NOTE_TYPES,
      _beforeClaim: beforeClaim,
      extractor,
    });
    await bothSelected;
    releaseClaims();
    const results = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(results.reduce(
      (sum, result) => sum + result.eligible_pages,
      0,
    )).toBe(2);
    expect(results.reduce(
      (sum, result) => sum + result.pages_scanned,
      0,
    )).toBe(1);
    expect(results.reduce(
      (sum, result) => sum + result.cache_misses,
      0,
    )).toBe(1);
    expect(results.reduce(
      (sum, result) => sum + result.cache_hits,
      0,
    )).toBe(1);
    expect(await count('take_proposal_scans')).toBe(1);
  });

  test('reclaims an expired in-progress lease', async () => {
    const hash = await queuePage('writing/expired', 'Expired leases are retryable.');
    await engine.executeRaw(
      `INSERT INTO take_proposal_scans (
         source_id, page_slug, mining_input_hash, prompt_version,
         status, attempt_id, lease_expires_at, proposal_run_id, model_id
       ) VALUES (
         'default', 'writing/expired', $1, $2,
         'in_progress', 'expired-attempt', now() - interval '1 second',
         'expired-run', 'test-model'
       )`,
      [hash, PROPOSE_TAKES_PROMPT_VERSION],
    );

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: noProposals,
    });

    const scans = await engine.executeRaw<{ status: string; attempt_id: string }>(
      `SELECT status, attempt_id FROM take_proposal_scans`,
    );
    expect(scans[0]?.status).toBe('succeeded');
    expect(scans[0]?.attempt_id).not.toBe('expired-attempt');
  });

  test('reclaimed ownership prevents the old worker from committing or deleting newer work', async () => {
    await queuePage('writing/reclaimed-race', 'Original semantic prose.');
    let notifyFirstEntered!: () => void;
    let notifySecondEntered!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstEntered = new Promise<void>(resolve => { notifyFirstEntered = resolve; });
    const secondEntered = new Promise<void>(resolve => { notifySecondEntered = resolve; });
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondReleased = new Promise<void>(resolve => { releaseSecond = resolve; });
    let extractorCalls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      extractorCalls++;
      if (extractorCalls === 1) {
        notifyFirstEntered();
        await firstReleased;
        return [{
          claim_text: 'Superseded worker claim',
          kind: 'take',
          holder: 'brain',
          weight: 0.5,
        }];
      }
      notifySecondEntered();
      await secondReleased;
      return [{
        claim_text: 'Reclaimed worker claim',
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }];
    };

    const oldWorker = runTakeMiningWork(ctx(), {
      admission: 'immediate',
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 100,
      _extractableTypes: NOTE_TYPES,
      extractor,
    });
    await firstEntered;
    await engine.executeRaw(
      `UPDATE take_proposal_scans
          SET lease_expires_at = now() - interval '1 second'
        WHERE source_id = 'default'
          AND page_slug = 'writing/reclaimed-race'
          AND status = 'in_progress'`,
    );

    const reclaimingWorker = runTakeMiningWork(ctx(), {
      admission: 'immediate',
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 100,
      _extractableTypes: NOTE_TYPES,
      extractor,
    });
    await secondEntered;

    const newerBody = 'Newer semantic prose.';
    const newerHash = buildTakeMiningInput(newerBody).mining_input_hash;
    await engine.putPage('writing/reclaimed-race', {
      type: 'note',
      title: 'Reclaimed race',
      compiled_truth: newerBody,
    }, {
      writeContext: {
        actor: 'test',
        writeIntent: 'user_edit',
      },
    });

    releaseFirst();
    const oldResult = await oldWorker;
    expect(oldResult).toMatchObject({
      eligible_pages: 1,
      pages_scanned: 1,
      cache_misses: 1,
      proposals_inserted: 0,
    });
    expect(oldResult.warnings).toContain(
      'scan ownership lost for writing/reclaimed-race',
    );
    expect(await count('take_proposals')).toBe(0);
    expect(await engine.executeRaw<{ mining_input_hash: string }>(
      `SELECT mining_input_hash
         FROM take_mining_work
        WHERE source_id = 'default'
          AND page_slug = 'writing/reclaimed-race'`,
    )).toEqual([{ mining_input_hash: newerHash }]);

    releaseSecond();
    const reclaimedResult = await reclaimingWorker;
    expect(reclaimedResult.proposals_inserted).toBe(1);
    expect(await engine.executeRaw<{ claim_text: string }>(
      `SELECT claim_text FROM take_proposals`,
    )).toEqual([{ claim_text: 'Reclaimed worker claim' }]);
    expect(await engine.executeRaw<{ mining_input_hash: string }>(
      `SELECT mining_input_hash
         FROM take_mining_work
        WHERE source_id = 'default'
          AND page_slug = 'writing/reclaimed-race'`,
    )).toEqual([{ mining_input_hash: newerHash }]);
  });

  test('does not delete newer work admitted while extraction is running', async () => {
    await queuePage('writing/stale', 'Original semantic prose.');
    const newer = buildTakeMiningInput('Newer semantic prose.').mining_input_hash;

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        await engine.executeRaw(
          `UPDATE take_mining_work
              SET mining_input_hash = $1, updated_at = now()
            WHERE source_id = 'default' AND page_slug = 'writing/stale'`,
          [newer],
        );
        return [];
      },
    });

    const work = await engine.executeRaw<{ mining_input_hash: string }>(
      `SELECT mining_input_hash FROM take_mining_work`,
    );
    expect(work).toEqual([{ mining_input_hash: newer }]);
  });

  test('dry-run is read-only and reports eligible outstanding work', async () => {
    await queuePage('writing/dry-run', 'Dry run prose.');
    let calls = 0;

    const result = await runPhaseProposeTakes(ctx(), {
      dryRun: true,
      _extractableTypes: NOTE_TYPES,
      extractor: async () => {
        calls++;
        return [];
      },
    });

    expect(result.details).toMatchObject({
      dry_run: true,
      eligible_pages: 1,
      pages_scanned: 0,
      cache_misses: 0,
    });
    expect(result.summary).toContain('would scan 1 eligible page');
    expect(calls).toBe(0);
    expect(await count('take_mining_work')).toBe(1);
    expect(await count('take_proposal_scans')).toBe(0);
    expect(await count('take_proposals')).toBe(0);
  });

  test('uses one proposal_run_id across proposals from every page in a run', async () => {
    await queuePage('writing/run-a', 'Run A prose.');
    await queuePage('writing/run-b', 'Run B prose.');

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      extractor: async input => [{
        claim_text: `Claim from ${input.pagePath}`,
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }],
    });

    const proposals = await engine.executeRaw<{
      page_slug: string;
      proposal_run_id: string;
    }>(
      `SELECT page_slug, proposal_run_id
         FROM take_proposals
        ORDER BY page_slug`,
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.proposal_run_id).toBe(proposals[1]?.proposal_run_id);
    expect(proposals[0]?.proposal_run_id).toMatch(/^propose-/);
  });

  test('records the configured default model when no phase override is passed', async () => {
    configureGateway({
      chat_model: 'openai:gpt-5',
      env: { OPENAI_API_KEY: 'test-key' },
    });
    await queuePage('writing/configured-model', 'Configured model prose.');

    await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      _estimatedPageSpendUsd: 0.001,
      extractor: async () => [{
        claim_text: 'Configured model claim',
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }],
    });

    const proposals = await engine.executeRaw<{ model_id: string }>(
      `SELECT model_id FROM take_proposals`,
    );
    expect(proposals).toEqual([{ model_id: 'openai:gpt-5' }]);
  });

  test('preserves nested provider model ids through budget checks and records', async () => {
    const modelId = 'openrouter:anthropic/claude-sonnet-4-6';
    configureGateway({
      chat_model: modelId,
      env: { OPENROUTER_API_KEY: 'test-key' },
    });
    await queuePage('writing/nested-model', 'Nested provider model prose.');
    const meter = new BudgetMeter({
      budgetUsd: 0.000001,
      phase: 'propose_takes',
      auditPath: '/dev/null',
    });

    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
      _estimatedPageSpendUsd: 0.001,
      meter,
      extractor: async () => [{
        claim_text: 'Nested provider model claim',
        kind: 'take',
        holder: 'brain',
        weight: 0.5,
      }],
    });

    expect(result.status).toBe('ok');
    expect(result.details.budget_exhausted).toBe(false);
    expect(meter.unpricedSubmits).toBe(1);
    const proposals = await engine.executeRaw<{ model_id: string }>(
      `SELECT model_id FROM take_proposals`,
    );
    const scans = await engine.executeRaw<{ model_id: string }>(
      `SELECT model_id FROM take_proposal_scans`,
    );
    expect(proposals).toEqual([{ model_id: modelId }]);
    expect(scans).toEqual([{ model_id: modelId }]);
  });

  test('stops before claiming work when the configured budget is exhausted', async () => {
    await queuePage('writing/over-budget', 'This work exceeds the budget.');
    let extractorCalls = 0;
    const meter = new BudgetMeter({
      budgetUsd: 0.000001,
      phase: 'propose_takes',
      auditPath: '/dev/null',
    });

    const result = await runPhaseProposeTakes(ctx(), {
      model: 'anthropic:claude-opus-4-7',
      _extractableTypes: NOTE_TYPES,
      meter,
      extractor: async () => {
        extractorCalls++;
        return [];
      },
    });

    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({
      budget_exhausted: true,
      eligible_pages: 1,
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
    });
    expect(result.details.warnings).toEqual([
      expect.stringContaining('budget exhausted before writing/over-budget'),
    ]);
    expect(extractorCalls).toBe(0);
    expect(await count('take_proposal_scans')).toBe(0);
    expect(await count('take_mining_work')).toBe(1);
  });
});

describe('extractor output validity', () => {
  test('distinguishes a valid empty array from malformed output', () => {
    expect(__testing.parseExtractorOutputResult('[]')).toEqual({
      valid: true,
      proposals: [],
    });
    expect(__testing.parseExtractorOutputResult('[not json')).toEqual({
      valid: false,
      proposals: [],
    });
    expect(__testing.parseExtractorOutputResult('{"claim_text":"not an array"}')).toEqual({
      valid: false,
      proposals: [],
    });
    expect(__testing.parseExtractorOutputResult('[42]')).toEqual({
      valid: false,
      proposals: [],
    });
  });
});

function extractorResponse(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  };
}

describe('default extractor settlement', () => {
  test.each([
    ['a top-level object', '{"claim_text":"not an array"}'],
    ['a non-object array entry', '[42]'],
  ])('keeps %s retryable', async (_shape, output) => {
    __setChatTransportForTests(async () => extractorResponse(output));
    await queuePage('writing/malformed-shape', 'Retry malformed output.');

    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
    });

    expect(result.details.warnings).toEqual([
      'extractor failed on writing/malformed-shape: extractor returned malformed JSON',
    ]);
    expect(await count('take_proposal_scans')).toBe(0);
    expect(await count('take_mining_work')).toBe(1);
  });

  test('settles a valid empty array', async () => {
    __setChatTransportForTests(async () => extractorResponse('[]'));
    await queuePage('writing/valid-empty', 'Settle valid empty output.');

    const result = await runPhaseProposeTakes(ctx(), {
      _extractableTypes: NOTE_TYPES,
    });

    expect(result.details.warnings).toEqual([]);
    expect(await count('take_proposal_scans')).toBe(1);
    expect(await count('take_mining_work')).toBe(0);
  });
});
