/** Whole-inventory preflight, relation application, and final receipt logic. */

import type { BrainEngine } from '../engine.ts';
import {
  AgentJobProposalError,
  canonicalProposalJson,
  digestProposalValue,
  parseProposalPage,
  type ScopedProposalPage,
} from '../ingestion-proposal-contract.ts';
export { AgentJobProposalError } from '../ingestion-proposal-contract.ts';
import { assertValidSourceId } from '../source-id.ts';
import type { WriteThroughResult } from '../write-through.ts';
import {
  appendAttempt,
  baselineFromFragment,
  digestFrozenProposalPage,
  getOwnedApprovedProposalAuthority,
  readApplyJobBinding,
  rewriteAttempt,
  type ApplyJobBinding,
  type ApprovedProposalAuthority,
  type StoredProposalFragment,
} from './agent-job-proposal-apply.ts';
import {
  digestProposalRelation,
  type ProposalLink,
  type ProposalTimelineEntry,
} from './agent-job-proposal-relations.ts';

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Authority common to relation application and proposal finalization. */
export interface ProposalApplicationAuthorityInput {
  proposal_job_id: number;
  proposal_digest: string;
  source_id: string;
}

/** Exact caller-selectable relation slot. Relation content remains server-owned. */
export interface ApplyProposalRelationInput extends ProposalApplicationAuthorityInput {
  relation_kind: 'timeline' | 'link';
  sequence: number;
}

/** Privacy-bounded result for one frozen relation slot. */
export interface ApplyProposalRelationResult {
  status: 'applied' | 'already_applied';
  relation_kind: 'timeline' | 'link';
  proposal_job_id: number;
  sequence: number;
  source_id: string;
  proposal_digest: string;
  relation_digest: string;
  target_slug: string;
  write_through?: WriteThroughResult;
}

/** Server receipt proving every frozen proposal effect is current. */
export interface FinalizeProposalApplicationResult {
  status: 'applied_proposal' | 'already_finalized';
  proposal_job_id: number;
  proposal_digest: string;
  source_id: string;
  inventory_digest: string;
  pages: { total: number; applied: number; rebased: number };
  timeline_entries: { total: number; applied: number };
  links: { total: number; applied: number };
  receipt_digest: string;
}

/** Frozen authority and apply-job binding checked for one operation call. */
export interface ProposalApplicationContext {
  binding: ApplyJobBinding;
  authority: ApprovedProposalAuthority;
  input: ProposalApplicationAuthorityInput;
}

interface ApplicationRunRow {
  proposal_id: string | number;
  proposal_digest: string;
  owner_client_id: string;
  source_id: string;
  artifact_id: string;
  admission_scope: string;
  capture_page_slug: string;
  inventory_digest: string;
  final_receipt: FinalizeProposalApplicationResult | null;
  final_receipt_digest: string | null;
  finalized_at: string | null;
}

export interface RelationOutcomeRow {
  relation_kind: 'timeline' | 'link';
  sequence: number;
  relation_digest: string;
  source_id: string;
  apply_job_id: string | number;
  target_slug: string;
  observed_row_id: string | number;
  outcome: 'applied' | 'already_applied';
  write_through: WriteThroughResult | null;
}

interface ApplicationProgress {
  pageApplied: number;
  totalPages: number;
  timelineApplied: number;
  linkApplied: number;
}

interface TimelineRow {
  id: string | number;
  source: string;
  detail: string;
  ref_slug: string | null;
  ref_label: string | null;
}

interface LinkRow {
  id: string | number;
  context: string;
  link_source: string | null;
}

/** Parse the shared exact authority envelope and reject extra model fields. */
export function parseProposalApplicationAuthorityInput(
  raw: unknown,
): ProposalApplicationAuthorityInput {
  const input = readRecord(raw, 'proposal application authority');
  assertExactKeys(
    input,
    ['proposal_job_id', 'proposal_digest', 'source_id'],
    'proposal application authority',
  );
  return parseAuthorityFields(input);
}

/** Parse the only caller-selectable fields for one frozen relation. */
export function parseApplyProposalRelationInput(raw: unknown): ApplyProposalRelationInput {
  const input = readRecord(raw, 'apply proposal relation input');
  assertExactKeys(
    input,
    ['proposal_job_id', 'proposal_digest', 'relation_kind', 'sequence', 'source_id'],
    'apply proposal relation input',
  );
  const authority = parseAuthorityFields(input);
  if (input.relation_kind !== 'timeline' && input.relation_kind !== 'link') {
    throw new AgentJobProposalError('invalid_params', 'relation_kind must be timeline or link.');
  }
  return {
    ...authority,
    relation_kind: input.relation_kind,
    sequence: readPositiveInteger(input.sequence, 'sequence'),
  };
}

/**
 * Verify the apply job's complete frozen authority and establish preflight.
 *
 * When no effect receipt exists, every page and relation is checked before
 * this transaction may mutate the corpus. Once progress exists, the durable
 * preflight row and each individual slot's current-state check govern resume.
 */
export async function ensureProposalApplicationPreflight(
  engine: BrainEngine,
  applyJobId: number,
  rawInput: ProposalApplicationAuthorityInput,
): Promise<ProposalApplicationContext> {
  const input = parseAuthorityFields(readRecord(rawInput, 'proposal application authority'));
  const binding = await readApplyJobBinding(engine, applyJobId, true);
  const authority = await getOwnedApprovedProposalAuthority(
    engine,
    input.proposal_job_id,
    binding.ownerClientId,
    input.proposal_digest,
  );
  assertAuthorityMatches(binding, authority, input);

  const existing = await readApplicationRun(engine, input, true);
  if (existing) assertApplicationRunMatches(existing, binding, authority);
  const progress = await readApplicationProgress(engine, input);
  if (progress.pageApplied + progress.timelineApplied + progress.linkApplied === 0) {
    await preflightFrozenInventory(engine, authority);
    await engine.executeRaw(
      `INSERT INTO ingestion_proposal_application_runs
         (proposal_id, proposal_digest, owner_client_id, source_id, artifact_id,
          admission_scope, capture_page_slug, inventory_digest,
          first_apply_job_id, last_apply_job_id, preflight_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now())
       ON CONFLICT (proposal_id, proposal_digest) DO UPDATE SET
         last_apply_job_id = EXCLUDED.last_apply_job_id,
         updated_at = now()`,
      [
        authority.proposalJobId,
        authority.proposalDigest,
        authority.ownerClientId,
        authority.sourceId,
        authority.artifactId,
        authority.admissionScope,
        authority.capturePageSlug,
        authority.inventoryDigest,
        applyJobId,
      ],
    );
  } else if (!existing) {
    throw new AgentJobProposalError(
      'invalid_apply_receipt',
      'Proposal effects exist without a durable whole-plan preflight receipt.',
    );
  } else {
    await engine.executeRaw(
      `UPDATE ingestion_proposal_application_runs
          SET last_apply_job_id = $3, updated_at = now()
        WHERE proposal_id = $1 AND proposal_digest = $2`,
      [authority.proposalJobId, authority.proposalDigest, applyJobId],
    );
  }
  const stored = await readApplicationRun(engine, input, true);
  if (!stored) {
    throw new AgentJobProposalError('invalid_apply_receipt', 'Proposal preflight receipt was not persisted.');
  }
  assertApplicationRunMatches(stored, binding, authority);
  return { binding, authority, input };
}

/** Enforce contiguous page-first execution while permitting exact replay. */
export async function assertNextProposalPage(
  engine: BrainEngine,
  input: ProposalApplicationAuthorityInput & { sequence: number },
): Promise<void> {
  const rows = await engine.executeRaw<{ sequence: number; applied_at: string | null }>(
    `SELECT sequence, applied_at
       FROM ingestion_proposal_authority_pages
      WHERE proposal_id = $1
      ORDER BY sequence`,
    [input.proposal_job_id],
  );
  const selected = rows[input.sequence - 1];
  if (!selected || selected.sequence !== input.sequence) {
    throw new AgentJobProposalError('off_plan_page', 'Requested page sequence is outside the frozen proposal.');
  }
  if (selected.applied_at !== null) return;
  const applied = rows.filter(row => row.applied_at !== null);
  if (input.sequence !== applied.length + 1 || rows.slice(0, input.sequence - 1).some(row => row.applied_at === null)) {
    throw new AgentJobProposalError('out_of_order', 'Apply proposal pages in exact one-based order.');
  }
  const relations = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM ingestion_proposal_relation_outcomes
      WHERE proposal_id = $1 AND proposal_digest = $2`,
    [input.proposal_job_id, input.proposal_digest],
  );
  if (Number(relations[0]?.count ?? 0) > 0) {
    throw new AgentJobProposalError('out_of_order', 'Page application cannot follow relation application.');
  }
}

/** Enforce pages, then timelines, then links, with contiguous per-kind slots. */
export async function assertNextProposalRelation(
  engine: BrainEngine,
  context: ProposalApplicationContext,
  input: ApplyProposalRelationInput,
): Promise<void> {
  const manifest = input.relation_kind === 'timeline'
    ? context.authority.timelineDigests
    : context.authority.linkDigests;
  if (!manifest[input.sequence - 1] || manifest[input.sequence - 1]!.sequence !== input.sequence) {
    throw new AgentJobProposalError('off_plan_relation', 'Requested relation sequence is outside the frozen proposal.');
  }
  const progress = await readApplicationProgress(engine, input);
  if (progress.pageApplied !== progress.totalPages) {
    throw new AgentJobProposalError('out_of_order', 'Apply every page before proposal relations.');
  }
  if (input.relation_kind === 'timeline') {
    if (progress.linkApplied > 0 || input.sequence !== progress.timelineApplied + 1) {
      throw new AgentJobProposalError('out_of_order', 'Apply timeline entries in exact one-based order before links.');
    }
    return;
  }
  if (
    progress.timelineApplied !== context.authority.timelineDigests.length
    || input.sequence !== progress.linkApplied + 1
  ) {
    throw new AgentJobProposalError('out_of_order', 'Apply every timeline entry, then links in exact one-based order.');
  }
}

/** Read one durable relation outcome for replay, if it exists. */
export async function readProposalRelationOutcome(
  engine: BrainEngine,
  input: ApplyProposalRelationInput,
  lock: boolean,
): Promise<RelationOutcomeRow | null> {
  const rows = await engine.executeRaw<RelationOutcomeRow>(
    `SELECT relation_kind, sequence, relation_digest, source_id, apply_job_id,
            target_slug, observed_row_id, outcome, write_through
       FROM ingestion_proposal_relation_outcomes
      WHERE proposal_id = $1 AND proposal_digest = $2
        AND relation_kind = $3 AND sequence = $4${lock ? ' FOR UPDATE' : ''}`,
    [input.proposal_job_id, input.proposal_digest, input.relation_kind, input.sequence],
  );
  return rows[0] ?? null;
}

/** Persist the external page mirror outcome after its DB receipt commits. */
export async function recordProposalPageWriteThrough(
  engine: BrainEngine,
  input: ProposalApplicationAuthorityInput & { sequence: number },
  result: WriteThroughResult,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE ingestion_proposal_authority_pages
        SET applied_write_through = $3::text::jsonb
      WHERE proposal_id = $1 AND sequence = $2 AND applied_at IS NOT NULL`,
    [input.proposal_job_id, input.sequence, canonicalProposalJson(result)],
  );
}

/** Re-verify every frozen effect and persist the only complete success receipt. */
export async function finalizeAgentJobProposalApplication(
  engine: BrainEngine,
  applyJobId: number,
  rawInput: ProposalApplicationAuthorityInput,
): Promise<FinalizeProposalApplicationResult> {
  const input = parseProposalApplicationAuthorityInput(rawInput);
  return engine.transaction(async (tx) => {
    const context = await ensureProposalApplicationPreflight(tx, applyJobId, input);
    const pageRows = await readPageReceiptRows(tx, input.proposal_job_id);
    if (
      pageRows.length !== context.authority.pageDigests.length
      || pageRows.some(row => row.applied_at === null || !writeThroughComplete(row.applied_write_through))
    ) {
      throw new AgentJobProposalError('incomplete_application', 'Not every frozen page has complete durable application proof.');
    }
    for (const row of pageRows) {
      await verifyAppliedPage(
        tx,
        context.authority.sourceId,
        context.authority.capturePageSlug,
        row,
      );
    }

    const outcomes = await tx.executeRaw<RelationOutcomeRow>(
      `SELECT relation_kind, sequence, relation_digest, source_id, apply_job_id,
              target_slug, observed_row_id, outcome, write_through
         FROM ingestion_proposal_relation_outcomes
        WHERE proposal_id = $1 AND proposal_digest = $2
        ORDER BY CASE relation_kind WHEN 'timeline' THEN 0 ELSE 1 END, sequence`,
      [input.proposal_job_id, input.proposal_digest],
    );
    const timeline = outcomes.filter(row => row.relation_kind === 'timeline');
    const links = outcomes.filter(row => row.relation_kind === 'link');
    if (
      timeline.length !== context.authority.timelineDigests.length
      || links.length !== context.authority.linkDigests.length
      || timeline.some(row => !writeThroughComplete(row.write_through))
    ) {
      throw new AgentJobProposalError('incomplete_application', 'Not every frozen relation has complete durable application proof.');
    }
    for (const row of timeline) {
      const relation = context.authority.plan.proposedTimelineEntries[row.sequence - 1];
      await verifyTimelineOutcome(tx, context.authority, row, relation);
    }
    for (const row of links) {
      const relation = context.authority.plan.proposedLinks[row.sequence - 1];
      await verifyLinkOutcome(tx, context.authority, row, relation);
    }

    const core = {
      proposal_job_id: input.proposal_job_id,
      proposal_digest: input.proposal_digest,
      source_id: input.source_id,
      inventory_digest: context.authority.inventoryDigest,
      pages: {
        total: pageRows.length,
        applied: pageRows.length,
        rebased: pageRows.filter(row => row.applied_rebased).length,
      },
      timeline_entries: { total: timeline.length, applied: timeline.length },
      links: { total: links.length, applied: links.length },
    };
    const receiptDigest = digestProposalValue(core);
    const run = await readApplicationRun(tx, input, true);
    if (!run) throw new AgentJobProposalError('invalid_apply_receipt', 'Proposal preflight receipt is unavailable.');
    if (run.finalized_at !== null) {
      if (run.final_receipt_digest !== receiptDigest) {
        throw new AgentJobProposalError('invalid_apply_receipt', 'Stored final receipt does not match current proposal proof.');
      }
      return { ...core, status: 'already_finalized', receipt_digest: receiptDigest };
    }
    const receipt: FinalizeProposalApplicationResult = {
      ...core,
      status: 'applied_proposal',
      receipt_digest: receiptDigest,
    };
    await tx.executeRaw(
      `UPDATE ingestion_proposal_application_runs
          SET final_receipt = $3::text::jsonb, final_receipt_digest = $4,
              finalized_at = now(), last_apply_job_id = $5, updated_at = now()
        WHERE proposal_id = $1 AND proposal_digest = $2 AND finalized_at IS NULL`,
      [
        input.proposal_job_id,
        input.proposal_digest,
        canonicalProposalJson(receipt),
        receiptDigest,
        applyJobId,
      ],
    );
    return receipt;
  });
}

async function preflightFrozenInventory(
  engine: BrainEngine,
  authority: ApprovedProposalAuthority,
): Promise<void> {
  const fragments = await readPageReceiptRows(engine, authority.proposalJobId);
  if (fragments.length !== authority.pageDigests.length) {
    throw new AgentJobProposalError('digest_mismatch', 'Frozen page inventory is incomplete.');
  }
  const planned = new Map(authority.plan.proposedPages.map(page => [page.slug, page.effect]));
  for (const fragment of fragments) {
    const page = parseProposalPage(fragment.page, {
      opaqueMarkdownForSlug: authority.capturePageSlug,
    });
    const baseline = baselineFromFragment(fragment, authority.capturePageSlug);
    if (digestFrozenProposalPage(page, baseline) !== fragment.page_digest) {
      throw new AgentJobProposalError('digest_mismatch', 'Frozen page inventory digest does not match.');
    }
    const current = await engine.getPage(page.slug, {
      sourceId: authority.sourceId,
      includeDeleted: true,
    });
    if (page.effect === 'create') {
      if (current) {
        throw new AgentJobProposalError(
          current.deleted_at ? 'page_unavailable' : 'page_exists',
          `Approved create target ${page.slug} is not absent; no mutation was performed.`,
        );
      }
      continue;
    }
    if (!current || current.deleted_at || !current.content_hash || !baseline) {
      throw new AgentJobProposalError('page_unavailable', `Approved update target ${page.slug} is missing or deleted.`);
    }
    if ('appendMarkdown' in page) {
      if (current.title !== baseline.title) {
        throw new AgentJobProposalError('stale_page', `Approved update target ${page.slug} changed title.`);
      }
      appendAttempt(current.compiled_truth, baseline, page.appendMarkdown);
    } else {
      rewriteAttempt(current as typeof current & { content_hash: string }, baseline, page);
    }
  }
  for (const entry of authority.plan.proposedTimelineEntries) {
    await assertVirtualPageExists(engine, authority.sourceId, planned, entry.pageSlug);
    await assertVirtualPageExists(engine, authority.sourceId, planned, entry.ref);
    const rows = await findTimelineIdentity(engine, authority.sourceId, entry);
    if (rows.length > 1 || (rows[0] && !timelineRowMatches(rows[0], entry))) {
      throw new AgentJobProposalError('relation_collision', 'A timeline identity collision does not match the frozen proposal.');
    }
  }
  for (const entry of authority.plan.proposedLinks) {
    await assertVirtualPageExists(engine, authority.sourceId, planned, entry.from);
    await assertVirtualPageExists(engine, authority.sourceId, planned, entry.to);
    const rows = await findLinkIdentity(engine, authority.sourceId, entry);
    if (rows.length > 1) {
      throw new AgentJobProposalError('relation_collision', 'Multiple existing links collide with one frozen relation slot.');
    }
  }
}

async function assertVirtualPageExists(
  engine: BrainEngine,
  sourceId: string,
  planned: ReadonlyMap<string, ScopedProposalPage['effect']>,
  slug: string,
): Promise<void> {
  if (planned.get(slug) === 'create') return;
  const page = await engine.getPage(slug, { sourceId, includeDeleted: true });
  if (!page || page.deleted_at) {
    throw new AgentJobProposalError('relation_target_unavailable', `Frozen relation target ${slug} is missing or deleted.`);
  }
}

async function readApplicationRun(
  engine: BrainEngine,
  input: ProposalApplicationAuthorityInput,
  lock: boolean,
): Promise<ApplicationRunRow | null> {
  const rows = await engine.executeRaw<ApplicationRunRow>(
    `SELECT proposal_id, proposal_digest, owner_client_id, source_id, artifact_id,
            admission_scope, capture_page_slug, inventory_digest,
            final_receipt, final_receipt_digest, finalized_at
       FROM ingestion_proposal_application_runs
      WHERE proposal_id = $1 AND proposal_digest = $2${lock ? ' FOR UPDATE' : ''}`,
    [input.proposal_job_id, input.proposal_digest],
  );
  return rows[0] ?? null;
}

async function readApplicationProgress(
  engine: BrainEngine,
  input: ProposalApplicationAuthorityInput,
): Promise<ApplicationProgress> {
  const [row] = await engine.executeRaw<{
    page_applied: number;
    total_pages: number;
    timeline_applied: number;
    link_applied: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM ingestion_proposal_authority_pages
         WHERE proposal_id = $1 AND applied_at IS NOT NULL) AS page_applied,
       (SELECT COUNT(*)::int FROM ingestion_proposal_authority_pages
         WHERE proposal_id = $1) AS total_pages,
       (SELECT COUNT(*)::int FROM ingestion_proposal_relation_outcomes
         WHERE proposal_id = $1 AND proposal_digest = $2 AND relation_kind = 'timeline') AS timeline_applied,
       (SELECT COUNT(*)::int FROM ingestion_proposal_relation_outcomes
         WHERE proposal_id = $1 AND proposal_digest = $2 AND relation_kind = 'link') AS link_applied`,
    [input.proposal_job_id, input.proposal_digest],
  );
  return {
    pageApplied: Number(row?.page_applied ?? 0),
    totalPages: Number(row?.total_pages ?? 0),
    timelineApplied: Number(row?.timeline_applied ?? 0),
    linkApplied: Number(row?.link_applied ?? 0),
  };
}

interface PageReceiptRow extends StoredProposalFragment {
  applied_previous_content_hash: string | null;
  applied_content_hash: string | null;
  applied_rebased: boolean | null;
  applied_write_through: WriteThroughResult | null;
  applied_at: string | null;
}

async function readPageReceiptRows(engine: BrainEngine, proposalId: number): Promise<PageReceiptRow[]> {
  return engine.executeRaw<PageReceiptRow>(
    `SELECT f.sequence, f.total_pages, p.owner_client_id, p.source_id, p.artifact_id,
            p.admission_scope, f.page, f.page_digest, f.baseline_title,
            f.baseline_markdown, f.baseline_content_hash,
            f.applied_previous_content_hash, f.applied_content_hash, f.applied_rebased,
            f.applied_write_through, f.applied_at
       FROM ingestion_proposal_authority_pages f
       JOIN ingestion_proposal_authorities p ON p.proposal_id = f.proposal_id
      WHERE f.proposal_id = $1 ORDER BY f.sequence`,
    [proposalId],
  );
}

async function verifyAppliedPage(
  engine: BrainEngine,
  sourceId: string,
  capturePageSlug: string,
  row: PageReceiptRow,
): Promise<void> {
  const page = parseProposalPage(row.page, {
    opaqueMarkdownForSlug: capturePageSlug,
  });
  const current = await engine.getPage(page.slug, { sourceId, includeDeleted: true });
  if (!current || current.deleted_at || !row.applied_content_hash || current.content_hash !== row.applied_content_hash) {
    throw new AgentJobProposalError('stale_page', `Applied page ${page.slug} no longer matches its receipt.`);
  }
  if (page.effect === 'create' && (current.title !== page.title || current.compiled_truth !== page.bodyMarkdown)) {
    throw new AgentJobProposalError('stale_page', `Applied create ${page.slug} no longer matches its frozen body.`);
  }
  if (page.effect === 'update' && !row.applied_previous_content_hash) {
    throw new AgentJobProposalError('invalid_apply_receipt', `Applied update ${page.slug} has incomplete hash proof.`);
  }
}

/** Query all rows that collide with a proposal timeline's semantic identity. */
export async function findTimelineIdentity(
  engine: BrainEngine,
  sourceId: string,
  entry: ProposalTimelineEntry,
): Promise<TimelineRow[]> {
  return engine.executeRaw<TimelineRow>(
    `SELECT te.id, te.source, te.detail, te.ref_slug, te.ref_label
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
        AND te.date = $3::date AND te.summary = $4
      ORDER BY te.id`,
    [sourceId, entry.pageSlug, entry.date, entry.text],
  );
}

/** Query all same-source edges that collide with one frozen typed link. */
export async function findLinkIdentity(
  engine: BrainEngine,
  sourceId: string,
  entry: ProposalLink,
): Promise<LinkRow[]> {
  return engine.executeRaw<LinkRow>(
    `SELECT l.id, l.context, l.link_source
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.source_id = $1 AND t.source_id = $1
        AND f.slug = $2 AND t.slug = $3 AND l.link_type = $4
      ORDER BY l.id`,
    [sourceId, entry.from, entry.to, entry.type],
  );
}

/** Re-read the exact row named by one durable relation receipt. */
export async function verifyProposalRelationOutcome(
  engine: BrainEngine,
  authority: ApprovedProposalAuthority,
  row: RelationOutcomeRow,
): Promise<void> {
  if (row.relation_kind === 'timeline') {
    const entry = authority.plan.proposedTimelineEntries[row.sequence - 1];
    await verifyTimelineOutcome(engine, authority, row, entry);
    return;
  }
  const entry = authority.plan.proposedLinks[row.sequence - 1];
  await verifyLinkOutcome(engine, authority, row, entry);
}

/** Check the non-content timeline fields represented by a frozen relation. */
export function timelineRowMatches(row: TimelineRow, entry: ProposalTimelineEntry): boolean {
  return row.source === ''
    && row.detail === ''
    && row.ref_slug === entry.ref
    && row.ref_label === (entry.refLabel ?? null);
}

async function verifyTimelineOutcome(
  engine: BrainEngine,
  authority: ApprovedProposalAuthority,
  row: RelationOutcomeRow,
  entry: ProposalTimelineEntry | undefined,
): Promise<void> {
  if (!entry || row.relation_digest !== digestProposalRelation('timeline', entry)) {
    throw new AgentJobProposalError('invalid_apply_receipt', 'Timeline receipt does not match its frozen slot.');
  }
  const rows = await findTimelineIdentity(engine, authority.sourceId, entry);
  const observed = rows.find(candidate => Number(candidate.id) === Number(row.observed_row_id));
  if (!observed || !timelineRowMatches(observed, entry)) {
    throw new AgentJobProposalError('stale_relation', 'Applied timeline relation is missing or changed.');
  }
}

async function verifyLinkOutcome(
  engine: BrainEngine,
  authority: ApprovedProposalAuthority,
  row: RelationOutcomeRow,
  entry: ProposalLink | undefined,
): Promise<void> {
  if (!entry || row.relation_digest !== digestProposalRelation('link', entry)) {
    throw new AgentJobProposalError('invalid_apply_receipt', 'Link receipt does not match its frozen slot.');
  }
  const rows = await findLinkIdentity(engine, authority.sourceId, entry);
  if (!rows.some(candidate => Number(candidate.id) === Number(row.observed_row_id))) {
    throw new AgentJobProposalError('stale_relation', 'Applied link relation is missing or changed.');
  }
}

function assertAuthorityMatches(
  binding: ApplyJobBinding,
  authority: ApprovedProposalAuthority,
  input: ProposalApplicationAuthorityInput,
): void {
  if (
    input.proposal_job_id !== authority.proposalJobId
    || input.proposal_digest !== authority.proposalDigest
    || input.source_id !== authority.sourceId
    || binding.approvedProposalJobId !== authority.proposalJobId
    || binding.approvedProposalDigest !== authority.proposalDigest
    || binding.ownerClientId !== authority.ownerClientId
    || binding.sourceId !== authority.sourceId
    || binding.artifactId !== authority.artifactId
    || binding.admissionScope !== authority.admissionScope
    || binding.capturePageSlug !== authority.capturePageSlug
    || canonicalProposalJson(binding.approvedPageDigests) !== canonicalProposalJson(authority.pageDigests)
    || canonicalProposalJson(binding.approvedTimelineDigests) !== canonicalProposalJson(authority.timelineDigests)
    || canonicalProposalJson(binding.approvedLinkDigests) !== canonicalProposalJson(authority.linkDigests)
    || binding.approvedInventoryDigest !== authority.inventoryDigest
  ) {
    throw new AgentJobProposalError('permission_denied', 'Apply job authority does not match the complete frozen proposal.');
  }
}

function assertApplicationRunMatches(
  run: ApplicationRunRow,
  binding: ApplyJobBinding,
  authority: ApprovedProposalAuthority,
): void {
  if (
    Number(run.proposal_id) !== authority.proposalJobId
    || run.proposal_digest !== authority.proposalDigest
    || run.owner_client_id !== binding.ownerClientId
    || run.source_id !== binding.sourceId
    || run.artifact_id !== binding.artifactId
    || run.admission_scope !== binding.admissionScope
    || run.capture_page_slug !== binding.capturePageSlug
    || run.inventory_digest !== binding.approvedInventoryDigest
  ) {
    throw new AgentJobProposalError('invalid_apply_receipt', 'Proposal application receipt does not match frozen authority.');
  }
}

function writeThroughComplete(raw: WriteThroughResult | null): boolean {
  if (!raw) return false;
  return raw.written === true || raw.skipped === 'no_repo_configured';
}

function parseAuthorityFields(input: Record<string, unknown>): ProposalApplicationAuthorityInput {
  const proposalJobId = readPositiveInteger(input.proposal_job_id, 'proposal_job_id');
  const proposalDigest = readString(input.proposal_digest, 'proposal_digest');
  const sourceId = readString(input.source_id, 'source_id');
  if (!SHA256_RE.test(proposalDigest)) {
    throw new AgentJobProposalError('invalid_digest', 'proposal_digest must be lowercase SHA-256.');
  }
  assertValidSourceId(sourceId);
  return { proposal_job_id: proposalJobId, proposal_digest: proposalDigest, source_id: sourceId };
}

function readRecord(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentJobProposalError('invalid_params', `${name} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

function readString(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AgentJobProposalError('invalid_params', `${name} must be a non-empty string.`);
  }
  return raw;
}

function readPositiveInteger(raw: unknown, name: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) {
    throw new AgentJobProposalError('invalid_params', `${name} must be a positive integer.`);
  }
  return Number(raw);
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AgentJobProposalError('invalid_params', `${name} must contain exactly: ${expected.join(', ')}.`);
  }
}
