import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  makeNightlyRepairAgentHandler,
  submitNightlyRepairAgent,
  type NightlyRepairAgentDependencies,
} from '../src/core/minions/handlers/nightly-repair-agent.ts';
import type { MinionJobContext, SubagentResult } from '../src/core/minions/types.ts';
import type { MinionQueue } from '../src/core/minions/queue.ts';
import type { SemanticRepairManifest } from '../src/core/minions/semantic-repair-manifest.ts';
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
        max_turns: 6,
        max_tokens: 4096,
        allowed_slug_prefixes: ['notes/example'],
        source_id: 'wiki',
      });
      return {
        result: JSON.stringify({
          status: 'applied',
          source_id: 'wiki',
          page_slug: 'notes/example',
          manifest_hash: manifest.manifest_hash,
        }),
        turns_count: 2,
        stop_reason: 'end_turn',
        tokens: { in: 1000, out: 100, cache_read: 0, cache_create: 0 },
      } as SubagentResult;
    },
    async verify() {
      calls.push('verify');
      return { ok: true, after_hash: 'f'.repeat(64), reason: null };
    },
    async rollback() { calls.push('rollback'); },
    async settle(_engine, _id, cents) { calls.push('settle'); settled.push(cents); },
    async readJobTokens() { return { input: 0, output: 0, cache_read: 0 }; },
    loadSystemPrompt() { return 'nightly repair system'; },
    ...overrides,
  };
  return { deps, calls, settled };
}

describe('nightly repair agent', () => {
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
      manifest_hash: manifest.manifest_hash,
    });
  });

  test('rolls back a mutation that fails deterministic verification', async () => {
    const { deps, calls } = dependencies({
      async verify() {
        calls.push('verify');
        return { ok: false, after_hash: 'f'.repeat(64), reason: 'reference still unresolved' };
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
      async readJobTokens() { return { input: 400, output: 20, cache_read: 0 }; },
    });

    await expect(
      makeNightlyRepairAgentHandler({} as BrainEngine, deps)(job()),
    ).rejects.toThrow('provider timeout');
    expect(calls).toContain('rollback');
    expect(calls).toContain('settle');
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
