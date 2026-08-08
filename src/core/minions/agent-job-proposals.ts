import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { matchesSlugAllowList } from '../slug-allow-list.ts';

/** Maximum UTF-8 size of one page-staging tool input. */
export const PROPOSAL_STAGE_INPUT_MAX_BYTES = 196_608;

/** Maximum UTF-8 size of one finalized, canonical proposal plan. */
export const PROPOSAL_AGGREGATE_MAX_BYTES = 98_304;

/** Maximum UTF-8 size after the canonical plan is embedded as a JSON string. */
export const PROPOSAL_ESCAPED_PLAN_MAX_BYTES = 98_304;

/** Maximum UTF-8 size of the compact receipt manifest. */
export const PROPOSAL_MANIFEST_MAX_BYTES = 262_144;

/** Maximum number of pages in one finalized proposal. */
export const PROPOSAL_MAX_PAGES = 32;

/** Maximum characters in the shared Lore/GBrain admission-scope contract. */
export const PROPOSAL_ADMISSION_SCOPE_MAX_CHARS = 4_000;

export const STAGE_PROPOSAL_TOOL_NAME = 'brain_stage_ingestion_proposal_page';
export const FINALIZE_PROPOSAL_TOOL_NAME = 'brain_finalize_ingestion_proposal';

const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_SLUG_CHARS = 'a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af';
const PAGE_SLUG_SEGMENT = `[${CANONICAL_SLUG_CHARS}][${CANONICAL_SLUG_CHARS}-]*`;
const PAGE_SLUG_RE = new RegExp(`^${PAGE_SLUG_SEGMENT}(\\/${PAGE_SLUG_SEGMENT})*$`);

/** Error raised when staged proposal evidence violates its durable contract. */
export class AgentJobProposalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentJobProposalError';
  }
}

export interface ProposalPageDigest {
  sequence: number;
  slug: string;
  digest: string;
}

export interface ScopedProposalPage {
  slug: string;
  effect: 'create' | 'update';
  title: string;
  bodyMarkdown: string;
  baseMarkdown?: string;
  expectedContentHash?: string;
}

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

export interface StageProposalPageInput {
  artifact_id: string;
  source_id: string;
  admission_scope: string;
  sequence: number;
  total_pages: number;
  page: unknown;
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
}

interface ParsedStageProposalPageInput {
  artifactId: string;
  sourceId: string;
  admissionScope: string;
  sequence: number;
  totalPages: number;
  page: ScopedProposalPage;
  pageDigest: string;
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

/** Return the canonical JSON encoding used for every proposal digest. */
export function canonicalProposalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProposalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalProposalJson(record[key])}`
  )).join(',')}}`;
}

/** Hash one canonical proposal value with SHA-256. */
export function digestProposalValue(value: unknown): string {
  return createHash('sha256').update(canonicalProposalJson(value), 'utf8').digest('hex');
}

/** Measure one tool input using the same canonical UTF-8 representation persisted by GBrain. */
export function proposalToolInputBytes(input: unknown): number {
  return Buffer.byteLength(canonicalProposalJson(input ?? null), 'utf8');
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
  const candidate = parseStageProposalPageInput(stageCall.input);

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
): Promise<ProposalPageDigest> {
  assertSafeJobId(jobId);
  const candidate = parseStageProposalPageInput(input);

  return engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, candidate);
    const frozenBinding = await freezeAdmissionScope(tx, jobId, binding, candidate.admissionScope);
    assertSlugAllowed(frozenBinding, candidate.page.slug, 'Proposed page');
    const finalized = await tx.executeRaw<{ proposal_digest: string }>(
      `SELECT proposal_digest FROM agent_job_proposals WHERE job_id = $1`,
      [jobId],
    );
    if (finalized.length > 0) {
      throw new AgentJobProposalError('proposal_finalized', 'This job proposal is already finalized.');
    }

    const fragments = await readStoredFragments(tx, jobId);
    const replay = assertCumulativeStageFits(frozenBinding, candidate, fragments);
    if (replay) {
      return {
        sequence: candidate.sequence,
        slug: candidate.page.slug,
        digest: candidate.pageDigest,
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
  }>(
    `SELECT name,
            data->>'__owner_client_id' AS owner_client_id,
            data->>'source_id' AS source_id,
            data->>'proposal_artifact_id' AS artifact_id,
            data->>'proposal_admission_scope' AS admission_scope,
            data->>'proposal_capture_page_slug' AS capture_page_slug,
            data->'allowed_slug_prefixes' AS allowed_slug_prefixes
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

/** Freeze a first-stage admission scope without changing any other job binding. */
async function freezeAdmissionScope(
  engine: BrainEngine,
  jobId: number,
  binding: JobBinding,
  requestedScope: string,
): Promise<JobBinding & { admissionScope: string }> {
  if (binding.admissionScope === null) {
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{proposal_admission_scope}', to_jsonb($2::text), true),
              updated_at = now()
        WHERE id = $1 AND data->>'proposal_admission_scope' IS NULL`,
      [jobId, requestedScope],
    );
    binding.admissionScope = requestedScope;
  }
  if (binding.admissionScope !== requestedScope) {
    throw new AgentJobProposalError(
      'binding_mismatch',
      'Proposal admission scope does not match the scope frozen by the first staged page.',
    );
  }
  return binding as JobBinding & { admissionScope: string };
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

/** Parse and normalize one page-staging input before any durable write. */
function parseStageProposalPageInput(raw: unknown): ParsedStageProposalPageInput {
  if (proposalToolInputBytes(raw) > PROPOSAL_STAGE_INPUT_MAX_BYTES) {
    throw new AgentJobProposalError('stage_input_too_large', 'Proposal page input exceeds the staging byte limit.');
  }
  const input = readRecord(raw, 'stage proposal input');
  const artifactId = readBoundedString(input.artifact_id, 'artifact_id', 255);
  const sourceId = readBoundedString(input.source_id, 'source_id', 255);
  assertValidSourceId(sourceId);
  const admissionScope = readBoundedString(
    input.admission_scope,
    'admission_scope',
    PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
  );
  const sequence = readPositiveInteger(input.sequence, 'sequence');
  const totalPages = readProposalPageCount(input.total_pages);
  if (sequence > totalPages) {
    throw new AgentJobProposalError('invalid_sequence', 'sequence must be within 1..total_pages.');
  }
  const page = parseProposalPage(input.page);
  return {
    artifactId,
    sourceId,
    admissionScope,
    sequence,
    totalPages,
    page,
    pageDigest: digestProposalValue(page),
  };
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
  candidate: ParsedStageProposalPageInput,
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

function parseProposalPage(raw: unknown): ScopedProposalPage {
  const page = readRecord(raw, 'page');
  const effect = page.effect;
  if (effect !== 'create' && effect !== 'update') {
    throw new AgentJobProposalError('invalid_page', 'page.effect must be create or update.');
  }
  const allowed = effect === 'create'
    ? ['slug', 'effect', 'title', 'bodyMarkdown']
    : ['slug', 'effect', 'title', 'bodyMarkdown', 'baseMarkdown', 'expectedContentHash'];
  assertExactKeys(page, allowed, 'page');
  const slug = readCanonicalSlug(page.slug, 'page.slug');
  const title = readBoundedString(page.title, 'page.title', 1_000);
  const bodyMarkdown = readNonBlankString(page.bodyMarkdown, 'page.bodyMarkdown');
  if (effect === 'create') return { slug, effect, title, bodyMarkdown };
  const baseMarkdown = readNonBlankString(page.baseMarkdown, 'page.baseMarkdown');
  const expectedContentHash = readString(page.expectedContentHash, 'page.expectedContentHash');
  if (!SHA256_RE.test(expectedContentHash)) {
    throw new AgentJobProposalError('invalid_page', 'page.expectedContentHash must be a lowercase SHA-256 digest.');
  }
  return { slug, effect, title, bodyMarkdown, baseMarkdown, expectedContentHash };
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

function readNonBlankString(raw: unknown, name: string): string {
  const value = readString(raw, name);
  if (!value.trim()) {
    throw new AgentJobProposalError('invalid_string', `${name} must not be blank.`);
  }
  return value;
}

function readCanonicalSlug(raw: unknown, name: string): string {
  const slug = readString(raw, name);
  if (slug.length > 255 || !PAGE_SLUG_RE.test(slug)) {
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
