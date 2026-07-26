import type { BrainEngine } from './engine.ts';
import { importFromContent } from './import-file.ts';
import {
  addSlugAliasInTransaction,
  type AddSlugAliasResult,
} from './slug-alias.ts';
import {
  findSuppressedClaimMatches,
  listSuppressedClaims,
} from './claim-suppression.ts';
import { parseMarkdown } from './markdown.ts';
import { preserveSuppressedClaimsFence } from './suppressed-claims-fence.ts';

export type PageRenameErrorCode =
  | 'same_slug'
  | 'origin_not_found'
  | 'destination_exists'
  | 'destination_not_written'
  | 'suppression_reassertion';

/** Stable domain error raised by the atomic page-rename service. */
export class PageRenameError extends Error {
  constructor(
    public readonly code: PageRenameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PageRenameError';
  }
}

export interface RenamePageOpts {
  sourceId: string;
  oldSlug: string;
  newSlug: string;
  content: string;
  remote: boolean;
}

export interface RenamePageResult {
  source_id: string;
  old_slug: string;
  new_slug: string;
  alias: AddSlugAliasResult;
}

/**
 * Create a renamed page and retire its old slug in one database transaction.
 *
 * Parsing and chunk preparation run against the transaction-scoped engine, and
 * the importer is told not to open a nested transaction. If alias retirement
 * fails, the destination insert and every derived row roll back with it.
 */
export async function renamePage(
  engine: BrainEngine,
  opts: RenamePageOpts,
): Promise<RenamePageResult> {
  if (opts.oldSlug === opts.newSlug) {
    throw new PageRenameError('same_slug', 'Old and new page slugs must differ.');
  }

  return engine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT id FROM sources WHERE id = $1 FOR UPDATE`,
      [opts.sourceId],
    );
    const origin = await tx.getPage(opts.oldSlug, { sourceId: opts.sourceId });
    if (!origin) {
      throw new PageRenameError(
        'origin_not_found',
        `Page '${opts.oldSlug}' does not exist or is soft-deleted in source '${opts.sourceId}'.`,
      );
    }
    const destination = await tx.getPage(opts.newSlug, {
      sourceId: opts.sourceId,
      includeDeleted: true,
    });
    if (destination) {
      throw new PageRenameError(
        'destination_exists',
        `Page '${opts.newSlug}' already exists in source '${opts.sourceId}'.`,
      );
    }

    const suppressions = await listSuppressedClaims(
      tx,
      opts.oldSlug,
      opts.sourceId,
    ) ?? [];
    if (suppressions.some((claim) => claim.active)) {
      const candidate = parseMarkdown(opts.content, `${opts.newSlug}.md`);
      const matches = findSuppressedClaimMatches(
        candidate.compiled_truth,
        suppressions,
      );
      if (matches.length > 0) {
        throw new PageRenameError(
          'suppression_reassertion',
          `Rename content reasserts ${matches.length} active suppressed claim(s).`,
        );
      }
    }
    const content = preserveSuppressedClaimsFence(
      origin.compiled_truth ?? '',
      opts.content,
    );
    const imported = await importFromContent(tx, opts.newSlug, content, {
      sourceId: opts.sourceId,
      sourcePath: `${opts.newSlug}.md`,
      noEmbed: true,
      forceRechunk: true,
      remote: opts.remote,
      withinTransaction: true,
      source_kind: opts.remote ? 'mcp:rename_page' : 'rename_page',
      ingested_via: opts.remote ? 'mcp:rename_page' : 'rename_page',
    });
    if (imported.status !== 'imported' || imported.slug !== opts.newSlug) {
      throw new PageRenameError(
        'destination_not_written',
        `GBrain did not create rename destination '${opts.newSlug}'.`,
      );
    }

    const alias = await addSlugAliasInTransaction(tx, {
      sourceId: opts.sourceId,
      aliasSlug: opts.oldSlug,
      canonicalSlug: opts.newSlug,
      softDeleteOld: true,
      notes: 'rename_page',
    });
    if (!alias.soft_deleted_old) {
      throw new PageRenameError(
        'origin_not_found',
        `GBrain did not retire rename origin '${opts.oldSlug}'.`,
      );
    }

    return {
      source_id: opts.sourceId,
      old_slug: opts.oldSlug,
      new_slug: opts.newSlug,
      alias,
    };
  });
}
