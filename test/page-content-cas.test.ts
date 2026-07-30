import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { StalePageError } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
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
});

describe('page content compare-and-swap', () => {
  test('rejects a stale import inside the page transaction', async () => {
    await importFromContent(
      engine,
      'people/alice-example',
      '# Alice\n\nOriginal text.',
      { noEmbed: true, sourceId: 'default' },
    );
    const original = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(original?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    const originalHash = original!.content_hash!;

    await importFromContent(
      engine,
      'people/alice-example',
      '# Alice\n\nConcurrent text.',
      { noEmbed: true, sourceId: 'default' },
    );
    const concurrent = await engine.getPage('people/alice-example', { sourceId: 'default' });

    try {
      await importFromContent(
        engine,
        'people/alice-example',
        '# Alice\n\nStale replacement.',
        {
          noEmbed: true,
          sourceId: 'default',
          expectedContentHash: originalHash,
        },
      );
      throw new Error('expected stale import to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(StalePageError);
      expect((error as StalePageError).code).toBe('stale_page');
      expect((error as StalePageError).expectedContentHash).toBe(originalHash);
      expect((error as StalePageError).currentContentHash).toBe(concurrent!.content_hash!);
    }

    const after = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(after?.compiled_truth).toContain('Concurrent text.');
    expect(after?.compiled_truth).not.toContain('Stale replacement.');
    expect(after?.content_hash).toBe(concurrent?.content_hash);
  });

  test('accepts the current hash and returns the new hash', async () => {
    await importFromContent(
      engine,
      'people/alice-example',
      '# Alice\n\nOriginal text.',
      { noEmbed: true, sourceId: 'default' },
    );
    const original = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const originalHash = original!.content_hash!;

    await importFromContent(
      engine,
      'people/alice-example',
      '# Alice\n\nUpdated text.',
      {
        noEmbed: true,
        sourceId: 'default',
        expectedContentHash: originalHash,
      },
    );

    const updated = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(updated?.content_hash).not.toBe(original?.content_hash);
    expect(updated?.compiled_truth).toContain('Updated text.');
  });

  test('rejects an expected hash when the page does not exist', async () => {
    await expect(importFromContent(
      engine,
      'people/missing',
      '# Missing\n\nNew text.',
      {
        noEmbed: true,
        sourceId: 'default',
        expectedContentHash: 'a'.repeat(64),
      },
    )).rejects.toMatchObject({
      code: 'stale_page',
      currentContentHash: null,
    });
  });
});
