import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import { extractEntityRefs } from './link-extraction.ts';

export type LinkValidationStatus = 'resolved' | 'missing' | 'ambiguous' | 'blocked';

export interface LinkValidationFinding {
  source_slug: string;
  target: string;
  status: LinkValidationStatus;
  source_id: string;
  target_source_id?: string;
  resolved_target?: string;
  candidates?: string[];
}

export interface LinkValidationReport {
  pages_scanned: number;
  references_scanned: number;
  resolved: number;
  missing: number;
  ambiguous: number;
  blocked: number;
  findings: LinkValidationFinding[];
}

interface LinkValidationOptions {
  sourceId?: string;
  sourceIds?: string[];
  /** Internal cache: existence-only rows used to classify inaccessible exact targets. */
  allPageRefs?: Array<{ slug: string; source_id: string }>;
}

/**
 * Validate explicit internal references without mutating graph state.
 *
 * This deliberately consumes extractEntityRefs, the same parser used by link
 * extraction. A reference rejected before graph insertion must remain visible
 * here instead of disappearing from doctor/check-backlinks-style audits.
 */
export async function validatePageReferences(
  engine: BrainEngine,
  page: Page,
  opts: LinkValidationOptions = {},
): Promise<LinkValidationFinding[]> {
  const content = `${page.compiled_truth}\n${page.timeline}`;
  const refs = extractEntityRefs(content);
  const findings: LinkValidationFinding[] = [];
  const seen = new Set<string>();
  const allowedSources = opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : [page.source_id]);
  const allPageRefs = opts.allPageRefs
    ?? ((opts.sourceId || opts.sourceIds) ? await engine.listAllPageRefs() : []);
  const existsOutsideScope = (slugs: string[]): boolean => {
    const candidates = new Set(slugs.map(slug => slug.toLowerCase()));
    return allPageRefs.some(ref =>
      !allowedSources.includes(ref.source_id) && candidates.has(ref.slug.toLowerCase()));
  };

  for (const ref of refs) {
    const key = `${ref.sourceId ?? ''}\u0000${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.needsResolution) {
      // Generic wikilinks include both true basenames (`[[openclaw]]`) and
      // full paths outside the extractor's entity-directory allow-list
      // (`[[partners/josh/sources/...]]`). Full paths are not fuzzy names:
      // prefer an exact, source-scoped lookup first. Slugs are canonicalized
      // to lowercase by import, while historical display paths may retain
      // mixed-case external IDs, so try the lowercase path as well.
      if (ref.slug.includes('/')) {
        if (ref.sourceId && allowedSources.length > 0 && !allowedSources.includes(ref.sourceId)) {
          findings.push({ source_slug: page.slug, target: ref.slug, status: 'blocked', source_id: page.source_id });
          continue;
        }
        const targetOpts = ref.sourceId
          ? { sourceId: ref.sourceId }
          : (opts.sourceId || opts.sourceIds ? opts : { sourceId: page.source_id });
        const resolutionSources = ref.sourceId ? [ref.sourceId] : allowedSources;
        const exactCandidates = [...new Set([ref.slug, ref.slug.toLowerCase()])];
        let exact: Page | null = null;
        let exactSlug = ref.slug;
        for (const candidate of exactCandidates) {
          const canonical = resolutionSources.length > 0
            ? await engine.resolveSlugWithAlias(candidate, resolutionSources)
            : candidate;
          exact = await engine.getPage(canonical, targetOpts);
          if (exact) { exactSlug = canonical; break; }
        }
        if (exact) {
          findings.push({
            source_slug: page.slug,
            target: ref.slug,
            status: 'resolved',
            source_id: page.source_id,
            target_source_id: exact.source_id,
            ...(exactSlug !== ref.slug ? { resolved_target: exactSlug } : {}),
          });
          continue;
        }
        if (existsOutsideScope(exactCandidates)) {
          findings.push({ source_slug: page.slug, target: ref.slug, status: 'blocked', source_id: page.source_id });
          continue;
        }
      }
      const candidates = await engine.resolveSlugs(ref.slug, opts);
      const unique = [...new Set(candidates)];
      if (unique.length === 1) {
        findings.push({
          source_slug: page.slug,
          target: ref.slug,
          status: 'resolved',
          source_id: page.source_id,
          candidates: unique,
        });
      } else if (unique.length > 1) {
        findings.push({
          source_slug: page.slug,
          target: ref.slug,
          status: 'ambiguous',
          source_id: page.source_id,
          candidates: unique,
        });
      } else {
        findings.push({ source_slug: page.slug, target: ref.slug, status: 'missing', source_id: page.source_id });
      }
      continue;
    }

    if (ref.sourceId && allowedSources.length > 0 && !allowedSources.includes(ref.sourceId)) {
      findings.push({ source_slug: page.slug, target: ref.slug, status: 'blocked', source_id: page.source_id });
      continue;
    }
    const targetOpts = ref.sourceId
      ? { sourceId: ref.sourceId }
      : (opts.sourceId || opts.sourceIds ? opts : { sourceId: page.source_id });
    const resolutionSources = ref.sourceId ? [ref.sourceId] : allowedSources;
    const canonical = resolutionSources.length > 0
      ? await engine.resolveSlugWithAlias(ref.slug, resolutionSources)
      : ref.slug;
    const target = await engine.getPage(canonical, targetOpts);
    findings.push(target
      ? {
          source_slug: page.slug,
          target: ref.slug,
          status: 'resolved',
          source_id: page.source_id,
          target_source_id: target.source_id,
          ...(canonical !== ref.slug ? { resolved_target: canonical } : {}),
        }
      : existsOutsideScope([ref.slug, canonical])
        ? { source_slug: page.slug, target: ref.slug, status: 'blocked', source_id: page.source_id }
        : { source_slug: page.slug, target: ref.slug, status: 'missing', source_id: page.source_id });
  }
  return findings;
}

export async function validateLinks(
  engine: BrainEngine,
  pages: Page[],
  opts: LinkValidationOptions = {},
): Promise<LinkValidationReport> {
  const allPageRefs = opts.allPageRefs
    ?? ((opts.sourceId || opts.sourceIds) ? await engine.listAllPageRefs() : []);
  const findings: LinkValidationFinding[] = [];
  for (const page of pages) findings.push(...await validatePageReferences(engine, page, { ...opts, allPageRefs }));
  return {
    pages_scanned: pages.length,
    references_scanned: findings.length,
    resolved: findings.filter(f => f.status === 'resolved').length,
    missing: findings.filter(f => f.status === 'missing').length,
    ambiguous: findings.filter(f => f.status === 'ambiguous').length,
    blocked: findings.filter(f => f.status === 'blocked').length,
    findings: findings.filter(f => f.status !== 'resolved'),
  };
}

/** Paginate and validate every page visible in the supplied source scope. */
export async function validateAllLinks(
  engine: BrainEngine,
  opts: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<LinkValidationReport> {
  const pages: Page[] = [];
  const batchSize = 100;
  for (let offset = 0; ; offset += batchSize) {
    const batch = await engine.listPages({ ...opts, sort: 'slug', limit: batchSize, offset });
    pages.push(...batch);
    if (batch.length < batchSize) break;
  }
  return validateLinks(engine, pages, opts);
}
