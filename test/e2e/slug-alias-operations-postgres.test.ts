import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  addSlugAlias,
  removeSlugAlias,
} from '../../src/core/slug-alias.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('slug-alias transactional parity on PostgreSQL', () => {
  let engine: BrainEngine;

  beforeAll(async () => {
    engine = await setupDB();
    await engine.executeRaw(`DELETE FROM slug_aliases`);
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('alias-pg', 'alias-pg') ON CONFLICT (id) DO NOTHING`,
    );
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  test('add, replacement, resolver, and idempotent removal match PGLite', async () => {
    for (const slug of ['old', 'canonical-a', 'canonical-b']) {
      await engine.putPage(slug, {
        type: 'note', title: slug, compiled_truth: `# ${slug}`, timeline: '',
      }, { sourceId: 'alias-pg' });
    }
    await engine.executeRaw(
      `INSERT INTO facts (
         source_id, entity_slug, fact, kind, valid_from, source,
         source_markdown_slug, row_num
       ) VALUES (
         'alias-pg', 'old', 'Old fact', 'fact', '2020-01-01'::date,
         'manual', 'old', 1
       )`,
    );
    const added = await addSlugAlias(engine, {
      sourceId: 'alias-pg',
      aliasSlug: 'old',
      canonicalSlug: 'canonical-a',
      softDeleteOld: true,
    });
    expect(added.status).toBe('added');
    expect(added.facts_migrated).toBe(1);
    expect(await engine.resolveSlugWithAlias('old', 'alias-pg')).toBe('canonical-a');
    const facts = await engine.executeRaw<{
      entity_slug: string;
      source_markdown_slug: string;
    }>(
      `SELECT entity_slug, source_markdown_slug
         FROM facts WHERE source_id = 'alias-pg' AND fact = 'Old fact'`,
    );
    expect(facts[0]).toEqual({
      entity_slug: 'canonical-a',
      source_markdown_slug: 'canonical-a',
    });

    await expect(addSlugAlias(engine, {
      sourceId: 'alias-pg', aliasSlug: 'old', canonicalSlug: 'canonical-b',
    })).rejects.toMatchObject({ code: 'alias_replacement_required' });
    const replaced = await addSlugAlias(engine, {
      sourceId: 'alias-pg',
      aliasSlug: 'old',
      canonicalSlug: 'canonical-b',
      replace: true,
    });
    expect(replaced.status).toBe('replaced');
    expect(await engine.resolveSlugWithAlias('old', 'alias-pg')).toBe('canonical-b');
    expect((await removeSlugAlias(engine, 'alias-pg', 'old')).status).toBe('removed');
    expect((await removeSlugAlias(engine, 'alias-pg', 'old')).status).toBe('not_found');
  });

  test('rolls back the soft-delete when a later alias write fails', async () => {
    await engine.putPage('rollback-old', {
      type: 'note', title: 'rollback-old', compiled_truth: '# old', timeline: '',
    }, { sourceId: 'alias-pg' });
    await engine.putPage('rollback-canonical', {
      type: 'note', title: 'rollback-canonical', compiled_truth: '# canonical', timeline: '',
    }, { sourceId: 'alias-pg' });

    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
      originalTransaction(async (tx) => {
        const originalExecuteRaw = tx.executeRaw.bind(tx);
        tx.executeRaw = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          if (/INSERT INTO slug_aliases/.test(sql)) throw new Error('forced postgres insert failure');
          return originalExecuteRaw<R>(sql, params);
        };
        return fn(tx);
      });
    try {
      await expect(addSlugAlias(engine, {
        sourceId: 'alias-pg',
        aliasSlug: 'rollback-old',
        canonicalSlug: 'rollback-canonical',
        softDeleteOld: true,
      })).rejects.toThrow('forced postgres insert failure');
    } finally {
      engine.transaction = originalTransaction;
    }

    const old = await engine.getPage('rollback-old', { sourceId: 'alias-pg' });
    expect(old?.deleted_at).toBeNull();
    expect(await engine.resolveSlugWithAlias('rollback-old', 'alias-pg')).toBe('rollback-old');
  });
});
