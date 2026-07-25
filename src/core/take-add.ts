/**
 * Shared markdown-and-database take insertion.
 *
 * Markdown remains canonical: the page fence is updated while holding the
 * per-page lock, then the same row is mirrored into the source-scoped page.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine, TakeKind } from './engine.ts';
import { withPageLock } from './page-lock.ts';
import { upsertTakeRow } from './takes-fence.ts';

export type TakeAddErrorCode =
  | 'brain_dir_not_found'
  | 'page_not_found'
  | 'page_deleted';

/** Expected configuration or page-resolution failure during take insertion. */
export class TakeAddError extends Error {
  constructor(
    public code: TakeAddErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TakeAddError';
  }
}

/** Fields accepted by the shared take-add orchestration. */
export interface AddTakeInput {
  slug: string;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  source?: string;
  sinceDate?: string;
  sourceId?: string;
  brainDir?: string;
}

/** Result of writing a take to markdown and its database mirror. */
export interface AddTakeResult {
  rowNum: number;
  pageSlug: string;
}

/** Canonical page and holder resolved before a take write begins. */
export interface ResolvedTakeTarget {
  slug: string;
  holder: string;
  pageId: number;
}

/**
 * Resolve the markdown working tree that owns `sourceId`'s pages.
 *
 * Precedence mirrors the write-through topology rules (#2018): an explicit
 * CLI --dir wins, then the source's own `local_path` working tree
 * (multi-source deployments), then the single-brain `sync.repo_path` config.
 */
export async function resolveTakeBrainDir(
  engine: BrainEngine,
  opts: { sourceId?: string; brainDir?: string } = {},
): Promise<string> {
  // An explicit CLI path retains precedence and the exact historical error.
  if (opts.brainDir) {
    if (!existsSync(opts.brainDir)) {
      throw new TakeAddError(
        'brain_dir_not_found',
        `--dir path does not exist: ${opts.brainDir}`,
      );
    }
    return opts.brainDir;
  }
  // Multi-source deployments keep each source's markdown in its own working
  // tree; writing a source's take anywhere else would pollute a sibling repo.
  if (opts.sourceId) {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    const localPath = rows[0]?.local_path;
    if (localPath) {
      if (!existsSync(localPath)) {
        throw new TakeAddError(
          'brain_dir_not_found',
          `Source '${opts.sourceId}' local_path does not exist: ${localPath}`,
        );
      }
      return localPath;
    }
  }
  // Single-brain setups use the same configured canonical checkout as the CLI.
  const configured = await engine.getConfig('sync.repo_path');
  if (configured && existsSync(configured)) return configured;
  throw new TakeAddError(
    'brain_dir_not_found',
    'No brain directory configured. Pass --dir <path> or run `gbrain init` first.',
  );
}

async function resolvePageId(
  engine: BrainEngine,
  slug: string,
  sourceId?: string,
): Promise<number> {
  const rows = sourceId
    ? await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages
          WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [slug, sourceId],
      )
    : await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages
          WHERE slug = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [slug],
      );
  if (rows[0]) return rows[0].id;

  // Distinguish a tombstone from a never-ingested slug without weakening the
  // active-row lookup that protects the file write below.
  const deletedRows = sourceId
    ? await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages
          WHERE slug = $1 AND source_id = $2 AND deleted_at IS NOT NULL
          LIMIT 1`,
        [slug, sourceId],
      )
    : await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages
          WHERE slug = $1 AND deleted_at IS NOT NULL
          LIMIT 1`,
        [slug],
      );
  if (deletedRows[0]) {
    throw new TakeAddError('page_deleted', `Page is soft-deleted: ${slug}`);
  }
  throw new TakeAddError(
    'page_not_found',
    `Page not found in brain: ${slug}${sourceId ? ` (source=${sourceId})` : ''}. Run \`gbrain sync\` first.`,
  );
}

/** Resolve slug aliases and verify the canonical page is active. */
export async function resolveTakeTarget(
  engine: BrainEngine,
  input: Pick<AddTakeInput, 'slug' | 'holder' | 'sourceId'>,
): Promise<ResolvedTakeTarget> {
  const aliasSourceId = input.sourceId ?? 'default';
  const slug = await engine.resolveSlugWithAlias(input.slug, aliasSourceId);
  const holder = await engine.resolveSlugWithAlias(input.holder, aliasSourceId);
  const pageId = await resolvePageId(engine, slug, input.sourceId);
  return { slug, holder, pageId };
}

/**
 * Add one take to the canonical page fence and source-scoped database mirror.
 */
export async function addTake(
  engine: BrainEngine,
  input: AddTakeInput,
): Promise<AddTakeResult> {
  const brainDir = await resolveTakeBrainDir(engine, {
    sourceId: input.sourceId,
    brainDir: input.brainDir,
  });
  const target = await resolveTakeTarget(engine, input);

  // The lock spans both sinks so concurrent writers cannot reuse a row number
  // or mirror a fence state different from the file they observed.
  return withPageLock(target.slug, async () => {
    const path = join(brainDir, `${target.slug}.md`);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const { body: nextBody, rowNum } = upsertTakeRow(body, {
      claim: input.claim,
      kind: input.kind,
      holder: target.holder,
      weight: input.weight,
      source: input.source,
      sinceDate: input.sinceDate,
      active: true,
    });

    // Preserve the established markdown-first command sequence.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextBody, 'utf8');
    await engine.addTakesBatch([{
      page_id: target.pageId,
      row_num: rowNum,
      claim: input.claim,
      kind: input.kind,
      holder: target.holder,
      weight: input.weight,
      since_date: input.sinceDate,
      source: input.source,
      active: true,
      superseded_by: null,
    }]);
    return {
      rowNum,
      pageSlug: target.slug,
    };
  });
}
