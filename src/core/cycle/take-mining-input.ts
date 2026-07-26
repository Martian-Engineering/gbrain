import { createHash } from 'node:crypto';

/** Canonical semantic input and its deterministic take-mining identity. */
export interface TakeMiningInput {
  prose: string;
  mining_input_hash: string;
}

interface ManagedMarker {
  line: number;
  name: string;
  boundary: 'begin' | 'end';
}

interface ManagedRegion {
  beginLine: number;
  endLine: number;
  name: string;
}

const MANAGED_MARKER =
  /^\s*<!---?\s*gbrain:([a-z0-9_-]+):(begin|end)\s*-->\s*$/i;

function findCompleteManagedRegions(lines: string[]): ManagedRegion[] {
  const stack: ManagedMarker[] = [];
  const regions: ManagedRegion[] = [];

  for (let line = 0; line < lines.length; line++) {
    const match = lines[line]!.match(MANAGED_MARKER);
    if (!match) continue;

    const marker: ManagedMarker = {
      line,
      name: match[1]!.toLowerCase(),
      boundary: match[2]!.toLowerCase() as ManagedMarker['boundary'],
    };
    if (marker.boundary === 'begin') {
      stack.push(marker);
      continue;
    }

    const begin = stack.pop();
    // A malformed marker sequence is ambiguous, so preserve the entire input.
    if (!begin || begin.name !== marker.name) return [];
    if (stack.length === 0) {
      regions.push({ beginLine: begin.line, endLine: marker.line, name: marker.name });
    }
  }

  // An incomplete managed region may contain user prose, so fail open.
  return stack.length === 0 ? regions : [];
}

function normalizedHeadingName(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHeading(line: string): { level: number; name: string } | undefined {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  if (!match) return undefined;
  return {
    level: match[0]!.trimStart().match(/^#+/)![0].length,
    name: normalizedHeadingName(match[1]!),
  };
}

function headingBelongsToRegion(heading: string, regionName: string): boolean {
  const managedName = normalizedHeadingName(regionName);
  if (heading === managedName) return true;
  return regionName === 'suppressions' && heading === 'suppressed claims';
}

function sectionIsEmpty(
  lines: string[],
  headingLine: number,
  headingLevel: number,
  removed: ReadonlySet<number>,
): boolean {
  for (let line = headingLine + 1; line < lines.length; line++) {
    const nextHeading = parseHeading(lines[line]!);
    if (nextHeading && nextHeading.level <= headingLevel) break;
    if (!removed.has(line) && lines[line]!.trim() !== '') return false;
  }
  return true;
}

function stripManagedRegions(prose: string): string {
  const lines = prose.replace(/\r\n?/g, '\n').split('\n');
  const regions = findCompleteManagedRegions(lines);
  const removed = new Set<number>();

  for (const region of regions) {
    for (let line = region.beginLine; line <= region.endLine; line++) {
      removed.add(line);
    }
  }

  for (const region of regions) {
    let headingLine = region.beginLine - 1;
    while (
      headingLine >= 0
      && (lines[headingLine]!.trim() === '' || removed.has(headingLine))
    ) {
      headingLine--;
    }
    const heading = headingLine >= 0 ? parseHeading(lines[headingLine]!) : undefined;
    if (
      heading
      && headingBelongsToRegion(heading.name, region.name)
      && sectionIsEmpty(lines, headingLine, heading.level, removed)
    ) {
      removed.add(headingLine);
    }
  }

  return lines.filter((_, line) => !removed.has(line)).join('\n');
}

function normalizeVisibleLinks(prose: string): string {
  return prose
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, _target: string, label: string) => label.trim())
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => target.trim())
    .replace(
      /!?\[([^\]\n]+)\]\(\s*(?:<[^>\n]*>|(?:\\.|[^()\n]|\([^()\n]*\))*)\s*\)/g,
      (_match, label: string) => label,
    );
}

function normalizeBlankLines(prose: string): string {
  const normalized: string[] = [];

  for (const line of prose.split('\n')) {
    const nextLine = line.trim() === '' ? '' : line;
    if (nextLine === '' && normalized.at(-1) === '') continue;
    normalized.push(nextLine);
  }

  while (normalized[0] === '') normalized.shift();
  while (normalized.at(-1) === '') normalized.pop();
  return normalized.join('\n');
}

/**
 * Build the semantic prose used by take extraction and its SHA-256 identity.
 *
 * Complete GBrain-managed regions and repairable link targets are excluded.
 * Malformed managed fences remain visible so user-authored content is never
 * silently discarded.
 */
export function buildTakeMiningInput(compiledTruth: string): TakeMiningInput {
  const prose = normalizeBlankLines(normalizeVisibleLinks(stripManagedRegions(compiledTruth)));
  const mining_input_hash = createHash('sha256').update(prose, 'utf8').digest('hex');
  return { prose, mining_input_hash };
}
