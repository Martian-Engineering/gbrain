import type { WriteIntent } from './take-mining-admission.ts';

/** Trusted operator classification accepted by import and sync CLIs. */
export type IngestionMode = 'live' | 'backfill';

/**
 * Parse an optional trusted CLI ingestion-mode declaration.
 *
 * Absence is distinct from either mode so each producer can preserve its
 * existing default classification.
 */
export function parseIngestionMode(args: readonly string[]): IngestionMode | undefined {
  const flagIndex = args.indexOf('--ingestion-mode');
  if (flagIndex === -1) return undefined;

  const value = args[flagIndex + 1];
  if (value !== 'live' && value !== 'backfill') {
    throw new Error('--ingestion-mode must be either "live" or "backfill".');
  }
  return value;
}

/** Map operator vocabulary onto the durable mutation vocabulary. */
export function writeIntentForIngestionMode(mode: IngestionMode): WriteIntent {
  return mode === 'live' ? 'live_ingest' : 'backfill';
}
