/**
 * Timeline materialization integration tests.
 *
 * This file configures the process-global AI gateway, so the serial suffix
 * gives it a dedicated Bun process and prevents ambient provider credentials
 * from triggering live embeddings against the fixture schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  composeTimelineView,
  type TimelineViewRow,
} from '../src/core/timeline-view.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
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
  if (timeline) {
    await engine.executeRaw(
      `UPDATE pages SET timeline = $1 WHERE slug = $2 AND source_id = 'default'`,
      [timeline, 'companies/acme-example'],
    );
  }
}

function viewRow(overrides: Partial<TimelineViewRow>): TimelineViewRow {
  return {
    id: 1,
    page_id: 1,
    date: '2026-07-31',
    summary: 'Bare event',
    event_page_id: null,
    event_slug: null,
    event_deleted_at: null,
    ref_slug: null,
    ref_label: null,
    ...overrides,
  };
}

describe('read-time timeline view', () => {
  test('renders date-desc/id-asc rows in all three canonical shapes', () => {
    expect(composeTimelineView([
      viewRow({ id: 4, date: '2026-07-30', summary: 'Bare event' }),
      viewRow({
        id: 2,
        summary: 'Reviewed the change',
        ref_slug: 'sources/github/456',
        ref_label: 'review thread',
      }),
      viewRow({
        id: 1,
        summary: 'Launch Dinner',
        event_page_id: 22,
        event_slug: 'life/events/2026-07-31-launch',
      }),
    ])).toBe(
      '## Timeline\n\n' +
      '- 2026-07-31 — [[life/events/2026-07-31-launch|Launch Dinner]]\n' +
      '- 2026-07-31 — Reviewed the change [[sources/github/456|review thread]]\n' +
      '- 2026-07-30 — Bare event',
    );
  });

  test('skips soft-deleted event projections and returns empty for no rows', () => {
    expect(composeTimelineView([
      viewRow({
        event_page_id: 22,
        event_slug: 'life/events/2026-07-31-deleted',
        event_deleted_at: new Date('2026-07-31T12:00:00Z'),
      }),
    ])).toBe('');
    expect(composeTimelineView([])).toBe('');
  });

  test('getPage ignores stored Markdown and composes active rows', async () => {
    await putTarget('## Timeline\n\n- 1999-01-01 — stale stored copy');
    await engine.putPage('life/events/2026-07-31-launch', {
      type: 'event',
      title: 'Launch',
      compiled_truth: '# Launch',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('life/events/2026-07-30-deleted', {
      type: 'event',
      title: 'Deleted',
      compiled_truth: '# Deleted',
      timeline: '',
      frontmatter: {},
    });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE slug = $1 AND source_id = 'default'`,
      ['life/events/2026-07-30-deleted'],
    );
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary, event_page_id)
       SELECT target.id, $1::date, $2, event.id
         FROM pages target, pages event
        WHERE target.slug = $3 AND event.slug = $4`,
      ['2026-07-31', 'Launch summary', 'companies/acme-example', 'life/events/2026-07-31-launch'],
    );
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary, event_page_id)
       SELECT target.id, $1::date, $2, event.id
         FROM pages target, pages event
        WHERE target.slug = $3 AND event.slug = $4`,
      ['2026-07-30', 'Deleted summary', 'companies/acme-example', 'life/events/2026-07-30-deleted'],
    );

    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n- 2026-07-31 — [[life/events/2026-07-31-launch|Launch summary]]',
    );
    const listed = await engine.listPages({ slugPrefix: 'companies/acme-example' });
    expect(listed[0]?.timeline).toBe(
      '## Timeline\n\n- 2026-07-31 — [[life/events/2026-07-31-launch|Launch summary]]',
    );
    const stale = await engine.listStalePagesForExtraction({ batchSize: 20 });
    expect(stale.find(page => page.slug === 'companies/acme-example')?.timeline).toBe(
      '## Timeline\n\n- 2026-07-31 — [[life/events/2026-07-31-launch|Launch summary]]',
    );
  });

  test('writePageThrough serializes the composed timeline view', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-timeline-view-'));
    try {
      await putTarget('## Timeline\n\n- 1999-01-01 — stale stored copy');
      await engine.addTimelineEntry('companies/acme-example', {
        date: '2026-07-31',
        summary: 'Durable row',
      });
      await engine.setConfig('sync.repo_path', repo);

      const result = await writePageThrough(engine, 'companies/acme-example');

      expect(result.written).toBe(true);
      expect(readFileSync(join(repo, 'companies/acme-example.md'), 'utf8')).toContain(
        '<!-- timeline -->\n\n## Timeline\n\n- 2026-07-31 — Durable row',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('put_page timeline import', () => {
  test('the shared importer converts Timeline Markdown for non-put_page callers', async () => {
    const result = await importFromContent(
      engine,
      'companies/direct-import',
      `---
type: company
title: Direct Import
---

# Direct Import

<!-- timeline -->

## Timeline

- 2026-07-31 — Imported through shared pipeline
`,
      { noEmbed: true },
    );

    expect(result.timeline_import).toEqual({
      imported: 1,
      skipped_duplicates: 0,
      dropped: 0,
    });
    expect((await engine.getPage('companies/direct-import'))?.timeline).toContain(
      '- 2026-07-31 — Imported through shared pipeline',
    );
    const stored = await engine.executeRaw<{ timeline: string }>(
      `SELECT timeline FROM pages WHERE slug = 'companies/direct-import'`,
    );
    expect(stored[0]?.timeline).toBe('');
  });

  test('a body-only rewrite cannot erase the composed timeline', async () => {
    await putTarget();
    await engine.addTimelineEntry('companies/acme-example', {
      date: '2026-07-31',
      summary: 'Survives rewrite',
    });

    const result = await operationsByName.put_page.handler(makeContext(), {
      slug: 'companies/acme-example',
      content: '---\ntype: company\ntitle: Acme Example\n---\n\n# Acme Example\n\nRewritten body.',
    });

    expect(result).not.toHaveProperty('timeline_import');
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n- 2026-07-31 — Survives rewrite',
    );
    const stored = await engine.executeRaw<{ timeline: string }>(
      `SELECT timeline FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['companies/acme-example'],
    );
    expect(stored[0]?.timeline).toBe('');
  });

  test('imports supported shapes and Chronicle projections with idempotent counts', async () => {
    await engine.putPage('sources/github/456', {
      type: 'source',
      title: 'Issue 456',
      compiled_truth: '# Issue 456',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('life/events/2026-07-31-launch', {
      type: 'event',
      title: 'Launch Dinner',
      compiled_truth: '# Launch Dinner',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('life/events/2026-07-26-deleted', {
      type: 'event',
      title: 'Deleted Event',
      compiled_truth: '# Deleted Event',
      timeline: '',
      frontmatter: {},
    });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now()
        WHERE source_id = 'default' AND slug = 'life/events/2026-07-26-deleted'`,
    );
    const content = `---
type: company
title: Acme Example
---

# Acme Example

<!-- timeline -->

## Timeline

- 2026-07-31 — [[life/events/2026-07-31-launch|Launch Dinner]]
- 2026-07-30 — Reviewed change [[sources/github/456|review thread]]
- 2026-07-29 — Missing ref remains visible [[sources/github/missing|missing issue]]
- 2026-07-28 — Bare event
- **2026-07-27** | Legacy event
- 2026-07-26 — [[life/events/2026-07-26-deleted|Deleted Event]]
- 2026-07-25 — [[life/events/2026-07-25-missing|Missing Event]]
- not parseable
`;

    const first = await operationsByName.put_page.handler(makeContext(), {
      slug: 'companies/acme-example',
      content,
    });
    expect(first).toMatchObject({
      status: 'created_or_updated',
      timeline_import: { imported: 5, skipped_duplicates: 0, dropped: 3 },
    });

    const rows = await engine.executeRaw<{
      summary: string;
      ref_slug: string | null;
      ref_label: string | null;
    }>(
      `SELECT summary, ref_slug, ref_label
         FROM timeline_entries
        ORDER BY date DESC, id ASC`,
    );
    expect(rows).toEqual([
      { summary: 'Launch Dinner', ref_slug: null, ref_label: null },
      { summary: 'Reviewed change', ref_slug: 'sources/github/456', ref_label: 'review thread' },
      { summary: 'Missing ref remains visible', ref_slug: null, ref_label: null },
      { summary: 'Bare event', ref_slug: null, ref_label: null },
      { summary: 'Legacy event', ref_slug: null, ref_label: null },
    ]);
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n' +
      '- 2026-07-31 — [[life/events/2026-07-31-launch|Launch Dinner]]\n' +
      '- 2026-07-30 — Reviewed change [[sources/github/456|review thread]]\n' +
      '- 2026-07-29 — Missing ref remains visible\n' +
      '- 2026-07-28 — Bare event\n' +
      '- 2026-07-27 — Legacy event',
    );
    await engine.executeRaw(
      `UPDATE timeline_entries
          SET detail = 'Private Chronicle detail', owner = 'people/alice-example'
        WHERE event_page_id IS NOT NULL`,
    );

    const second = await operationsByName.put_page.handler(makeContext(), {
      slug: 'companies/acme-example',
      content,
    });
    expect(second).toMatchObject({
      timeline_import: { imported: 0, skipped_duplicates: 5, dropped: 3 },
    });
    const projection = await engine.executeRaw<{ detail: string; owner: string | null }>(
      `SELECT detail, owner FROM timeline_entries WHERE event_page_id IS NOT NULL`,
    );
    expect(projection).toEqual([{
      detail: 'Private Chronicle detail',
      owner: 'people/alice-example',
    }]);
  });
});

describe('add_timeline_entry row-only write', () => {
  test('stores validated refs, preserves dedupe, and never writes stored Markdown', async () => {
    await putTarget('## Timeline\n\n- 1999-01-01 — old copy');
    await engine.putPage('sources/github/123', {
      type: 'source',
      title: 'GitHub issue 123',
      compiled_truth: '# GitHub issue 123',
      timeline: '',
      frontmatter: {},
    });
    const params = {
      slug: 'companies/acme-example',
      date: '2026-07-31',
      summary: 'Shipped the release',
      ref: 'sources/github/123',
      ref_label: 'release issue',
    };

    const firstInsert = await operationsByName.add_timeline_entry.handler(makeContext(), params);
    expect(firstInsert).toMatchObject({ status: 'ok', inserted: true });
    // A real insert refreshes the space write-through mirror (best-effort;
    // unconfigured test env reports written:false rather than failing).
    expect((firstInsert as { write_through?: { written: boolean } }).write_through)
      .toBeDefined();
    expect(await operationsByName.add_timeline_entry.handler(makeContext(), params))
      .toEqual({ status: 'ok', inserted: false });

    const rows = await engine.executeRaw<{
      ref_slug: string | null;
      ref_label: string | null;
    }>(`SELECT ref_slug, ref_label FROM timeline_entries`);
    expect(rows).toEqual([{ ref_slug: 'sources/github/123', ref_label: 'release issue' }]);
    const stored = await engine.executeRaw<{ timeline: string }>(
      `SELECT timeline FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['companies/acme-example'],
    );
    expect(stored[0]?.timeline).toBe('## Timeline\n\n- 1999-01-01 — old copy');
  });
});

describe('timeline_import legacy migration', () => {
  test('is exposed as the local-only admin timeline-import command', () => {
    expect(operationsByName.timeline_import).toMatchObject({
      scope: 'admin',
      localOnly: true,
      cliHints: { name: 'timeline-import' },
    });
    expect(operationsByName.timeline_materialize).toBeUndefined();
  });

  test('imports stored legacy sections idempotently without rewriting pages', async () => {
    await engine.putPage('life/events/2026-07-29-owned', {
      type: 'event',
      title: 'Chronicle owned',
      compiled_truth: '# Chronicle owned',
      timeline: '',
      frontmatter: {},
    });
    await putTarget(
      '## Timeline\n\n' +
      '- 2026-07-31 — New row\n' +
      '- **2026-07-30** | Legacy row\n' +
      '- 2026-07-29 — [[life/events/2026-07-29-owned|Chronicle-owned]]\n' +
      '- malformed',
    );

    const preview = await operationsByName.timeline_import.handler(makeContext(), {
      source: 'default',
      dry_run: true,
    });
    expect(preview).toEqual({
      pages_scanned: 1,
      imported: 3,
      skipped_duplicates: 0,
      dropped: 1,
      mirrored: 0,
    });
    expect(await engine.getTimeline('companies/acme-example')).toHaveLength(0);

    const first = await operationsByName.timeline_import.handler(makeContext(), {
      source: 'default',
    });
    expect(first).toEqual({
      pages_scanned: 1,
      imported: 3,
      skipped_duplicates: 0,
      dropped: 1,
      mirrored: 0,
    });
    const second = await operationsByName.timeline_import.handler(makeContext(), {
      source: 'default',
    });
    expect(second).toEqual({
      pages_scanned: 1,
      imported: 0,
      skipped_duplicates: 3,
      dropped: 1,
      mirrored: 0,
    });

    const stored = await engine.executeRaw<{ timeline: string }>(
      `SELECT timeline FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['companies/acme-example'],
    );
    expect(stored[0]?.timeline).toContain('- **2026-07-30** | Legacy row');
    expect((await engine.getPage('companies/acme-example'))?.timeline).toBe(
      '## Timeline\n\n' +
      '- 2026-07-31 — New row\n' +
      '- 2026-07-30 — Legacy row\n' +
      '- 2026-07-29 — [[life/events/2026-07-29-owned|Chronicle-owned]]',
    );
  });
});
