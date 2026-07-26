import { randomUUID } from 'node:crypto';
import type { BrainEngine, PageWriteContext } from './engine.ts';
import { classifyTakeMiningAdmission } from './take-mining-admission.ts';
import { buildTakeMiningInput } from './cycle/take-mining-input.ts';

/** Conservative attribution used until a production write boundary classifies itself. */
export const DEFAULT_PAGE_WRITE_CONTEXT: Readonly<PageWriteContext> = {
  actor: 'engine:unspecified',
  writeIntent: 'maintenance',
  reason: 'missing_write_context',
};

/**
 * Create one public-safe batch id for a producer-owned write run.
 *
 * Producers call this once at their orchestration boundary and reuse the
 * result for every page write in that run.
 */
export function createPageWriteBatchId(actor: string): string {
  const prefix = actor.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80);
  return `${prefix || 'write'}:${randomUUID()}`;
}

/** Resolve the explicit server context or the conservative internal fallback. */
export function resolvePageWriteContext(
  context: PageWriteContext | undefined,
): Readonly<PageWriteContext> {
  return context ?? DEFAULT_PAGE_WRITE_CONTEXT;
}

/**
 * Append one semantic mutation receipt and update current mining work.
 *
 * The caller must invoke this inside the same serialized transaction as the
 * page write. A semantic no-op remains auditable but does not disturb pending
 * work for the prior semantic revision.
 */
export async function recordPageMutation(
  engine: BrainEngine,
  input: {
    sourceId: string;
    slug: string;
    previousCompiledTruth: string | null;
    newCompiledTruth: string;
    writeContext?: PageWriteContext;
  },
): Promise<number> {
  const context = resolvePageWriteContext(input.writeContext);
  // Canonical mining hashes deliberately ignore managed link targets and
  // other non-prose churn, so maintenance rewrites can remain audit-only.
  const previousHash = input.previousCompiledTruth === null
    ? null
    : buildTakeMiningInput(input.previousCompiledTruth).mining_input_hash;
  const newHash = buildTakeMiningInput(input.newCompiledTruth).mining_input_hash;
  const semanticChanged = previousHash !== newHash;
  const admission = classifyTakeMiningAdmission({
    writeIntent: context.writeIntent,
    semanticChanged,
  });

  const mutationRows = await engine.executeRaw<{ id: number | string }>(
    `INSERT INTO page_mutations (
       source_id, page_slug, actor, write_intent, batch_id, reason,
       previous_mining_input_hash, new_mining_input_hash, semantic_changed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.sourceId,
      input.slug,
      context.actor,
      context.writeIntent,
      context.batchId ?? null,
      context.reason ?? null,
      previousHash,
      newHash,
      semanticChanged,
    ],
  );
  const mutationId = Number(mutationRows[0]!.id);
  const batchId = context.batchId
    ?? (admission === 'deferred' ? `mutation:${mutationId}` : null);

  // Deferred work must always have a stable drain key. Legacy callers that
  // omit a batch get one derived from the append-only receipt id.
  if (batchId !== (context.batchId ?? null)) {
    await engine.executeRaw(
      `UPDATE page_mutations
          SET batch_id = $2
        WHERE id = $1`,
      [mutationId, batchId],
    );
  }

  // Semantic no-ops leave any pending work untouched. A changed semantic
  // revision replaces current work only when its receipt is newer. Generated
  // and intrinsically non-markdown pages retain the receipt but never enter
  // a prose-mining queue they cannot drain.
  if (admission !== 'none') {
    await engine.executeRaw(
      `INSERT INTO take_mining_work (
         source_id, page_slug, mining_input_hash, admission, write_intent,
         actor, batch_id, reason, priority, page_mutation_id
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, 0, $9
         FROM pages p
        WHERE p.source_id = $1
          AND p.slug = $2
          AND p.page_kind = 'markdown'
          AND COALESCE(p.type, '') <> 'extract_receipt'
          AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
       ON CONFLICT (source_id, page_slug) DO UPDATE SET
         mining_input_hash = EXCLUDED.mining_input_hash,
         admission = EXCLUDED.admission,
         write_intent = EXCLUDED.write_intent,
         actor = EXCLUDED.actor,
         batch_id = EXCLUDED.batch_id,
         reason = EXCLUDED.reason,
         priority = EXCLUDED.priority,
         page_mutation_id = EXCLUDED.page_mutation_id,
         created_at = now(),
         updated_at = now()
       WHERE take_mining_work.page_mutation_id IS NULL
          OR take_mining_work.page_mutation_id < EXCLUDED.page_mutation_id`,
      [
        input.sourceId,
        input.slug,
        newHash,
        admission,
        context.writeIntent,
        context.actor,
        batchId,
        context.reason ?? null,
        mutationId,
      ],
    );
  }

  return mutationId;
}
