import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('take-mining operation contracts', () => {
  test('publishes the three remote admin operations with bounded inputs', () => {
    const enqueue = operationsByName.enqueue_take_mining_work;
    const run = operationsByName.run_take_mining_batch;
    const status = operationsByName.get_take_mining_status;

    expect(enqueue).toMatchObject({
      scope: 'admin',
      mutating: true,
      localOnly: false,
    });
    expect(run).toMatchObject({
      scope: 'admin',
      mutating: true,
      localOnly: false,
    });
    expect(status).toMatchObject({
      scope: 'admin',
      localOnly: false,
    });
    expect(enqueue.params.source_id.required).toBe(true);
    expect(enqueue.params.batch_id.required).toBe(true);
    expect(enqueue.params.page_cap.required).toBe(true);
    expect(enqueue.params.dry_run.required).toBe(true);
    expect(run.params.source_id.required).toBe(true);
    expect(run.params.batch_id.required).toBe(true);
    expect(run.params.request_id.required).toBe(true);
    expect(run.params.page_cap.required).toBe(true);
    expect(run.params.proposal_cap.required).toBe(true);
    expect(run.params.max_estimated_spend_usd.required).toBe(true);
  });

  test('protects the paid drain and recognizes its config namespace', () => {
    expect(PROTECTED_JOB_NAMES.has('take-mining-drain')).toBe(true);
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('take_mining.');
  });
});

describe('take-mining operation behavior', () => {
  let engine: PGLiteEngine;
  let ctx: OperationContext;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ctx = {
      engine,
      config: {} as OperationContext['config'],
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'stale-context-source',
      auth: {
        token: 'test',
        clientId: 'admin-client',
        scopes: ['admin'],
        sourceId: 'default',
      },
    };
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('version', '132');
  });

  test('authorizes the requested source before reading or submitting', async () => {
    const promise = operationsByName.run_take_mining_batch.handler(ctx, {
      source_id: 'neighbor',
      batch_id: 'history',
      request_id: 'attempt-1',
      page_cap: 10,
      proposal_cap: 20,
      max_estimated_spend_usd: 1,
      dry_run: true,
    });
    await expect(promise).rejects.toBeInstanceOf(OperationError);
    await expect(promise).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM minion_jobs`,
    )).toEqual([{ count: 0 }]);
  });

  test('dry-run reports caps without creating a job', async () => {
    const result = await operationsByName.run_take_mining_batch.handler(ctx, {
      source_id: 'default',
      batch_id: 'history',
      request_id: 'attempt-1',
      page_cap: 10,
      proposal_cap: 20,
      max_estimated_spend_usd: 1,
      dry_run: true,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      dry_run: true,
      outstanding: 0,
      effective_caps: {
        pages: 10,
        proposals: 20,
        estimated_spend_usd: 1,
      },
    });
    expect(await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM minion_jobs`,
    )).toEqual([{ count: 0 }]);
  });

  test('generic submit_job cannot bypass the dedicated validated operation', async () => {
    const local = { ...ctx, remote: false, auth: undefined };
    await expect(operationsByName.submit_job.handler(local, {
      name: 'take-mining-drain',
      data: {},
    })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('submits one protected pinned job per request id and reports it', async () => {
    const params = {
      source_id: 'default',
      batch_id: 'history',
      request_id: 'attempt-1',
      page_cap: 10,
      proposal_cap: 20,
      max_estimated_spend_usd: 1,
    };
    const first = await operationsByName.run_take_mining_batch.handler(ctx, params) as {
      job_id: number;
    };
    const second = await operationsByName.run_take_mining_batch.handler(ctx, {
      ...params,
      page_cap: 99,
      proposal_cap: 400,
      max_estimated_spend_usd: 9,
    }) as {
      job_id: number;
      effective_caps: Record<string, unknown>;
    };
    expect(second.job_id).toBe(first.job_id);
    expect(second.effective_caps).toEqual({
      pages: 10,
      proposals: 20,
      estimated_spend_usd: 1,
    });

    const status = await operationsByName.get_take_mining_status.handler(ctx, {
      source_id: 'default',
      batch_id: 'history',
    }) as { jobs: Array<Record<string, unknown>> };
    expect(status.jobs).toEqual([{
      id: first.job_id,
      status: 'waiting',
      batch_id: 'history',
    }]);
    const [job] = await engine.executeRaw<{
      name: string;
      max_attempts: number;
      timeout_ms: number;
      prompt_version: string;
    }>(
      `SELECT name, max_attempts, timeout_ms,
              data->>'prompt_version' AS prompt_version
         FROM minion_jobs`,
    );
    expect(job).toMatchObject({
      name: 'take-mining-drain',
      max_attempts: 1,
      timeout_ms: 1_800_000,
    });
    expect(typeof job?.prompt_version).toBe('string');
  });

  test('uses unambiguous idempotency for colon-bearing ids', async () => {
    const base = {
      source_id: 'default',
      page_cap: 1,
      proposal_cap: 1,
      max_estimated_spend_usd: 1,
    };
    const first = await operationsByName.run_take_mining_batch.handler(ctx, {
      ...base,
      batch_id: 'a:b',
      request_id: 'c',
    }) as { job_id: number };
    const second = await operationsByName.run_take_mining_batch.handler(ctx, {
      ...base,
      batch_id: 'a',
      request_id: 'b:c',
    }) as { job_id: number };
    expect(second.job_id).not.toBe(first.job_id);
  });
});
