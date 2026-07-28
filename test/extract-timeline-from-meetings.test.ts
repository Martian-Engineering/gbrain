import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGazetteer } from '../src/core/by-mention.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tempHome: string;

const activePack: Pick<SchemaPackManifest, 'page_types'> = {
  page_types: [
    {
      name: 'person',
      primitive: 'entity',
      path_prefixes: ['people/'],
      aliases: [],
      extractable: false,
      expert_routing: true,
      materialized_backlinks: false,
    },
    {
      name: 'event',
      primitive: 'temporal',
      path_prefixes: ['life/events/'],
      aliases: [],
      extractable: false,
      expert_routing: false,
      materialized_backlinks: true,
    },
  ],
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = mkdtempSync(join(tmpdir(), 'gbrain-timeline-events-'));
});

function installTimelinePack(): string {
  const packDir = join(tempHome, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packPath = join(packDir, 'pack.yaml');
  writeFileSync(packPath, `api_version: gbrain-schema-pack-v1
name: timeline-source-pack
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: advisor
    primitive: entity
    path_prefixes: [advisors/]
    aliases: []
    extractable: false
    expert_routing: false
  - name: milestone
    primitive: temporal
    path_prefixes: [milestones/]
    aliases: []
    extractable: false
    expert_routing: false
    materialized_backlinks: true
link_types: []
frontmatter_links: []
takes_kinds: [fact, take, bet, hunch]
enrichable_types: []
filing_rules: []
`, 'utf8');
  return packPath;
}

describe('extractTimelineFromMeetings event widening', () => {
  test('can write canonical timeline rows without reciprocal Markdown', async () => {
    await engine.putPage('people/casey-example', {
      type: 'person',
      title: 'Casey Example',
      compiled_truth: '# Casey Example',
      timeline: '## Timeline',
      frontmatter: {},
    });
    await engine.putPage('life/events/2026-07-26-planning', {
      type: 'event',
      title: 'Planning Session',
      compiled_truth: 'Casey Example attended.',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-07-26T18:00:00.000Z'),
      effective_date_source: 'event_date',
    });

    const gazetteer = await buildGazetteer(engine, { activePack });
    const result = await extractTimelineFromMeetings(engine, {
      gazetteer,
      activePack,
      materializeBacklinks: false,
    });

    expect(result.entries_created).toBe(1);
    expect(result.materialized_backlinks_written).toBe(0);
    expect(await engine.getTimeline('people/casey-example', { sourceId: 'default' })).toHaveLength(1);
    const page = await engine.getPage('people/casey-example', { sourceId: 'default' });
    expect(page?.timeline).not.toContain('life/events/2026-07-26-planning');
  });

  test('event pages update entity timelines through put_page and remain idempotent', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: '# Alice Example',
      timeline: '## Timeline',
      frontmatter: {},
    });
    await engine.putPage('life/events/2026-07-25-launch', {
      type: 'event',
      title: 'Launch Dinner',
      compiled_truth: 'Alice Example attended the launch dinner.',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-07-25T18:00:00.000Z'),
      effective_date_source: 'event_date',
    });

    const gazetteer = await buildGazetteer(engine, { activePack });
    const putPage = operationsByName.put_page!;
    const originalHandler = putPage.handler;
    let putPageCalls = 0;
    putPage.handler = async (...args) => {
      putPageCalls++;
      return originalHandler(...args);
    };

    try {
      await withEnv({ GBRAIN_HOME: tempHome }, async () => {
        const first = await extractTimelineFromMeetings(engine, {
          gazetteer,
        });
        const second = await extractTimelineFromMeetings(engine, {
          gazetteer,
        });

        expect(first).toMatchObject({
          meetings_scanned: 1,
          entries_created: 1,
          entities_touched: 1,
          materialized_backlinks_written: 1,
        });
        expect(second.entries_created).toBe(0);
        expect(second.materialized_backlinks_written).toBe(0);
      });
    } finally {
      putPage.handler = originalHandler;
    }

    expect(putPageCalls).toBe(1);
    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(timeline).toHaveLength(1);

    const alice = await engine.getPage('people/alice-example', { sourceId: 'default' });
    const backlink = '[[life/events/2026-07-25-launch|Launch Dinner]]';
    expect((alice?.timeline.split(backlink).length ?? 1) - 1).toBe(1);

    const links = await engine.getLinks('people/alice-example', { sourceId: 'default' });
    expect(links.some(link => link.to_slug === 'life/events/2026-07-25-launch')).toBe(true);
  });

  test('meeting propagation stays active when materialized backlinks are not mandated', async () => {
    await engine.putPage('people/bob-example', {
      type: 'person',
      title: 'Bob Example',
      compiled_truth: '# Bob Example',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('meetings/2026-07-25-review', {
      type: 'meeting',
      title: 'Quarterly Review',
      compiled_truth: 'Bob Example presented the update.',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-07-25T10:00:00.000Z'),
      effective_date_source: 'event_date',
    });

    const gazetteer = await buildGazetteer(engine, {
      activePack: { page_types: [activePack.page_types[0]!] },
    });
    const result = await extractTimelineFromMeetings(engine, {
      gazetteer,
      activePack: {
        page_types: [{
          name: 'meeting',
          primitive: 'temporal',
          aliases: [],
          materialized_backlinks: false,
        }],
      },
    });

    expect(result.entries_created).toBe(1);
    expect(result.materialized_backlinks_written).toBe(0);
    const bob = await engine.getPage('people/bob-example', { sourceId: 'default' });
    expect(bob?.timeline).not.toContain('meetings/2026-07-25-review');
  });

  test('unscoped extraction reuses each source pack for events and entity mentions', async () => {
    const packPath = installTimelinePack();
    __setPackLocatorForTests(name => name === 'timeline-source-pack' ? packPath : null);
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      ['client-a'],
    );
    await engine.setConfig('schema_pack.source.client-a', 'timeline-source-pack');
    await engine.putPage('advisors/riley-example', {
      type: 'advisor',
      title: 'Riley Example',
      compiled_truth: '# Riley Example',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'client-a' });
    await engine.putPage('milestones/2026-07-25-close', {
      type: 'milestone',
      title: 'Financing Close',
      compiled_truth: 'Riley Example joined the financing close.',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-07-25T12:00:00.000Z'),
      effective_date_source: 'event_date',
    }, { sourceId: 'client-a' });

    const result = await withEnv({
      GBRAIN_HOME: tempHome,
      GBRAIN_SCHEMA_PACK: undefined,
    }, () =>
      extractTimelineFromMeetings(engine));

    expect(result.entries_created).toBe(1);
    const timeline = await engine.getTimeline('advisors/riley-example', {
      sourceId: 'client-a',
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.source).toBe('extract-timeline-from-meetings:milestones/2026-07-25-close');
  });

  test('cross-source attendees get timeline rows without materialization failures', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      ['client-a'],
    );
    await engine.putPage('people/riley-example', {
      type: 'person',
      title: 'Riley Example',
      compiled_truth: '# Riley Example',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'client-a' });
    await engine.putPage('meetings/2026-07-25-review', {
      type: 'meeting',
      title: 'Cross-Source Review',
      compiled_truth: '',
      timeline: '',
      frontmatter: {},
      effective_date: new Date('2026-07-25T12:00:00.000Z'),
      effective_date_source: 'event_date',
    });
    await engine.addLink(
      'meetings/2026-07-25-review',
      'people/riley-example',
      'attendee',
      'attended',
      'manual',
      undefined,
      undefined,
      { fromSourceId: 'default', toSourceId: 'client-a' },
    );

    const result = await withEnv({ GBRAIN_HOME: tempHome }, () =>
      extractTimelineFromMeetings(engine));

    expect(result).toMatchObject({
      entries_created: 1,
      materialized_backlinks_written: 0,
      materialized_backlink_errors: 0,
    });
    const timeline = await engine.getTimeline('people/riley-example', {
      sourceId: 'client-a',
    });
    expect(timeline).toHaveLength(1);
  });
});
