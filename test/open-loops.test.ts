import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  decodeOpenLoopCursor,
  listOpenLoops,
  OpenLoopValidationError,
  type OpenLoopItem,
} from '../src/core/open-loops.ts';

let engine: PGLiteEngine;

/** Insert one page fixture and return its generated id. */
async function insertPage(input: {
  sourceId?: string;
  slug: string;
  type: string;
  effectiveDate?: string;
  event?: Record<string, unknown>;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
     VALUES ($1, $2, $3, $2, $4::timestamptz, $5::jsonb)
     RETURNING id`,
    [
      input.sourceId ?? 'default',
      input.slug,
      input.type,
      input.effectiveDate ?? null,
      JSON.stringify(input.event ? { event: input.event } : {}),
    ],
  );
  return Number(rows[0].id);
}

/** Project an event onto one depth page. */
async function insertProjection(
  pageId: number,
  eventPageId: number,
  date: string,
  summary: string,
  owner: string | null = null,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id, owner)
     VALUES ($1, $2::date, 'test:event', $3, '', $4, $5)`,
    [pageId, date, summary, eventPageId, owner],
  );
}

/** Follow every cursor so assertions exercise the public pagination contract. */
async function readAll(limit = 200): Promise<OpenLoopItem[]> {
  const items: OpenLoopItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await listOpenLoops(engine, {
      since: '2026-01-01',
      until: '2026-12-31',
      sourceId: 'default',
      limit,
      cursor,
    });
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items;
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

describe('listOpenLoops', () => {
  test('applies resolution before pagination and returns events beyond 500 projections', async () => {
    const depthPageId = await insertPage({ slug: 'projects/example', type: 'project' });

    // The old Chronicle reader capped this ordered projection stream at 500,
    // which hid the newer event. This fixture keeps that exact failure shape.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
       SELECT
         'default',
         'life/events/2026-01-' || lpad(n::text, 3, '0'),
         'event',
         'Event ' || n,
         '2026-01-01T12:00:00Z'::timestamptz,
         jsonb_build_object('event', jsonb_build_object(
           'kind', 'commitment',
           'what', 'Old follow-up ' || n
         ))
       FROM generate_series(1, 501) AS n`,
    );
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
       SELECT $1, '2026-01-01'::date, 'test:event', p.title, '', p.id
         FROM pages p
        WHERE p.slug LIKE 'life/events/2026-01-%'`,
      [depthPageId],
    );
    const recentEventId = await insertPage({
      slug: 'life/events/2026-08-18-recent',
      type: 'event',
      effectiveDate: '2026-08-18T15:00:00Z',
      event: { kind: 'commitment', what: 'Recent follow-up' },
    });
    await insertProjection(depthPageId, recentEventId, '2026-08-18', 'Recent follow-up');

    const beforeResolution = await readAll();
    expect(beforeResolution).toHaveLength(502);
    expect(beforeResolution.at(-1)?.event_slug).toBe('life/events/2026-08-18-recent');

    const resolvedId = beforeResolution[250].event_page_id;
    await engine.executeRaw(
      `INSERT INTO tags (page_id, tag) VALUES ($1, 'desk:done')`,
      [resolvedId],
    );
    const afterResolution = await readAll();
    expect(afterResolution).toHaveLength(501);
    expect(afterResolution.some(item => item.event_page_id === resolvedId)).toBe(false);
    expect(afterResolution.at(-1)?.summary).toBe('Recent follow-up');
  });

  test('collapses same-source projections while retaining every depth slug', async () => {
    const firstDepthId = await insertPage({ slug: 'projects/alpha', type: 'project' });
    const secondDepthId = await insertPage({ slug: 'people/example', type: 'person' });
    const eventId = await insertPage({
      slug: 'life/events/2026-06-15-intro',
      type: 'event',
      effectiveDate: '2026-06-15T09:30:00Z',
      event: {
        kind: 'intro',
        what: 'Make an introduction',
        who: ['people/owner', 'people/recipient'],
      },
    });
    await insertProjection(firstDepthId, eventId, '2026-06-15', 'Projection one', 'people/owner');
    await insertProjection(secondDepthId, eventId, '2026-06-15', 'Projection two', 'people/owner');

    const page = await listOpenLoops(engine, {
      since: '2026-06-01',
      until: '2026-06-30',
      sourceId: 'default',
    });

    expect(page.items).toEqual([expect.objectContaining({
      event_page_id: eventId,
      kind: 'intro',
      summary: 'Make an introduction',
      owner: 'people/owner',
      who: ['people/owner', 'people/recipient'],
      source_page_slugs: ['people/example', 'projects/alpha'],
    })]);
  });

  test('requires both event and projection sources to be authorized', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'Other')`,
    );
    const defaultDepthId = await insertPage({ slug: 'projects/default', type: 'project' });
    const otherDepthId = await insertPage({ sourceId: 'other', slug: 'projects/other', type: 'project' });
    const eventId = await insertPage({
      slug: 'life/events/2026-07-01-cross-source',
      type: 'event',
      effectiveDate: '2026-07-01T12:00:00Z',
      event: { kind: 'commitment', what: 'Cross-source follow-up' },
    });
    await insertProjection(defaultDepthId, eventId, '2026-07-01', 'Default projection');
    await insertProjection(otherDepthId, eventId, '2026-07-01', 'Other projection');

    const scalar = await listOpenLoops(engine, {
      since: '2026-07-01',
      until: '2026-07-01',
      sourceId: 'default',
    });
    expect(scalar.items.map(item => item.source_id)).toEqual(['default']);

    const federated = await listOpenLoops(engine, {
      since: '2026-07-01',
      until: '2026-07-01',
      sourceIds: ['default', 'other'],
    });
    expect(federated.items.map(item => item.source_id)).toEqual(['default', 'other']);

    const otherOnly = await listOpenLoops(engine, {
      since: '2026-07-01',
      until: '2026-07-01',
      sourceId: 'other',
    });
    expect(otherOnly.items).toEqual([]);
  });

  test('uses stable opaque cursors and rejects malformed boundaries', async () => {
    const depthId = await insertPage({ slug: 'projects/cursors', type: 'project' });
    for (const [index, date] of ['2026-05-01', '2026-05-02'].entries()) {
      const eventId = await insertPage({
        slug: `life/events/${date}-${index}`,
        type: 'event',
        effectiveDate: `${date}T12:00:00Z`,
        event: { kind: 'commitment', what: `Follow-up ${index}` },
      });
      await insertProjection(depthId, eventId, date, `Follow-up ${index}`);
    }

    const first = await listOpenLoops(engine, {
      since: '2026-05-01',
      until: '2026-05-02',
      sourceId: 'default',
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    expect(decodeOpenLoopCursor(first.next_cursor!)).toMatchObject({
      date: '2026-05-01',
      eventPageId: first.items[0].event_page_id,
      sourceId: 'default',
    });

    const second = await listOpenLoops(engine, {
      since: '2026-05-01',
      until: '2026-05-02',
      sourceId: 'default',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.items.map(item => item.date)).toEqual(['2026-05-02']);
    expect(second.next_cursor).toBeNull();

    await expect(listOpenLoops(engine, {
      since: '2026-05-01',
      until: '2026-05-02',
      cursor: 'not-json',
    })).rejects.toBeInstanceOf(OpenLoopValidationError);
  });
});
