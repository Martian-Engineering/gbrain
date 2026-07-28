import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';
import {
  assertFreshSemanticRepairManifest,
  buildSemanticRepairManifest,
  buildSemanticRepairManifests,
  semanticFindingsFromBacklinks,
  type SemanticRepairFinding,
} from '../src/core/minions/semantic-repair-manifest.ts';

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    source_id: 'wiki',
    slug: 'notes/example',
    type: 'note',
    title: 'Example',
    compiled_truth: 'See [[people/alice]].',
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-28T00:00:00.000Z'),
    ...overrides,
  };
}

function engineWith(current: Page | null): BrainEngine {
  return {
    async getPage(slug: string, opts?: { sourceId?: string }) {
      if (!current || slug !== current.slug || opts?.sourceId !== current.source_id) return null;
      return current;
    },
  } as BrainEngine;
}

const refs = {
  resolver: { path: 'skills/RESOLVER.md', sha256: 'a'.repeat(64) },
  schema: { identity: 'default@1.0.0+12345678', sha256: 'b'.repeat(64) },
};

function missingFinding(): Extract<SemanticRepairFinding, { kind: 'link_reference' }> {
  return {
    kind: 'link_reference',
    source_id: 'wiki',
    page_slug: 'notes/example',
    status: 'missing',
    target: 'people/alice',
    evidence: {
      excerpt: 'See [[people/alice]].',
      diagnostic: 'target page does not exist',
    },
  };
}

describe('semantic repair manifests', () => {
  test('binds one repair to the source, page content, finding, resolver, and schema', async () => {
    const current = page();
    const manifest = await buildSemanticRepairManifest(
      engineWith(current),
      missingFinding(),
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
    );

    expect(manifest).toMatchObject({
      schema_version: '1',
      source_id: 'wiki',
      page_slug: 'notes/example',
      disposition: 'repair',
      allowed_actions: [{
        kind: 'replace_reference',
        source_id: 'wiki',
        page_slug: 'notes/example',
      }],
      required_verification: [
        'source_scope',
        'page_hash_changed',
        'reference_validation',
        'schema_validation',
      ],
    });
    expect(manifest.page_hash).toHaveLength(64);
    expect(manifest.finding_hash).toHaveLength(64);
    expect(manifest.manifest_hash).toHaveLength(64);
    await expect(assertFreshSemanticRepairManifest(engineWith(current), manifest)).resolves.toEqual(current);
  });

  test('turns ambiguity into a proposal instead of authorizing a page write', async () => {
    const finding: SemanticRepairFinding = {
      ...missingFinding(),
      status: 'ambiguous',
      candidates: ['people/alice-a', 'people/alice-b'],
    };

    const manifest = await buildSemanticRepairManifest(
      engineWith(page()),
      finding,
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
    );

    expect(manifest.disposition).toBe('proposal');
    expect(manifest.allowed_actions).toEqual([{
      kind: 'create_proposal',
      source_id: 'wiki',
      page_slug: 'notes/example',
    }]);
  });

  test('rejects a stale page before any action is taken', async () => {
    const manifest = await buildSemanticRepairManifest(
      engineWith(page()),
      missingFinding(),
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
    );
    const edited = page({ compiled_truth: 'The page changed after diagnosis.' });

    await expect(
      assertFreshSemanticRepairManifest(engineWith(edited), manifest),
    ).rejects.toThrow('stale');
  });

  test('rejects cross-source findings and tampered action scope', async () => {
    await expect(buildSemanticRepairManifest(
      engineWith(page()),
      { ...missingFinding(), source_id: 'client-a' },
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
    )).rejects.toThrow('source');

    const manifest = await buildSemanticRepairManifest(
      engineWith(page()),
      missingFinding(),
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
    );
    const tampered = structuredClone(manifest);
    tampered.allowed_actions[0]!.source_id = 'client-a';

    await expect(
      assertFreshSemanticRepairManifest(engineWith(page()), tampered),
    ).rejects.toThrow();
  });

  test('converts graph audit output into a stable bounded manifest batch', async () => {
    const findings = semanticFindingsFromBacklinks({
      action: 'check',
      mode: 'graph',
      gaps_found: 2,
      fixed: 0,
      pages_affected: 1,
      dryRun: false,
      reference_validation: {
        pages_scanned: 1,
        references_scanned: 1,
        resolved: 0,
        missing: 0,
        ambiguous: 1,
        blocked: 0,
        findings: [{
          source_id: 'wiki',
          source_slug: 'notes/example',
          target: 'alice',
          status: 'ambiguous',
          candidates: ['people/alice-b', 'people/alice-a'],
        }],
      },
      graph_findings: [{
        source_id: 'wiki',
        source_slug: 'notes/example',
        target_slug: 'people/alice',
        kind: 'missing_graph_edge',
      }],
    });
    const manifests = await buildSemanticRepairManifests(
      engineWith(page()),
      [...findings, findings[0]!],
      { ...refs, issued_at: '2026-07-28T10:00:00.000Z' },
      { limit: 2 },
    );

    expect(manifests).toHaveLength(2);
    expect(manifests.every(manifest => manifest.source_id === 'wiki')).toBe(true);
    expect(manifests.every(manifest => manifest.disposition === 'proposal')).toBe(true);
    expect(manifests.map(manifest => manifest.manifest_id)).toEqual(
      [...manifests.map(manifest => manifest.manifest_id)].sort(),
    );
  });
});
