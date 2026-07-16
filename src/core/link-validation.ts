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
  opts: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<LinkValidationFinding[]> {
  const content = `${page.compiled_truth}\n${page.timeline}`;
  const refs = extractEntityRefs(content);
  const findings: LinkValidationFinding[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const key = `${ref.sourceId ?? ''}\u0000${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (ref.needsResolution) {
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

    const allowedSources = opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : []);
    if (ref.sourceId && allowedSources.length > 0 && !allowedSources.includes(ref.sourceId)) {
      findings.push({ source_slug: page.slug, target: ref.slug, status: 'blocked', source_id: page.source_id });
      continue;
    }
    const targetOpts = ref.sourceId ? { sourceId: ref.sourceId } : opts;
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
      : { source_slug: page.slug, target: ref.slug, status: 'missing', source_id: page.source_id });
  }
  return findings;
}

export async function validateLinks(
  engine: BrainEngine,
  pages: Page[],
  opts: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<LinkValidationReport> {
  const findings: LinkValidationFinding[] = [];
  for (const page of pages) findings.push(...await validatePageReferences(engine, page, opts));
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
