/**
 * back-link validator — every outbound link is reverse-navigable.
 *
 * The Iron Law: if page A mentions page B, B's backlink view must expose A.
 *
 * After v0.12.0 shipped auto-link + runAutoLink reconciliation, the graph
 * layer creates the forward edges automatically on put_page. This validator
 * catches the MINORITY case where:
 *   - A page has a link that runAutoLink didn't extract (unusual phrasing)
 *   - A bulk edit to timeline forgot to back-link the mentioned entity
 *   - A manual page edit added a brand-new wikilink between commits
 *
 * The graph row remains directed; getBacklinks supplies the inverse view. A
 * second target → source row or reciprocal Markdown entry is optional and is
 * reserved for a real semantic relationship or curated dossier history.
 */

import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

export const backLinkValidator: PageValidator = {
  id: 'back-link',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];

    const outbound = await ctx.engine.getLinks(ctx.slug);
    if (outbound.length === 0) return findings;

    // Iron Law: if ctx.slug → target, target's inverse view must expose ctx.slug.
    const uniqueTargets = new Set<string>();
    for (const link of outbound) uniqueTargets.add(link.to_slug);

    for (const target of uniqueTargets) {
      const targetBacklinks = await ctx.engine.getBacklinks(target);
      const hasReverse = targetBacklinks.some(l => l.from_slug === ctx.slug);
      if (!hasReverse) {
        findings.push({
          slug: ctx.slug,
          validator: 'back-link',
          severity: 'warning',
          message: `Outbound link to ${target} is absent from that page's backlink view. Re-extract links and inspect graph consistency.`,
        });
      }
    }

    return findings;
  },
};
