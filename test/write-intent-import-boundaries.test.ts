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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { runImport } from '../src/commands/import.ts';
import { performSync, runSync } from '../src/commands/sync.ts';
import { importFromFile } from '../src/core/import-file.ts';
import {
  PROPOSE_TAKES_PROMPT_VERSION,
  runTakeMiningWork,
} from '../src/core/cycle/propose-takes.ts';
import { getTakeMiningStatus } from '../src/core/take-mining-control.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

interface MutationReceipt {
  page_slug: string;
  actor: string;
  write_intent: string;
  batch_id: string | null;
}

let engine: PGLiteEngine;
let tempDirs: string[] = [];

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
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeImportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-intent-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function mutations(): Promise<MutationReceipt[]> {
  return engine.executeRaw<MutationReceipt>(
    `SELECT page_slug, actor, write_intent, batch_id
       FROM page_mutations
      ORDER BY id`,
  );
}

describe('import write-intent boundaries', () => {
  test('importFromFile defaults unknown file imports to deferred backfill', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nHistorical prose.',
    });

    await importFromFile(engine, join(dir, 'one.md'), 'one.md', {
      noEmbed: true,
    });

    expect(await mutations()).toEqual([{
      page_slug: 'one',
      actor: 'import:file',
      write_intent: 'backfill',
      batch_id: 'mutation:1',
    }]);
  });

  test('one CLI import run stamps every file with one server batch id', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nFirst historical page.',
      'two.md': '---\ntitle: Two\ntype: note\n---\n\nSecond historical page.',
    });

    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values.map(String).join(' '));
    });
    const result = await runImport(engine, [dir, '--no-embed'])
      .finally(() => log.mockRestore());
    expect(result.imported).toBe(2);
    expect(result.batchId).toMatch(/^import:/);
    expect(logs).toContain(`  Take-mining batch: ${result.batchId}`);

    const rows = await mutations();
    expect(rows.map(row => row.actor)).toEqual(['cli:import', 'cli:import']);
    expect(rows.map(row => row.write_intent)).toEqual(['backfill', 'backfill']);
    expect(rows[0]?.batch_id).toBe(result.batchId);
    expect(rows[1]?.batch_id).toBe(rows[0]?.batch_id);
  });

  test('explicit CLI batch id is reported and drains the imported batch end to end', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nHistorical prediction.',
    });

    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values.map(String).join(' '));
    });
    const result = await runImport(engine, [
      dir,
      '--no-embed',
      '--batch-id',
      'archive-2024',
      '--json',
    ]).finally(() => log.mockRestore());
    expect(result.batchId).toBe('archive-2024');
    const summary = logs
      .map(line => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(value => value?.status === 'success');
    expect(summary?.batch_id).toBe('archive-2024');

    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    };
    const queued = await getTakeMiningStatus(ctx, {
      sourceId: 'default',
      batchId: result.batchId,
    });
    expect(queued.batch?.queuedPages).toBe(1);

    const drained = await runTakeMiningWork(ctx, {
      admission: 'deferred',
      sourceId: 'default',
      batchId: result.batchId,
      promptVersion: PROPOSE_TAKES_PROMPT_VERSION,
      pageCap: 1,
      proposalCap: 10,
      maxEstimatedSpendUsd: 1,
      _extractableTypes: ['note'],
      _estimatedPageSpendUsd: 0.01,
      extractor: async () => [],
    });
    expect(drained.pages_scanned).toBe(1);
    expect(drained.remaining_work).toBe(0);

    const settled = await getTakeMiningStatus(ctx, {
      sourceId: 'default',
      batchId: result.batchId,
    });
    expect(settled.batch).toBeNull();
  });

  test('explicit CLI import ingestion mode can classify current material as live', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nCurrent prose.',
    });

    const result = await runImport(engine, [
      dir,
      '--no-embed',
      '--ingestion-mode',
      'live',
    ]);
    expect(result.imported).toBe(1);

    expect(await mutations()).toEqual([{
      page_slug: 'one',
      actor: 'cli:import',
      write_intent: 'live_ingest',
      batch_id: expect.stringMatching(/^import:/),
    }]);
    expect(await engine.executeRaw<{ admission: string }>(
      `SELECT admission FROM take_mining_work WHERE page_slug = 'one'`,
    )).toEqual([{ admission: 'immediate' }]);
  });

  test('full sync is backfill while the next incremental commit is live ingestion', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nHistorical page.',
    });
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['add', 'one.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'],
      { cwd: dir },
    );
    const initialHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    await performSync(engine, {
      repoPath: dir,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    let rows = await mutations();
    expect(rows.at(-1)).toEqual({
      page_slug: 'one',
      actor: 'cli:sync:full',
      write_intent: 'backfill',
      batch_id: initialHead,
    });

    writeFileSync(
      join(dir, 'one.md'),
      '---\ntitle: One\ntype: note\n---\n\nCurrent semantic update.',
    );
    execFileSync('git', ['add', 'one.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'update'],
      { cwd: dir },
    );
    const updatedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    await performSync(engine, {
      repoPath: dir,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
    });

    rows = await mutations();
    expect(rows.at(-1)).toEqual({
      page_slug: 'one',
      actor: 'cli:sync:incremental',
      write_intent: 'live_ingest',
      batch_id: updatedHead,
    });
  });

  test('explicit CLI sync backfill mode defers an incremental archive commit', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nInitial page.',
    });
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['add', 'one.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial'],
      { cwd: dir },
    );
    await performSync(engine, {
      repoPath: dir,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      full: true,
    });

    writeFileSync(
      join(dir, 'one.md'),
      '---\ntitle: One\ntype: note\n---\n\nArchived historical addition.',
    );
    execFileSync('git', ['add', 'one.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'archive'],
      { cwd: dir },
    );
    const archiveHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    await runSync(engine, [
      '--repo',
      dir,
      '--source',
      'default',
      '--no-pull',
      '--no-embed',
      '--ingestion-mode',
      'backfill',
    ]);

    expect((await mutations()).at(-1)).toEqual({
      page_slug: 'one',
      actor: 'cli:sync:incremental',
      write_intent: 'backfill',
      batch_id: archiveHead,
    });
    expect(await engine.executeRaw<{ admission: string; batch_id: string }>(
      `SELECT admission, batch_id
         FROM take_mining_work
        WHERE source_id = 'default' AND page_slug = 'one'`,
    )).toEqual([{
      admission: 'deferred',
      batch_id: archiveHead,
    }]);
  });
});
