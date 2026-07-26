import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import type { OperationContext } from '../../src/core/operations.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const skip = !hasDatabase();

if (skip) test.skip('rename_page Postgres parity skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('rename_page Postgres parity', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  });

  function ctx(): OperationContext {
    return {
      engine,
      config: { engine: 'postgres' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
  }

  test('commits destination and alias together', async () => {
    await engine.putPage('people/parity-old', {
      type: 'person',
      title: 'Parity Old',
      compiled_truth: 'Parity Old is an engineer.',
      timeline: '',
      frontmatter: {},
    });

    const result = await operationsByName.rename_page.handler(ctx(), {
      old_slug: 'people/parity-old',
      new_slug: 'people/parity-new',
      content: '---\ntitle: Parity New\n---\n\nParity New is an engineer.\n',
    });

    expect(result).toMatchObject({
      status: 'renamed',
      source_id: 'default',
      old_page_soft_deleted: true,
    });
    expect(await engine.getPage('people/parity-new'))
      .toMatchObject({ title: 'Parity New' });
    expect(await engine.resolveSlugWithAlias('people/parity-old', 'default'))
      .toBe('people/parity-new');
  });

  test('rolls back a destination created before alias failure', async () => {
    await engine.putPage('people/rollback-old', {
      type: 'person',
      title: 'Rollback Old',
      compiled_truth: 'Rollback Old is an engineer.',
      timeline: '',
      frontmatter: {},
    });
    const originalMigrateFacts = engine.migrateFactsToCanonical;
    engine.migrateFactsToCanonical = async () => {
      throw new Error('postgres injected alias failure');
    };

    try {
      await expect(operationsByName.rename_page.handler(ctx(), {
        old_slug: 'people/rollback-old',
        new_slug: 'people/rollback-new',
        content: '---\ntitle: Rollback New\n---\n\nRollback New is an engineer.\n',
      })).rejects.toThrow('postgres injected alias failure');
    } finally {
      engine.migrateFactsToCanonical = originalMigrateFacts;
    }

    expect(await engine.getPage('people/rollback-old'))
      .toMatchObject({ title: 'Rollback Old', deleted_at: null });
    expect(await engine.getPage('people/rollback-new')).toBeNull();
  });
});
