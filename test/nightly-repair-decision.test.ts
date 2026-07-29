import { describe, expect, test } from 'bun:test';
import {
  AUTONOMOUS_REPAIR_CONFIDENCE,
  parseNightlyRepairDecision,
} from '../src/core/minions/nightly-repair-decision.ts';
import type { SemanticRepairManifest } from '../src/core/minions/semantic-repair-manifest.ts';

const manifest = {
  schema_version: '1',
  manifest_id: 'semantic-repair:wiki:notes/example:finding:page',
  issued_at: '2026-07-28T10:00:00.000Z',
  source_id: 'wiki',
  page_slug: 'notes/example',
  page_hash: 'a'.repeat(64),
  finding_hash: 'b'.repeat(64),
  finding: {
    kind: 'link_reference',
    source_id: 'wiki',
    page_slug: 'notes/example',
    status: 'missing',
    target: 'companies/lucky-strike-entertainment',
    evidence: { diagnostic: 'missing' },
  },
  resolver: { path: 'skills/RESOLVER.md', sha256: 'c'.repeat(64) },
  schema: { identity: 'default@1.0.0+12345678', sha256: 'd'.repeat(64) },
  disposition: 'repair',
  allowed_actions: [{ kind: 'replace_reference', source_id: 'wiki', page_slug: 'notes/example' }],
  required_verification: ['source_scope', 'page_hash_changed', 'reference_validation', 'schema_validation'],
  manifest_hash: 'e'.repeat(64),
} as SemanticRepairManifest;

function replacement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'applied',
    decision: 'replace_reference',
    source_id: manifest.source_id,
    page_slug: manifest.page_slug,
    manifest_hash: manifest.manifest_hash,
    broken_reference: 'companies/lucky-strike-entertainment',
    occurrence_context: 'Michael works at [[companies/lucky-strike-entertainment]].',
    candidates: [{
      slug: 'companies/lucky-strike',
      title: 'Lucky Strike',
      evidence: ['Exact company name and matching employment context.'],
      confidence: 0.98,
    }],
    proposed_replacement: 'companies/lucky-strike',
    exact_edit_description: 'Replace only the broken company link target.',
    rationale: 'The canonical company page represents the same employer.',
    confidence: 0.98,
    unresolved_questions: [],
    operations: ['get_page', 'search', 'put_page', 'validate_links'],
    verification: {
      page_reread: true,
      links_validated: true,
    },
    ...overrides,
  };
}

describe('nightly repair decision', () => {
  test('normalizes one high-confidence applied replacement', () => {
    const decision = parseNightlyRepairDecision(
      JSON.stringify(replacement()),
      'end_turn',
      manifest,
    );

    expect(AUTONOMOUS_REPAIR_CONFIDENCE).toBe(0.9);
    expect(decision).toMatchObject({
      status: 'applied',
      decision: 'replace_reference',
      proposed_replacement: 'companies/lucky-strike',
      confidence: 0.98,
    });
  });

  test('normalizes source recovery as a no-write deferred outcome', () => {
    const decision = parseNightlyRepairDecision(
      JSON.stringify(replacement({
        status: 'deferred',
        decision: 'recover_source',
        candidates: [],
        proposed_replacement: null,
        exact_edit_description: 'Do not change the page; recover the missing source.',
        rationale: 'The cited source has not been ingested.',
        confidence: 0.96,
        operations: ['get_page', 'search', 'query'],
        verification: {
          page_reread: true,
          links_validated: false,
        },
      })),
      'end_turn',
      manifest,
    );

    expect(decision).toMatchObject({
      status: 'deferred',
      decision: 'recover_source',
      proposed_replacement: null,
    });
  });

  test('rejects failed as an agent-authored terminal status', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({
        status: 'failed',
        decision: 'leave_unresolved',
        candidates: [],
        proposed_replacement: null,
        operations: ['get_page'],
        verification: {
          page_reread: true,
          links_validated: false,
        },
      })),
      'end_turn',
      manifest,
    )).toThrow('unsupported status or decision');
  });

  test('normalizes the tool names surfaced by the subagent loop', () => {
    const decision = parseNightlyRepairDecision(
      JSON.stringify(replacement({
        operations: [
          'brain_get_page',
          'brain_search',
          'brain_put_page',
          'brain_validate_links',
        ],
      })),
      'end_turn',
      manifest,
    );

    expect(decision.operations).toEqual([
      'get_page',
      'search',
      'put_page',
      'validate_links',
    ]);
  });

  test('rejects a low-confidence applied replacement', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({ confidence: AUTONOMOUS_REPAIR_CONFIDENCE - 0.01 })),
      'end_turn',
      manifest,
    )).toThrow('applied decision confidence is below 0.9');
  });

  test('rejects a replacement that is absent from candidate evidence', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({ proposed_replacement: 'companies/other' })),
      'end_turn',
      manifest,
    )).toThrow('proposed_replacement must match a candidate slug');
  });

  test('rejects an applied candidate without identity evidence', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({
        candidates: [{
          slug: 'companies/lucky-strike',
          title: 'Lucky Strike',
          evidence: [],
          confidence: 0.98,
        }],
      })),
      'end_turn',
      manifest,
    )).toThrow('replacement candidate must include evidence');
  });

  test('rejects output bound to another manifest', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({ manifest_hash: 'f'.repeat(64) })),
      'end_turn',
      manifest,
    )).toThrow('decision identity does not match the manifest');
  });

  test('rejects unbounded evidence arrays', () => {
    expect(() => parseNightlyRepairDecision(
      JSON.stringify(replacement({
        candidates: [{
          slug: 'companies/lucky-strike',
          title: 'Lucky Strike',
          evidence: Array.from({ length: 11 }, (_, index) => `Evidence ${index}`),
          confidence: 0.98,
        }],
      })),
      'end_turn',
      manifest,
    )).toThrow('candidate evidence must contain at most 10 items');
  });
});
