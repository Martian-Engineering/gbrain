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

  test('registers nullable ref columns as the latest migration', () => {
    const migration = MIGRATIONS.find(entry => entry.version === 135);
    expect(migration).toMatchObject({
      name: 'timeline_entry_refs',
      idempotent: true,
    });
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS ref_slug TEXT');
    expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS ref_label TEXT');
    expect(typeof migration?.handler).toBe('function');
    expect(LATEST_VERSION).toBe(135);
  });

  test('adds both nullable columns and can safely reapply them', async () => {
    await engine.putPage('legacy-search-page', {
      type: 'note',
      title: 'Legacy search page',
      compiled_truth: '',
    });
    await engine.executeRaw(`
      CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C');
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await engine.executeRaw(
      `UPDATE pages SET timeline = $1 WHERE slug = 'legacy-search-page'`,
      ['zzLegacyMigrationTimeline135'],
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
    expect(first).toEqual({ applied: 1, current: 135 });
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
    const searchState = await engine.executeRaw<{ matches: boolean; function_body: string }>(
      `SELECT p.search_vector @@ plainto_tsquery('english', 'zzLegacyMigrationTimeline135') AS matches,
              fn.prosrc AS function_body
         FROM pages p
         CROSS JOIN pg_proc fn
        WHERE p.slug = 'legacy-search-page'
          AND fn.proname = 'update_page_search_vector'`,
    );
    expect(searchState[0]?.matches).toBe(false);
    expect(searchState[0]?.function_body).not.toContain('NEW.timeline');

    await engine.setConfig('version', '134');
    const second = await runMigrations(engine);
    expect(second).toEqual({ applied: 1, current: 135 });
  }, 30_000);
});
