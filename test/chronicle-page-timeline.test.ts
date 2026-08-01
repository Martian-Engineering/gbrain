import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  parseCanonicalTimelineEventLinks,
  resolvePageTimelineEvents,
} from '../src/core/chronicle/page-timeline.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

async function putPage(
  slug: string,
  type: string,
  timeline = '',
  frontmatter: Record<string, unknown> = {},
  sourceId = 'default',
): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: '',
    timeline,
    frontmatter,
  }, { sourceId });
}

function operationContext(opts: {
  sourceId?: string;
  allowedSources?: string[];
} = {}): OperationContext {
  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: opts.sourceId ?? 'default',
    auth: {
      token: 'test',
      clientId: 'client',
      scopes: ['read'],
      sourceId: opts.sourceId ?? 'default',
      allowedSources: opts.allowedSources ?? ['default'],
    },
  } as unknown as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('canonical Chronicle page timeline', () => {
  test('parses only canonical unbolded event backlink lines', () => {
    const timeline = [
      '## Timeline',
      '',
      '- 2026-07-24 — [[life/events/2026-07-24-active|Authored summary]]',
      '- **2026-07-23** — [[life/events/2026-07-23-legacy|Legacy summary]]',
      '- 2026-07-22 — [[meetings/2026-07-22-sync|Meeting summary]]',
    ].join('\n');

    expect(parseCanonicalTimelineEventLinks(timeline)).toEqual([{
      date: '2026-07-24',
      event_slug: 'life/events/2026-07-24-active',
      authored_label: 'Authored summary',
      source_order: 0,
    }]);
  });

  test('enriches active composed projections and exposes graph-missing state', async () => {
    await putPage('people/alice-example', 'person');
    await putPage('meetings/2026-07-24-depth', 'meeting');
    await putPage(
      'life/events/2026-07-24-active',
      'event',
      '',
      {
        event: {
          when: '2026-07-24T15:00:00Z',
          who: ['people/alice-example', 'people/bob-example'],
          what: 'Alice committed to the complete, untruncated follow-up.',
          where: 'SignalCore',
          owner: 'people/alice-example',
          kind: 'commitment',
          depth: 'meetings/2026-07-24-depth',
        },
      },
    );
    await putPage(
      'life/events/2026-07-23-stale',
      'event',
      '',
      {
        event: {
          when: '2026-07-23T10:00:00Z',
          who: ['people/alice-example'],
          what: 'Superseded event',
          kind: 'meeting',
          depth: 'meetings/2026-07-23-missing-depth',
        },
      },
    );
    await putPage(
      'life/events/2026-07-21-unlinked',
      'event',
      '',
      {
        event: {
          when: '2026-07-21T10:00:00Z',
          who: ['people/alice-example'],
          what: 'Active event whose graph edge is missing',
          kind: 'decision',
          depth: 'meetings/2026-07-24-depth',
        },
      },
    );
    await engine.upsertEventProjection({
      depthSlug: 'people/alice-example',
      eventSlug: 'life/events/2026-07-24-active',
      date: '2026-07-24',
      summary: 'Short active label',
    });
    await engine.upsertEventProjection({
      depthSlug: 'people/alice-example',
      eventSlug: 'life/events/2026-07-23-stale',
      date: '2026-07-23',
      summary: 'Stale label',
    });
    await engine.upsertEventProjection({
      depthSlug: 'people/alice-example',
      eventSlug: 'life/events/2026-07-21-unlinked',
      date: '2026-07-21',
      summary: 'Unlinked label',
    });
    await engine.addLink(
      'people/alice-example',
      'life/events/2026-07-24-active',
      'timeline backlink',
      'references',
      'markdown',
      undefined,
      undefined,
      { fromSourceId: 'default', toSourceId: 'default' },
    );
    await engine.addLink(
      'people/alice-example',
      'life/events/2026-07-23-stale',
      'timeline backlink',
      'references',
      'markdown',
      undefined,
      undefined,
      { fromSourceId: 'default', toSourceId: 'default' },
    );
    await engine.softDeletePage('life/events/2026-07-23-stale', {
      sourceId: 'default',
    });

    const linksBefore = await engine.getLinks('people/alice-example', {
      sourceId: 'default',
    });
    const result = await resolvePageTimelineEvents(engine, {
      slug: 'people/alice-example',
      sourceId: 'default',
      limit: 10,
    });
    const linksAfter = await engine.getLinks('people/alice-example', {
      sourceId: 'default',
    });

    expect(result).toMatchObject({
      schema_version: 1,
      page_slug: 'people/alice-example',
      source_id: 'default',
      total: 2,
      offset: 0,
      limit: 10,
      truncated: false,
      issue_counts: {
        soft_deleted: 0,
        missing: 0,
        graph_missing: 1,
        depth_missing: 0,
      },
    });
    expect(result.events.map(event => event.state)).toEqual([
      'active',
      'graph_missing',
    ]);
    expect(result.events[0]).toMatchObject({
      summary: 'Alice committed to the complete, untruncated follow-up.',
      kind: 'commitment',
      owner: 'people/alice-example',
      who: ['people/alice-example', 'people/bob-example'],
      where: 'SignalCore',
      graph_edge_present: true,
      depth: {
        slug: 'meetings/2026-07-24-depth',
        title: 'meetings/2026-07-24-depth',
        type: 'meeting',
        state: 'active',
      },
    });
    expect(linksAfter).toEqual(linksBefore);
  });

  test('paginates without changing canonical source order', async () => {
    await putPage('people/alice-example', 'person');
    const projections: Array<[string, string, string]> = [
      ['2026-07-24', 'life/events/a', 'A'],
      ['2026-07-23', 'life/events/b', 'B'],
      ['2026-07-22', 'life/events/c', 'C'],
    ];
    for (const [date, eventSlug, summary] of projections) {
      await putPage(eventSlug, 'event');
      await engine.upsertEventProjection({
        depthSlug: 'people/alice-example',
        eventSlug,
        date,
        summary,
      });
    }

    const result = await resolvePageTimelineEvents(engine, {
      slug: 'people/alice-example',
      sourceId: 'default',
      offset: 1,
      limit: 1,
    });

    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.events.map(event => event.event_slug)).toEqual([
      'life/events/b',
    ]);
  });

  test('operation rejects an explicitly requested source outside the grant', async () => {
    const op = operationsByName.resolve_timeline_events;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.mutating).not.toBe(true);

    await expect(op.handler(operationContext(), {
      slug: 'people/alice-example',
      source_id: 'other',
    })).rejects.toBeInstanceOf(OperationError);
  });
});
