import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { getSkillAgentBindings } from '../src/core/skill-catalog.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

const skillsDir = join(import.meta.dir, '..', 'skills');
const skill = readFileSync(
  join(skillsDir, 'github-project-ingestion', 'SKILL.md'),
  'utf8',
);
const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf8');

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
  'sources/',
  'people/',
  'companies/',
  'projects/',
  'concepts/',
  'decisions/',
];

describe('github-project-ingestion skill', () => {
  test('derives the exact reviewed agent bindings', () => {
    expect(getSkillAgentBindings(skillsDir, 'github-project-ingestion')).toEqual({
      tools: expectedTools,
      writes_to: expectedPrefixes,
    });
  });

  test('declares only Minion-supported canonical operations', () => {
    const operationNames = new Set(operations.map(operation => operation.name));
    for (const tool of expectedTools) {
      expect(operationNames.has(tool)).toBe(true);
      expect(BRAIN_TOOL_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  test('keeps acquisition and code interpretation outside the Minion', () => {
    expect(skill).toContain('does not acquire data from GitHub');
    expect(skill).toContain('does not ingest or reconstruct repository code');
    expect(skill).toContain('choose among sources');
    expect(skill).toContain('manage checkpoints');
    expect(skill).toContain('Do not read another source');
  });

  test('declares the complete resolver route as a trigger', () => {
    const route =
      'Prompt-supplied GitHub issue, pull request, or Markdown project-document revision for one already-selected source';
    expect(skill).toContain(`- "${route}"`);
    expect(resolver).toContain(`| ${route} |`);
  });

  test('handles canonical revisions without duplicating upstream objects', () => {
    expect(skill).toContain('canonicalExternalId');
    expect(skill).toContain('captureExternalId');
    expect(skill).toContain('predecessorExternalId');
    expect(skill).toContain('newer revision of the same canonical object');
    expect(skill).toContain('tombstone');
    expect(skill).toContain("Lore's local Markdown mirror");
  });

  test('returns the exact Lore ingestion receipt', () => {
    expect(skill).toContain('"status": "succeeded | needs_attention | failed"');
    expect(skill).toContain('"artifactId": "copied exactly from the prompt"');
    expect(skill).toContain('"sourceId": "verified source id"');
    expect(skill).toContain('qualify every page as `<sourceId>:<slug>`');
    expect(skill).toContain('"createdPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"updatedPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"verifiedPages": ["<sourceId>:<slug>"]');
    expect(skill).not.toContain('<sourceId>:<slug> created');
  });
});
