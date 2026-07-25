/**
 * Shared canonical take supersession.
 *
 * Markdown remains the source of truth: validate and rewrite the takes fence
 * under the page lock, then mirror the same replacement through the engine.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine, TakeBatchInput } from './engine.ts';
import { withPageLock } from './page-lock.ts';
import { resolveTakeBrainDir } from './take-add.ts';
import {
  parseTakesFence,
  supersedeRow,
  type ParsedTake,
} from './takes-fence.ts';

export type TakeSupersedeErrorCode =
  | 'take_row_not_found'
  | 'take_already_superseded'
  | 'take_resolved_immutable'
  | 'take_fence_row_not_found'
  | 'take_row_mismatch';

/** Expected canonical-state failure during a take supersession. */
export class TakeSupersedeError extends Error {
  constructor(
    public code: TakeSupersedeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TakeSupersedeError';
  }
}

/** Fields required to supersede one source-scoped take. */
export interface SupersedeTakeInput {
  slug: string;
  takeId: number;
  pageId: number;
  rowNum: number;
  expected: Omit<ParsedTake, 'rowNum'>;
  replacement: Omit<
    TakeBatchInput,
    'page_id' | 'row_num' | 'superseded_by'
  >;
  sourceId: string;
  dryRun?: boolean;
}

/** Identifiers assigned or predicted by canonical take supersession. */
export interface SupersedeTakeResult {
  oldRow: number;
  newRow: number;
}

/**
 * Rewrite the canonical takes fence and mirror the supersession to the engine.
 *
 * Dry runs perform the same source-tree, fence, and row validation but skip
 * both writes.
 */
export async function supersedeTake(
  engine: BrainEngine,
  input: SupersedeTakeInput,
): Promise<SupersedeTakeResult> {
  const brainDir = await resolveTakeBrainDir(engine, {
    sourceId: input.sourceId,
  });

  return withPageLock(input.slug, async () => {
    const currentRows = await engine.executeRaw<{
      active: boolean;
      superseded_by: number | null;
      resolved_at: string | Date | null;
    }>(
      `SELECT active, superseded_by, resolved_at
         FROM takes
        WHERE id = $1 AND page_id = $2
        LIMIT 1`,
      [input.takeId, input.pageId],
    );
    const current = currentRows[0];
    if (!current) {
      throw new TakeSupersedeError(
        'take_row_not_found',
        `Take id ${input.takeId} no longer exists on page id ${input.pageId}.`,
      );
    }
    if (!current.active || current.superseded_by !== null) {
      throw new TakeSupersedeError(
        'take_already_superseded',
        `Take id ${input.takeId} is already inactive or superseded.`,
      );
    }
    if (current.resolved_at !== null) {
      throw new TakeSupersedeError(
        'take_resolved_immutable',
        `Take id ${input.takeId} is resolved and immutable.`,
      );
    }

    const path = join(brainDir, `${input.slug}.md`);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const canonical = parseTakesFence(body).takes.find(
      take => take.rowNum === input.rowNum,
    );
    if (!canonical) {
      throw new TakeSupersedeError(
        'take_fence_row_not_found',
        `Take row #${input.rowNum} was not found in ${input.slug}'s canonical takes fence.`,
      );
    }
    const canonicalMatches = canonical.claim === input.expected.claim
      && canonical.kind === input.expected.kind
      && canonical.holder === input.expected.holder
      && Math.abs(canonical.weight - input.expected.weight) < 0.000_001
      && canonical.sinceDate === input.expected.sinceDate
      && canonical.untilDate === input.expected.untilDate
      && canonical.source === input.expected.source
      && canonical.active === input.expected.active;
    if (!canonicalMatches) {
      throw new TakeSupersedeError(
        'take_row_mismatch',
        `Take row #${input.rowNum} differs between the canonical fence and database mirror.`,
      );
    }

    let nextBody: string;
    let newRowNum: number;
    try {
      const fenceResult = supersedeRow(body, input.rowNum, {
        claim: input.replacement.claim,
        kind: input.replacement.kind,
        holder: input.replacement.holder,
        weight: input.replacement.weight ?? 0.5,
        sinceDate: input.replacement.since_date,
        untilDate: input.replacement.until_date,
        source: input.replacement.source,
      });
      nextBody = fenceResult.body;
      newRowNum = fenceResult.newRowNum;
    } catch {
      throw new TakeSupersedeError(
        'take_fence_row_not_found',
        `Take row #${input.rowNum} was not found in ${input.slug}'s canonical takes fence.`,
      );
    }

    const nextRows = await engine.executeRaw<{ next: number | string }>(
      `SELECT COALESCE(MAX(row_num), 0) + 1 AS next
         FROM takes
        WHERE page_id = $1`,
      [input.pageId],
    );
    const expectedRow = Number(nextRows[0]?.next ?? 1);
    if (expectedRow !== newRowNum) {
      throw new TakeSupersedeError(
        'take_row_mismatch',
        `Canonical fence would create row #${newRowNum}, but the database expects row #${expectedRow}.`,
      );
    }
    if (input.dryRun) {
      return { oldRow: input.rowNum, newRow: newRowNum };
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, nextBody, 'utf8');
    const result = await engine.supersedeTake(
      input.pageId,
      input.rowNum,
      input.replacement,
    );
    if (result.newRow !== newRowNum) {
      throw new TakeSupersedeError(
        'take_row_mismatch',
        `Canonical fence wrote row #${newRowNum}, but the database created row #${result.newRow}.`,
      );
    }
    return result;
  });
}
