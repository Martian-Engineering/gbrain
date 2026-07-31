/**
 * Registry-driven `gbrain dream --all-sources` coverage.
 *
 * The real PGLite source registry proves archived filtering and JSONB config
 * handling. An injected cycle runner keeps the tests focused on orchestration
 * without running maintenance phases or acquiring cycle locks.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { runDream, runDreamAllSources } from '../src/commands/dream.ts';
import type { CycleOpts, CycleReport, CycleStatus } from '../src/core/cycle.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const tempDirs: string[] = [];

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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedSource(
  id: string,
  opts: {
    localPath?: string | null;
    archived?: boolean;
    config?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (id) DO UPDATE
       SET local_path = EXCLUDED.local_path,
           config = EXCLUDED.config,
           archived = EXCLUDED.archived`,
    [
      id,
      id,
      opts.localPath ?? null,
      JSON.stringify(opts.config ?? {}),
      opts.archived === true,
    ],
  );
}

function makeReport(status: CycleStatus, brainDir: string | null): CycleReport {
  return {
    schema_version: '1',
    timestamp: '2026-07-31T12:00:00.000Z',
    duration_ms: 10,
    status,
    brain_dir: brainDir,
    phases: [],
    totals: {
      lint_fixes: 0,
      backlinks_added: 0,
      pages_synced: 0,
      pages_extracted: 0,
      pages_embedded: 0,
      orphans_found: 0,
      transcripts_processed: 0,
      synth_pages_written: 0,
      patterns_written: 0,
      pages_emotional_weight_recomputed: 0,
      edges_resolved: 0,
      edges_ambiguous: 0,
      purged_sources_count: 0,
      purged_pages_count: 0,
      facts_consolidated: 0,
      consolidate_takes_written: 0,
      phantoms_redirected: 0,
      phantoms_ambiguous: 0,
      phantoms_skipped_drift: 0,
    },
  };
}

describe('runDreamAllSources', () => {
  test('--all-sources requires a connected engine', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      try {
        await runDream(null, ['--all-sources']);
        throw new Error('expected runDream to exit');
      } catch (error) {
        expect((error as Error).message).toBe('EXIT');
      }
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.flat().join(' ')).toContain(
        'gbrain dream --all-sources requires a connected brain',
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('excludes archived sources and reports dream.enabled=false opt-outs', async () => {
    await seedSource('default', { config: { dream: { enabled: false } } });
    await seedSource('enabled');
    await seedSource('opted-out', { config: { dream: { enabled: false } } });
    await seedSource('archived', { archived: true });

    const runSourceIds: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const result = await runDreamAllSources(
      engine,
      { json: true, dryRun: false, pull: false, phase: null, once: false },
      async (_engine, opts) => {
        runSourceIds.push(opts.sourceId!);
        return makeReport('clean', opts.brainDir);
      },
    );
    logSpy.mockRestore();

    expect(runSourceIds).toEqual(['enabled']);
    expect(result.entries.some((entry) => entry.source_id === 'archived')).toBe(false);
    expect(result.entries).toContainEqual({
      source_id: 'opted-out',
      skipped: 'dream.enabled=false',
    });
    expect(result.failed).toBe(false);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      source_id: 'default',
      skipped: 'dream.enabled=false',
    });
  });

  test('continues after a failed cycle and reports overall failure', async () => {
    await seedSource('default', { config: { dream: { enabled: false } } });
    await seedSource('alpha');
    await seedSource('beta');

    const runSourceIds: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const result = await runDreamAllSources(
      engine,
      { json: true, dryRun: false, pull: false, phase: null, once: false },
      async (_engine, opts) => {
        runSourceIds.push(opts.sourceId!);
        return makeReport(opts.sourceId === 'alpha' ? 'failed' : 'clean', opts.brainDir);
      },
    );
    logSpy.mockRestore();

    expect(runSourceIds).toEqual(['alpha', 'beta']);
    expect(result.failed).toBe(true);
    expect(result.entries.find((entry) => entry.source_id === 'alpha')).toMatchObject({
      source_id: 'alpha',
      report: { status: 'failed' },
    });
    expect(result.entries.find((entry) => entry.source_id === 'beta')).toMatchObject({
      source_id: 'beta',
      report: { status: 'clean' },
    });
  });

  test('continues after a thrown cycle and reports the source error', async () => {
    await seedSource('default', { config: { dream: { enabled: false } } });
    await seedSource('alpha');
    await seedSource('beta');

    const runSourceIds: string[] = [];
    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const result = await runDreamAllSources(
      engine,
      { json: true, dryRun: false, pull: false, phase: null, once: false },
      async (_engine, opts) => {
        runSourceIds.push(opts.sourceId!);
        if (opts.sourceId === 'alpha') throw new Error('alpha broke');
        return makeReport('clean', opts.brainDir);
      },
    );
    logSpy.mockRestore();

    expect(runSourceIds).toEqual(['alpha', 'beta']);
    expect(result.failed).toBe(true);
    expect(result.entries).toContainEqual({ source_id: 'alpha', error: 'alpha broke' });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      source_id: 'alpha',
      error: 'alpha broke',
    });
  });

  test('resolves existing source checkouts and runs missing checkouts DB-only', async () => {
    const checkout = mkdtempSync(join(tmpdir(), 'gbrain-dream-all-'));
    tempDirs.push(checkout);
    await seedSource('default', { config: { dream: { enabled: false } } });
    await seedSource('file-backed', { localPath: checkout });
    await seedSource('db-only', { localPath: null });

    const calls = new Map<string, CycleOpts>();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const result = await runDreamAllSources(
      engine,
      {
        json: false,
        dryRun: true,
        pull: true,
        phase: 'lint',
        once: true,
        bypassDreamGuard: true,
      },
      async (_engine, opts) => {
        calls.set(opts.sourceId!, opts);
        return makeReport('clean', opts.brainDir);
      },
    );
    logSpy.mockRestore();

    expect(result.failed).toBe(false);
    expect(calls.get('file-backed')).toMatchObject({
      brainDir: resolve(checkout),
      sourceId: 'file-backed',
      dryRun: true,
      pull: true,
      phases: ['lint'],
      synthBypassDreamGuard: true,
      onceForPhase: 'lint',
    });
    expect(calls.get('db-only')).toMatchObject({
      brainDir: null,
      sourceId: 'db-only',
    });
  });

  test('human output prints a source header and the single-source summary', async () => {
    await seedSource('default', { config: { dream: { enabled: false } } });
    await seedSource('alpha');

    const lines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await runDreamAllSources(
      engine,
      { json: false, dryRun: false, pull: false, phase: null, once: false },
      async (_engine, opts) => makeReport('clean', opts.brainDir),
    );
    logSpy.mockRestore();

    expect(lines.join('\n')).toContain('=== Dream source: alpha ===');
    expect(lines.join('\n')).toContain('Brain is healthy.');
  });
});
