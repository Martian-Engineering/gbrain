import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { listOpenLoops } from '../../src/core/open-loops.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const skip = !hasDatabase();

if (skip) test.skip('list_open_loops Postgres parity skipped (DATABASE_URL unset)', () => {});

describe.skipIf(skip)('list_open_loops Postgres parity', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('filters resolved events before keyset pagination', async () => {
    const depthRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, frontmatter)
       VALUES ('default', 'projects/postgres-parity', 'project', 'Parity', '{}'::jsonb)
       RETURNING id`,
    );
    const eventRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
       VALUES
         ('default', 'life/events/2026-04-01-first', 'event', 'First',
          '2026-04-01T12:00:00Z', '{"event":{"kind":"commitment","what":"First follow-up"}}'::jsonb),
         ('default', 'life/events/2026-04-02-second', 'event', 'Second',
          '2026-04-02T12:00:00Z', '{"event":{"kind":"intro","what":"Second follow-up"}}'::jsonb)
       RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
       VALUES
         ($1, '2026-04-01', 'test:event', 'First projection', '', $2),
         ($1, '2026-04-02', 'test:event', 'Second projection', '', $3)`,
      [depthRows[0].id, eventRows[0].id, eventRows[1].id],
    );
    await engine.executeRaw(
      `INSERT INTO tags (page_id, tag) VALUES ($1, 'desk:done')`,
      [eventRows[0].id],
    );

    const page = await listOpenLoops(engine, {
      since: '2026-04-01',
      until: '2026-04-02',
      sourceId: 'default',
      limit: 1,
    });

    expect(page).toMatchObject({
      schema_version: 1,
      next_cursor: null,
      items: [{
        date: '2026-04-02',
        kind: 'intro',
        summary: 'Second follow-up',
        source_page_slugs: ['projects/postgres-parity'],
      }],
    });
  });
});
