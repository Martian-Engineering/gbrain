/** Deterministic application of server-frozen ingestion proposal pages. */

import type { BrainEngine } from '../engine.ts';
import { StalePageError } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import {
  AgentJobProposalError,
  PROPOSAL_MAX_PAGES,
  digestProposalValue,
  isCanonicalProposalSlug,
  parseProposalPage,
  type ProposalPageDigest,
  type ScopedProposalPage,
} from '../ingestion-proposal-contract.ts';
export { AgentJobProposalError } from '../ingestion-proposal-contract.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { assertValidSourceId } from '../source-id.ts';
import { matchesSlugAllowList } from '../slug-allow-list.ts';
import type { Page } from '../types.ts';
import { writePageThrough, type WriteThroughResult } from '../write-through.ts';
import {
  getOwnedAgentJobProposal,
  type ScopedAdmissionProposalPlan,
} from './agent-job-proposals.ts';

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Exact authority required to apply one frozen proposal page. */
export interface ApplyProposalPageInput {
  proposal_job_id: number;
  proposal_digest: string;
  sequence: number;
  page_digest: string;
  source_id: string;
}

/** Privacy-bounded receipt for one deterministic proposal-page application. */
export interface ApplyProposalPageResult {
  status: 'applied' | 'already_applied';
  effect: 'create' | 'update';
  proposal_job_id: number;
  sequence: number;
  slug: string;
  source_id: string;
  proposal_digest: string;
  page_digest: string;
  previous_content_hash: string | null;
  content_hash: string;
  rebased: boolean;
  write_through?: WriteThroughResult;
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

interface ApplyJobBinding {
  ownerClientId: string;
  actor: string;
  sourceId: string;
  artifactId: string;
  admissionScope: string;
  capturePageSlug: string;
  allowedSlugPrefixes: string[];
  approvedProposalJobId: number;
  approvedProposalDigest: string;
  approvedPageDigests: ProposalPageDigest[];
}

interface ApplyProposalRow extends StoredProposalFragment {
  proposal_owner_client_id: string;
  proposal_source_id: string;
  proposal_digest: string;
  page_digests: ProposalPageDigest[];
  plan: ScopedAdmissionProposalPlan;
  applied_previous_content_hash: string | null;
  applied_content_hash: string | null;
  applied_rebased: boolean | null;
  applied_at: string | null;
}

/** Server-verified authority frozen onto a later apply agent job. */
export interface ApprovedProposalAuthority {
  proposalJobId: number;
  proposalDigest: string;
  ownerClientId: string;
  sourceId: string;
  artifactId: string;
  admissionScope: string;
  capturePageSlug: string;
  pageDigests: ProposalPageDigest[];
  plan: ScopedAdmissionProposalPlan;
}

/** Load one finalized proposal and its durable capture fence by exact owner. */
export async function getOwnedApprovedProposalAuthority(
  engine: BrainEngine,
  proposalJobId: number,
  ownerClientId: string,
  proposalDigest: string,
): Promise<ApprovedProposalAuthority> {
  const owned = await getOwnedAgentJobProposal(
    engine,
    proposalJobId,
    ownerClientId,
    proposalDigest,
  );
  const rows = await engine.executeRaw<{
    source_id: string;
    artifact_id: string;
    admission_scope: string;
    capture_page_slug: string | null;
  }>(
    `SELECT p.source_id, p.artifact_id, p.admission_scope,
            p.capture_page_slug
       FROM ingestion_proposal_authorities p
      WHERE p.proposal_id = $1 AND p.owner_client_id = $2 AND p.proposal_digest = $3`,
    [proposalJobId, ownerClientId, proposalDigest],
  );
  const row = rows[0];
  if (!row?.capture_page_slug) {
    throw new AgentJobProposalError(
      'proposal_authority_unavailable',
      'This finalized ingestion proposal authority is unavailable for the approved owner and digest.',
    );
  }
  const capturePageSlug = readCanonicalSlug(
    row.capture_page_slug,
    'proposal_capture_page_slug',
  );
  if (!owned.plan.proposedPages.some(page => page.slug === capturePageSlug)) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Approved proposal capture page is not present in its frozen page inventory.',
    );
  }
  return {
    proposalJobId,
    proposalDigest,
    ownerClientId,
    sourceId: row.source_id,
    artifactId: row.artifact_id,
    admissionScope: row.admission_scope,
    capturePageSlug,
    pageDigests: owned.page_digests,
    plan: owned.plan,
  };
}

/**
 * Apply one exact frozen page under a separate owner/source-bound agent job.
 *
 * The proposal row and fragment are locked with the corpus mutation. A single
 * bounded CAS retry handles a writer that wins after the first page read; a
 * non-prefix change is never rebased and leaves every row untouched.
 */
export async function applyAgentJobProposalPage(
  engine: BrainEngine,
  applyJobId: number,
  rawInput: ApplyProposalPageInput,
): Promise<ApplyProposalPageResult> {
  assertSafeJobId(applyJobId);
  const input = parseApplyProposalPageInput(rawInput);
  if (input.proposal_job_id === applyJobId) {
    throw new AgentJobProposalError(
      'permission_denied',
      'A proposal must be applied by a separate authorized agent job.',
    );
  }

  const result = await engine.transaction(async (tx) => {
    const applyBinding = await readApplyJobBinding(tx, applyJobId, true);
    const proposal = await readApplyProposalRow(tx, applyBinding, input);
    assertApplyAuthority(applyBinding, proposal, input);
    const page = parseProposalPage(proposal.page);
    if (proposal.applied_at !== null) {
      return appliedReplayResult(tx, proposal, input, page);
    }
    if (page.effect === 'create') {
      return applyFrozenCreate(tx, applyBinding, applyJobId, proposal, input, page);
    }
    const baseline = baselineFromFragment(proposal);
    if (!baseline || digestFrozenProposalPage(page, baseline) !== input.page_digest) {
      throw new AgentJobProposalError('digest_mismatch', 'The selected append does not match its frozen private baseline.');
    }

    const firstPage = await readApplicablePage(tx, page.slug, input.source_id);
    const firstAttempt = appendAttempt(firstPage.compiled_truth, baseline, page.appendMarkdown);
    if (firstAttempt.alreadyApplied) {
      return recordAppliedPage(tx, input, page.slug, 'update', {
        previousContentHash: firstPage.content_hash,
        contentHash: firstPage.content_hash,
        rebased: firstAttempt.rebased,
        status: 'already_applied',
      });
    }

    try {
      const contentHash = await persistAppend(tx, applyBinding, applyJobId, firstPage, firstAttempt.markdown);
      return recordAppliedPage(tx, input, page.slug, 'update', {
        previousContentHash: firstPage.content_hash,
        contentHash,
        rebased: firstAttempt.rebased,
        status: 'applied',
      });
    } catch (error) {
      if (!(error instanceof StalePageError)) throw error;
      // putPage now holds the page's transaction lock. Re-read once and
      // recompute from the exact frozen prefix; there is no retry loop.
      const racedPage = await readApplicablePage(tx, page.slug, input.source_id);
      const racedAttempt = appendAttempt(racedPage.compiled_truth, baseline, page.appendMarkdown);
      if (racedAttempt.alreadyApplied) {
        return recordAppliedPage(tx, input, page.slug, 'update', {
          previousContentHash: racedPage.content_hash,
          contentHash: racedPage.content_hash,
          rebased: true,
          status: 'already_applied',
        });
      }
      const contentHash = await persistAppend(tx, applyBinding, applyJobId, racedPage, racedAttempt.markdown);
      return recordAppliedPage(tx, input, page.slug, 'update', {
        previousContentHash: racedPage.content_hash,
        contentHash,
        rebased: true,
        status: 'applied',
      });
    }
  });
  const writeThrough = await writePageThrough(engine, result.slug, {
    sourceId: result.source_id,
  });
  return { ...result, write_through: writeThrough };
}

/** Join an approved append without changing any byte of the reviewed text. */
export function appendProposalMarkdown(baseline: string, appendMarkdown: string): string {
  return baseline + appendBoundary(baseline) + appendMarkdown;
}

/** Return the sole separator accepted between authored text and an append. */
function appendBoundary(markdown: string): string {
  if (markdown.length === 0 || markdown.endsWith('\n\n')) return '';
  if (markdown.endsWith('\n')) return '\n';
  return '\n\n';
}

function parseApplyProposalPageInput(raw: unknown): ApplyProposalPageInput {
  const input = readRecord(raw, 'apply proposal page input');
  assertExactKeys(
    input,
    ['proposal_job_id', 'proposal_digest', 'sequence', 'page_digest', 'source_id'],
    'apply proposal page input',
  );
  const proposalJobId = readPositiveInteger(input.proposal_job_id, 'proposal_job_id');
  const sequence = readPositiveInteger(input.sequence, 'sequence');
  const proposalDigest = readString(input.proposal_digest, 'proposal_digest');
  const pageDigest = readString(input.page_digest, 'page_digest');
  const sourceId = readBoundedString(input.source_id, 'source_id', 255);
  assertValidSourceId(sourceId);
  if (!SHA256_RE.test(proposalDigest) || !SHA256_RE.test(pageDigest)) {
    throw new AgentJobProposalError('invalid_digest', 'Proposal and page digests must be lowercase SHA-256 values.');
  }
  return {
    proposal_job_id: proposalJobId,
    proposal_digest: proposalDigest,
    sequence,
    page_digest: pageDigest,
    source_id: sourceId,
  };
}

async function readApplyProposalRow(
  engine: BrainEngine,
  applyBinding: ApplyJobBinding,
  input: ApplyProposalPageInput,
): Promise<ApplyProposalRow> {
  const authorities = await engine.executeRaw<{ expired: boolean }>(
    `SELECT expires_at <= now() AS expired
       FROM ingestion_proposal_authorities
      WHERE proposal_id = $1 AND owner_client_id = $2 AND proposal_digest = $3
      FOR UPDATE`,
    [input.proposal_job_id, applyBinding.ownerClientId, input.proposal_digest],
  );
  if (!authorities[0]) {
    throw new AgentJobProposalError(
      'proposal_authority_unavailable',
      'This finalized ingestion proposal authority is unavailable for the approved owner and digest.',
    );
  }
  if (authorities[0].expired) {
    throw new AgentJobProposalError(
      'proposal_authority_expired',
      'This finalized ingestion proposal has expired and must be proposed again.',
    );
  }
  const rows = await engine.executeRaw<ApplyProposalRow>(
    `SELECT f.sequence, f.total_pages, p.owner_client_id, p.source_id,
            p.artifact_id, p.admission_scope, f.page, f.page_digest,
            f.baseline_title, f.baseline_markdown, f.baseline_content_hash,
            f.applied_previous_content_hash, f.applied_content_hash,
            f.applied_rebased, f.applied_at,
            p.owner_client_id AS proposal_owner_client_id,
            p.source_id AS proposal_source_id, p.proposal_digest,
            p.page_digests, p.plan
       FROM ingestion_proposal_authority_pages f
       JOIN ingestion_proposal_authorities p ON p.proposal_id = f.proposal_id
      WHERE f.proposal_id = $1 AND f.sequence = $2
      FOR UPDATE`,
    [input.proposal_job_id, input.sequence],
  );
  if (!rows[0]) {
    throw new AgentJobProposalError(
      'proposal_authority_page_missing',
      'The selected page is missing from the finalized ingestion proposal authority.',
    );
  }
  return rows[0];
}

function assertApplyAuthority(
  applyBinding: ApplyJobBinding,
  proposal: ApplyProposalRow,
  input: ApplyProposalPageInput,
): void {
  const manifestEntry = Array.isArray(proposal.page_digests)
    ? proposal.page_digests[input.sequence - 1]
    : undefined;
  const approvedEntry = applyBinding.approvedPageDigests[input.sequence - 1];
  if (
    applyBinding.ownerClientId !== proposal.proposal_owner_client_id
    || applyBinding.sourceId !== input.source_id
    || proposal.proposal_source_id !== input.source_id
    || proposal.owner_client_id !== proposal.proposal_owner_client_id
    || proposal.source_id !== input.source_id
    || applyBinding.artifactId !== proposal.artifact_id
    || applyBinding.admissionScope !== proposal.admission_scope
    || applyBinding.approvedProposalJobId !== input.proposal_job_id
    || applyBinding.approvedProposalDigest !== input.proposal_digest
  ) {
    throw new AgentJobProposalError('permission_denied', 'Apply job authority does not match the frozen proposal.');
  }
  if (
    proposal.proposal_digest !== input.proposal_digest
    || digestProposalValue(proposal.plan) !== input.proposal_digest
    || !manifestEntry
    || manifestEntry.sequence !== input.sequence
    || manifestEntry.slug !== parseProposalPage(proposal.page).slug
    || manifestEntry.digest !== input.page_digest
    || proposal.page_digest !== input.page_digest
    || !approvedEntry
    || approvedEntry.sequence !== input.sequence
    || approvedEntry.slug !== manifestEntry.slug
    || approvedEntry.digest !== input.page_digest
  ) {
    throw new AgentJobProposalError('digest_mismatch', 'Proposal job, sequence, or digest does not match the frozen page.');
  }
  const slug = manifestEntry.slug;
  if (!matchesSlugAllowList(slug, applyBinding.allowedSlugPrefixes)) {
    throw new AgentJobProposalError('slug_not_allowed', 'Frozen page is outside the apply job slug fence.');
  }
}

async function readApplyJobBinding(
  engine: BrainEngine,
  jobId: number,
  lock: boolean,
): Promise<ApplyJobBinding> {
  const rows = await engine.executeRaw<{
    name: string;
    owner_client_id: string | null;
    owner_principal: string | null;
    source_id: string | null;
    artifact_id: string | null;
    admission_scope: string | null;
    capture_page_slug: string | null;
    allowed_slug_prefixes: unknown;
    approved_proposal_job_id: string | null;
    approved_proposal_digest: string | null;
    approved_page_digests: unknown;
  }>(
    `SELECT name, data->>'__owner_client_id' AS owner_client_id,
            data->>'__owner_principal' AS owner_principal,
            data->>'source_id' AS source_id,
            data->>'proposal_artifact_id' AS artifact_id,
            data->>'proposal_admission_scope' AS admission_scope,
            data->>'proposal_capture_page_slug' AS capture_page_slug,
            data->'allowed_slug_prefixes' AS allowed_slug_prefixes,
            data->>'approved_proposal_job_id' AS approved_proposal_job_id,
            data->>'approved_proposal_digest' AS approved_proposal_digest,
            data->'approved_proposal_page_digests' AS approved_page_digests
       FROM minion_jobs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  const row = rows[0];
  if (
    !row || row.name !== 'subagent' || !row.owner_client_id || !row.source_id
    || !row.artifact_id || !row.admission_scope || !row.capture_page_slug
    || !Array.isArray(row.allowed_slug_prefixes)
    || row.allowed_slug_prefixes.length === 0
    || row.allowed_slug_prefixes.some(prefix => typeof prefix !== 'string' || prefix.length === 0)
    || !row.approved_proposal_job_id
    || !Number.isSafeInteger(Number(row.approved_proposal_job_id))
    || Number(row.approved_proposal_job_id) < 1
    || !row.approved_proposal_digest
    || !SHA256_RE.test(row.approved_proposal_digest)
    || !Array.isArray(row.approved_page_digests)
    || row.approved_page_digests.length === 0
  ) {
    throw new AgentJobProposalError(
      'job_not_bound',
      'Apply job is not bound to exact approved proposal authority.',
    );
  }
  assertValidSourceId(row.source_id);
  const approvedPageDigests = parseApprovedPageDigests(row.approved_page_digests);
  return {
    ownerClientId: row.owner_client_id,
    actor: row.owner_principal ? `principal:${row.owner_principal}` : `mcp:${row.owner_client_id}`,
    sourceId: row.source_id,
    artifactId: row.artifact_id,
    admissionScope: row.admission_scope,
    capturePageSlug: readCanonicalSlug(row.capture_page_slug, 'proposal_capture_page_slug'),
    allowedSlugPrefixes: row.allowed_slug_prefixes as string[],
    approvedProposalJobId: Number(row.approved_proposal_job_id),
    approvedProposalDigest: row.approved_proposal_digest,
    approvedPageDigests,
  };
}

/** Parse the canonical page manifest frozen server-side when the apply job is submitted. */
function parseApprovedPageDigests(raw: unknown): ProposalPageDigest[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PROPOSAL_MAX_PAGES) {
    throw new AgentJobProposalError('job_not_bound', 'Approved proposal page manifest is invalid.');
  }
  return raw.map((value, index) => {
    const entry = readRecord(value, 'approved proposal page digest');
    assertExactKeys(entry, ['sequence', 'slug', 'digest'], 'approved proposal page digest');
    const sequence = readPositiveInteger(entry.sequence, 'approved page sequence');
    const slug = readCanonicalSlug(entry.slug, 'approved page slug');
    const digest = readString(entry.digest, 'approved page digest');
    if (sequence !== index + 1 || !SHA256_RE.test(digest)) {
      throw new AgentJobProposalError('job_not_bound', 'Approved proposal page manifest is invalid.');
    }
    return { sequence, slug, digest };
  });
}

async function readApplicablePage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<Page & { content_hash: string }> {
  const page = await engine.getPage(slug, { sourceId, includeDeleted: true });
  if (!page || page.deleted_at || !page.content_hash) {
    throw new AgentJobProposalError('page_unavailable', `Append target ${slug} is missing or deleted.`);
  }
  return page as Page & { content_hash: string };
}

function appendAttempt(
  currentMarkdown: string,
  baseline: PrivateUpdateBaseline,
  appendMarkdown: string,
): { markdown: string; rebased: boolean; alreadyApplied: boolean } {
  const frozenResult = appendProposalMarkdown(baseline.markdown, appendMarkdown);
  if (currentMarkdown === frozenResult) {
    return { markdown: currentMarkdown, rebased: false, alreadyApplied: true };
  }
  const currentIsSafeAppend = currentMarkdown === baseline.markdown
    || currentMarkdown.startsWith(baseline.markdown + appendBoundary(baseline.markdown));
  if (!currentIsSafeAppend) {
    throw new AgentJobProposalError(
      'stale_page',
      'Page changed outside an append-only suffix; no mutation was performed.',
    );
  }
  if (currentMarkdown.endsWith(appendMarkdown)) {
    const prefix = currentMarkdown.slice(0, -appendMarkdown.length);
    if (appendProposalMarkdown(prefix, appendMarkdown) === currentMarkdown) {
      return { markdown: currentMarkdown, rebased: true, alreadyApplied: true };
    }
  }
  const rebased = currentMarkdown !== baseline.markdown;
  return {
    markdown: appendProposalMarkdown(currentMarkdown, appendMarkdown),
    rebased,
    alreadyApplied: false,
  };
}

/** Create one frozen page from server-owned title/body data and record it atomically. */
async function applyFrozenCreate(
  engine: BrainEngine,
  binding: ApplyJobBinding,
  applyJobId: number,
  proposal: ApplyProposalRow,
  input: ApplyProposalPageInput,
  page: Extract<ScopedProposalPage, { effect: 'create' }>,
): Promise<ApplyProposalPageResult> {
  if (
    baselineFromFragment(proposal) !== null
    || digestFrozenProposalPage(page, null) !== input.page_digest
  ) {
    throw new AgentJobProposalError(
      'digest_mismatch',
      'The selected create does not match its frozen proposal slot.',
    );
  }
  const existing = await engine.getPage(page.slug, {
    sourceId: input.source_id,
    includeDeleted: true,
  });
  if (existing) {
    throw new AgentJobProposalError(
      existing.deleted_at ? 'page_unavailable' : 'page_exists',
      `Approved create target ${page.slug} is not absent; refresh the proposal.`,
    );
  }
  const inferred = parseMarkdown(page.bodyMarkdown, `${page.slug}.md`);
  const content = serializeMarkdown({}, page.bodyMarkdown, '', {
    type: inferred.type,
    title: page.title,
    tags: [],
  });
  const { isAvailable } = await import('../ai/gateway.ts');
  let imported;
  try {
    imported = await importFromContent(engine, page.slug, content, {
      sourceId: input.source_id,
      expectedContentHash: null,
      noEmbed: !isAvailable('embedding'),
      remote: true,
      withinTransaction: true,
      skipLinkExtraction: true,
      writeContext: {
        actor: binding.actor,
        writeIntent: 'live_ingest',
        batchId: `job:${applyJobId}`,
        reason: 'approved ingestion proposal create',
      },
    });
  } catch (error) {
    if (error instanceof StalePageError) {
      throw new AgentJobProposalError(
        'page_exists',
        `Approved create target ${page.slug} was created concurrently; refresh the proposal.`,
      );
    }
    throw error;
  }
  if (imported.status !== 'imported') {
    throw new AgentJobProposalError('apply_failed', `Create import returned ${imported.status}.`);
  }
  const current = await readApplicablePage(engine, page.slug, input.source_id);
  if (current.title !== page.title || current.compiled_truth !== page.bodyMarkdown) {
    throw new AgentJobProposalError('apply_failed', 'Created page does not match the frozen proposal.');
  }
  return recordAppliedPage(engine, input, page.slug, 'create', {
    previousContentHash: null,
    contentHash: current.content_hash,
    rebased: false,
    status: 'applied',
  });
}

async function persistAppend(
  engine: BrainEngine,
  binding: ApplyJobBinding,
  applyJobId: number,
  page: Page & { content_hash: string },
  markdown: string,
): Promise<string> {
  const tags = await engine.getTags(page.slug, { sourceId: page.source_id });
  const content = serializeMarkdown(page.frontmatter, markdown, '', {
    type: page.type,
    title: page.title,
    tags,
  });
  const { isAvailable } = await import('../ai/gateway.ts');
  const result = await importFromContent(engine, page.slug, content, {
    sourceId: page.source_id,
    expectedContentHash: page.content_hash,
    noEmbed: !isAvailable('embedding'),
    remote: true,
    withinTransaction: true,
    skipLinkExtraction: true,
    writeContext: {
      actor: binding.actor,
      writeIntent: 'live_ingest',
      batchId: `job:${applyJobId}`,
      reason: 'approved ingestion proposal append',
    },
  });
  if (result.status !== 'imported') {
    throw new AgentJobProposalError('apply_failed', `Append import returned ${result.status}.`);
  }
  const current = await readApplicablePage(engine, page.slug, page.source_id);
  return current.content_hash;
}

async function recordAppliedPage(
  engine: BrainEngine,
  input: ApplyProposalPageInput,
  slug: string,
  effect: 'create' | 'update',
  outcome: {
    previousContentHash: string | null;
    contentHash: string;
    rebased: boolean;
    status: ApplyProposalPageResult['status'];
  },
): Promise<ApplyProposalPageResult> {
  await engine.executeRaw(
    `UPDATE ingestion_proposal_authority_pages
        SET applied_previous_content_hash = $3, applied_content_hash = $4,
            applied_rebased = $5, applied_at = now()
      WHERE proposal_id = $1 AND sequence = $2 AND applied_at IS NULL`,
    [input.proposal_job_id, input.sequence, outcome.previousContentHash, outcome.contentHash, outcome.rebased],
  );
  return {
    status: outcome.status,
    effect,
    proposal_job_id: input.proposal_job_id,
    sequence: input.sequence,
    slug,
    source_id: input.source_id,
    proposal_digest: input.proposal_digest,
    page_digest: input.page_digest,
    previous_content_hash: outcome.previousContentHash,
    content_hash: outcome.contentHash,
    rebased: outcome.rebased,
  };
}

async function appliedReplayResult(
  engine: BrainEngine,
  proposal: ApplyProposalRow,
  input: ApplyProposalPageInput,
  page: ScopedProposalPage,
): Promise<ApplyProposalPageResult> {
  if (
    !proposal.applied_content_hash
    || proposal.applied_rebased === null
  ) {
    throw new AgentJobProposalError('invalid_apply_receipt', 'Stored append application receipt is incomplete.');
  }
  if (page.effect === 'create') {
    const current = await readApplicablePage(engine, page.slug, input.source_id);
    if (
      current.content_hash !== proposal.applied_content_hash
      || current.title !== page.title
      || current.compiled_truth !== page.bodyMarkdown
      || proposal.applied_previous_content_hash !== null
      || proposal.applied_rebased
    ) {
      throw new AgentJobProposalError(
        'stale_page',
        'Previously applied create no longer matches its frozen receipt.',
      );
    }
  } else {
    if (!proposal.applied_previous_content_hash) {
      throw new AgentJobProposalError('invalid_apply_receipt', 'Stored update receipt is incomplete.');
    }
    const current = await readApplicablePage(engine, page.slug, input.source_id);
    if (current.content_hash !== proposal.applied_content_hash) {
      throw new AgentJobProposalError(
        'stale_page',
        'Previously applied update changed after its frozen receipt was recorded.',
      );
    }
  }
  return {
    status: 'already_applied',
    effect: page.effect,
    proposal_job_id: input.proposal_job_id,
    sequence: input.sequence,
    slug: page.slug,
    source_id: input.source_id,
    proposal_digest: input.proposal_digest,
    page_digest: input.page_digest,
    previous_content_hash: proposal.applied_previous_content_hash,
    content_hash: proposal.applied_content_hash,
    rebased: proposal.applied_rebased,
  };
}


/** Reconstruct a private update baseline without accepting partial rows. */
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

function assertSafeJobId(jobId: number): void {
  if (!Number.isSafeInteger(jobId) || jobId < 1) {
    throw new AgentJobProposalError('invalid_job_id', 'Agent job id must be a positive integer.');
  }
}

function readPositiveInteger(raw: unknown, name: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) {
    throw new AgentJobProposalError('invalid_params', `${name} must be a positive integer.`);
  }
  return Number(raw);
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

function readBoundedString(raw: unknown, name: string, maxLength: number): string {
  const value = readString(raw, name);
  if (value.length > maxLength) {
    throw new AgentJobProposalError('invalid_params', `${name} exceeds ${maxLength} characters.`);
  }
  return value;
}

function readCanonicalSlug(raw: unknown, name: string): string {
  const slug = readBoundedString(raw, name, 255);
  if (!isCanonicalProposalSlug(slug)) {
    throw new AgentJobProposalError('invalid_slug', `${name} must be a canonical proposal slug.`);
  }
  return slug;
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new AgentJobProposalError('invalid_params', `${name} must contain exactly: ${expected.join(', ')}.`);
  }
}
