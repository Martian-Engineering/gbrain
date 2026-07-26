import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const MIGRATION_VERSION = 129;
const migration = MIGRATIONS.find(candidate => candidate.version === MIGRATION_VERSION);
const postgresSchema = readFileSync(
  join(import.meta.dir, '../src/schema.sql'),
  'utf8',
);
const pgliteSchema = readFileSync(
  join(import.meta.dir, '../src/core/pglite-schema.ts'),
  'utf8',
);
const embeddedPostgresSchema = readFileSync(
  join(import.meta.dir, '../src/core/schema-embedded.ts'),
  'utf8',
);

describe('take_proposal_scans schema contract', () => {
  test('uses the next migration version and preserves proposal uniqueness', () => {
    expect(migration?.name).toBe('take_proposal_scans');
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS take_proposal_scans');
    expect(migration?.sql).not.toContain('DROP INDEX');
    expect(migration?.sql).not.toContain('take_proposals_idempotency_idx');
  });

  test('defines the identity, lease, completion, and audit contract', () => {
    const sql = migration?.sql ?? '';

    expect(sql).toContain(
      'PRIMARY KEY (source_id, page_slug, mining_input_hash, prompt_version)',
    );
    expect(sql).toMatch(
      /source_id\s+TEXT\s+NOT NULL REFERENCES sources\(id\) ON DELETE CASCADE/,
    );
    expect(sql).toContain("CHECK (status IN ('in_progress', 'succeeded'))");
    expect(sql).toContain('attempt_id');
    expect(sql).toContain('lease_expires_at');
    expect(sql).toContain('proposal_run_id');
    expect(sql).toContain('model_id');
    expect(sql).toContain('proposal_count');
    expect(sql).toContain('completed_at');
    expect(sql).toContain('created_at');
    expect(sql).toContain('updated_at');
    expect(sql).toContain('proposal_count >= 0');
  });

  test('ships the table in both fresh-install schemas and enables PostgreSQL RLS', () => {
    for (const schema of [postgresSchema, embeddedPostgresSchema, pgliteSchema]) {
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS take_proposal_scans');
      expect(schema).toContain(
        'PRIMARY KEY (source_id, page_slug, mining_input_hash, prompt_version)',
      );
    }
    expect(postgresSchema).toContain(
      'ALTER TABLE take_proposal_scans ENABLE ROW LEVEL SECURITY',
    );
  });
});

describe('take_proposal_scans PGLite constraints', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('persists an in-flight lease and enforces one owner per semantic input', async () => {
    await engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, lease_expires_at, proposal_run_id, model_id
      ) VALUES (
        'default', 'writing/example', 'semantic-hash', 'prompt-v1',
        'in_progress', 'attempt-1', now() + interval '5 minutes', 'run-1', 'model-1'
      )
    `);

    await expect(engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, lease_expires_at, proposal_run_id, model_id
      ) VALUES (
        'default', 'writing/example', 'semantic-hash', 'prompt-v1',
        'in_progress', 'attempt-2', now() + interval '5 minutes', 'run-2', 'model-1'
      )
    `)).rejects.toThrow();
  });

  test('accepts successful zero-proposal completion', async () => {
    await engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, proposal_run_id, model_id,
        proposal_count, completed_at
      ) VALUES (
        'default', 'writing/empty-result', 'empty-hash', 'prompt-v1',
        'succeeded', 'attempt-empty', 'run-empty', 'model-1',
        0, now()
      )
    `);

    const rows = await engine.executeRaw<{
      status: string;
      proposal_count: number;
    }>(`
      SELECT status, proposal_count
        FROM take_proposal_scans
       WHERE page_slug = 'writing/empty-result'
    `);
    expect(rows).toEqual([{ status: 'succeeded', proposal_count: 0 }]);
  });

  test('rejects impossible claim and completion states', async () => {
    await expect(engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, proposal_run_id, model_id,
        proposal_count, completed_at
      ) VALUES (
        'default', 'writing/bad-running', 'bad-running-hash', 'prompt-v1',
        'in_progress', 'attempt-bad', 'run-bad', 'model-1',
        1, now()
      )
    `)).rejects.toThrow();

    await expect(engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, proposal_run_id, model_id,
        proposal_count, completed_at
      ) VALUES (
        'default', 'writing/bad-count', 'bad-count-hash', 'prompt-v1',
        'succeeded', 'attempt-bad-count', 'run-bad', 'model-1',
        -1, now()
      )
    `)).rejects.toThrow();
  });

  test('permits failure cleanup and a later retry without fake success', async () => {
    await engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, lease_expires_at, proposal_run_id, model_id
      ) VALUES (
        'default', 'writing/retry', 'retry-hash', 'prompt-v1',
        'in_progress', 'attempt-failed', now() + interval '5 minutes', 'run-failed', 'model-1'
      )
    `);
    await engine.executeRaw(`
      DELETE FROM take_proposal_scans
       WHERE source_id = 'default'
         AND page_slug = 'writing/retry'
         AND mining_input_hash = 'retry-hash'
         AND prompt_version = 'prompt-v1'
         AND attempt_id = 'attempt-failed'
    `);
    await engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, lease_expires_at, proposal_run_id, model_id
      ) VALUES (
        'default', 'writing/retry', 'retry-hash', 'prompt-v1',
        'in_progress', 'attempt-retry', now() + interval '5 minutes', 'run-retry', 'model-1'
      )
    `);

    const rows = await engine.executeRaw<{ attempt_id: string; status: string }>(`
      SELECT attempt_id, status
        FROM take_proposal_scans
       WHERE page_slug = 'writing/retry'
    `);
    expect(rows).toEqual([{ attempt_id: 'attempt-retry', status: 'in_progress' }]);
  });

  test('cascades scan rows when their source is deleted', async () => {
    await engine.executeRaw(`
      INSERT INTO sources (id, name, config)
      VALUES ('scan-source', 'Scan source', '{}')
    `);
    await engine.executeRaw(`
      INSERT INTO take_proposal_scans (
        source_id, page_slug, mining_input_hash, prompt_version,
        status, attempt_id, lease_expires_at, proposal_run_id, model_id
      ) VALUES (
        'scan-source', 'writing/cascade', 'cascade-hash', 'prompt-v1',
        'in_progress', 'attempt-cascade', now() + interval '5 minutes', 'run-cascade', 'model-1'
      )
    `);
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'scan-source'`);

    const rows = await engine.executeRaw<{ count: number }>(`
      SELECT COUNT(*)::int AS count
        FROM take_proposal_scans
       WHERE source_id = 'scan-source'
    `);
    expect(rows[0]?.count).toBe(0);
  });
});
