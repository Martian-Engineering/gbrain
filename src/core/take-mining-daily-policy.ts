import type { BrainEngine } from './engine.ts';

const DEFAULT_DAILY_PAGE_CAP = 100;
const DEFAULT_DAILY_PROPOSAL_CAP = 200;
const DEFAULT_DAILY_SPEND_CAP_USD = 5;
const DEFAULT_BUDGET_TIME_ZONE = 'America/Los_Angeles';

/** Budget-ledger scope shared by take-mining policy and reservations. */
export const TAKE_MINING_DAILY_BUDGET_SCOPE = 'brain';

/** Budget-ledger resolver shared by take-mining policy and reservations. */
export const TAKE_MINING_DAILY_BUDGET_RESOLVER = 'take_mining';

/** Resolved daily take-mining limits and the calendar window they govern. */
export interface TakeMiningDailyPolicy {
  pageCap: number;
  proposalCap: number;
  spendCapUsd: number;
  timeZone: string;
  localDate: string;
}

/** Current daily take-mining activity and budget-ledger usage. */
export interface TakeMiningDailyUsage {
  pageCalls: number;
  proposals: number;
  reservedUsd: number;
  committedUsd: number;
}

/**
 * Resolve the canonical daily take-mining policy from current configuration.
 */
export async function resolveTakeMiningDailyPolicy(
  engine: BrainEngine,
): Promise<TakeMiningDailyPolicy> {
  const [pageCap, proposalCap, spendCapUsd, configuredTimeZone] =
    await Promise.all([
      readNonNegativeConfig(
        engine,
        'take_mining.daily_page_cap',
        DEFAULT_DAILY_PAGE_CAP,
      ),
      readNonNegativeConfig(
        engine,
        'take_mining.daily_proposal_cap',
        DEFAULT_DAILY_PROPOSAL_CAP,
      ),
      readNonNegativeConfig(
        engine,
        'take_mining.daily_estimated_spend_usd',
        DEFAULT_DAILY_SPEND_CAP_USD,
      ),
      engine.getConfig('budget.tz'),
    ]);
  const timeZone = configuredTimeZone || DEFAULT_BUDGET_TIME_ZONE;
  return {
    pageCap,
    proposalCap,
    spendCapUsd,
    timeZone,
    localDate: currentDateInTimeZone(timeZone),
  };
}

/**
 * Read all activity governed by one resolved daily take-mining policy.
 */
export async function readTakeMiningDailyUsage(
  engine: BrainEngine,
  policy: TakeMiningDailyPolicy,
): Promise<TakeMiningDailyUsage> {
  const [pageRows, proposalRows, ledgerRows] = await Promise.all([
    engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM budget_reservations
        WHERE scope = $1
          AND resolver_id = $2
          AND local_date = $3::date
          AND status IN ('held', 'committed')`,
      [
        TAKE_MINING_DAILY_BUDGET_SCOPE,
        TAKE_MINING_DAILY_BUDGET_RESOLVER,
        policy.localDate,
      ],
    ),
    engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM take_proposals
        WHERE (proposed_at AT TIME ZONE $2) >= $1::date
          AND (proposed_at AT TIME ZONE $2) < ($1::date + interval '1 day')`,
      [policy.localDate, policy.timeZone],
    ),
    engine.executeRaw<{
      reserved_usd: string | number;
      committed_usd: string | number;
    }>(
      `SELECT reserved_usd, committed_usd
         FROM budget_ledger
       WHERE scope = $1
          AND resolver_id = $2
          AND local_date = $3::date`,
      [
        TAKE_MINING_DAILY_BUDGET_SCOPE,
        TAKE_MINING_DAILY_BUDGET_RESOLVER,
        policy.localDate,
      ],
    ),
  ]);
  return {
    pageCalls: pageRows[0]?.count ?? 0,
    proposals: proposalRows[0]?.count ?? 0,
    reservedUsd: Number(ledgerRows[0]?.reserved_usd ?? 0),
    committedUsd: Number(ledgerRows[0]?.committed_usd ?? 0),
  };
}

async function readNonNegativeConfig(
  engine: BrainEngine,
  key: string,
  fallback: number,
): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function currentDateInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
