import type { BrainEngine, TimelineBatchInput } from './engine.ts';

/** One structured timeline row projected for read-time Markdown rendering. */
export interface TimelineViewRow {
  id: number;
  page_id: number;
  date: string | Date;
  summary: string;
  event_page_id: number | null;
  event_slug: string | null;
  event_deleted_at: string | Date | null;
  ref_slug: string | null;
  ref_label: string | null;
}

/** Counts reported when a Markdown timeline section is imported into rows. */
export interface TimelineImportResult {
  imported: number;
  skipped_duplicates: number;
  dropped: number;
}

/** One parseable non-Chronicle Markdown line ready for row import. */
export interface TimelineImportEntry {
  date: string;
  summary: string;
  ref_slug?: string;
  ref_label?: string;
}

interface TimelineEventReference {
  date: string;
  slug: string;
  label: string;
}

interface ExistingTimelineRow {
  id: number;
  date: string | Date;
  summary: string;
  source: string;
  ref_slug: string | null;
  ref_label: string | null;
}

const CANONICAL_EVENT_LINE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+\[\[(life\/events\/[^|\]\n]+)(?:\|([^\]\n]+))?\]\]\s*$/;
const LINK_ONLY_LINE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+\[\[([^|\]\n]+)(?:\|([^\]\n]+))?\]\]\s*$/;
const REF_LINE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+?)\s+\[\[([^|\]\n]+)\|([^\]\n]+)\]\]\s*$/;
const BARE_LINE = /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+?)\s*$/;
const LEGACY_LINE = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s+\|\s+(.+?)\s*$/;

/** Shared SQL used by both engines to load rows for one or more pages. */
export const TIMELINE_VIEW_SQL = `
  SELECT te.id, te.page_id, te.date::text AS date, te.summary,
         te.event_page_id, event_page.slug AS event_slug,
         event_page.deleted_at AS event_deleted_at,
         te.ref_slug, te.ref_label
    FROM timeline_entries te
    LEFT JOIN pages event_page ON event_page.id = te.event_page_id
   WHERE te.page_id = ANY($1::int[])
   ORDER BY te.page_id, te.date DESC, te.id ASC`;

/** Compose the canonical page Timeline section from structured rows. */
export function composeTimelineView(rows: TimelineViewRow[]): string {
  const ordered = [...rows].sort((a, b) => {
    const dateOrder = normalizeDate(b.date).localeCompare(normalizeDate(a.date));
    return dateOrder || Number(a.id) - Number(b.id);
  });
  const lines: string[] = [];
  for (const row of ordered) {
    if (row.event_page_id !== null) {
      if (row.event_deleted_at !== null || !row.event_slug) continue;
      lines.push(`- ${normalizeDate(row.date)} — [[${row.event_slug}|${row.summary}]]`);
      continue;
    }
    const base = `- ${normalizeDate(row.date)} — ${row.summary}`;
    lines.push(row.ref_slug
      ? `${base} [[${row.ref_slug}|${row.ref_label || row.ref_slug}]]`
      : base);
  }
  return lines.length > 0 ? `## Timeline\n\n${lines.join('\n')}` : '';
}

/**
 * Load and compose Timeline views for a batch of already-authorized pages.
 * Never fall back to `pages.timeline`; `timeline_import` is the explicit
 * one-time migration for that legacy copy.
 */
export async function composePageTimelineViews(
  engine: Pick<BrainEngine, 'executeRaw'>,
  pageIds: number[],
): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(pageIds.map(Number))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await engine.executeRaw<TimelineViewRow>(TIMELINE_VIEW_SQL, [uniqueIds]);
  const grouped = new Map<number, TimelineViewRow[]>();
  for (const row of rows) {
    const pageId = Number(row.page_id);
    const pageRows = grouped.get(pageId) ?? [];
    pageRows.push(row);
    grouped.set(pageId, pageRows);
  }
  return new Map(uniqueIds.map(pageId => [
    pageId,
    composeTimelineView(grouped.get(pageId) ?? []),
  ]));
}

/** Parse supported dated bullets while ignoring Chronicle-owned event lines. */
export function parseTimelineSection(section: string): {
  entries: TimelineImportEntry[];
  eventReferences: TimelineEventReference[];
  dropped: number;
} {
  const entries: TimelineImportEntry[] = [];
  const eventReferences: TimelineEventReference[] = [];
  let dropped = 0;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^##\s+(timeline|history)\s*$/i.test(line)) continue;
    const event = CANONICAL_EVENT_LINE.exec(line);
    if (event) {
      if (isValidDate(event[1]!)) {
        eventReferences.push({
          date: event[1]!,
          slug: event[2]!.trim(),
          label: (event[3] ?? event[2]!).trim(),
        });
      } else dropped++;
      continue;
    }
    const linkOnly = LINK_ONLY_LINE.exec(line);
    if (linkOnly) {
      if (isValidDate(linkOnly[1]!)) {
        eventReferences.push({
          date: linkOnly[1]!,
          slug: linkOnly[2]!.trim(),
          label: (linkOnly[3] ?? linkOnly[2]!).trim(),
        });
      }
      dropped++;
      continue;
    }
    const ref = REF_LINE.exec(line);
    if (ref && isValidDate(ref[1]!)) {
      entries.push({
        date: ref[1]!,
        summary: ref[2]!.trim(),
        ref_slug: ref[3]!.trim(),
        ref_label: ref[4]!.trim(),
      });
      continue;
    }
    const bare = BARE_LINE.exec(line) ?? LEGACY_LINE.exec(line);
    if (bare && isValidDate(bare[1]!)) {
      entries.push({ date: bare[1]!, summary: bare[2]!.trim() });
      continue;
    }
    dropped++;
  }
  return { entries, eventReferences, dropped };
}

/** Resolve and validate a provenance page within one source. */
export async function resolveTimelineReference(
  engine: BrainEngine,
  sourceId: string,
  ref: string,
  refLabel?: string,
): Promise<{ ref_slug: string; ref_label: string }> {
  const page = await engine.getPage(ref, { sourceId });
  if (!page) {
    throw new Error(`Timeline reference page "${ref}" (source=${sourceId}) not found`);
  }
  return {
    ref_slug: ref,
    ref_label: refLabel || page.title.trim() || ref,
  };
}

/** Import one page's parseable Timeline bullets without deleting any rows. */
export async function importTimelineSection(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  section: string,
  dryRun = false,
): Promise<TimelineImportResult> {
  const parsed = parseTimelineSection(section);
  // Missing same-source refs import as bare rows; valid refs retain their
  // persisted slug/label for read-time rendering.
  const refSlugs = [...new Set(parsed.entries.flatMap(entry => entry.ref_slug ? [entry.ref_slug] : []))];
  const validRefs = refSlugs.length === 0
    ? new Set<string>()
    : new Set((await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])`,
      [sourceId, refSlugs],
    )).map(row => row.slug));
  const candidates: TimelineBatchInput[] = parsed.entries.map(entry => ({
    slug,
    source_id: sourceId,
    date: entry.date,
    source: '',
    summary: entry.summary,
    detail: '',
    ...(entry.ref_slug && validRefs.has(entry.ref_slug)
      ? { ref_slug: entry.ref_slug, ref_label: entry.ref_label }
      : {}),
  }));

  const existing = await engine.executeRaw<ExistingTimelineRow>(
    `SELECT te.id, te.date::text AS date, te.summary, te.source,
            te.ref_slug, te.ref_label
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
      WHERE p.source_id = $1 AND p.slug = $2`,
    [sourceId, slug],
  );
  // A legacy materialized Chronicle line may accompany an ordinary row whose
  // source names that exact event. It never creates a projection row; it only
  // preserves the already-proven same-source backlink as ref metadata.
  for (const event of parsed.eventReferences) {
    const row = existing.find(candidate =>
      normalizeDate(candidate.date) === event.date
      && candidate.source === `extract-timeline-from-meetings:${event.slug}`
    );
    if (!dryRun && row && !row.ref_slug) {
      await engine.executeRaw(
        `UPDATE timeline_entries SET ref_slug = $1, ref_label = $2 WHERE id = $3`,
        [event.slug, event.label, row.id],
      );
      row.ref_slug = event.slug;
      row.ref_label = event.label;
    }
  }

  // The Markdown view cannot encode the free-text source column. Match on
  // visible identity so serializing and re-importing an existing sourced row
  // does not create a second source='' copy.
  const existingByKey = new Map(existing.map(row => [visibleEntryKey(row), row]));
  const pending: TimelineBatchInput[] = [];
  let skippedDuplicates = 0;
  for (const candidate of candidates) {
    const key = visibleEntryKey(candidate);
    const duplicate = existingByKey.get(key);
    if (duplicate) {
      skippedDuplicates++;
      if (!dryRun && candidate.ref_slug && !duplicate.ref_slug) {
        await engine.executeRaw(
          `UPDATE timeline_entries SET ref_slug = $1, ref_label = $2 WHERE id = $3`,
          [candidate.ref_slug, candidate.ref_label ?? candidate.ref_slug, duplicate.id],
        );
      }
      continue;
    }
    existingByKey.set(key, {
      id: -1,
      date: candidate.date,
      summary: candidate.summary,
      source: candidate.source ?? '',
      ref_slug: candidate.ref_slug ?? null,
      ref_label: candidate.ref_label ?? null,
    });
    pending.push(candidate);
  }

  const imported = dryRun || pending.length === 0
    ? pending.length
    : await engine.addTimelineEntriesBatch(pending);
  return {
    imported,
    skipped_duplicates: skippedDuplicates + pending.length - imported,
    dropped: parsed.dropped,
  };
}

/** Convert database DATE values to the public YYYY-MM-DD form. */
function normalizeDate(date: string | Date): string {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
}

/** Build the identity that survives a Markdown view round-trip. */
function visibleEntryKey(entry: { date: string | Date; summary: string }): string {
  return `${normalizeDate(entry.date)}\u0000${entry.summary}`;
}

/** Reject impossible calendar dates before they reach a DATE cast. */
function isValidDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
