/** Deterministic application of server-frozen proposal relations. */

import type { BrainEngine } from '../engine.ts';
import { AgentJobProposalError, canonicalProposalJson } from '../ingestion-proposal-contract.ts';
import { writePageThrough } from '../write-through.ts';
import {
  assertNextProposalRelation,
  ensureProposalApplicationPreflight,
  findLinkIdentity,
  findTimelineIdentity,
  parseApplyProposalRelationInput,
  readProposalRelationOutcome,
  timelineRowMatches,
  verifyProposalRelationOutcome,
  type ApplyProposalRelationInput,
  type ApplyProposalRelationResult,
  type RelationOutcomeRow,
} from './agent-job-proposal-application.ts';
import {
  digestProposalRelation,
  type ProposalLink,
  type ProposalTimelineEntry,
} from './agent-job-proposal-relations.ts';

interface PendingRelationResult {
  result: ApplyProposalRelationResult;
  row: RelationOutcomeRow;
  needsWriteThrough: boolean;
}

/**
 * Apply one relation selected only by frozen kind and one-based sequence.
 *
 * The caller cannot supply relation content. The operation resolves the
 * reviewed row from proposal authority, enforces whole-plan preflight/order,
 * and records a globally replayable outcome before returning.
 */
export async function applyAgentJobProposalRelation(
  engine: BrainEngine,
  applyJobId: number,
  rawInput: ApplyProposalRelationInput,
): Promise<ApplyProposalRelationResult> {
  if (!Number.isSafeInteger(applyJobId) || applyJobId < 1) {
    throw new AgentJobProposalError('invalid_job_id', 'Apply job id must be a positive integer.');
  }
  const input = parseApplyProposalRelationInput(rawInput);
  if (input.proposal_job_id === applyJobId) {
    throw new AgentJobProposalError('permission_denied', 'A proposal must be applied by a separate authorized job.');
  }

  const pending = await engine.transaction(async (tx) => {
    const context = await ensureProposalApplicationPreflight(tx, applyJobId, input);
    const relation = input.relation_kind === 'timeline'
      ? context.authority.plan.proposedTimelineEntries[input.sequence - 1]
      : context.authority.plan.proposedLinks[input.sequence - 1];
    const manifest = input.relation_kind === 'timeline'
      ? context.authority.timelineDigests[input.sequence - 1]
      : context.authority.linkDigests[input.sequence - 1];
    if (!relation || !manifest || manifest.sequence !== input.sequence) {
      throw new AgentJobProposalError('off_plan_relation', 'Requested relation is outside the frozen proposal.');
    }
    const relationDigest = digestProposalRelation(input.relation_kind, relation);
    if (relationDigest !== manifest.digest) {
      throw new AgentJobProposalError('digest_mismatch', 'Frozen relation does not match its approved digest manifest.');
    }

    const existing = await readProposalRelationOutcome(tx, input, true);
    if (existing) {
      if (
        existing.source_id !== input.source_id
        || existing.relation_digest !== relationDigest
      ) {
        throw new AgentJobProposalError('invalid_apply_receipt', 'Stored relation receipt does not match frozen authority.');
      }
      await verifyProposalRelationOutcome(tx, context.authority, existing);
      return {
        result: resultFor(input, relationDigest, existing.target_slug, 'already_applied'),
        row: existing,
        needsWriteThrough: input.relation_kind === 'timeline' &&
          !writeThroughComplete(existing.write_through),
      };
    }

    await assertNextProposalRelation(tx, context, input);
    const applied = input.relation_kind === 'timeline'
      ? await applyTimeline(tx, input.source_id, relation as ProposalTimelineEntry)
      : await applyLink(tx, input.source_id, relation as ProposalLink);
    const rows = await tx.executeRaw<RelationOutcomeRow>(
      `INSERT INTO ingestion_proposal_relation_outcomes
         (proposal_id, proposal_digest, relation_kind, sequence,
          relation_digest, source_id, apply_job_id, target_slug,
          observed_row_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (proposal_id, proposal_digest, relation_kind, sequence) DO NOTHING
       RETURNING relation_kind, sequence, relation_digest, source_id,
                 apply_job_id, target_slug, observed_row_id, outcome, write_through`,
      [
        input.proposal_job_id,
        input.proposal_digest,
        input.relation_kind,
        input.sequence,
        relationDigest,
        input.source_id,
        applyJobId,
        applied.targetSlug,
        applied.observedRowId,
        applied.status,
      ],
    );
    const insertedOutcome = rows[0] !== undefined;
    const stored = rows[0] ?? await readProposalRelationOutcome(tx, input, true);
    if (!stored || stored.relation_digest !== relationDigest) {
      throw new AgentJobProposalError('invalid_apply_receipt', 'Relation application receipt was not persisted.');
    }
    await verifyProposalRelationOutcome(tx, context.authority, stored);
    return {
      result: resultFor(
        input,
        relationDigest,
        stored.target_slug,
        insertedOutcome ? applied.status : 'already_applied',
      ),
      row: stored,
      needsWriteThrough: input.relation_kind === 'timeline',
    };
  });

  if (!pending.needsWriteThrough) {
    return pending.row.write_through
      ? { ...pending.result, write_through: pending.row.write_through }
      : pending.result;
  }
  const writeThrough = await writePageThrough(engine, pending.result.target_slug, {
    sourceId: input.source_id,
  });
  await engine.executeRaw(
    `UPDATE ingestion_proposal_relation_outcomes
        SET write_through = $5::text::jsonb
      WHERE proposal_id = $1 AND proposal_digest = $2
        AND relation_kind = $3 AND sequence = $4`,
    [
      input.proposal_job_id,
      input.proposal_digest,
      input.relation_kind,
      input.sequence,
      canonicalProposalJson(writeThrough),
    ],
  );
  return { ...pending.result, write_through: writeThrough };
}

async function applyTimeline(
  engine: BrainEngine,
  sourceId: string,
  entry: ProposalTimelineEntry,
): Promise<{ status: 'applied' | 'already_applied'; targetSlug: string; observedRowId: number }> {
  const before = await findTimelineIdentity(engine, sourceId, entry);
  if (before.length > 1 || (before[0] && !timelineRowMatches(before[0], entry))) {
    throw new AgentJobProposalError('relation_collision', 'Timeline identity collision does not match the frozen relation.');
  }
  let status: 'applied' | 'already_applied' = before[0] ? 'already_applied' : 'applied';
  if (!before[0]) {
    const inserted = await engine.addTimelineEntry(entry.pageSlug, { // gbrain-allow-direct-insert: exact server-frozen proposal relation
      date: entry.date,
      source: '',
      summary: entry.text,
      detail: '',
      ref_slug: entry.ref,
      ...(entry.refLabel ? { ref_label: entry.refLabel } : {}),
    }, { sourceId });
    if (!inserted) status = 'already_applied';
  }
  const after = await findTimelineIdentity(engine, sourceId, entry);
  if (after.length !== 1 || !timelineRowMatches(after[0]!, entry)) {
    throw new AgentJobProposalError('apply_failed', 'Timeline relation did not reach its exact frozen state.');
  }
  return { status, targetSlug: entry.pageSlug, observedRowId: Number(after[0]!.id) };
}

async function applyLink(
  engine: BrainEngine,
  sourceId: string,
  entry: ProposalLink,
): Promise<{ status: 'applied' | 'already_applied'; targetSlug: string; observedRowId: number }> {
  const before = await findLinkIdentity(engine, sourceId, entry);
  if (before.length > 1) {
    throw new AgentJobProposalError('relation_collision', 'Multiple existing links collide with the frozen relation.');
  }
  const status = before[0] ? 'already_applied' as const : 'applied' as const;
  if (!before[0]) {
    await engine.addLink(entry.from, entry.to, '', entry.type, 'ingestion-proposal', undefined, undefined, { // gbrain-allow-direct-insert: exact server-frozen proposal relation
      fromSourceId: sourceId,
      toSourceId: sourceId,
      originSourceId: sourceId,
    });
  }
  const after = await findLinkIdentity(engine, sourceId, entry);
  if (after.length !== 1) {
    throw new AgentJobProposalError('apply_failed', 'Link relation did not reach its exact frozen state.');
  }
  return { status, targetSlug: entry.from, observedRowId: Number(after[0]!.id) };
}

function resultFor(
  input: ApplyProposalRelationInput,
  relationDigest: string,
  targetSlug: string,
  status: 'applied' | 'already_applied',
): ApplyProposalRelationResult {
  return {
    status,
    relation_kind: input.relation_kind,
    proposal_job_id: input.proposal_job_id,
    sequence: input.sequence,
    source_id: input.source_id,
    proposal_digest: input.proposal_digest,
    relation_digest: relationDigest,
    target_slug: targetSlug,
  };
}

function writeThroughComplete(result: RelationOutcomeRow['write_through']): boolean {
  return result?.written === true || result?.skipped === 'no_repo_configured';
}
