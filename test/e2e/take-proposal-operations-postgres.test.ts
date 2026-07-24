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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  operationsByName,
  type OperationContext,
} from '../../src/core/operations.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;
const SOURCE_ID = 'take-proposal-pg';

describePostgres('take proposal operations on PostgreSQL', () => {
  let engine: BrainEngine;
  let brainDir: string;

  beforeAll(async () => {
    engine = await setupDB();
    brainDir = mkdtempSync(join(import.meta.dir, '.take-proposals-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ($1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [SOURCE_ID],
    );
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
    rmSync(brainDir, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM take_proposals`);
    await engine.executeRaw(`DELETE FROM takes`);
    await engine.executeRaw(
      `DELETE FROM pages WHERE source_id = $1`,
      [SOURCE_ID],
    );
    rmSync(brainDir, { recursive: true, force: true });
    mkdirSync(brainDir, { recursive: true });
    await engine.setConfig('sync.repo_path', brainDir);
  });

  function ctx(): OperationContext {
    return {
      engine,
      config: { engine: 'postgres' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: SOURCE_ID,
    };
  }

  async function seedProposal(
    slug: string,
    claimText: string,
  ): Promise<{ id: number; pagePath: string }> {
    const markdown = `# ${slug}\n`;
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: markdown,
      timeline: '',
    }, { sourceId: SOURCE_ID });
    const pagePath = join(brainDir, `${slug}.md`);
    writeFileSync(pagePath, markdown, 'utf8');
    const claimHash = createHash('sha256')
      .update(claimText.trim())
      .digest('hex');
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals (
         source_id, page_slug, content_hash, prompt_version, proposal_run_id,
         status, claim_text, claim_hash, kind, holder, weight, domain,
         dedup_against_fence_rows, model_id, proposed_at
       ) VALUES (
         $1, $2, $3, 'prompt-v1', 'pg-run', 'pending', $4, $5,
         'take', 'world', 0.7, 'strategy', '[]'::jsonb,
         'test-model', '2026-07-20T10:00:00Z'::timestamptz
       )
       RETURNING id`,
      [SOURCE_ID, slug, `content-${slug}`, claimText, claimHash],
    );
    return { id: rows[0]!.id, pagePath };
  }

  test('accept round-trips through the fence, takes mirror, and proposal audit row', async () => {
    const { id, pagePath } = await seedProposal(
      'proposal-round-trip',
      'PostgreSQL accepted claim',
    );

    const result = await withEnv(
      { GBRAIN_HOME: brainDir },
      () => operationsByName.resolve_take_proposal.handler(ctx(), {
        id,
        action: 'accept',
        notes: 'PostgreSQL review accepted.',
      }) as Promise<Record<string, unknown>>,
    );

    expect(result).toMatchObject({
      id,
      status: 'accepted',
      promoted_row_num: 1,
      resolution_note: 'PostgreSQL review accepted.',
    });
    const fence = parseTakesFence(readFileSync(pagePath, 'utf8'));
    expect(fence.takes).toHaveLength(1);
    expect(fence.takes[0]).toMatchObject({
      claim: 'PostgreSQL accepted claim',
      sinceDate: '2026-07-20',
      source: `proposal:${id}`,
    });
    const takes = await engine.executeRaw<{
      claim: string;
      since_date: string;
      source: string;
    }>(
      `SELECT claim, since_date::text AS since_date, source FROM takes`,
    );
    expect(takes).toEqual([{
      claim: 'PostgreSQL accepted claim',
      since_date: '2026-07-20',
      source: `proposal:${id}`,
    }]);
  });

  test('concurrent resolution has one winner and one not_pending result', async () => {
    const { id, pagePath } = await seedProposal(
      'proposal-concurrent',
      'Resolve me once',
    );

    const settled = await withEnv(
      { GBRAIN_HOME: brainDir },
      () => Promise.allSettled([
        operationsByName.resolve_take_proposal.handler(ctx(), {
          id,
          action: 'accept',
        }),
        operationsByName.resolve_take_proposal.handler(ctx(), {
          id,
          action: 'accept',
        }),
      ]),
    );

    const fulfilled = settled.filter(result => result.status === 'fulfilled');
    const rejected = settled.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'not_pending',
      status: 'accepted',
    });
    expect(parseTakesFence(readFileSync(pagePath, 'utf8')).takes).toHaveLength(1);
    const counts = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes`,
    );
    expect(Number(counts[0]?.count)).toBe(1);
  });
});
