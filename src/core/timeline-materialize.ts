import type { BrainEngine } from './engine.ts';
import { serializeMarkdown } from './markdown.ts';

/** A normalized timeline entry ready to render into page Markdown. */
export interface TimelineMarkdownEntry {
  date: string;
  summary: string;
  ref?: string;
  refLabel?: string;
}

/** Counts produced while materializing entries into one page. */
export interface TimelineMaterializeResult {
  materialized: number;
  skippedDuplicates: number;
}

/** Aggregate counts returned by a source-scoped timeline backfill. */
export interface TimelineBackfillResult {
  pages_touched: number;
  lines_written: number;
  skipped_duplicates: number;
}

interface TimelineBackfillRow {
  page_slug: string;
  date: string | Date;
  summary: string;
  source: string | null;
  event_slug: string | null;
  event_source_id: string | null;
}

/** Build the canonical Markdown bullet for a structured timeline entry. */
export function timelineMarkdownLine(entry: TimelineMarkdownEntry): string {
  const base = `- ${entry.date} — ${entry.summary}`;
  if (!entry.ref) return base;
  const label = sanitizeWikilinkLabel(entry.refLabel || entry.ref) || entry.ref;
  return `${base} [[${entry.ref}|${label}]]`;
}

/** Test whether a timeline already exposes the same date and summary. */
export function timelineContainsEntry(timeline: string, entry: TimelineMarkdownEntry): boolean {
  const base = `- ${entry.date} — ${entry.summary}`;
  return timeline.split('\n').some((line) => {
    const normalized = line.trimEnd();
    return normalized === base || normalized.startsWith(`${base} [[`);
  });
}

/** Resolve and validate a provenance page within one source. */
export async function resolveTimelineReference(
  engine: BrainEngine,
  sourceId: string,
  ref: string,
  refLabel?: string,
): Promise<{ ref: string; refLabel: string }> {
  const page = await engine.getPage(ref, { sourceId });
  if (!page) {
    throw new Error(`Timeline reference page "${ref}" (source=${sourceId}) not found`);
  }
  return {
    ref,
    refLabel: refLabel || page.title.trim() || ref,
  };
}

/** Append missing entries to a page through the canonical put_page import path. */
export async function materializeTimelineMarkdown(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  entries: TimelineMarkdownEntry[],
  dryRun = false,
): Promise<TimelineMaterializeResult> {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) throw new Error(`Timeline target page "${slug}" (source=${sourceId}) not found`);

  let timeline = page.timeline;
  const lines: string[] = [];
  let skippedDuplicates = 0;
  for (const entry of entries) {
    if (timelineContainsEntry(timeline, entry)) {
      skippedDuplicates++;
      continue;
    }
    const line = timelineMarkdownLine(entry);
    lines.push(line);
    timeline = timeline.trim()
      ? `${timeline.trimEnd()}\n${line}`
      : `## Timeline\n\n${line}`;
  }

  if (lines.length === 0 || dryRun) {
    return { materialized: lines.length, skippedDuplicates };
  }

  const tags = await engine.getTags(slug, { sourceId });
  const content = serializeMarkdown(page.frontmatter, page.compiled_truth, timeline, {
    type: page.type,
    title: page.title,
    tags,
  });
  const { operationsByName } = await import('./operations.ts');
  const result = await operationsByName.put_page.handler({
    engine,
    config: { engine: engine.kind },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  }, {
    slug,
    content,
    source_kind: 'timeline-materialize',
    ingested_via: 'timeline-materialize',
  });
  if ((result as { status?: string }).status !== 'created_or_updated') {
    throw new Error(
      `put_page returned status ${(result as { status?: string }).status ?? 'unknown'} while materializing ${slug}`,
    );
  }
  return { materialized: lines.length, skippedDuplicates };
}

/** Materialize every existing timeline row for one source. */
export async function backfillTimelineMarkdown(
  engine: BrainEngine,
  sourceId: string,
  dryRun = false,
): Promise<TimelineBackfillResult> {
  // Load every stored entry with its target page and any explicit event page.
  const rows = await engine.executeRaw<TimelineBackfillRow>(
    `SELECT p.slug AS page_slug, te.date, te.summary, te.source,
            event_page.slug AS event_slug, event_page.source_id AS event_source_id
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       LEFT JOIN pages event_page ON event_page.id = te.event_page_id
      WHERE p.source_id = $1
        AND p.deleted_at IS NULL
      ORDER BY p.slug, te.id`,
    [sourceId],
  );
  const byPage = new Map<string, TimelineBackfillRow[]>();
  // Group entries so each target is written through put_page only once.
  for (const row of rows) {
    const pageRows = byPage.get(row.page_slug) ?? [];
    pageRows.push(row);
    byPage.set(row.page_slug, pageRows);
  }

  const refCache = new Map<string, { ref: string; refLabel: string } | null>();
  let pagesTouched = 0;
  let linesWritten = 0;
  let skippedDuplicates = 0;
  // Existing Markdown remains untouched; missing rows append in insertion order.
  for (const [slug, pageRows] of byPage) {
    const entries: TimelineMarkdownEntry[] = [];
    for (const row of pageRows) {
      const ref = await resolveBackfillReference(engine, sourceId, row, refCache);
      entries.push({
        date: normalizeDate(row.date),
        summary: row.summary,
        ...ref,
      });
    }
    const result = await materializeTimelineMarkdown(engine, slug, sourceId, entries, dryRun);
    if (result.materialized > 0) pagesTouched++;
    linesWritten += result.materialized;
    skippedDuplicates += result.skippedDuplicates;
  }

  return {
    pages_touched: pagesTouched,
    lines_written: linesWritten,
    skipped_duplicates: skippedDuplicates,
  };
}

/** Keep wikilink labels on one safe Markdown line. */
function sanitizeWikilinkLabel(label: string): string {
  return label.replace(/[\r\n|\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Convert database DATE values to the public YYYY-MM-DD form. */
function normalizeDate(date: string | Date): string {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date.slice(0, 10);
}

/** Resolve a backfill row's structured or legacy free-text provenance. */
async function resolveBackfillReference(
  engine: BrainEngine,
  sourceId: string,
  row: TimelineBackfillRow,
  cache: Map<string, { ref: string; refLabel: string } | null>,
): Promise<{ ref: string; refLabel: string } | Record<string, never>> {
  const candidates = new Set<string>();
  if (row.event_slug && row.event_source_id === sourceId) candidates.add(row.event_slug);
  const source = row.source?.trim();
  const meetingPrefix = 'extract-timeline-from-meetings:';
  if (source?.startsWith(meetingPrefix)) candidates.add(source.slice(meetingPrefix.length));
  if (source) candidates.add(source);

  for (const candidate of candidates) {
    let resolved = cache.get(candidate);
    if (resolved === undefined) {
      const page = await engine.getPage(candidate, { sourceId });
      resolved = page
        ? { ref: candidate, refLabel: page.title.trim() || candidate }
        : null;
      cache.set(candidate, resolved);
    }
    if (resolved) return resolved;
  }
  return {};
}
