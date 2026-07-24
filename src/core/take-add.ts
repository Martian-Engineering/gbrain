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

export type TakeAddErrorCode = 'brain_dir_not_found' | 'page_not_found';

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
}

async function resolveBrainDir(
  engine: BrainEngine,
  explicitDir?: string,
): Promise<string> {
  // An explicit CLI path retains precedence and the exact historical error.
  if (explicitDir) {
    if (!existsSync(explicitDir)) {
      throw new TakeAddError(
        'brain_dir_not_found',
        `--dir path does not exist: ${explicitDir}`,
      );
    }
    return explicitDir;
  }
  // Operation callers use the same configured canonical checkout as the CLI.
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
        `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
        [slug, sourceId],
      )
    : await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
        [slug],
      );
  if (!rows[0]) {
    throw new TakeAddError(
      'page_not_found',
      `Page not found in brain: ${slug}${sourceId ? ` (source=${sourceId})` : ''}. Run \`gbrain sync\` first.`,
    );
  }
  return rows[0].id;
}

/**
 * Add one take to the canonical page fence and source-scoped database mirror.
 */
export async function addTake(
  engine: BrainEngine,
  input: AddTakeInput,
): Promise<AddTakeResult> {
  const brainDir = await resolveBrainDir(engine, input.brainDir);

  // The lock spans both sinks so concurrent writers cannot reuse a row number
  // or mirror a fence state different from the file they observed.
  return withPageLock(input.slug, async () => {
    const path = join(brainDir, `${input.slug}.md`);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const { body: nextBody, rowNum } = upsertTakeRow(body, {
      claim: input.claim,
      kind: input.kind,
      holder: input.holder,
      weight: input.weight,
      source: input.source,
      sinceDate: input.sinceDate,
      active: true,
    });

    // Preserve the established markdown-first command sequence.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextBody, 'utf8');
    const pageId = await resolvePageId(engine, input.slug, input.sourceId);
    await engine.addTakesBatch([{
      page_id: pageId,
      row_num: rowNum,
      claim: input.claim,
      kind: input.kind,
      holder: input.holder,
      weight: input.weight,
      since_date: input.sinceDate,
      source: input.source,
      active: true,
      superseded_by: null,
    }]);
    return { rowNum };
  });
}
