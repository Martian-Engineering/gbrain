import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { __testing } from '../../src/commands/migrations/v0_32_2.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

if (skip) test.skip('facts fence backfill resolution skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('facts fence backfill resolution on Postgres', () => {
  const sourceId = 'fd3-no-checkout';
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
  });

  afterAll(async () => {
    if (engine) {
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
      await engine.disconnect();
    }
  });

  test('retains a no-local_path legacy fact and releases extract_facts', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path)
       VALUES ($1, $1, NULL)
       ON CONFLICT (id) DO UPDATE SET local_path = NULL`,
      [sourceId],
    );
    await engine.executeRaw(
      `INSERT INTO facts
         (source_id, entity_slug, fact, kind, visibility, notability,
          valid_from, source, confidence)
       VALUES ($1, 'people/alice-example', 'DB-only legacy fact', 'fact',
               'private', 'medium', now(), 'mcp:put_page', 1.0)`,
      [sourceId],
    );

    const migration = await __testing.phaseBFenceFacts(
      engine,
      { yes: true, dryRun: false, noAutopilotInstall: true },
    );
    const phase = await runExtractFacts(engine, { sourceId, slugs: [] });
    const rows = await engine.executeRaw<{
      fact: string;
      row_num: number | null;
      resolution: string;
    }>(
      `SELECT f.fact, f.row_num, r.resolution
         FROM facts f
         JOIN facts_fence_backfill_resolutions r ON r.fact_id = f.id
        WHERE f.source_id = $1`,
      [sourceId],
    );

    expect(migration.status).toBe('complete');
    expect(migration.detail).toContain('retained_db_only=1');
    expect(phase.guardTriggered).toBe(false);
    expect(phase.legacyRowsPending).toBe(0);
    expect(Array.from(rows)).toEqual([{
      fact: 'DB-only legacy fact',
      row_num: null,
      resolution: 'retained_db_only',
    }]);
  }, 30_000);
});
