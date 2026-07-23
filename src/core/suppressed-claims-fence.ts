/**
 * Parser and renderer for the page-owned suppressed-claims fence.
 *
 * The shape follows the facts/takes convention: a named Markdown section,
 * paired gbrain HTML-comment markers, an escaped table, append-only row
 * numbers, and strikethrough for inactive audit history.
 */

import {
  escapeFenceCell,
  isSeparatorRow,
  parseRowCells,
  stripStrikethrough,
} from './fence-shared.ts';

/** Canonical Markdown heading immediately preceding the suppression fence. */
export const SUPPRESSED_CLAIMS_HEADING = '## Suppressed Claims';
/** Opening marker for the server-owned suppression table. */
export const SUPPRESSED_CLAIMS_FENCE_BEGIN = '<!--- gbrain:suppressions:begin -->';
/** Closing marker for the server-owned suppression table. */
export const SUPPRESSED_CLAIMS_FENCE_END = '<!--- gbrain:suppressions:end -->';

/** One durable suppression row parsed from page Markdown. */
export interface ParsedSuppressedClaim {
  rowNum: number;
  claimText: string;
  reason: string;
  suppressedAt: string;
  provenance: string;
  active: boolean;
}

/** Parse result with lenient hand-edit warnings. */
export interface SuppressedClaimsFenceParseResult {
  claims: ParsedSuppressedClaim[];
  warnings: string[];
}

interface FenceBounds {
  start: number;
  fenceStart: number;
  end: number;
}

/**
 * Preserve arbitrary plain text inside one Markdown table cell. The shared
 * fence convention handles pipes; this fence additionally entity-encodes
 * ampersands and line breaks so claims round-trip without splitting a row.
 */
function escapeSuppressionCell(value: string): string {
  return escapeFenceCell(
    value
      .replace(/&/g, '&amp;')
      .replace(/\r/g, '&#13;')
      .replace(/\n/g, '&#10;'),
  );
}

/** Decode the suppression-specific additions to the shared cell codec. */
function decodeSuppressionCell(value: string): string {
  return value
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

/** Locate the suppression fence and its immediately preceding heading. */
function findFenceBounds(body: string): FenceBounds | null {
  const fenceStart = body.indexOf(SUPPRESSED_CLAIMS_FENCE_BEGIN);
  if (fenceStart === -1) return null;
  const fenceEnd = body.indexOf(
    SUPPRESSED_CLAIMS_FENCE_END,
    fenceStart + SUPPRESSED_CLAIMS_FENCE_BEGIN.length,
  );
  if (fenceEnd === -1) return null;

  const prefix = body.slice(0, fenceStart);
  const headingMatch = prefix.match(/(?:^|\n)## Suppressed Claims[^\n]*\n\s*$/);
  const start = headingMatch?.index ?? fenceStart;
  let end = fenceEnd + SUPPRESSED_CLAIMS_FENCE_END.length;
  if (body[end] === '\n') end += 1;
  return { start, fenceStart, end };
}

/**
 * Parse the suppressed-claims table. Missing fences produce an empty result;
 * malformed rows are skipped with warnings.
 */
export function parseSuppressedClaimsFence(body: string): SuppressedClaimsFenceParseResult {
  const begin = body.indexOf(SUPPRESSED_CLAIMS_FENCE_BEGIN);
  const end = body.indexOf(
    SUPPRESSED_CLAIMS_FENCE_END,
    begin + SUPPRESSED_CLAIMS_FENCE_BEGIN.length,
  );
  const warnings: string[] = [];
  if (begin === -1 && end === -1) return { claims: [], warnings };
  if (begin === -1 || end === -1 || end < begin) {
    return {
      claims: [],
      warnings: ['SUPPRESSED_CLAIMS_FENCE_UNBALANCED: missing or misordered marker'],
    };
  }

  const claims: ParsedSuppressedClaim[] = [];
  const seen = new Set<number>();
  let sawHeader = false;
  const inner = body.slice(begin + SUPPRESSED_CLAIMS_FENCE_BEGIN.length, end);
  for (const line of inner.split('\n')) {
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;
    if (!sawHeader) {
      const lower = cells.map((cell) => cell.toLowerCase());
      if (lower.includes('claim_text') && lower.includes('provenance')) {
        sawHeader = true;
        continue;
      }
      warnings.push(`SUPPRESSED_CLAIMS_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    if (cells.length < 5) {
      warnings.push(`SUPPRESSED_CLAIMS_TABLE_MALFORMED: only ${cells.length} cells`);
      continue;
    }

    const rowNum = Number.parseInt(cells[0], 10);
    if (!Number.isFinite(rowNum) || rowNum <= 0 || seen.has(rowNum)) {
      warnings.push(`SUPPRESSED_CLAIMS_TABLE_MALFORMED: invalid row_num "${cells[0]}"`);
      continue;
    }
    const { text: encodedClaim, struck } = stripStrikethrough(cells[1]);
    const claimText = decodeSuppressionCell(encodedClaim);
    const suppressedAt = decodeSuppressionCell(cells[3]).trim();
    const provenance = decodeSuppressionCell(cells[4]).trim();
    if (!claimText.trim() || !suppressedAt || !provenance) {
      warnings.push(`SUPPRESSED_CLAIMS_TABLE_MALFORMED: missing required cell in row ${rowNum}`);
      continue;
    }

    seen.add(rowNum);
    claims.push({
      rowNum,
      claimText,
      reason: decodeSuppressionCell(cells[2]).trim(),
      suppressedAt,
      provenance,
      active: !struck,
    });
  }
  return { claims, warnings };
}

/** Render suppression rows into the canonical fenced Markdown table. */
export function renderSuppressedClaimsFence(claims: ParsedSuppressedClaim[]): string {
  const rows = claims.map((claim) => {
    const text = claim.active ? claim.claimText : `~~${claim.claimText}~~`;
    return `| ${claim.rowNum} | ${escapeSuppressionCell(text)} | ${escapeSuppressionCell(claim.reason)} | ${escapeSuppressionCell(claim.suppressedAt)} | ${escapeSuppressionCell(claim.provenance)} |`;
  });
  return [
    SUPPRESSED_CLAIMS_FENCE_BEGIN,
    '| # | claim_text | reason | suppressed_at | provenance |',
    '|---|------------|--------|---------------|------------|',
    ...rows,
    SUPPRESSED_CLAIMS_FENCE_END,
  ].join('\n');
}

/** Replace an existing fence or append a new section before the timeline. */
export function replaceSuppressedClaimsFence(
  body: string,
  claims: ParsedSuppressedClaim[],
): string {
  const section = `${SUPPRESSED_CLAIMS_HEADING}\n\n${renderSuppressedClaimsFence(claims)}\n`;
  const stripped = stripSuppressedClaimsFence(body);
  const timelineIndex = stripped.indexOf('<!-- timeline -->');
  if (timelineIndex !== -1) {
    const before = stripped.slice(0, timelineIndex).trimEnd();
    const after = stripped.slice(timelineIndex).trimStart();
    return `${before}\n\n${section}\n${after}`;
  }
  return `${stripped.trimEnd()}\n\n${section}`;
}

/** Append a suppression row with a stable, monotonically increasing row id. */
export function upsertSuppressedClaim(
  body: string,
  claim: Omit<ParsedSuppressedClaim, 'rowNum' | 'active'>,
): { body: string; rowNum: number } {
  const existing = parseSuppressedClaimsFence(body).claims;
  const rowNum = existing.length === 0
    ? 1
    : Math.max(...existing.map((entry) => entry.rowNum)) + 1;
  return {
    body: replaceSuppressedClaimsFence(body, [
      ...existing,
      { ...claim, rowNum, active: true },
    ]),
    rowNum,
  };
}

/** Remove the suppression heading and fence from a body. */
export function stripSuppressedClaimsFence(body: string): string {
  if (typeof body !== 'string') return body;
  const bounds = findFenceBounds(body);
  if (!bounds) return body;
  return `${body.slice(0, bounds.start).trimEnd()}\n${body.slice(bounds.end).trimStart()}`.trimEnd();
}

/**
 * Preserve only the server-owned existing fence across a put_page rewrite.
 * A caller-supplied fence is stripped when no canonical fence exists.
 */
export function preserveSuppressedClaimsFence(existingBody: string, candidate: string): string {
  const existing = parseSuppressedClaimsFence(existingBody).claims;
  const withoutCandidateFence = stripSuppressedClaimsFence(candidate);
  return existing.length > 0
    ? replaceSuppressedClaimsFence(withoutCandidateFence, existing)
    : withoutCandidateFence;
}
