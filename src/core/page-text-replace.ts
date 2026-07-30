/** Stable failure codes returned by scoped page-text replacement. */
export type PageTextReplaceErrorCode =
  | 'invalid_old_text'
  | 'match_count_mismatch'
  | 'malformed_managed_region';

/** Structured details for a replacement-count mismatch. */
export interface MatchCountDetails {
  expectedMatches: number;
  editableMatches: number;
  protectedMatches: number;
}

/** A validation failure that leaves page content unchanged. */
export class PageTextReplaceError extends Error {
  constructor(
    public readonly code: PageTextReplaceErrorCode,
    message: string,
    public readonly details?: MatchCountDetails,
  ) {
    super(message);
    this.name = 'PageTextReplaceError';
  }
}

/** Successful literal replacement of authored page text. */
export interface PageTextReplaceResult {
  content: string;
  replaced: number;
  protectedMatches: number;
}

interface PageSegment {
  content: string;
  protected: boolean;
}

const MANAGED_MARKER = /<!---?\s*gbrain:([a-z0-9_-]+):(begin|end)\s*-->/gi;

/** Count non-overlapping literal occurrences in one string. */
function countLiteral(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const match = content.indexOf(needle, offset);
    if (match === -1) break;
    count++;
    offset = match + needle.length;
  }
  return count;
}

/** Split authored text from balanced GBrain-managed regions. */
function splitManagedRegions(content: string): PageSegment[] {
  const segments: PageSegment[] = [];
  let cursor = 0;
  let open: { name: string; start: number } | null = null;

  for (const match of content.matchAll(MANAGED_MARKER)) {
    const index = match.index;
    const name = match[1]!.toLowerCase();
    const boundary = match[2]!.toLowerCase();

    if (boundary === 'begin') {
      if (open) {
        throw new PageTextReplaceError(
          'malformed_managed_region',
          `Managed region "${name}" begins before "${open.name}" ends`,
        );
      }
      if (index > cursor) {
        segments.push({ content: content.slice(cursor, index), protected: false });
      }
      open = { name, start: index };
      continue;
    }

    if (!open || open.name !== name) {
      throw new PageTextReplaceError(
        'malformed_managed_region',
        `Managed region "${name}" has no matching begin marker`,
      );
    }
    const end = index + match[0].length;
    segments.push({ content: content.slice(open.start, end), protected: true });
    cursor = end;
    open = null;
  }

  if (open) {
    throw new PageTextReplaceError(
      'malformed_managed_region',
      `Managed region "${open.name}" has no matching end marker`,
    );
  }
  if (cursor < content.length || segments.length === 0) {
    segments.push({ content: content.slice(cursor), protected: false });
  }
  return segments;
}

/**
 * Replace exact, case-sensitive text only in authored page-body segments.
 *
 * Every balanced `gbrain:<name>:begin/end` region is copied byte-for-byte.
 * The edit is all-or-nothing: an empty locator, malformed managed region, or
 * unexpected editable match count throws before returning changed content.
 */
export function replaceAuthoredPageText(
  content: string,
  oldText: string,
  newText: string,
  expectedMatches: number,
): PageTextReplaceResult {
  if (oldText.length === 0) {
    throw new PageTextReplaceError('invalid_old_text', 'old_text must be non-empty');
  }

  const segments = splitManagedRegions(content);
  const editableMatches = segments
    .filter((segment) => !segment.protected)
    .reduce((count, segment) => count + countLiteral(segment.content, oldText), 0);
  const protectedMatches = segments
    .filter((segment) => segment.protected)
    .reduce((count, segment) => count + countLiteral(segment.content, oldText), 0);

  if (editableMatches !== expectedMatches) {
    const details = { expectedMatches, editableMatches, protectedMatches };
    throw new PageTextReplaceError(
      'match_count_mismatch',
      `Expected ${expectedMatches} editable matches but found ${editableMatches}`,
      details,
    );
  }

  const replacedContent = segments
    .map((segment) => segment.protected
      ? segment.content
      : segment.content.split(oldText).join(newText))
    .join('');
  return { content: replacedContent, replaced: editableMatches, protectedMatches };
}
