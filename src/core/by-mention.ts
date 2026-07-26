/**
 * v0.42.0.0 Part B — Auto-link entity mentions to known entity pages.
 * Migration #1 of the consolidated #1409 design doc (orphan reduction).
 *
 * `buildGazetteer` queries the brain for entity-typed pages and produces a
 * token-Map lookup structure suitable for fast body-text scanning.
 *
 * `findMentionedEntities` is a pure function that scans body text against
 * the gazetteer, applies the maximal-munch matcher (longest gazetteer
 * entry wins at each offset), self-link guard, cross-source guard, and
 * per-page first-mention-only cap (1 link per (source_slug, target_slug)).
 *
 * Design decisions locked in /plan-eng-review for v0.42.0.0:
 *  - D2/D10  Entity-type filter follows the active schema pack's entity
 *            primitives, with the legacy list as the no-pack fallback.
 *  - D6      Token-Map + multi-word phrase pass (no new deps, no regex
 *            alternation, no Aho-Corasick).
 *  - D7      DB-source only — caller restricts page WALK to DB iteration.
 *  - D12     `link_source='mentions'` writes filtered out of backlink-count
 *            for search ranking (see postgres-engine.ts/pglite-engine.ts).
 *  - D13     Self-link guard.
 *  - CK12    Ignore-list applied at gazetteer-build time, NOT match time.
 *            Built-in ambiguous tokens (Apple, Amazon, Square, Stripe, Box)
 *            are dropped from the gazetteer ONLY when no corresponding
 *            entity page exists. If a page DOES exist, the user explicitly
 *            created it and we trust the gazetteer presence.
 */

import type { BrainEngine } from './engine.ts';
import { loadConfig } from './config.ts';
import { stripCodeBlocks } from './link-extraction.ts';
import { loadActivePack } from './schema-pack/load-active.ts';
import type { SchemaPackManifest } from './schema-pack/manifest-v1.ts';

/** Legacy entity types used only when no active schema pack can be loaded. */
export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity'] as const;

/**
 * Minimum title length for gazetteer inclusion. Filters out 2-3 char names
 * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
 * Codex CK13 noted v1 will under-deliver on 3-char real entities; the
 * pack-aware follow-up (TODO-1) can let users opt specific 3-char entity
 * types in.
 */
const MIN_NAME_LENGTH = 4;

/**
 * Built-in ignore list — common ambiguous tokens whose body-text mentions
 * are usually NOT references to the named brand/entity. Suppressed at
 * gazetteer-build time when no corresponding entity page exists.
 *
 * Per CK12 (codex outside-voice): if the user has explicitly created
 * `companies/apple` as a page, they want auto-link → ignore-list does
 * not override gazetteer presence. The list only suppresses entries
 * that would NOT otherwise be in the gazetteer.
 */
const DEFAULT_IGNORE_LIST = ['Apple', 'Amazon', 'Square', 'Stripe', 'Box', 'Meta', 'Target', 'Oracle'];

export interface GazetteerEntry {
  /** Canonical page slug (e.g. `companies/acme-corp`). */
  slug: string;
  /** Source id (multi-source brains). 'default' for single-source. */
  source_id: string;
  /** Original title (preserved for the mention payload). */
  title: string;
  /** Lowercase title tokens in order. Length 1 = single-word entity. */
  tokens: string[];
}

/**
 * Gazetteer is keyed by lowercase FIRST token. Multiple entries can
 * share a first token (e.g. "Acme" + "Acme Corp" + "Acme Foundation").
 * At match time, the scanner picks the entry with the most tokens that
 * matches the body-text token sequence at the current offset (maximal
 * munch).
 */
export type Gazetteer = Map<string, GazetteerEntry[]>;

export interface Mention {
  /** Target page slug (the entity being mentioned). */
  slug: string;
  /** Target source id (cross-source guard). */
  source_id: string;
  /** Display name (original title). */
  name: string;
  /** Character offset in the ORIGINAL (un-stripped) body where the mention starts. */
  offset: number;
}

export interface BuildGazetteerOpts {
  /**
   * Optional user-supplied additional ignore-list entries (case-sensitive
   * raw title match). Merged with DEFAULT_IGNORE_LIST.
   */
  extraIgnore?: string[];
  /** Restrict pages and active-pack resolution to one source. */
  sourceId?: string;
  /**
   * Preloaded active pack manifest. Omit to resolve the active pack from
   * config; pass null to use the legacy no-pack fallback.
   */
  activePack?: EntityPack | null;
}

type EntityPageType = Pick<
  SchemaPackManifest['page_types'][number],
  'name' | 'primitive'
> & Partial<Omit<
  SchemaPackManifest['page_types'][number],
  'name' | 'primitive'
>>;

interface EntityPack {
  name?: string;
  page_types: ReadonlyArray<EntityPageType>;
}

export interface FindMentionsOpts {
  /** Source slug of the page being scanned. Used for self-link guard. */
  fromSlug: string;
  /** Source id of the page being scanned. Used for cross-source guard. */
  fromSourceId: string;
}

// ============================================================
// Gazetteer construction
// ============================================================

/**
 * Token-only tokenizer. Returns `[token, offset]` pairs for every
 * `[a-zA-Z0-9]+` run, lowercased. Non-ASCII (CJK, accented) is
 * deliberately not tokenized in v1 — entity gazetteer is English-dominant
 * in production today. Widening to `\p{L}+` is a future option once a
 * real CJK entity catalog appears (filed under TODO-1 + a TODO for
 * Unicode-aware tokenization).
 *
 * Possessive "Acme's" tokenizes as ['acme', 's'] (single-quote breaks the
 * run) — single-word "Acme" lookup succeeds at offset 0; the trailing 's'
 * is harmless noise.
 */
const TOKEN_RE = /[a-zA-Z0-9]+/g;

interface ScannedToken {
  text: string;       // lowercase
  offset: number;     // index in source
  length: number;     // original length (for span tracking)
}

function tokenizeForScan(text: string): ScannedToken[] {
  const out: ScannedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({ text: m[0].toLowerCase(), offset: m.index, length: m[0].length });
  }
  return out;
}

function tokenizeTitle(title: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(title)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

function aliasDisplayName(aliasSlug: string): string {
  const tail = aliasSlug.split('/').pop() ?? aliasSlug;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function frontmatterTitle(frontmatter: unknown): string | null {
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return null;
  const value = (frontmatter as Record<string, unknown>).title;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

async function resolveActivePack(
  engine: BrainEngine,
  sourceId?: string,
): Promise<EntityPack | null> {
  try {
    const [dbConfig, perSourceConfig] = await Promise.all([
      engine.getConfig('schema_pack'),
      sourceId
        ? engine.getConfig(`schema_pack.source.${sourceId}`)
        : Promise.resolve(null),
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

function entityTypesFromPack(
  pack: EntityPack | null,
): readonly string[] {
  if (!pack) return LINKABLE_ENTITY_TYPES;
  const declaredTypes = pack.page_types
    .filter(pageType => pageType.primitive === 'entity')
    .flatMap(pageType => [pageType.name, ...(pageType.aliases ?? [])]);
  return pack.name === 'gbrain-base'
    ? [...new Set([...declaredTypes, ...LINKABLE_ENTITY_TYPES])]
    : declaredTypes;
}

/**
 * Build a token-Map gazetteer from all entity-typed pages in the brain.
 *
 * Entity types come from the active schema pack's `primitive: entity`
 * declarations, falling back to LINKABLE_ENTITY_TYPES when no pack loads.
 * Soft-deleted pages are excluded. Canonical titles, retained frontmatter
 * titles, and slug-alias display forms all resolve to the canonical page.
 *
 * Returned gazetteer is keyed by lowercase first token; entries with the
 * same first token co-exist in the same bucket (e.g. "Acme" + "Acme Corp").
 */
export async function buildGazetteer(
  engine: BrainEngine,
  opts: BuildGazetteerOpts = {},
): Promise<Gazetteer> {
  const activePack = opts.activePack === undefined
    ? await resolveActivePack(engine, opts.sourceId)
    : opts.activePack;
  const entityTypes = entityTypesFromPack(activePack);
  if (entityTypes.length === 0) return new Map();

  const typePlaceholders = entityTypes.map((_, index) => `$${index + 1}`).join(', ');
  const sourcePredicate = opts.sourceId
    ? `AND source_id = $${entityTypes.length + 1}`
    : '';
  const queryParams = opts.sourceId
    ? [...entityTypes, opts.sourceId]
    : [...entityTypes];
  const rows = await engine.executeRaw<{
    slug: string;
    source_id: string | null;
    title: string | null;
    frontmatter: unknown;
  }>(
    `SELECT slug, source_id, title, frontmatter
     FROM pages
     WHERE type IN (${typePlaceholders})
       ${sourcePredicate}
       AND deleted_at IS NULL`,
    queryParams,
  );

  let aliases: Array<{
    source_id: string;
    alias_slug: string;
    canonical_slug: string;
  }> = [];
  try {
    aliases = await engine.executeRaw(
      `SELECT sa.source_id, sa.alias_slug, sa.canonical_slug
         FROM slug_aliases sa
         JOIN pages p
           ON p.source_id = sa.source_id
          AND p.slug = sa.canonical_slug
        WHERE p.type IN (${typePlaceholders})
          ${opts.sourceId ? `AND sa.source_id = $${entityTypes.length + 1}` : ''}
          AND p.deleted_at IS NULL`,
      queryParams,
    );
  } catch {
    // Pre-v105 brains do not have slug_aliases; canonical titles still work.
  }

  const candidates: Array<{ slug: string; source_id: string; title: string }> = [];
  for (const r of rows) {
    if (r.title) candidates.push({
      slug: r.slug,
      source_id: r.source_id ?? 'default',
      title: r.title,
    });
    const alternateTitle = frontmatterTitle(r.frontmatter);
    if (alternateTitle && alternateTitle !== r.title) candidates.push({
      slug: r.slug,
      source_id: r.source_id ?? 'default',
      title: alternateTitle,
    });
  }
  for (const alias of aliases) {
    candidates.push({
      slug: alias.canonical_slug,
      source_id: alias.source_id,
      title: aliasDisplayName(alias.alias_slug),
    });
  }

  // A canonical title, retained frontmatter title, or slug alias is an
  // explicit operator-created entity name, preserving CK12's rule that
  // explicit gazetteer entries win over the built-in ambiguity list.
  const existingTitles = new Set(candidates.map(candidate => candidate.title));
  const ignoreSet = new Set<string>([...DEFAULT_IGNORE_LIST, ...(opts.extraIgnore ?? [])]);

  const gazetteer: Gazetteer = new Map();
  const seenEntries = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.title.length < MIN_NAME_LENGTH) continue;
    if (ignoreSet.has(candidate.title) && !existingTitles.has(candidate.title)) continue;

    const tokens = tokenizeTitle(candidate.title);
    if (tokens.length === 0) continue;
    if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) continue;

    const identity = `${candidate.source_id}\0${candidate.slug}\0${candidate.title}`;
    if (seenEntries.has(identity)) continue;
    seenEntries.add(identity);
    const entry: GazetteerEntry = {
      slug: candidate.slug,
      source_id: candidate.source_id,
      title: candidate.title,
      tokens,
    };
    const key = tokens[0]!;
    const bucket = gazetteer.get(key);
    if (bucket) bucket.push(entry);
    else gazetteer.set(key, [entry]);
  }

  // Sort each bucket by token-count DESC so maximal-munch walks longest-first.
  for (const bucket of gazetteer.values()) {
    bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  }
  return gazetteer;
}

// ============================================================
// Body-text scanner (pure)
// ============================================================

/**
 * Scan body text for mentions of gazetteer entities. Pure function — no
 * IO. Returns `Mention[]` ordered by offset, deduped per
 * `(fromSlug → entry.slug)` pair (first-mention-only cap).
 *
 * Matcher is maximal-munch: at each token offset, the longest gazetteer
 * entry that matches the body-token sequence wins. Single-word entries
 * are length-1 maximal matches.
 *
 * Guards (deterministic):
 *  - D13 self-link: skip when `fromSlug === entry.slug`.
 *  - Cross-source: skip when `fromSourceId !== entry.source_id` (mention
 *    in source A of an entity in source B is suppressed; design doc
 *    treats this as deliberate isolation in v1, can relax in a follow-up).
 *  - First-mention-only cap: dedup by `entry.slug` (one link per
 *    target page regardless of how many body mentions there are).
 *
 * Code-block stripping via `stripCodeBlocks` (preserves offsets, so the
 * returned mention offsets index into the ORIGINAL text not the stripped
 * text — useful for downstream debugging tools).
 */
export function findMentionedEntities(
  text: string,
  gazetteer: Gazetteer,
  opts: FindMentionsOpts,
): Mention[] {
  if (!text || gazetteer.size === 0) return [];
  const stripped = stripCodeBlocks(text);
  const tokens = tokenizeForScan(stripped);
  if (tokens.length === 0) return [];

  const out: Mention[] = [];
  const seenSlugs = new Set<string>();
  let i = 0;

  while (i < tokens.length) {
    const head = tokens[i]!;
    const bucket = gazetteer.get(head.text);
    if (!bucket) {
      i++;
      continue;
    }

    // Maximal-munch: bucket is pre-sorted longest-first. Find the first
    // entry whose subsequent tokens all match the body sequence.
    let matched: GazetteerEntry | null = null;
    let matchedTokens = 0;
    for (const entry of bucket) {
      if (entry.tokens.length === 1) {
        matched = entry;
        matchedTokens = 1;
        break;
      }
      // Multi-word: validate subsequent tokens.
      if (i + entry.tokens.length > tokens.length) continue;
      let allMatch = true;
      for (let k = 1; k < entry.tokens.length; k++) {
        if (tokens[i + k]!.text !== entry.tokens[k]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matched = entry;
        matchedTokens = entry.tokens.length;
        break;
      }
    }

    if (!matched) {
      i++;
      continue;
    }

    // Guards.
    if (matched.slug === opts.fromSlug) {
      i += matchedTokens;
      continue;
    }
    if (matched.source_id !== opts.fromSourceId) {
      i += matchedTokens;
      continue;
    }
    if (seenSlugs.has(matched.slug)) {
      i += matchedTokens;
      continue;
    }

    out.push({
      slug: matched.slug,
      source_id: matched.source_id,
      name: matched.title,
      offset: head.offset,
    });
    seenSlugs.add(matched.slug);
    i += matchedTokens;
  }

  return out;
}
