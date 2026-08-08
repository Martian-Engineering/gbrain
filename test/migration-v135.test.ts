/**
 * Migration v135 — persisted timeline reference labels.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

describe('migration v135 — timeline reference columns', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('registers refs, per-page event dedup, and search repair', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 135);
    expect(migration).toMatchObject({
      name: 'timeline_entry_refs',
      idempotent: true,
    });
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS ref_slug TEXT');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS ref_label TEXT');
    expect(migration?.sql).toContain('DROP INDEX IF EXISTS idx_timeline_event_dedup');
    expect(migration?.sql).toContain('page_id, event_page_id, date');
    expect(typeof migration?.handler).toBe('function');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(135);
  });

  test('v139 accepts deployment users with inherited BYPASSRLS authority', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 139);
    expect(migration).toMatchObject({
      name: 'ingestion_proposal_application_ledger',
      idempotent: true,
    });
    expect(migration?.sql).toContain("pg_has_role(current_user, pr.oid, 'USAGE')");
    expect(migration?.sql).not.toContain('pr.rolname = current_user');
  });

  test('adds refs, widens event dedup, and preserves row-backed timeline search', async () => {
    await engine.putPage('legacy-search-page', {
      type: 'note',
      title: 'Legacy search page',
      compiled_truth: '',
    });
    await engine.executeRaw(`
      CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
      DECLARE
        timeline_text TEXT;
      BEGIN
        SELECT string_agg(coalesce(summary, '') || ' ' || coalesce(detail, ''), ' ')
          INTO timeline_text
          FROM timeline_entries
         WHERE page_id = NEW.id;
        NEW.search_vector :=
          setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
          setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await engine.executeRaw(
      `UPDATE pages SET timeline = $1 WHERE slug = 'legacy-search-page'`,
      ['zzLegacyMigrationTimeline135'],
    );
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT id, '2026-07-31'::date, '', 'zzStructuredTimeline135', 'search detail'
         FROM pages WHERE slug = 'legacy-search-page'`,
    );
    await engine.executeRaw('DROP INDEX IF EXISTS idx_timeline_event_dedup');
    await engine.executeRaw(
      `CREATE UNIQUE INDEX idx_timeline_event_dedup
         ON timeline_entries(event_page_id, date) WHERE event_page_id IS NOT NULL`,
    );
    const before = await engine.executeRaw<{ matches: boolean }>(
      `SELECT search_vector @@ plainto_tsquery('english', 'zzLegacyMigrationTimeline135') AS matches
         FROM pages WHERE slug = 'legacy-search-page'`,
    );
    expect(before[0]?.matches).toBe(true);

    await engine.executeRaw(`ALTER TABLE timeline_entries DROP COLUMN IF EXISTS ref_slug`);
    await engine.executeRaw(`ALTER TABLE timeline_entries DROP COLUMN IF EXISTS ref_label`);
    await engine.setConfig('version', '134');

    const first = await runMigrations(engine);
    expect(first).toEqual({ applied: 5, current: 139 });
    const columns = await engine.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'timeline_entries'
          AND column_name IN ('ref_slug', 'ref_label')
        ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'ref_label', is_nullable: 'YES' },
      { column_name: 'ref_slug', is_nullable: 'YES' },
    ]);
    const searchState = await engine.executeRaw<{
      legacy_matches: boolean;
      structured_matches: boolean;
      function_body: string;
    }>(
      `SELECT p.search_vector @@ plainto_tsquery('english', 'zzLegacyMigrationTimeline135') AS legacy_matches,
              p.search_vector @@ plainto_tsquery('english', 'zzStructuredTimeline135') AS structured_matches,
              fn.prosrc AS function_body
         FROM pages p
         CROSS JOIN pg_proc fn
        WHERE p.slug = 'legacy-search-page'
          AND fn.proname = 'update_page_search_vector'`,
    );
    expect(searchState[0]?.legacy_matches).toBe(false);
    expect(searchState[0]?.structured_matches).toBe(true);
    expect(searchState[0]?.function_body).not.toContain('NEW.timeline');
    expect(searchState[0]?.function_body).toContain('FROM timeline_entries');
    const index = await engine.executeRaw<{ definition: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS definition
         FROM pg_index
        WHERE indexrelid = 'idx_timeline_event_dedup'::regclass`,
    );
    expect(index[0]?.definition).toContain('(page_id, event_page_id, date)');

    await engine.setConfig('version', '134');
    const second = await runMigrations(engine);
    expect(second).toEqual({ applied: 5, current: 139 });
  }, 30_000);
});
