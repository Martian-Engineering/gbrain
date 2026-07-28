import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  completeNightlyPhase,
  createNightlyProgress,
  getNightlyBudgetSummary,
  isNightlyPhaseComplete,
  nightlyPhaseIdempotencyKey,
  parseNightlyMaintenanceInput,
  reserveNightlyBudget,
  settleNightlyBudget,
  submitNightlyMaintenance,
} from '../src/core/minions/nightly-maintenance.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '132');
});

describe('nightly maintenance contract', () => {
  test('pins Terra high, the UTC run date, and the hard daily defaults', () => {
    const input = parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian', 'josh-private'],
    });

    expect(input.run_id).toBe('nightly-maintenance:2026-07-28');
    expect(input.budget_client_id).toBe(input.run_id);
    expect(input.budget_limit_cents).toBe(1500);
    expect(input.model).toBe('openai:gpt-5.6-terra');
    expect(input.reasoning_effort).toBe('high');
    expect(input.max_page_mutations).toBe(10);
  });

  test('rejects a model or reasoning override that violates the automation contract', () => {
    expect(() => parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
      model: 'openai:gpt-5.6',
    })).toThrow('model must be openai:gpt-5.6-terra');
    expect(() => parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
      reasoning_effort: 'medium',
    })).toThrow('reasoning_effort must be high');
  });

  test('deduplicates one root job per UTC run date', async () => {
    const input = parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
    });

    const first = await submitNightlyMaintenance(queue, input);
    const second = await submitNightlyMaintenance(queue, input);

    expect(second.id).toBe(first.id);
    expect(first.name).toBe('nightly-maintenance');
    expect(first.data.run_id).toBe(input.run_id);
    expect(first.data.nightly_phase).toBe('contradiction_probe');
    expect(first.timeout_ms).toBe(2 * 60 * 60 * 1000);
  });

  test('checkpoints completed phases so a resumed run skips duplicate work', () => {
    const input = parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
    });
    const initial = createNightlyProgress(input);
    const completed = completeNightlyPhase(initial, 'snapshot', {
      completed_at: '2026-07-28T10:01:00.000Z',
      summary: { pages: 120 },
    });

    expect(isNightlyPhaseComplete(initial, 'snapshot')).toBe(false);
    expect(isNightlyPhaseComplete(completed, 'snapshot')).toBe(true);
    expect(completed.checkpoints.snapshot?.summary).toEqual({ pages: 120 });
    expect(nightlyPhaseIdempotencyKey(input.run_id, 'snapshot')).toBe(
      'nightly-maintenance:2026-07-28:snapshot',
    );
    expect(nightlyPhaseIdempotencyKey(input.run_id, 'semantic_repair', 'martian')).toBe(
      'nightly-maintenance:2026-07-28:semantic_repair:martian',
    );
  });

  test('shares one cap across phases and reports settled and pending cost', async () => {
    const input = parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
    });
    const dreamJob = await queue.add('test-dream', {
      nightly_phase: 'dream',
    });
    const repairJob = await queue.add('test-repair', {
      nightly_phase: 'semantic_repair',
    });

    const dream = await reserveNightlyBudget(engine, input, {
      phase: 'dream',
      job_id: dreamJob.id,
      estimated_cents: 500,
    });
    await settleNightlyBudget(engine, dream.reservationId, 'dream', 325);
    await reserveNightlyBudget(engine, input, {
      phase: 'semantic_repair',
      job_id: repairJob.id,
      estimated_cents: 700,
    });

    const summary = await getNightlyBudgetSummary(engine, input);
    expect(summary.limit_cents).toBe(1500);
    expect(summary.settled_cents).toBe(325);
    expect(summary.pending_reserved_cents).toBe(700);
    expect(summary.remaining_cents).toBe(475);
    expect(summary.by_phase.dream).toEqual({
      settled_cents: 325,
      pending_reserved_cents: 0,
    });
    expect(summary.by_phase.semantic_repair).toEqual({
      settled_cents: 0,
      pending_reserved_cents: 700,
    });
  });

  test('records an unavoidable provider overage for nightly accounting', async () => {
    const input = parseNightlyMaintenanceInput({
      scheduled_for: '2026-07-28T10:00:00.000Z',
      source_ids: ['martian'],
    });
    const repairJob = await queue.add('test-repair-overage', {
      nightly_phase: 'semantic_repair',
    });
    const reservation = await reserveNightlyBudget(engine, input, {
      phase: 'semantic_repair',
      job_id: repairJob.id,
      estimated_cents: 100,
    });

    await settleNightlyBudget(engine, reservation.reservationId, 'semantic_repair', 101);

    const summary = await getNightlyBudgetSummary(engine, input);
    expect(summary.settled_cents).toBe(101);
    expect(summary.remaining_cents).toBe(1399);
  });
});
