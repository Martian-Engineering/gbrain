import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = readFileSync(
  join(import.meta.dir, '../skills/nightly-semantic-repair/SKILL.md'),
  'utf8',
);

test('nightly semantic repair skill stays one-page and non-destructive', () => {
  expect(skill).toContain('only on `page_slug`');
  expect(skill).toContain('Never delete, rename, merge, provision, execute shell commands');
  expect(skill).toContain('Return one JSON object');
  const frontmatter = skill.split('---')[1]!;
  expect(frontmatter).toContain('put_page');
  expect(frontmatter).not.toContain('delete_page');
  expect(frontmatter).not.toContain('rename_page');
  expect(frontmatter).not.toContain('shell');
});
