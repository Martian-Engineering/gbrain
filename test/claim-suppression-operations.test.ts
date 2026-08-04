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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { importFile } from '../src/core/import-file.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-suppress-'));
  await engine.executeRaw(
    'UPDATE sources SET local_path = $1 WHERE id = $2',
    [brainDir, 'default'],
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

async function putPage(
  slug: string,
  prose: string,
  operationContext: OperationContext = ctx(),
): Promise<void> {
  await operationsByName.put_page.handler(operationContext, {
    slug,
    content: `---\ntitle: Suppression test\n---\n\n${prose}`,
  });
}

async function listClaims(slug: string) {
  return operationsByName.list_suppressed_claims.handler(ctx(), { slug }) as Promise<{
    schema_version: 1;
    count: number;
    suppressed_claims: Array<{
      claim_text: string;
      reason: string;
      suppressed_at: string;
      provenance: string;
      active: boolean;
    }>;
  }>;
}

describe('claim suppression operation contract', () => {
  test('registers remote-capable read/write operations and CLI names', () => {
    expect(operationsByName.suppress_claim.scope).toBe('write');
    expect(operationsByName.suppress_claim.mutating).toBe(true);
    expect(operationsByName.suppress_claim.localOnly).not.toBe(true);
    expect(operationsByName.suppress_claim.cliHints?.name).toBe('suppress-claim');

    expect(operationsByName.unsuppress_claim.scope).toBe('write');
    expect(operationsByName.unsuppress_claim.mutating).toBe(true);
    expect(operationsByName.unsuppress_claim.localOnly).not.toBe(true);
    expect(operationsByName.unsuppress_claim.cliHints?.name).toBe('unsuppress-claim');

    expect(operationsByName.list_suppressed_claims.scope).toBe('read');
    expect(operationsByName.list_suppressed_claims.localOnly).not.toBe(true);
    expect(operationsByName.list_suppressed_claims.cliHints?.hidden).toBe(true);
  });

  test('suppresses idempotently and writes the fence through to markdown', async () => {
    const slug = 'wiki/personal/patterns/launch-timing';
    await putPage(slug, 'The launch is Friday.');

    const first = await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
      reason: 'The date moved',
    }) as Record<string, unknown>;
    const second = await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: '  the   launch IS friday. ',
      reason: 'Duplicate request',
    }) as Record<string, unknown>;

    expect(first).toMatchObject({ slug, suppressed: true, noop: false });
    expect(second).toMatchObject({ slug, suppressed: false, noop: true });
    const listed = await listClaims(slug);
    expect(listed.count).toBe(1);
    expect(listed.suppressed_claims[0]).toMatchObject({
      claim_text: 'The launch is Friday.',
      reason: 'The date moved',
      provenance: 'cli:suppress_claim',
      active: true,
    });

    const filePath = join(brainDir, `${slug}.md`);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toContain('gbrain:suppressions:begin');
  });

  test('fail-closed remote provenance ignores trust spoofing by omission', async () => {
    const slug = 'wiki/personal/patterns/remote-provenance';
    await putPage(slug, 'A remote claim.');

    await operationsByName.suppress_claim.handler(
      ctx({ remote: undefined as unknown as boolean }),
      { slug, claim_text: 'A remote claim.' },
    );

    expect((await listClaims(slug)).suppressed_claims[0].provenance)
      .toBe('mcp:suppress_claim');
  });

  test('routes page reads and write-through through ctx.sourceId', async () => {
    const slug = 'wiki/personal/patterns/source-scoped';
    const otherDir = join(brainDir, 'other-source');
    mkdirSync(otherDir);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['other', 'Other source', otherDir],
    );
    await putPage(slug, 'Default source prose.');
    await putPage(slug, 'Other source prose.', ctx({ sourceId: 'other' }));

    await operationsByName.suppress_claim.handler(ctx({ sourceId: 'other' }), {
      slug,
      claim_text: 'Other source prose.',
    });

    const other = await operationsByName.list_suppressed_claims.handler(
      ctx({ sourceId: 'other' }),
      { slug },
    ) as { count: number };
    expect(other.count).toBe(1);
    expect((await listClaims(slug)).count).toBe(0);
    expect(readFileSync(join(otherDir, `${slug}.md`), 'utf8'))
      .toContain('gbrain:suppressions:begin');
    expect(readFileSync(join(brainDir, `${slug}.md`), 'utf8'))
      .not.toContain('gbrain:suppressions:begin');

    const federated = await operationsByName.list_suppressed_claims.handler(ctx({
      remote: true,
      sourceId: 'default',
      auth: {
        token: 'test-token',
        clientId: 'test-client',
        scopes: ['read'],
        allowedSources: ['other'],
      },
    }), { slug }) as { count: number; suppressed_claims: Array<{ claim_text: string }> };
    expect(federated).toMatchObject({
      count: 1,
      suppressed_claims: [{ claim_text: 'Other source prose.' }],
    });
  });

  test('remote get_page hides the raw fence while the structured list remains readable', async () => {
    const slug = 'wiki/personal/patterns/remote-read';
    await putPage(slug, 'The launch is Friday.');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
      reason: 'User corrected it',
    });
    await operationsByName.put_page.handler(ctx(), {
      slug,
      content: '---\ntitle: Corrected\n---\n\nThe launch is Monday.',
    });

    const remotePage = await operationsByName.get_page.handler(
      ctx({ remote: undefined as unknown as boolean }),
      { slug },
    ) as { compiled_truth: string };
    expect(remotePage.compiled_truth).toContain('The launch is Monday.');
    expect(remotePage.compiled_truth).not.toContain('gbrain:suppressions:begin');
    expect(remotePage.compiled_truth).not.toContain('User corrected it');

    const localPage = await operationsByName.get_page.handler(ctx(), { slug }) as {
      compiled_truth: string;
    };
    expect(localPage.compiled_truth).toContain('gbrain:suppressions:begin');
    expect((await listClaims(slug)).count).toBe(1);
  });

  test('unsuppress retains inactive audit history and permits a later write', async () => {
    const slug = 'wiki/personal/patterns/unsuppress';
    await putPage(slug, 'The launch is Friday.');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
    });

    const blocked = await operationsByName.put_page.handler(ctx({
      remote: true,
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/personal/patterns/*'],
    }), {
      slug,
      content: '---\ntitle: Blocked\n---\n\nTHE   LAUNCH is friday.',
    }) as Record<string, unknown>;
    expect(blocked).toMatchObject({
      suppression_backstop: {
        action: 'skipped_page_write',
        slug,
      },
    });

    await operationsByName.unsuppress_claim.handler(ctx(), {
      slug,
      claim_text: 'the launch is friday.',
    });
    const listed = await listClaims(slug);
    expect(listed.suppressed_claims).toHaveLength(1);
    expect(listed.suppressed_claims[0].active).toBe(false);

    const allowed = await operationsByName.put_page.handler(ctx({
      remote: true,
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/personal/patterns/*'],
    }), {
      slug,
      content: '---\ntitle: Allowed\n---\n\nThe launch is Friday.',
    }) as Record<string, unknown>;
    expect(allowed.suppression_backstop).toBeUndefined();
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth)
      .toContain('The launch is Friday.');
  });

  test('a stale conditional write cannot exit through the suppression backstop', async () => {
    const slug = 'wiki/personal/patterns/stale-suppression';
    await putPage(slug, 'The launch is Friday.');
    const reviewed = await engine.getPage(slug, { sourceId: 'default' });
    await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
    });
    const current = await engine.getPage(slug, { sourceId: 'default' });

    await expect(operationsByName.put_page.handler(ctx({
      remote: true,
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/personal/patterns/*'],
    }), {
      slug,
      content: '---\ntitle: Blocked\n---\n\nThe launch is Friday.',
      expected_content_hash: reviewed!.content_hash,
    })).rejects.toMatchObject({
      code: 'stale_page',
      details: {
        expected_content_hash: reviewed!.content_hash,
        current_content_hash: current!.content_hash,
      },
    });
  });

  test('later put_page rewrites preserve the canonical suppression fence', async () => {
    const slug = 'wiki/personal/reflections/preserved';
    await putPage(slug, 'The old prose contains a false launch date.');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
      reason: 'Moved',
    });

    await operationsByName.put_page.handler(ctx(), {
      slug,
      content: '---\ntitle: Updated\n---\n\nThe corrected launch date is Monday.',
    });

    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('The corrected launch date is Monday.');
    expect(page?.compiled_truth).toContain('gbrain:suppressions:begin');
    expect((await listClaims(slug)).count).toBe(1);
  });

  test('reindex and rebuild-style file round-trips retain suppressions', async () => {
    const slug = 'wiki/personal/reflections/rebuild';
    await putPage(slug, 'The launch is Friday.');
    await operationsByName.suppress_claim.handler(ctx(), {
      slug,
      claim_text: 'The launch is Friday.',
      reason: 'Refuted by user',
    });
    const filePath = join(brainDir, `${slug}.md`);

    const reindexed = await importFile(engine, filePath, `${slug}.md`, {
      noEmbed: true,
      sourceId: 'default',
      forceRechunk: true,
    });
    expect(reindexed.status).toBe('imported');
    expect((await listClaims(slug)).suppressed_claims[0].active).toBe(true);

    await engine.executeRaw(
      'DELETE FROM pages WHERE source_id = $1 AND slug = $2',
      ['default', slug],
    );
    const result = await importFile(engine, filePath, `${slug}.md`, {
      noEmbed: true,
      sourceId: 'default',
      forceRechunk: true,
    });
    expect(result.status).toBe('imported');
    expect((await listClaims(slug)).suppressed_claims[0]).toMatchObject({
      claim_text: 'The launch is Friday.',
      active: true,
    });
  });

  test('uses stable not-found and validation errors', async () => {
    await expect(operationsByName.suppress_claim.handler(ctx(), {
      slug: 'missing',
      claim_text: 'No page',
    })).rejects.toEqual(expect.objectContaining({
      code: 'page_not_found',
    }));

    await putPage('wiki/personal/patterns/errors', 'Body');
    await expect(operationsByName.unsuppress_claim.handler(ctx(), {
      slug: 'wiki/personal/patterns/errors',
      claim_text: 'Not suppressed',
    })).rejects.toEqual(expect.objectContaining({
      code: 'suppression_not_found',
    }));
    await expect(operationsByName.suppress_claim.handler(ctx(), {
      slug: 'wiki/personal/patterns/errors',
      claim_text: 'Claim',
      reason: 'x'.repeat(501),
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('enforces the subagent slug fence before mutation', async () => {
    await putPage('wiki/personal/patterns/fenced', 'Claim');
    await expect(operationsByName.suppress_claim.handler(ctx({
      remote: true,
      viaSubagent: true,
      subagentId: 7,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
    }), {
      slug: 'wiki/personal/patterns/fenced',
      claim_text: 'Claim',
    })).rejects.toEqual(expect.objectContaining({
      code: 'permission_denied',
    }));
  });
});
