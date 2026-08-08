import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { importFromContent } from '../../src/core/import-file.ts';
import {
  operationsByName,
  type OperationContext,
} from '../../src/core/operations.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const skip = !hasDatabase();

if (skip) {
  test.skip('replace_page_text Postgres parity skipped (DATABASE_URL unset)', () => {});
}

describe.skipIf(skip)('replace_page_text Postgres parity', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  });

  /** Build one source-bound remote operation context. */
  function context(): OperationContext {
    return {
      engine,
      config: { engine: 'postgres' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      auth: {
        token: 'postgres-parity',
        clientId: 'postgres-parity',
        clientName: 'postgres-parity',
        scopes: ['read', 'write'],
        sourceId: 'default',
        allowedSources: ['default'],
      },
    };
  }

  test('applies one exact edit and rejects reuse of the stale snapshot', async () => {
    const slug = 'people/postgres-parity';
    await importFromContent(engine, slug, `---
type: person
title: Postgres Parity
email: parity@example.com
tags:
  - parity
---

# Postgres Parity

Postgres Parity works at Old Company.

<!--- gbrain:takes:begin -->
| 1 | Postgres Parity works at Old Company. |
<!--- gbrain:takes:end -->

<!-- timeline -->

- 2026-07-30: Postgres Parity joined Old Company.
    `, {
      noEmbed: true,
      sourceId: 'default',
    });
    await engine.addTimelineEntry(slug, {
      date: '2026-07-30',
      summary: 'Postgres Parity joined Old Company.',
    }, { sourceId: 'default' });
    const before = await engine.getPage(slug, { sourceId: 'default' });

    const applied = await operationsByName.replace_page_text.handler(context(), {
      slug,
      old_text: 'Old Company',
      new_text: 'New Company',
      expected_content_hash: before!.content_hash,
      expected_matches: 1,
      section: 'body',
    });
    const after = await engine.getPage(slug, { sourceId: 'default' });
    const afterTimeline = await engine.getTimeline(slug, { sourceId: 'default' });

    expect(applied).toMatchObject({
      status: 'applied',
      previous_content_hash: before!.content_hash,
      content_hash: after!.content_hash,
      replaced: 1,
      protected_matches: 1,
    });
    expect(after?.compiled_truth).toContain('works at New Company.');
    expect(after?.compiled_truth).toContain('| 1 | Postgres Parity works at Old Company. |');
    expect(afterTimeline.map((entry) => entry.summary))
      .toContain('Postgres Parity joined Old Company.');
    expect(after?.frontmatter.email).toBe('parity@example.com');
    expect(await engine.getTags(slug, { sourceId: 'default' })).toEqual(['parity']);

    await expect(operationsByName.replace_page_text.handler(context(), {
      slug,
      old_text: 'New Company',
      new_text: 'Another Company',
      expected_content_hash: before!.content_hash,
      expected_matches: 1,
      section: 'body',
    })).rejects.toMatchObject({
      code: 'stale_page',
      details: { current_content_hash: after!.content_hash },
    });
  });
});
