/**
 * v0.42.x — Life Chronicle (#2390) auto-emit extractor (Phase A.3).
 * PGLite in-memory. Covers eligibility, the extractor's parse barrier +
 * idempotent writes (event pages + timeline projection), and the backstop's
 * auto_chronicle gating + enqueue. The LLM judge is stubbed so the deterministic
 * write path is tested without a gateway.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import {
  JUDGE_SYSTEM,
  isValidProposal,
  parseJudgeJson,
  runChronicleExtract,
  type ChronicleJudge,
} from '../src/core/chronicle/extract-events.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';

let engine: PGLiteEngine;
const LONG_BODY = 'A'.repeat(120);

async function countEvents(): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'event'`);
  return Number(r[0].n);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('isChronicleEligible', () => {
  const body = LONG_BODY;
  test('meeting is eligible', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('meetings/ slug rescues a note-typed page', () => {
    expect(isChronicleEligible({ type: 'note', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('diary is excluded (privacy)', () => {
    expect(isChronicleEligible({ type: 'diary', slug: 'life/diary/x', body })).toEqual({ ok: false, reason: 'diary_excluded' });
  });
  test('event is excluded (anti-loop)', () => {
    expect(isChronicleEligible({ type: 'event', slug: 'life/events/x', body })).toEqual({ ok: false, reason: 'event_self' });
  });
  test('dream-generated is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body, dreamGenerated: true })).toEqual({ ok: false, reason: 'dream_generated' });
  });
  test('too-short body is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body: 'hi' })).toEqual({ ok: false, reason: 'too_short' });
  });
  test('unrelated type is excluded', () => {
    expect(isChronicleEligible({ type: 'concept', slug: 'wiki/concepts/x', body })).toEqual({ ok: false, reason: 'kind:concept' });
  });
});

describe('runChronicleExtract', () => {
  const oneEvent: ChronicleJudge = async () => ({
    events: [{
      when: '2026-06-18T15:30:00Z',
      who: ['people/sarah-chen', 'people/bob'],
      owner: 'people/sarah-chen',
      what: 'Sarah committed to Q3',
      kind: 'commitment',
    }],
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = 'meetings/2026-06-18-sync'`);
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Weekly sync',
      compiled_truth: LONG_BODY,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
  });

  test('writes an event page + timeline projection', async () => {
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
    expect(day[0].summary).toBe('Sarah committed to Q3');
    expect(day[0].page_slug).toBe('meetings/2026-06-18-sync'); // projection keyed to depth
    expect(day[0].event_slug?.startsWith('life/events/2026-06-18-')).toBe(true);
    expect(day[0].kind).toBe('commitment');
    expect(day[0].owner).toBe('people/sarah-chen');
    const event = await engine.getPage(day[0].event_slug!, { sourceId: 'default' });
    expect((event?.frontmatter.event as Record<string, unknown>).owner).toBe('people/sarah-chen');
  });

  test('is idempotent: running twice yields one event + one projection', async () => {
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
  });

  test('rephrased output supersedes the prior event and removes its projection', async () => {
    const first = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });
    const firstDay = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const priorSlug = firstDay[0].event_slug!;
    await engine.putPage('people/sarah-chen', {
      type: 'person',
      title: 'Sarah Chen',
      compiled_truth: '# Sarah Chen',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertEventProjection({
      depthSlug: 'people/sarah-chen',
      eventSlug: priorSlug,
      date: '2026-06-18',
      summary: 'Sarah committed to the Q3 follow-up',
      sourceId: 'default',
    });
    const priorBefore = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM timeline_entries te
         JOIN pages ep ON ep.id = te.event_page_id
        WHERE ep.slug = $1`,
      [priorSlug],
    );
    expect(priorBefore[0]?.n).toBe(2);

    const rephrased: ChronicleJudge = async () => ({
      events: [{
        when: '2026-06-18T15:30:00Z',
        who: ['people/sarah-chen', 'people/bob'],
        owner: 'people/sarah-chen',
        what: 'Sarah took ownership of the Q3 follow-up',
        kind: 'commitment',
      }],
    });
    const second = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: rephrased,
    });

    expect(first.events_superseded).toBe(0);
    expect(first.events_kept_tagged).toBe(0);
    expect(second.events_superseded).toBe(1);
    expect(second.events_kept_tagged).toBe(0);
    expect(await engine.getPage(priorSlug, { sourceId: 'default' })).toBeNull();
    expect(await engine.getPage(priorSlug, {
      sourceId: 'default',
      includeDeleted: true,
    })).not.toBeNull();
    const priorAfter = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM timeline_entries te
         JOIN pages ep ON ep.id = te.event_page_id
        WHERE ep.slug = $1`,
      [priorSlug],
    );
    expect(priorAfter[0]?.n).toBe(0);

    const projections = await engine.executeRaw<{ event_slug: string }>(
      `SELECT ep.slug AS event_slug
         FROM timeline_entries te
         JOIN pages ep ON ep.id = te.event_page_id
        ORDER BY ep.slug`,
    );
    expect(projections).toHaveLength(1);
    expect(projections[0].event_slug).not.toBe(priorSlug);
  });

  test('concurrent extracts serialize replace-set writes for one depth page', async () => {
    let judgesReady = 0;
    let releaseJudges!: () => void;
    const bothJudgesReady = new Promise<void>((resolve) => {
      releaseJudges = resolve;
    });
    const judge = (what: string): ChronicleJudge => async () => {
      judgesReady++;
      if (judgesReady === 2) releaseJudges();
      await bothJudgesReady;
      return {
        events: [{
          when: '2026-06-18T15:30:00Z',
          who: ['people/sarah-chen'],
          what,
          kind: 'commitment',
        }],
      };
    };

    await Promise.all([
      runChronicleExtract(engine, {
        slug: 'meetings/2026-06-18-sync',
        judge: judge('Sarah owns the Q3 follow-up'),
      }),
      runChronicleExtract(engine, {
        slug: 'meetings/2026-06-18-sync',
        judge: judge('Sarah took the Q3 action item'),
      }),
    ]);

    const activeEvents = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pages
        WHERE deleted_at IS NULL
          AND frontmatter->'event'->>'depth' = 'meetings/2026-06-18-sync'`,
    );
    const projections = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM timeline_entries WHERE event_page_id IS NOT NULL`,
    );
    expect(Number(activeEvents[0].n)).toBe(1);
    expect(Number(projections[0].n)).toBe(1);
  });

  test('no_events leaves prior events and projections untouched', async () => {
    await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });
    const priorDay = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const priorSlug = priorDay[0].event_slug!;
    const none: ChronicleJudge = async () => ({ events: [] });

    const result = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: none,
    });

    expect(result.status).toBe('no_events');
    expect(result.events_superseded).toBe(0);
    expect(result.events_kept_tagged).toBe(0);
    expect(await engine.getPage(priorSlug, { sourceId: 'default' })).not.toBeNull();
    const projections = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM timeline_entries WHERE event_page_id IS NOT NULL`,
    );
    expect(Number(projections[0].n)).toBe(1);
  });

  test('desk-tagged prior events survive supersession and are counted', async () => {
    await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });
    const priorDay = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const priorSlug = priorDay[0].event_slug!;
    await engine.addTag(priorSlug, 'desk:resolved', { sourceId: 'default' });
    const rephrased: ChronicleJudge = async () => ({
      events: [{
        when: '2026-06-18T15:30:00Z',
        who: ['people/sarah-chen', 'people/bob'],
        owner: 'people/sarah-chen',
        what: 'Sarah owns the Q3 action item',
        kind: 'commitment',
      }],
    });

    const result = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: rephrased,
    });

    expect(result.events_superseded).toBe(0);
    expect(result.events_kept_tagged).toBe(1);
    expect(await engine.getPage(priorSlug, { sourceId: 'default' })).not.toBeNull();
    const projections = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM timeline_entries WHERE event_page_id IS NOT NULL`,
    );
    expect(Number(projections[0].n)).toBe(2);
  });

  test('same-hash re-extraction preserves a user-deleted event tombstone', async () => {
    await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });
    const priorDay = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const eventSlug = priorDay[0].event_slug!;
    await engine.softDeletePage(eventSlug, { sourceId: 'default' });

    const result = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });

    expect(result.events_superseded).toBe(0);
    expect(await engine.getPage(eventSlug, { sourceId: 'default' })).toBeNull();
    const tombstone = await engine.getPage(eventSlug, {
      sourceId: 'default',
      includeDeleted: true,
    });
    expect(tombstone?.deleted_at).toBeInstanceOf(Date);
  });

  test('re-emitting an extractor-superseded hash restores that event only', async () => {
    await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });
    const firstDay = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    const originalSlug = firstDay[0].event_slug!;
    const rephrased: ChronicleJudge = async () => ({
      events: [{
        when: '2026-06-18T15:30:00Z',
        who: ['people/sarah-chen', 'people/bob'],
        owner: 'people/sarah-chen',
        what: 'Sarah took ownership of the Q3 follow-up',
        kind: 'commitment',
      }],
    });
    await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: rephrased,
    });

    const result = await runChronicleExtract(engine, {
      slug: 'meetings/2026-06-18-sync',
      judge: oneEvent,
    });

    expect(result.events_superseded).toBe(1);
    expect(await engine.getPage(originalSlug, { sourceId: 'default' })).not.toBeNull();
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day).toHaveLength(1);
    expect(day[0].event_slug).toBe(originalSlug);
  });

  test('parse barrier: a malformed proposal writes NOTHING', async () => {
    const before = await countEvents();
    const bad: ChronicleJudge = async () => ({ events: [{ when: '2026-06-18', who: [], kind: 'x' } as never] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: bad });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before); // no partial write
  });

  test('parse barrier: a non-date `when` writes NOTHING (codex fix #2)', async () => {
    const before = await countEvents();
    const badDate: ChronicleJudge = async () => ({ events: [{ when: 'not-a-date', who: [], what: 'x', kind: 'meeting' }] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: badDate });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before);
  });

  test('no events → no_events status', async () => {
    const none: ChronicleJudge = async () => ({ events: [] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: none });
    expect(r.status).toBe('no_events');
  });

  // #2606: a truncated or unparseable judge response must NOT be recorded as
  // a legitimate no_events — it gets a distinct skipped reason.
  test('truncated judge output → skipped/judge_truncated, not no_events (#2606)', async () => {
    const truncated: ChronicleJudge = async () => ({ events: [], failure: 'truncated' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: truncated });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_truncated');
    expect(await countEvents()).toBe(0);
  });

  test('unparseable judge output → skipped/judge_parse_failed (#2606)', async () => {
    const parseFailed: ChronicleJudge = async () => ({ events: [], failure: 'parse_failed' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: parseFailed });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_parse_failed');
  });
});

describe('isValidProposal owner', () => {
  const proposal = {
    when: '2026-06-18',
    who: ['people/sarah-chen', 'people/bob'],
    what: 'Sarah committed to Q3',
    kind: 'commitment',
  };

  test('accepts absent, string, or null owner', () => {
    expect(isValidProposal(proposal)).toBe(true);
    expect(isValidProposal({ ...proposal, owner: 'people/sarah-chen' })).toBe(true);
    expect(isValidProposal({ ...proposal, owner: null })).toBe(true);
  });

  test('rejects non-string owner', () => {
    expect(isValidProposal({ ...proposal, owner: ['people/sarah-chen'] })).toBe(false);
    expect(isValidProposal({ ...proposal, owner: 42 })).toBe(false);
  });
});

describe('JUDGE_SYSTEM owner attribution', () => {
  test('names the in-summary actor before attendee inference', () => {
    expect(JUDGE_SYSTEM).toContain(
      'When the "what" clause names the acting person, "owner" MUST be that person',
    );
    expect(JUDGE_SYSTEM).toContain('mapped to their attendee slug when available');
    expect(JUDGE_SYSTEM).toContain(
      'Fall back to attendee inference only when the clause is actorless',
    );
    expect(JUDGE_SYSTEM).toContain('Never default "owner" to the meeting host');
  });
});

describe('parseJudgeJson failure signalling (#2606)', () => {
  test('a legitimate empty array parses to []', () => {
    expect(parseJudgeJson('[]')).toEqual([]);
    expect(parseJudgeJson('```json\n[]\n```')).toEqual([]);
  });

  test('a valid array round-trips', () => {
    const arr = parseJudgeJson('[{"when":"2026-06-18","who":[],"what":"x","kind":"meeting"}]');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr!.length).toBe(1);
  });

  test('empty / no-array / truncated / non-array responses return null', () => {
    expect(parseJudgeJson('')).toBeNull();
    expect(parseJudgeJson('I found no events worth extracting.')).toBeNull();
    // Truncated mid-array (the maxTokens-cap shape from the issue).
    expect(parseJudgeJson('[{"when":"2026-06-18","who":["a"],"what":"long ev')).toBeNull();
    expect(parseJudgeJson('{"events": 1}')).toBeNull();
  });
});

describe('runChronicleBackstop gating', () => {
  beforeEach(async () => {
    await engine.unsetConfig('auto_chronicle');
    await engine.putPage('meetings/bs', { type: 'meeting', title: 'bs', compiled_truth: LONG_BODY });
  });

  test('skips when auto_chronicle is off (default)', async () => {
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'auto_chronicle_off' });
  });

  test('skips a diary page before consulting the flag', async () => {
    const r = await runChronicleBackstop({ slug: 'life/diary/x', type: 'diary', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'diary_excluded' });
  });

  test('enqueues a chronicle_extract job when enabled + eligible', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r.enqueued).toBe(true);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'chronicle_extract'`);
    expect(Number(jobs[0].n)).toBeGreaterThanOrEqual(1);
  });
});
