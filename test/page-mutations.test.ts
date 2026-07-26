import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageWriteContext } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildTakeMiningInput } from '../src/core/cycle/take-mining-input.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const migration = MIGRATIONS.find(candidate => candidate.version === 131);
const schemas = [
  readFileSync(join(import.meta.dir, '../src/schema.sql'), 'utf8'),
  readFileSync(join(import.meta.dir, '../src/core/schema-embedded.ts'), 'utf8'),
  readFileSync(join(import.meta.dir, '../src/core/pglite-schema.ts'), 'utf8'),
];

const USER_EDIT: PageWriteContext = {
  actor: 'human:test',
  writeIntent: 'user_edit',
  batchId: 'batch-user',
  reason: 'test edit',
};

const DERIVED: PageWriteContext = {
  actor: 'cycle:test',
  writeIntent: 'derived',
  batchId: 'batch-cycle',
};

interface MutationRow {
  id: number;
  actor: string;
  write_intent: string;
  batch_id: string | null;
  reason: string | null;
  previous_mining_input_hash: string | null;
  new_mining_input_hash: string;
  semantic_changed: boolean;
}

interface WorkRow {
  mining_input_hash: string;
  admission: string;
  write_intent: string;
  actor: string;
  batch_id: string | null;
  reason: string | null;
  page_mutation_id: number;
}

describe('page mutation v131 schema', () => {
  test('adds an append-only mutation ledger and monotonic work revision', () => {
    const sql = migration?.sql ?? '';
    expect(migration?.name).toBe('page_mutations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS page_mutations');
    expect(sql).toContain('previous_mining_input_hash');
    expect(sql).toContain('new_mining_input_hash');
    expect(sql).toContain('semantic_changed');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS page_mutation_id BIGINT');
    expect(sql.split('ALTER TABLE take_mining_work')[0]).not.toMatch(
      /REFERENCES\s+pages/i,
    );
    expect(sql).toContain('ON UPDATE CASCADE');
    expect(sql).not.toMatch(/REFERENCES\s+sources/i);
  });

  test('ships the same ledger and work revision in every fresh schema', () => {
    for (const schema of schemas) {
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS page_mutations');
      expect(schema).toContain('page_mutation_id');
      expect(schema).toContain('page_mutations_page_idx');
      expect(schema).toContain('page_mutations_batch_idx');
    }
    expect(schemas[0]).toContain(
      'ALTER TABLE page_mutations ENABLE ROW LEVEL SECURITY',
    );
  });
});

describe('PGLite atomic page mutations', () => {
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

  async function mutations(slug: string): Promise<MutationRow[]> {
    return engine.executeRaw<MutationRow>(
      `SELECT id, actor, write_intent, batch_id, reason,
              previous_mining_input_hash, new_mining_input_hash,
              semantic_changed
         FROM page_mutations
        WHERE source_id = 'default' AND page_slug = $1
        ORDER BY id`,
      [slug],
    );
  }

  async function work(slug: string): Promise<WorkRow | undefined> {
    const rows = await engine.executeRaw<WorkRow>(
      `SELECT mining_input_hash, admission, write_intent, actor,
              batch_id, reason, page_mutation_id
         FROM take_mining_work
        WHERE source_id = 'default' AND page_slug = $1`,
      [slug],
    );
    return rows[0];
  }

  test('atomically records a semantic insert and immediate mining work', async () => {
    const body = 'Atlas launches in September.';
    await engine.putPage(
      'writing/atomic-insert',
      { type: 'note', title: 'Atomic insert', compiled_truth: body },
      { writeContext: USER_EDIT },
    );

    const expectedHash = buildTakeMiningInput(body).mining_input_hash;
    expect(await mutations('writing/atomic-insert')).toEqual([{
      id: 1,
      actor: 'human:test',
      write_intent: 'user_edit',
      batch_id: 'batch-user',
      reason: 'test edit',
      previous_mining_input_hash: null,
      new_mining_input_hash: expectedHash,
      semantic_changed: true,
    }]);
    expect(await work('writing/atomic-insert')).toEqual({
      mining_input_hash: expectedHash,
      admission: 'immediate',
      write_intent: 'user_edit',
      actor: 'human:test',
      batch_id: 'batch-user',
      reason: 'test edit',
      page_mutation_id: 1,
    });
  });

  test('records generated page receipts without creating undrainable mining work', async () => {
    const slug = 'extracts/take-mining-receipt';
    await engine.putPage(
      slug,
      {
        type: 'extract_receipt',
        title: 'Take mining receipt',
        compiled_truth: 'Generated audit receipt.',
        frontmatter: {
          type: 'extract_receipt',
          dream_generated: true,
        },
      },
      {
        writeContext: {
          actor: 'extract:takes',
          writeIntent: 'derived',
          batchId: 'run-1',
        },
      },
    );

    expect(await mutations(slug)).toHaveLength(1);
    expect(await work(slug)).toBeUndefined();
    expect((await engine.getPage(slug))?.compiled_truth).toBe('Generated audit receipt.');
  });

  test('records a canonical no-op without replacing pending work', async () => {
    await engine.putPage(
      'writing/link-repair',
      {
        type: 'note',
        title: 'Link repair',
        compiled_truth: 'Work with [[projects/atlas|Project Atlas]] continues.',
      },
      { writeContext: USER_EDIT },
    );
    const initialWork = await work('writing/link-repair');

    await engine.putPage(
      'writing/link-repair',
      {
        type: 'note',
        title: 'Link repair',
        compiled_truth: 'Work with [[initiatives/atlas|Project Atlas]] continues.',
      },
      {
        writeContext: {
          actor: 'maintenance:link-repair',
          writeIntent: 'maintenance',
          batchId: 'repair-1',
        },
      },
    );

    const rows = await mutations('writing/link-repair');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      actor: 'maintenance:link-repair',
      write_intent: 'maintenance',
      batch_id: 'repair-1',
      semantic_changed: false,
      previous_mining_input_hash: rows[0]!.new_mining_input_hash,
      new_mining_input_hash: rows[0]!.new_mining_input_hash,
    });
    expect(await work('writing/link-repair')).toEqual(initialWork);
  });

  test('uses monotonic mutation ids when semantic work changes A to B to A', async () => {
    const slug = 'writing/revision-order';
    await engine.putPage(
      slug,
      { type: 'note', title: 'Revision order', compiled_truth: 'Revision A.' },
      { writeContext: USER_EDIT },
    );
    await engine.putPage(
      slug,
      { type: 'note', title: 'Revision order', compiled_truth: 'Revision B.' },
      { writeContext: DERIVED },
    );
    await engine.putPage(
      slug,
      { type: 'note', title: 'Revision order', compiled_truth: 'Revision A.' },
      { writeContext: USER_EDIT },
    );

    const rows = await mutations(slug);
    expect(rows.map(row => row.id)).toEqual([1, 2, 3]);
    expect(rows[0]!.new_mining_input_hash).toBe(rows[2]!.new_mining_input_hash);
    expect(rows[1]!.new_mining_input_hash).not.toBe(rows[2]!.new_mining_input_hash);
    expect(await work(slug)).toMatchObject({
      mining_input_hash: rows[2]!.new_mining_input_hash,
      admission: 'immediate',
      page_mutation_id: 3,
    });
  });

  test('keeps the stored page, receipt, and work aligned under concurrent writes', async () => {
    const slug = 'writing/concurrent';
    await engine.putPage(
      slug,
      { type: 'note', title: 'Concurrent', compiled_truth: 'Initial.' },
      { writeContext: USER_EDIT },
    );

    await Promise.all([
      engine.putPage(
        slug,
        { type: 'note', title: 'Concurrent', compiled_truth: 'Concurrent B.' },
        { writeContext: DERIVED },
      ),
      engine.putPage(
        slug,
        { type: 'note', title: 'Concurrent', compiled_truth: 'Concurrent C.' },
        { writeContext: USER_EDIT },
      ),
    ]);

    const page = await engine.getPage(slug);
    const rows = await mutations(slug);
    const currentWork = await work(slug);
    const storedHash = buildTakeMiningInput(page!.compiled_truth).mining_input_hash;
    expect(rows).toHaveLength(3);
    expect(rows[2]!.new_mining_input_hash).toBe(storedHash);
    expect(currentWork?.mining_input_hash).toBe(storedHash);
    expect(currentWork?.page_mutation_id).toBe(rows[2]!.id);
  });

  test('uses a conservative attributed default and preserves ingestion provenance', async () => {
    const slug = 'writing/default-context';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Default context',
      compiled_truth: 'Original prose.',
      source_kind: 'capture-cli',
      source_uri: 'stdin',
      ingested_via: 'capture-cli',
    });
    await engine.putPage(slug, {
      type: 'note',
      title: 'Default context',
      compiled_truth: 'Changed prose.',
    });

    const rows = await mutations(slug);
    expect(rows.map(row => ({
      actor: row.actor,
      write_intent: row.write_intent,
      reason: row.reason,
    }))).toEqual([
      {
        actor: 'engine:unspecified',
        write_intent: 'maintenance',
        reason: 'missing_write_context',
      },
      {
        actor: 'engine:unspecified',
        write_intent: 'maintenance',
        reason: 'missing_write_context',
      },
    ]);
    expect(await work(slug)).toMatchObject({
      admission: 'deferred',
      actor: 'engine:unspecified',
      page_mutation_id: 2,
    });
    expect(await engine.getPage(slug)).toMatchObject({
      source_kind: 'capture-cli',
      source_uri: 'stdin',
      ingested_via: 'capture-cli',
    });
  });

  test('rolls back the page when mutation attribution is invalid', async () => {
    const invalidContext = {
      actor: 'test:invalid',
      writeIntent: 'spoofed',
    } as unknown as PageWriteContext;

    await expect(engine.putPage(
      'writing/rollback',
      { type: 'note', title: 'Rollback', compiled_truth: 'Must not persist.' },
      { writeContext: invalidContext },
    )).rejects.toThrow();

    expect(await engine.getPage('writing/rollback')).toBeNull();
    expect(await mutations('writing/rollback')).toEqual([]);
    expect(await work('writing/rollback')).toBeUndefined();
  });

  test('rolls back page and receipt when the current-work upsert fails', async () => {
    await engine.executeRaw(
      `ALTER TABLE take_mining_work
         ADD CONSTRAINT take_mining_work_test_actor_check
         CHECK (actor <> 'test:reject-work')`,
    );
    try {
      await expect(engine.putPage(
        'writing/work-rollback',
        { type: 'note', title: 'Work rollback', compiled_truth: 'Must roll back.' },
        {
          writeContext: {
            actor: 'test:reject-work',
            writeIntent: 'user_edit',
          },
        },
      )).rejects.toThrow();

      expect(await engine.getPage('writing/work-rollback')).toBeNull();
      expect(await mutations('writing/work-rollback')).toEqual([]);
      expect(await work('writing/work-rollback')).toBeUndefined();
    } finally {
      await engine.executeRaw(
        `ALTER TABLE take_mining_work
           DROP CONSTRAINT take_mining_work_test_actor_check`,
      );
    }
  });

  test('refreshPageBody records maintenance work atomically', async () => {
    const slug = 'writing/refresh';
    await engine.putPage(
      slug,
      { type: 'note', title: 'Refresh', compiled_truth: 'Before refresh.' },
      { writeContext: USER_EDIT },
    );

    await engine.refreshPageBody(
      slug,
      'default',
      'After refresh.',
      '',
      'content-hash-after-refresh',
      { writeContext: DERIVED },
    );

    const rows = await mutations(slug);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      actor: 'cycle:test',
      write_intent: 'derived',
      previous_mining_input_hash: rows[0]!.new_mining_input_hash,
      semantic_changed: true,
    });
    expect(await work(slug)).toMatchObject({
      admission: 'deferred',
      actor: 'cycle:test',
      page_mutation_id: rows[1]!.id,
    });
  });

  test('revertToVersion admits the restored semantic revision', async () => {
    const slug = 'writing/revert';
    await engine.putPage(
      slug,
      { type: 'note', title: 'Revert', compiled_truth: 'Version one.' },
      { writeContext: USER_EDIT },
    );
    const version = await engine.createVersion(slug, { sourceId: 'default' });
    await engine.putPage(
      slug,
      { type: 'note', title: 'Revert', compiled_truth: 'Version two.' },
      { writeContext: DERIVED },
    );

    await engine.revertToVersion(slug, version.id, {
      sourceId: 'default',
      writeContext: USER_EDIT,
    });

    const rows = await mutations(slug);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.new_mining_input_hash).toBe(rows[0]!.new_mining_input_hash);
    expect(await work(slug)).toMatchObject({
      admission: 'immediate',
      write_intent: 'user_edit',
      page_mutation_id: rows[2]!.id,
    });
  });

  test('keeps append-only mutation receipts after page deletion', async () => {
    const slug = 'writing/deleted-audit';
    await engine.putPage(
      slug,
      { type: 'note', title: 'Deleted audit', compiled_truth: 'Audited prose.' },
      { writeContext: USER_EDIT },
    );

    await engine.deletePage(slug, { sourceId: 'default' });

    expect(await mutations(slug)).toHaveLength(1);
    expect(await work(slug)).toBeUndefined();
  });
});
