import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const MIGRATION_VERSION = 130;
const migration = MIGRATIONS.find(candidate => candidate.version === MIGRATION_VERSION);
const enrollmentMigration = MIGRATIONS.find(candidate => candidate.version === 132);
const schemas = [
  readFileSync(join(import.meta.dir, '../src/schema.sql'), 'utf8'),
  readFileSync(join(import.meta.dir, '../src/core/schema-embedded.ts'), 'utf8'),
  readFileSync(join(import.meta.dir, '../src/core/pglite-schema.ts'), 'utf8'),
];

describe('take_mining_work schema contract', () => {
  test('adds an empty current-work queue without backfilling pages', () => {
    expect(migration?.name).toBe('take_mining_work');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS take_mining_work');
    expect(migration?.sql).not.toMatch(/INSERT\s+INTO\s+take_mining_work/i);
    expect(migration?.sql).not.toMatch(/SELECT[\s\S]+FROM\s+pages/i);
  });

  test('stores one attributed admission per current page', () => {
    const sql = migration?.sql ?? '';
    expect(sql).toContain('PRIMARY KEY (source_id, page_slug)');
    expect(sql).toContain(
      'FOREIGN KEY (source_id, page_slug) REFERENCES pages(source_id, slug) ON DELETE CASCADE',
    );
    expect(sql).toContain("CHECK (admission IN ('immediate', 'deferred'))");
    expect(sql).toContain(
      "CHECK (write_intent IN ('user_edit', 'live_ingest', 'maintenance', 'backfill', 'derived'))",
    );
    for (const column of [
      'mining_input_hash',
      'actor',
      'batch_id',
      'reason',
      'priority',
      'created_at',
      'updated_at',
    ]) {
      expect(sql).toContain(column);
    }
  });

  test('ships matching fresh-install schemas and a narrow immediate-work index', () => {
    for (const schema of schemas) {
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS take_mining_work');
      expect(schema).toContain('PRIMARY KEY (source_id, page_slug)');
      expect(schema).toContain('take_mining_work_immediate_idx');
      expect(schema).toMatch(
        /CREATE TABLE IF NOT EXISTS take_mining_work[\s\S]*?write_intent\s+TEXT\s+(?!NOT NULL)CHECK/,
      );
    }
    expect(schemas[0]).toContain(
      'ALTER TABLE take_mining_work ENABLE ROW LEVEL SECURITY',
    );
  });

  test('makes write intent nullable only for explicit enrollment work', () => {
    expect(enrollmentMigration?.name).toBe('take_mining_work_explicit_enrollment');
    expect(enrollmentMigration?.sql).toContain(
      'ALTER COLUMN write_intent DROP NOT NULL',
    );
  });
});

describe('take_mining_work PGLite behavior', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('starts empty even when pages already exist', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES (
         'default', 'writing/preexisting', 'note', 'Preexisting',
         'This page predates explicit mining admission.'
       )`,
    );
    const rows = await engine.executeRaw<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM take_mining_work',
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  test('enforces current-work identity and cascades page deletion', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES (
         'default', 'writing/queued', 'note', 'Queued',
         'This page has explicitly admitted work.'
       )`,
    );
    await engine.executeRaw(`
      INSERT INTO take_mining_work (
        source_id, page_slug, mining_input_hash, admission,
        write_intent, actor, batch_id, reason
      ) VALUES (
        'default', 'writing/queued', 'hash-1', 'immediate',
        'user_edit', 'human:test', 'batch-1', 'test'
      )
    `);
    await expect(engine.executeRaw(`
      INSERT INTO take_mining_work (
        source_id, page_slug, mining_input_hash, admission,
        write_intent, actor
      ) VALUES (
        'default', 'writing/queued', 'hash-2', 'deferred',
        'maintenance', 'system:test'
      )
    `)).rejects.toThrow();

    await engine.executeRaw(
      `DELETE FROM pages WHERE source_id = 'default' AND slug = 'writing/queued'`,
    );
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM take_mining_work
        WHERE page_slug = 'writing/queued'`,
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  test('accepts a null write intent for operator-enrolled work', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES (
         'default', 'writing/enrolled', 'note', 'Enrolled',
         'This page was deliberately selected for historical mining.'
       )`,
    );
    await engine.executeRaw(`
      INSERT INTO take_mining_work (
        source_id, page_slug, mining_input_hash, admission,
        write_intent, actor, batch_id, reason
      ) VALUES (
        'default', 'writing/enrolled', 'hash-enrolled', 'deferred',
        NULL, 'cli:take-mining', 'history-1', 'historical_backfill'
      )
    `);

    const rows = await engine.executeRaw<{ write_intent: string | null }>(
      `SELECT write_intent
         FROM take_mining_work
        WHERE page_slug = 'writing/enrolled'`,
    );
    expect(rows).toEqual([{ write_intent: null }]);
  });
});
