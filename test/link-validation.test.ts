import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import { validateLinks, validatePageReferences } from '../src/core/link-validation.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

function page(slug: string, body: string): Page {
  return {
    id: 1,
    slug,
    type: 'meeting',
    title: slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    source_id: 'martian',
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function engine(existing: string[], fuzzy: Record<string, string[]> = {}): BrainEngine {
  const pages = new Set(existing);
  return {
    getPage: async (slug: string, opts?: { sourceId?: string; sourceIds?: string[] }) =>
      pages.has(slug) && (!opts?.sourceId || opts.sourceId === 'martian') ? page(slug, '') : null,
    resolveSlugs: async (slug: string) => fuzzy[slug] ?? [],
    resolveSlugWithAlias: async (slug: string) => slug,
    listAllPageRefs: async () => [...pages].map(slug => ({ slug, source_id: 'martian' })),
  } as unknown as BrainEngine;
}

describe('link validation', () => {
  test('reports explicit missing references that graph extraction drops', async () => {
    const findings = await validatePageReferences(
      engine(['companies/lucky-strike']),
      page('meetings/x', '[[companies/lucky-strike]] and [[companies/elvy]]'),
      { sourceId: 'martian' },
    );
    expect(findings.map(f => [f.target, f.status])).toEqual([
      ['companies/lucky-strike', 'resolved'],
      ['companies/elvy', 'missing'],
    ]);
  });

  test('reports ambiguous bare wikilinks', async () => {
    const findings = await validatePageReferences(
      engine([], { openclaw: ['projects/openclaw', 'companies/openclaw-foundation'] }),
      page('meetings/x', 'Discussed [[openclaw]].'),
      { sourceId: 'martian' },
    );
    expect(findings[0]).toMatchObject({ target: 'openclaw', status: 'ambiguous' });
    expect(findings[0].candidates).toHaveLength(2);
  });

  test('resolves mixed-case full-path generic wikilinks exactly before fuzzy lookup', async () => {
    const findings = await validatePageReferences(
      engine(['partners/josh/sources/granola/not-abc-artifact'], {
        'partners/josh/sources/granola/not-AbC-artifact': ['wrong/a', 'wrong/b'],
      }),
      page('meetings/x', '[[partners/josh/sources/granola/not-AbC-artifact]]'),
      { sourceId: 'martian' },
    );
    expect(findings[0]).toMatchObject({
      status: 'resolved',
      resolved_target: 'partners/josh/sources/granola/not-abc-artifact',
    });
  });

  test('resolves a qualified deep-path slug alias before reporting it missing', async () => {
    const e = engine(['partners/josh/sources/canonical-artifact']);
    e.resolveSlugWithAlias = async (slug, sources) => {
      expect(sources).toEqual(['martian']);
      return slug === 'partners/josh/sources/old-artifact'
        ? 'partners/josh/sources/canonical-artifact'
        : slug;
    };
    const findings = await validatePageReferences(
      e,
      page('meetings/x', '[[partners/josh/sources/old-artifact]]'),
      { sourceId: 'martian' },
    );
    expect(findings[0]).toMatchObject({
      status: 'resolved',
      resolved_target: 'partners/josh/sources/canonical-artifact',
    });
  });

  test('uses the page source to resolve aliases when validation is unscoped', async () => {
    const e = engine(['partners/josh/sources/canonical-artifact']);
    e.resolveSlugWithAlias = async (slug, sources) => {
      expect(sources).toEqual(['martian']);
      return slug === 'partners/josh/sources/old-artifact'
        ? 'partners/josh/sources/canonical-artifact'
        : slug;
    };
    const findings = await validatePageReferences(
      e,
      page('meetings/x', '[[partners/josh/sources/old-artifact]]'),
    );
    expect(findings[0]).toMatchObject({
      status: 'resolved',
      resolved_target: 'partners/josh/sources/canonical-artifact',
    });
  });

  test('summary excludes resolved references from findings', async () => {
    const report = await validateLinks(
      engine(['companies/acme']),
      [page('meetings/x', '[[companies/acme]] [[people/missing]]')],
      { sourceId: 'martian' },
    );
    expect(report).toMatchObject({ pages_scanned: 1, references_scanned: 2, resolved: 1, missing: 1, ambiguous: 0, blocked: 0 });
    expect(report.findings.map(f => f.target)).toEqual(['people/missing']);
  });

  test('does not probe a qualified source outside the caller scope', async () => {
    let reads = 0;
    const e = engine([]);
    e.getPage = async () => { reads++; return null; };
    const findings = await validatePageReferences(
      e,
      page('meetings/x', '[[restricted:companies/secret]]'),
      { sourceId: 'martian' },
    );
    expect(findings[0].status).toBe('blocked');
    expect(reads).toBe(0);
  });

  test('reports an exact target that exists only outside caller scope as blocked', async () => {
    const e = engine([]);
    e.listAllPageRefs = async () => [{
      slug: 'partners/josh/meetings/restricted-record',
      source_id: 'martian-restricted',
    }];
    const findings = await validatePageReferences(
      e,
      page('people/alice', '[[partners/josh/meetings/restricted-record]]'),
      { sourceId: 'martian' },
    );
    expect(findings[0]).toMatchObject({
      target: 'partners/josh/meetings/restricted-record',
      status: 'blocked',
    });
    expect(findings[0].target_source_id).toBeUndefined();
  });

  test('validate_links operation paginates the whole source', async () => {
    const e = engine([]);
    const pages = Array.from({ length: 205 }, (_, i) => page(`meetings/${i.toString().padStart(3, '0')}`, ''));
    e.listPages = async (filters) => pages.slice(filters?.offset ?? 0, (filters?.offset ?? 0) + (filters?.limit ?? 100));
    const result = await operationsByName.validate_links.handler({
      engine: e,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'martian',
    } as unknown as OperationContext, {});
    expect(result).toMatchObject({ pages_scanned: 205 });
  });
});
