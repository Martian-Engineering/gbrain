import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let defaultBrainDir: string;
const brainDirs: string[] = [];

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
  defaultBrainDir = mkdtempSync(join(tmpdir(), 'gbrain-supersede-op-'));
  brainDirs.push(defaultBrainDir);
  await engine.executeRaw(
    'UPDATE sources SET local_path = $1 WHERE id = $2',
    [defaultBrainDir, 'default'],
  );
});

afterEach(() => {
  for (const dir of brainDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ctx(
  sourceId = 'default',
  dryRun = false,
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun,
    remote: false,
    sourceId,
  };
}

async function seedTake(
  slug: string,
  claim: string,
  sourceId = 'default',
): Promise<{ id: number; pageId: number; rowNum: number }> {
  let brainDir = defaultBrainDir;
  if (sourceId !== 'default') {
    brainDir = mkdtempSync(join(tmpdir(), `gbrain-supersede-${sourceId}-`));
    brainDirs.push(brainDir);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path)
       VALUES ($1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [sourceId, brainDir],
    );
  }
  const body = `# ${slug}\n\n## Takes\n\n${renderTakesFence([{
    rowNum: 7,
    claim,
    kind: 'take',
    holder: 'world',
    weight: 0.8,
    sinceDate: '2026-01-01',
    untilDate: '2026-12-31',
    source: 'origin note',
    active: true,
  }])}\n`;
  const page = await engine.putPage(slug, {
    title: slug,
    type: 'note',
    compiled_truth: body,
  }, { sourceId });
  await engine.addTakesBatch([{
    page_id: page.id,
    row_num: 7,
    claim,
    kind: 'take',
    holder: 'world',
    weight: 0.8,
    since_date: '2026-01-01',
    until_date: '2026-12-31',
    source: 'origin note',
  }]);
  const path = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  const [take] = await engine.listTakes({
    page_id: page.id,
    active: true,
    sourceId,
  });
  return { id: take.id, pageId: page.id, rowNum: take.row_num };
}

async function supersede(
  operationCtx: OperationContext,
  params: Record<string, unknown>,
): Promise<{
  dry_run?: boolean;
  action?: string;
  slug: string;
  source_id: string;
  reason: string | null;
  superseded_take: {
    id: number;
    page_id: number;
    row_num: number;
    slug: string;
  };
  replacement_take: {
    id: number | null;
    page_id: number;
    row_num: number | null;
    slug: string;
    claim: string;
    kind: string;
    holder: string;
    weight: number;
  };
}> {
  return operationsByName.supersede_take.handler(
    operationCtx,
    params,
  ) as ReturnType<typeof supersede>;
}

describe('supersede_take operation contract', () => {
  test('registers a remote-capable write operation without subagent access', () => {
    const op = operationsByName.supersede_take;
    expect(op).toBeDefined();
    expect(op.scope).toBe('write');
    expect(op.mutating).toBe(true);
    expect(op.localOnly).not.toBe(true);
    expect(op.cliHints?.hidden).toBe(true);
    expect(op.params).toEqual({
      slug: {
        type: 'string',
        required: true,
        description: 'Page slug that owns the take',
      },
      take_id: {
        type: 'number',
        required: true,
        description: 'takes.id primary key of the take to supersede',
      },
      replacement: {
        type: 'string',
        required: true,
        description: 'Replacement take text (required by the current takes engine)',
      },
      reason: {
        type: 'string',
        description: 'Optional audit reason recorded in replacement source provenance',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview the validated supersession without writing',
      },
    });
    expect(BRAIN_TOOL_ALLOWLIST.has('supersede_take')).toBe(false);
  });
});

describe('supersede_take operation behavior', () => {
  test('resolves takes.id, supersedes the row, and returns audit identifiers', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');

    const result = await supersede(ctx(), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads engineering',
      reason: 'Role corrected',
    });

    expect(result).toMatchObject({
      slug,
      source_id: 'default',
      reason: 'Role corrected',
      superseded_take: {
        id: seeded.id,
        page_id: seeded.pageId,
        row_num: seeded.rowNum,
        slug,
      },
      replacement_take: {
        page_id: seeded.pageId,
        slug,
        claim: 'Alice leads engineering',
        kind: 'take',
        holder: 'world',
        weight: 0.7,
        since_date: '2026-01-01',
        until_date: '2026-12-31',
        source: 'origin note; supersession reason: Role corrected',
      },
    });
    expect(result.replacement_take.id).toBeGreaterThan(seeded.id);
    expect(result.replacement_take.row_num).toBeGreaterThan(seeded.rowNum);

    const rows = await engine.executeRaw<{
      id: number | string;
      active: boolean;
      superseded_by: number | null;
      claim: string;
    }>(
      `SELECT id, active, superseded_by, claim
         FROM takes
        WHERE page_id = $1
        ORDER BY row_num`,
      [seeded.pageId],
    );
    const oldRow = rows.find(row => Number(row.id) === seeded.id);
    const newRow = rows.find(
      row => Number(row.id) === result.replacement_take.id,
    );
    expect(oldRow).toMatchObject({
      active: false,
      superseded_by: result.replacement_take.row_num,
    });
    expect(newRow).toMatchObject({
      active: true,
      claim: 'Alice leads engineering',
    });
    const markdown = readFileSync(
      join(defaultBrainDir, `${slug}.md`),
      'utf8',
    );
    expect(markdown).toContain('~~Alice leads product~~');
    expect(markdown).toContain('Alice leads engineering');
    expect(markdown).toContain('origin note; supersession reason: Role corrected');
  });

  test('rejects an id that belongs to a different slug', async () => {
    const seeded = await seedTake('people/alice-example', 'Alice leads product');
    await seedTake('people/bob-example', 'Bob leads sales');

    await expect(supersede(ctx(), {
      slug: 'people/bob-example',
      take_id: seeded.id,
      replacement: 'Bob leads engineering',
    })).rejects.toEqual(expect.objectContaining({
      code: 'take_slug_mismatch',
      message: expect.stringContaining("belongs to slug 'people/alice-example'"),
    }));
  });

  test('rejects a missing take id within the caller write source', async () => {
    await expect(supersede(ctx(), {
      slug: 'people/alice-example',
      take_id: 999_999,
      replacement: 'Alice leads engineering',
    })).rejects.toEqual(expect.objectContaining({
      code: 'take_not_found',
      message: expect.stringContaining('999999'),
    }));
  });

  test('rejects a take whose owning page is soft-deleted', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');
    await engine.softDeletePage(slug, { sourceId: 'default' });

    await expect(supersede(ctx(), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads engineering',
    })).rejects.toEqual(expect.objectContaining({
      code: 'take_not_found',
    }));
  });

  test('rejects canonical fence drift without writing either sink', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');
    const path = join(defaultBrainDir, `${slug}.md`);
    const drifted = readFileSync(path, 'utf8').replace(
      'Alice leads product',
      'Alice leads design',
    );
    writeFileSync(path, drifted, 'utf8');

    await expect(supersede(ctx(), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads engineering',
    })).rejects.toEqual(expect.objectContaining({
      code: 'take_row_mismatch',
    }));
    const rows = await engine.executeRaw<{
      active: boolean;
      superseded_by: number | null;
    }>(
      'SELECT active, superseded_by FROM takes WHERE id = $1',
      [seeded.id],
    );
    expect(rows[0]).toEqual({ active: true, superseded_by: null });
    expect(readFileSync(path, 'utf8')).toBe(drifted);
  });

  test('rejects line breaks in take table cells without writing', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');
    const path = join(defaultBrainDir, `${slug}.md`);
    const before = readFileSync(path, 'utf8');

    for (const params of [
      {
        slug,
        take_id: seeded.id,
        replacement: 'Alice leads engineering\n```',
      },
      {
        slug,
        take_id: seeded.id,
        replacement: 'Alice leads engineering',
        reason: 'Role corrected\r\n```',
      },
    ]) {
      await expect(supersede(ctx(), params)).rejects.toEqual(
        expect.objectContaining({
          code: 'invalid_params',
          message: expect.stringContaining('line breaks'),
        }),
      );
    }
    const rows = await engine.executeRaw<{ active: boolean }>(
      'SELECT active FROM takes WHERE page_id = $1',
      [seeded.pageId],
    );
    expect(rows).toEqual([{ active: true }]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('rejects an already-superseded id without writing another row', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');
    await supersede(ctx(), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads engineering',
    });

    await expect(supersede(ctx(), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads design',
    })).rejects.toEqual(expect.objectContaining({
      code: 'take_already_superseded',
    }));
    const rows = await engine.executeRaw<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM takes WHERE page_id = $1',
      [seeded.pageId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  test('dry_run validates and previews without writing', async () => {
    const slug = 'people/alice-example';
    const seeded = await seedTake(slug, 'Alice leads product');
    const path = join(defaultBrainDir, `${slug}.md`);
    const before = readFileSync(path, 'utf8');

    const result = await supersede(ctx('default', true), {
      slug,
      take_id: seeded.id,
      replacement: 'Alice leads engineering',
      reason: 'Role corrected',
    });

    expect(result).toMatchObject({
      dry_run: true,
      action: 'supersede_take',
      reason: 'Role corrected',
      superseded_take: { id: seeded.id },
      replacement_take: {
        id: null,
        row_num: 8,
        claim: 'Alice leads engineering',
      },
    });
    const rows = await engine.executeRaw<{
      id: number | string;
      active: boolean;
    }>(
      'SELECT id, active FROM takes WHERE page_id = $1',
      [seeded.pageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: true });
    expect(Number(rows[0]?.id)).toBe(seeded.id);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('uses ctx.sourceId to isolate overlapping slugs', async () => {
    const slug = 'people/alice-example';
    const defaultTake = await seedTake(slug, 'Default-source take');
    const otherTake = await seedTake(slug, 'Other-source take', 'other');

    const result = await supersede(ctx('other'), {
      slug,
      take_id: otherTake.id,
      replacement: 'Other-source replacement',
    });

    expect(result).toMatchObject({
      source_id: 'other',
      superseded_take: { id: otherTake.id },
    });
    const defaultRows = await engine.executeRaw<{
      id: number | string;
      active: boolean;
      claim: string;
    }>(
      'SELECT id, active, claim FROM takes WHERE page_id = $1',
      [defaultTake.pageId],
    );
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0]).toMatchObject({
      active: true,
      claim: 'Default-source take',
    });
    expect(Number(defaultRows[0]?.id)).toBe(defaultTake.id);
  });
});
