import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __testing, runTakes } from '../src/commands/takes.ts';
import type { BrainEngine, Take, TakesListOpts } from '../src/core/engine.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { withEnv } from './helpers/with-env.ts';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('gbrain takes supersede --id', () => {
  test('accepts only whole positive safe-integer take ids', () => {
    expect(__testing.parsePositiveTakeId('42')).toBe(42);
    expect(__testing.parsePositiveTakeId('42abc')).toBeNull();
    expect(__testing.parsePositiveTakeId('0')).toBeNull();
    expect(__testing.parsePositiveTakeId('-1')).toBeNull();
    expect(__testing.parsePositiveTakeId('9007199254740992')).toBeNull();
  });

  test('resolves takes.id to row_num before superseding', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-id-brain-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-id-home-'));
    tmpRoots.push(brainDir, home);

    const pagePath = join(brainDir, 'people/alice.md');
    mkdirSync(dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, renderTakesFence([{
      rowNum: 7,
      claim: 'Alice is the CTO',
      kind: 'fact',
      holder: 'garry',
      weight: 0.9,
      active: true,
    }]));

    const calls: Array<{ pageId: number; rowNum: number }> = [];
    const target = {
      id: 42,
      page_id: 22,
      page_slug: 'people/alice',
      row_num: 7,
      claim: 'Alice is the CTO',
      kind: 'fact',
      holder: 'garry',
      weight: 0.9,
      active: true,
    } as Take;
    const engine = {
      getConfig: async () => null,
      executeRaw: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sources WHERE id = $1')) return [{ id: params[0] }];
        if (sql.includes('FROM sources WHERE local_path IS NOT NULL')) return [];
        if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) return [{ id: 22 }];
        if (sql.includes('FROM takes WHERE id = $1 AND page_id = $2')) {
          expect(params).toEqual([42, 22]);
          return [{ row_num: 7 }];
        }
        return [];
      },
      listTakes: async (opts: TakesListOpts) => opts.active === true ? [target] : [],
      supersedeTake: async (pageId: number, rowNum: number) => {
        calls.push({ pageId, rowNum });
        return { oldRow: rowNum, newRow: 8 };
      },
    } as unknown as BrainEngine;

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'supersede',
        'people/alice',
        '--id',
        '42',
        '--claim',
        'Alice is the CFO',
        '--dir',
        brainDir,
      ]);
    });

    expect(calls).toEqual([{ pageId: 22, rowNum: 7 }]);
    expect(existsSync(pagePath)).toBe(true);
    const body = readFileSync(pagePath, 'utf-8');
    expect(body).toContain('~~Alice is the CTO~~');
    expect(body).toContain('Alice is the CFO');
  });
});
