import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { runImport } from '../src/commands/import.ts';
import { performSync } from '../src/commands/sync.ts';
import { importFromFile } from '../src/core/import-file.ts';
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
      batch_id: null,
    }]);
  });

  test('one CLI import run stamps every file with one server batch id', async () => {
    const dir = makeImportDir({
      'one.md': '---\ntitle: One\ntype: note\n---\n\nFirst historical page.',
      'two.md': '---\ntitle: Two\ntype: note\n---\n\nSecond historical page.',
    });

    const result = await runImport(engine, [dir, '--no-embed']);
    expect(result.imported).toBe(2);

    const rows = await mutations();
    expect(rows.map(row => row.actor)).toEqual(['cli:import', 'cli:import']);
    expect(rows.map(row => row.write_intent)).toEqual(['backfill', 'backfill']);
    expect(rows[0]?.batch_id).toMatch(/^import:/);
    expect(rows[1]?.batch_id).toBe(rows[0]?.batch_id);
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
});
