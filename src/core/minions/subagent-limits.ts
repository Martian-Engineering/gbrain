/** Default per-turn output-token cap for subagent jobs. */
export const DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS = 8_192;

/** Hard ceiling for caller-selected per-job output budgets. */
export const MAX_SUBAGENT_MAX_OUTPUT_TOKENS = 32_768;

/** Return whether a public per-job output budget is safely bounded. */
export function isValidSubagentMaxOutputTokens(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SUBAGENT_MAX_OUTPUT_TOKENS;
}

/** Resolve a subagent output cap from job data, configuration, then default. */
export function resolveSubagentMaxOutputTokens(
  perJob: number | undefined,
  configRaw: string | null | undefined,
): number {
  if (typeof perJob === 'number' && Number.isFinite(perJob) && perJob > 0) {
    return Math.floor(perJob);
  }
  if (typeof configRaw === 'string' && configRaw.trim() !== '') {
    const configured = Number(configRaw);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  }
  return DEFAULT_SUBAGENT_MAX_OUTPUT_TOKENS;
}
