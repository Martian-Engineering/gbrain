import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  addSlugAlias,
  removeSlugAlias,
  SlugAliasError,
} from '../src/core/slug-alias.ts';
import { readRecentSlugAliasAudit } from '../src/core/audit/slug-alias-audit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

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

function page(slug: string, sourcePath: string | null = null) {
  return {
    type: 'note' as const,
    title: slug,
    compiled_truth: `# ${slug}`,
    timeline: '',
    frontmatter: {},
    source_path: sourcePath,
  };
}

async function seedPage(slug: string, sourceId = 'default', sourcePath: string | null = null) {
  await engine.putPage(slug, page(slug, sourcePath), { sourceId });
}

function ctx(
  sourceId = 'default',
  remote = false,
  auth?: OperationContext['auth'],
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
    sourceId,
    auth,
  };
}

async function withAuditDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-audit-'));
  try {
    return await withEnv({ GBRAIN_AUDIT_DIR: dir }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('slug-alias operation registration', () => {
  test('alias operations are remote-capable with their expected scopes', () => {
    for (const name of ['add_slug_alias', 'remove_slug_alias']) {
      const op = operationsByName[name];
      expect(op).toBeDefined();
      expect(op.scope).toBe('write');
      expect(op.localOnly).not.toBe(true);
    }
    expect(operationsByName.add_slug_alias.params).toHaveProperty('soft_delete_old');
    expect(operationsByName.add_slug_alias.params).toHaveProperty('remove_file');
    expect(operationsByName.add_slug_alias.params).toHaveProperty('replace');
    expect(operationsByName.add_slug_alias.params).toHaveProperty('notes');
    expect(operationsByName.list_slug_aliases).toBeDefined();
    expect(operationsByName.list_slug_aliases.scope).toBe('read');
    expect(operationsByName.list_slug_aliases.localOnly).not.toBe(true);
  });
});

describe('addSlugAlias on PGLite', () => {
  test('requires an active canonical page', async () => {
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'missing',
    })).rejects.toMatchObject({
      code: 'canonical_not_found',
      message: "Canonical page 'missing' does not exist or is soft-deleted in source 'default'.",
    });

    await seedPage('canonical');
    await engine.softDeletePage('canonical', { sourceId: 'default' });
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    })).rejects.toMatchObject({
      code: 'canonical_not_found',
      message: "Canonical page 'canonical' does not exist or is soft-deleted in source 'default'.",
    });
  });

  test('reports when the requested canonical slug is itself an alias', async () => {
    await seedPage('canonical');
    await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'canonical-alias',
      canonicalSlug: 'canonical',
    });

    await expect(addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical-alias',
    })).rejects.toMatchObject({
      code: 'canonical_is_alias',
      message: "'canonical-alias' is an alias of 'canonical' — alias to 'canonical' instead.",
    });

    await withAuditDir(async () => {
      await expect(operationsByName.add_slug_alias.handler(ctx(), {
        alias_slug: 'old',
        canonical_slug: 'canonical-alias',
      })).rejects.toMatchObject({
        code: 'canonical_is_alias',
        message: "'canonical-alias' is an alias of 'canonical' — alias to 'canonical' instead.",
      });
    });
  });

  test('rejects self aliases', async () => {
    await seedPage('same');
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'same', canonicalSlug: 'same',
    })).rejects.toMatchObject({ code: 'self_alias' });
  });

  test('rejects an active alias page without explicit soft-delete', async () => {
    await seedPage('old');
    await seedPage('canonical');
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    })).rejects.toMatchObject({ code: 'alias_page_collision' });
    expect((await engine.getPage('old', { sourceId: 'default' }))?.deleted_at).toBeNull();
  });

  test('soft-deletes the old page and inserts the alias in one transaction', async () => {
    await seedPage('old');
    await seedPage('canonical');
    await engine.executeRaw(
      `INSERT INTO facts (
         source_id, entity_slug, fact, kind, valid_from, source,
         source_markdown_slug, row_num
       ) VALUES (
         'default', 'old', 'Old fact', 'fact', '2020-01-01'::date,
         'manual', 'old', 1
       )`,
    );
    const result = await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical',
      softDeleteOld: true,
    });
    expect(result.status).toBe('added');
    expect(result.soft_deleted_old).toBe(true);
    expect(result.facts_migrated).toBe(1);
    expect(await engine.getPage('old', { sourceId: 'default' })).toBeNull();
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('canonical');
    const facts = await engine.executeRaw<{
      entity_slug: string;
      source_markdown_slug: string;
    }>(
      `SELECT entity_slug, source_markdown_slug
         FROM facts WHERE source_id = 'default' AND fact = 'Old fact'`,
    );
    expect(facts[0]).toEqual({
      entity_slug: 'canonical',
      source_markdown_slug: 'canonical',
    });
  });

  test('identical mapping is idempotent success', async () => {
    await seedPage('canonical');
    const first = await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    });
    const second = await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    });
    expect(first.status).toBe('added');
    expect(first.facts_migrated).toBe(0);
    expect(second.status).toBe('unchanged');
    expect(second.facts_migrated).toBe(0);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM slug_aliases WHERE source_id = 'default' AND alias_slug = 'old'`,
    );
    expect(rows[0].n).toBe(1);
  });

  test('an active page still requires explicit soft-delete for an identical mapping', async () => {
    await seedPage('canonical');
    await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    });
    await seedPage('old');
    await engine.executeRaw(
      `INSERT INTO facts (
         source_id, entity_slug, fact, kind, valid_from, source,
         source_markdown_slug, row_num
       ) VALUES (
         'default', 'old', 'Identical fact', 'fact', '2020-01-01'::date,
         'manual', 'old', 1
       )`,
    );
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    })).rejects.toMatchObject({ code: 'alias_page_collision' });

    const result = await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical',
      softDeleteOld: true,
    });
    expect(result).toMatchObject({
      status: 'unchanged',
      soft_deleted_old: true,
      facts_migrated: 1,
    });
    expect(await engine.getPage('old', { sourceId: 'default' })).toBeNull();
    const facts = await engine.executeRaw<{
      entity_slug: string;
      source_markdown_slug: string;
    }>(
      `SELECT entity_slug, source_markdown_slug
         FROM facts WHERE source_id = 'default' AND fact = 'Identical fact'`,
    );
    expect(facts[0]).toEqual({
      entity_slug: 'canonical',
      source_markdown_slug: 'canonical',
    });
  });

  test('replacement is gated and explicit replacement changes the resolver', async () => {
    await seedPage('canonical-a');
    await seedPage('canonical-b');
    const added = await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical-a',
      notes: 'initial provenance',
    });
    expect(added.notes).toBe('initial provenance');
    await expect(addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical-b',
    })).rejects.toMatchObject({ code: 'alias_replacement_required' });
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('canonical-a');

    const replaced = await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical-b',
      replace: true,
      notes: 'replacement provenance',
    });
    expect(replaced.status).toBe('replaced');
    expect(replaced.notes).toBe('replacement provenance');
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('canonical-b');
    const rows = await engine.executeRaw<{ notes: string | null }>(
      `SELECT notes FROM slug_aliases
        WHERE source_id = 'default' AND alias_slug = 'old'`,
    );
    expect(rows[0]?.notes).toBe('replacement provenance');
  });

  test('rejects a multi-hop cycle', async () => {
    await seedPage('page-b');
    await seedPage('page-c');
    await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'page-a', canonicalSlug: 'page-b',
    });
    await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'page-b',
      canonicalSlug: 'page-c',
      softDeleteOld: true,
    });
    // Make page-a an active canonical candidate after its alias row exists.
    await seedPage('page-a');
    await expect(addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'page-c',
      canonicalSlug: 'page-a',
      softDeleteOld: true,
    })).rejects.toMatchObject({ code: 'alias_cycle' });
    expect((await engine.getPage('page-c', { sourceId: 'default' }))?.deleted_at).toBeNull();
  });

  test('rolls back old-page soft-delete when the alias insert fails', async () => {
    await seedPage('old');
    await seedPage('canonical');
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
      originalTransaction(async (tx) => {
        const originalExecuteRaw = tx.executeRaw.bind(tx);
        tx.executeRaw = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          if (/INSERT INTO slug_aliases/.test(sql)) throw new Error('forced alias insert failure');
          return originalExecuteRaw<R>(sql, params);
        };
        return fn(tx);
      });
    try {
      await expect(addSlugAlias(engine, {
        sourceId: 'default',
        aliasSlug: 'old',
        canonicalSlug: 'canonical',
        softDeleteOld: true,
      })).rejects.toThrow('forced alias insert failure');
    } finally {
      engine.transaction = originalTransaction;
    }
    expect((await engine.getPage('old', { sourceId: 'default' }))?.deleted_at).toBeNull();
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('old');
  });

  test('rolls back old-page soft-delete when an alias replacement fails', async () => {
    await seedPage('canonical-a');
    await seedPage('canonical-b');
    await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical-a',
    });
    await seedPage('old');

    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
      originalTransaction(async (tx) => {
        const originalExecuteRaw = tx.executeRaw.bind(tx);
        tx.executeRaw = async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          if (/UPDATE slug_aliases/.test(sql)) throw new Error('forced alias update failure');
          return originalExecuteRaw<R>(sql, params);
        };
        return fn(tx);
      });
    try {
      await expect(addSlugAlias(engine, {
        sourceId: 'default',
        aliasSlug: 'old',
        canonicalSlug: 'canonical-b',
        softDeleteOld: true,
        replace: true,
      })).rejects.toThrow('forced alias update failure');
    } finally {
      engine.transaction = originalTransaction;
    }
    expect((await engine.getPage('old', { sourceId: 'default' }))?.deleted_at).toBeNull();
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('canonical-a');
  });
});

describe('source isolation and removal', () => {
  beforeEach(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT (id) DO NOTHING`,
    );
    await seedPage('canonical', 'default');
    await seedPage('canonical', 'other');
  });

  test('same alias is isolated by source', async () => {
    await addSlugAlias(engine, {
      sourceId: 'default', aliasSlug: 'old', canonicalSlug: 'canonical',
    });
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('canonical');
    expect(await engine.resolveSlugWithAlias('old', 'other')).toBe('old');
  });

  test('remove is source-scoped, idempotent, and never restores a page', async () => {
    await seedPage('old', 'default');
    await addSlugAlias(engine, {
      sourceId: 'default',
      aliasSlug: 'old',
      canonicalSlug: 'canonical',
      softDeleteOld: true,
    });
    await addSlugAlias(engine, {
      sourceId: 'other', aliasSlug: 'old', canonicalSlug: 'canonical',
    });

    expect((await removeSlugAlias(engine, 'default', 'old')).status).toBe('removed');
    expect((await removeSlugAlias(engine, 'default', 'old')).status).toBe('not_found');
    expect(await engine.resolveSlugWithAlias('old', 'default')).toBe('old');
    expect(await engine.resolveSlugWithAlias('old', 'other')).toBe('canonical');
    const deleted = await engine.getPage('old', { sourceId: 'default', includeDeleted: true });
    expect(deleted?.deleted_at).not.toBeNull();
  });
});

describe('list_slug_aliases read operation', () => {
  beforeEach(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name)
       VALUES ('other', 'other') ON CONFLICT (id) DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO slug_aliases (
         source_id, alias_slug, canonical_slug, notes
       ) VALUES
         ('default', 'old-a', 'canonical-a', 'default a'),
         ('default', 'old-b', 'canonical-b', 'default b'),
         ('other', 'old-a', 'canonical-a', 'other a')`,
    );
  });

  test('filters aliases within a scalar source scope', async () => {
    const byCanonical = await operationsByName.list_slug_aliases.handler(ctx(), {
      canonical_slug: 'canonical-a',
    }) as {
      schema_version: number;
      count: number;
      aliases: Array<Record<string, unknown>>;
    };
    expect(byCanonical.schema_version).toBe(1);
    expect(byCanonical.count).toBe(1);
    expect(byCanonical.aliases[0]).toMatchObject({
      alias_slug: 'old-a',
      canonical_slug: 'canonical-a',
      notes: 'default a',
      source_id: 'default',
    });
    expect(byCanonical.aliases[0]?.created_at).toBeDefined();

    const byAlias = await operationsByName.list_slug_aliases.handler(ctx(), {
      alias_slug: 'old-b',
      limit: 0,
    }) as { count: number; aliases: Array<{ alias_slug: string }> };
    expect(byAlias.count).toBe(1);
    expect(byAlias.aliases[0]?.alias_slug).toBe('old-b');
  });

  test('supports federated and trusted-local unscoped reads', async () => {
    const auth = {
      token: 't',
      clientId: 'client',
      scopes: ['read'],
      sourceId: 'default',
      allowedSources: ['default', 'other'],
    };
    const federated = await operationsByName.list_slug_aliases.handler(
      ctx('default', true, auth),
      { alias_slug: 'old-a' },
    ) as { count: number; aliases: Array<{ source_id: string }> };
    expect(federated.count).toBe(2);
    expect(federated.aliases.map((row) => row.source_id)).toEqual(['default', 'other']);

    const localUnscoped = await operationsByName.list_slug_aliases.handler(
      { ...ctx(), sourceId: '' },
      { limit: 2 },
    ) as { count: number };
    expect(localUnscoped.count).toBe(2);
  });

  test('fails soft when slug_aliases is unavailable on a pre-migration brain', async () => {
    const originalExecuteRaw = engine.executeRaw;
    engine.executeRaw = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (/FROM slug_aliases/.test(sql)) {
        throw Object.assign(new Error('relation "slug_aliases" does not exist'), {
          code: '42P01',
        });
      }
      return originalExecuteRaw.call(engine, sql, params) as Promise<T[]>;
    };
    try {
      await expect(operationsByName.list_slug_aliases.handler(ctx(), {})).resolves.toEqual({
        schema_version: 1,
        count: 0,
        aliases: [],
      });
    } finally {
      engine.executeRaw = originalExecuteRaw;
    }
  });
});

describe('operation auth, cache, audit, and synced-file warning', () => {
  test('remote caller inherits OAuth write source and cannot override it', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('oauth-src', 'oauth-src'), ('other', 'other') ON CONFLICT (id) DO NOTHING`,
    );
    await seedPage('canonical', 'oauth-src');
    const auth = {
      token: 't', clientId: 'client-123456789', scopes: ['write'], sourceId: 'oauth-src',
      allowedSources: ['oauth-src', 'other'],
    };

    await withAuditDir(async () => {
      await expect(operationsByName.add_slug_alias.handler(
        ctx('oauth-src', true, auth),
        { alias_slug: 'old', canonical_slug: 'canonical', source_id: 'other' },
      )).rejects.toMatchObject({ code: 'permission_denied' });

      const result = await operationsByName.add_slug_alias.handler(
        ctx('oauth-src', true, auth),
        { alias_slug: 'old', canonical_slug: 'canonical' },
      ) as { source_id: string; status: string };
      expect(result).toMatchObject({ source_id: 'oauth-src', status: 'added' });
    });
    expect(await engine.resolveSlugWithAlias('old', 'oauth-src')).toBe('canonical');
    expect(await engine.resolveSlugWithAlias('old', 'other')).toBe('old');
  });

  test('remote authenticated context fails closed when OAuth has no write source', async () => {
    const auth = { token: 't', clientId: 'client', scopes: ['write'] };
    await withAuditDir(async () => {
      await expect(operationsByName.remove_slug_alias.handler(
        ctx('default', true, auth),
        { alias_slug: 'old' },
      )).rejects.toMatchObject({ code: 'permission_denied' });
    });
  });

  test('remote callers cannot remove host source files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-remote-source-'));
    const sourceFile = join(repo, 'old.md');
    try {
      writeFileSync(sourceFile, '# old\n');
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [repo],
      );
      await seedPage('old', 'default', 'old.md');
      await seedPage('canonical');
      const auth = {
        token: 't',
        clientId: 'client',
        scopes: ['write'],
        sourceId: 'default',
      };

      await withAuditDir(async () => {
        await expect(operationsByName.add_slug_alias.handler(
          ctx('default', true, auth),
          {
            alias_slug: 'old',
            canonical_slug: 'canonical',
            soft_delete_old: true,
            remove_file: true,
          },
        )).rejects.toMatchObject({ code: 'permission_denied' });
      });
      expect(readFileSync(sourceFile, 'utf8')).toBe('# old\n');
      expect((await engine.getPage('old', { sourceId: 'default' }))?.deleted_at).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('invalidates only the affected source query cache after a real change', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT (id) DO NOTHING`,
    );
    await seedPage('canonical');
    for (const sourceId of ['default', 'other']) {
      await engine.executeRaw(
        `INSERT INTO query_cache
          (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, created_at)
         VALUES ($1, 'q', $2, 'test', NULL, '[]'::jsonb, '{}'::jsonb, 3600, now())`,
        [`cache-${sourceId}`, sourceId],
      );
    }

    await withAuditDir(async () => {
      const result = await operationsByName.add_slug_alias.handler(ctx(), {
        alias_slug: 'old', canonical_slug: 'canonical',
      }) as { cache_rows_invalidated: number };
      expect(result.cache_rows_invalidated).toBe(1);
      const unchanged = await operationsByName.add_slug_alias.handler(ctx(), {
        alias_slug: 'old', canonical_slug: 'canonical',
      }) as { cache_rows_invalidated: number };
      expect(unchanged.cache_rows_invalidated).toBe(0);
    });
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM query_cache ORDER BY source_id`,
    );
    expect(rows.map((row) => row.source_id)).toEqual(['other']);
  });

  test('emits an audit record and warns when sync can recreate the old page', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-source-'));
    const audit = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-audit-'));
    try {
      mkdirSync(join(repo, 'notes'), { recursive: true });
      writeFileSync(join(repo, 'notes', 'old.md'), '# old\n');
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [repo],
      );
      await seedPage('notes/old', 'default', 'notes/old.md');
      await seedPage('notes/canonical');

      await withEnv({ GBRAIN_AUDIT_DIR: audit }, async () => {
        const result = await operationsByName.add_slug_alias.handler(ctx(), {
          alias_slug: 'notes/old',
          canonical_slug: 'notes/canonical',
          soft_delete_old: true,
          notes: 'merged duplicate note',
        }) as { facts_migrated: number; file_removed: boolean; warnings: string[] };
        expect(result.facts_migrated).toBe(0);
        expect(result.file_removed).toBe(false);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('future sync can recreate');
        expect(result.warnings[0]).toContain('Git was not modified');
        expect(readFileSync(join(repo, 'notes', 'old.md'), 'utf8')).toBe('# old\n');

        const events = readRecentSlugAliasAudit();
        expect(events.at(-1)).toMatchObject({
          op: 'add_slug_alias',
          actor: 'cli',
          source_id: 'default',
          alias_slug: 'notes/old',
          canonical_slug: 'notes/canonical',
          notes: 'merged duplicate note',
          outcome: 'added',
        });
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(audit, { recursive: true, force: true });
    }
  });

  test('removes a confined source file when explicitly requested', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-remove-source-'));
    try {
      mkdirSync(join(repo, 'notes'), { recursive: true });
      const sourceFile = join(repo, 'notes', 'old.md');
      writeFileSync(sourceFile, '# old\n');
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [repo],
      );
      await seedPage('notes/old', 'default', 'notes/old.md');
      await seedPage('notes/canonical');

      await withAuditDir(async () => {
        const result = await operationsByName.add_slug_alias.handler(ctx(), {
          alias_slug: 'notes/old',
          canonical_slug: 'notes/canonical',
          soft_delete_old: true,
          remove_file: true,
        }) as {
          file_removed: boolean;
          file_remove_error?: string;
          warnings: string[];
        };
        expect(result.file_removed).toBe(true);
        expect(result.file_remove_error).toBeUndefined();
        expect(result.warnings).toEqual([]);
        expect(existsSync(sourceFile)).toBe(false);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('refuses to remove a source path that escapes the source root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-escape-source-'));
    const repo = join(parent, 'repo');
    const outsideFile = join(parent, 'outside.md');
    try {
      mkdirSync(repo);
      writeFileSync(outsideFile, '# outside\n');
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [repo],
      );
      await seedPage('old', 'default', '../outside.md');
      await seedPage('canonical');

      await withAuditDir(async () => {
        const result = await operationsByName.add_slug_alias.handler(ctx(), {
          alias_slug: 'old',
          canonical_slug: 'canonical',
          soft_delete_old: true,
          remove_file: true,
        }) as {
          file_removed: boolean;
          file_remove_error?: string;
        };
        expect(result.file_removed).toBe(false);
        expect(result.file_remove_error).toContain('escapes');
        expect(readFileSync(outsideFile, 'utf8')).toBe('# outside\n');
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('synced-file warning honors the legacy default-source repo path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-slug-alias-legacy-source-'));
    try {
      writeFileSync(join(repo, 'old.md'), '# old\n');
      await engine.setConfig('sync.repo_path', repo);
      await seedPage('old', 'default', 'old.md');
      await seedPage('canonical');
      await withAuditDir(async () => {
        const result = await operationsByName.add_slug_alias.handler(ctx(), {
          alias_slug: 'old',
          canonical_slug: 'canonical',
          soft_delete_old: true,
        }) as { warnings: string[] };
        expect(result.warnings[0]).toContain('future sync can recreate');
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('remove operation is idempotent and reports that no page was restored', async () => {
    await withAuditDir(async () => {
      const result = await operationsByName.remove_slug_alias.handler(ctx(), {
        alias_slug: 'not-registered',
      }) as { status: string; page_restored: boolean; cache_rows_invalidated: number };
      expect(result).toEqual(expect.objectContaining({
        status: 'not_found',
        page_restored: false,
        cache_rows_invalidated: 0,
      }));
    });
  });
});

test('SlugAliasError remains a tagged domain error', () => {
  const error = new SlugAliasError('self_alias', 'x');
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('self_alias');
  expect(new OperationError('permission_denied', 'x').code).toBe('permission_denied');
});
