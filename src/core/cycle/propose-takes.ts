/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Claims explicitly admitted semantic page revisions, sends canonical prose
 * to a tuned LLM extractor, and writes gradeable claims to `take_proposals`.
 * User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract:
 *   `take_proposal_scans` atomically claims each semantic-input/prompt tuple
 *   and records successful zero-result scans. `take_proposals` keeps its
 *   per-claim uniqueness, with content_hash storing mining_input_hash.
 *
 * F2 fence dedup:
 *   The phase reads the page's existing `<!-- gbrain:takes:begin -->` fence
 *   (when present) and passes the canonical take rows to the extractor as
 *   "things you have already captured." This prevents duplicate proposals
 *   when a user adds prose to a page that already has takes.
 *
 * Auto-resolve posture:
 *   propose_takes only WRITES proposals to the queue. Nothing here mutates
 *   the canonical takes table. Operator opt-in via `gbrain takes propose
 *   --accept N` is the only path from queue to canonical fence (D17).
 *
 * Prompt tuning status (v0.36.1.0 ship state):
 *   The default extractor prompt was tuned against the synthetic corpus at
 *   test/fixtures/calibration/ and validated via the cat15 propose_takes
 *   eval in the gbrain-evals repo. First live run scored 0.952 F1 on
 *   training (target 0.85) and 0.922 F1 on holdout (target 0.80), with a
 *   0.03 train-holdout gap (no overfitting). PROPOSE_TAKES_PROMPT_VERSION
 *   is "v0.36.1.0-tuned-cat15". Re-tuning requires re-running cat15;
 *   bumping the version string invalidates the take_proposals idempotency
 *   cache so old proposals stay as audit history but the next cycle
 *   re-extracts fresh against the new prompt.
 *
 * The extractor LLM call is INJECTED via opts.extractor for tests, so the
 * phase can run hermetically in unit tests without touching the gateway.
 */

import { createHash } from 'node:crypto';
import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { GBrainError } from '../types.ts';
import { sourceScopeOpts, type OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';
import { loadActivePackBestEffort } from '../schema-pack/best-effort.ts';
import { extractableTypesFromPack } from '../schema-pack/extractable.ts';
import { buildTakeMiningInput } from './take-mining-input.ts';
import {
  extractExistingTakesForDedup,
  PROPOSE_TAKES_PROMPT_VERSION,
  renderTakeMiningRequest,
  TAKE_MINING_MAX_PROPOSALS_PER_PAGE,
  type TakeMiningExtractorInput,
} from './take-mining-request.ts';
import {
  createTakeMiningRunner,
  TAKE_MINING_LOCK_NAME,
  takeMiningWorkBatchSize,
  type TakeMiningRunnerOptions,
  type TakeMiningRunnerWork,
} from './take-mining-runner.ts';
import { withTakeMiningLock } from './take-mining-lock.ts';

export {
  TakeMiningRunnerError,
  TAKE_MINING_LOCK_NAME,
  type TakeMiningRunResult,
  type TakeMiningRunnerOptions,
  type TakeMiningStopReason,
} from './take-mining-runner.ts';

/**
 * Bump when the extractor prompt or the JSON output shape changes. Old
 * verdicts in `take_proposals` (composite key includes prompt_version) stay
 * valid as audit history; new runs re-spend LLM tokens on every page.
 */
export { PROPOSE_TAKES_PROMPT_VERSION } from './take-mining-request.ts';

/**
 * Tuned extractor prompt, validated against the hand-labeled synthetic
 * corpus at test/fixtures/calibration/. Measured F1 on first live run
 * via gbrain-evals cat15 (claude-sonnet-4-6 extractor, claude-haiku-4-5
 * matcher judge):
 *
 *   training avg F1: 0.952 (target 0.85, exceeded by 10 points)
 *   holdout  avg F1: 0.922 (target 0.80, exceeded by 12 points)
 *   train-holdout gap: 0.03 (no overfitting signal)
 *
 * Per-genre F1 floor: 0.80 (people-pages, the hardest genre). The
 * concept-with-timeline and meeting-notes genres scored at 1.00 on
 * holdout pages.
 *
 * Design choices baked into the prompt:
 *   - Worked example list seeds the model's notion of "gradeable claim"
 *     so it doesn't drift into pure-fact extraction.
 *   - NOT-gradeable list catches the most common over-extraction modes
 *     (pure facts, direct quotes, restatements).
 *   - conviction inference rules anchored to specific hedging language
 *     ("I bet"/"strong conviction"=0.7-0.85, "I think"/"moderate"=0.5-0.7).
 *   - kind enum kept narrow ('prediction'|'judgment'|'bet') — the v1
 *     stub's 4-tag enum bled into noise classification.
 *
 * Replaces the v0.36.1.0-stub. If you re-tune, run cat15 against the
 * fixtures before bumping PROPOSE_TAKES_PROMPT_VERSION; the train-holdout
 * gap should stay < 0.10 (overfitting threshold).
 */
export {
  EXTRACT_TAKES_PROMPT,
  extractExistingTakesForDedup,
} from './take-mining-request.ts';

/** One proposed take, as the extractor produces it. */
export interface ProposedTake {
  claim_text: string;
  kind: 'fact' | 'take' | 'bet' | 'hunch';
  holder: string;
  weight: number;
  domain?: string;
}

/** Extractor function signature — injected for tests; production calls gateway. */
export type ProposeTakesExtractor = (
  input: TakeMiningExtractorInput,
) => Promise<ProposedTake[]>;

export interface ProposeTakesOpts extends BasePhaseOpts {
  /** Retained cycle-call compatibility; queued work is database-backed. */
  repoPath?: string;
  /** Limit admitted work processed in this cycle. Default: 100. */
  pageLimit?: number;
  /** Inject the LLM call for tests; production uses gateway.chat. */
  extractor?: ProposeTakesExtractor;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Override model id (tests + config). */
  model?: string;
  /** Cooperative cycle cancellation and renewable-lock loss signal. */
  signal?: AbortSignal;
  /** Skip pages that already have a complete takes fence. Default: true. */
  skipPagesWithFence?: boolean;
  /** Test seam for active-pack eligibility. Production resolves the active pack. */
  _extractableTypes?: readonly string[];
  /** Test seam for bounded lease behavior. */
  _leaseSeconds?: number;
  /** Test seam for bounded queue pagination. */
  _workBatchSize?: number;
  /** Test seam for synchronizing workers immediately before atomic claim. */
  _beforeClaim?: (pageSlug: string) => Promise<void>;
  /** Test seam for model-price coverage. */
  _estimatedPageSpendUsd?: number | null;
}

export interface ProposeTakesResult {
  /** Canonical candidates selected before budget checks and atomic claims. */
  eligible_pages: number;
  /** Work items successfully claimed for an extraction attempt. */
  pages_scanned: number;
  cache_hits: number;
  cache_misses: number;
  proposals_extracted: number;
  proposals_inserted: number;
  budget_exhausted: boolean;
  warnings: string[];
}

/**
 * Compatibility helper for callers that need the take-mining identity.
 * Generated fences and repair-only link targets do not affect this hash.
 */
export function contentHash(pageBody: string): string {
  return buildTakeMiningInput(pageBody).mining_input_hash;
}

/**
 * Compute the per-claim proposal identity from normalized claim text.
 */
export function claimHash(claimText: string): string {
  return createHash('sha256').update(claimText.trim()).digest('hex');
}

/**
 * Detect whether a page already has a complete `<!-- gbrain:takes:begin -->`
 * fence. We DO propose against pages with fences (F2 dedup) but the operator
 * may opt to skip-with-fence pages via skipPagesWithFence:true for a faster
 * pass. The fence shape mirrors src/core/takes-fence.ts.
 */
export function hasCompleteFence(pageBody: string): boolean {
  return /<!---?\s*gbrain:takes:begin[\s\S]*?gbrain:takes:end\s*-->/.test(pageBody);
}

/**
 * Production extractor — calls gateway.chat with the EXTRACT_TAKES_PROMPT
 * and parses the JSON array output. Malformed output throws so the caller
 * releases the lease; a valid [] remains a durable successful scan.
 *
 * Stub-prompt note: the v0.36.1.0 ship-state prompt is a placeholder. Real
 * extractor lands when T19 corpus build produces the tuned prompt. Until
 * then, the production extractor returns whatever the stub LLM produces —
 * empirically often a sparse list or [].
 */
export async function defaultExtractor(
  input: Parameters<ProposeTakesExtractor>[0],
): Promise<ProposedTake[]> {
  const request = renderTakeMiningRequest(input);

  const result = await gatewayChat({
    messages: request.messages,
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: request.maxTokens,
  });

  // A valid [] is a successful scan; malformed output is retryable.
  const parsed = parseExtractorOutputResult(result.text);
  if (!parsed.valid) throw new Error('extractor returned malformed JSON');
  return parsed.proposals;
}

interface ExtractorParseResult {
  valid: boolean;
  proposals: ProposedTake[];
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
function parseExtractorOutputResult(raw: string): ExtractorParseResult {
  if (!raw || raw.trim().length === 0) return { valid: false, proposals: [] };
  let text = raw.trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return { valid: false, proposals: [] };
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return { valid: false, proposals: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProposedTake[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const claim_text = typeof r.claim_text === 'string' ? r.claim_text.trim() : '';
    if (!claim_text || claim_text.length > 500) continue;
    const kind = ['fact', 'take', 'bet', 'hunch'].includes(r.kind as string)
      ? (r.kind as ProposedTake['kind'])
      : 'take';
    const holder = typeof r.holder === 'string' && r.holder.length > 0 ? r.holder : 'brain';
    const weightRaw = typeof r.weight === 'number' ? r.weight : 0.5;
    const weight = Math.max(0, Math.min(1, weightRaw));
    const domain = typeof r.domain === 'string' && r.domain.length > 0 ? r.domain : undefined;
    out.push({ claim_text, kind, holder, weight, domain });
  }
  return {
    valid: true,
    proposals: out.slice(0, TAKE_MINING_MAX_PROPOSALS_PER_PAGE),
  };
}

export function parseExtractorOutput(raw: string): ProposedTake[] {
  return parseExtractorOutputResult(raw).proposals;
}

interface TakeMiningWorkRow {
  source_id: string;
  page_slug: string;
  mining_input_hash: string;
  compiled_truth: string;
  priority: number;
  created_at: string;
}

interface TakeMiningWorkCursor {
  priority: number;
  created_at: string;
  source_id: string;
  page_slug: string;
}

interface TakeMiningSelector {
  admission: 'immediate' | 'deferred';
  batchId?: string;
}

function sourcePredicate(scope: ScopedReadOpts, params: unknown[]): string {
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    const placeholders = scope.sourceIds.map(sourceId => {
      params.push(sourceId);
      return `$${params.length}`;
    });
    return `w.source_id IN (${placeholders.join(', ')})`;
  }
  params.push(scope.sourceId ?? 'default');
  return `w.source_id = $${params.length}`;
}

async function resolveExtractableTypes(
  ctx: OperationContext,
  opts: ProposeTakesOpts,
): Promise<Set<string> | null> {
  if (opts._extractableTypes) return new Set(opts._extractableTypes);
  const pack = await loadActivePackBestEffort(ctx);
  return pack ? extractableTypesFromPack(pack.manifest) : null;
}

async function loadEligibleWorkBatch(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  extractableTypes: ReadonlySet<string>,
  promptVersion: string,
  selector: TakeMiningSelector,
  cursor: TakeMiningWorkCursor | undefined,
  batchSize: number,
): Promise<TakeMiningWorkRow[]> {
  if (extractableTypes.size === 0) return [];
  const params: unknown[] = [];
  const scoped = sourcePredicate(scope, params);
  const typePlaceholders = [...extractableTypes].map(type => {
    params.push(type);
    return `$${params.length}`;
  });
  params.push(promptVersion);
  const promptParam = `$${params.length}`;
  params.push(selector.admission);
  const admissionParam = `$${params.length}`;
  let batchPredicate = '';
  if (selector.admission === 'deferred') {
    params.push(selector.batchId);
    batchPredicate = `AND w.batch_id = $${params.length}`;
  }
  let cursorPredicate = '';
  if (cursor) {
    params.push(cursor.priority);
    const priorityParam = `$${params.length}`;
    params.push(cursor.created_at);
    const createdAtParam = `$${params.length}`;
    params.push(cursor.source_id);
    const sourceIdParam = `$${params.length}`;
    params.push(cursor.page_slug);
    const pageSlugParam = `$${params.length}`;
    cursorPredicate = `
        AND (
          w.priority < ${priorityParam}
          OR (
            w.priority = ${priorityParam}
            AND w.created_at > ${createdAtParam}::timestamptz
          )
          OR (
            w.priority = ${priorityParam}
            AND w.created_at = ${createdAtParam}::timestamptz
            AND w.source_id > ${sourceIdParam}
          )
          OR (
            w.priority = ${priorityParam}
            AND w.created_at = ${createdAtParam}::timestamptz
            AND w.source_id = ${sourceIdParam}
            AND w.page_slug > ${pageSlugParam}
          )
        )`;
  }
  params.push(batchSize);
  const limitParam = `$${params.length}`;

  return engine.executeRaw<TakeMiningWorkRow>(
    `SELECT w.source_id, w.page_slug, w.mining_input_hash,
            p.compiled_truth, w.priority, w.created_at::text AS created_at
       FROM take_mining_work w
       JOIN pages p
         ON p.source_id = w.source_id
        AND p.slug = w.page_slug
      WHERE ${scoped}
        AND w.admission = ${admissionParam}
        ${batchPredicate}
        AND p.deleted_at IS NULL
        AND p.page_kind = 'markdown'
        AND p.type IN (${typePlaceholders.join(', ')})
        AND length(trim(p.compiled_truth)) > 0
        AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
        AND NOT EXISTS (
          SELECT 1
            FROM take_proposal_scans s
           WHERE s.source_id = w.source_id
             AND s.page_slug = w.page_slug
             AND s.mining_input_hash = w.mining_input_hash
             AND s.prompt_version = ${promptParam}
             AND (
               s.status = 'succeeded'
               OR (s.status = 'in_progress' AND s.lease_expires_at > now())
             )
        )
        ${cursorPredicate}
      ORDER BY w.priority DESC, w.created_at ASC, w.source_id ASC, w.page_slug ASC
      LIMIT ${limitParam}`,
    params,
  );
}

async function loadCandidateWork(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  extractableTypes: ReadonlySet<string>,
  promptVersion: string,
  selector: TakeMiningSelector,
  pageLimit: number,
  batchSize: number,
  skipPagesWithFence: boolean,
): Promise<{
  candidates: Array<{
    work: TakeMiningWorkRow;
    input: ReturnType<typeof buildTakeMiningInput>;
  }>;
  staleCount: number;
  emptyCount: number;
  batchesRead: number;
}> {
  const candidates: Array<{
    work: TakeMiningWorkRow;
    input: ReturnType<typeof buildTakeMiningInput>;
  }> = [];
  let staleCount = 0;
  let emptyCount = 0;
  let batchesRead = 0;
  let cursor: TakeMiningWorkCursor | undefined;

  while (candidates.length < pageLimit) {
    const batch = await loadEligibleWorkBatch(
      engine,
      scope,
      extractableTypes,
      promptVersion,
      selector,
      cursor,
      batchSize,
    );
    if (batch.length === 0) break;
    batchesRead++;

    for (const work of batch) {
      const input = buildTakeMiningInput(work.compiled_truth);
      if (input.prose.length === 0) {
        emptyCount++;
      } else if (input.mining_input_hash !== work.mining_input_hash) {
        staleCount++;
      } else if (!(skipPagesWithFence && hasCompleteFence(work.compiled_truth))) {
        candidates.push({ work, input });
        if (candidates.length === pageLimit) break;
      }
    }

    const last = batch.at(-1);
    if (!last || batch.length < batchSize) break;
    cursor = {
      priority: last.priority,
      created_at: last.created_at,
      source_id: last.source_id,
      page_slug: last.page_slug,
    };
  }

  return { candidates, staleCount, emptyCount, batchesRead };
}

async function claimScan(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
  promptVersion: string,
  attemptId: string,
  proposalRunId: string,
  modelId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ attempt_id: string }>(
    `INSERT INTO take_proposal_scans (
       source_id, page_slug, mining_input_hash, prompt_version,
       status, attempt_id, lease_expires_at, proposal_run_id, model_id
     ) VALUES (
       $1, $2, $3, $4, 'in_progress', $5,
       now() + ($6 * interval '1 second'), $7, $8
     )
     ON CONFLICT (source_id, page_slug, mining_input_hash, prompt_version)
     DO UPDATE SET
       attempt_id = EXCLUDED.attempt_id,
       lease_expires_at = EXCLUDED.lease_expires_at,
       proposal_run_id = EXCLUDED.proposal_run_id,
       model_id = EXCLUDED.model_id,
       updated_at = now()
     WHERE take_proposal_scans.status = 'in_progress'
       AND take_proposal_scans.lease_expires_at <= now()
     RETURNING attempt_id`,
    [
      work.source_id,
      work.page_slug,
      work.mining_input_hash,
      promptVersion,
      attemptId,
      leaseSeconds,
      proposalRunId,
      modelId,
    ],
  );
  return rows[0]?.attempt_id === attemptId;
}

async function releaseClaim(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
  promptVersion: string,
  attemptId: string,
): Promise<void> {
  await engine.executeRaw(
    `DELETE FROM take_proposal_scans
      WHERE source_id = $1
        AND page_slug = $2
        AND mining_input_hash = $3
        AND prompt_version = $4
        AND status = 'in_progress'
        AND attempt_id = $5`,
    [work.source_id, work.page_slug, work.mining_input_hash, promptVersion, attemptId],
  );
}

class ScanOwnershipLostError extends Error {}

function workPredicate(
  scope: ScopedReadOpts,
  selector: TakeMiningSelector,
  params: unknown[],
): string {
  const scoped = sourcePredicate(scope, params);
  params.push(selector.admission);
  let predicate = `${scoped} AND w.admission = $${params.length}`;
  if (selector.admission === 'deferred') {
    params.push(selector.batchId);
    predicate += ` AND w.batch_id = $${params.length}`;
  }
  return predicate;
}

async function countRemainingWork(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  selector: TakeMiningSelector,
): Promise<number> {
  const params: unknown[] = [];
  const predicate = workPredicate(scope, selector, params);
  const [row] = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM take_mining_work w
      WHERE ${predicate}`,
    params,
  );
  return row?.count ?? 0;
}

/**
 * Settle queued revisions already covered by this prompt's successful scan.
 *
 * The hash predicate is deliberately evaluated inside the DELETE so a page
 * updated while cleanup waits on its row lock is rechecked and preserved.
 */
async function settleSatisfiedWork(
  engine: BrainEngine,
  scope: ScopedReadOpts,
  selector: TakeMiningSelector,
  promptVersion: string,
  dryRun: boolean,
): Promise<number> {
  const params: unknown[] = [];
  const predicate = workPredicate(scope, selector, params);
  params.push(promptVersion);
  const promptParam = `$${params.length}`;
  const satisfiedPredicate = `${predicate}
        AND EXISTS (
          SELECT 1
            FROM take_proposal_scans s
           WHERE s.source_id = w.source_id
             AND s.page_slug = w.page_slug
             AND s.mining_input_hash = w.mining_input_hash
             AND s.prompt_version = ${promptParam}
             AND s.status = 'succeeded'
        )`;

  if (dryRun) {
    const [row] = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM take_mining_work w
        WHERE ${satisfiedPredicate}`,
      params,
    );
    return row?.count ?? 0;
  }

  const retired = await engine.executeRaw<{ page_slug: string }>(
    `DELETE FROM take_mining_work w
      WHERE ${satisfiedPredicate}
      RETURNING page_slug`,
    params,
  );
  return retired.length;
}

async function persistExtractedProposals(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
  promptVersion: string,
  attemptId: string,
  proposalRunId: string,
  modelId: string,
  proposals: ProposedTake[],
  existingTakes: ReturnType<typeof extractExistingTakesForDedup>,
): Promise<number> {
  return engine.transaction(async tx => {
    const inserted = await insertProposals(
      tx,
      work,
      promptVersion,
      proposalRunId,
      modelId,
      proposals,
      existingTakes,
    );
    await completeOwnedScan(tx, work, promptVersion, attemptId, proposals.length);
    await deleteMatchingWork(tx, work);
    return inserted;
  });
}

/** Insert proposal rows while preserving per-claim idempotency. */
async function insertProposals(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
  promptVersion: string,
  proposalRunId: string,
  modelId: string,
  proposals: ProposedTake[],
  existingTakes: ReturnType<typeof extractExistingTakesForDedup>,
): Promise<number> {
  let insertedCount = 0;
  for (const proposal of proposals) {
    const inserted = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals
         (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
          claim_text, kind, holder, weight, domain, dedup_against_fence_rows,
          model_id, claim_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (
         source_id, page_slug, content_hash, prompt_version, claim_hash
       ) DO NOTHING
       RETURNING id`,
      [
        work.source_id,
        work.page_slug,
        work.mining_input_hash,
        promptVersion,
        proposalRunId,
        proposal.claim_text,
        proposal.kind,
        proposal.holder,
        proposal.weight,
        proposal.domain ?? null,
        JSON.stringify(existingTakes),
        modelId,
        claimHash(proposal.claim_text),
      ],
    );
    insertedCount += inserted.length;
  }
  return insertedCount;
}

/** Complete only the scan lease still owned by this attempt. */
async function completeOwnedScan(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
  promptVersion: string,
  attemptId: string,
  proposalCount: number,
): Promise<void> {
  const completed = await engine.executeRaw<{ attempt_id: string }>(
    `UPDATE take_proposal_scans
        SET status = 'succeeded',
            lease_expires_at = NULL,
            proposal_count = $6,
            completed_at = now(),
            updated_at = now()
      WHERE source_id = $1
        AND page_slug = $2
        AND mining_input_hash = $3
        AND prompt_version = $4
        AND status = 'in_progress'
        AND attempt_id = $5
      RETURNING attempt_id`,
    [
      work.source_id,
      work.page_slug,
      work.mining_input_hash,
      promptVersion,
      attemptId,
      proposalCount,
    ],
  );
  if (completed.length !== 1) throw new ScanOwnershipLostError();
}

/** Delete only the semantic revision that the completed scan consumed. */
async function deleteMatchingWork(
  engine: BrainEngine,
  work: TakeMiningRunnerWork,
): Promise<void> {
  await engine.executeRaw(
    `DELETE FROM take_mining_work
      WHERE source_id = $1
        AND page_slug = $2
        AND mining_input_hash = $3`,
    [work.source_id, work.page_slug, work.mining_input_hash],
  );
}

function runnerScope(
  ctx: OperationContext,
  opts: TakeMiningRunnerOptions,
): ScopedReadOpts {
  return opts.admission === 'deferred'
    ? { sourceId: opts.sourceId }
    : sourceScopeOpts(ctx);
}

function runnerSelector(opts: TakeMiningRunnerOptions): TakeMiningSelector {
  return {
    admission: opts.admission,
    ...(opts.admission === 'deferred' ? { batchId: opts.batchId } : {}),
  };
}

async function selectRunnerWork(
  ctx: OperationContext,
  opts: TakeMiningRunnerOptions,
) {
  const extractableTypes = await resolveExtractableTypes(ctx, {
    _extractableTypes: opts._extractableTypes,
  });
  if (!extractableTypes) return null;
  const scope = runnerScope(ctx, opts);
  const selector = runnerSelector(opts);
  const satisfiedCount = await settleSatisfiedWork(
    ctx.engine,
    scope,
    selector,
    opts.promptVersion,
    opts.dryRun ?? false,
  );
  const selection = await loadCandidateWork(
    ctx.engine,
    scope,
    extractableTypes,
    opts.promptVersion,
    selector,
    opts.pageCap,
    takeMiningWorkBatchSize(opts.pageCap, opts._workBatchSize),
    opts.skipPagesWithFence ?? false,
  );
  return { ...selection, satisfiedCount };
}

async function countRunnerWork(
  ctx: OperationContext,
  opts: TakeMiningRunnerOptions,
): Promise<number> {
  return countRemainingWork(
    ctx.engine,
    runnerScope(ctx, opts),
    runnerSelector(opts),
  );
}

/**
 * Process immediate or exact deferred work with shared pacing and persistence.
 */
export const runTakeMiningWork = createTakeMiningRunner({
  promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
  defaultExtractor,
  renderRequest: renderTakeMiningRequest,
  select: selectRunnerWork,
  countRemaining: countRunnerWork,
  claim: claimScan,
  release: releaseClaim,
  existingTakes: extractExistingTakesForDedup,
  persist: persistExtractedProposals,
  isOwnershipLost: error => error instanceof ScanOwnershipLostError,
});

/**
 * BaseCyclePhase subclass. Claims admitted semantic work and writes proposals.
 */
class ProposeTakesPhase extends BaseCyclePhase {
  readonly name = 'propose_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.propose_takes.budget_usd';
  protected readonly budgetUsdDefault = 5.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('content_hash')) return 'CALIBRATION_PROPOSAL_DEDUP_FAIL';
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
    }
    return 'PROPOSE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    _scope: ScopedReadOpts,
    ctx: OperationContext,
    opts: ProposeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const locked = await withTakeMiningLock(engine, opts.signal, signal =>
      runTakeMiningWork(ctx, {
        admission: 'immediate',
        promptVersion: opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION,
        pageCap: Math.max(0, Math.floor(opts.pageLimit ?? 100)),
        model: opts.model,
        extractor: opts.extractor,
        dryRun: opts.dryRun,
        skipPagesWithFence: opts.skipPagesWithFence,
        reporter: opts.reporter,
        signal,
        _extractableTypes: opts._extractableTypes,
        _leaseSeconds: opts._leaseSeconds,
        _workBatchSize: opts._workBatchSize,
        _beforeClaim: opts._beforeClaim,
        _estimatedPageSpendUsd: opts._estimatedPageSpendUsd,
        _checkRunBudget: estimate => this.checkBudget(estimate),
      }),
    );
    if (!locked.acquired) {
      return {
        summary: 'propose_takes deferred: take mining is already in progress',
        details: {
          deferred: true,
          reason: 'take_mining_in_progress',
          lock_name: TAKE_MINING_LOCK_NAME,
        },
        status: 'warn',
      };
    }
    const result = locked.value;

    const summary = result.dry_run
      ? `(dry-run) would scan ${result.eligible_pages} eligible page${result.eligible_pages === 1 ? '' : 's'}`
      : `propose_takes: scanned ${result.pages_scanned} pages, ${result.cache_hits} cached, ${result.proposals_extracted} extracted, ${result.proposals_inserted} new proposals (run ${result.proposal_run_id})`;
    return {
      summary,
      details: { ...result },
      status: result.stopped ? 'warn' : 'ok',
    };
  }
}

/**
 * Public entry point — mirrors the v0.23 `runPhaseSynthesize` shape so the
 * cycle orchestrator in cycle.ts can call it uniformly.
 */
export async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts: ProposeTakesOpts = {},
) {
  return new ProposeTakesPhase().run(ctx, opts);
}

/** Test-only access to the class for subclassing in tests. */
export const __testing = {
  ProposeTakesPhase,
  parseExtractorOutput,
  parseExtractorOutputResult,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
};
