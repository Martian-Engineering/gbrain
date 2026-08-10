// src/core/extract-timeline-from-meetings.ts
// v0.41.18.0 (A11, T8). Walk meeting/event pages, identify discussed entities via
// (a) existing `attended` links (attendees) + (b) body-mention scan, and
// write a timeline entry on each entity page with an event-specific source
// key that survives v99's widened dedup.
//
// Codex finding #11 dependency: requires v99 dedup widening from
// (page_id, date, summary) to (page_id, date, summary, source). Without v99,
// two meetings on the same date with the same summary on the same entity
// page would silently drop the second one.

import type { BrainEngine } from './engine.ts';
import type { TimelineBatchInput } from './engine.ts';
import { buildGazetteer, findMentionedEntities, type Gazetteer } from './by-mention.ts';
import { loadConfig } from './config.ts';
import { serializeMarkdown } from './markdown.ts';
import { loadActivePack } from './schema-pack/load-active.ts';
import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';

type TimelinePageType = Pick<
  SchemaPackManifest['page_types'][number],
  'name' | 'primitive' | 'aliases' | 'materialized_backlinks'
>;

interface TimelinePack {
  page_types: ReadonlyArray<TimelinePageType>;
}

interface TimelineSourcePolicy {
  pack: TimelinePack | null;
  types: Map<string, TimelineTypePolicy>;
}

interface TimelineTypePolicy {
  materializeBacklinks: boolean;
  propagate: boolean;
}

export interface ExtractTimelineFromMeetingsOpts {
  dryRun?: boolean;
  sourceIdFilter?: string;
  /** Optional slug-prefix filter on meeting/event source pages. */
  prefixFilter?: string;
  /** Optional exact page-type filters on meeting/event source pages. */
  typeFilters?: string[];
  /** Only scan meetings with updated_at after this ISO date. */
  since?: string;
  /** Optional pre-built gazetteer (for shared-walk callers). */
  gazetteer?: Gazetteer;
  /** Optional pre-loaded active pack (avoids a second config resolution). */
  activePack?: TimelinePack | null;
  /** Persist pack-authorized reciprocal Markdown lines. Defaults to true. */
  materializeBacklinks?: boolean;
  onProgress?: (done: number, total: number, created: number) => void;
}

export interface ExtractTimelineFromMeetingsResult {
  meetings_scanned: number;
  /** Meeting source pages skipped by a source-scoped propagation policy. */
  meetings_skipped_by_policy: number;
  entries_created: number;
  /** Distinct entity pages that received at least one new timeline entry. */
  entities_touched: number;
  /**
   * #2057: batches that failed to insert. Previously swallowed by a bare
   * `catch {}`, which let a brain-wide timeline-write failure read as a clean
   * "0 entries" run. Non-zero here means inserts are failing — surfaced on
   * stderr too.
   */
  batch_errors: number;
  /** First batch-insert error message, when batch_errors > 0. */
  first_batch_error?: string;
  /** Missing Markdown backlink lines persisted through trusted put_page. */
  materialized_backlinks_written: number;
  /** Entity-page read/put failures while materializing backlinks. */
  materialized_backlink_errors: number;
}

interface EventRow {
  slug: string;
  source_id: string;
  type: string;
  title: string;
  effective_date: string | Date | null;
  updated_at: string | Date;
  compiled_truth: string;
  timeline: string;
}

interface AttendedEdgeRow {
  from_slug: string;
  from_source_id: string;
  to_slug: string;
  to_source_id: string;
}

const BATCH_SIZE = 200;
const MEETING_PROPAGATION_CONFIG_KEY = 'extract.timeline_from_meetings.enabled';

interface BacklinkTarget {
  slug: string;
  source_id: string;
  lines: Map<string, string>;
}

async function resolveTimelinePack(
  engine: BrainEngine,
  sourceId?: string,
): Promise<TimelinePack | null> {
  try {
    const [dbConfig, perSourceConfig] = await Promise.all([
      engine.getConfig('schema_pack'),
      sourceId ? engine.getConfig(`schema_pack.source.${sourceId}`) : Promise.resolve(null),
    ]);
    const pack = await loadActivePack({
      cfg: loadConfig(),
      remote: false,
      sourceId,
      dbConfig: dbConfig ?? undefined,
      perSourceDb: sourceId && perSourceConfig
        ? new Map([[sourceId, perSourceConfig]])
        : undefined,
    });
    return pack.manifest;
  } catch {
    return null;
  }
}

async function resolveMeetingPropagation(
  engine: BrainEngine,
  sourceId: string,
): Promise<boolean> {
  const [global, sourceOverride] = await Promise.all([
    engine.getConfig(MEETING_PROPAGATION_CONFIG_KEY),
    engine.getConfig(`${MEETING_PROPAGATION_CONFIG_KEY}.source.${sourceId}`),
  ]);
  const configured = sourceOverride ?? global;
  return !['false', '0', 'off', 'no'].includes(configured?.trim().toLowerCase() ?? '');
}

function timelineTypePolicy(
  pack: TimelinePack | null,
  meetingPropagationEnabled: boolean,
): Map<string, TimelineTypePolicy> {
  if (!pack) {
    return new Map([
      ['meeting', { materializeBacklinks: false, propagate: meetingPropagationEnabled }],
      ['event', { materializeBacklinks: false, propagate: true }],
    ]);
  }
  const policy = new Map<string, TimelineTypePolicy>();
  for (const pageType of pack.page_types) {
    if (pageType.name !== 'meeting' && pageType.name !== 'event'
      && !pageType.aliases.includes('meeting') && !pageType.aliases.includes('event')
      && pageType.materialized_backlinks !== true) continue;
    const isMeeting = pageType.name === 'meeting' || pageType.aliases.includes('meeting');
    const typePolicy = {
      materializeBacklinks: pageType.materialized_backlinks === true,
      propagate: !isMeeting || meetingPropagationEnabled,
    };
    policy.set(pageType.name, typePolicy);
    for (const alias of pageType.aliases) {
      policy.set(alias, typePolicy);
    }
  }
  return policy;
}

/**
 * Build a source-qualified SQL predicate from the active timeline types for
 * each source. Parameters are returned in placeholder order.
 */
function timelinePolicyPredicate(
  policies: ReadonlyMap<string, TimelineSourcePolicy>,
  qualifier = '',
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  for (const [sourceId, policy] of policies) {
    const types = [...policy.types.keys()];
    if (types.length === 0) continue;
    const sourcePlaceholder = `$${params.push(sourceId)}`;
    const typePlaceholders = types.map(type => `$${params.push(type)}`).join(', ');
    clauses.push(
      `(${qualifier}source_id = ${sourcePlaceholder} AND ` +
      `${qualifier}type IN (${typePlaceholders}))`,
    );
  }
  return { sql: clauses.join(' OR '), params };
}

function backlinkLine(event: EventRow): string {
  const title = event.title.replace(/[|\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const date = event.effective_date instanceof Date
    ? event.effective_date.toISOString().slice(0, 10)
    : event.effective_date!.slice(0, 10);
  return `- ${date} — [[${event.slug}|${title}]]`;
}

async function materializeBacklinks(
  engine: BrainEngine,
  targets: Map<string, BacklinkTarget>,
  dryRun: boolean,
): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors = 0;
  const { operationsByName } = await import('./operations.ts');
  const putPage = operationsByName.put_page;
  if (!putPage) return { written: 0, errors: targets.size };

  for (const target of targets.values()) {
    try {
      const page = await engine.getPage(target.slug, { sourceId: target.source_id });
      if (!page) continue;
      const missing = [...target.lines.entries()]
        .filter(([eventSlug]) => !page.timeline.includes(`[[${eventSlug}|`))
        .map(([, line]) => line);
      if (missing.length === 0) continue;
      if (dryRun) {
        written += missing.length;
        continue;
      }

      const timeline = page.timeline.trim()
        ? `${page.timeline.trimEnd()}\n${missing.join('\n')}`
        : `## Timeline\n\n${missing.join('\n')}`;
      const tags = await engine.getTags(target.slug, { sourceId: target.source_id });
      const content = serializeMarkdown(page.frontmatter, page.compiled_truth, timeline, {
        type: page.type,
        title: page.title,
        tags,
      });
      const result = await putPage.handler({
        engine,
        config: { engine: engine.kind },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: false,
        sourceId: target.source_id,
      }, {
        slug: target.slug,
        content,
        source_kind: 'extract-timeline',
        ingested_via: 'extract-timeline',
      });
      if ((result as { status?: string }).status !== 'created_or_updated') {
        throw new Error(`put_page returned status ${(result as { status?: string }).status ?? 'unknown'}`);
      }
      written += missing.length;
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[extract timeline] materialized backlink failed for ${target.slug}: ${message}`);
    }
  }
  return { written, errors };
}

export async function extractTimelineFromMeetings(
  engine: BrainEngine,
  opts: ExtractTimelineFromMeetingsOpts = {},
): Promise<ExtractTimelineFromMeetingsResult> {
  const dryRun = opts.dryRun ?? false;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
  const allRefs = await engine.listAllPageRefs();
  const sourceIds = opts.sourceIdFilter
    ? [opts.sourceIdFilter]
    : [...new Set(allRefs.map(ref => ref.source_id))];
  const policyEntries = await Promise.all(sourceIds.map(async sourceId => {
    const [pack, meetingPropagationEnabled] = await Promise.all([
      opts.activePack === undefined
        ? resolveTimelinePack(engine, sourceId)
        : Promise.resolve(opts.activePack),
      resolveMeetingPropagation(engine, sourceId),
    ]);
    return [sourceId, {
      pack,
      types: timelineTypePolicy(pack, meetingPropagationEnabled),
    }] as const;
  }));
  const policies = new Map<string, TimelineSourcePolicy>(policyEntries);
  const eventPredicate = timelinePolicyPredicate(policies);
  if (!eventPredicate.sql) {
    return {
      meetings_scanned: 0,
      meetings_skipped_by_policy: 0,
      entries_created: 0,
      entities_touched: 0,
      batch_errors: 0,
      materialized_backlinks_written: 0,
      materialized_backlink_errors: 0,
    };
  }

  // 1. Fetch all pack-selected meeting/event pages (one round-trip).
  let meetings = await engine.executeRaw<EventRow>(
    `SELECT slug, source_id, type, title, effective_date, updated_at,
            compiled_truth, COALESCE(timeline, '') AS timeline
       FROM pages
      WHERE (${eventPredicate.sql})
        AND deleted_at IS NULL
      ORDER BY effective_date DESC NULLS LAST, slug`,
    eventPredicate.params,
  );
  if (opts.sourceIdFilter) {
    meetings = meetings.filter(meeting => meeting.source_id === opts.sourceIdFilter);
  }
  if (opts.prefixFilter) {
    meetings = meetings.filter(meeting => meeting.slug.startsWith(opts.prefixFilter!));
  }
  if (opts.typeFilters && opts.typeFilters.length > 0) {
    const allowedTypes = new Set(opts.typeFilters);
    meetings = meetings.filter(meeting => allowedTypes.has(meeting.type));
  }

  if (meetings.length === 0) {
    return {
      meetings_scanned: 0,
      meetings_skipped_by_policy: 0,
      entries_created: 0,
      entities_touched: 0,
      batch_errors: 0,
      materialized_backlinks_written: 0,
      materialized_backlink_errors: 0,
    };
  }

  // 2. Fetch all 'attended' edges (one round-trip, scoped to the loaded
  // meeting source_ids). Build a Map<meetingSlug → attendees[]> for O(1)
  // attendee lookup per meeting.
  const meetingKeys = new Set(meetings.map((m) => `${m.source_id}::${m.slug}`));
  const attendedPredicate = timelinePolicyPredicate(policies, 'pf.');
  const attendedEdges = await engine.executeRaw<AttendedEdgeRow>(
    `SELECT pf.slug AS from_slug, pf.source_id AS from_source_id,
            pt.slug AS to_slug, pt.source_id AS to_source_id
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
      JOIN pages pt ON pt.id = l.to_page_id
      WHERE l.link_type = 'attended'
        AND (${attendedPredicate.sql})
        AND pf.deleted_at IS NULL
        AND pt.deleted_at IS NULL`,
    attendedPredicate.params,
  );
  const attendeesByMeeting = new Map<string, AttendedEdgeRow[]>();
  for (const e of attendedEdges) {
    const key = `${e.from_source_id}::${e.from_slug}`;
    if (!meetingKeys.has(key)) continue;
    const list = attendeesByMeeting.get(key);
    if (list) list.push(e);
    else attendeesByMeeting.set(key, [e]);
  }

  // 3. For each meeting, derive entity mentions (gazetteer-based) + merge
  // with attendee edges. Each (meeting, entity) produces ONE timeline row.
  const gazetteers = new Map<string, Gazetteer>();
  await Promise.all([...policies.entries()].map(async ([sourceId, policy]) => {
    const gazetteer = opts.gazetteer ?? await buildGazetteer(engine, {
      sourceId,
      activePack: policy.pack,
    });
    gazetteers.set(sourceId, gazetteer);
  }));

  const batch: TimelineBatchInput[] = [];
  let entriesCreated = 0;
  const entitiesTouched = new Set<string>();
  let meetingsScanned = 0;
  let meetingsSkippedByPolicy = 0;
  let batchErrors = 0;
  let firstBatchError: string | undefined;
  const materializedTargets = new Map<string, BacklinkTarget>();

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
      try {
        entriesCreated += await engine.addTimelineEntriesBatch(batch);
      } catch (e) {
        // #2057: do NOT swallow. A bare `catch {}` here hid a brain-wide
        // timeline-write failure (the run reported 0 entries with no error).
        // Count + surface it on stderr; the per-meeting loop still continues so
        // one bad batch isn't fatal to the rest.
        batchErrors += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (!firstBatchError) firstBatchError = msg;
        console.error(`[extract timeline] batch insert failed (${batch.length} row(s)): ${msg}`);
      }
    } else {
      entriesCreated += batch.length;
    }
    batch.length = 0;
  }

  for (const meeting of meetings) {
    if (sinceMs !== null) {
      const updatedMs = new Date(meeting.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) continue;
    }
    if (!meeting.effective_date) continue; // can't write a timeline entry without a date

    if (policies.get(meeting.source_id)?.types.get(meeting.type)?.propagate === false) {
      meetingsSkippedByPolicy++;
      continue;
    }

    meetingsScanned++;
    opts.onProgress?.(meetingsScanned, meetings.length, entriesCreated);

    const meetingKey = `${meeting.source_id}::${meeting.slug}`;
    const summary = `Discussed in ${meeting.title}`;
    const sourceKey = `extract-timeline-from-meetings:${meeting.slug}`;

    // Attendees (from 'attended' links).
    const attendees = attendeesByMeeting.get(meetingKey) ?? [];
    const targets = new Map<string, { slug: string; source_id: string }>();
    for (const e of attendees) {
      targets.set(`${e.to_source_id}::${e.to_slug}`, {
        slug: e.to_slug,
        source_id: e.to_source_id,
      });
    }

    // Body mentions (gazetteer-based). Skip self-mention (meeting page
    // referencing itself by title). The cross-source guard in
    // findMentionedEntities already drops mentions targeting a different
    // source than the gazetteer entry was built from.
    const body = meeting.compiled_truth + '\n\n' + meeting.timeline;
    if (body.trim()) {
      const gazetteer = gazetteers.get(meeting.source_id) ?? new Map();
      const mentions = findMentionedEntities(body, gazetteer, {
        fromSlug: meeting.slug,
        fromSourceId: meeting.source_id,
      });
      for (const m of mentions) {
        targets.set(`${m.source_id}::${m.slug}`, {
          slug: m.slug,
          source_id: m.source_id,
        });
      }
    }

    // Emit one timeline row per (entity, this meeting).
    for (const t of targets.values()) {
      batch.push({
        slug: t.slug,
        source_id: t.source_id,
        date: meeting.effective_date instanceof Date
          ? meeting.effective_date.toISOString().slice(0, 10)
          : meeting.effective_date,
        source: sourceKey,
        summary,
      });
      entitiesTouched.add(`${t.source_id}::${t.slug}`);
      if (policies.get(meeting.source_id)?.types.get(meeting.type)?.materializeBacklinks === true
        && t.source_id === meeting.source_id) {
        // put_page reconciles links within its target source. Cross-source
        // attendees still receive the canonical DB timeline row, but their
        // Markdown materialization is skipped rather than failing extraction.
        const targetKey = `${t.source_id}::${t.slug}`;
        let materialized = materializedTargets.get(targetKey);
        if (!materialized) {
          materialized = { ...t, lines: new Map() };
          materializedTargets.set(targetKey, materialized);
        }
        materialized.lines.set(meeting.slug, backlinkLine(meeting));
      }
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  const materialized = opts.materializeBacklinks === false
    ? { written: 0, errors: 0 }
    : await materializeBacklinks(engine, materializedTargets, dryRun);
  return {
    meetings_scanned: meetingsScanned,
    meetings_skipped_by_policy: meetingsSkippedByPolicy,
    entries_created: entriesCreated,
    entities_touched: entitiesTouched.size,
    batch_errors: batchErrors,
    first_batch_error: firstBatchError,
    materialized_backlinks_written: materialized.written,
    materialized_backlink_errors: materialized.errors,
  };
}
