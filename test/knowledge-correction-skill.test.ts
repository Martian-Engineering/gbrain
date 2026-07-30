import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';

const skillPath = join(import.meta.dir, '..', 'skills', 'knowledge-correction', 'SKILL.md');
const skill = readFileSync(skillPath, 'utf8');

/** Extract one block-list field from the skill's YAML frontmatter. */
function frontmatterList(field: string): string[] {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const lines = frontmatter.split('\n');
  const start = lines.findIndex(line => line === `${field}:`);
  if (start < 0) return [];
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^  - (.+)$/);
    if (!match) break;
    values.push(match[1]);
  }
  return values;
}

describe('knowledge-correction skill', () => {
  test('covers every correction effect and compound page creation', () => {
    for (const effect of [
      'fix',
      'changed',
      'rename',
      'same_thing',
      'aka',
      'connect',
      'remove',
      'create_or_enrich',
    ]) {
      expect(skill).toContain(`\`${effect}\``);
    }
  });

  test('defaults to proposal mode and requires accepted approval before writes', () => {
    expect(skill).toContain('Default to `propose`');
    expect(skill).toContain('`mode: apply` and `approval_state: accepted`');
    expect(skill).toContain('In propose mode, do not call mutating tools.');
  });

  test('plans against declared apply tools without exposing them before approval', () => {
    expect(skill).toContain('available_apply_tools:');
    expect(skill).toContain('do not call or require them to be callable in propose mode');
    expect(skill).toContain('required operation appears in `available_apply_tools`');
  });

  test('requires a caller-supplied correction date instead of inventing one', () => {
    expect(skill).toContain('correction_date: <caller-supplied YYYY-MM-DD>');
    expect(skill).toContain('Never infer or');
    expect(skill).toContain('invent the date');
  });

  test('treats an anchor as optional context rather than write authorization', () => {
    expect(skill).toContain('anchor_quote: <optional selected text for context>');
    expect(skill).toContain('A missing, repeated, or stale anchor alone is not ambiguity');
    expect(skill).not.toContain('If it is missing or repeated');
    expect(skill).not.toContain('source, page, or anchor does not match');
  });

  test('is self-contained for remote agent dispatch', () => {
    expect(skill).toContain('instructions are self-contained for remote agents');
    expect(skill).not.toMatch(/Read `\.\.\//);
    expect(skill).toContain('Apply a notability gate');
    expect(skill).toContain('Every explicit reference must resolve');
  });

  test('declared tools resolve to canonical GBrain operations', () => {
    const operationNames = new Set(operations.map(operation => operation.name));
    for (const tool of frontmatterList('tools')) {
      expect(operationNames.has(tool)).toBe(true);
    }
    expect(frontmatterList('tools')).toContain('replace_page_text');
    expect(skill).toContain('Prefer `replace_page_text` for edits to existing prose.');
    expect(skill).toContain('Do not reconstruct the');
    expect(skill).toContain('full page with `put_page`.');
  });

  test('can correct source-derived partner and life pages', () => {
    expect(frontmatterList('writes_to')).toContain('partners/');
    expect(frontmatterList('writes_to')).toContain('life/');
  });
});
