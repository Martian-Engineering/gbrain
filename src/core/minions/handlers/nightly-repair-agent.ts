import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import type { Page } from '../../types.ts';
import { canonicalLookup } from '../../model-pricing.ts';
import { serializePageToMarkdown } from '../../markdown.ts';
import { lintContent } from '../../../commands/lint.ts';
import { validatePageReferences } from '../../link-validation.ts';
import { loadConfigWithEngine } from '../../config.ts';
import { operationsByName, type OperationContext } from '../../operations.ts';
import { makeSubagentHandler } from './subagent.ts';
import type {
  MinionHandler,
  MinionJob,
  MinionJobContext,
  SubagentHandlerData,
  SubagentResult,
} from '../types.ts';
import type { MinionQueue } from '../queue.ts';
import {
  assertFreshSemanticRepairManifest,
  semanticRepairPageHash,
  type SemanticRepairManifest,
} from '../semantic-repair-manifest.ts';
import {
  getNightlyBudgetSummary,
  parseNightlyMaintenanceInput,
  reserveNightlyBudget,
  settleNightlyBudget,
  wholeCentReservation,
  type NightlyMaintenanceInput,
  type NightlyMutationReceipt,
} from '../nightly-maintenance.ts';
import type { Reservation } from '../budget-meter.ts';
import { MinionQueue as Queue } from '../queue.ts';
import { BudgetExhausted, BudgetTracker } from '../../budget/budget-tracker.ts';
import { withBudgetTracker } from '../../ai/gateway.ts';

const AGENT_MAX_TURNS = 6;
const AGENT_MAX_OUTPUT_TOKENS = 4096;
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const SKILL_PATH = join(import.meta.dir, '../../../../skills/nightly-semantic-repair/SKILL.md');

export interface NightlyRepairAgentInput {
  nightly: NightlyMaintenanceInput;
  manifest: SemanticRepairManifest;
  reservation_cents: number;
}

export interface NightlyPageSnapshot {
  page: Page;
  markdown: string;
  version_id: number;
}

export interface NightlyRepairVerification {
  ok: boolean;
  after_hash: string;
  reason: string | null;
}

export interface NightlyRepairAgentResult extends NightlyMutationReceipt {
  disposition: SemanticRepairManifest['disposition'];
  agent: {
    turns_count: number;
    stop_reason: SubagentResult['stop_reason'];
    cost_cents: number;
  };
  verification_reason: string | null;
}

export interface NightlyRepairAgentDependencies {
  assertFresh(engine: BrainEngine, manifest: SemanticRepairManifest): Promise<Page>;
  createSnapshot(
    engine: BrainEngine,
    manifest: SemanticRepairManifest,
    page: Page,
  ): Promise<NightlyPageSnapshot>;
  availableReservationCents(
    engine: BrainEngine,
    input: NightlyMaintenanceInput,
    requestedCents: number,
  ): Promise<number>;
  reserve(
    engine: BrainEngine,
    input: NightlyMaintenanceInput,
    request: { phase: 'semantic_repair'; job_id: number; estimated_cents: number; ttl_ms: number },
  ): Promise<Reservation>;
  runAgent(ctx: MinionJobContext, data: SubagentHandlerData): Promise<SubagentResult>;
  verify(
    engine: BrainEngine,
    manifest: SemanticRepairManifest,
    before: NightlyPageSnapshot,
    result: SubagentResult,
  ): Promise<NightlyRepairVerification>;
  rollback(
    engine: BrainEngine,
    manifest: SemanticRepairManifest,
    snapshot: NightlyPageSnapshot,
  ): Promise<void>;
  settle(
    engine: BrainEngine,
    reservationId: string,
    actualCents: number,
  ): Promise<void>;
  readJobTokens(
    engine: BrainEngine,
    jobId: number,
  ): Promise<{ input: number; output: number; cache_read: number }>;
  loadSystemPrompt(): string;
}

/** Validate a durable child-job payload without widening the nightly contract. */
export function parseNightlyRepairAgentInput(data: Record<string, unknown>): NightlyRepairAgentInput {
  if (!data.nightly || typeof data.nightly !== 'object' || Array.isArray(data.nightly)) {
    throw new Error('nightly-repair-agent: nightly input is required');
  }
  const rawNightly = data.nightly as Record<string, unknown>;
  const nightly = parseNightlyMaintenanceInput(rawNightly);
  if (
    (rawNightly.run_id !== undefined && rawNightly.run_id !== nightly.run_id)
    || (rawNightly.budget_client_id !== undefined
      && rawNightly.budget_client_id !== nightly.budget_client_id)
  ) {
    throw new Error('nightly-repair-agent: nightly run identity mismatch');
  }
  if (!data.manifest || typeof data.manifest !== 'object' || Array.isArray(data.manifest)) {
    throw new Error('nightly-repair-agent: manifest is required');
  }
  const manifest = data.manifest as SemanticRepairManifest;
  if (!nightly.source_ids.includes(manifest.source_id)) {
    throw new Error('nightly-repair-agent: manifest source is outside the nightly source set');
  }
  if (
    !Number.isInteger(data.reservation_cents)
    || (data.reservation_cents as number) < 1
    || (data.reservation_cents as number) > nightly.budget_limit_cents
  ) {
    throw new Error('nightly-repair-agent: reservation_cents is outside the daily cap');
  }
  return {
    nightly,
    manifest,
    reservation_cents: data.reservation_cents as number,
  };
}

/** Submit one durable, exact-manifest repair child with a single retry. */
export async function submitNightlyRepairAgent(
  queue: MinionQueue,
  input: NightlyRepairAgentInput,
): Promise<MinionJob> {
  return queue.add(
    'nightly-repair-agent',
    {
      ...input,
      nightly_phase: 'semantic_repair',
    },
    {
      idempotency_key: `${input.nightly.run_id}:semantic_repair:${input.manifest.manifest_hash}`,
      max_attempts: 2,
      max_stalled: 5,
      timeout_ms: RESERVATION_TTL_MS,
    },
    { allowProtectedSubmit: true },
  );
}

/** Price recorded tokens conservatively using the canonical Terra rate. */
export function nightlyAgentCostCents(
  model: string,
  tokens: { input: number; output: number; cache_read?: number },
): number {
  const pricing = canonicalLookup(model);
  if (!pricing) throw new Error(`nightly-repair-agent: no pricing for ${model}`);
  const inputTokens = tokens.input + (tokens.cache_read ?? 0);
  const rawCents = (
    (inputTokens / 1_000_000) * pricing.input
    + (tokens.output / 1_000_000) * pricing.output
  ) * 100;
  return Math.ceil(rawCents * 100) / 100;
}

/** Parse and bind the model's final JSON receipt to the immutable manifest. */
function parseAgentReceipt(result: SubagentResult, manifest: SemanticRepairManifest): {
  status: 'applied' | 'proposal' | 'failed';
} {
  if (result.stop_reason !== 'end_turn') {
    throw new Error(`nightly-repair-agent: terminal stop reason ${result.stop_reason}`);
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(result.result) as Record<string, unknown>;
  } catch {
    throw new Error('nightly-repair-agent: final response was not one JSON object');
  }
  if (
    !['applied', 'proposal', 'failed'].includes(String(value.status))
    || value.source_id !== manifest.source_id
    || value.page_slug !== manifest.page_slug
    || value.manifest_hash !== manifest.manifest_hash
  ) {
    throw new Error('nightly-repair-agent: final receipt does not match the manifest');
  }
  return { status: value.status as 'applied' | 'proposal' | 'failed' };
}

/** Build the exact tool and prompt contract passed to the generic subagent loop. */
function buildAgentData(
  input: NightlyRepairAgentInput,
  system: string,
): SubagentHandlerData {
  const readTools = [
    'get_page',
    'search',
    'query',
    'resolve_slugs',
    'validate_links',
    'get_active_schema_pack',
  ];
  return {
    prompt: [
      'Apply the following server-issued manifest exactly as instructed.',
      'It is already approved when disposition is "repair".',
      'Return only the required JSON receipt.',
      JSON.stringify(input.manifest),
    ].join('\n\n'),
    system,
    system_no_tool_preamble: false,
    model: input.nightly.model,
    reasoning_effort: input.nightly.reasoning_effort,
    use_gateway_loop: true,
    max_turns: AGENT_MAX_TURNS,
    max_tokens: AGENT_MAX_OUTPUT_TOKENS,
    allowed_tools: input.manifest.disposition === 'repair'
      ? [...readTools, 'put_page']
      : readTools,
    allowed_slug_prefixes: [input.manifest.page_slug],
    source_id: input.manifest.source_id,
    no_self_fix: true,
  };
}

/** Verify the resulting page against the manifest and deterministic validators. */
async function verifyRepair(
  engine: BrainEngine,
  manifest: SemanticRepairManifest,
  before: NightlyPageSnapshot,
  result: SubagentResult,
): Promise<NightlyRepairVerification> {
  const receipt = parseAgentReceipt(result, manifest);
  const after = await engine.getPage(manifest.page_slug, { sourceId: manifest.source_id });
  if (!after) return { ok: false, after_hash: manifest.page_hash, reason: 'page missing after agent' };
  const afterHash = semanticRepairPageHash(after);

  if (manifest.disposition === 'proposal') {
    return {
      ok: receipt.status === 'proposal' && afterHash === manifest.page_hash,
      after_hash: afterHash,
      reason: receipt.status === 'proposal' && afterHash === manifest.page_hash
        ? null
        : 'proposal agent mutated the page or returned the wrong status',
    };
  }
  if (receipt.status !== 'applied') {
    return { ok: false, after_hash: afterHash, reason: `agent returned ${receipt.status}` };
  }
  if (afterHash === manifest.page_hash) {
    return { ok: false, after_hash: afterHash, reason: 'page hash did not change' };
  }

  if (manifest.finding.kind === 'link_reference') {
    const target = manifest.finding.target;
    const findings = await validatePageReferences(
      engine,
      after,
      { sourceId: manifest.source_id },
    );
    const unresolved = findings.some(finding =>
      finding.target === target && finding.status !== 'resolved');
    if (unresolved) {
      return { ok: false, after_hash: afterHash, reason: 'reference still unresolved' };
    }
  }
  const tags = await engine.getTags(after.slug, { sourceId: manifest.source_id });
  const markdown = serializePageToMarkdown(after, tags);
  const schemaIssues = lintContent(markdown, `${after.slug}.md`)
    .filter(issue => issue.rule.startsWith('frontmatter-'));
  if (schemaIssues.length > 0) {
    return { ok: false, after_hash: afterHash, reason: schemaIssues[0]!.message };
  }
  return { ok: true, after_hash: afterHash, reason: null };
}

/** Restore the complete prewrite page through the canonical local write path. */
async function rollbackSnapshot(
  engine: BrainEngine,
  manifest: SemanticRepairManifest,
  snapshot: NightlyPageSnapshot,
): Promise<void> {
  const current = await engine.getPage(manifest.page_slug, { sourceId: manifest.source_id });
  if (current && semanticRepairPageHash(current) === manifest.page_hash) return;
  const config = await loadConfigWithEngine(engine);
  const ctx: OperationContext = {
    engine,
    config: config ?? ({ engine: engine.kind } as OperationContext['config']),
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: manifest.source_id,
    writeContext: {
      actor: 'nightly-maintenance:rollback',
      writeIntent: 'maintenance',
      reason: manifest.manifest_hash,
    },
  };
  await operationsByName.put_page!.handler(ctx, {
    slug: manifest.page_slug,
    content: snapshot.markdown,
  });
  const restored = await engine.getPage(manifest.page_slug, { sourceId: manifest.source_id });
  if (!restored || semanticRepairPageHash(restored) !== manifest.page_hash) {
    throw new Error('nightly-repair-agent: rollback verification failed');
  }
}

const DEFAULT_DEPENDENCIES = (engine: BrainEngine): NightlyRepairAgentDependencies => ({
  assertFresh: assertFreshSemanticRepairManifest,
  async createSnapshot(snapshotEngine, manifest, page) {
    const tags = await snapshotEngine.getTags(page.slug, { sourceId: manifest.source_id });
    const version = await snapshotEngine.createVersion(page.slug, { sourceId: manifest.source_id });
    return {
      page,
      markdown: serializePageToMarkdown(page, tags),
      version_id: version.id,
    };
  },
  async availableReservationCents(budgetEngine, input, requestedCents) {
    const budget = await getNightlyBudgetSummary(budgetEngine, input);
    return Math.min(requestedCents, wholeCentReservation(budget.remaining_cents));
  },
  reserve: reserveNightlyBudget,
  runAgent: makeSubagentHandler({ engine }),
  verify: verifyRepair,
  rollback: rollbackSnapshot,
  async settle(settleEngine, reservationId, actualCents) {
    await settleNightlyBudget(settleEngine, reservationId, 'semantic_repair', actualCents);
  },
  async readJobTokens(tokenEngine, jobId) {
    const persisted = await new Queue(tokenEngine).getJob(jobId);
    return {
      input: persisted?.tokens_input ?? 0,
      output: persisted?.tokens_output ?? 0,
      cache_read: persisted?.tokens_cache_read ?? 0,
    };
  },
  loadSystemPrompt() {
    return readFileSync(SKILL_PATH, 'utf8');
  },
});

/**
 * Build the protected one-manifest repair handler.
 *
 * The shared daily ledger reserves all capacity assigned by the root before
 * the model call. Any exception after the snapshot triggers rollback before
 * the worker may retry. Failed deterministic verification also rolls back but
 * returns an auditable receipt instead of retrying an unsafe semantic choice.
 */
export function makeNightlyRepairAgentHandler(
  engine: BrainEngine,
  dependencies: NightlyRepairAgentDependencies = DEFAULT_DEPENDENCIES(engine),
): MinionHandler {
  return async job => {
    const input = parseNightlyRepairAgentInput(job.data);
    const beforePage = await dependencies.assertFresh(engine, input.manifest);
    const snapshot = await dependencies.createSnapshot(engine, input.manifest, beforePage);
    const reservationCents = await dependencies.availableReservationCents(
      engine,
      input.nightly,
      input.reservation_cents,
    );
    if (reservationCents < 1) {
      return {
        source_id: input.manifest.source_id,
        slug: input.manifest.page_slug,
        before_hash: input.manifest.page_hash,
        after_hash: input.manifest.page_hash,
        manifest_hash: input.manifest.manifest_hash,
        disposition: input.manifest.disposition,
        validation_status: 'failed_rolled_back',
        agent: { turns_count: 0, stop_reason: 'error', cost_cents: 0 },
        verification_reason: 'budget_exhausted',
      } satisfies NightlyRepairAgentResult;
    }
    const reservation = await dependencies.reserve(engine, input.nightly, {
      phase: 'semantic_repair',
      job_id: job.id,
      estimated_cents: reservationCents,
      ttl_ms: RESERVATION_TTL_MS,
    });
    let agentResult: SubagentResult | null = null;
    let actualCents = 0;
    let tracker: BudgetTracker | null = null;

    try {
      const agentData = buildAgentData(input, dependencies.loadSystemPrompt());
      tracker = new BudgetTracker({
        label: 'nightly-maintenance:semantic_repair',
        maxCostUsd: reservationCents / 100,
        maxRuntimeMs: RESERVATION_TTL_MS,
      });
      agentResult = await withBudgetTracker(tracker, () =>
        dependencies.runAgent(
          { ...job, data: agentData as unknown as Record<string, unknown> },
          agentData,
        ));
      const budget = tracker.snapshot();
      if (
        budget.maxCostUsd !== undefined
        && budget.cumulativeCostUsd > budget.maxCostUsd
      ) {
        throw new BudgetExhausted(
          'nightly-maintenance:semantic_repair exceeded its reservation on the final turn',
          {
            reason: 'cost',
            spent: budget.cumulativeCostUsd,
            cap: budget.maxCostUsd,
            modelId: input.nightly.model,
          },
        );
      }
      actualCents = nightlyAgentCostCents(input.nightly.model, {
        input: agentResult.tokens.in,
        output: agentResult.tokens.out,
        cache_read: agentResult.tokens.cache_read,
      });
      if (actualCents > reservationCents) {
        throw new BudgetExhausted(
          'nightly-maintenance:semantic_repair actual cost exceeded its reservation',
          {
            reason: 'cost',
            spent: actualCents / 100,
            cap: reservationCents / 100,
            modelId: input.nightly.model,
          },
        );
      }
      const verification = await dependencies.verify(
        engine,
        input.manifest,
        snapshot,
        agentResult,
      );
      if (!verification.ok) {
        await dependencies.rollback(engine, input.manifest, snapshot);
      }
      await dependencies.settle(engine, reservation.reservationId, actualCents);
      return {
        source_id: input.manifest.source_id,
        slug: input.manifest.page_slug,
        before_hash: input.manifest.page_hash,
        after_hash: verification.after_hash,
        manifest_hash: input.manifest.manifest_hash,
        disposition: input.manifest.disposition,
        validation_status: verification.ok ? 'passed' : 'failed_rolled_back',
        agent: {
          turns_count: agentResult.turns_count,
          stop_reason: agentResult.stop_reason,
          cost_cents: actualCents,
        },
        verification_reason: verification.reason,
      } satisfies NightlyRepairAgentResult;
    } catch (error) {
      const tokens = agentResult
        ? {
            input: agentResult.tokens.in,
            output: agentResult.tokens.out,
            cache_read: agentResult.tokens.cache_read,
          }
        : await dependencies.readJobTokens(engine, job.id);
      actualCents = nightlyAgentCostCents(input.nightly.model, tokens);
      if (error instanceof BudgetExhausted && error.reason === 'cost') {
        actualCents = Math.max(actualCents, Math.ceil(error.spent * 100 * 100) / 100);
      }
      await dependencies.rollback(engine, input.manifest, snapshot);
      await dependencies.settle(engine, reservation.reservationId, actualCents);
      if (error instanceof BudgetExhausted) {
        return {
          source_id: input.manifest.source_id,
          slug: input.manifest.page_slug,
          before_hash: input.manifest.page_hash,
          after_hash: input.manifest.page_hash,
          manifest_hash: input.manifest.manifest_hash,
          disposition: input.manifest.disposition,
          validation_status: 'failed_rolled_back',
          agent: {
            turns_count: agentResult?.turns_count ?? 0,
            stop_reason: 'error',
            cost_cents: actualCents,
          },
          verification_reason: 'budget_exhausted',
        } satisfies NightlyRepairAgentResult;
      }
      throw error;
    }
  };
}
