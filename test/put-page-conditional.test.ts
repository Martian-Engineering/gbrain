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

/** Build one source-bound remote operation context. */
function context(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'conditional-put-page',
      clientId: 'conditional-put-page',
      clientName: 'conditional-put-page',
      scopes: ['read', 'write'],
      sourceId,
      allowedSources: [sourceId],
    },
  };
}

/** Render one complete page body with a caller-selected relationship line. */
function pageContent(company: string): string {
  return `---
type: person
title: Alice Example
---

# Alice Example

Alice works at ${company}.
`;
}

describe('conditional put_page', () => {
  test('publishes a remote-required nullable expected content hash', () => {
    const operation = operationsByName.put_page;

    expect(operation.params.expected_content_hash).toMatchObject({
      type: 'string',
      required: false,
      remoteRequired: true,
      nullable: true,
    });
  });

  test('rejects an omitted baseline from remote callers before writing', async () => {
    await expect(operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: pageContent('Acme'),
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'expected_content_hash is required for remote put_page calls; pass null to create a page.',
    });

    expect(await engine.getPage('people/alice-example')).toBeNull();
  });

  test('creates only when a null baseline target is absent', async () => {
    await operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: pageContent('Acme'),
      expected_content_hash: null,
    });

    expect((await engine.getPage('people/alice-example'))?.compiled_truth)
      .toContain('Alice works at Acme.');
  });

  test('rejects a null baseline when the source-bound page already exists', async () => {
    await importFromContent(engine, 'people/alice-example', pageContent('Acme'), {
      noEmbed: true,
      sourceId: 'default',
    });

    await expect(operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: pageContent('Widget Co'),
      expected_content_hash: null,
    })).rejects.toMatchObject({
      code: 'page_exists',
      message: 'Page already exists: people/alice-example',
    });

    expect((await engine.getPage('people/alice-example'))?.compiled_truth)
      .toContain('Alice works at Acme.');
  });

  test('rejects a same-content create collision at the importer boundary', async () => {
    const content = pageContent('Acme');
    await importFromContent(engine, 'people/alice-example', content, {
      noEmbed: true,
      sourceId: 'default',
    });

    await expect(importFromContent(engine, 'people/alice-example', content, {
      noEmbed: true,
      sourceId: 'default',
      expectedContentHash: null,
    })).rejects.toMatchObject({
      code: 'stale_page',
      expectedContentHash: null,
    });
  });

  test('retains omitted-baseline unconditional writes for trusted local callers', async () => {
    const local = { ...context(), remote: false };
    await operationsByName.put_page.handler(local, {
      slug: 'people/alice-example',
      content: pageContent('Acme'),
    });
    await operationsByName.put_page.handler(local, {
      slug: 'people/alice-example',
      content: pageContent('Widget Co'),
    });

    expect((await engine.getPage('people/alice-example'))?.compiled_truth)
      .toContain('Alice works at Widget Co.');
  });

  test('rejects a malformed expected content hash before writing', async () => {
    await expect(operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: pageContent('Acme'),
      expected_content_hash: 'not-a-hash',
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'expected_content_hash must be a 64-character lowercase hex hash.',
    });

    expect(await engine.getPage('people/alice-example')).toBeNull();
  });

  test('updates the exact source-bound page when its hash still matches', async () => {
    await importFromContent(engine, 'people/alice-example', pageContent('Acme'), {
      noEmbed: true,
      sourceId: 'default',
    });
    await importFromContent(engine, 'people/alice-example', pageContent('Other Co'), {
      noEmbed: true,
      sourceId: 'other',
    });
    const before = await engine.getPage('people/alice-example', { sourceId: 'default' });

    await operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: pageContent('Widget Co'),
      expected_content_hash: before!.content_hash,
    });

    const updated = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const other = await engine.getPage('people/alice-example', { sourceId: 'other' });
    expect(updated?.compiled_truth).toContain('Alice works at Widget Co.');
    expect(other?.compiled_truth).toContain('Alice works at Other Co.');
  });

  test('returns a structured stale error without changing the page', async () => {
    await importFromContent(engine, 'people/alice-example', pageContent('Acme'), {
      noEmbed: true,
      sourceId: 'default',
    });
    const reviewed = await engine.getPage('people/alice-example', { sourceId: 'default' });
    await importFromContent(engine, 'people/alice-example', pageContent('Newer Co'), {
      noEmbed: true,
      sourceId: 'default',
    });
    const current = await engine.getPage('people/alice-example', { sourceId: 'default' });

    try {
      await operationsByName.put_page.handler(context(), {
        slug: 'people/alice-example',
        content: pageContent('Reviewed Co'),
        expected_content_hash: reviewed!.content_hash,
      });
      throw new Error('expected stale_page');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).toJSON()).toMatchObject({
        error: 'stale_page',
        details: {
          expected_content_hash: reviewed!.content_hash,
          current_content_hash: current!.content_hash,
        },
      });
    }

    const after = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(after?.content_hash).toBe(current?.content_hash);
    expect(after?.compiled_truth).toContain('Alice works at Newer Co.');
  });

  test('treats replayed requested content as an already-applied no-op', async () => {
    await importFromContent(engine, 'people/alice-example', pageContent('Acme'), {
      noEmbed: true,
      sourceId: 'default',
    });
    const reviewed = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const requested = pageContent('Reviewed Co');

    await operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: requested,
      expected_content_hash: reviewed!.content_hash,
    });
    const first = await engine.getPage('people/alice-example', { sourceId: 'default' });

    const replay = await operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: requested,
      expected_content_hash: reviewed!.content_hash,
    }) as { status: string };

    const after = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(replay.status).toBe('skipped');
    expect(after?.content_hash).toBe(first?.content_hash);
    expect(after?.compiled_truth).toContain('Alice works at Reviewed Co.');
  });

  test('rejects Timeline mutation during a stale same-content replay', async () => {
    await importFromContent(engine, 'people/alice-example', pageContent('Acme'), {
      noEmbed: true,
      sourceId: 'default',
    });
    const reviewed = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const requested = `${pageContent('Reviewed Co')}
<!-- timeline -->

## Timeline

- 2026-08-04 — Reviewed relationship
`;
    await operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: requested,
      expected_content_hash: reviewed!.content_hash,
    });
    await engine.executeRaw('DELETE FROM timeline_entries');

    await expect(operationsByName.put_page.handler(context(), {
      slug: 'people/alice-example',
      content: requested,
      expected_content_hash: reviewed!.content_hash,
    })).rejects.toMatchObject({ code: 'stale_page' });
    const rows = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM timeline_entries',
    );

    expect(rows[0]?.count).toBe(0);
  });
});
