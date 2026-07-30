import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('other', 'Other', '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
});

function context(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'test',
      clientId: 'correction-agent',
      clientName: 'correction-agent',
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId],
    },
  };
}

const fixture = `---
type: person
title: Alice Example
email: alice@example.com
tags:
  - founder
---

# Alice Example

Alice works at Acme.

<!--- gbrain:takes:begin -->
| 1 | Alice works at Acme. |
<!--- gbrain:takes:end -->

<!-- timeline -->

- 2026-01-01: Alice joined Acme.
`;

describe('replace_page_text operation', () => {
  test('publishes the narrow write contract', () => {
    const operation = operationsByName.replace_page_text;
    expect(operation).toBeDefined();
    expect(operation.scope).toBe('write');
    expect(operation.mutating).toBe(true);
    expect(operation.params.expected_content_hash.required).toBe(true);
    expect(operation.params.expected_matches.required).toBe(true);
    expect(operation.params.section.enum).toEqual(['body']);
  });

  test('updates authored body text while preserving page-owned state', async () => {
    await importFromContent(engine, 'people/alice-example', fixture, {
      noEmbed: true,
      sourceId: 'default',
    });
    await importFromContent(engine, 'people/alice-example', fixture.replaceAll('Alice', 'Other Alice'), {
      noEmbed: true,
      sourceId: 'other',
    });
    const before = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const beforeTags = await engine.getTags('people/alice-example', { sourceId: 'default' });

    const result = await operationsByName.replace_page_text.handler(context(), {
      slug: 'people/alice-example',
      old_text: 'Acme',
      new_text: 'Widget Co',
      expected_content_hash: before!.content_hash,
      expected_matches: 1,
      section: 'body',
    }) as {
      status: string;
      previous_content_hash: string;
      content_hash: string;
      replaced: number;
      protected_matches: number;
      write_through: { written: boolean; skipped?: string };
    };

    const after = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const other = await engine.getPage('people/alice-example', { sourceId: 'other' });
    const afterTags = await engine.getTags('people/alice-example', { sourceId: 'default' });

    expect(result).toMatchObject({
      status: 'applied',
      previous_content_hash: before!.content_hash,
      content_hash: after!.content_hash,
      replaced: 1,
      protected_matches: 1,
      write_through: { written: false, skipped: 'no_repo_configured' },
    });
    expect(after?.compiled_truth).toContain('Alice works at Widget Co.');
    expect(after?.compiled_truth).toContain('| 1 | Alice works at Acme. |');
    expect(after?.timeline).toContain('Alice joined Acme.');
    expect(after?.frontmatter.email).toBe('alice@example.com');
    expect(afterTags).toEqual(beforeTags);
    expect(other?.compiled_truth).toContain('Other Alice works at Acme.');
  });

  test('returns structured count details without changing the page', async () => {
    await importFromContent(engine, 'people/alice-example', fixture, {
      noEmbed: true,
      sourceId: 'default',
    });
    const before = await engine.getPage('people/alice-example', { sourceId: 'default' });

    try {
      await operationsByName.replace_page_text.handler(context(), {
        slug: 'people/alice-example',
        old_text: 'Acme',
        new_text: 'Widget Co',
        expected_content_hash: before!.content_hash,
        expected_matches: 2,
        section: 'body',
      });
      throw new Error('expected match-count failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).toJSON()).toMatchObject({
        error: 'match_count_mismatch',
        details: {
          expectedMatches: 2,
          editableMatches: 1,
          protectedMatches: 1,
        },
      });
    }

    const after = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(after?.content_hash).toBe(before?.content_hash);
  });

  test('returns the current hash when the supplied snapshot is stale', async () => {
    await importFromContent(engine, 'people/alice-example', fixture, {
      noEmbed: true,
      sourceId: 'default',
    });
    const before = await engine.getPage('people/alice-example', { sourceId: 'default' });
    await importFromContent(engine, 'people/alice-example', fixture.replace('Acme.', 'Changed.'), {
      noEmbed: true,
      sourceId: 'default',
    });
    const current = await engine.getPage('people/alice-example', { sourceId: 'default' });

    await expect(operationsByName.replace_page_text.handler(context(), {
      slug: 'people/alice-example',
      old_text: 'Acme',
      new_text: 'Widget Co',
      expected_content_hash: before!.content_hash,
      expected_matches: 1,
      section: 'body',
    })).rejects.toMatchObject({
      code: 'stale_page',
      details: {
        current_content_hash: current!.content_hash,
      },
    });
  });
});
