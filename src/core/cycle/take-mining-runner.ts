/**
 * Shared pacing and budget orchestration for immediate and deferred take mining.
 *
 * Storage-specific eligibility, claims, and proposal persistence are injected by
 * propose-takes.ts so both entry points use one canonical implementation without
 * coupling this policy module to the cycle phase class.
 */

import { randomUUID } from 'node:crypto';
import { getChatModel } from '../ai/gateway.ts';
import { estimateMaxCostUsd } from '../anthropic-pricing.ts';
import { BudgetLedger, type ReservationResult } from '../enrichment/budget.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../operations.ts';
import type { BasePhaseOpts } from './base-phase.ts';
import type { BudgetCheckResult, SubmitEstimate } from './budget-meter.ts';
import type {
  ProposeTakesExtractor,
  ProposeTakesResult,
  ProposedTake,
} from './propose-takes.ts';
import {
  TAKE_MINING_MAX_OUTPUT_TOKENS,
  TAKE_MINING_MAX_PROPOSALS_PER_PAGE,
  type RenderedTakeMiningRequest,
  type TakeMiningExtractorInput,
} from './take-mining-request.ts';

const DEFAULT_CLAIM_LEASE_SECONDS = 10 * 60;
const MIN_WORK_BATCH_SIZE = 25;
const MAX_WORK_BATCH_SIZE = 250;
const DEFAULT_DAILY_PAGE_CAP = 100;
const DEFAULT_DAILY_PROPOSAL_CAP = 200;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const DEFAULT_BUDGET_TIME_ZONE = 'America/Los_Angeles';
const DAILY_BUDGET_SCOPE = 'brain';
const DAILY_BUDGET_RESOLVER = 'take_mining';

/** Renewable lock shared by automatic and operator-triggered take mining. */
export const TAKE_MINING_LOCK_NAME = 'gbrain-take-mining';

/** Conservative aggregate pricing for a concrete preview's rendered inputs. */
export function takeMiningExpectedWorkSpend(
  pageCount: number,
  estimatedInputTokens: number,
  modelId = getChatModel(),
): {
  modelId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  maxOutputTokensPerPage: number;
  maxProposalsPerPage: number;
  estimatedSpendUsd: number | null;
} {
  const totalOutputTokens = pageCount * TAKE_MINING_MAX_OUTPUT_TOKENS;
  return {
    modelId,
    estimatedInputTokens,
    maxOutputTokens: totalOutputTokens,
    maxOutputTokensPerPage: TAKE_MINING_MAX_OUTPUT_TOKENS,
    maxProposalsPerPage: TAKE_MINING_MAX_PROPOSALS_PER_PAGE,
    estimatedSpendUsd: estimateMaxCostUsd(
      modelId,
      estimatedInputTokens,
      totalOutputTokens,
    ),
  };
}

/** A clean boundary that stopped a bounded take-mining run. */
export type TakeMiningStopReason =
  | 'schema_pack_unavailable'
  | 'unknown_model_pricing'
  | 'page_cap'
  | 'proposal_cap'
  | 'estimated_spend_cap'
  | 'daily_page_cap'
  | 'daily_proposal_cap'
  | 'daily_estimated_spend_cap'
  | 'cycle_budget';

interface TakeMiningRunnerCommon {
  promptVersion: string;
  pageCap: number;
  proposalCap?: number;
  maxEstimatedSpendUsd?: number;
  model?: string;
  extractor?: ProposeTakesExtractor;
  dryRun?: boolean;
  skipPagesWithFence?: boolean;
  reporter?: BasePhaseOpts['reporter'];
  signal?: AbortSignal;
  _extractableTypes?: readonly string[];
  _leaseSeconds?: number;
  _workBatchSize?: number;
  _beforeClaim?: (pageSlug: string) => Promise<void>;
  _estimatedPageSpendUsd?: number | null;
  _checkRunBudget?: (estimate: SubmitEstimate) => BudgetCheckResult;
}

/** Shared runner contract used by the nightly cycle and deferred drain job. */
export type TakeMiningRunnerOptions =
  | (TakeMiningRunnerCommon & {
      admission: 'immediate';
      sourceId?: never;
      batchId?: never;
    })
  | (TakeMiningRunnerCommon & {
      admission: 'deferred';
      sourceId: string;
      batchId: string;
      proposalCap: number;
      maxEstimatedSpendUsd: number;
    });

/** Structured result returned for complete and cleanly stopped runs. */
export interface TakeMiningRunResult extends ProposeTakesResult {
  admission: 'immediate' | 'deferred';
  batch_id: string | null;
  prompt_version: string;
  model_id: string;
  proposal_run_id: string;
  dry_run: boolean;
  estimated_spend_usd: number;
  stopped: boolean;
  stop_reason: TakeMiningStopReason | null;
  remaining_work: number;
  work_batches_read: number;
}

/** Invalid runner input, including a deploy-time prompt pin mismatch. */
export class TakeMiningRunnerError extends Error {
  constructor(
    public readonly code: 'invalid_options' | 'prompt_version_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'TakeMiningRunnerError';
  }
}

/** Minimal work identity passed between storage and pacing layers. */
export interface TakeMiningRunnerWork {
  source_id: string;
  page_slug: string;
  mining_input_hash: string;
  compiled_truth: string;
}

/** Candidate selected from the canonical take-mining queue. */
export interface TakeMiningRunnerCandidate {
  work: TakeMiningRunnerWork;
  input: { prose: string };
}

/** Bounded selection plus diagnostic counts. */
export interface TakeMiningRunnerSelection {
  candidates: TakeMiningRunnerCandidate[];
  /** Queued revisions already covered by a successful scan for this prompt. */
  satisfiedCount: number;
  staleCount: number;
  emptyCount: number;
  batchesRead: number;
}

type ExistingTake = {
  claim: string;
  kind: string;
  holder: string;
  weight: number;
};

/** Storage and extraction operations owned by the take-mining domain module. */
export interface TakeMiningRunnerDependencies {
  promptVersion: string;
  defaultExtractor: ProposeTakesExtractor;
  renderRequest(input: TakeMiningExtractorInput): RenderedTakeMiningRequest;
  select(
    ctx: OperationContext,
    opts: TakeMiningRunnerOptions,
  ): Promise<TakeMiningRunnerSelection | null>;
  countRemaining(
    ctx: OperationContext,
    opts: TakeMiningRunnerOptions,
  ): Promise<number>;
  claim(
    engine: BrainEngine,
    work: TakeMiningRunnerWork,
    promptVersion: string,
    attemptId: string,
    proposalRunId: string,
    modelId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  release(
    engine: BrainEngine,
    work: TakeMiningRunnerWork,
    promptVersion: string,
    attemptId: string,
  ): Promise<void>;
  existingTakes(pageBody: string): ExistingTake[];
  persist(
    engine: BrainEngine,
    work: TakeMiningRunnerWork,
    promptVersion: string,
    attemptId: string,
    proposalRunId: string,
    modelId: string,
    proposals: ProposedTake[],
    existingTakes: ExistingTake[],
  ): Promise<number>;
  isOwnershipLost(error: unknown): boolean;
}

interface DailyTakeMiningCaps {
  pageCap: number;
  proposalCap: number;
  spendCapUsd: number;
  timeZone: string;
  localDate: string;
}

interface DailyTakeMiningUsage {
  pageCalls: number;
  proposals: number;
}

interface CandidateContext {
  engine: BrainEngine;
  opts: TakeMiningRunnerOptions;
  result: TakeMiningRunResult;
  caps: DailyTakeMiningCaps;
  ledger: BudgetLedger;
  extractor: ProposeTakesExtractor;
  modelId: string;
  leaseSeconds: number;
  deps: TakeMiningRunnerDependencies;
}

interface PreparedCandidate {
  existingTakes: ExistingTake[];
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedSpendUsd: number;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TakeMiningRunnerError(
      'invalid_options',
      `${field} must be a positive integer`,
    );
  }
}

function requireIntegerInRange(
  value: number,
  field: string,
  maximum: number,
): void {
  requirePositiveInteger(value, field);
  if (value > maximum) {
    throw new TakeMiningRunnerError(
      'invalid_options',
      `${field} must be at most ${maximum}`,
    );
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TakeMiningRunnerError(
      'invalid_options',
      `${field} must be a non-negative integer`,
    );
  }
}

function requirePositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TakeMiningRunnerError(
      'invalid_options',
      `${field} must be finite and greater than zero`,
    );
  }
}

function validateRunnerOptions(
  opts: TakeMiningRunnerOptions,
  runningPromptVersion: string,
): void {
  if (opts.promptVersion !== runningPromptVersion) {
    throw new TakeMiningRunnerError(
      'prompt_version_mismatch',
      `Pinned prompt ${opts.promptVersion} does not match running prompt ${runningPromptVersion}; preview and resubmit the batch`,
    );
  }
  if (opts.admission === 'deferred') {
    requireIntegerInRange(opts.pageCap, 'pageCap', 100);
    if (opts.sourceId.trim().length === 0 || opts.batchId.trim().length === 0) {
      throw new TakeMiningRunnerError(
        'invalid_options',
        'Deferred runs require exact non-empty sourceId and batchId',
      );
    }
    requireIntegerInRange(opts.proposalCap, 'proposalCap', 500);
    requirePositiveFinite(opts.maxEstimatedSpendUsd, 'maxEstimatedSpendUsd');
    return;
  }
  requireNonNegativeInteger(opts.pageCap, 'pageCap');
  if (opts.proposalCap !== undefined) {
    requirePositiveInteger(opts.proposalCap, 'proposalCap');
  }
  if (opts.maxEstimatedSpendUsd !== undefined) {
    requirePositiveFinite(opts.maxEstimatedSpendUsd, 'maxEstimatedSpendUsd');
  }
}

async function readNonNegativeConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function currentDateInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function resolveDailyCaps(engine: BrainEngine): Promise<DailyTakeMiningCaps> {
  const [pageCap, proposalCap, spendCapUsd, configuredTimeZone] =
    await Promise.all([
      readNonNegativeConfig(
        engine,
        'take_mining.daily_page_cap',
        DEFAULT_DAILY_PAGE_CAP,
      ),
      readNonNegativeConfig(
        engine,
        'take_mining.daily_proposal_cap',
        DEFAULT_DAILY_PROPOSAL_CAP,
      ),
      readNonNegativeConfig(
        engine,
        'take_mining.daily_estimated_spend_usd',
        DEFAULT_DAILY_SPEND_CAP_USD,
      ),
      engine.getConfig('budget.tz'),
    ]);
  const timeZone = configuredTimeZone || DEFAULT_BUDGET_TIME_ZONE;
  return {
    pageCap,
    proposalCap,
    spendCapUsd,
    timeZone,
    localDate: currentDateInTimeZone(timeZone),
  };
}

async function readDailyUsage(
  engine: BrainEngine,
  caps: DailyTakeMiningCaps,
): Promise<DailyTakeMiningUsage> {
  const [pageRow, proposalRow] = await Promise.all([
    engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM budget_reservations
        WHERE scope = $1
          AND resolver_id = $2
          AND local_date = $3::date
          AND status IN ('held', 'committed')`,
      [DAILY_BUDGET_SCOPE, DAILY_BUDGET_RESOLVER, caps.localDate],
    ),
    engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM take_proposals
        WHERE (proposed_at AT TIME ZONE $2) >= $1::date
          AND (proposed_at AT TIME ZONE $2) < ($1::date + interval '1 day')`,
      [caps.localDate, caps.timeZone],
    ),
  ]);
  return {
    pageCalls: pageRow[0]?.count ?? 0,
    proposals: proposalRow[0]?.count ?? 0,
  };
}

function markStopped(
  result: TakeMiningRunResult,
  reason: TakeMiningStopReason,
  warning: string,
): void {
  result.stopped = true;
  result.stop_reason = reason;
  result.warnings.push(warning);
  if (
    reason === 'unknown_model_pricing'
    || reason === 'estimated_spend_cap'
    || reason === 'daily_estimated_spend_cap'
    || reason === 'cycle_budget'
  ) {
    result.budget_exhausted = true;
  }
}

function buildInitialResult(
  opts: TakeMiningRunnerOptions,
  modelId: string,
): TakeMiningRunResult {
  return {
    admission: opts.admission,
    batch_id: opts.admission === 'deferred' ? opts.batchId : null,
    prompt_version: opts.promptVersion,
    model_id: modelId,
    proposal_run_id:
      `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}` +
      `-${randomUUID().slice(0, 8)}`,
    dry_run: opts.dryRun ?? false,
    eligible_pages: 0,
    pages_scanned: 0,
    cache_hits: 0,
    cache_misses: 0,
    proposals_extracted: 0,
    proposals_inserted: 0,
    estimated_spend_usd: 0,
    budget_exhausted: false,
    stopped: false,
    stop_reason: null,
    remaining_work: 0,
    work_batches_read: 0,
    warnings: [],
  };
}

function applySelectionDiagnostics(
  result: TakeMiningRunResult,
  selection: TakeMiningRunnerSelection,
): void {
  result.eligible_pages = selection.candidates.length;
  result.cache_hits += selection.satisfiedCount;
  result.work_batches_read = selection.batchesRead;
  if (selection.staleCount > 0) {
    result.warnings.push(
      `${selection.staleCount} take-mining work item${selection.staleCount === 1 ? '' : 's'} had stale semantic hashes and ${selection.staleCount === 1 ? 'was' : 'were'} preserved`,
    );
  }
  if (selection.emptyCount > 0) {
    result.warnings.push(
      `${selection.emptyCount} take-mining work item${selection.emptyCount === 1 ? '' : 's'} had no canonical prose and ${selection.emptyCount === 1 ? 'was' : 'were'} preserved`,
    );
  }
}

async function pacingStop(
  context: CandidateContext,
  estimatedPageSpend: number,
): Promise<[TakeMiningStopReason, string] | null> {
  const { engine, caps, opts, result } = context;
  const usage = await readDailyUsage(engine, caps);
  if (usage.pageCalls >= caps.pageCap) {
    return ['daily_page_cap', 'brain-wide daily page cap reached'];
  }
  if (usage.proposals >= caps.proposalCap) {
    return ['daily_proposal_cap', 'brain-wide daily proposal cap reached'];
  }
  if (opts.proposalCap !== undefined && result.proposals_inserted >= opts.proposalCap) {
    return ['proposal_cap', 'per-run proposal cap reached'];
  }
  if (
    opts.maxEstimatedSpendUsd !== undefined
    && result.estimated_spend_usd + estimatedPageSpend >
      opts.maxEstimatedSpendUsd + 1e-9
  ) {
    return ['estimated_spend_cap', 'per-run estimated-spend cap reached'];
  }
  return null;
}

async function reserveAttempt(
  context: CandidateContext,
  work: TakeMiningRunnerWork,
  prepared: PreparedCandidate,
): Promise<Extract<ReservationResult, { kind: 'held' }> | null> {
  const { ledger, caps, opts, modelId, result } = context;
  const estimatedPageSpend = prepared.estimatedSpendUsd;
  const reserved = await ledger.reserve({
    scope: DAILY_BUDGET_SCOPE,
    resolverId: DAILY_BUDGET_RESOLVER,
    estimateUsd: estimatedPageSpend,
    capUsd: caps.spendCapUsd,
    ttlSeconds: context.leaseSeconds,
  });
  if (reserved.kind === 'exhausted') {
    markStopped(
      result,
      'daily_estimated_spend_cap',
      `brain-wide daily estimated-spend cap reached: ${reserved.reason}`,
    );
    return null;
  }

  let budget: BudgetCheckResult | undefined;
  try {
    budget = opts._checkRunBudget?.({
      modelId,
      estimatedInputTokens: prepared.estimatedInputTokens,
      maxOutputTokens: prepared.maxOutputTokens,
    });
  } catch (error) {
    await ledger.rollback(reserved.reservationId);
    throw error;
  }
  if (budget?.allowed === false) {
    await ledger.rollback(reserved.reservationId);
    markStopped(
      result,
      'cycle_budget',
      `budget exhausted before ${work.page_slug} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
    );
    return null;
  }
  return reserved;
}

async function invokeExtractor(
  context: CandidateContext,
  candidate: TakeMiningRunnerCandidate,
  prepared: PreparedCandidate,
  reservation: Extract<ReservationResult, { kind: 'held' }>,
): Promise<{ proposals: ProposedTake[]; existingTakes: ExistingTake[] } | null> {
  const { work, input } = candidate;
  const { opts, extractor, result, ledger } = context;
  const estimatedPageSpend = prepared.estimatedSpendUsd;
  try {
    opts.signal?.throwIfAborted();
  } catch (error) {
    await ledger.rollback(reservation.reservationId);
    throw error;
  }
  let extraction: Promise<ProposedTake[]>;
  try {
    extraction = Promise.resolve(extractor({
      pagePath: work.page_slug,
      pageBody: input.prose,
      existingTakes: prepared.existingTakes,
      modelHint: opts.model,
    }));
  } catch (error) {
    extraction = Promise.reject(error);
  }

  result.pages_scanned++;
  result.cache_misses++;
  result.estimated_spend_usd += estimatedPageSpend;
  try {
    await ledger.commit(reservation.reservationId, estimatedPageSpend);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`daily spend commit warning: ${message}`);
  }

  try {
    const rawProposals = await waitForExtraction(extraction, opts.signal);
    const proposals = rawProposals.slice(0, TAKE_MINING_MAX_PROPOSALS_PER_PAGE);
    if (rawProposals.length > TAKE_MINING_MAX_PROPOSALS_PER_PAGE) {
      result.warnings.push(
        `extractor returned ${rawProposals.length} proposals for ${work.page_slug}; ` +
        `kept the strongest ${TAKE_MINING_MAX_PROPOSALS_PER_PAGE}`,
      );
    }
    return {
      proposals,
      existingTakes: prepared.existingTakes,
    };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`extractor failed on ${work.page_slug}: ${message}`);
    return null;
  }
}

function prepareCandidate(
  opts: TakeMiningRunnerOptions,
  modelId: string,
  deps: TakeMiningRunnerDependencies,
  candidate: TakeMiningRunnerCandidate,
): PreparedCandidate | null {
  const existingTakes = deps.existingTakes(
    candidate.work.compiled_truth,
  );
  const request = deps.renderRequest({
    pagePath: candidate.work.page_slug,
    pageBody: candidate.input.prose,
    existingTakes,
    modelHint: opts.model,
  });
  const estimatedSpendUsd = opts._estimatedPageSpendUsd === undefined
    ? estimateMaxCostUsd(
      modelId,
      request.estimatedInputTokens,
      request.maxTokens,
    )
    : opts._estimatedPageSpendUsd;
  if (estimatedSpendUsd === null) return null;
  return {
    existingTakes,
    estimatedInputTokens: request.estimatedInputTokens,
    maxOutputTokens: request.maxTokens,
    estimatedSpendUsd,
  };
}

async function proposalPersistenceStop(
  context: CandidateContext,
  proposalCount: number,
): Promise<[TakeMiningStopReason, string] | null> {
  const { caps, engine, opts, result } = context;
  if (
    opts.proposalCap !== undefined
    && result.proposals_inserted + proposalCount > opts.proposalCap
  ) {
    return [
      'proposal_cap',
      `complete page result (${proposalCount}) would exceed the per-run ` +
      `proposal cap; no proposals from this page were persisted`,
    ];
  }
  const usage = await readDailyUsage(engine, caps);
  if (usage.proposals + proposalCount > caps.proposalCap) {
    return [
      'daily_proposal_cap',
      `complete page result (${proposalCount}) would exceed the brain-wide ` +
      `daily proposal cap; no proposals from this page were persisted`,
    ];
  }
  return null;
}

/**
 * Cooperatively abandon a provider wait when the worker is cancelled.
 *
 * The provider request may already be in flight, so its estimate remains
 * committed while the owned scan claim is released by the caller.
 */
async function waitForExtraction<T>(
  extraction: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return extraction;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    extraction.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function processCandidate(
  context: CandidateContext,
  candidate: TakeMiningRunnerCandidate,
): Promise<'continue' | 'stop'> {
  const { work } = candidate;
  const prepared = prepareCandidate(
    context.opts,
    context.modelId,
    context.deps,
    candidate,
  );
  if (!prepared) {
    markStopped(
      context.result,
      'unknown_model_pricing',
      `model ${context.modelId} has no pricing; capped take mining fails closed`,
    );
    return 'stop';
  }
  const stop = await pacingStop(context, prepared.estimatedSpendUsd);
  if (stop) {
    markStopped(context.result, ...stop);
    return 'stop';
  }

  context.opts.signal?.throwIfAborted();
  await context.opts._beforeClaim?.(work.page_slug);
  const attemptId = randomUUID();
  const claimed = await context.deps.claim(
    context.engine,
    work,
    context.opts.promptVersion,
    attemptId,
    context.result.proposal_run_id,
    context.modelId,
    context.leaseSeconds,
  );
  if (!claimed) {
    context.result.cache_hits++;
    return 'continue';
  }

  let claimSettled = false;
  try {
    const reservation = await reserveAttempt(context, work, prepared);
    if (!reservation) {
      return 'stop';
    }
    const extracted = await invokeExtractor(
      context,
      candidate,
      prepared,
      reservation,
    );
    if (!extracted) {
      return 'continue';
    }
    context.result.proposals_extracted += extracted.proposals.length;
    const proposalStop = await proposalPersistenceStop(
      context,
      extracted.proposals.length,
    );
    if (proposalStop) {
      markStopped(context.result, ...proposalStop);
      return 'stop';
    }
    context.result.proposals_inserted += await context.deps.persist(
      context.engine,
      work,
      context.opts.promptVersion,
      attemptId,
      context.result.proposal_run_id,
      context.modelId,
      extracted.proposals,
      extracted.existingTakes,
    );
    claimSettled = true;
  } catch (error) {
    if (context.deps.isOwnershipLost(error)) {
      context.result.warnings.push(`scan ownership lost for ${work.page_slug}`);
      claimSettled = true;
      return 'continue';
    }
    throw error;
  } finally {
    if (!claimSettled) {
      await context.deps.release(
        context.engine,
        work,
        context.opts.promptVersion,
        attemptId,
      );
    }
  }
  return 'continue';
}

async function processCandidates(
  context: CandidateContext,
  candidates: TakeMiningRunnerCandidate[],
): Promise<void> {
  await context.ledger.cleanupExpired();
  for (const candidate of candidates) {
    context.opts.reporter?.tick(1, candidate.work.page_slug);
    if (await processCandidate(context, candidate) === 'stop') break;
  }
}

async function recordRunOutcome(
  engine: BrainEngine,
  sourceId: string,
  result: TakeMiningRunResult,
): Promise<void> {
  if (result.proposals_inserted > 0) {
    try {
      await writeReceipt(engine, {
        kind: 'takes.proposed',
        source_id: sourceId,
        run_id: result.proposal_run_id,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: result.proposals_inserted,
        cost_usd: result.estimated_spend_usd,
        summary:
          `Extracted ${result.proposals_extracted} takes and created ` +
          `${result.proposals_inserted} proposals from ${result.pages_scanned} pages ` +
          `(${result.cache_hits} cached).`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`receipt write failed: ${message}`);
    }
  }
  await upsertExtractRollup(engine, {
    kind: 'takes.proposed',
    source_id: sourceId,
    round_completed_delta: result.budget_exhausted ? 0 : 1,
    halt_delta: result.budget_exhausted ? 1 : 0,
  });
}

/**
 * Create the shared runner used by the nightly cycle and deferred drain job.
 *
 * Every production caller must hold and renew `TAKE_MINING_LOCK_NAME` while
 * calling the resulting function. This includes both the immediate cycle
 * adapter and the deferred drain handler. BudgetLedger serializes spend
 * reservations; the shared external lock makes page/proposal count checks
 * race-safe across modes and sources.
 */
export function createTakeMiningRunner(deps: TakeMiningRunnerDependencies) {
  return async function runTakeMiningWork(
    ctx: OperationContext,
    opts: TakeMiningRunnerOptions,
  ): Promise<TakeMiningRunResult> {
    validateRunnerOptions(opts, deps.promptVersion);
    const engine = ctx.engine;
    const modelId = opts.model ?? getChatModel();
    const result = buildInitialResult(opts, modelId);
    const selection = await deps.select(ctx, opts);
    if (!selection) {
      markStopped(
        result,
        'schema_pack_unavailable',
        'active schema pack could not be resolved; take mining skipped safely',
      );
      result.remaining_work = await deps.countRemaining(ctx, opts);
      return result;
    }

    applySelectionDiagnostics(result, selection);
    opts.reporter?.start('propose_takes.pages' as never, result.eligible_pages);
    const pricingAvailable = opts._estimatedPageSpendUsd === undefined
      ? estimateMaxCostUsd(modelId, 0, TAKE_MINING_MAX_OUTPUT_TOKENS) !== null
      : opts._estimatedPageSpendUsd !== null;
    if (!pricingAvailable) {
      markStopped(
        result,
        'unknown_model_pricing',
        `model ${modelId} has no pricing; capped take mining fails closed`,
      );
    } else if (opts.dryRun) {
      for (const candidate of selection.candidates) {
        const prepared = prepareCandidate(opts, modelId, deps, candidate);
        result.estimated_spend_usd += prepared?.estimatedSpendUsd ?? 0;
      }
    } else {
      const caps = await resolveDailyCaps(engine);
      await processCandidates({
        engine,
        opts,
        result,
        caps,
        ledger: new BudgetLedger(engine, { tz: caps.timeZone }),
        extractor: opts.extractor ?? deps.defaultExtractor,
        modelId,
        leaseSeconds: opts._leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS,
        deps,
      }, selection.candidates);
    }

    opts.reporter?.finish();
    result.remaining_work = await deps.countRemaining(ctx, opts);
    if (
      !result.stopped
      && opts.admission === 'deferred'
      && result.remaining_work > 0
      && result.eligible_pages >= opts.pageCap
    ) {
      markStopped(result, 'page_cap', 'per-run page cap reached');
    }
    if (!opts.dryRun) {
      const sourceId = opts.admission === 'deferred'
        ? opts.sourceId
        : ctx.sourceId ?? 'default';
      await recordRunOutcome(engine, sourceId, result);
    }
    return result;
  };
}

/** Compute the bounded selector page size without changing queue semantics. */
export function takeMiningWorkBatchSize(
  pageCap: number,
  configured?: number,
): number {
  return Math.max(
    1,
    Math.floor(configured ?? Math.max(
      MIN_WORK_BATCH_SIZE,
      Math.min(pageCap * 2, MAX_WORK_BATCH_SIZE),
    )),
  );
}
