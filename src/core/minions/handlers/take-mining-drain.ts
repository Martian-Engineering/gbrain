import type { BrainEngine } from '../../engine.ts';
import { loadConfigWithEngine } from '../../config.ts';
import type { MinionHandler } from '../types.ts';
import type { OperationContext } from '../../operations.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  runTakeMiningWork,
} from '../../cycle/propose-takes.ts';
import {
  TAKE_MINING_LOCK_NAME,
  TakeMiningRunnerError,
} from '../../cycle/take-mining-runner.ts';
import { withTakeMiningLock } from '../../cycle/take-mining-lock.ts';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface TakeMiningDrainData {
  source_id: string;
  batch_id: string;
  request_id: string;
  page_cap: number;
  proposal_cap: number;
  max_estimated_spend_usd: number;
  prompt_version: string;
  client_id?: string;
}

/** Validate persisted job data before acquiring a lock or spending money. */
export function validateTakeMiningDrainData(
  data: Record<string, unknown>,
): TakeMiningDrainData {
  const requiredIds = ['source_id', 'batch_id', 'request_id', 'prompt_version'] as const;
  for (const field of requiredIds) {
    if (typeof data[field] !== 'string' || !ID_PATTERN.test(data[field] as string)) {
      throw new Error(`take-mining-drain: invalid ${field}`);
    }
  }
  if (!Number.isInteger(data.page_cap) || (data.page_cap as number) < 1 || (data.page_cap as number) > 100) {
    throw new Error('take-mining-drain: page_cap must be an integer from 1 to 100');
  }
  if (!Number.isInteger(data.proposal_cap) || (data.proposal_cap as number) < 1 || (data.proposal_cap as number) > 500) {
    throw new Error('take-mining-drain: proposal_cap must be an integer from 1 to 500');
  }
  if (
    typeof data.max_estimated_spend_usd !== 'number'
    || !Number.isFinite(data.max_estimated_spend_usd)
    || data.max_estimated_spend_usd <= 0
  ) {
    throw new Error('take-mining-drain: max_estimated_spend_usd must be finite and greater than zero');
  }
  if (data.client_id !== undefined && typeof data.client_id !== 'string') {
    throw new Error('take-mining-drain: invalid client_id');
  }
  return data as unknown as TakeMiningDrainData;
}

/** Build the protected worker handler for one exact deferred batch. */
export function makeTakeMiningDrainHandler(engine: BrainEngine): MinionHandler {
  return async job => {
    const data = validateTakeMiningDrainData(job.data);
    if (data.prompt_version !== PROPOSE_TAKES_PROMPT_VERSION) {
      throw new TakeMiningRunnerError(
        'prompt_version_mismatch',
        `Pinned prompt ${data.prompt_version} does not match running prompt ${PROPOSE_TAKES_PROMPT_VERSION}; preview and resubmit the batch`,
      );
    }
    const config = await loadConfigWithEngine(engine);
    const ctx: OperationContext = {
      engine,
      config: config ?? ({ engine: engine.kind } as OperationContext['config']),
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: data.source_id,
    };
    const locked = await withTakeMiningLock(engine, job.signal, signal =>
      runTakeMiningWork(ctx, {
        admission: 'deferred',
        sourceId: data.source_id,
        batchId: data.batch_id,
        promptVersion: data.prompt_version,
        pageCap: data.page_cap,
        proposalCap: data.proposal_cap,
        maxEstimatedSpendUsd: data.max_estimated_spend_usd,
        signal,
      }),
    );
    if (!locked.acquired) {
      return {
        deferred: true,
        reason: 'take_mining_in_progress',
        lock_name: TAKE_MINING_LOCK_NAME,
      };
    }
    await job.updateProgress({
      pages_scanned: locked.value.pages_scanned,
      proposals_inserted: locked.value.proposals_inserted,
      remaining_work: locked.value.remaining_work,
    });
    return locked.value;
  };
}
