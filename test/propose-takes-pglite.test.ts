import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import type { OperationContext } from '../src/core/operations.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import {
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';
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

function ctx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function enqueue(slug: string, body: string): Promise<string> {
  const hash = buildTakeMiningInput(body).mining_input_hash;
  await engine.executeRaw(
    `UPDATE take_mining_work
        SET mining_input_hash = $2,
            admission = 'immediate',
            write_intent = 'user_edit',
            actor = 'test'
      WHERE source_id = 'default' AND page_slug = $1`,
    [slug, hash],
  );
  return hash;
}

describe('propose_takes persistence on PGLite', () => {
  test('migration backfills claim hashes and installs per-claim uniqueness', async () => {
    await engine.executeRaw(
      `ALTER TABLE take_proposals ALTER COLUMN claim_hash DROP NOT NULL`,
    );
    await engine.executeRaw(
      `DROP INDEX IF EXISTS take_proposals_idempotency_idx`,
    );
    await engine.executeRaw(`
      CREATE UNIQUE INDEX take_proposals_idempotency_idx
        ON take_proposals (source_id, page_slug, content_hash, prompt_version)
    `);
    await engine.executeRaw(
      `INSERT INTO take_proposals (
         source_id, page_slug, content_hash, prompt_version, proposal_run_id,
         claim_text, kind, holder, weight, model_id
       ) VALUES (
         'default', 'writing/legacy-proposal', 'page-hash', 'prompt-v1', 'run-v1',
         $1, 'take', 'brain', 0.5, 'test-model'
       )`,
      ['  A legacy claim.  '],
    );
    await engine.setConfig('version', '125');

    const result = await runMigrations(engine);

    expect(result.applied).toBe(
      MIGRATIONS.filter(migration => migration.version > 125).length,
    );
    const rows = await engine.executeRaw<{
      claim_hash: string;
      resolution_note: string | null;
    }>(
      `SELECT claim_hash, resolution_note FROM take_proposals`,
    );
    expect(rows).toEqual([{
      claim_hash: createHash('sha256').update('A legacy claim.').digest('hex'),
      resolution_note: null,
    }]);
    const columns = await engine.executeRaw<{
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'take_proposals'
          AND column_name IN ('claim_hash', 'resolution_note')
        ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'claim_hash', is_nullable: 'NO' },
      { column_name: 'resolution_note', is_nullable: 'YES' },
    ]);
    const indexes = await engine.executeRaw<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE indexname = 'take_proposals_idempotency_idx'`,
    );
    expect(indexes[0]?.indexdef).toContain(
      '(source_id, page_slug, content_hash, prompt_version, claim_hash)',
    );
  });

  test('preserves distinct claims, conflict-drops duplicate claims, and reports honest counts', async () => {
    await engine.putPage('writing/proposal-source', {
      type: 'note',
      title: 'Proposal source',
      compiled_truth: 'Three extracted claims should produce two queue rows.',
      timeline: '',
      frontmatter: {},
    });
    const miningHash = await enqueue(
      'writing/proposal-source',
      'Three extracted claims should produce two queue rows.',
    );
    const extractor: ProposeTakesExtractor = async () => [
      {
        claim_text: 'The first claim survives.',
        kind: 'take',
        holder: 'brain',
        weight: 0.6,
      },
      {
        claim_text: 'The second claim survives.',
        kind: 'bet',
        holder: 'brain',
        weight: 0.7,
      },
      {
        claim_text: '  The first claim survives.  ',
        kind: 'take',
        holder: 'brain',
        weight: 0.6,
      },
    ];

    const result = await runPhaseProposeTakes(ctx(), {
      extractor,
      _extractableTypes: ['note'],
    });

    expect(result.details).toMatchObject({
      proposals_extracted: 3,
      proposals_inserted: 2,
    });
    expect(result.summary).toContain('3 extracted');
    expect(result.summary).toContain('2 new proposals');

    const rows = await engine.executeRaw<{
      claim_text: string;
      claim_hash: string;
    }>(
      `SELECT claim_text, claim_hash
         FROM take_proposals
        ORDER BY claim_text`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.claim_text)).toEqual([
      'The first claim survives.',
      'The second claim survives.',
    ]);
    expect(rows[0]?.claim_hash).toBe(
      createHash('sha256').update(rows[0]!.claim_text.trim()).digest('hex'),
    );
    const provenance = await engine.executeRaw<{ content_hash: string }>(
      `SELECT DISTINCT content_hash FROM take_proposals`,
    );
    expect(provenance).toEqual([{ content_hash: miningHash }]);
  });
});
