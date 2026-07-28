import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import type { OperationContext } from '../../operations.ts';
import { operationsByName } from '../../operations.ts';
import { loadConfigWithEngine } from '../../config.ts';
import { auditGraphBacklinks, type BacklinksResult } from '../../../commands/backlinks.ts';
import { runCycle, type CycleReport } from '../../cycle.ts';
import {
  buildSemanticRepairManifests,
  semanticFindingsFromBacklinks,
  type SemanticRepairManifest,
  type SemanticRepairReference,
} from '../semantic-repair-manifest.ts';
import {
  completeNightlyPhase,
  createNightlyProgress,
  getNightlyBudgetSummary,
  isNightlyPhaseComplete,
  parseNightlyMaintenanceInput,
  reserveNightlyBudget,
  settleNightlyBudget,
  wholeCentReservation,
  type NightlyMaintenanceInput,
  type NightlyMaintenanceProgress,
  type NightlyMaintenanceReport,
  type NightlyMutationReceipt,
} from '../nightly-maintenance.ts';
import { makeLinkRepairHandler, type LinkRepairResult } from './link-repair.ts';
import {
  submitNightlyRepairAgent,
  type NightlyRepairAgentResult,
} from './nightly-repair-agent.ts';
import { MinionQueue } from '../queue.ts';
import { waitForCompletion } from '../wait-for-completion.ts';
import type { MinionHandler, MinionJob, MinionJobContext } from '../types.ts';
import { runContradictionProbe, type RunnerResult } from '../../eval-contradictions/runner.ts';
import { writeRunRow } from '../../eval-contradictions/trends.ts';
import { BudgetExceededError } from '../budget-meter.ts';
import { BudgetExhausted } from '../../budget/budget-tracker.ts';
import { canonicalJson } from '../../remediation-step.ts';

const RESOLVER_PATH = join(import.meta.dir, '../../../../skills/RESOLVER.md');
const MIN_REPAIR_RESERVATION_CENTS = 50;
const MAX_SEMANTIC_MANIFESTS = 100;
const PROBE_MAX_QUERIES = 20;
const PROBE_TOP_K = 3;
const CHILD_WAIT_MS = 35 * 60 * 1000;

interface SourceSnapshot {
  source_id: string;
  last_commit: string | null;
  last_sync_at: string | null;
  local_path: string | null;
  audit: BacklinksResult;
}

interface SemanticPhaseResult {
  manifests: SemanticRepairManifest[];
  receipts: NightlyRepairAgentResult[];
  stopped_reason: 'budget_exhausted' | 'mutation_limit' | null;
}

/** Count every unresolved reference class exposed by the deterministic audit. */
function unresolvedReferenceCount(audit: BacklinksResult): number {
  const report = audit.reference_validation;
  return report ? report.missing + report.ambiguous + report.blocked : 0;
}

export interface NightlyMaintenanceDependencies {
  loadProgress(jobId: number, input: NightlyMaintenanceInput): Promise<NightlyMaintenanceProgress>;
  snapshotSource(engine: BrainEngine, sourceId: string): Promise<SourceSnapshot>;
  auditSource(engine: BrainEngine, sourceId: string): Promise<BacklinksResult>;
  runDreamMaintenance(
    engine: BrainEngine,
    source: SourceSnapshot,
    job: MinionJobContext,
  ): Promise<CycleReport>;
  runGlobalMaintenance(engine: BrainEngine, job: MinionJobContext): Promise<CycleReport>;
  runDeterministicRepair(
    engine: BrainEngine,
    input: NightlyMaintenanceInput,
    sourceId: string,
    job: MinionJobContext,
  ): Promise<LinkRepairResult>;
  buildManifests(
    engine: BrainEngine,
    input: NightlyMaintenanceInput,
    audits: Map<string, BacklinksResult>,
  ): Promise<SemanticRepairManifest[]>;
  runRepairChild(
    input: NightlyMaintenanceInput,
    manifest: SemanticRepairManifest,
    reservationCents: number,
    signal: AbortSignal,
  ): Promise<NightlyRepairAgentResult>;
  loadProbeQueries(
    engine: BrainEngine,
    audits: ReadonlyMap<string, BacklinksResult>,
  ): Promise<string[]>;
  runProbe(
    engine: BrainEngine,
    input: NightlyMaintenanceInput,
    queries: string[],
    budgetCents: number,
    job: MinionJobContext,
  ): Promise<RunnerResult>;
  now(): string;
}

/** Return a full SHA-256 reference for the source's active schema identity. */
async function activeSchemaReference(
  engine: BrainEngine,
  sourceId: string,
): Promise<SemanticRepairReference> {
  const config = await loadConfigWithEngine(engine);
  const ctx: OperationContext = {
    engine,
    config: config ?? ({ engine: engine.kind } as OperationContext['config']),
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
  const packet = await operationsByName.get_active_schema_pack!.handler(ctx, {});
  const value = packet as Record<string, unknown>;
  const identity = String(value.identity ?? `${value.pack_name}@${value.version}+${value.sha8}`);
  return {
    identity,
    sha256: createHash('sha256').update(canonicalJson(value)).digest('hex'),
  };
}

/** Build source-specific immutable manifests from the deterministic audit. */
async function buildRunManifests(
  engine: BrainEngine,
  input: NightlyMaintenanceInput,
  audits: Map<string, BacklinksResult>,
): Promise<SemanticRepairManifest[]> {
  const resolver: SemanticRepairReference = {
    path: 'skills/RESOLVER.md',
    sha256: createHash('sha256').update(readFileSync(RESOLVER_PATH)).digest('hex'),
  };
  const manifests: SemanticRepairManifest[] = [];
  for (const sourceId of input.source_ids) {
    const audit = audits.get(sourceId);
    if (!audit) continue;
    const findings = semanticFindingsFromBacklinks(audit);
    if (findings.length === 0) continue;
    const sourceManifests = await buildSemanticRepairManifests(
      engine,
      findings,
      {
        issued_at: input.scheduled_for,
        resolver,
        schema: await activeSchemaReference(engine, sourceId),
      },
      { limit: 100 },
    );
    manifests.push(...sourceManifests);
  }
  return manifests.sort((a, b) => {
    if (a.disposition !== b.disposition) return a.disposition === 'repair' ? -1 : 1;
    return a.manifest_id.localeCompare(b.manifest_id);
  }).slice(0, MAX_SEMANTIC_MANIFESTS);
}

/** Extract a bounded, stable contradiction query set from unresolved targets. */
export function nightlyContradictionQueries(
  audits: Iterable<BacklinksResult>,
): string[] {
  const queries = new Set<string>();
  for (const audit of audits) {
    for (const finding of audit.reference_validation?.findings ?? []) {
      if (finding.status === 'resolved' || !finding.target.trim()) continue;
      queries.add(finding.target.trim());
    }
  }
  return [...queries].sort().slice(0, PROBE_MAX_QUERIES);
}

/** Convert a terminal child job into the strict nightly receipt shape. */
function childResult(job: MinionJob): NightlyRepairAgentResult {
  if (job.status !== 'completed' || !job.result || typeof job.result !== 'object') {
    throw new Error(
      `nightly-maintenance: repair child ${job.id} ended ${job.status}: ${job.error_text ?? 'no result'}`,
    );
  }
  return job.result as unknown as NightlyRepairAgentResult;
}

const DEFAULT_DEPENDENCIES = (
  engine: BrainEngine,
  queue: MinionQueue,
): NightlyMaintenanceDependencies => ({
  async loadProgress(jobId, input) {
    const persisted = await queue.getJob(jobId);
    const value = persisted?.progress;
    if (
      value
      && typeof value === 'object'
      && (value as NightlyMaintenanceProgress).schema_version === '1'
      && (value as NightlyMaintenanceProgress).run_id === input.run_id
    ) {
      return value as NightlyMaintenanceProgress;
    }
    return createNightlyProgress(input);
  },
  async snapshotSource(snapshotEngine, sourceId) {
    const rows = await snapshotEngine.executeRaw<{
      last_commit: string | null;
      last_sync_at: Date | string | null;
      local_path: string | null;
    }>(
      `SELECT last_commit, last_sync_at, local_path
         FROM sources
        WHERE id = $1 AND COALESCE(archived, false) = false`,
      [sourceId],
    );
    if (!rows[0]) throw new Error(`nightly-maintenance: active source ${sourceId} not found`);
    return {
      source_id: sourceId,
      last_commit: rows[0].last_commit,
      last_sync_at: rows[0].last_sync_at
        ? new Date(rows[0].last_sync_at).toISOString()
        : null,
      local_path: rows[0].local_path,
      audit: await auditGraphBacklinks(snapshotEngine, { sourceId }),
    };
  },
  async auditSource(auditEngine, sourceId) {
    return auditGraphBacklinks(auditEngine, { sourceId });
  },
  async runDreamMaintenance(cycleEngine, source, job) {
    return runCycle(cycleEngine, {
      brainDir: source.local_path,
      sourceId: source.source_id,
      pull: false,
      phases: ['recompute_emotional_weight'],
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs,
      yieldBetweenPhases: async () => { await new Promise<void>(resolve => setImmediate(resolve)); },
    });
  },
  async runGlobalMaintenance(cycleEngine, job) {
    return runCycle(cycleEngine, {
      brainDir: null,
      pull: false,
      phases: ['resolve_symbol_edges', 'orphans', 'purge'],
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs,
      yieldBetweenPhases: async () => { await new Promise<void>(resolve => setImmediate(resolve)); },
    });
  },
  async runDeterministicRepair(repairEngine, input, sourceId, job) {
    return await makeLinkRepairHandler(repairEngine)({
      ...job,
      async updateProgress() {},
      data: {
        source_id: sourceId,
        run_id: input.run_id,
        dry_run: false,
      },
    }) as LinkRepairResult;
  },
  buildManifests: buildRunManifests,
  async runRepairChild(input, manifest, reservationCents, signal) {
    const submitted = await submitNightlyRepairAgent(queue, {
      nightly: input,
      manifest,
      reservation_cents: reservationCents,
    });
    const terminal = await waitForCompletion(queue, submitted.id, {
      timeoutMs: CHILD_WAIT_MS,
      pollMs: engine.kind === 'pglite' ? 250 : 1000,
      signal,
    });
    return childResult(terminal);
  },
  async loadProbeQueries(queryEngine, audits) {
    const targets = nightlyContradictionQueries(audits.values());
    const config = await loadConfigWithEngine(queryEngine);
    const titles: string[] = [];
    for (const sourceId of audits.keys()) {
      const ctx: OperationContext = {
        engine: queryEngine,
        config: config ?? ({ engine: queryEngine.kind } as OperationContext['config']),
        logger: { info() {}, warn() {}, error() {} },
        dryRun: false,
        remote: false,
        sourceId,
      };
      const recent = await operationsByName.get_recent_salience!.handler(ctx, {
        days: 14,
        limit: PROBE_MAX_QUERIES,
        recency_bias: 'on',
      });
      if (Array.isArray(recent)) {
        titles.push(...recent
          .map(row => typeof row === 'object' && row
            ? String((row as Record<string, unknown>).title ?? '').trim()
            : '')
          .filter(Boolean));
      }
    }
    return [...new Set([...targets, ...titles])].slice(0, PROBE_MAX_QUERIES);
  },
  async runProbe(probeEngine, input, queries, budgetCents, job) {
    const result = await runContradictionProbe({
      engine: probeEngine,
      queries,
      judgeModel: input.model,
      reasoningEffort: input.reasoning_effort,
      topK: PROBE_TOP_K,
      budgetUsd: budgetCents / 100,
      hardBudget: true,
      yesOverride: true,
      abortSignal: job.signal,
    });
    await writeRunRow(probeEngine, result.report, result.report.duration_ms);
    return result;
  },
  now: () => new Date().toISOString(),
});

/** Persist one completed phase into the root job's durable progress field. */
async function checkpoint(
  job: MinionJobContext,
  progress: NightlyMaintenanceProgress,
  phase: Parameters<typeof completeNightlyPhase>[1],
  summary: Record<string, unknown>,
  now: string,
): Promise<NightlyMaintenanceProgress> {
  const next = completeNightlyPhase(progress, phase, { completed_at: now, summary });
  await job.updateProgress(next as unknown as Record<string, unknown>);
  return next;
}

/**
 * Build the protected nightly root handler.
 *
 * The handler is checkpointed and idempotent. Source scans and deterministic
 * repairs run first. Exact-page semantic children are then submitted and
 * awaited serially, so only one writing agent can run at once. The remaining
 * shared budget is reserved before the inline contradiction probe.
 */
export function makeNightlyMaintenanceHandler(
  engine: BrainEngine,
  dependencies?: NightlyMaintenanceDependencies,
): MinionHandler {
  const queue = new MinionQueue(engine);
  const deps = dependencies ?? DEFAULT_DEPENDENCIES(engine, queue);
  return async job => {
    const input = parseNightlyMaintenanceInput(job.data);
    let progress = await deps.loadProgress(job.id, input);
    const snapshots = new Map<string, SourceSnapshot>();
    const audits = new Map<string, BacklinksResult>();
    const persistedReceipts = progress.semantic_receipts
      ?? progress.checkpoints.semantic_repair?.summary.receipts;
    const receipts: NightlyRepairAgentResult[] = Array.isArray(persistedReceipts)
      ? persistedReceipts as NightlyRepairAgentResult[]
      : [];

    if (!isNightlyPhaseComplete(progress, 'snapshot')) {
      for (const sourceId of input.source_ids) {
        const snapshot = await deps.snapshotSource(engine, sourceId);
        snapshots.set(sourceId, snapshot);
        audits.set(sourceId, snapshot.audit);
      }
      progress = await checkpoint(job, progress, 'snapshot', {
        sources: [...snapshots.values()].map(source => ({
          source_id: source.source_id,
          last_commit: source.last_commit,
          last_sync_at: source.last_sync_at,
          local_path: source.local_path,
          unresolved_references: unresolvedReferenceCount(source.audit),
          graph_findings: source.audit.graph_findings?.length ?? 0,
        })),
      }, deps.now());
    } else {
      for (const sourceId of input.source_ids) {
        const snapshot = await deps.snapshotSource(engine, sourceId);
        snapshots.set(sourceId, snapshot);
        audits.set(sourceId, snapshot.audit);
      }
    }

    if (!isNightlyPhaseComplete(progress, 'dream')) {
      const reports = [];
      for (const sourceId of input.source_ids) {
        const source = snapshots.get(sourceId)!;
        const report = await deps.runDreamMaintenance(engine, source, job);
        reports.push({ source_id: sourceId, status: report.status, totals: report.totals });
      }
      const global = await deps.runGlobalMaintenance(engine, job);
      progress = await checkpoint(job, progress, 'dream', {
        reports,
        global: { status: global.status, totals: global.totals },
      }, deps.now());
    }

    if (!isNightlyPhaseComplete(progress, 'deterministic_repair')) {
      const results = [];
      for (const sourceId of input.source_ids) {
        const result = await deps.runDeterministicRepair(engine, input, sourceId, job);
        results.push(result);
        const audit = result.stages.backlinks as BacklinksResult | undefined;
        audits.set(
          sourceId,
          audit ?? await deps.auditSource(engine, sourceId),
        );
      }
      progress = await checkpoint(job, progress, 'deterministic_repair', {
        sources: results.map(result => ({
          source_id: result.source_id,
          resumed: result.resumed,
          completed_stages: result.completed_stages,
          stages: result.stages,
        })),
      }, deps.now());
    } else {
      for (const sourceId of input.source_ids) {
        audits.set(sourceId, await deps.auditSource(engine, sourceId));
      }
    }

    let semantic: SemanticPhaseResult = {
      manifests: [],
      receipts,
      stopped_reason:
        progress.checkpoints.semantic_repair?.summary.stopped_reason === 'budget_exhausted'
        || progress.checkpoints.semantic_repair?.summary.stopped_reason === 'mutation_limit'
          ? progress.checkpoints.semantic_repair.summary.stopped_reason
          : null,
    };
    if (!isNightlyPhaseComplete(progress, 'semantic_repair')) {
      semantic.manifests = await deps.buildManifests(engine, input, audits);
      const completedManifestHashes = new Set(receipts.map(receipt => receipt.manifest_hash));
      let appliedMutations = receipts.filter(receipt =>
        receipt.disposition === 'repair'
        && receipt.validation_status === 'passed'
        && receipt.before_hash !== receipt.after_hash
      ).length;
      for (const manifest of semantic.manifests) {
        if (completedManifestHashes.has(manifest.manifest_hash)) continue;
        if (appliedMutations >= input.max_page_mutations) {
          semantic.stopped_reason = 'mutation_limit';
          break;
        }
        const budget = await getNightlyBudgetSummary(engine, input);
        const reservationCents = wholeCentReservation(budget.remaining_cents);
        if (reservationCents < MIN_REPAIR_RESERVATION_CENTS) {
          semantic.stopped_reason = 'budget_exhausted';
          break;
        }
        try {
          const receipt = await deps.runRepairChild(
            input,
            manifest,
            reservationCents,
            job.signal,
          );
          receipts.push(receipt);
          progress = { ...progress, semantic_receipts: receipts };
          await job.updateProgress(progress as unknown as Record<string, unknown>);
          if (receipt.verification_reason === 'budget_exhausted') {
            semantic.stopped_reason = 'budget_exhausted';
            break;
          }
          if (
            receipt.disposition === 'repair'
            && receipt.validation_status === 'passed'
            && receipt.before_hash !== receipt.after_hash
          ) {
            appliedMutations++;
          }
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            semantic.stopped_reason = 'budget_exhausted';
            break;
          }
          throw error;
        }
      }
      progress = await checkpoint(job, progress, 'semantic_repair', {
        manifest_count: semantic.manifests.length,
        receipts,
        stopped_reason: semantic.stopped_reason,
      }, deps.now());
    }

    const verifiedAudits = new Map<string, BacklinksResult>();
    if (!isNightlyPhaseComplete(progress, 'verification')) {
      for (const sourceId of input.source_ids) {
        verifiedAudits.set(sourceId, await deps.auditSource(engine, sourceId));
      }
      progress = await checkpoint(job, progress, 'verification', {
        sources: [...verifiedAudits].map(([sourceId, audit]) => ({
          source_id: sourceId,
          unresolved_references: unresolvedReferenceCount(audit),
          graph_findings: audit.graph_findings?.length ?? 0,
        })),
      }, deps.now());
    } else {
      for (const sourceId of input.source_ids) {
        verifiedAudits.set(sourceId, await deps.auditSource(engine, sourceId));
      }
    }

    if (!isNightlyPhaseComplete(progress, 'contradiction_probe')) {
      const queries = await deps.loadProbeQueries(engine, verifiedAudits);
      const budget = await getNightlyBudgetSummary(engine, input);
      const reservationCents = wholeCentReservation(budget.remaining_cents);
      let summary: Record<string, unknown> = {
        queries,
        skipped: queries.length === 0 ? 'no_unresolved_targets' : null,
      };
      if (queries.length > 0 && reservationCents > 0) {
        let reservation: Awaited<ReturnType<typeof reserveNightlyBudget>> | null = null;
        try {
          reservation = await reserveNightlyBudget(engine, input, {
            phase: 'contradiction_probe',
            job_id: job.id,
            estimated_cents: reservationCents,
            ttl_ms: 30 * 60 * 1000,
          });
          const result = await deps.runProbe(
            engine,
            input,
            queries,
            reservationCents,
            job,
          );
          const actualCents = Math.ceil(result.report.cost_usd.total * 100 * 100) / 100;
          await settleNightlyBudget(
            engine,
            reservation.reservationId,
            'contradiction_probe',
            actualCents,
          );
          summary = { ...summary, report: result.report, cap_hit_mid_run: result.capHitMidRun };
        } catch (error) {
          if (error instanceof BudgetExhausted) {
            const actualCents = Math.ceil(error.spent * 100 * 100) / 100;
            if (reservation) {
              await settleNightlyBudget(
                engine,
                reservation.reservationId,
                'contradiction_probe',
                actualCents,
              );
            }
            summary = {
              ...summary,
              stopped_reason: 'budget_exhausted',
              spent_cents: actualCents,
            };
          } else if (error instanceof BudgetExceededError) {
            summary = { ...summary, stopped_reason: 'budget_exhausted' };
          } else {
            if (reservation) {
              await settleNightlyBudget(
                engine,
                reservation.reservationId,
                'contradiction_probe',
                0,
              );
            }
            throw error;
          }
        }
      } else if (queries.length > 0) {
        summary = { ...summary, stopped_reason: 'budget_exhausted' };
      }
      progress = await checkpoint(job, progress, 'contradiction_probe', summary, deps.now());
    }

    const budget = await getNightlyBudgetSummary(engine, input);
    const probeBudgetExhausted =
      progress.checkpoints.contradiction_probe?.summary.stopped_reason === 'budget_exhausted';
    const status = semantic.stopped_reason === 'budget_exhausted' || probeBudgetExhausted
      ? 'budget_exhausted'
      : 'completed';
    progress = { ...progress, status };
    progress = await checkpoint(job, progress, 'report', {
      status,
      budget,
      receipt_count: receipts.length,
    }, deps.now());
    progress = { ...progress, status };
    await job.updateProgress(progress as unknown as Record<string, unknown>);
    return {
      schema_version: '1',
      run_id: input.run_id,
      status,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
      budget,
      checkpoints: progress.checkpoints,
      mutation_receipts: receipts as NightlyMutationReceipt[],
    } satisfies NightlyMaintenanceReport;
  };
}
