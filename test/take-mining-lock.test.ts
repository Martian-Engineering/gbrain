import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import {
  TAKE_MINING_LOCK_NAME,
} from '../src/core/cycle/take-mining-runner.ts';
import { withTakeMiningLock } from '../src/core/cycle/take-mining-lock.ts';
import { makeTakeMiningDrainHandler } from '../src/core/minions/handlers/take-mining-drain.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  runPhaseProposeTakes,
} from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('renewable take-mining lock', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('returns busy cleanly and releases after successful work', async () => {
    const held = await tryAcquireDbLock(engine, TAKE_MINING_LOCK_NAME);
    expect(held).not.toBeNull();
    const busy = await withTakeMiningLock(engine, undefined, async () => 'never');
    expect(busy).toEqual({ acquired: false });
    await held?.release();

    const completed = await withTakeMiningLock(engine, undefined, async () => 'done');
    expect(completed).toEqual({ acquired: true, value: 'done' });
    expect(await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM gbrain_cycle_locks
        WHERE id = $1`,
      [TAKE_MINING_LOCK_NAME],
    )).toEqual([{ count: 0 }]);
  });

  test('renews while running and releases on cooperative abort', async () => {
    const controller = new AbortController();
    let refreshed = false;
    const running = withTakeMiningLock(
      engine,
      controller.signal,
      async signal => {
        await new Promise(resolve => setTimeout(resolve, 35));
        const [row] = await engine.executeRaw<{ refreshed: boolean }>(
          `SELECT last_refreshed_at > acquired_at AS refreshed
             FROM gbrain_cycle_locks
            WHERE id = $1`,
          [TAKE_MINING_LOCK_NAME],
        );
        refreshed = row?.refreshed ?? false;
        controller.abort(new Error('test abort'));
        signal.throwIfAborted();
        return 'unreachable';
      },
      { refreshIntervalMs: 5 },
    );
    await expect(running).rejects.toThrow('test abort');
    expect(refreshed).toBe(true);
    expect(await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM gbrain_cycle_locks
        WHERE id = $1`,
      [TAKE_MINING_LOCK_NAME],
    )).toEqual([{ count: 0 }]);
  });

  test('fails a successful work result when renewal is lost', async () => {
    let released = false;
    const run = withTakeMiningLock(
      engine,
      undefined,
      async () => {
        await new Promise(resolve => setTimeout(resolve, 15));
        return 'would-have-succeeded';
      },
      {
        refreshIntervalMs: 1,
        acquire: async () => ({
          id: TAKE_MINING_LOCK_NAME,
          async refresh() {
            throw new Error('lease lost');
          },
          async release() {
            released = true;
          },
        }),
      },
    );
    await expect(run).rejects.toThrow('take-mining lock refresh failed: lease lost');
    expect(released).toBe(true);
  });

  test('treats a zero-row renewal as lock loss', async () => {
    const run = withTakeMiningLock(
      engine,
      undefined,
      async () => {
        await new Promise(resolve => setTimeout(resolve, 15));
        return 'would-have-succeeded';
      },
      {
        refreshIntervalMs: 1,
        acquire: async () => ({
          id: TAKE_MINING_LOCK_NAME,
          async refresh() {},
          async release() {},
        }),
      },
    );
    await expect(run).rejects.toThrow(
      'take-mining lock refresh failed: renewal completed without ownership',
    );
  });

  test('deferred handler reports the shared lock as busy without running', async () => {
    const held = await tryAcquireDbLock(engine, TAKE_MINING_LOCK_NAME);
    expect(held).not.toBeNull();
    const handler = makeTakeMiningDrainHandler(engine);
    const result = await handler({
      id: 1,
      name: 'take-mining-drain',
      data: {
        source_id: 'default',
        batch_id: 'history',
        request_id: 'attempt-1',
        page_cap: 10,
        proposal_cap: 20,
        max_estimated_spend_usd: 1,
        prompt_version: PROPOSE_TAKES_PROMPT_VERSION,
      },
      attempts_made: 0,
      signal: new AbortController().signal,
      deadlineAtMs: null,
      shutdownSignal: new AbortController().signal,
      async updateProgress() {},
      async updateTokens() {},
      async log() {},
      async isActive() { return true; },
      async readInbox() { return []; },
    });
    expect(result).toEqual({
      deferred: true,
      reason: 'take_mining_in_progress',
      lock_name: TAKE_MINING_LOCK_NAME,
    });
    await held?.release();
  });

  test('immediate cycle reports the same shared lock as busy', async () => {
    const held = await tryAcquireDbLock(engine, TAKE_MINING_LOCK_NAME);
    expect(held).not.toBeNull();
    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
    const result = await runPhaseProposeTakes(ctx, {
      _extractableTypes: ['note'],
    });
    expect(result).toMatchObject({
      status: 'warn',
      details: {
        deferred: true,
        reason: 'take_mining_in_progress',
        lock_name: TAKE_MINING_LOCK_NAME,
      },
    });
    await held?.release();
  });
});
