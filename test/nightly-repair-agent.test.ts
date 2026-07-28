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
    async reserve() {
      calls.push('reserve');
      return { reservationId: 'reservation-1', estimatedCents: 1500, ttlMs: 1_800_000 };
    },
    async runAgent(_ctx, data) {
      calls.push('agent');
      expect(data).toMatchObject({
        model: 'openai:gpt-5.6-terra',
        reasoning_effort: 'high',
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

    expect(calls).toEqual(['fresh', 'snapshot', 'reserve', 'agent', 'verify', 'settle']);
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
