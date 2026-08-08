import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { matchesSlugAllowList } from '../slug-allow-list.ts';
import {
  buildProposalApplicationDigestInventory,
  parseProposalLinks,
  parseProposalTimelineEntries,
  parseProposalUnresolved,
  validateProposalRelations,
  type ProposalRelationDigest,
} from './agent-job-proposal-relations.ts';
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
import {
  finalizedIngestionProposalExists,
  promoteIngestionProposalAuthority,
  readIngestionProposalAuthorityPages,
  readOwnedIngestionProposalAuthority,
} from './ingestion-proposal-authority.ts';
import {
  bindProposalToolInput,
  type IngestionProposalToolBinding,
} from './ingestion-proposal-tool-binding.ts';

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
  timelineDigests: ProposalRelationDigest[];
  linkDigests: ProposalRelationDigest[];
  inventoryDigest: string;
  proposalDigest: string;
  proposedTimelineEntries: ScopedProposalTimelineEntry[];
  proposedLinks: ScopedProposalLink[];
  unresolved: string[];
}

interface StoredCompletedProposal {
  owner_client_id: string;
  source_id: string;
  artifact_id: string;
  admission_scope: string;
  total_pages: number;
  page_digests: unknown;
  proposal_digest: string;
  manifest: unknown;
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
  baseline_title: string | null;
  baseline_markdown: string | null;
  baseline_content_hash: string | null;
}

interface PrivateUpdateBaseline {
  title: string;
  markdown: string;
  contentHash: string;
}

interface FrozenProposalCandidate extends ParsedStageProposalPageCore {
  pageDigest: string;
  baseline: PrivateUpdateBaseline | null;
}

interface ProposalTurnBlock {
  type?: unknown;
  name?: unknown;
  toolName?: unknown;
  input?: unknown;
}

const CORRECTABLE_STAGE_PARSE_ERROR_CODES = [
  'invalid_object',
  'invalid_string',
  'invalid_integer',
  'invalid_total_pages',
  'invalid_sequence',
  'invalid_page',
  'invalid_keys',
  'invalid_slug',
  'managed_region_marker',
  'timeline_sentinel',
] as const;

type CorrectableStageParseErrorCode = typeof CORRECTABLE_STAGE_PARSE_ERROR_CODES[number];
type StageProposalPageCoreParser = (raw: unknown) => ParsedStageProposalPageCore;

/** Return whether a parser failure is safe to return through the tool-result loop. */
function isCorrectableStageParseError(
  error: unknown,
): error is AgentJobProposalError & { readonly code: CorrectableStageParseErrorCode } {
  return error instanceof AgentJobProposalError
    && CORRECTABLE_STAGE_PARSE_ERROR_CODES.some(code => code === error.code);
}

/** Parse a pre-persistence candidate while deferring only known correctable failures. */
function parseStageProposalPageCoreForPersistence(
  raw: unknown,
  parser: StageProposalPageCoreParser = parseStageProposalPageCore,
): ParsedStageProposalPageCore | null {
  try {
    return parser(raw);
  } catch (error) {
    if (isCorrectableStageParseError(error)) return null;
    throw error;
  }
}

/** Test seams for the fail-closed pre-persistence parser boundary. */
export const __testing = { parseStageProposalPageCoreForPersistence };

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
  proposalBinding?: IngestionProposalToolBinding,
): Promise<void> {
  assertProposalToolTurnPersistable(blocks);
  const boundBlocks = blocks.map((block) => {
    const name = typeof block.name === 'string'
      ? block.name
      : typeof block.toolName === 'string'
        ? block.toolName
        : '';
    return {
      ...block,
      input: bindProposalToolInput(name, block.input, proposalBinding),
    };
  });
  if (proposalBinding) assertProposalToolTurnPersistable(boundBlocks);
  const stageCall = proposalToolCalls(boundBlocks)
    .find((call) => call.name === STAGE_PROPOSAL_TOOL_NAME);
  if (!stageCall) return;
  // Inventory semantics intentionally remain an execution-time tool result so
  // the agent can correct a bad plan in the same job. Page-shape errors are
  // equally correctable and already byte-bounded above, so defer them to the
  // tool handler instead of aborting the job before it can receive the error.
  const candidate = parseStageProposalPageCoreForPersistence(stageCall.input);
  if (!candidate) return;

  await engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, candidate);
    assertSlugAllowed(binding, candidate.page.slug, 'Proposed page');
    const fragments = await readStoredFragments(tx, jobId);
    const replay = assertCumulativeStageFits(binding, candidate, fragments);
    if (!replay) await freezeProposalCandidate(tx, binding, candidate);
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
    if (await finalizedIngestionProposalExists(tx, jobId)) {
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
        digest: replay.page_digest,
        nextExpectedSlot: nextExpectedInventorySlot(candidate.pageInventory, fragments),
      };
    }

    const frozenCandidate = await freezeProposalCandidate(tx, binding, candidate);

    await tx.executeRaw(
      `INSERT INTO agent_job_proposal_fragments
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          sequence, total_pages, page, page_digest, baseline_title,
          baseline_markdown, baseline_content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10, $11, $12)
       ON CONFLICT (job_id, sequence) DO NOTHING`,
      [
        jobId, frozenBinding.ownerClientId, frozenBinding.sourceId, frozenBinding.artifactId,
        frozenBinding.admissionScope, candidate.sequence, candidate.totalPages,
        canonicalProposalJson(candidate.page), frozenCandidate.pageDigest,
        frozenCandidate.baseline?.title ?? null,
        frozenCandidate.baseline?.markdown ?? null,
        frozenCandidate.baseline?.contentHash ?? null,
      ],
    );
    return {
      sequence: candidate.sequence,
      slug: candidate.page.slug,
      digest: frozenCandidate.pageDigest,
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
  const timeline = parseProposalTimelineEntries(input.proposed_timeline_entries ?? []);
  const links = parseProposalLinks(input.proposed_links ?? []);
  const unresolved = parseProposalUnresolved(input.unresolved ?? []);

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
      if (digestFrozenProposalPage(page, baselineFromFragment(fragment)) !== fragment.page_digest) {
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
    validateProposalRelations(
      binding.capturePageSlug,
      binding.allowedSlugPrefixes,
      seenSlugs,
      timeline,
      links,
    );

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
    const applicationInventory = buildProposalApplicationDigestInventory(
      pageDigests,
      timeline,
      links,
    );
    const manifest = parseFinalizedProposalManifest({
      status: 'staged_proposal',
      artifactId: binding.artifactId,
      sourceId: binding.sourceId,
      admissionScope: boundScope,
      summary,
      pageDigests,
      timelineDigests: applicationInventory.timelineDigests,
      linkDigests: applicationInventory.linkDigests,
      inventoryDigest: applicationInventory.inventoryDigest,
      proposalDigest,
      proposedTimelineEntries: timeline,
      proposedLinks: links,
      unresolved,
    }, totalPages);
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

    const authority = await promoteIngestionProposalAuthority<FinalizedProposalManifest>(tx, {
      proposalId: jobId,
      ownerClientId: binding.ownerClientId,
      sourceId: binding.sourceId,
      artifactId: binding.artifactId,
      admissionScope: boundScope,
      capturePageSlug: binding.capturePageSlug,
      totalPages,
      pageDigestsJson: canonicalProposalJson(pageDigests),
      planJson,
      proposalDigest,
      manifestJson,
    });
    if (
      !authority
      || authority.proposalDigest !== proposalDigest
      || canonicalProposalJson(authority.manifest) !== manifestJson
      || authority.pages.length !== totalPages
      || pageDigests.some((entry, index) => (
        entry.digest !== authority.pages[index]?.page_digest
        || entry.digest !== digestFrozenProposalPage(
          parseProposalPage(authority.pages[index]?.page),
          baselineFromFragment(authority.pages[index]!),
        )
      ))
    ) {
      throw new AgentJobProposalError(
        'conflicting_finalization',
        'This stable proposal authority conflicts with the finalized job evidence.',
      );
    }
    return authority.manifest;
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
  timeline_digests: ProposalRelationDigest[];
  link_digests: ProposalRelationDigest[];
  inventory_digest: string;
  plan: ScopedAdmissionProposalPlan;
}> {
  assertSafeJobId(jobId);
  if (!ownerClientId) {
    throw new AgentJobProposalError('permission_denied', 'An OAuth client owner is required.');
  }
  if (!SHA256_RE.test(proposalDigest)) {
    throw new AgentJobProposalError('invalid_digest', 'proposal_digest must be 64 lowercase hexadecimal characters.');
  }
  const authority = await readOwnedIngestionProposalAuthority<
    ScopedAdmissionProposalPlan,
    ProposalPageDigest[]
  >(
    engine,
    jobId,
    ownerClientId,
    proposalDigest,
  );
  if (!authority) {
    throw new AgentJobProposalError(
      'proposal_authority_unavailable',
      'This finalized ingestion proposal authority is unavailable for the approved owner and digest.',
    );
  }
  if (authority.expired) {
    throw new AgentJobProposalError(
      'proposal_authority_expired',
      'This finalized ingestion proposal has expired and must be proposed again.',
    );
  }
  const plan = authority.plan;
  if (digestProposalValue(plan) !== proposalDigest) {
    throw new AgentJobProposalError('digest_mismatch', 'Stored proposal content does not match its digest.');
  }
  const pageDigests = authority.pageDigests;
  const fragments = await readIngestionProposalAuthorityPages(engine, jobId);
  if (
    fragments.length < plan.proposedPages.length
    || plan.proposedPages.some((_, index) => fragments[index]?.sequence !== index + 1)
  ) {
    throw new AgentJobProposalError(
      'proposal_authority_page_missing',
      'A page is missing from the finalized ingestion proposal authority.',
    );
  }
  if (
    !Array.isArray(pageDigests)
    || pageDigests.length !== plan.proposedPages.length
    || fragments.length !== plan.proposedPages.length
    || pageDigests.some((entry, index) => (
      entry.sequence !== index + 1
      || entry.slug !== plan.proposedPages[index]?.slug
      || entry.digest !== fragments[index]?.page_digest
      || entry.digest !== digestFrozenProposalPage(
        parseProposalPage(fragments[index]?.page),
        baselineFromFragment(fragments[index]!),
      )
    ))
  ) {
    throw new AgentJobProposalError('digest_mismatch', 'Stored proposal page manifest does not match the frozen plan.');
  }
  const applicationInventory = buildProposalApplicationDigestInventory(
    pageDigests,
    plan.proposedTimelineEntries,
    plan.proposedLinks,
  );
  return {
    id: jobId,
    proposal_digest: proposalDigest,
    page_digests: pageDigests,
    timeline_digests: applicationInventory.timelineDigests,
    link_digests: applicationInventory.linkDigests,
    inventory_digest: applicationInventory.inventoryDigest,
    plan,
  };
}

/**
 * Return the compact durable receipt for a completed proposal job.
 *
 * A missing proposal row preserves ordinary job-result behavior, while any
 * stored ownership or identity conflict fails closed. The full plan is never
 * selected or returned.
 */
export async function readCompletedOwnedAgentJobProposalManifest(
  engine: BrainEngine,
  jobId: number,
  ownerClientId: string,
  jobBinding: { sourceId: unknown; artifactId: unknown; admissionScope: unknown },
): Promise<FinalizedProposalManifest | null> {
  assertSafeJobId(jobId);
  if (!ownerClientId) {
    throw new AgentJobProposalError('permission_denied', 'An OAuth client owner is required.');
  }
  const rows = await engine.executeRaw<StoredCompletedProposal>(
    `SELECT owner_client_id, source_id, artifact_id, admission_scope,
            total_pages, page_digests, proposal_digest, manifest
       FROM agent_job_proposals
      WHERE job_id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.owner_client_id !== ownerClientId) {
    throw new AgentJobProposalError(
      'permission_denied',
      'Finalized proposal ownership does not match the requesting OAuth client.',
    );
  }
  if (
    jobBinding.sourceId !== row.source_id
    || jobBinding.artifactId !== row.artifact_id
    || jobBinding.admissionScope !== row.admission_scope
  ) {
    throw new AgentJobProposalError(
      'proposal_identity_mismatch',
      'Finalized proposal identity does not match its agent job binding.',
    );
  }

  const manifest = compactManifestFromRow(row);
  if (manifest === null) {
    throw new AgentJobProposalError(
      'proposal_identity_mismatch',
      'Finalized proposal manifest does not match its stored identity and digest.',
    );
  }
  return manifest;
}

/** Accept only the exact compact manifest shape and row-bound identity. */
function compactManifestFromRow(row: StoredCompletedProposal): FinalizedProposalManifest | null {
  try {
    const manifest = parseFinalizedProposalManifest(row.manifest, Number(row.total_pages));
    if (
      manifest.artifactId !== row.artifact_id
      || manifest.sourceId !== row.source_id
      || manifest.admissionScope !== row.admission_scope
      || manifest.proposalDigest !== row.proposal_digest
      || canonicalProposalJson(manifest.pageDigests) !== canonicalProposalJson(row.page_digests)
    ) return null;
    return manifest;
  } catch (error) {
    if (error instanceof AgentJobProposalError) return null;
    throw error;
  }
}

/** Strictly parse and rederive a complete compact finalized-proposal manifest. */
export function parseFinalizedProposalManifest(
  raw: unknown,
  totalPages: number,
): FinalizedProposalManifest {
  const record = readRecord(raw, 'finalized proposal manifest');
  assertExactKeys(record, [
    'status', 'artifactId', 'sourceId', 'admissionScope', 'summary',
    'pageDigests', 'timelineDigests', 'linkDigests', 'inventoryDigest',
    'proposalDigest', 'proposedTimelineEntries', 'proposedLinks', 'unresolved',
  ], 'finalized proposal manifest');
  if (record.status !== 'staged_proposal') {
    throw new AgentJobProposalError('proposal_identity_mismatch', 'Finalized proposal status is invalid.');
  }
  const pageDigests = parseFinalizedPageDigests(record.pageDigests, totalPages);
  const proposedTimelineEntries = parseProposalTimelineEntries(record.proposedTimelineEntries);
  const proposedLinks = parseProposalLinks(record.proposedLinks);
  const inventory = buildProposalApplicationDigestInventory(
    pageDigests,
    proposedTimelineEntries,
    proposedLinks,
  );
  const proposalDigest = readString(record.proposalDigest, 'manifest.proposalDigest');
  if (!SHA256_RE.test(proposalDigest)) {
    throw new AgentJobProposalError('proposal_identity_mismatch', 'Finalized proposal digest is invalid.');
  }
  const manifest: FinalizedProposalManifest = {
    status: 'staged_proposal',
    artifactId: readBoundedString(record.artifactId, 'manifest.artifactId', 255),
    sourceId: readBoundedString(record.sourceId, 'manifest.sourceId', 255),
    admissionScope: readBoundedString(
      record.admissionScope,
      'manifest.admissionScope',
      PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
    ),
    summary: readBoundedString(record.summary, 'manifest.summary', 1_000),
    pageDigests,
    timelineDigests: inventory.timelineDigests,
    linkDigests: inventory.linkDigests,
    inventoryDigest: inventory.inventoryDigest,
    proposalDigest,
    proposedTimelineEntries,
    proposedLinks,
    unresolved: parseProposalUnresolved(record.unresolved),
  };
  try {
    assertValidSourceId(manifest.sourceId);
  } catch {
    throw new AgentJobProposalError(
      'proposal_identity_mismatch',
      'Finalized proposal manifest contains an invalid source identity.',
    );
  }
  if (canonicalProposalJson(raw) !== canonicalProposalJson(manifest)) {
    throw new AgentJobProposalError(
      'proposal_identity_mismatch',
      'Finalized proposal manifest does not match its canonical digest inventory.',
    );
  }
  return manifest;
}

/** Strictly parse the ordered page digest inventory in a compact manifest. */
function parseFinalizedPageDigests(raw: unknown, totalPages: number): ProposalPageDigest[] {
  const expectedPages = readProposalPageCount(totalPages);
  if (!Array.isArray(raw) || raw.length !== expectedPages) {
    throw new AgentJobProposalError('proposal_identity_mismatch', 'Finalized page digest inventory is incomplete.');
  }
  return raw.map((entry, index) => {
    const record = readRecord(entry, `pageDigests[${index}]`);
    assertExactKeys(record, ['sequence', 'slug', 'digest'], `pageDigests[${index}]`);
    const sequence = readPositiveInteger(record.sequence, `pageDigests[${index}].sequence`);
    const slug = readCanonicalSlug(record.slug, `pageDigests[${index}].slug`);
    const digest = readString(record.digest, `pageDigests[${index}].digest`);
    if (sequence !== index + 1 || !SHA256_RE.test(digest)) {
      throw new AgentJobProposalError(
        'proposal_identity_mismatch',
        'Finalized page digest inventory is invalid.',
      );
    }
    return { sequence, slug, digest };
  });
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
            admission_scope, page, page_digest, baseline_title,
            baseline_markdown, baseline_content_hash
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
): StoredProposalFragment | null {
  let stagedBytes = 0;
  let replay: StoredProposalFragment | null = null;
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
    const pageDigest = digestFrozenProposalPage(page, baselineFromFragment(fragment));
    if (pageDigest !== fragment.page_digest) {
      throw new AgentJobProposalError('digest_mismatch', 'A staged fragment does not match its stored digest.');
    }
    stagedBytes += proposalToolInputBytes(page);
    if (Number(fragment.sequence) !== candidate.sequence) continue;
    if (
      canonicalProposalJson(page) !== canonicalProposalJson(candidate.page)
    ) {
      throw new AgentJobProposalError(
        'conflicting_fragment',
        `Sequence ${candidate.sequence} already contains a different proposal fragment.`,
      );
    }
    replay = fragment;
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

/** Load and freeze the exact private baseline for a compact update intent. */
async function freezeProposalCandidate(
  engine: BrainEngine,
  binding: JobBinding,
  candidate: ParsedStageProposalPageCore,
): Promise<FrozenProposalCandidate> {
  if (candidate.page.effect === 'create') {
    return { ...candidate, pageDigest: digestFrozenProposalPage(candidate.page, null), baseline: null };
  }
  const page = await engine.getPage(candidate.page.slug, {
    sourceId: binding.sourceId,
    includeDeleted: true,
  });
  if (!page || page.deleted_at || !page.content_hash) {
    throw new AgentJobProposalError(
      'baseline_unavailable',
      `Update baseline is unavailable for ${candidate.page.slug}; rebuild the inventory against current pages.`,
    );
  }
  const baseline: PrivateUpdateBaseline = {
    title: page.title,
    markdown: page.compiled_truth,
    contentHash: page.content_hash,
  };
  return {
    ...candidate,
    baseline,
    pageDigest: digestFrozenProposalPage(candidate.page, baseline),
  };
}

/** Reconstruct a private baseline without accepting partially populated rows. */
function baselineFromFragment(fragment: StoredProposalFragment): PrivateUpdateBaseline | null {
  const page = parseProposalPage(fragment.page);
  if (page.effect === 'create') return null;
  if (
    fragment.baseline_title === null
    || fragment.baseline_markdown === null
    || fragment.baseline_content_hash === null
    || !SHA256_RE.test(fragment.baseline_content_hash)
  ) {
    throw new AgentJobProposalError('baseline_unavailable', 'A staged update is missing its private baseline.');
  }
  return {
    title: fragment.baseline_title,
    markdown: fragment.baseline_markdown,
    contentHash: fragment.baseline_content_hash,
  };
}

/** Bind a public page intent to its server-private baseline. */
function digestFrozenProposalPage(
  page: ScopedProposalPage,
  baseline: PrivateUpdateBaseline | null,
): string {
  if (page.effect === 'create') return digestProposalValue(page);
  if (!baseline) {
    throw new AgentJobProposalError('baseline_unavailable', 'A compact update requires a private baseline.');
  }
  return digestProposalValue({
    page,
    baselineTitle: baseline.title,
    baselineMarkdown: baseline.markdown,
    baselineContentHash: baseline.contentHash,
  });
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
