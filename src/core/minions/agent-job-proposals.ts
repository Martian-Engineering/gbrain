import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';

/** Maximum UTF-8 size of one page-staging tool input. */
export const PROPOSAL_STAGE_INPUT_MAX_BYTES = 196_608;

/** Maximum UTF-8 size of one finalized, canonical proposal plan. */
export const PROPOSAL_AGGREGATE_MAX_BYTES = 786_432;

/** Maximum UTF-8 size of the compact receipt manifest. */
export const PROPOSAL_MANIFEST_MAX_BYTES = 262_144;

export const STAGE_PROPOSAL_TOOL_NAME = 'brain_stage_ingestion_proposal_page';
export const FINALIZE_PROPOSAL_TOOL_NAME = 'brain_finalize_ingestion_proposal';

const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]*(?:\/[\p{L}\p{N}][\p{L}\p{N}-]*)*$/u;

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
  page_digests: unknown;
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
  admissionScope: string;
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
  const calls = blocks.flatMap((block) => {
    const isCall = block.type === 'tool_use' || block.type === 'tool-call';
    if (!isCall) return [];
    const name = typeof block.name === 'string'
      ? block.name
      : typeof block.toolName === 'string'
        ? block.toolName
        : '';
    return [{ name, input: block.input }];
  });
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

/** Stage one exact page proposal in the current agent job's durable ledger. */
export async function stageAgentJobProposalPage(
  engine: BrainEngine,
  jobId: number,
  input: StageProposalPageInput,
): Promise<ProposalPageDigest> {
  assertSafeJobId(jobId);
  if (proposalToolInputBytes(input) > PROPOSAL_STAGE_INPUT_MAX_BYTES) {
    throw new AgentJobProposalError('stage_input_too_large', 'Proposal page input exceeds the staging byte limit.');
  }
  const sequence = readPositiveInteger(input.sequence, 'sequence');
  const totalPages = readPositiveInteger(input.total_pages, 'total_pages');
  if (sequence > totalPages) {
    throw new AgentJobProposalError('invalid_sequence', 'sequence must be within 1..total_pages.');
  }
  const page = parseProposalPage(input.page);
  const pageDigest = digestProposalValue(page);

  return engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, input.artifact_id, input.source_id, input.admission_scope);
    const finalized = await tx.executeRaw<{ proposal_digest: string }>(
      `SELECT proposal_digest FROM agent_job_proposals WHERE job_id = $1`,
      [jobId],
    );
    if (finalized.length > 0) {
      throw new AgentJobProposalError('proposal_finalized', 'This job proposal is already finalized.');
    }

    await tx.executeRaw(
      `INSERT INTO agent_job_proposal_fragments
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          sequence, total_pages, page, page_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9)
       ON CONFLICT (job_id, sequence) DO NOTHING`,
      [
        jobId, binding.ownerClientId, binding.sourceId, binding.artifactId,
        binding.admissionScope, sequence, totalPages, canonicalProposalJson(page), pageDigest,
      ],
    );
    const rows = await tx.executeRaw<{
      source_id: string;
      artifact_id: string;
      admission_scope: string;
      total_pages: number;
      page: unknown;
      page_digest: string;
    }>(
      `SELECT source_id, artifact_id, admission_scope, total_pages, page, page_digest
         FROM agent_job_proposal_fragments
        WHERE job_id = $1 AND sequence = $2`,
      [jobId, sequence],
    );
    const existing = rows[0];
    if (
      !existing
      || existing.source_id !== binding.sourceId
      || existing.artifact_id !== binding.artifactId
      || existing.admission_scope !== binding.admissionScope
      || Number(existing.total_pages) !== totalPages
      || existing.page_digest !== pageDigest
      || canonicalProposalJson(existing.page) !== canonicalProposalJson(page)
    ) {
      throw new AgentJobProposalError(
        'conflicting_fragment',
        `Sequence ${sequence} already contains a different proposal fragment.`,
      );
    }
    return { sequence, slug: page.slug, digest: pageDigest };
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
  const totalPages = readPositiveInteger(input.total_pages, 'total_pages');
  const requestedDigests = parseRequestedDigests(input.page_digests, totalPages);
  const summary = readBoundedString(input.summary, 'summary', 1_000);
  const timeline = parseTimelineEntries(input.proposed_timeline_entries ?? []);
  const links = parseLinks(input.proposed_links ?? []);
  const unresolved = parseUnresolved(input.unresolved ?? []);

  return engine.transaction(async (tx) => {
    const binding = await readJobBinding(tx, jobId, true);
    assertBindingMatches(binding, input.artifact_id, input.source_id, input.admission_scope);
    const fragments = await tx.executeRaw<{
      sequence: number;
      total_pages: number;
      owner_client_id: string;
      source_id: string;
      artifact_id: string;
      admission_scope: string;
      page: unknown;
      page_digest: string;
    }>(
      `SELECT sequence, total_pages, owner_client_id, source_id, artifact_id,
              admission_scope, page, page_digest
         FROM agent_job_proposal_fragments
        WHERE job_id = $1
        ORDER BY sequence`,
      [jobId],
    );
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
      const requested = requestedDigests[index]!;
      if (Number(fragment.sequence) !== expectedSequence || Number(fragment.total_pages) !== totalPages) {
        throw new AgentJobProposalError('fragment_gap', 'Staged proposal sequences are not exactly contiguous.');
      }
      if (
        fragment.owner_client_id !== binding.ownerClientId
        || fragment.source_id !== binding.sourceId
        || fragment.artifact_id !== binding.artifactId
        || fragment.admission_scope !== binding.admissionScope
      ) {
        throw new AgentJobProposalError('binding_mismatch', 'A staged fragment does not match its job binding.');
      }
      const page = parseProposalPage(fragment.page);
      if (
        requested.sequence !== expectedSequence
        || requested.digest !== fragment.page_digest
        || digestProposalValue(page) !== fragment.page_digest
      ) {
        throw new AgentJobProposalError('digest_mismatch', `Digest mismatch at sequence ${expectedSequence}.`);
      }
      if (seenSlugs.has(page.slug)) {
        throw new AgentJobProposalError('duplicate_page', `Proposal contains duplicate page slug ${page.slug}.`);
      }
      seenSlugs.add(page.slug);
      pages.push(page);
      pageDigests.push({ sequence: expectedSequence, slug: page.slug, digest: fragment.page_digest });
    }
    validatePlanRelations(seenSlugs, timeline, links);

    const plan: ScopedAdmissionProposalPlan = {
      artifactId: binding.artifactId,
      sourceId: binding.sourceId,
      admissionScope: binding.admissionScope,
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
    const proposalDigest = digestProposalValue(plan);
    const manifest: FinalizedProposalManifest = {
      status: 'staged_proposal',
      artifactId: binding.artifactId,
      sourceId: binding.sourceId,
      admissionScope: binding.admissionScope,
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
        binding.admissionScope, totalPages, canonicalProposalJson(pageDigests),
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
  }>(
    `SELECT name,
            data->>'__owner_client_id' AS owner_client_id,
            data->>'source_id' AS source_id,
            data->>'proposal_artifact_id' AS artifact_id,
            data->>'proposal_admission_scope' AS admission_scope
       FROM minion_jobs
      WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  const row = rows[0];
  if (
    !row || row.name !== 'subagent' || !row.owner_client_id || !row.artifact_id
    || !row.admission_scope
  ) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Agent job is not bound to an owner, proposal artifact, and admission scope.',
    );
  }
  const sourceId = row.source_id ?? 'default';
  assertValidSourceId(sourceId);
  return {
    ownerClientId: row.owner_client_id,
    sourceId,
    artifactId: row.artifact_id,
    admissionScope: row.admission_scope,
  };
}

function assertBindingMatches(
  binding: JobBinding,
  artifactId: unknown,
  sourceId: unknown,
  admissionScope: unknown,
): void {
  if (
    artifactId !== binding.artifactId
    || sourceId !== binding.sourceId
    || admissionScope !== binding.admissionScope
  ) {
    throw new AgentJobProposalError(
      'binding_mismatch',
      'Proposal artifact, source, or admission scope does not match the submitted agent job.',
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
  const bodyMarkdown = readString(page.bodyMarkdown, 'page.bodyMarkdown');
  if (effect === 'create') return { slug, effect, title, bodyMarkdown };
  const baseMarkdown = readString(page.baseMarkdown, 'page.baseMarkdown');
  const expectedContentHash = readString(page.expectedContentHash, 'page.expectedContentHash');
  if (!SHA256_RE.test(expectedContentHash)) {
    throw new AgentJobProposalError('invalid_page', 'page.expectedContentHash must be a lowercase SHA-256 digest.');
  }
  return { slug, effect, title, bodyMarkdown, baseMarkdown, expectedContentHash };
}

function parseRequestedDigests(raw: unknown, totalPages: number): Array<{ sequence: number; digest: string }> {
  if (!Array.isArray(raw) || raw.length !== totalPages) {
    throw new AgentJobProposalError('invalid_manifest', 'page_digests must contain exactly total_pages entries.');
  }
  const seen = new Set<number>();
  return raw.map((entry, index) => {
    const record = readRecord(entry, `page_digests[${index}]`);
    assertExactKeys(record, ['sequence', 'digest'], `page_digests[${index}]`);
    const sequence = readPositiveInteger(record.sequence, `page_digests[${index}].sequence`);
    const digest = readString(record.digest, `page_digests[${index}].digest`);
    if (!SHA256_RE.test(digest)) {
      throw new AgentJobProposalError('invalid_manifest', `Invalid digest at sequence ${sequence}.`);
    }
    if (seen.has(sequence)) {
      throw new AgentJobProposalError('duplicate_manifest_sequence', `Duplicate manifest sequence ${sequence}.`);
    }
    seen.add(sequence);
    if (sequence !== index + 1) {
      throw new AgentJobProposalError('fragment_gap', 'page_digests must be ordered and contiguous from 1.');
    }
    return { sequence, digest };
  });
}

function parseTimelineEntries(raw: unknown): ScopedProposalTimelineEntry[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_timeline', 'proposed_timeline_entries must be an array of at most 40 entries.');
  }
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
    if ('refLabel' in record) result.refLabel = readBoundedString(record.refLabel, 'timeline.refLabel', 1_000);
    return result;
  });
}

function parseLinks(raw: unknown): ScopedProposalLink[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_links', 'proposed_links must be an array of at most 40 entries.');
  }
  return raw.map((entry, index) => {
    const record = readRecord(entry, `proposed_links[${index}]`);
    assertExactKeys(record, ['from', 'to', 'type'], `proposed_links[${index}]`);
    return {
      from: readCanonicalSlug(record.from, 'link.from'),
      to: readCanonicalSlug(record.to, 'link.to'),
      type: readBoundedString(record.type, 'link.type', 128),
    };
  });
}

function parseUnresolved(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_unresolved', 'unresolved must be an array of at most 40 strings.');
  }
  return raw.map((entry, index) => readBoundedString(entry, `unresolved[${index}]`, 500));
}

function validatePlanRelations(
  pageSlugs: ReadonlySet<string>,
  timeline: readonly ScopedProposalTimelineEntry[],
  links: readonly ScopedProposalLink[],
): void {
  // The shared plan contract guarantees referential integrity. Provider
  // skills own stricter provenance rules such as capture-page-only refs.
  for (const entry of timeline) {
    if (!pageSlugs.has(entry.ref)) {
      throw new AgentJobProposalError('invalid_timeline', 'Every timeline ref must name a proposed page.');
    }
  }
  for (const link of links) {
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
  if (slug.length > 255 || !PAGE_SLUG_RE.test(slug) || slug !== slug.toLowerCase()) {
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
