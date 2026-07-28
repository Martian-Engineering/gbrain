import type { BrainEngine } from '../engine.ts';
import { assertValidSourceId } from '../source-id.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { reserve, settle, type Reservation } from './budget-meter.ts';
import type { MinionJob } from './types.ts';
import type { MinionQueue } from './queue.ts';

export const NIGHTLY_MAINTENANCE_MODEL = 'openai:gpt-5.6-terra' as const;
export const NIGHTLY_MAINTENANCE_REASONING = 'high' as const;
export const NIGHTLY_MAINTENANCE_BUDGET_CENTS = 1500;
export const NIGHTLY_MAINTENANCE_MAX_PAGE_MUTATIONS = 10;
export const NIGHTLY_MAINTENANCE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const NIGHTLY_MAINTENANCE_PHASES = [
  'snapshot',
  'dream',
  'deterministic_repair',
  'semantic_repair',
  'verification',
  'contradiction_probe',
  'report',
] as const;

export type NightlyMaintenancePhase = typeof NIGHTLY_MAINTENANCE_PHASES[number];

export interface NightlyMaintenanceInput {
  run_id: string;
  budget_client_id: string;
  scheduled_for: string;
  source_ids: string[];
  budget_limit_cents: number;
  model: typeof NIGHTLY_MAINTENANCE_MODEL;
  reasoning_effort: typeof NIGHTLY_MAINTENANCE_REASONING;
  max_page_mutations: number;
}

export interface NightlyMaintenanceCheckpoint {
  completed_at: string;
  summary: Record<string, unknown>;
}

export interface NightlyMaintenanceProgress {
  schema_version: '1';
  run_id: string;
  status: 'running' | 'budget_exhausted' | 'failed' | 'completed';
  checkpoints: Partial<Record<NightlyMaintenancePhase, NightlyMaintenanceCheckpoint>>;
  /** Receipts persisted after each child so a root retry cannot lose a verified write. */
  semantic_receipts?: NightlyMutationReceipt[];
}

export interface NightlyMutationReceipt {
  source_id: string;
  slug: string;
  before_hash: string;
  after_hash: string;
  manifest_hash: string;
  validation_status: 'passed' | 'failed_rolled_back';
}

export interface NightlyMaintenanceReport {
  schema_version: '1';
  run_id: string;
  status: NightlyMaintenanceProgress['status'];
  model: typeof NIGHTLY_MAINTENANCE_MODEL;
  reasoning_effort: typeof NIGHTLY_MAINTENANCE_REASONING;
  budget: NightlyBudgetSummary;
  checkpoints: NightlyMaintenanceProgress['checkpoints'];
  mutation_receipts: NightlyMutationReceipt[];
}

export interface NightlyBudgetPhaseSummary {
  settled_cents: number;
  pending_reserved_cents: number;
}

export interface NightlyBudgetSummary {
  limit_cents: number;
  settled_cents: number;
  pending_reserved_cents: number;
  remaining_cents: number;
  by_phase: Record<NightlyMaintenancePhase, NightlyBudgetPhaseSummary>;
}

export interface NightlyBudgetReservationInput {
  phase: NightlyMaintenancePhase;
  job_id: number;
  estimated_cents: number;
  ttl_ms?: number;
}

/** Convert fractional ledger headroom into a conservative whole-cent reservation. */
export function wholeCentReservation(remainingCents: number): number {
  return Math.max(0, Math.floor(remainingCents));
}

/**
 * Validate and normalize the operator-facing nightly-maintenance payload.
 * The model, reasoning effort, total budget, and initial mutation ceiling are
 * constrained here so a scheduler or manual invocation cannot silently widen
 * the approved production contract.
 */
export function parseNightlyMaintenanceInput(
  value: Record<string, unknown>,
): NightlyMaintenanceInput {
  const scheduledFor = requireIsoTimestamp(value.scheduled_for, 'scheduled_for');
  const sourceIds = requireSourceIds(value.source_ids);
  const model = value.model ?? NIGHTLY_MAINTENANCE_MODEL;
  const reasoningEffort = value.reasoning_effort ?? NIGHTLY_MAINTENANCE_REASONING;
  const budgetLimitCents = value.budget_limit_cents ?? NIGHTLY_MAINTENANCE_BUDGET_CENTS;
  const maxPageMutations = value.max_page_mutations ?? NIGHTLY_MAINTENANCE_MAX_PAGE_MUTATIONS;

  if (model !== NIGHTLY_MAINTENANCE_MODEL) {
    throw new Error(`model must be ${NIGHTLY_MAINTENANCE_MODEL}`);
  }
  if (reasoningEffort !== NIGHTLY_MAINTENANCE_REASONING) {
    throw new Error(`reasoning_effort must be ${NIGHTLY_MAINTENANCE_REASONING}`);
  }
  assertBoundedInteger(budgetLimitCents, 'budget_limit_cents', 1, NIGHTLY_MAINTENANCE_BUDGET_CENTS);
  assertBoundedInteger(
    maxPageMutations,
    'max_page_mutations',
    1,
    NIGHTLY_MAINTENANCE_MAX_PAGE_MUTATIONS,
  );

  const utcDate = scheduledFor.slice(0, 10);
  const runId = `nightly-maintenance:${utcDate}`;
  return {
    run_id: runId,
    budget_client_id: runId,
    scheduled_for: scheduledFor,
    source_ids: sourceIds,
    budget_limit_cents: budgetLimitCents as number,
    model: NIGHTLY_MAINTENANCE_MODEL,
    reasoning_effort: NIGHTLY_MAINTENANCE_REASONING,
    max_page_mutations: maxPageMutations as number,
  };
}

/**
 * Submit one durable root job for a UTC maintenance date. The idempotency key
 * returns the same job when systemd or an operator repeats submission, while
 * the two-hour timeout bounds both scheduled and controlled one-off runs.
 */
export async function submitNightlyMaintenance(
  queue: MinionQueue,
  input: NightlyMaintenanceInput,
): Promise<MinionJob> {
  return queue.add(
    'nightly-maintenance',
    { ...input, nightly_phase: 'contradiction_probe' },
    {
      idempotency_key: input.run_id,
      max_attempts: 2,
      max_stalled: 5,
      timeout_ms: NIGHTLY_MAINTENANCE_TIMEOUT_MS,
    },
    { allowProtectedSubmit: true },
  );
}

/** Create the durable progress value stored on the root Minion job. */
export function createNightlyProgress(
  input: NightlyMaintenanceInput,
): NightlyMaintenanceProgress {
  return {
    schema_version: '1',
    run_id: input.run_id,
    status: 'running',
    checkpoints: {},
  };
}

/**
 * Record a completed phase without mutating the caller's progress object.
 * Replacing an existing checkpoint is intentional: a manually retried phase
 * may record a newer verified summary under the same run identity.
 */
export function completeNightlyPhase(
  progress: NightlyMaintenanceProgress,
  phase: NightlyMaintenancePhase,
  checkpoint: NightlyMaintenanceCheckpoint,
): NightlyMaintenanceProgress {
  return {
    ...progress,
    checkpoints: {
      ...progress.checkpoints,
      [phase]: {
        completed_at: requireIsoTimestamp(checkpoint.completed_at, 'completed_at'),
        summary: checkpoint.summary,
      },
    },
  };
}

/** Return whether a phase already completed in this durable run. */
export function isNightlyPhaseComplete(
  progress: NightlyMaintenanceProgress,
  phase: NightlyMaintenancePhase,
): boolean {
  return progress.checkpoints[phase] !== undefined;
}

/** Build the stable per-run, per-phase, optional per-source deduplication key. */
export function nightlyPhaseIdempotencyKey(
  runId: string,
  phase: NightlyMaintenancePhase,
  sourceId?: string,
): string {
  if (sourceId !== undefined) assertValidSourceId(sourceId);
  return [runId, phase, sourceId].filter((part) => part !== undefined).join(':');
}

/**
 * Reserve worst-case model cost from the single synthetic client ledger shared
 * by every phase and source-specific child job in this nightly run.
 */
export async function reserveNightlyBudget(
  engine: BrainEngine,
  input: NightlyMaintenanceInput,
  request: NightlyBudgetReservationInput,
): Promise<Reservation> {
  return reserve(engine, {
    clientId: input.budget_client_id,
    estimatedCents: request.estimated_cents,
    capCents: input.budget_limit_cents,
    model: input.model,
    provider: 'openai',
    jobId: request.job_id,
    ttlMs: request.ttl_ms,
  });
}

/** Settle one nightly reservation and attribute its actual cost to a phase. */
export async function settleNightlyBudget(
  engine: BrainEngine,
  reservationId: string,
  phase: NightlyMaintenancePhase,
  actualCents: number,
): Promise<void> {
  await settle(
    engine,
    reservationId,
    actualCents,
    `nightly-maintenance:${phase}`,
    { allowOverage: true },
  );
}

/**
 * Aggregate the root run's settled and outstanding cost from the shared spend
 * ledger. Settled rows carry phase attribution in `operation`; pending rows
 * derive it from the owning Minion job's immutable `nightly_phase` payload.
 */
export async function getNightlyBudgetSummary(
  engine: BrainEngine,
  input: NightlyMaintenanceInput,
): Promise<NightlyBudgetSummary> {
  const byPhase = emptyPhaseBudget();
  const sql = sqlQueryForEngine(engine);
  const settledRows = await sql`
    SELECT operation, COALESCE(SUM(spend_cents), 0)::text AS cents
      FROM mcp_spend_log
     WHERE client_id = ${input.budget_client_id}
     GROUP BY operation
  `;
  for (const row of settledRows) {
    const phase = parsePhaseOperation(String(row.operation ?? ''));
    if (phase) byPhase[phase].settled_cents += Number(row.cents ?? 0);
  }

  const pendingRows = await sql`
    SELECT j.data->>'nightly_phase' AS phase,
           COALESCE(SUM(r.estimated_cents), 0)::text AS cents
      FROM mcp_spend_reservations r
      LEFT JOIN minion_jobs j ON j.id = r.job_id
     WHERE r.client_id = ${input.budget_client_id}
       AND r.status = 'pending'
     GROUP BY j.data->>'nightly_phase'
  `;
  for (const row of pendingRows) {
    const phase = asNightlyPhase(row.phase);
    if (phase) byPhase[phase].pending_reserved_cents += Number(row.cents ?? 0);
  }

  const settledCents = sumPhaseField(byPhase, 'settled_cents');
  const pendingCents = sumPhaseField(byPhase, 'pending_reserved_cents');
  return {
    limit_cents: input.budget_limit_cents,
    settled_cents: settledCents,
    pending_reserved_cents: pendingCents,
    remaining_cents: Math.max(0, input.budget_limit_cents - settledCents - pendingCents),
    by_phase: byPhase,
  };
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function requireSourceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('source_ids must be a non-empty array');
  }
  const sourceIds = [...new Set(value)];
  for (const sourceId of sourceIds) assertValidSourceId(sourceId);
  return sourceIds as string[];
}

function assertBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
}

function emptyPhaseBudget(): Record<NightlyMaintenancePhase, NightlyBudgetPhaseSummary> {
  return Object.fromEntries(
    NIGHTLY_MAINTENANCE_PHASES.map((phase) => [
      phase,
      { settled_cents: 0, pending_reserved_cents: 0 },
    ]),
  ) as Record<NightlyMaintenancePhase, NightlyBudgetPhaseSummary>;
}

function parsePhaseOperation(operation: string): NightlyMaintenancePhase | null {
  return asNightlyPhase(operation.replace(/^nightly-maintenance:/, ''));
}

function asNightlyPhase(value: unknown): NightlyMaintenancePhase | null {
  return typeof value === 'string' &&
    (NIGHTLY_MAINTENANCE_PHASES as readonly string[]).includes(value)
    ? value as NightlyMaintenancePhase
    : null;
}

function sumPhaseField(
  phases: Record<NightlyMaintenancePhase, NightlyBudgetPhaseSummary>,
  field: keyof NightlyBudgetPhaseSummary,
): number {
  return NIGHTLY_MAINTENANCE_PHASES.reduce((sum, phase) => sum + phases[phase][field], 0);
}
