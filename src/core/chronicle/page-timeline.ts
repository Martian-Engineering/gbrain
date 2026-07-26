import type { BrainEngine } from '../engine.ts';
import type {
  PageTimelineEvent,
  PageTimelineEventResult,
  PageTimelineEventState,
  PageTimelineEventTarget,
} from '../types.ts';

const CANONICAL_EVENT_LINE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+—\s+\[\[(life\/events\/[^|\]\n]+)(?:\|([^\]\n]+))?\]\]\s*$/;

export interface CanonicalTimelineEventLink {
  date: string;
  event_slug: string;
  authored_label: string;
  source_order: number;
}

export interface ResolvePageTimelineEventsOptions {
  slug: string;
  sourceId?: string;
  sourceIds?: string[];
  offset?: number;
  limit?: number;
}

interface EventPageRow {
  slug: string;
  title: string;
  type: string;
  deleted_at: string | Date | null;
  effective_date: string | Date | null;
  frontmatter: unknown;
  depth_slug: string | null;
  depth_title: string | null;
  depth_type: string | null;
  depth_deleted_at: string | Date | null;
}

/** Raised when the requested source-scoped page does not exist. */
export class PageTimelineNotFoundError extends Error {
  constructor(slug: string) {
    super(`Page not found: ${slug}`);
    this.name = 'PageTimelineNotFoundError';
  }
}

/** Parse the exact canonical Chronicle event backlink syntax from a timeline. */
export function parseCanonicalTimelineEventLinks(
  timeline: string,
): CanonicalTimelineEventLink[] {
  const events: CanonicalTimelineEventLink[] = [];
  for (const line of timeline.split(/\r?\n/)) {
    const match = CANONICAL_EVENT_LINE.exec(line);
    if (!match) continue;
    const eventSlug = match[2]!.trim();
    events.push({
      date: match[1]!,
      event_slug: eventSlug,
      authored_label: (match[3] ?? eventSlug).trim(),
      source_order: events.length,
    });
  }
  return events;
}

/** Resolve graph-bearing Chronicle timeline links without mutating their edges. */
export async function resolvePageTimelineEvents(
  engine: BrainEngine,
  opts: ResolvePageTimelineEventsOptions,
): Promise<PageTimelineEventResult> {
  const page = await engine.getPage(opts.slug, {
    ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}),
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
  });
  if (!page) throw new PageTimelineNotFoundError(opts.slug);

  const parsed = parseCanonicalTimelineEventLinks(page.timeline);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
  const selected = parsed.slice(offset, offset + limit);
  const eventSlugs = [...new Set(selected.map(event => event.event_slug))];
  const [eventRows, linkedSlugs] = await Promise.all([
    loadEventRows(engine, page.source_id, eventSlugs),
    loadLinkedEventSlugs(engine, page.source_id, page.slug, eventSlugs),
  ]);
  const rowsBySlug = new Map(eventRows.map(row => [row.slug, row]));
  const links = new Set(linkedSlugs.map(row => row.slug));
  const events = selected.map(event =>
    enrichTimelineEvent(event, rowsBySlug.get(event.event_slug), links.has(event.event_slug))
  );

  return {
    schema_version: 1,
    page_slug: page.slug,
    source_id: page.source_id,
    total: parsed.length,
    offset,
    limit,
    truncated: offset + events.length < parsed.length,
    events,
    issue_counts: {
      soft_deleted: events.filter(event => event.state === 'soft_deleted').length,
      missing: events.filter(event => event.state === 'missing').length,
      graph_missing: events.filter(event => event.state === 'graph_missing').length,
      depth_missing: events.filter(event =>
        event.depth !== null && event.depth.state !== 'active'
      ).length,
    },
  };
}

/** Fetch event and depth-page metadata in one source-scoped query. */
async function loadEventRows(
  engine: BrainEngine,
  sourceId: string,
  eventSlugs: string[],
): Promise<EventPageRow[]> {
  if (eventSlugs.length === 0) return [];
  return engine.executeRaw<EventPageRow>(
    `SELECT e.slug, e.title, e.type, e.deleted_at, e.effective_date, e.frontmatter,
            e.frontmatter->'event'->>'depth' AS depth_slug,
            d.title AS depth_title, d.type AS depth_type,
            d.deleted_at AS depth_deleted_at
       FROM pages e
       LEFT JOIN pages d
         ON d.source_id = e.source_id
        AND d.slug = e.frontmatter->'event'->>'depth'
      WHERE e.source_id = $1
        AND e.slug = ANY($2::text[])`,
    [sourceId, eventSlugs],
  );
}

/** Read the existing entity-to-event edges without changing graph state. */
async function loadLinkedEventSlugs(
  engine: BrainEngine,
  sourceId: string,
  pageSlug: string,
  eventSlugs: string[],
): Promise<Array<{ slug: string }>> {
  if (eventSlugs.length === 0) return [];
  return engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT target.slug
       FROM links l
       JOIN pages source ON source.id = l.from_page_id
       JOIN pages target ON target.id = l.to_page_id
      WHERE source.source_id = $1
        AND source.slug = $2
        AND target.source_id = $1
        AND target.slug = ANY($3::text[])`,
    [sourceId, pageSlug, eventSlugs],
  );
}

/** Convert a canonical source link plus optional DB row into the public shape. */
function enrichTimelineEvent(
  link: CanonicalTimelineEventLink,
  row: EventPageRow | undefined,
  graphEdgePresent: boolean,
): PageTimelineEvent {
  const event = recordValue(recordValue(row?.frontmatter).event);
  const state: PageTimelineEventState = !row
    ? 'missing'
    : row.deleted_at
      ? 'soft_deleted'
      : graphEdgePresent
        ? 'active'
        : 'graph_missing';
  const depth = row?.depth_slug
    ? eventTarget(row)
    : null;

  return {
    ...link,
    state,
    graph_edge_present: graphEdgePresent,
    summary: stringValue(event.what) ?? link.authored_label,
    event_title: row?.title ?? null,
    effective_date: isoValue(row?.effective_date),
    when: stringValue(event.when),
    kind: stringValue(event.kind),
    owner: stringValue(event.owner),
    who: stringArray(event.who),
    where: stringValue(event.where),
    depth,
  };
}

/** Resolve the depth-page destination while retaining missing/deleted state. */
function eventTarget(row: EventPageRow): PageTimelineEventTarget {
  return {
    slug: row.depth_slug!,
    title: row.depth_title,
    type: row.depth_type,
    state: row.depth_title === null
      ? 'missing'
      : row.depth_deleted_at
        ? 'soft_deleted'
        : 'active',
  };
}

/** Narrow unknown JSON objects without trusting malformed stored values. */
function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Return a non-empty string or null for malformed Chronicle metadata. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Chronicle participant arrays are all-or-nothing to avoid partial lies. */
function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : null;
}

/** Normalize database timestamp variants into an ISO string. */
function isoValue(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}
