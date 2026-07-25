import type { ChronicleTimelineRow } from '../types.ts';

function parseWho(value: unknown): string[] | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    return null;
  }
  return parsed;
}

/** Normalize Chronicle JSONB fields returned by either database driver. */
export function normalizeChronicleTimelineRows(
  rows: readonly Record<string, unknown>[],
): ChronicleTimelineRow[] {
  return rows.map(row => ({
    ...row,
    who: parseWho(row.who),
  } as unknown as ChronicleTimelineRow));
}
