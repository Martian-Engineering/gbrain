// src/core/extract-ner.ts
// v0.41.18.0 (A10, T7). NER link extraction reuses the by-mention gazetteer
// and applies schema-pack `link_types[].inference.regex` patterns to assign
// a typed link verb ("CEO of Acme" → 'works_at' linking the page to Acme).
//
// Codex finding #12 design (locked): do NOT split link_source='ner' as a
// new provenance — that would break every existing link_source='mentions'
// query (backlink-count filter, orphan-ratio, doctor checks). Instead:
// keep link_source='mentions' AND set link_kind='typed_ner' on the new row
// (v98 added the column). Legacy plain mentions stay link_kind=NULL
// (semantically 'plain').
//
// The links UNIQUE constraint excludes link_kind, so an existing plain
// mention row + a typed_ner row for the same (from, to, type, source, origin)
// collide — DO NOTHING. NER does NOT overwrite plain mentions; the verb
// link goes in as a different row with a different link_type.

import type { BrainEngine } from './engine.ts';
import type { LinkBatchInput } from './engine.ts';
import { buildGazetteer, findMentionedEntities, type Gazetteer } from './by-mention.ts';
import { inferLinkTypeFromPack } from './schema-pack/link-inference.ts';
import { loadActivePackBestEffort } from './schema-pack/best-effort.ts';

export interface ExtractNerOpts {
  /** When true: enumerate but don't write. */
  dryRun?: boolean;
  /** Optional source-id filter on the WALK (gazetteer stays brain-wide). */
  sourceIdFilter?: string;
  /** Optional page-type filter on the WALK. */
  typeFilter?: string;
  /** Only scan pages with updated_at after this ISO date. */
  since?: string;
  /**
   * Pre-built gazetteer for a source-scoped walk. When omitted, this function
   * builds one gazetteer per source so schema-pack overrides stay isolated.
   */
  gazetteer?: Gazetteer;
  /** Optional progress hook called per processed page. */
  onProgress?: (done: number, total: number, created: number) => void;
}

export interface ExtractNerResult {
  /** Pages scanned. */
  pages: number;
  /** Typed-NER links created (or would-have-created in dry-run). */
  created: number;
  /** Pages where the active schema pack had no link_types at all. */
  pack_unavailable: boolean;
}

/** Context window scanned around each mention for verb-pattern matching. */
const CONTEXT_WINDOW_CHARS = 80;

/**
 * Pure helper: get the context window around a mention's character offset.
 * Returns the substring [offset - W, offset + name.length + W] of the body.
 * Caller passes (body, offset, name.length).
 */
export function getContextWindow(
  body: string,
  offset: number,
  nameLen: number,
  window: number = CONTEXT_WINDOW_CHARS,
): string {
  const start = Math.max(0, offset - window);
  const end = Math.min(body.length, offset + nameLen + window);
  return body.slice(start, end);
}

/**
 * Pure helper: derive the entity-type→link-verb pair from a single mention.
 * Returns null when (a) target type unknown, (b) pack has no inference for
 * that type, (c) no verb pattern matches the surrounding context.
 *
 * Exported for unit tests; the orchestrator below uses it directly.
 */
export function inferNerLinkType(
  pack: Parameters<typeof inferLinkTypeFromPack>[0],
  targetType: string | undefined,
  context: string,
): string | null {
  if (!targetType) return null;
  try {
    return inferLinkTypeFromPack(pack, targetType, context);
  } catch {
    return null;
  }
}

/**
 * extractNerLinks: walk pages, find body mentions, apply schema-pack
 * inference regex per (target_type, surrounding context) to assign a typed
 * link verb. Returns count of created links.
 *
 * Best-effort wrt the schema pack: if no active pack OR no link_types
 * declared OR no inference.regex on any link_type, the function returns
 * pack_unavailable=true and 0 created. Caller (CLI / handler) surfaces a
 * one-line hint instead of an error.
 */
export async function extractNerLinks(
  engine: BrainEngine,
  opts: ExtractNerOpts = {},
): Promise<ExtractNerResult> {
  const dryRun = opts.dryRun ?? false;
  const allRefs = opts.sourceIdFilter
    ? (await engine.listAllPageRefs()).filter((r) => r.source_id === opts.sourceIdFilter)
    : await engine.listAllPageRefs();
  const sourceIds = [...new Set(allRefs.map(ref => ref.source_id))];

  // Resolve inference policy per source. An unscoped federated walk may mix
  // sources whose packs define different entity types and link verbs.
  const manifests = new Map<string, Parameters<typeof inferNerLinkType>[0]>();
  await Promise.all(sourceIds.map(async sourceId => {
    const pack = await loadActivePackBestEffort({
      engine,
      remote: false,
      sourceId,
    } as never);
    const hasRegex = pack?.manifest.link_types.some(
      lt => lt.inference && typeof lt.inference === 'object' && 'regex' in lt.inference,
    );
    if (pack && hasRegex) manifests.set(sourceId, pack.manifest);
  }));
  if (manifests.size === 0) return { pages: 0, created: 0, pack_unavailable: true };

  const gazetteers = new Map<string, Gazetteer>();
  await Promise.all(sourceIds.map(async sourceId => {
    if (!manifests.has(sourceId)) return;
    const gazetteer = opts.gazetteer && sourceId === opts.sourceIdFilter
      ? opts.gazetteer
      : await buildGazetteer(engine, { sourceId });
    gazetteers.set(sourceId, gazetteer);
  }));
  if ([...gazetteers.values()].every(gazetteer => gazetteer.size === 0)) {
    return { pages: 0, created: 0, pack_unavailable: false };
  }

  // Pre-fetch target entity types so inferLinkType has the type signal
  // without an N+1 getPage round-trip. Pulls the slug→type map from
  // listAllPageRefs + a single listPages projection.
  const targetTypeMap = await buildTargetTypeMap(engine, opts.sourceIdFilter);

  let processed = 0;
  let created = 0;
  const batch: LinkBatchInput[] = [];
  const BATCH_SIZE = 500;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : null;

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
      try {
        created += await engine.addLinksBatch(batch); // gbrain-allow-direct-insert: extract-ner — typed NER link write
      } catch {
        // batch error: drop; the per-page progress continues
      }
    } else {
      created += batch.length;
    }
    batch.length = 0;
  }

  for (const { slug, source_id } of allRefs) {
    const manifest = manifests.get(source_id);
    const gazetteer = gazetteers.get(source_id);
    if (!manifest || !gazetteer) continue;
    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    if (sinceMs !== null) {
      const updatedMs = new Date(page.updated_at).getTime();
      if (Number.isFinite(updatedMs) && updatedMs <= sinceMs) continue;
    }
    processed++;
    opts.onProgress?.(processed, allRefs.length, created);

    const body = page.compiled_truth + '\n\n' + (page.timeline ?? '');
    if (!body.trim()) continue;

    const mentions = findMentionedEntities(body, gazetteer, {
      fromSlug: slug,
      fromSourceId: source_id,
    });
    if (mentions.length === 0) continue;

    for (const m of mentions) {
      const targetType = targetTypeMap.get(`${m.source_id}::${m.slug}`);
      const context = getContextWindow(body, m.offset, m.name.length);
      const verb = inferNerLinkType(manifest, targetType, context);
      if (!verb) continue;

      batch.push({
        from_slug: slug,
        to_slug: m.slug,
        link_type: verb,
        link_source: 'mentions',
        link_kind: 'typed_ner',
        context: m.name,
        from_source_id: source_id,
        to_source_id: m.source_id,
      });
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }

  await flush();
  return { pages: processed, created, pack_unavailable: false };
}

/**
 * Helper: build a Map<sourceId::slug → type> for all entity-typed pages.
 * One round-trip via listPages. Targets cached at extraction-start so
 * inferNerLinkType doesn't pay an N+1 cost per mention.
 */
async function buildTargetTypeMap(
  engine: BrainEngine,
  sourceId?: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const sourcePredicate = sourceId ? 'AND source_id = $1' : '';
    const result = await engine.executeRaw<{ slug: string; source_id: string; type: string }>(
      `SELECT slug, source_id, type FROM pages
         WHERE deleted_at IS NULL
           ${sourcePredicate}`,
      sourceId ? [sourceId] : [],
    );
    for (const row of result) {
      map.set(`${row.source_id}::${row.slug}`, row.type);
    }
  } catch {
    // Engine error → empty map; inferNerLinkType returns null for unknown types.
  }
  return map;
}
