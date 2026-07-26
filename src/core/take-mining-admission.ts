/**
 * The server-owned reason a page write occurred.
 *
 * Write boundaries must assign this value explicitly. Agent-facing callers
 * must not choose it, and an omitted or unknown intent is not part of the
 * contract.
 */
export type WriteIntent =
  | 'user_edit'
  | 'live_ingest'
  | 'maintenance'
  | 'backfill'
  | 'derived';

/** The take-mining work class produced by the admission policy. */
export type TakeMiningAdmission = 'none' | 'immediate' | 'deferred';

/** Inputs required to classify a page revision for take mining. */
export interface TakeMiningAdmissionInput {
  writeIntent: WriteIntent;
  semanticChanged: boolean;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled write intent: ${String(value)}`);
}

/**
 * Classify whether and when a page revision should enter take mining.
 *
 * Semantic no-ops never create work. Human-authored and live-ingested
 * semantic changes run immediately; automated semantic changes are deferred
 * so a separate paced worker can admit them.
 */
export function classifyTakeMiningAdmission(
  input: TakeMiningAdmissionInput,
): TakeMiningAdmission {
  if (!input.semanticChanged) return 'none';

  switch (input.writeIntent) {
    case 'user_edit':
    case 'live_ingest':
      return 'immediate';
    case 'maintenance':
    case 'backfill':
    case 'derived':
      return 'deferred';
    default:
      return assertNever(input.writeIntent);
  }
}
