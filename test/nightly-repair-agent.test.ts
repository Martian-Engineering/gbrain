import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  makeNightlyRepairAgentHandler,
  nightlyAgentCostCents,
  submitNightlyRepairAgent,
  verifyRepair,
  type NightlyRepairAgentDependencies,
} from '../src/core/minions/handlers/nightly-repair-agent.ts';
import type { MinionJobContext, SubagentResult } from '../src/core/minions/types.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';
import type { SemanticRepairManifest } from '../src/core/minions/semantic-repair-manifest.ts';
import {
  semanticRepairPageHash,
  StaleSemanticRepairManifestError,
} from '../src/core/minions/semantic-repair-manifest.ts';
import type { NightlyRepairDecision } from '../src/core/minions/nightly-repair-decision.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/handlers/subagent.ts';
import type { Page } from '../src/core/types.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';

const beforePage = {
  id: 1,
  source_id: 'wiki',
  slug: 'notes/example',
  type: 'note',
  title: 'Example',
  compiled_truth: 'Old',
  timeline: '',
  frontmatter: {},
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  updated_at: new Date('2026-07-28T00:00:00.000Z'),
} as Page;

const manifest = {
  schema_version: '1',
  manifest_id: 'semantic-repair:wiki:notes/example:finding:page',
  issued_at: '2026-07-28T10:00:00.000Z',
  source_id: 'wiki',
  page_slug: 'notes/example',
  page_hash: 'a'.repeat(64),
  finding_hash: 'b'.repeat(64),
  finding: {
    kind: 'link_reference',
    source_id: 'wiki',
    page_slug: 'notes/example',
    status: 'missing',
    target: 'people/alice',
    evidence: { diagnostic: 'missing' },
  },
  resolver: { path: 'skills/RESOLVER.md', sha256: 'c'.repeat(64) },
  schema: { identity: 'default@1.0.0+12345678', sha256: 'd'.repeat(64) },
  disposition: 'repair',
  allowed_actions: [{ kind: 'replace_reference', source_id: 'wiki', page_slug: 'notes/example' }],
  required_verification: ['source_scope', 'page_hash_changed', 'reference_validation', 'schema_validation'],
  manifest_hash: 'e'.repeat(64),
} as SemanticRepairManifest;

const nightly = {
  run_id: 'nightly-maintenance:2026-07-28',
  budget_client_id: 'nightly-maintenance:2026-07-28',
  scheduled_for: '2026-07-28T10:00:00.000Z',
  source_ids: ['wiki'],
  budget_limit_cents: 1500,
  model: 'openai:gpt-5.6-terra',
  reasoning_effort: 'high',
  max_page_mutations: 10,
} satisfies import('../src/core/minions/nightly-maintenance.ts').NightlyMaintenanceInput;

function decision(
  overrides: Partial<NightlyRepairDecision> = {},
): NightlyRepairDecision {
  return {
    status: 'applied',
    decision: 'replace_reference',
    source_id: manifest.source_id,
    page_slug: manifest.page_slug,
    manifest_hash: manifest.manifest_hash,
    broken_reference: 'people/alice',
    occurrence_context: 'The old reference points to [[people/alice]].',
    candidates: [{
      slug: 'people/alicia',
      title: 'Alicia',
      evidence: ['The canonical page has the same identity attributes.'],
      confidence: 0.98,
    }],
    proposed_replacement: 'people/alicia',
    exact_edit_description: 'Replace only the broken link target.',
    rationale: 'The candidate is the unique canonical identity.',
    confidence: 0.98,
    unresolved_questions: [],
    operations: ['get_page', 'search', 'put_page', 'validate_links'],
    verification: { page_reread: true, links_validated: true },
    ...overrides,
  } as NightlyRepairDecision;
}

function job(): MinionJobContext {
  return {
    id: 73,
    name: 'nightly-repair-agent',
    data: {
      nightly,
      manifest,
      reservation_cents: 1500,
      nightly_phase: 'semantic_repair',
    },
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30 * 60_000,
    shutdownSignal: new AbortController().signal,
    async updateProgress() {},
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

function dependencies(overrides: Partial<NightlyRepairAgentDependencies> = {}) {
  const calls: string[] = [];
  const settled: number[] = [];
  const deps: NightlyRepairAgentDependencies = {
    async settlePendingReservation() { calls.push('reconcile'); return 0; },
    async assertFresh() { calls.push('fresh'); return beforePage; },
    async createSnapshot() {
      calls.push('snapshot');
      return { page: beforePage, markdown: '# Before', version_id: 9 };
    },
    async availableReservationCents(_engine, _input, requestedCents) {
      calls.push('available');
      return requestedCents;
    },
    async reserve() {
      calls.push('reserve');
      return { reservationId: 'reservation-1', estimatedCents: 1500, ttlMs: 1_800_000 };
    },
    async runAgent(_ctx, data) {
      calls.push('agent');
      expect(data).toMatchObject({
        model: 'openai:gpt-5.6-terra',
        reasoning_effort: 'high',
        use_gateway_loop: true,
        max_turns: 12,
        max_tokens: 4096,
        allowed_slug_prefixes: ['notes/example'],
        source_id: 'wiki',
      });
      return {
        result: JSON.stringify(decision()),
        turns_count: 2,
        stop_reason: 'end_turn',
        tokens: { in: 1000, out: 100, cache_read: 0, cache_create: 0 },
      } as SubagentResult;
    },
    async verify() {
      calls.push('verify');
      return {
        ok: true,
        after_hash: 'f'.repeat(64),
        reason: null,
        outcome: decision(),
      };
    },
    async rollback() { calls.push('rollback'); },
    async settle(_engine, _id, cents) { calls.push('settle'); settled.push(cents); },
    async readDurableTokens() { return { input: 0, output: 0, cache_read: 0 }; },
    loadSystemPrompt() { return 'nightly repair system'; },
    ...overrides,
  };
  return { deps, calls, settled };
}

describe('nightly repair agent', () => {
  test('turns a malformed final receipt into failed verification', async () => {
    const result = await verifyRepair(
      {
        async getPage() { return beforePage; },
      } as unknown as BrainEngine,
      manifest,
      { page: beforePage, markdown: '# Before', version_id: 9 },
      {
        result: JSON.stringify({
          status: 'proposal',
          source_id: 'wiki',
          page_slug: 'notes/example',
          manifest_hash: 'wrong',
        }),
        turns_count: 1,
        stop_reason: 'end_turn',
        tokens: { in: 100, out: 10, cache_read: 0, cache_create: 0 },
      } as SubagentResult,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'nightly-repair-agent: decision identity does not match the manifest',
    });
  });

  test('runs Terra high once, verifies, and emits a mutation receipt', async () => {
    const { deps, calls, settled } = dependencies();
    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(calls).toEqual([
      'fresh',
      'snapshot',
      'available',
      'reserve',
      'agent',
      'verify',
      'settle',
    ]);
    expect(settled[0]).toBeGreaterThan(0);
    expect(result).toMatchObject({
      validation_status: 'passed',
      source_id: 'wiki',
      slug: 'notes/example',
      before_hash: manifest.page_hash,
      after_hash: 'f'.repeat(64),
      finding_hash: manifest.finding_hash,
      manifest_hash: manifest.manifest_hash,
      outcome: {
        status: 'applied',
        decision: 'replace_reference',
        proposed_replacement: 'people/alicia',
      },
    });
  });

  test('returns a no-cost stale receipt before snapshot or reservation', async () => {
    const { deps, calls } = dependencies({
      async assertFresh() {
        calls.push('fresh');
        throw new StaleSemanticRepairManifestError();
      },
    });

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(calls).toEqual(['fresh']);
    expect(result).toMatchObject({
      source_id: manifest.source_id,
      slug: manifest.page_slug,
      before_hash: manifest.page_hash,
      after_hash: manifest.page_hash,
      finding_hash: manifest.finding_hash,
      manifest_hash: manifest.manifest_hash,
      validation_status: 'stale',
      verification_reason: 'stale_manifest',
      outcome: null,
      agent: { turns_count: 0, stop_reason: 'error', cost_cents: 0 },
    });
  });

  test('accounts an abandoned reservation before a stale retry exits', async () => {
    let reconciledCents = 0;
    const { deps, calls } = dependencies({
      async readDurableTokens() {
        calls.push('tokens');
        return { input: 400, output: 20, cache_read: 0 };
      },
      async settlePendingReservation(_engine, _clientId, _jobId, actualCents) {
        calls.push('reconcile');
        reconciledCents = actualCents;
        return 1;
      },
      async assertFresh() {
        calls.push('fresh');
        throw new StaleSemanticRepairManifestError();
      },
    });
    const retry = job();
    retry.attempts_made = 1;

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(retry);

    expect(calls).toEqual(['tokens', 'reconcile', 'fresh']);
    expect(reconciledCents).toBeGreaterThan(0);
    expect(result).toMatchObject({
      validation_status: 'stale',
      verification_reason: 'stale_manifest',
    });
  });

  test('does not charge cumulative tokens twice on terminal replay', async () => {
    let reconciledCents = 0;
    const { deps, settled } = dependencies({
      async readDurableTokens() {
        return { input: 1000, output: 100, cache_read: 0 };
      },
      async settlePendingReservation(_engine, _clientId, _jobId, actualCents) {
        reconciledCents = actualCents;
        return 1;
      },
    });
    const retry = job();
    retry.attempts_made = 1;

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(retry);

    expect(reconciledCents).toBeGreaterThan(0);
    expect(settled).toEqual([0]);
    expect(result).toMatchObject({
      validation_status: 'passed',
      agent: { cost_cents: 0 },
    });
  });

  test('charges the persisted token delta for a resumed retry', async () => {
    let reads = 0;
    const prior = { input: 1000, output: 100, cache_read: 0 };
    const current = { input: 500, output: 50, cache_read: 0 };
    const { deps, settled } = dependencies({
      async readDurableTokens() {
        reads++;
        return reads === 1
          ? prior
          : {
              input: prior.input + current.input,
              output: prior.output + current.output,
              cache_read: 0,
            };
      },
      async runAgent() {
        return {
          result: JSON.stringify(decision()),
          turns_count: 3,
          stop_reason: 'end_turn',
          tokens: {
            in: current.input,
            out: current.output,
            cache_read: 0,
            cache_create: 0,
          },
        } as SubagentResult;
      },
    });
    const retry = job();
    retry.attempts_made = 1;

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(retry);

    expect(reads).toBe(2);
    expect(settled).toEqual([nightlyAgentCostCents(nightly.model, current)]);
    expect(result).toMatchObject({
      validation_status: 'passed',
      agent: { cost_cents: nightlyAgentCostCents(nightly.model, current) },
    });
  });

  test('retains source recovery without treating an unchanged page as failure', async () => {
    const unchangedManifest = {
      ...manifest,
      page_hash: semanticRepairPageHash(beforePage),
    };
    const deferred = decision({
      status: 'deferred',
      decision: 'recover_source',
      candidates: [],
      proposed_replacement: null,
      exact_edit_description: 'Do not edit the page; recover the missing source.',
      rationale: 'The cited source is not available in the corpus.',
      confidence: 0.97,
      operations: ['get_page', 'search'],
      verification: { page_reread: true, links_validated: false },
    });

    const result = await verifyRepair(
      {
        async getPage() { return beforePage; },
      } as unknown as BrainEngine,
      unchangedManifest,
      { page: beforePage, markdown: '# Before', version_id: 9 },
      {
        result: JSON.stringify(deferred),
        turns_count: 2,
        stop_reason: 'end_turn',
        tokens: { in: 100, out: 10, cache_read: 0, cache_create: 0 },
      } as SubagentResult,
    );

    expect(result).toMatchObject({
      ok: true,
      after_hash: unchangedManifest.page_hash,
      reason: null,
      outcome: {
        status: 'deferred',
        decision: 'recover_source',
      },
    });
  });

  test('rejects deleting the broken occurrence when replacement already existed', async () => {
    const pageBefore = {
      ...beforePage,
      compiled_truth: 'Old [[people/alice]] and existing [[people/alicia]].',
    };
    const pageAfter = {
      ...pageBefore,
      compiled_truth: 'Existing [[people/alicia]].',
    };
    const countedManifest = {
      ...manifest,
      page_hash: semanticRepairPageHash(pageBefore),
    };
    const canonicalTarget = {
      ...beforePage,
      slug: 'people/alicia',
      title: 'Alicia',
    };
    const result = await verifyRepair(
      {
        async getPage(slug: string) {
          if (slug === pageAfter.slug) return pageAfter;
          if (slug === canonicalTarget.slug) return canonicalTarget;
          return null;
        },
        async resolveSlugWithAlias(slug: string) { return slug; },
        async resolveSlugs() { return []; },
        async getTags() { return []; },
      } as unknown as BrainEngine,
      countedManifest,
      { page: pageBefore, markdown: '# Before', version_id: 9 },
      {
        result: JSON.stringify(decision()),
        turns_count: 2,
        stop_reason: 'end_turn',
        tokens: { in: 100, out: 10, cache_read: 0, cache_create: 0 },
      } as SubagentResult,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'replacement reference count did not increase',
    });
  });

  test('rolls back a mutation that fails deterministic verification', async () => {
    const { deps, calls } = dependencies({
      async verify() {
        calls.push('verify');
        return {
          ok: false,
          after_hash: 'f'.repeat(64),
          reason: 'reference still unresolved',
          outcome: decision(),
        };
      },
    });

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(calls).toContain('rollback');
    expect(result).toMatchObject({ validation_status: 'failed_rolled_back' });
  });

  test('settles and rolls back before surfacing an agent error for retry', async () => {
    const { deps, calls } = dependencies({
      async runAgent() {
        calls.push('agent');
        throw new Error('provider timeout');
      },
      async readDurableTokens() { return { input: 400, output: 20, cache_read: 0 }; },
    });

    await expect(
      makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job()),
    ).rejects.toThrow('provider timeout');
    expect(calls).toContain('rollback');
    expect(calls).toContain('settle');
  });

  test('contains a safely rolled-back agent error on the final attempt', async () => {
    const { deps, calls } = dependencies({
      async runAgent() {
        calls.push('agent');
        throw new SyntaxError('JSON Parse error: Unterminated string');
      },
      async readDurableTokens() { return { input: 400, output: 20, cache_read: 0 }; },
    });
    const finalAttempt = job();
    finalAttempt.attempts_made = 1;

    const result = await makeNightlyRepairAgentHandler(
      {} as BrainEngine,
      deps,
    )(finalAttempt);

    expect(calls).toContain('rollback');
    expect(calls).toContain('settle');
    expect(result).toMatchObject({
      before_hash: manifest.page_hash,
      after_hash: manifest.page_hash,
      validation_status: 'failed_rolled_back',
      outcome: null,
      verification_reason: 'JSON Parse error: Unterminated string',
      agent: { stop_reason: 'error' },
    });
  });

  test('preserves rate-lease backpressure on the final attempt', async () => {
    const { deps } = dependencies({
      async runAgent() {
        throw new RateLeaseUnavailableError('openai:gpt-5.6-terra', 1, 1);
      },
    });
    const finalAttempt = job();
    finalAttempt.attempts_made = 1;

    await expect(
      makeNightlyRepairAgentHandler({} as BrainEngine, deps)(finalAttempt),
    ).rejects.toBeInstanceOf(RateLeaseUnavailableError);
  });

  test('returns a rolled-back receipt when the provider hard cap is reached', async () => {
    const { deps, calls } = dependencies({
      async runAgent() {
        calls.push('agent');
        throw new BudgetExhausted('nightly cap reached', {
          reason: 'cost',
          spent: 0,
          cap: 15,
          modelId: nightly.model,
        });
      },
    });

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(calls).toContain('rollback');
    expect(calls).toContain('settle');
    expect(result).toMatchObject({
      before_hash: manifest.page_hash,
      after_hash: manifest.page_hash,
      validation_status: 'failed_rolled_back',
      verification_reason: 'budget_exhausted',
      agent: { stop_reason: 'error', cost_cents: 0 },
    });
  });

  test('rolls back and records a final-turn overage as budget exhaustion', async () => {
    const { deps, calls, settled } = dependencies({
      async runAgent() {
        calls.push('agent');
        return {
          result: '{}',
          turns_count: 1,
          stop_reason: 'end_turn',
          tokens: {
            in: 10_000_000,
            out: 1_000_000,
            cache_read: 0,
            cache_create: 0,
          },
        } as SubagentResult;
      },
    });
    const tinyReservation = job();
    tinyReservation.data.reservation_cents = 1;

    const result = await makeNightlyRepairAgentHandler(
      {} as BrainEngine,
      deps,
    )(tinyReservation);

    expect(calls).toContain('rollback');
    expect(calls).not.toContain('verify');
    expect(settled[0]).toBeGreaterThan(1);
    expect(result).toMatchObject({
      validation_status: 'failed_rolled_back',
      verification_reason: 'budget_exhausted',
    });
  });

  test('budget refusal happens before the model call', async () => {
    const { deps, calls } = dependencies({
      async reserve() {
        calls.push('reserve');
        throw new Error('budget exceeded');
      },
    });

    await expect(
      makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job()),
    ).rejects.toThrow('budget exceeded');
    expect(calls).not.toContain('agent');
  });

  test('clamps a retry reservation to current whole-cent headroom', async () => {
    let reservedCents = 0;
    const { deps } = dependencies({
      async availableReservationCents() { return 1469; },
      async reserve(_engine, _input, request) {
        reservedCents = request.estimated_cents;
        return {
          reservationId: 'reservation-2',
          estimatedCents: reservedCents,
          ttlMs: 1_800_000,
        };
      },
    });

    await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(reservedCents).toBe(1469);
  });

  test('returns budget exhaustion without a model call when no whole cent remains', async () => {
    const { deps, calls } = dependencies({
      async availableReservationCents() { return 0; },
    });

    const result = await makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job());

    expect(calls).not.toContain('reserve');
    expect(calls).not.toContain('agent');
    expect(result).toMatchObject({
      validation_status: 'failed_rolled_back',
      verification_reason: 'budget_exhausted',
      agent: { cost_cents: 0 },
    });
  });

  test('submission permits exactly one retry', async () => {
    const calls: unknown[][] = [];
    const queue = {
      async add(...args: unknown[]) {
        calls.push(args);
        return { id: 99 };
      },
    } as unknown as MinionQueue;

    await submitNightlyRepairAgent(queue, {
      nightly,
      manifest,
      reservation_cents: 1500,
    });

    expect(calls[0]?.[0]).toBe('nightly-repair-agent');
    expect(calls[0]?.[2]).toMatchObject({ max_attempts: 2 });
    expect(calls[0]?.[3]).toEqual({ allowProtectedSubmit: true });
  });
});
