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
  'get_links',
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
    expect(skill).toContain('"status": "succeeded | failed"');
    expect(skill).toContain('"artifactId": "copied exactly from the prompt"');
    expect(skill).toContain('"sourceId": "verified source id"');
    expect(skill).toContain('"createdPages":');
    expect(skill).toContain('"updatedPages":');
    expect(skill).toContain('"verifiedPages":');
    expect(skill).toContain('qualify every page as `<sourceId>:<slug>`');
    expect(skill).toContain('with no status words or commentary');
    expect(skill).toContain('"createdPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"updatedPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"verifiedPages": ["<sourceId>:<slug>"]');
    expect(skill).not.toContain('<sourceId>:<slug> created');
    expect(skill).not.toContain('<sourceId>:<slug> updated');
    expect(skill).not.toContain('<sourceId>:<slug> read back and verified');
    expect(skill).toMatch(/Never return a bare\s+`sources\/\.\.\.`/);
    expect(skill).toContain('"unresolved":');
    expect(skill).not.toContain('effect list');
    expect(skill).not.toContain('content hash');
  });

  test('supports a zero-mutation scoped proposal with a bounded complete plan', () => {
    expect(skill).toContain('mode: <propose | apply | omit for normal mode>');
    expect(skill).toContain('admissionScope: <required in propose and apply modes>');
    expect(skill).toContain('In `propose` mode, do not call any mutating tool');
    expect(skill).toMatch(/`put_page`,\s+`add_link`, or `add_timeline_entry`/);
    expect(skill).toContain('complete set of pages that `apply` will write');
    expect(skill).toMatch(/cannot be\s+represented completely by `proposedPages`/);
    expect(skill).toMatch(/Return `failed` with an operational summary and zero mutations rather\s+than omit that mutation/);
    expect(skill).toContain('full intended `bodyMarkdown`, never a diff');
    expect(skill).toContain('262,144 UTF-8 bytes');
    expect(skill).toMatch(/Return `failed`\s+with an operational summary/);
    expect(skill).toContain('Never truncate or split a proposal');
    expect(skill).toContain('must not name or describe the excluded material');
    expect(skill).toMatch(/local Markdown artifact is the\s+complete verbatim record/);
    expect(skill).toContain('"status": "scoped_proposal"');
    expect(skill).toContain('"effect": "create | update"');
    expect(skill).toContain('"bodyMarkdown": "complete intended page body"');
  });

  test('splits partial disqualification from classed needs-attention outcomes', () => {
    expect(skill).toContain('partial disqualification');
    expect(skill).toMatch(/[Dd]erive `admissionScope` only from the resolver/);
    expect(skill).toContain('return `scoped_proposal` directly');
    expect(skill).toMatch(/Do not mutate before returning that\s+proposal/);
    expect(skill).toContain('"reason_class": "resolver_ambiguity | operational"');
    expect(skill).toMatch(/Every `needs_attention`\s+receipt must include `reason_class`/);
  });

  test('applies only the frozen plan with resumable page and collision results', () => {
    expect(skill).toContain('proposedPages: <required frozen proposal pages in apply mode>');
    expect(skill).toMatch(/write the supplied title\s+and full body exactly/);
    expect(skill).toContain('slug collision discovered at write time');
    expect(skill).toMatch(/No other plan\s+adjustment is allowed/);
    expect(skill).toMatch(/does not\s+contradict `admissionScope`/);
    expect(skill).toMatch(/Skip a prior `applied` result only after\s+read-back/);
    expect(skill).toContain('"pageResults":');
    expect(skill).toContain('"status": "pending | written | applied | failed"');
    expect(skill).toContain('immediately after a successful mutation');
    expect(skill).toMatch(/Resume a prior `written`\s+result at its recorded actual slug/);
    expect(skill).toContain('"slugAdjustments":');
    expect(skill).toContain('"reason": "slug_collision"');
  });

  test('requires rich meeting enrichment before reporting success', () => {
    expect(skill).toContain('Every unambiguous attendee must have a substantive `people/` dossier');
    expect(skill).toContain('Every substantive organization, project, concept, and durable decision');
    expect(skill).toContain('The meeting is not complete until every resolved entity dossier');
    expect(skill).toContain('Every page created or updated during enrichment must appear');
    expect(skill).toContain('Check `get_links`');
    expect(skill).toContain('Check `get_backlinks`');
    expect(skill).not.toContain('For each notable, unambiguous attendee');
  });
});
