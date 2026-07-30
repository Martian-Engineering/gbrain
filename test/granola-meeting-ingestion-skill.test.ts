import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { getSkillAgentBindings } from '../src/core/skill-catalog.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

const skillsDir = join(import.meta.dir, '..', 'skills');
const skill = readFileSync(
  join(skillsDir, 'granola-meeting-ingestion', 'SKILL.md'),
  'utf8',
);

const expectedTools = [
  'get_active_schema_pack',
  'search',
  'query',
  'get_page',
  'list_pages',
  'resolve_slugs',
  'get_backlinks',
  'put_page',
  'add_link',
  'add_timeline_entry',
  'validate_links',
];

const expectedPrefixes = [
  'partners/',
  'sources/',
  'meetings/',
  'people/',
  'companies/',
  'projects/',
  'concepts/',
  'decisions/',
];

describe('granola-meeting-ingestion skill', () => {
  test('derives the exact reviewed agent bindings', () => {
    expect(getSkillAgentBindings(skillsDir, 'granola-meeting-ingestion')).toEqual({
      tools: expectedTools,
      writes_to: expectedPrefixes,
    });
  });

  test('declares only canonical GBrain operations', () => {
    const operationNames = new Set(operations.map(operation => operation.name));
    for (const tool of expectedTools) {
      expect(operationNames.has(tool)).toBe(true);
      expect(BRAIN_TOOL_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  test('keeps acquisition, routing, and orchestration outside the Minion', () => {
    expect(skill).toContain('does not acquire data from Granola');
    expect(skill).toMatch(/choose\s+among sources/);
    expect(skill).toContain('manage checkpoints');
    expect(skill).toContain('provide a generic ingestion control plane');
    expect(skill).toContain('Do not read another source');
  });

  test('uses the source-bound credential and frozen resolver without inventing a page', () => {
    expect(skill).toContain('credential binds every tool call to the prompt');
    expect(skill).toContain('exact prompt-supplied resolver text and revision');
    expect(skill).not.toContain('exact `resolver` slug');
    expect(skill).not.toContain("source's `resolver` page");
    expect(skill).toContain("Lore's local Markdown mirror");
    expect(skill).toContain('Read the source page back with `get_page`');
    expect(skill).toContain('artifact source-record read-back');
    expect(skill).toContain('local-mirror provenance statement');
    expect(skill).not.toContain('the complete transcript Markdown');
    expect(skill).not.toContain('raw-data retrieval');
  });

  test('returns the Lore ingestion receipt without deterministic effects', () => {
    expect(skill).toContain('"status": "succeeded | needs_attention | failed"');
    expect(skill).toContain('"artifactId": "copied exactly from the prompt"');
    expect(skill).toContain('"sourceId": "verified source id"');
    expect(skill).toContain('"createdPages":');
    expect(skill).toContain('"updatedPages":');
    expect(skill).toContain('"verifiedPages":');
    expect(skill).toContain('qualify every page as `<sourceId>:<slug>`');
    expect(skill).toContain('Never return a bare `sources/...`');
    expect(skill).toContain('"unresolved":');
    expect(skill).not.toContain('effect list');
    expect(skill).not.toContain('content hash');
  });
});
