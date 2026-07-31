/**
 * lore-04c — subagent slug whitespace rejection.
 *
 * Ingestion Minions transcribe uppercase artifact ULIDs into capture slugs
 * and intermittently insert a space mid-ULID (observed on GPT-5.6: 19
 * malformed `sources/<provider>/...` pages on 2026-07-31). The fence in
 * enforceSubagentSlugFence now rejects any whitespace in a subagent-authored
 * slug so the bad write fails loudly and the model retries with the correct
 * slug, instead of landing durable duplicate debris it cannot delete.
 *
 * Non-subagent callers keep accepting space-containing slugs — those are a
 * supported identity for filename-derived sync imports (Apple Notes), per
 * test/slug-validation.test.ts.
 *
 * Uses dryRun ctxs — the fence runs BEFORE the dry-run short-circuit, so no
 * engine is needed (same pattern as test/timeline-entry-subagent-fence.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const put_page = operations.find(o => o.name === 'put_page') as Operation;
if (!put_page) throw new Error('put_page op missing');

const BODY = { content: '# test' };

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

const SUBAGENT_CTX = {
  viaSubagent: true,
  subagentId: 42,
  allowedSlugPrefixes: ['sources/'],
} as const;

describe('subagent slug whitespace rejection (lore-04c)', () => {
  test('rejects a space inside the slug (observed Minion failure mode)', async () => {
    const ctx = makeCtx({ ...SUBAGENT_CTX });
    await expect(
      put_page.handler(ctx, { slug: 'sources/github/01kyvdr2cf4sakk rmgcx0zb2x3', ...BODY }),
    ).rejects.toThrow(OperationError);
  });

  test('rejects tab and newline whitespace', async () => {
    const ctx = makeCtx({ ...SUBAGENT_CTX });
    await expect(
      put_page.handler(ctx, { slug: 'sources/github/a\tb', ...BODY }),
    ).rejects.toThrow(/whitespace/);
    await expect(
      put_page.handler(ctx, { slug: 'sources/github/a\nb', ...BODY }),
    ).rejects.toThrow(/whitespace/);
  });

  test('rejects whitespace in the legacy wiki/agents namespace too', async () => {
    const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
    await expect(
      put_page.handler(ctx, { slug: 'wiki/agents/42/note with space', ...BODY }),
    ).rejects.toThrow(/whitespace/);
  });

  test('accepts a whitespace-free slug within the allow-list', async () => {
    const ctx = makeCtx({ ...SUBAGENT_CTX });
    const result = await put_page.handler(ctx, {
      slug: 'sources/github/01kyvdr2cf4sakkrmgcx0zb2x3',
      ...BODY,
    });
    expect(result).toMatchObject({ dry_run: true });
  });

  test('regression: non-subagent callers still accept space-containing slugs', async () => {
    const local = makeCtx({ remote: false });
    const result = await put_page.handler(local, {
      slug: 'apple-notes/2017-05-03 ohmygreen',
      ...BODY,
    });
    expect(result).toMatchObject({ dry_run: true });

    const mcp = makeCtx({ remote: true });
    const mcpResult = await put_page.handler(mcp, {
      slug: 'notes/file with space',
      ...BODY,
    });
    expect(mcpResult).toMatchObject({ dry_run: true });
  });
});
