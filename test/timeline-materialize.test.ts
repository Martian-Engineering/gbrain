import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as BrainEngine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

async function putTarget(timeline = ''): Promise<void> {
  await engine.putPage('companies/acme-example', {
    type: 'company',
    title: 'Acme Example',
    compiled_truth: '# Acme Example\n\nExisting truth.',
    timeline,
    frontmatter: {},
  });
}

describe('add_timeline_entry Markdown materialization', () => {
  test('creates a Timeline section and appends a refless bullet', async () => {
    await putTarget();

    const result = await operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Opened the new office',
    });

    expect(result).toEqual({ status: 'ok', materialized: true });
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n- 2026-07-31 — Opened the new office',
    );
  });

  test('appends a ref wikilink using the ref page title by default', async () => {
    await putTarget('## Timeline\n\n- 2026-07-15 — Existing entry');
    await engine.putPage('sources/github/123', {
      type: 'source',
      title: 'GitHub issue 123',
      compiled_truth: '# GitHub issue 123',
      frontmatter: {},
    });

    const result = await operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-10',
      summary: 'Shipped the release',
      ref: 'sources/github/123',
    });

    expect(result).toEqual({ status: 'ok', materialized: true });
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n- 2026-07-15 — Existing entry\n' +
      '- 2026-07-10 — Shipped the release [[sources/github/123|GitHub issue 123]]',
    );
    expect(await engine.getLinks('companies/acme-example')).toEqual([
      expect.objectContaining({ to_slug: 'sources/github/123' }),
    ]);
  });

  test('uses an explicit ref_label', async () => {
    await putTarget();
    await engine.putPage('sources/github/456', {
      type: 'source',
      title: 'Long source title',
      compiled_truth: '# Long source title',
      frontmatter: {},
    });

    await operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-30',
      summary: 'Reviewed the change',
      ref: 'sources/github/456',
      ref_label: 'review thread',
    });

    expect((await engine.getPage('companies/acme-example'))?.timeline).toContain(
      '- 2026-07-30 — Reviewed the change [[sources/github/456|review thread]]',
    );
  });

  test('rejects a ref that does not exist in the target source before inserting', async () => {
    await putTarget();

    await expect(operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Should not insert',
      ref: 'sources/github/missing',
    })).rejects.toThrow(
      'Timeline reference page "sources/github/missing" (source=default) not found',
    );

    expect(await engine.getTimeline('companies/acme-example')).toHaveLength(0);
  });

  test('rejects a ref that exists only in another source', async () => {
    await putTarget();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ['other-source', 'Other source'],
    );
    await engine.putPage('sources/github/cross-source', {
      type: 'source',
      title: 'Foreign source page',
      compiled_truth: '# Foreign source page',
      frontmatter: {},
    }, { sourceId: 'other-source' });

    await expect(operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Should not cross sources',
      ref: 'sources/github/cross-source',
    })).rejects.toThrow(
      'Timeline reference page "sources/github/cross-source" (source=default) not found',
    );
    expect(await engine.getTimeline('companies/acme-example')).toHaveLength(0);
  });

  test('a duplicate call does not append a second line', async () => {
    await putTarget();
    const params = {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Idempotent event',
    };

    expect(await operationsByName.add_timeline_entry.handler(makeContext(), params))
      .toEqual({ status: 'ok', materialized: true });
    expect(await operationsByName.add_timeline_entry.handler(makeContext(), params))
      .toEqual({ status: 'ok', materialized: false });

    const timeline = (await engine.getPage('companies/acme-example'))!.timeline;
    expect(timeline.split('- 2026-07-31 — Idempotent event')).toHaveLength(2);
  });

  test('an existing date-and-summary line suppresses materialization after a new DB insert', async () => {
    await putTarget('## Timeline\n\n- 2026-07-31 — Already visible [[sources/github/old|old ref]]');

    const result = await operationsByName.add_timeline_entry.handler(makeContext(), {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Already visible',
    });

    expect(result).toEqual({ status: 'ok', materialized: false });
    expect((await engine.getPage('companies/acme-example'))!.timeline)
      .toBe('## Timeline\n\n- 2026-07-31 — Already visible [[sources/github/old|old ref]]');
    expect(await engine.getTimeline('companies/acme-example')).toHaveLength(1);
  });
});

describe('timeline_materialize backfill', () => {
  test('dry-run reports work without changing Markdown', async () => {
    await putTarget();
    await engine.addTimelineEntry('companies/acme-example', {
      date: '2026-07-28',
      summary: 'Preview event',
    });

    expect(await operationsByName.timeline_materialize.handler(makeContext(), {
      source: 'default',
      dry_run: true,
    })).toEqual({ pages_touched: 1, lines_written: 1, skipped_duplicates: 0 });
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe('');
  });

  test('materializes existing rows and is idempotent on a second run', async () => {
    await putTarget();
    await engine.putPage('sources/github/789', {
      type: 'source',
      title: 'GitHub issue 789',
      compiled_truth: '# GitHub issue 789',
      frontmatter: {},
    });
    await engine.addTimelineEntry('companies/acme-example', {
      date: '2026-07-29',
      summary: 'Source-backed event',
      source: 'sources/github/789',
    });
    await engine.addTimelineEntry('companies/acme-example', {
      date: '2026-07-30',
      summary: 'Free-text source event',
      source: 'manual note with no page slug',
    });

    const first = await operationsByName.timeline_materialize.handler(makeContext(), {
      source: 'default',
    });
    expect(first).toEqual({ pages_touched: 1, lines_written: 2, skipped_duplicates: 0 });
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n' +
      '- 2026-07-29 — Source-backed event [[sources/github/789|GitHub issue 789]]\n' +
      '- 2026-07-30 — Free-text source event',
    );

    const second = await operationsByName.timeline_materialize.handler(makeContext(), {
      source: 'default',
    });
    expect(second).toEqual({ pages_touched: 0, lines_written: 0, skipped_duplicates: 2 });
  });
});
