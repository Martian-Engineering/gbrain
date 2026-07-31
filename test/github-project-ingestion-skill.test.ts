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

  test('treats GitHub objects as evidence for durable features, not projects', () => {
    expect(skill).toMatch(
      /An issue, pull request, or plan document is evidence about work; it is not a\s+project merely because it is a canonical upstream object\./,
    );
    expect(skill).toMatch(
      /Multiple GitHub objects about the same feature or initiative must converge on\s+one durable project page\./,
    );
    expect(skill).toMatch(
      /When no durable feature or initiative can be resolved, keep the exact capture\s+and report the relationship as unresolved without creating a project stub\./,
    );
    expect(skill).toMatch(
      /Reuse a source record only when its stored `captureExternalId` matches\s+exactly\./,
    );
    expect(skill).toMatch(
      /never overwrite an earlier capture with a newer revision\./,
    );
    expect(skill).toMatch(
      /A newer revision of the same canonical object records its own exact capture/,
    );
    expect(skill).toMatch(
      /When `tombstone` is true, record or reuse only the exact tombstone capture\./,
    );
    expect(skill).toMatch(
      /A\s+tombstone changes the availability of the upstream object, not the existence of\s+the feature or initiative it discussed\./,
    );
    expect(skill).not.toContain(
      'create or update one canonical project page for the upstream object',
    );
  });

  test('prescribes current-state page anatomy for historical captures', () => {
    expect(skill).toMatch(
      /The feature or initiative page body records current understanding only:\s+purpose, scope, behavior, decisions, constraints, status, and open questions\./,
    );
    expect(skill).toMatch(
      /Record every material dated change exclusively with `add_timeline_entry`,\s+dated by the upstream event time/,
    );
    expect(skill).toMatch(
      /Still write dated, cited timeline entries for material feature or initiative\s+events\. Being historical is never a reason to skip the timeline\./,
    );
    expect(skill).toMatch(
      /Update the body's current understanding only when the capture is the newest\s+evidence recorded for that page, judged by `upstreamOrder` and revision dates\s+already recorded\./,
    );
    expect(skill).toMatch(
      /Appending dated capture sections or per-artifact narration to a feature or\s+initiative page body\./,
    );
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
