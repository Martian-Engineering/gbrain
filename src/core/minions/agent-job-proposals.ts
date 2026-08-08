import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { matchesSlugAllowList } from '../slug-allow-list.ts';
import {
  AgentJobProposalError,
  PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
  PROPOSAL_MAX_PAGES,
  PROPOSAL_STAGE_INPUT_MAX_BYTES,
  STAGE_PROPOSAL_TOOL_NAME,
  assertExactPageInventory,
  assertPageMatchesInventorySlot,
  canonicalProposalJson,
  digestProposalValue,
  isCanonicalProposalSlug,
  nextExpectedInventorySlot,
  parseProposalPage,
  parseProposalPageInventory,
  parseStageProposalPageCore,
  parseStageProposalPageInput,
  proposalToolInputBytes,
  type ParsedStageProposalPageCore,
  type ParsedStageProposalPageInput,
  type ProposalPageDigest,
  type ProposalPageInventoryEntry,
  type ScopedProposalPage,
  type StageProposalPageInput,
  type StageProposalPageResult,
} from '../ingestion-proposal-contract.ts';

export {
  AgentJobProposalError,
  PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
  PROPOSAL_MAX_PAGES,
  PROPOSAL_STAGE_INPUT_MAX_BYTES,
  STAGE_PROPOSAL_TOOL_NAME,
  canonicalProposalJson,
  digestProposalValue,
  proposalToolInputBytes,
} from '../ingestion-proposal-contract.ts';
export type {
  ProposalPageDigest,
  ProposalPageInventoryEntry,
  ScopedProposalPage,
  StageProposalPageInput,
  StageProposalPageResult,
} from '../ingestion-proposal-contract.ts';
/** Maximum UTF-8 size of one finalized, canonical proposal plan. */
export const PROPOSAL_AGGREGATE_MAX_BYTES = 98_304;

/** Maximum UTF-8 size after the canonical plan is embedded as a JSON string. */
export const PROPOSAL_ESCAPED_PLAN_MAX_BYTES = 98_304;

/** Maximum UTF-8 size of the compact receipt manifest. */
export const PROPOSAL_MANIFEST_MAX_BYTES = 262_144;

export const FINALIZE_PROPOSAL_TOOL_NAME = 'brain_finalize_ingestion_proposal';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ScopedProposalTimelineEntry {
  pageSlug: string;
  date: string;
  text: string;
  ref: string;
  refLabel?: string;
}

export interface ScopedProposalLink {
  from: string;
  to: string;
  type: string;
}

export interface ScopedAdmissionProposalPlan {
  artifactId: string;
  sourceId: string;
  admissionScope: string;
  summary: string;
  proposedPages: ScopedProposalPage[];
  proposedTimelineEntries: ScopedProposalTimelineEntry[];
  proposedLinks: ScopedProposalLink[];
  unresolved: string[];
}
export interface FinalizeProposalInput {
  artifact_id: string;
  source_id: string;
  admission_scope: string;
  total_pages: number;
  summary: string;
  proposed_timeline_entries?: unknown;
  proposed_links?: unknown;
  unresolved?: unknown;
}

export interface FinalizedProposalManifest {
  status: 'staged_proposal';
  artifactId: string;
  sourceId: string;
  admissionScope: string;
  summary: string;
  pageDigests: ProposalPageDigest[];
  proposalDigest: string;
  proposedTimelineEntries: ScopedProposalTimelineEntry[];
  proposedLinks: ScopedProposalLink[];
  unresolved: string[];
}

interface JobBinding {
  ownerClientId: string;
  sourceId: string;
  artifactId: string;
  admissionScope: string | null;
  capturePageSlug: string;
  allowedSlugPrefixes: string[];
  pageInventory: unknown;
}
interface StoredProposalFragment {
  sequence: number;
  total_pages: number;
  owner_client_id: string;
  source_id: string;
  artifact_id: string;
  admission_scope: string;
  page: unknown;
  page_digest: string;
}

interface ProposalTurnBlock {
  type?: unknown;
  name?: unknown;
  toolName?: unknown;
  input?: unknown;
}

/**
 * Validate page-staging calls before an assistant turn is persisted.
 *
 * A turn may stage at most one page. Both stage and finalize inputs are byte
 * bounded here so rejected raw inputs never reach either durable transcript
 * table. Callers repeat this check immediately before legacy replay writes as
 * defense in depth.
 */
export function assertProposalToolTurnPersistable(blocks: readonly ProposalTurnBlock[]): void {
  const calls = proposalToolCalls(blocks);
  const stageCalls = calls.filter((call) => call.name === STAGE_PROPOSAL_TOOL_NAME);
  const finalizeCalls = calls.filter((call) => call.name === FINALIZE_PROPOSAL_TOOL_NAME);
  if (stageCalls.length > 1) {
    throw new AgentJobProposalError(
      'multiple_stage_calls',
      'Stage exactly one proposal page per agent turn.',
    );
  }
  if (stageCalls.length > 0 && finalizeCalls.length > 0) {
    throw new AgentJobProposalError(
      'mixed_proposal_calls',
      'Stage and finalize proposal calls must occur in separate agent turns.',
    );
  }
  for (const call of calls) {
    if (call.name !== STAGE_PROPOSAL_TOOL_NAME && call.name !== FINALIZE_PROPOSAL_TOOL_NAME) continue;
    const bytes = proposalToolInputBytes(call.input);
    if (bytes > PROPOSAL_STAGE_INPUT_MAX_BYTES) {
      throw new AgentJobProposalError(
        'stage_input_too_large',
        `Proposal tool input is ${bytes} UTF-8 bytes; maximum is ${PROPOSAL_STAGE_INPUT_MAX_BYTES}.`,
      );
    }
  }
}

/**
 * Check cumulative staged bytes before persisting a fresh assistant turn.
 *
 * The same-sequence, same-content replay contributes zero new bytes. The
 * staging transaction repeats this check while holding the job row lock.
 */
export async function assertProposalToolTurnPersistableForJob(
  engine: BrainEngine,
  jobId: number,
  blocks: readonly ProposalTurnBlock[],
): Promise<void> {
  assertProposalToolTurnPersistable(blocks);
  const stageCall = proposalToolCalls(blocks)
    .find((call) => call.name === STAGE_PROPOSAL_TOOL_NAME);
  if (!stageCall) return;
  // Inventory semantics intentionally remain an execution-time tool result so
  // the agent can correct a bad plan in the same job. This pre-persistence
  // boundary only enforces transcript size and cumulative staged page bytes.
  const candidate = parseStageProposalPageCore(stageCall.input);

  await engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, candidate);
    assertSlugAllowed(binding, candidate.page.slug, 'Proposed page');
    const fragments = await readStoredFragments(tx, jobId);
    assertCumulativeStageFits(binding, candidate, fragments);
  });
}

/** Extract provider-neutral and legacy proposal tool-call shapes. */
function proposalToolCalls(blocks: readonly ProposalTurnBlock[]): Array<{ name: string; input: unknown }> {
  return blocks.flatMap((block) => {
    const isCall = block.type === 'tool_use' || block.type === 'tool-call';
    if (!isCall) return [];
    const name = typeof block.name === 'string'
      ? block.name
      : typeof block.toolName === 'string'
        ? block.toolName
        : '';
    return [{ name, input: block.input }];
  });
}

/** Stage one exact page proposal in the current agent job's durable ledger. */
export async function stageAgentJobProposalPage(
  engine: BrainEngine,
  jobId: number,
  input: StageProposalPageInput,
): Promise<StageProposalPageResult> {
  assertSafeJobId(jobId);
  const candidate = parseStageProposalPageInput(input);

  return engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, candidate);
    assertPageInventoryForBinding(binding, candidate.pageInventory);
    const frozenInventory = parseFrozenPageInventory(binding, candidate.totalPages);
    if (frozenInventory) assertExactPageInventory(frozenInventory, candidate.pageInventory);
    assertPageMatchesInventorySlot(candidate);
    const finalized = await tx.executeRaw<{ proposal_digest: string }>(
      `SELECT proposal_digest FROM agent_job_proposals WHERE job_id = $1`,
      [jobId],
    );
    if (finalized.length > 0) {
      throw new AgentJobProposalError('proposal_finalized', 'This job proposal is already finalized.');
    }

    await assertFirstInventoryEffectsMatchCorpus(tx, binding, candidate.pageInventory);
    const fragments = await readStoredFragments(tx, jobId);
    const replay = assertCumulativeStageFits(binding, candidate, fragments);
    const frozenBinding = await freezeProposalBinding(
      tx,
      jobId,
      binding,
      candidate.admissionScope,
      candidate.pageInventory,
    );
    if (replay) {
      return {
        sequence: candidate.sequence,
        slug: candidate.page.slug,
        digest: candidate.pageDigest,
        nextExpectedSlot: nextExpectedInventorySlot(candidate.pageInventory, fragments),
      };
    }

    await tx.executeRaw(
      `INSERT INTO agent_job_proposal_fragments
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          sequence, total_pages, page, page_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9)
       ON CONFLICT (job_id, sequence) DO NOTHING`,
      [
        jobId, frozenBinding.ownerClientId, frozenBinding.sourceId, frozenBinding.artifactId,
        frozenBinding.admissionScope, candidate.sequence, candidate.totalPages,
        canonicalProposalJson(candidate.page), candidate.pageDigest,
      ],
    );
    return {
      sequence: candidate.sequence,
      slug: candidate.page.slug,
      digest: candidate.pageDigest,
      nextExpectedSlot: nextExpectedInventorySlot(candidate.pageInventory, [
        ...fragments,
        { sequence: candidate.sequence },
      ]),
    };
  });
}

/** Assemble, validate, cap, digest, and freeze the current job's staged plan. */
export async function finalizeAgentJobProposal(
  engine: BrainEngine,
  jobId: number,
  input: FinalizeProposalInput,
): Promise<FinalizedProposalManifest> {
  assertSafeJobId(jobId);
  if (proposalToolInputBytes(input) > PROPOSAL_STAGE_INPUT_MAX_BYTES) {
    throw new AgentJobProposalError('finalize_input_too_large', 'Proposal finalization input exceeds the tool byte limit.');
  }
  const totalPages = readProposalPageCount(input.total_pages);
  const artifactId = readBoundedString(input.artifact_id, 'artifact_id', 255);
  const sourceId = readBoundedString(input.source_id, 'source_id', 255);
  assertValidSourceId(sourceId);
  const admissionScope = readBoundedString(
    input.admission_scope,
    'admission_scope',
    PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
  );
  const summary = readBoundedString(input.summary, 'summary', 1_000);
  const timeline = parseTimelineEntries(input.proposed_timeline_entries ?? []);
  const links = parseLinks(input.proposed_links ?? []);
  const unresolved = parseUnresolved(input.unresolved ?? []);

  return engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, { artifactId, sourceId, admissionScope });
    const boundScope = requireBoundAdmissionScope(binding);
    const inventory = requireFrozenPageInventory(binding, totalPages);
    assertPageInventoryForBinding(binding, inventory);
    const fragments = await readStoredFragments(tx, jobId);
    if (fragments.length !== totalPages) {
      throw new AgentJobProposalError(
        'fragment_gap',
        `Expected ${totalPages} staged pages but found ${fragments.length}.`,
      );
    }

    const pages: ScopedProposalPage[] = [];
    const pageDigests: ProposalPageDigest[] = [];
    const seenSlugs = new Set<string>();
    for (let index = 0; index < fragments.length; index++) {
      const expectedSequence = index + 1;
      const fragment = fragments[index]!;
      if (Number(fragment.sequence) !== expectedSequence || Number(fragment.total_pages) !== totalPages) {
        throw new AgentJobProposalError('fragment_gap', 'Staged proposal sequences are not exactly contiguous.');
      }
      if (
        fragment.owner_client_id !== binding.ownerClientId
        || fragment.source_id !== binding.sourceId
        || fragment.artifact_id !== binding.artifactId
        || fragment.admission_scope !== boundScope
      ) {
        throw new AgentJobProposalError('binding_mismatch', 'A staged fragment does not match its job binding.');
      }
      const page = parseProposalPage(fragment.page);
      if (
        digestProposalValue(page) !== fragment.page_digest
      ) {
        throw new AgentJobProposalError('digest_mismatch', `Digest mismatch at sequence ${expectedSequence}.`);
      }
      if (seenSlugs.has(page.slug)) {
        throw new AgentJobProposalError('duplicate_page', `Proposal contains duplicate page slug ${page.slug}.`);
      }
      assertPageMatchesInventorySlot({
        sequence: expectedSequence,
        page,
        pageInventory: inventory,
      });
      assertSlugAllowed(binding, page.slug, 'Proposed page');
      seenSlugs.add(page.slug);
      pages.push(page);
      pageDigests.push({ sequence: expectedSequence, slug: page.slug, digest: fragment.page_digest });
    }
    validatePlanRelations(binding, seenSlugs, timeline, links);

    const plan: ScopedAdmissionProposalPlan = {
      artifactId: binding.artifactId,
      sourceId: binding.sourceId,
      admissionScope: boundScope,
      summary,
      proposedPages: pages,
      proposedTimelineEntries: timeline,
      proposedLinks: links,
      unresolved,
    };
    const planJson = canonicalProposalJson(plan);
    const planBytes = Buffer.byteLength(planJson, 'utf8');
    if (planBytes > PROPOSAL_AGGREGATE_MAX_BYTES) {
      throw new AgentJobProposalError(
        'proposal_too_large',
        `Finalized proposal is ${planBytes} UTF-8 bytes; maximum is ${PROPOSAL_AGGREGATE_MAX_BYTES}.`,
      );
    }
    const escapedPlanBytes = Buffer.byteLength(JSON.stringify(planJson), 'utf8');
    if (escapedPlanBytes > PROPOSAL_ESCAPED_PLAN_MAX_BYTES) {
      throw new AgentJobProposalError(
        'proposal_too_large',
        `Escaped finalized proposal is ${escapedPlanBytes} UTF-8 bytes; maximum is ${PROPOSAL_ESCAPED_PLAN_MAX_BYTES}.`,
      );
    }
    const proposalDigest = digestProposalValue(plan);
    const manifest: FinalizedProposalManifest = {
      status: 'staged_proposal',
      artifactId: binding.artifactId,
      sourceId: binding.sourceId,
      admissionScope: boundScope,
      summary,
      pageDigests,
      proposalDigest,
      proposedTimelineEntries: timeline,
      proposedLinks: links,
      unresolved,
    };
    const manifestJson = canonicalProposalJson(manifest);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');
    if (manifestBytes > PROPOSAL_MANIFEST_MAX_BYTES) {
      throw new AgentJobProposalError(
        'manifest_too_large',
        `Compact proposal manifest is ${manifestBytes} UTF-8 bytes; maximum is ${PROPOSAL_MANIFEST_MAX_BYTES}.`,
      );
    }

    await tx.executeRaw(
      `INSERT INTO agent_job_proposals
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          total_pages, page_digests, plan, proposal_digest, manifest)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9, $10::text::jsonb)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        jobId, binding.ownerClientId, binding.sourceId, binding.artifactId,
        boundScope, totalPages, canonicalProposalJson(pageDigests),
        planJson, proposalDigest, manifestJson,
      ],
    );
    const stored = await tx.executeRaw<{
      proposal_digest: string;
      manifest: FinalizedProposalManifest;
    }>(
      `SELECT proposal_digest, manifest FROM agent_job_proposals WHERE job_id = $1`,
      [jobId],
    );
    if (!stored[0] || stored[0].proposal_digest !== proposalDigest) {
      throw new AgentJobProposalError('conflicting_finalization', 'This job already has a different finalized proposal.');
    }
    return stored[0].manifest;
  });
}

/** Retrieve a frozen full plan by exact job owner and proposal digest. */
export async function getOwnedAgentJobProposal(
  engine: BrainEngine,
  jobId: number,
  ownerClientId: string,
  proposalDigest: string,
): Promise<{
  id: number;
  proposal_digest: string;
  page_digests: ProposalPageDigest[];
  plan: ScopedAdmissionProposalPlan;
}> {
  assertSafeJobId(jobId);
  if (!ownerClientId) {
    throw new AgentJobProposalError('permission_denied', 'An OAuth client owner is required.');
  }
  if (!SHA256_RE.test(proposalDigest)) {
    throw new AgentJobProposalError('invalid_digest', 'proposal_digest must be 64 lowercase hexadecimal characters.');
  }
  const rows = await engine.executeRaw<{
    owner_client_id: string;
    proposal_digest: string;
    page_digests: ProposalPageDigest[];
    plan: ScopedAdmissionProposalPlan;
  }>(
    `SELECT owner_client_id, proposal_digest, page_digests, plan
       FROM agent_job_proposals
      WHERE job_id = $1 AND owner_client_id = $2 AND proposal_digest = $3`,
    [jobId, ownerClientId, proposalDigest],
  );
  if (!rows[0]) {
    throw new AgentJobProposalError('permission_denied', 'Agent job proposal is not owned by this OAuth client or its digest does not match.');
  }
  const plan = rows[0].plan;
  if (digestProposalValue(plan) !== proposalDigest) {
    throw new AgentJobProposalError('digest_mismatch', 'Stored proposal content does not match its digest.');
  }
  const pageDigests = rows[0].page_digests;
  if (
    !Array.isArray(pageDigests)
    || pageDigests.length !== plan.proposedPages.length
    || pageDigests.some((entry, index) => (
      entry.sequence !== index + 1
      || entry.slug !== plan.proposedPages[index]?.slug
      || entry.digest !== digestProposalValue(plan.proposedPages[index])
    ))
  ) {
    throw new AgentJobProposalError('digest_mismatch', 'Stored proposal page manifest does not match the frozen plan.');
  }
  return {
    id: jobId,
    proposal_digest: proposalDigest,
    page_digests: pageDigests,
    plan,
  };
}

async function readJobBinding(engine: BrainEngine, jobId: number, lock: boolean): Promise<JobBinding> {
  const rows = await engine.executeRaw<{
    name: string;
    owner_client_id: string | null;
    source_id: string | null;
    artifact_id: string | null;
    admission_scope: string | null;
    capture_page_slug: string | null;
    allowed_slug_prefixes: unknown;
    page_inventory: unknown;
  }>(
    `SELECT name,
            data->>'__owner_client_id' AS owner_client_id,
            data->>'source_id' AS source_id,
            data->>'proposal_artifact_id' AS artifact_id,
            data->>'proposal_admission_scope' AS admission_scope,
            data->>'proposal_capture_page_slug' AS capture_page_slug,
            data->'allowed_slug_prefixes' AS allowed_slug_prefixes,
            data->'proposal_page_inventory' AS page_inventory
       FROM minion_jobs
      WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  const row = rows[0];
  if (
    !row || row.name !== 'subagent' || !row.owner_client_id || !row.source_id
    || !row.artifact_id || !row.capture_page_slug
    || !Array.isArray(row.allowed_slug_prefixes)
    || row.allowed_slug_prefixes.length === 0
    || row.allowed_slug_prefixes.some((prefix) => typeof prefix !== 'string' || prefix.length === 0)
  ) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Agent job is not bound to an owner, source, proposal artifact, capture page, and slug fence.',
    );
  }
  const sourceId = row.source_id;
  assertValidSourceId(sourceId);
  const capturePageSlug = readCanonicalSlug(row.capture_page_slug, 'proposal_capture_page_slug');
  const allowedSlugPrefixes = row.allowed_slug_prefixes as string[];
  if (!matchesSlugAllowList(capturePageSlug, allowedSlugPrefixes)) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Agent job capture page is outside its bound slug fence.',
    );
  }
  return {
    ownerClientId: row.owner_client_id,
    sourceId,
    artifactId: row.artifact_id,
    admissionScope: row.admission_scope,
    capturePageSlug,
    allowedSlugPrefixes,
    pageInventory: row.page_inventory,
  };
}

function assertBindingMatches(
  binding: JobBinding,
  requested: Pick<ParsedStageProposalPageInput, 'artifactId' | 'sourceId' | 'admissionScope'>,
): void {
  if (
    requested.artifactId !== binding.artifactId
    || requested.sourceId !== binding.sourceId
    || (binding.admissionScope !== null && requested.admissionScope !== binding.admissionScope)
  ) {
    throw new AgentJobProposalError(
      'binding_mismatch',
      'Proposal artifact, source, or admission scope does not match the submitted agent job.',
    );
  }
}

/** Freeze the first valid stage's admission scope and complete page inventory together. */
async function freezeProposalBinding(
  engine: BrainEngine,
  jobId: number,
  binding: JobBinding,
  requestedScope: string,
  requestedInventory: ProposalPageInventoryEntry[],
): Promise<JobBinding & { admissionScope: string; pageInventory: ProposalPageInventoryEntry[] }> {
  if (
    binding.admissionScope === null
    || binding.pageInventory === null
    || binding.pageInventory === undefined
  ) {
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(
                jsonb_set(data, '{proposal_admission_scope}', to_jsonb($2::text), true),
                '{proposal_page_inventory}', $3::text::jsonb, true
              ),
              updated_at = now()
        WHERE id = $1`,
      [jobId, requestedScope, canonicalProposalJson(requestedInventory)],
    );
    binding.admissionScope = requestedScope;
    binding.pageInventory = requestedInventory;
  }
  if (binding.admissionScope !== requestedScope) {
    throw new AgentJobProposalError(
      'binding_mismatch',
      'Proposal admission scope does not match the scope frozen by the first staged page.',
    );
  }
  const frozenInventory = parseFrozenPageInventory(binding, requestedInventory.length);
  if (!frozenInventory) {
    throw new AgentJobProposalError('job_not_bound', 'Agent job page inventory was not frozen.');
  }
  assertExactPageInventory(frozenInventory, requestedInventory);
  return binding as JobBinding & {
    admissionScope: string;
    pageInventory: ProposalPageInventoryEntry[];
  };
}

/** Require finalization to use a scope already frozen by a staged page. */
function requireBoundAdmissionScope(binding: JobBinding): string {
  if (binding.admissionScope === null) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Agent job admission scope has not been frozen by a staged page.',
    );
  }
  return binding.admissionScope;
}

/** Enforce capture provenance and the durable job slug fence for an inventory. */
function assertPageInventoryForBinding(
  binding: JobBinding,
  inventory: readonly ProposalPageInventoryEntry[],
): void {
  const captureCount = inventory.filter(entry => entry.slug === binding.capturePageSlug).length;
  if (captureCount !== 1) {
    throw new AgentJobProposalError(
      'missing_capture_inventory',
      `page_inventory must include the exact capture slug ${binding.capturePageSlug} exactly once.`,
    );
  }
  for (const entry of inventory) assertSlugAllowed(binding, entry.slug, 'Inventory page');
}

/** Read a previously frozen inventory without accepting malformed durable state. */
function parseFrozenPageInventory(
  binding: JobBinding,
  totalPages: number,
): ProposalPageInventoryEntry[] | null {
  if (binding.pageInventory === null || binding.pageInventory === undefined) return null;
  try {
    return parseProposalPageInventory(binding.pageInventory, totalPages);
  } catch (error) {
    if (error instanceof AgentJobProposalError) {
      throw new AgentJobProposalError(
        'invalid_frozen_inventory',
        `The frozen agent job page inventory is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Require finalization to use a complete previously frozen inventory. */
function requireFrozenPageInventory(
  binding: JobBinding,
  totalPages: number,
): ProposalPageInventoryEntry[] {
  const inventory = parseFrozenPageInventory(binding, totalPages);
  if (!inventory) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Agent job page inventory has not been frozen by a staged page.',
    );
  }
  return inventory;
}

/** Check a newly proposed inventory against current live pages in its bound source. */
async function assertFirstInventoryEffectsMatchCorpus(
  engine: BrainEngine,
  binding: JobBinding,
  inventory: readonly ProposalPageInventoryEntry[],
): Promise<void> {
  if (binding.pageInventory !== null && binding.pageInventory !== undefined) return;
  // The durable source binding keeps same-slug pages in every other source
  // from changing whether this inventory entry is a create or an update.
  const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null }>(
    `SELECT slug, deleted_at
       FROM pages
      WHERE source_id = $1
        AND slug = ANY($2::text[])`,
    [binding.sourceId, inventory.map(entry => entry.slug)],
  );
  const pageStates = new Map(rows.map(row => [row.slug, row.deleted_at === null ? 'active' : 'deleted']));
  // Return the complete correction set so the agent can rebuild and retry one
  // coherent inventory instead of discovering effect mistakes one at a time.
  const mismatches = inventory.flatMap((entry) => {
    const state = pageStates.get(entry.slug);
    if (state === 'deleted') {
      return [`${entry.slug} is soft-deleted; restore or repair the page before retrying, and do not mark it create.`];
    }
    if (state === 'active' && entry.effect === 'create') {
      return [`${entry.slug} exists but is marked create; use update and read its exact baseline before staging.`];
    }
    if (state === undefined && entry.effect === 'update') {
      return [`${entry.slug} does not exist but is marked update; use create.`];
    }
    return [];
  });
  if (mismatches.length > 0) {
    throw new AgentJobProposalError(
      'inventory_effect_mismatch',
      `page_inventory effects do not match current non-deleted pages in source ${binding.sourceId}: `
        + `${mismatches.join(' ')} Correct page_inventory and total_pages, then retry.`,
    );
  }
}

/** Read every staged fragment in deterministic sequence order. */
async function readStoredFragments(engine: BrainEngine, jobId: number): Promise<StoredProposalFragment[]> {
  return engine.executeRaw<StoredProposalFragment>(
    `SELECT sequence, total_pages, owner_client_id, source_id, artifact_id,
            admission_scope, page, page_digest
       FROM agent_job_proposal_fragments
      WHERE job_id = $1
      ORDER BY sequence`,
    [jobId],
  );
}

/**
 * Validate replay identity and the cumulative canonical page-byte ceiling.
 * Returns true only for an exact existing sequence replay.
 */
function assertCumulativeStageFits(
  binding: JobBinding,
  candidate: ParsedStageProposalPageCore,
  fragments: readonly StoredProposalFragment[],
): boolean {
  let stagedBytes = 0;
  let replay = false;
  for (const fragment of fragments) {
    if (
      fragment.owner_client_id !== binding.ownerClientId
      || fragment.source_id !== binding.sourceId
      || fragment.artifact_id !== binding.artifactId
      || fragment.admission_scope !== candidate.admissionScope
      || Number(fragment.total_pages) !== candidate.totalPages
    ) {
      throw new AgentJobProposalError('binding_mismatch', 'A staged fragment does not match its job binding.');
    }
    const page = parseProposalPage(fragment.page);
    const pageDigest = digestProposalValue(page);
    if (pageDigest !== fragment.page_digest) {
      throw new AgentJobProposalError('digest_mismatch', 'A staged fragment does not match its stored digest.');
    }
    stagedBytes += proposalToolInputBytes(page);
    if (Number(fragment.sequence) !== candidate.sequence) continue;
    if (
      pageDigest !== candidate.pageDigest
      || canonicalProposalJson(page) !== canonicalProposalJson(candidate.page)
    ) {
      throw new AgentJobProposalError(
        'conflicting_fragment',
        `Sequence ${candidate.sequence} already contains a different proposal fragment.`,
      );
    }
    replay = true;
  }
  if (!replay) stagedBytes += proposalToolInputBytes(candidate.page);
  if (stagedBytes > PROPOSAL_AGGREGATE_MAX_BYTES) {
    throw new AgentJobProposalError(
      'proposal_too_large',
      `Staged proposal pages are ${stagedBytes} UTF-8 bytes; maximum is ${PROPOSAL_AGGREGATE_MAX_BYTES}.`,
    );
  }
  return replay;
}

/** Reject a proposed mutation target outside the job's durable slug fence. */
function assertSlugAllowed(binding: JobBinding, slug: string, label: string): void {
  if (!matchesSlugAllowList(slug, binding.allowedSlugPrefixes)) {
    throw new AgentJobProposalError(
      'slug_not_allowed',
      `${label} ${slug} is outside the agent job slug fence.`,
    );
  }
}

function parseTimelineEntries(raw: unknown): ScopedProposalTimelineEntry[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_timeline', 'proposed_timeline_entries must be an array of at most 40 entries.');
  }
  const identities = new Set<string>();
  return raw.map((entry, index) => {
    const record = readRecord(entry, `proposed_timeline_entries[${index}]`);
    const keys = Object.keys(record).sort();
    const validKeys = keys.every((key) => ['date', 'pageSlug', 'ref', 'refLabel', 'text'].includes(key));
    if (!validKeys || !['date', 'pageSlug', 'ref', 'text'].every((key) => key in record)) {
      throw new AgentJobProposalError('invalid_timeline', `Invalid timeline entry at index ${index}.`);
    }
    const date = readString(record.date, 'timeline.date');
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (
      !DATE_RE.test(date)
      || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== date
    ) {
      throw new AgentJobProposalError('invalid_timeline', `Invalid timeline date ${date}.`);
    }
    const result: ScopedProposalTimelineEntry = {
      pageSlug: readCanonicalSlug(record.pageSlug, 'timeline.pageSlug'),
      date,
      text: readBoundedString(record.text, 'timeline.text', 1_000),
      ref: readCanonicalSlug(record.ref, 'timeline.ref'),
    };
    if ('refLabel' in record) result.refLabel = readBoundedString(record.refLabel, 'timeline.refLabel', 500);
    const identity = canonicalProposalJson(result);
    if (identities.has(identity)) {
      throw new AgentJobProposalError('duplicate_timeline', 'Proposal contains duplicate timeline mutations.');
    }
    identities.add(identity);
    return result;
  });
}

function parseLinks(raw: unknown): ScopedProposalLink[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_links', 'proposed_links must be an array of at most 40 entries.');
  }
  const identities = new Set<string>();
  return raw.map((entry, index) => {
    const record = readRecord(entry, `proposed_links[${index}]`);
    assertExactKeys(record, ['from', 'to', 'type'], `proposed_links[${index}]`);
    const result = {
      from: readCanonicalSlug(record.from, 'link.from'),
      to: readCanonicalSlug(record.to, 'link.to'),
      type: readBoundedString(record.type, 'link.type', 128),
    };
    const identity = canonicalProposalJson(result);
    if (identities.has(identity)) {
      throw new AgentJobProposalError('duplicate_links', 'Proposal contains duplicate link mutations.');
    }
    identities.add(identity);
    return result;
  });
}

function parseUnresolved(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_unresolved', 'unresolved must be an array of at most 40 strings.');
  }
  return raw.map((entry, index) => readBoundedString(entry, `unresolved[${index}]`, 500));
}

function validatePlanRelations(
  binding: JobBinding,
  pageSlugs: ReadonlySet<string>,
  timeline: readonly ScopedProposalTimelineEntry[],
  links: readonly ScopedProposalLink[],
): void {
  if (!pageSlugs.has(binding.capturePageSlug)) {
    throw new AgentJobProposalError(
      'missing_capture_page',
      'The exact job-bound capture page must be included in proposed pages.',
    );
  }
  for (const entry of timeline) {
    assertSlugAllowed(binding, entry.pageSlug, 'Timeline target');
    if (entry.ref !== binding.capturePageSlug) {
      throw new AgentJobProposalError(
        'invalid_timeline_capture',
        'Every timeline ref must equal the exact job-bound capture page.',
      );
    }
  }
  for (const link of links) {
    assertSlugAllowed(binding, link.from, 'Link source');
    if (!pageSlugs.has(link.from)) {
      throw new AgentJobProposalError('invalid_links', 'Every proposed link from slug must name a proposed page.');
    }
  }
}

function assertSafeJobId(jobId: number): void {
  if (!Number.isSafeInteger(jobId) || jobId < 1) {
    throw new AgentJobProposalError('invalid_job', 'Agent job id must be a positive safe integer.');
  }
}

function readPositiveInteger(raw: unknown, name: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 1_000) {
    throw new AgentJobProposalError('invalid_integer', `${name} must be an integer from 1 to 1000.`);
  }
  return Number(raw);
}

function readProposalPageCount(raw: unknown): number {
  const totalPages = readPositiveInteger(raw, 'total_pages');
  if (totalPages > PROPOSAL_MAX_PAGES) {
    throw new AgentJobProposalError(
      'invalid_total_pages',
      `total_pages must be at most ${PROPOSAL_MAX_PAGES}.`,
    );
  }
  return totalPages;
}

function readRecord(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentJobProposalError('invalid_object', `${name} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

function readString(raw: unknown, name: string): string {
  if (typeof raw !== 'string') {
    throw new AgentJobProposalError('invalid_string', `${name} must be a string.`);
  }
  return raw;
}

function readBoundedString(raw: unknown, name: string, maxLength: number): string {
  const value = readString(raw, name).trim();
  if (!value || value.length > maxLength) {
    throw new AgentJobProposalError('invalid_string', `${name} must contain 1-${maxLength} characters.`);
  }
  return value;
}

function readCanonicalSlug(raw: unknown, name: string): string {
  const slug = readString(raw, name);
  if (!isCanonicalProposalSlug(slug)) {
    throw new AgentJobProposalError('invalid_slug', `${name} is not a canonical page slug.`);
  }
  return slug;
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AgentJobProposalError('invalid_keys', `${name} must contain exactly: ${expected.join(', ')}.`);
  }
}
