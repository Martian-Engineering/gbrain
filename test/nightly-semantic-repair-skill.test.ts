import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skill = readFileSync(
  join(import.meta.dir, '../skills/nightly-semantic-repair/SKILL.md'),
  'utf8',
);

test('nightly semantic repair skill authorizes bounded autonomous repair', () => {
  expect(skill).toContain('only on `page_slug`');
  expect(skill).toContain('Never delete, rename, merge, provision, execute shell commands');
  expect(skill).toContain('confidence is at least `0.90`');
  expect(skill).toContain('write the correction immediately');
  expect(skill).toContain('`recover_source`');
  expect(skill).toContain('`leave_unresolved`');
  expect(skill).toContain('Never return `failed`');
  expect(skill).toContain('"status": "applied | deferred"');
  expect(skill).toContain('Do not compare `page_hash`');
  expect(skill).toContain('Return one JSON object');
  expect(skill).not.toContain('proposal receipt');
  expect(skill).not.toContain('"status": "applied | proposal | failed"');
  const frontmatter = skill.split('---')[1]!;
  expect(frontmatter).toContain('put_page');
  expect(frontmatter).not.toContain('delete_page');
  expect(frontmatter).not.toContain('rename_page');
  expect(frontmatter).not.toContain('shell');
});
