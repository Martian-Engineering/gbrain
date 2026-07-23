import type { BrainEngine } from './engine.ts';
import { existsSync, unlinkSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { isPathContained } from './path-confine.ts';
import {
  commitWriteThroughFile,
  isDurabilityHardened,
} from './brain-repo-durability.ts';

export type SlugAliasErrorCode =
  | 'canonical_not_found'
  | 'self_alias'
  | 'alias_cycle'
  | 'alias_page_collision'
  | 'alias_replacement_required';

export class SlugAliasError extends Error {
  constructor(
    public readonly code: SlugAliasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SlugAliasError';
  }
}

export interface AddSlugAliasOpts {
  sourceId: string;
  aliasSlug: string;
  canonicalSlug: string;
  softDeleteOld?: boolean;
  replace?: boolean;
}

export interface AddSlugAliasResult {
  status: 'added' | 'replaced' | 'unchanged';
  source_id: string;
  alias_slug: string;
  canonical_slug: string;
  soft_deleted_old: boolean;
  facts_migrated: number;
  old_source_path: string | null;
}

export interface RemoveSlugAliasResult {
  status: 'removed' | 'not_found';
  source_id: string;
  alias_slug: string;
}

export interface RemoveSyncedSourceFileResult {
  file_removed: boolean;
  file_remove_error?: string;
}

export async function activePageExists(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, slug],
  );
  return rows.length > 0;
}

/**
 * Low-level idempotent insert used by the protected page-to-alias migration.
 * Its DO NOTHING behavior intentionally preserves that bulk migration's retry
 * contract. The supported operator surface uses addSlugAlias() below.
 */
export async function insertSlugAliasIfAbsent(
  engine: BrainEngine,
  sourceId: string,
  aliasSlug: string,
  canonicalSlug: string,
  notes?: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, alias_slug) DO NOTHING
     RETURNING id`,
    [sourceId, aliasSlug, canonicalSlug, notes ?? null],
  );
  return rows.length > 0;
}

function assertNoCycle(
  rows: Array<{ alias_slug: string; canonical_slug: string }>,
  aliasSlug: string,
  canonicalSlug: string,
): void {
  const nextByAlias = new Map(rows.map((row) => [row.alias_slug, row.canonical_slug]));
  nextByAlias.set(aliasSlug, canonicalSlug);

  const seen = new Set<string>([aliasSlug]);
  let cursor = canonicalSlug;
  while (true) {
    if (seen.has(cursor)) {
      throw new SlugAliasError(
        'alias_cycle',
        `Alias '${aliasSlug}' -> '${canonicalSlug}' would create a slug-alias cycle.`,
      );
    }
    seen.add(cursor);
    const next = nextByAlias.get(cursor);
    if (next === undefined) return;
    cursor = next;
  }
}

/**
 * Add or explicitly replace one source-scoped slug redirect. Validation,
 * optional old-page soft deletion, and the alias write share one real engine
 * transaction on both PostgreSQL and PGLite.
 */
export async function addSlugAlias(
  engine: BrainEngine,
  opts: AddSlugAliasOpts,
): Promise<AddSlugAliasResult> {
  const { sourceId, aliasSlug, canonicalSlug } = opts;
  if (aliasSlug === canonicalSlug) {
    throw new SlugAliasError('self_alias', 'Alias slug and canonical slug must differ.');
  }

  return engine.transaction(async (tx) => {
    // Serialize supported alias mutations per source. This closes the race
    // where two concurrent validations could each miss the other's edge and
    // commit a cycle. The sources row exists for every page via the FK.
    await tx.executeRaw(
      `SELECT id FROM sources WHERE id = $1 FOR UPDATE`,
      [sourceId],
    );
    if (!(await activePageExists(tx, canonicalSlug, sourceId))) {
      throw new SlugAliasError(
        'canonical_not_found',
        `Canonical page '${canonicalSlug}' does not exist or is soft-deleted in source '${sourceId}'.`,
      );
    }

    const existing = await tx.executeRaw<{ canonical_slug: string }>(
      `SELECT canonical_slug FROM slug_aliases
        WHERE source_id = $1 AND alias_slug = $2
        LIMIT 1`,
      [sourceId, aliasSlug],
    );
    const identical = existing[0]?.canonical_slug === canonicalSlug;
    if (existing.length > 0 && opts.replace !== true) {
      if (!identical) {
        throw new SlugAliasError(
          'alias_replacement_required',
          `Alias '${aliasSlug}' already points to '${existing[0].canonical_slug}'. Pass replace: true to change it.`,
        );
      }
    }

    const oldPages = await tx.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages
        WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [sourceId, aliasSlug],
    );
    if (oldPages.length > 0 && opts.softDeleteOld !== true) {
      throw new SlugAliasError(
        'alias_page_collision',
        `Alias slug '${aliasSlug}' is an active page in source '${sourceId}'. Pass soft_delete_old: true to soft-delete it atomically.`,
      );
    }

    if (identical) {
      let softDeletedOld = false;
      let factsMigrated = 0;
      if (oldPages.length > 0) {
        softDeletedOld = (await tx.softDeletePage(aliasSlug, { sourceId })) !== null;
        if (!softDeletedOld) {
          throw new Error(`Active alias page '${aliasSlug}' changed during alias creation.`);
        }
        factsMigrated = (await tx.migrateFactsToCanonical(
          aliasSlug,
          canonicalSlug,
          sourceId,
        )).migrated;
      }
      return {
        status: 'unchanged' as const,
        source_id: sourceId,
        alias_slug: aliasSlug,
        canonical_slug: canonicalSlug,
        soft_deleted_old: softDeletedOld,
        facts_migrated: factsMigrated,
        old_source_path: oldPages[0]?.source_path ?? null,
      };
    }

    const aliases = await tx.executeRaw<{ alias_slug: string; canonical_slug: string }>(
      `SELECT alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1`,
      [sourceId],
    );
    assertNoCycle(aliases, aliasSlug, canonicalSlug);

    let softDeletedOld = false;
    let factsMigrated = 0;
    if (oldPages.length > 0) {
      softDeletedOld = (await tx.softDeletePage(aliasSlug, { sourceId })) !== null;
      if (!softDeletedOld) {
        throw new Error(`Active alias page '${aliasSlug}' changed during alias creation.`);
      }
      factsMigrated = (await tx.migrateFactsToCanonical(
        aliasSlug,
        canonicalSlug,
        sourceId,
      )).migrated;
    }

    const status = existing.length > 0 ? 'replaced' as const : 'added' as const;
    if (status === 'replaced') {
      const updated = await tx.executeRaw<{ id: number }>(
        `UPDATE slug_aliases
            SET canonical_slug = $3
          WHERE source_id = $1 AND alias_slug = $2
          RETURNING id`,
        [sourceId, aliasSlug, canonicalSlug],
      );
      if (updated.length !== 1) throw new Error(`Alias '${aliasSlug}' changed during replacement.`);
    } else {
      await tx.executeRaw(
        `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
         VALUES ($1, $2, $3)`,
        [sourceId, aliasSlug, canonicalSlug],
      );
    }

    return {
      status,
      source_id: sourceId,
      alias_slug: aliasSlug,
      canonical_slug: canonicalSlug,
      soft_deleted_old: softDeletedOld,
      facts_migrated: factsMigrated,
      old_source_path: oldPages[0]?.source_path ?? null,
    };
  });
}

/** Source-scoped and idempotent. Removing an alias never restores a page. */
export async function removeSlugAlias(
  engine: BrainEngine,
  sourceId: string,
  aliasSlug: string,
): Promise<RemoveSlugAliasResult> {
  const rows = await engine.executeRaw<{ id: number }>(
    `DELETE FROM slug_aliases
      WHERE source_id = $1 AND alias_slug = $2
      RETURNING id`,
    [sourceId, aliasSlug],
  );
  return {
    status: rows.length > 0 ? 'removed' : 'not_found',
    source_id: sourceId,
    alias_slug: aliasSlug,
  };
}

/** Resolve the registered source root, including the legacy default fallback. */
async function resolveSourceRoot(
  engine: BrainEngine,
  sourceId: string,
): Promise<string | null> {
  const sources = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  );
  let localPath = sources[0]?.local_path;
  // Pre-v0.18 default-source brains keep the synced repo in the legacy
  // config key. Other sources cannot safely inherit that global path.
  if (!localPath && sourceId === 'default') {
    localPath = await engine.getConfig('sync.repo_path');
  }
  return localPath ? resolve(localPath) : null;
}

/**
 * Remove one source-owned file after the alias transaction has committed.
 * File handling is fail-soft and path-confined; a Git durability commit is
 * best-effort and never changes the removal result.
 */
export async function removeSyncedSourceFile(
  engine: BrainEngine,
  sourceId: string,
  sourcePath: string,
  aliasSlug: string,
): Promise<RemoveSyncedSourceFileResult> {
  try {
    const root = await resolveSourceRoot(engine, sourceId);
    if (!root) {
      return {
        file_removed: false,
        file_remove_error: `Source '${sourceId}' has no registered local path.`,
      };
    }

    const file = resolve(root, sourcePath);
    const rel = relative(root, file);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      return {
        file_removed: false,
        file_remove_error: `Source path '${sourcePath}' escapes source root '${root}'.`,
      };
    }
    if (!isPathContained(file, root)) {
      return {
        file_removed: false,
        file_remove_error: `Source file '${sourcePath}' is missing or escapes source root '${root}'.`,
      };
    }

    unlinkSync(file);
    // The path-limited durability helper uses `git add -- <path>`, which
    // stages removals as well as writes. Commit failure is intentionally
    // fail-soft; host-level durability timers remain the fallback.
    if (isDurabilityHardened(root)) {
      commitWriteThroughFile(root, file, aliasSlug);
    }
    return { file_removed: true };
  } catch (error) {
    return {
      file_removed: false,
      file_remove_error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Return an operator warning when sync still owns an on-disk file for a page
 * that the alias operation soft-deleted. This is read-only: Git and the source
 * tree are never modified.
 */
export async function syncedFileWarning(
  engine: BrainEngine,
  sourceId: string,
  sourcePath: string | null,
): Promise<string | null> {
  if (!sourcePath) return null;
  const root = await resolveSourceRoot(engine, sourceId);
  if (!root) return null;

  const file = resolve(root, sourcePath);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || !existsSync(file)) return null;
  return `Source file '${sourcePath}' still exists for source '${sourceId}'. A future sync can recreate the soft-deleted page; update or remove that file separately. Git was not modified.`;
}
