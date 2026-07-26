import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './operations.ts';
import { PROPOSE_TAKES_PROMPT_VERSION } from './cycle/propose-takes.ts';
import { buildTakeMiningInput } from './cycle/take-mining-input.ts';
import { loadActivePackBestEffort } from './schema-pack/best-effort.ts';
import { extractableTypesFromPack } from './schema-pack/extractable.ts';

const DEFAULT_DISCOVERY_BATCH_SIZE = 250;
const DEFAULT_MAX_DISCOVERY_ROWS = 25_000;
const DEFAULT_DAILY_PAGE_CAP = 100;
const DEFAULT_DAILY_PROPOSAL_CAP = 200;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const DEFAULT_BUDGET_TIME_ZONE = 'America/Los_Angeles';
const MAX_PAGE_CAP = 5_000;
const MAX_EXACT_SLUGS = 1_000;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Operator-declared purpose for an explicit take-mining enrollment batch. */
export type TakeMiningEnrollmentReason =
  | 'historical_backfill'
  | 'prompt_upgrade'
  | 'operator_remine';

/** Filters and limits for one explicit take-mining enrollment pass. */
export interface TakeMiningEnrollmentInput {
  sourceId: string;
  batchId: string;
  reason: TakeMiningEnrollmentReason;
  pageCap: number;
  slugPrefix?: string;
  slugs?: string[];
  effectiveFrom?: string;
  effectiveTo?: string;
  afterSlug?: string;
}

/** Dependency overrides for deterministic control-layer tests. */
export interface TakeMiningControlDependencies {
  extractableTypes?: ReadonlySet<string>;
  promptVersion?: string;
  discoveryBatchSize?: number;
  maxDiscoveryRows?: number;
}

/** One page selected by an enrollment preview. */
export interface TakeMiningEnrollmentItem {
  slug: string;
  type: string;
  effectiveDate: string | null;
  effectiveDateSource: string | null;
  miningInputHash: string;
}

/** Read-only result of applying enrollment filters and current-work guards. */
export interface TakeMiningEnrollmentPreview {
  dryRun: true;
  sourceId: string;
  batchId: string;
  reason: TakeMiningEnrollmentReason;
  promptVersion: string;
  inspectedPages: number;
  eligiblePages: number;
  alreadyScannedPages: number;
  existingImmediatePages: number;
  existingOtherBatchPages: number;
  existingWriteTriggeredPages: number;
  alreadyEnrolledPages: number;
  items: TakeMiningEnrollmentItem[];
  nextAfterSlug: string | null;
  truncated: boolean;
}

/** Result of an idempotent explicit-enrollment write. */
export interface TakeMiningEnqueueResult
  extends Omit<TakeMiningEnrollmentPreview, 'dryRun'> {
  dryRun: false;
  enqueuedPages: number;
  skippedConcurrentPages: number;
}

/** Queue counts for one source. */
export interface TakeMiningQueueStatus {
  total: number;
  immediate: number;
  deferred: number;
}

/** Deferred queue state for one explicit enrollment batch. */
export interface TakeMiningBatchStatus {
  batchId: string;
  queuedPages: number;
  oldestAt: string | null;
  newestAt: string | null;
}

/** Current daily take-mining usage and configured caps when available. */
export interface TakeMiningDailyStatus {
  localDate: string;
  reservedUsd: number;
  committedUsd: number;
  budgetCapUsd: number | null;
  configuredPageCap: number | null;
  configuredProposalCap: number | null;
  pageCalls: number;
  proposals: number;
}

/** Read-only queue, batch, and daily take-mining status. */
export interface TakeMiningStatus {
  promptVersion: string;
  sourceId: string;
  queue: TakeMiningQueueStatus;
  batch: TakeMiningBatchStatus | null;
  daily: TakeMiningDailyStatus;
}

/** Structured validation or schema-pack failure from enrollment control. */
export class TakeMiningControlError extends Error {
  constructor(
    public readonly code: 'invalid_input' | 'schema_pack_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'TakeMiningControlError';
  }
}

interface CandidateRow {
  slug: string;
  type: string;
  compiled_truth: string;
  effective_date: Date | string | null;
  effective_date_source: string | null;
  work_hash: string | null;
  work_admission: 'immediate' | 'deferred' | null;
  work_batch_id: string | null;
  work_page_mutation_id: number | null;
}

interface EligibleCandidate extends TakeMiningEnrollmentItem {
  compiledTruth: string;
}

interface DiscoveryResult extends TakeMiningEnrollmentPreview {
  eligibleCandidates: EligibleCandidate[];
}

interface DiscoveryCounters {
  inspectedPages: number;
  alreadyScannedPages: number;
  existingImmediatePages: number;
  existingOtherBatchPages: number;
  existingWriteTriggeredPages: number;
  alreadyEnrolledPages: number;
}

/**
 * Preview explicit enrollment without mutating queue, scan, proposal, or
 * budget state.
 */
export async function previewTakeMiningEnrollment(
  ctx: OperationContext,
  input: TakeMiningEnrollmentInput,
  dependencies: TakeMiningControlDependencies = {},
): Promise<TakeMiningEnrollmentPreview> {
  const discovery = await discoverEnrollment(ctx, input, dependencies);
  return publicPreview(discovery);
}

/**
 * Enqueue current canonical inputs as deferred work without overwriting
 * immediate, write-triggered, or differently batched work.
 */
export async function enqueueTakeMiningWork(
  ctx: OperationContext,
  input: TakeMiningEnrollmentInput,
  dependencies: TakeMiningControlDependencies = {},
): Promise<TakeMiningEnqueueResult> {
  const discovery = await discoverEnrollment(ctx, input, dependencies);
  const actor = enrollmentActor(ctx);
  let enqueuedPages = 0;

  await ctx.engine.transaction(async engine => {
    for (const candidate of discovery.eligibleCandidates) {
      enqueuedPages += await upsertEnrollmentCandidate(
        engine,
        input,
        candidate,
        actor,
      );
    }
  });

  return {
    ...publicPreview(discovery),
    dryRun: false,
    enqueuedPages,
    skippedConcurrentPages: discovery.eligiblePages - enqueuedPages,
  };
}

/** Read current queue, optional batch, and daily usage state without writes. */
export async function getTakeMiningStatus(
  ctx: OperationContext,
  input: { sourceId: string; batchId?: string },
): Promise<TakeMiningStatus> {
  assertSourceAccess(ctx, input.sourceId);
  if (input.batchId !== undefined) validateBatchId(input.batchId);

  const [queue, batch, daily] = await Promise.all([
    readQueueStatus(ctx.engine, input.sourceId),
    input.batchId
      ? readBatchStatus(ctx.engine, input.sourceId, input.batchId)
      : Promise.resolve(null),
    readDailyStatus(ctx.engine),
  ]);
  return {
    promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
    sourceId: input.sourceId,
    queue,
    batch,
    daily,
  };
}

async function discoverEnrollment(
  ctx: OperationContext,
  input: TakeMiningEnrollmentInput,
  dependencies: TakeMiningControlDependencies,
): Promise<DiscoveryResult> {
  validateEnrollmentInput(ctx, input);
  const extractableTypes = await resolveExtractableTypes(
    ctx,
    input.sourceId,
    dependencies,
  );
  const promptVersion = dependencies.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
  const batchSize = positiveInteger(
    dependencies.discoveryBatchSize ?? DEFAULT_DISCOVERY_BATCH_SIZE,
    'discoveryBatchSize',
  );
  const maxRows = positiveInteger(
    dependencies.maxDiscoveryRows ?? DEFAULT_MAX_DISCOVERY_ROWS,
    'maxDiscoveryRows',
  );
  const counters = emptyCounters();
  const eligibleCandidates: EligibleCandidate[] = [];
  let cursor = input.afterSlug;
  let reachedEnd = false;

  // Keyset batches bound database and memory work even when many candidates
  // are excluded by successful scans or protected queue entries.
  while (counters.inspectedPages < maxRows && eligibleCandidates.length < input.pageCap) {
    const limit = Math.min(batchSize, maxRows - counters.inspectedPages);
    const rows = await readCandidateBatch(
      ctx.engine,
      input,
      extractableTypes,
      cursor,
      limit,
    );
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }

    const successful = await successfulScanKeys(
      ctx.engine,
      input.sourceId,
      promptVersion,
      rows,
    );
    for (const row of rows) {
      cursor = row.slug;
      counters.inspectedPages++;
      classifyCandidate(
        row,
        input,
        successful,
        counters,
        eligibleCandidates,
      );
      if (eligibleCandidates.length === input.pageCap) break;
    }
    if (eligibleCandidates.length === input.pageCap) break;
    if (rows.length < limit) {
      reachedEnd = true;
      break;
    }
  }

  const truncated = !reachedEnd;
  return {
    dryRun: true,
    sourceId: input.sourceId,
    batchId: input.batchId,
    reason: input.reason,
    promptVersion,
    ...counters,
    eligiblePages: eligibleCandidates.length,
    items: eligibleCandidates.map(publicItem),
    nextAfterSlug: truncated ? (cursor ?? null) : null,
    truncated,
    eligibleCandidates,
  };
}

function classifyCandidate(
  row: CandidateRow,
  input: TakeMiningEnrollmentInput,
  successful: ReadonlySet<string>,
  counters: DiscoveryCounters,
  eligible: EligibleCandidate[],
): void {
  const canonical = buildTakeMiningInput(row.compiled_truth);
  if (canonical.prose.length === 0) return;
  if (successful.has(scanKey(row.slug, canonical.mining_input_hash))) {
    counters.alreadyScannedPages++;
    return;
  }
  if (row.work_admission === 'immediate') {
    counters.existingImmediatePages++;
    return;
  }
  if (row.work_admission === 'deferred' && row.work_batch_id !== input.batchId) {
    counters.existingOtherBatchPages++;
    return;
  }
  if (row.work_admission === 'deferred' && row.work_page_mutation_id !== null) {
    counters.existingWriteTriggeredPages++;
    return;
  }
  if (
    row.work_admission === 'deferred'
    && row.work_hash === canonical.mining_input_hash
  ) {
    counters.alreadyEnrolledPages++;
    return;
  }
  eligible.push({
    slug: row.slug,
    type: row.type,
    effectiveDate: isoDate(row.effective_date),
    effectiveDateSource: row.effective_date_source,
    miningInputHash: canonical.mining_input_hash,
    compiledTruth: row.compiled_truth,
  });
}

async function readCandidateBatch(
  engine: BrainEngine,
  input: TakeMiningEnrollmentInput,
  extractableTypes: ReadonlySet<string>,
  cursor: string | undefined,
  limit: number,
): Promise<CandidateRow[]> {
  if (extractableTypes.size === 0) return [];
  const params: unknown[] = [input.sourceId];
  const where = [
    'p.source_id = $1',
    "p.page_kind = 'markdown'",
    'p.deleted_at IS NULL',
    "btrim(p.compiled_truth) <> ''",
    "COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'",
  ];
  where.push(`p.type IN (${placeholders(params, [...extractableTypes].sort())})`);
  if (input.slugPrefix !== undefined) {
    params.push(input.slugPrefix);
    where.push(`strpos(p.slug, $${params.length}) = 1`);
  }
  if (input.slugs !== undefined) {
    where.push(`p.slug IN (${placeholders(params, input.slugs)})`);
  }
  if (input.effectiveFrom !== undefined) {
    params.push(input.effectiveFrom);
    where.push(`p.effective_date >= $${params.length}::date`);
  }
  if (input.effectiveTo !== undefined) {
    params.push(input.effectiveTo);
    where.push(`p.effective_date < ($${params.length}::date + interval '1 day')`);
  }
  if (cursor !== undefined) {
    params.push(cursor);
    where.push(`p.slug > $${params.length}`);
  }
  params.push(limit);

  return engine.executeRaw<CandidateRow>(
    `SELECT p.slug, p.type, p.compiled_truth,
            p.effective_date, p.effective_date_source,
            w.mining_input_hash AS work_hash,
            w.admission AS work_admission,
            w.batch_id AS work_batch_id,
            w.page_mutation_id AS work_page_mutation_id
       FROM pages p
       LEFT JOIN take_mining_work w
         ON w.source_id = p.source_id
        AND w.page_slug = p.slug
      WHERE ${where.join('\n        AND ')}
      ORDER BY p.slug
      LIMIT $${params.length}`,
    params,
  );
}

async function successfulScanKeys(
  engine: BrainEngine,
  sourceId: string,
  promptVersion: string,
  rows: CandidateRow[],
): Promise<Set<string>> {
  const slugs = rows.map(row => row.slug);
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [sourceId, promptVersion];
  const slugSql = placeholders(params, slugs);
  const scans = await engine.executeRaw<{
    page_slug: string;
    mining_input_hash: string;
  }>(
    `SELECT page_slug, mining_input_hash
       FROM take_proposal_scans
      WHERE source_id = $1
        AND prompt_version = $2
        AND status = 'succeeded'
        AND page_slug IN (${slugSql})`,
    params,
  );
  return new Set(scans.map(scan => scanKey(scan.page_slug, scan.mining_input_hash)));
}

async function upsertEnrollmentCandidate(
  engine: BrainEngine,
  input: TakeMiningEnrollmentInput,
  candidate: EligibleCandidate,
  actor: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ page_slug: string }>(
    `INSERT INTO take_mining_work (
       source_id, page_slug, mining_input_hash, admission,
       write_intent, actor, batch_id, reason, priority, page_mutation_id
     )
     SELECT p.source_id, p.slug, $3, 'deferred',
            NULL, $4, $5, $6, 0, NULL
       FROM pages p
      WHERE p.source_id = $1
        AND p.slug = $2
        AND p.compiled_truth = $7
        AND p.deleted_at IS NULL
     ON CONFLICT (source_id, page_slug) DO UPDATE
       SET mining_input_hash = EXCLUDED.mining_input_hash,
           actor = EXCLUDED.actor,
           reason = EXCLUDED.reason,
           updated_at = now()
     WHERE take_mining_work.admission = 'deferred'
       AND take_mining_work.batch_id = EXCLUDED.batch_id
       AND take_mining_work.page_mutation_id IS NULL
       AND take_mining_work.mining_input_hash <> EXCLUDED.mining_input_hash
     RETURNING page_slug`,
    [
      input.sourceId,
      candidate.slug,
      candidate.miningInputHash,
      actor,
      input.batchId,
      input.reason,
      candidate.compiledTruth,
    ],
  );
  return rows.length;
}

async function resolveExtractableTypes(
  ctx: OperationContext,
  sourceId: string,
  dependencies: TakeMiningControlDependencies,
): Promise<ReadonlySet<string>> {
  if (dependencies.extractableTypes) return dependencies.extractableTypes;
  const pack = await loadActivePackBestEffort({ ...ctx, sourceId });
  if (!pack) {
    throw new TakeMiningControlError(
      'schema_pack_unavailable',
      'Cannot enroll take-mining work without an active schema pack.',
    );
  }
  return extractableTypesFromPack(pack.manifest);
}

function validateEnrollmentInput(
  ctx: OperationContext,
  input: TakeMiningEnrollmentInput,
): void {
  assertSourceAccess(ctx, input.sourceId);
  validateBatchId(input.batchId);
  positiveInteger(input.pageCap, 'pageCap', MAX_PAGE_CAP);
  if (input.slugs && input.slugs.length > MAX_EXACT_SLUGS) {
    invalid(`slugs must contain at most ${MAX_EXACT_SLUGS} entries`);
  }
  if (input.slugs && input.slugs.length === 0) {
    invalid('slugs must contain at least one value when provided');
  }
  if (input.slugs?.some(slug => slug.length === 0)) {
    invalid('slugs must not contain empty values');
  }
  validateDate(input.effectiveFrom, 'effectiveFrom');
  validateDate(input.effectiveTo, 'effectiveTo');
  if (
    input.effectiveFrom
    && input.effectiveTo
    && input.effectiveFrom > input.effectiveTo
  ) {
    invalid('effectiveFrom must be on or before effectiveTo');
  }
}

function assertSourceAccess(ctx: OperationContext, sourceId: string): void {
  if (sourceId.length === 0) invalid('sourceId must not be empty');
  if (ctx.remote && ctx.sourceId !== sourceId) {
    invalid(`sourceId ${sourceId} is outside the caller's write scope`);
  }
}

function validateBatchId(batchId: string): void {
  if (!BATCH_ID_PATTERN.test(batchId)) {
    invalid('batchId must be 1-128 letters, digits, dots, underscores, colons, or hyphens');
  }
}

function validateDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(value) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(`${field} must be an ISO date in YYYY-MM-DD form`);
  }
}

function positiveInteger(value: number, field: string, maximum?: number): number {
  if (!Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    invalid(`${field} must be an integer from 1 to ${maximum ?? 'an implementation bound'}`);
  }
  return value;
}

function invalid(message: string): never {
  throw new TakeMiningControlError('invalid_input', message);
}

function placeholders(params: unknown[], values: readonly unknown[]): string {
  return values.map(value => {
    params.push(value);
    return `$${params.length}`;
  }).join(', ');
}

function emptyCounters(): DiscoveryCounters {
  return {
    inspectedPages: 0,
    alreadyScannedPages: 0,
    existingImmediatePages: 0,
    existingOtherBatchPages: 0,
    existingWriteTriggeredPages: 0,
    alreadyEnrolledPages: 0,
  };
}

function scanKey(slug: string, hash: string): string {
  return `${slug}\0${hash}`;
}

function isoDate(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function publicItem(candidate: EligibleCandidate): TakeMiningEnrollmentItem {
  return {
    slug: candidate.slug,
    type: candidate.type,
    effectiveDate: candidate.effectiveDate,
    effectiveDateSource: candidate.effectiveDateSource,
    miningInputHash: candidate.miningInputHash,
  };
}

function publicPreview(discovery: DiscoveryResult): TakeMiningEnrollmentPreview {
  const { eligibleCandidates: _eligibleCandidates, ...preview } = discovery;
  return preview;
}

function enrollmentActor(ctx: OperationContext): string {
  if (!ctx.remote) return 'cli:take-mining';
  return ctx.auth
    ? `mcp:${ctx.auth.clientId || ctx.auth.clientName || 'authenticated'}`
    : 'mcp:stdio';
}

async function readQueueStatus(
  engine: BrainEngine,
  sourceId: string,
): Promise<TakeMiningQueueStatus> {
  const [row] = await engine.executeRaw<{
    total: number;
    immediate: number;
    deferred: number;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE admission = 'immediate')::int AS immediate,
            COUNT(*) FILTER (WHERE admission = 'deferred')::int AS deferred
       FROM take_mining_work
      WHERE source_id = $1`,
    [sourceId],
  );
  return row ?? { total: 0, immediate: 0, deferred: 0 };
}

async function readBatchStatus(
  engine: BrainEngine,
  sourceId: string,
  batchId: string,
): Promise<TakeMiningBatchStatus | null> {
  const [row] = await engine.executeRaw<{
    queued_pages: number;
    oldest_at: Date | string | null;
    newest_at: Date | string | null;
  }>(
    `SELECT COUNT(*)::int AS queued_pages,
            MIN(created_at) AS oldest_at,
            MAX(updated_at) AS newest_at
       FROM take_mining_work
      WHERE source_id = $1
        AND admission = 'deferred'
        AND batch_id = $2`,
    [sourceId, batchId],
  );
  if (!row || row.queued_pages === 0) return null;
  return {
    batchId,
    queuedPages: row.queued_pages,
    oldestAt: isoDate(row.oldest_at),
    newestAt: isoDate(row.newest_at),
  };
}

async function readDailyStatus(
  engine: BrainEngine,
): Promise<TakeMiningDailyStatus> {
  const timeZone =
    await engine.getConfig('budget.tz') ?? DEFAULT_BUDGET_TIME_ZONE;
  const localDate = currentDateInTimeZone(timeZone);
  const [ledger] = await engine.executeRaw<{
    reserved_usd: string | number;
    committed_usd: string | number;
    cap_usd: string | number | null;
  }>(
    `SELECT reserved_usd, committed_usd, cap_usd
       FROM budget_ledger
      WHERE scope = 'brain'
        AND resolver_id = 'take_mining'
        AND local_date = $1::date`,
    [localDate],
  );
  const [
    pageCalls,
    proposals,
    configuredPageCap,
    configuredProposalCap,
    configuredBudgetCap,
  ] =
    await Promise.all([
      readDailyPageCalls(engine, localDate),
      readDailyProposals(engine, localDate),
      readNumberConfig(
        engine,
        'take_mining.daily_page_cap',
        DEFAULT_DAILY_PAGE_CAP,
      ),
      readNumberConfig(
        engine,
        'take_mining.daily_proposal_cap',
        DEFAULT_DAILY_PROPOSAL_CAP,
      ),
      readNumberConfig(
        engine,
        'take_mining.daily_estimated_spend_usd',
        DEFAULT_DAILY_SPEND_CAP_USD,
      ),
    ]);
  return {
    localDate,
    reservedUsd: Number(ledger?.reserved_usd ?? 0),
    committedUsd: Number(ledger?.committed_usd ?? 0),
    budgetCapUsd: ledger?.cap_usd === null || ledger?.cap_usd === undefined
      ? configuredBudgetCap
      : Number(ledger.cap_usd),
    configuredPageCap,
    configuredProposalCap,
    pageCalls,
    proposals,
  };
}

function currentDateInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function readDailyPageCalls(
  engine: BrainEngine,
  localDate: string,
): Promise<number> {
  const [row] = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM budget_reservations
      WHERE scope = 'brain'
        AND resolver_id = 'take_mining'
        AND local_date = $1::date
        AND status IN ('held', 'committed')`,
    [localDate],
  );
  return row?.count ?? 0;
}

async function readDailyProposals(
  engine: BrainEngine,
  localDate: string,
): Promise<number> {
  const [row] = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM take_proposals
      WHERE proposed_at >= $1::date
        AND proposed_at < ($1::date + interval '1 day')`,
    [localDate],
  );
  return row?.count ?? 0;
}

async function readNumberConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
