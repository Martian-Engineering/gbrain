import type { BrainEngine } from '../engine.ts';
import { buildTakeMiningInput } from './take-mining-input.ts';

/** Stored page state needed to classify one take-mining work revision. */
export interface TakeMiningWorkBody {
  source_id: string;
  page_slug: string;
  mining_input_hash: string;
  compiled_truth: string;
}

/** Canonical eligibility result shared by work selection and settlement. */
export interface TakeMiningWorkClassification {
  kind: 'eligible' | 'stale' | 'canonical_empty';
  input: ReturnType<typeof buildTakeMiningInput>;
}

/** Build the SQL predicate for page properties that precede canonicalization. */
export function takeMiningPageEligibilityPredicate(
  pageAlias: string,
  typePlaceholders: readonly string[],
): string {
  if (typePlaceholders.length === 0) return 'FALSE';
  return `${pageAlias}.deleted_at IS NULL
        AND ${pageAlias}.page_kind = 'markdown'
        AND ${pageAlias}.type IN (${typePlaceholders.join(', ')})
        AND length(trim(${pageAlias}.compiled_truth)) > 0
        AND COALESCE(${pageAlias}.frontmatter->>'dream_generated', '') <> 'true'`;
}

/** Classify current page prose against the exact queued semantic revision. */
export function classifyTakeMiningWork(
  work: TakeMiningWorkBody,
): TakeMiningWorkClassification {
  const input = buildTakeMiningInput(work.compiled_truth);
  if (input.mining_input_hash !== work.mining_input_hash) {
    return { kind: 'stale', input };
  }
  if (input.prose.length === 0) return { kind: 'canonical_empty', input };
  return { kind: 'eligible', input };
}

/**
 * Retire observed canonical-empty revisions in one guarded statement.
 *
 * The page-body equality guard makes cleanup race-safe without deleting page
 * mutation receipts or stale work for a concurrently edited page.
 */
export async function settleCanonicalEmptyWork(
  engine: BrainEngine,
  candidates: readonly TakeMiningWorkBody[],
  onSerialized?: (bytes: number) => void,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const observed = JSON.stringify(candidates);
  if (onSerialized) onSerialized(Buffer.byteLength(observed, 'utf8'));
  const settled = await engine.executeRaw<{ page_slug: string }>(
    `WITH observed AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS candidate(
           source_id text,
           page_slug text,
           mining_input_hash text,
           compiled_truth text
         )
     )
     DELETE FROM take_mining_work w
     USING observed, pages p
      WHERE w.source_id = observed.source_id
        AND w.page_slug = observed.page_slug
        AND w.mining_input_hash = observed.mining_input_hash
        AND p.source_id = w.source_id
        AND p.slug = w.page_slug
        AND p.compiled_truth = observed.compiled_truth
     RETURNING w.page_slug`,
    [observed],
  );
  return settled.length;
}
