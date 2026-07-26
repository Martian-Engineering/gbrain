import type { BrainEngine } from '../engine.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { TAKE_MINING_LOCK_NAME } from './take-mining-runner.ts';
import { hostname } from 'node:os';

const DEFAULT_LOCK_TTL_MINUTES = 30;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/** Result of entering the brain-wide take-mining critical section. */
export type TakeMiningLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/** The renewable take-mining lock was lost while paid work was running. */
export class TakeMiningLockLostError extends Error {
  constructor(cause: unknown) {
    super(`take-mining lock refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TakeMiningLockLostError';
  }
}

/** Test seams for the renewable-lock lifecycle. */
export interface TakeMiningLockOptions {
  ttlMinutes?: number;
  refreshIntervalMs?: number;
  /** Deterministic acquisition seam for lock-loss tests. */
  acquire?: typeof tryAcquireDbLock;
}

async function assertTakeMiningLockOwned(engine: BrainEngine): Promise<void> {
  const [row] = await engine.executeRaw<{ owned: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM gbrain_cycle_locks
        WHERE id = $1
          AND holder_pid = $2
          AND holder_host = $3
          AND ttl_expires_at > now()
     ) AS owned`,
    [TAKE_MINING_LOCK_NAME, process.pid, hostname()],
  );
  if (!row?.owned) {
    throw new Error('renewal completed without ownership');
  }
}

/**
 * Run work under the shared brain-wide take-mining lock.
 *
 * Busy acquisition is a clean result. Cancellation is forwarded to the work,
 * and a failed renewal aborts it before the helper releases the lock.
 */
export async function withTakeMiningLock<T>(
  engine: BrainEngine,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
  options: TakeMiningLockOptions = {},
): Promise<TakeMiningLockResult<T>> {
  const handle = await (options.acquire ?? tryAcquireDbLock)(
    engine,
    TAKE_MINING_LOCK_NAME,
    options.ttlMinutes ?? DEFAULT_LOCK_TTL_MINUTES,
  );
  if (!handle) return { acquired: false };

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  let refreshPromise: Promise<void> | null = null;
  let refreshError: TakeMiningLockLostError | null = null;
  const timer = setInterval(() => {
    if (refreshPromise) return;
    refreshPromise = handle.refresh()
      .then(() => assertTakeMiningLockOwned(engine))
      .catch(error => {
        refreshError = new TakeMiningLockLostError(error);
        controller.abort(refreshError);
      })
      .finally(() => {
        refreshPromise = null;
      });
  }, options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
  timer.unref?.();

  let value!: T;
  try {
    controller.signal.throwIfAborted();
    value = await work(controller.signal);
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', forwardAbort);
    await refreshPromise;
    await handle.release();
  }
  if (refreshError) throw refreshError;
  controller.signal.throwIfAborted();
  return { acquired: true, value };
}
