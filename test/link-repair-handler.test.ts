import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  makeLinkRepairHandler,
  parseLinkRepairInput,
  type LinkRepairDependencies,
} from '../src/core/minions/handlers/link-repair.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { isProtectedJobName } from '../src/core/minions/protected-names.ts';

function makeJob(data: Record<string, unknown>) {
  const progress: unknown[] = [];
  const job = {
    id: 42,
    name: 'link_repair',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    async updateProgress(value: unknown) { progress.push(value); },
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  } as MinionJobContext;
  return { job, progress };
}

function makeDependencies(
  completed: string[] = [],
): { dependencies: LinkRepairDependencies; calls: string[]; recorded: string[][] } {
  const calls: string[] = [];
  const recorded: string[][] = [];
  const dependencies: LinkRepairDependencies = {
    async loadCompleted() { return completed; },
    async recordCompleted(_engine, _key, keys) { recorded.push([...keys]); return true; },
    async buildGazetteer() { calls.push('gazetteer'); return new Map(); },
    async extractMentions() {
      calls.push('mentions');
      return { created: 2, pages: 3 };
    },
    async extractNer() {
      calls.push('ner');
      return { created: 1, pages: 3, pack_unavailable: false };
    },
    async extractLinks() {
      calls.push('links');
      return { created: 4, pages: 3, unresolved: [] };
    },
    async extractTimeline() {
      calls.push('timeline');
      return {
        meetings_scanned: 1,
        entries_created: 2,
        entities_touched: 2,
        batch_errors: 0,
        materialized_backlinks_written: 0,
        materialized_backlink_errors: 0,
      };
    },
    async auditBacklinks() {
      calls.push('backlinks');
      return {
        action: 'check',
        mode: 'graph',
        gaps_found: 0,
        fixed: 0,
        pages_affected: 0,
        dryRun: false,
      };
    },
  };
  return { dependencies, calls, recorded };
}

describe('link_repair input', () => {
  test('is protected from untrusted remote submission', () => {
    expect(isProtectedJobName('link_repair')).toBe(true);
  });

  test('requires a source and bounds optional filters', () => {
    expect(() => parseLinkRepairInput({})).toThrow('source_id');
    expect(() => parseLinkRepairInput({ source_id: '../bad' })).toThrow();
    expect(() => parseLinkRepairInput({
      source_id: 'wiki',
      run_id: 'nightly-maintenance:2026-07-28',
      prefix: '../bad',
    })).toThrow('prefix');
    expect(parseLinkRepairInput({
      source_id: 'wiki',
      prefix: 'people/',
      types: ['person', 'company', 'person'],
      dry_run: true,
      run_id: 'nightly-maintenance:2026-07-28',
    })).toEqual({
      source_id: 'wiki',
      prefix: 'people/',
      types: ['company', 'person'],
      dry_run: true,
      run_id: 'nightly-maintenance:2026-07-28',
    });
  });
});

describe('link_repair handler', () => {
  test('runs deterministic stages in order and checkpoints each successful stage', async () => {
    const { dependencies, calls, recorded } = makeDependencies();
    const { job, progress } = makeJob({
      source_id: 'wiki',
      run_id: 'nightly-maintenance:2026-07-28',
    });
    const handler = makeLinkRepairHandler({} as BrainEngine, dependencies);

    const result = await handler(job);

    expect(calls).toEqual(['gazetteer', 'mentions', 'ner', 'links', 'timeline', 'backlinks']);
    expect(recorded.at(-1)).toEqual([
      'gazetteer',
      'mentions',
      'ner',
      'links',
      'timeline',
      'backlinks',
    ]);
    expect(progress).toHaveLength(7);
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', done: 6, total: 6 });
    expect(result).toMatchObject({
      source_id: 'wiki',
      resumed: false,
      stages: {
        mentions: { created: 2 },
        ner: { created: 1 },
        links: { created: 4 },
        timeline: { entries_created: 2 },
        backlinks: { mode: 'graph' },
      },
    });
  });

  test('resumes from durable stage checkpoints', async () => {
    const { dependencies, calls, recorded } = makeDependencies(['gazetteer', 'mentions']);
    const { job } = makeJob({
      source_id: 'wiki',
      run_id: 'nightly-maintenance:2026-07-28',
    });

    const result = await makeLinkRepairHandler({} as BrainEngine, dependencies)(job);

    expect(calls).toEqual(['gazetteer', 'ner', 'links', 'timeline', 'backlinks']);
    expect(recorded.at(-1)).toEqual([
      'gazetteer',
      'mentions',
      'ner',
      'links',
      'timeline',
      'backlinks',
    ]);
    expect(result).toMatchObject({ resumed: true });
  });

  test('dry-run never persists a completion checkpoint', async () => {
    const { dependencies, recorded } = makeDependencies();
    const { job } = makeJob({
      source_id: 'wiki',
      run_id: 'nightly-maintenance:2026-07-28',
      dry_run: true,
    });

    await makeLinkRepairHandler({} as BrainEngine, dependencies)(job);

    expect(recorded).toEqual([]);
  });
});
