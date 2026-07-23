/**
 * Durable resolution state for legacy facts that cannot be written to a
 * markdown fence because their source has no local_path.
 */

import type { BrainEngine } from '../engine.ts';

export const RETAINED_DB_ONLY_REASON = 'source_local_path_unavailable';

/**
 * Count legacy fact rows that have neither been fenced nor explicitly retained
 * as DB-only by the v0.32.2 remediation.
 */
export async function countPendingFactFenceBackfills(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM facts f
      WHERE f.row_num IS NULL
        AND f.entity_slug IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM facts_fence_backfill_resolutions r
           WHERE r.fact_id = f.id
             AND r.resolution = 'retained_db_only'
        )`,
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Record that a legacy fact is intentionally preserved in the DB because its
 * source has no writable markdown checkout.
 */
export async function retainFactDbOnly(
  engine: BrainEngine,
  fact: { id: string; source_id: string; entity_slug: string },
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts_fence_backfill_resolutions
       (fact_id, source_id, entity_slug, resolution, reason)
     VALUES ($1, $2, $3, 'retained_db_only', $4)
     ON CONFLICT (fact_id) DO UPDATE
       SET resolution = EXCLUDED.resolution,
           reason = EXCLUDED.reason,
           updated_at = now()
     WHERE facts_fence_backfill_resolutions.resolution <> EXCLUDED.resolution
        OR facts_fence_backfill_resolutions.reason <> EXCLUDED.reason`,
    [fact.id, fact.source_id, fact.entity_slug, RETAINED_DB_ONLY_REASON],
  );
}

/**
 * Advance an existing DB-only resolution when the source later becomes
 * writable and the fact is successfully linked to a markdown fence. Facts
 * that were fenceable on the first pass have no resolution row to update.
 */
export async function markFactFenced(engine: BrainEngine, factId: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE facts_fence_backfill_resolutions
        SET resolution = 'fenced',
            reason = 'backfilled_to_fence',
            updated_at = now()
      WHERE fact_id = $1`,
    [factId],
  );
}
