import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(import.meta.dir, '.take-proposals-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  rmSync(brainDir, { recursive: true, force: true });
  mkdirSync(brainDir, { recursive: true });
});

function ctx(
  sourceId = 'default',
  opts: {
    allowedSources?: string[];
    takesHoldersAllowList?: string[];
    auth?: OperationContext['auth'];
    dryRun?: boolean;
    remote?: boolean;
  } = {},
): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: opts.dryRun ?? false,
    remote: opts.remote ?? false,
    sourceId,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    auth: opts.auth ?? (opts.allowedSources
      ? {
          token: 'test-token',
          clientId: 'test-client',
          scopes: ['read'],
          sourceId,
          allowedSources: opts.allowedSources,
        }
      : undefined),
  };
}

async function seedSource(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name)
     VALUES ($1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
}

async function seedProposal(opts: {
  sourceId?: string;
  pageSlug: string;
  claimText: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'superseded';
  holder?: string;
  kind?: 'fact' | 'take' | 'bet' | 'hunch';
  weight?: number;
  runId?: string;
  proposedAt: string;
}): Promise<number> {
  const sourceId = opts.sourceId ?? 'default';
  const claimHash = createHash('sha256')
    .update(opts.claimText.trim())
    .digest('hex');
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals (
       source_id, page_slug, content_hash, prompt_version, proposal_run_id,
       status, claim_text, claim_hash, kind, holder, weight, domain,
       dedup_against_fence_rows, model_id, proposed_at
     ) VALUES (
       $1, $2, $3, 'prompt-v1', $4, $5, $6, $7, $8, $9, $10,
       'strategy', '[]'::jsonb, 'test-model', $11::timestamptz
     )
     RETURNING id`,
    [
      sourceId,
      opts.pageSlug,
      `content-${opts.pageSlug}-${opts.claimText}`,
      opts.runId ?? 'run-default',
      opts.status ?? 'pending',
      opts.claimText,
      claimHash,
      opts.kind ?? 'take',
      opts.holder ?? 'world',
      opts.weight ?? 0.6,
      opts.proposedAt,
    ],
  );
  return rows[0]!.id;
}

async function seedProposalPage(
  slug: string,
  sourceId = 'default',
  markdown = `# ${slug}\n`,
): Promise<string> {
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: markdown,
    timeline: '',
  }, { sourceId });
  const path = join(brainDir, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, 'utf8');
  return path;
}

async function seedSlugAlias(
  aliasSlug: string,
  canonicalSlug: string,
  sourceId = 'default',
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
     VALUES ($1, $2, $3)`,
    [sourceId, aliasSlug, canonicalSlug],
  );
}

async function resolveProposal(
  operationCtx: OperationContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withEnv(
    { GBRAIN_HOME: brainDir },
    () => operationsByName.resolve_take_proposal.handler(
      operationCtx,
      params,
    ) as Promise<Record<string, unknown>>,
  );
}

type ProposalListResult = {
  proposals: Array<{
    id: number;
    source_id: string;
    page_slug: string;
    claim_text: string;
    holder: string;
    status: string;
    resolution_note: string | null;
  }>;
  total: number;
  limit: number;
  offset: number;
};

async function list(
  operationCtx: OperationContext,
  params: Record<string, unknown> = {},
): Promise<ProposalListResult> {
  return operationsByName.list_take_proposals.handler(
    operationCtx,
    params,
  ) as Promise<ProposalListResult>;
}

describe('take proposal operation registration', () => {
  test('proposal operations expose the frozen scopes and mutation metadata', () => {
    const op = operationsByName.list_take_proposals;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.mutating).not.toBe(true);
    expect(op.localOnly).not.toBe(true);

    const resolveOp = operationsByName.resolve_take_proposal;
    expect(resolveOp).toBeDefined();
    expect(resolveOp.scope).toBe('write');
    expect(resolveOp.mutating).toBe(true);
    expect(resolveOp.localOnly).not.toBe(true);
    expect(resolveOp.params).toHaveProperty('dry_run');
  });
});

describe('list_take_proposals', () => {
  test('defaults to pending rows ordered newest-first with a full filtered total', async () => {
    const oldestId = await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Old pending',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    const tiedOlderId = await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'New pending A',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    const newestId = await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'New pending B',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/gamma',
      claimText: 'Already accepted',
      status: 'accepted',
      proposedAt: '2026-07-23T10:00:00Z',
    });

    const result = await list(ctx(), { limit: 2 });

    expect(result).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(result.proposals.map(row => row.id)).toEqual([
      newestId,
      tiedOlderId,
    ]);
    expect(result.proposals[0]).toMatchObject({
      source_id: 'default',
      page_slug: 'writing/beta',
      status: 'pending',
      resolution_note: null,
    });
    expect(result.proposals[0]!.id).not.toBe(oldestId);
  });

  test('applies status, page, run, limit, and offset filters without truncating total', async () => {
    await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Alpha accepted old',
      status: 'accepted',
      runId: 'run-a',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    const newestId = await seedProposal({
      pageSlug: 'writing/alpha',
      claimText: 'Alpha accepted new',
      status: 'accepted',
      runId: 'run-a',
      proposedAt: '2026-07-22T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'Beta accepted',
      status: 'accepted',
      runId: 'run-b',
      proposedAt: '2026-07-23T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/beta',
      claimText: 'Beta pending',
      runId: 'run-b',
      proposedAt: '2026-07-24T10:00:00Z',
    });

    const result = await list(ctx(), {
      status: 'accepted',
      page_slug: 'writing/alpha',
      proposal_run_id: 'run-a',
      limit: 1,
      offset: 0,
    });

    expect(result).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(result.proposals.map(row => row.id)).toEqual([newestId]);
    const allStatuses = await list(ctx(), { status: 'all' });
    expect(allStatuses.total).toBe(4);
  });

  test('clamps limit to 1..200 and offset to zero or greater', async () => {
    const low = await list(ctx(), { limit: 0, offset: -8 });
    expect(low).toMatchObject({ limit: 1, offset: 0 });

    const high = await list(ctx(), { limit: 500, offset: 3 });
    expect(high).toMatchObject({ limit: 200, offset: 3 });
  });

  test('isolates scalar source reads and gives federated grants precedence', async () => {
    await seedSource('source-a');
    await seedSource('source-b');
    await seedProposal({
      sourceId: 'source-a',
      pageSlug: 'writing/shared',
      claimText: 'Source A claim',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    await seedProposal({
      sourceId: 'source-b',
      pageSlug: 'writing/shared',
      claimText: 'Source B claim',
      proposedAt: '2026-07-21T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/shared',
      claimText: 'Default claim',
      proposedAt: '2026-07-22T10:00:00Z',
    });

    const scalar = await list(ctx('source-a'));
    expect(scalar.proposals.map(row => row.source_id)).toEqual(['source-a']);
    expect(scalar.total).toBe(1);

    const federated = await list(ctx('default', {
      allowedSources: ['source-a', 'source-b'],
    }));
    expect(federated.proposals.map(row => row.source_id).sort()).toEqual([
      'source-a',
      'source-b',
    ]);
    expect(federated.total).toBe(2);
  });

  test('ignores the takes holder allow-list; source scope is the boundary', async () => {
    await seedProposal({
      pageSlug: 'writing/public',
      claimText: 'World claim',
      holder: 'world',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    await seedProposal({
      pageSlug: 'writing/private',
      claimText: 'Brain claim',
      holder: 'brain',
      proposedAt: '2026-07-21T10:00:00Z',
    });

    // Review surfaces authenticate as OAuth clients, which carry no holder
    // grants (['world'] fallback). Proposal claims derive from pages the
    // caller can already read within its source scope, so the queue lists
    // every holder rather than hiding reviewable rows.
    const result = await list(ctx('default', {
      takesHoldersAllowList: ['world'],
    }));

    expect(result.total).toBe(2);
    expect(result.proposals.map(row => row.holder).sort()).toEqual([
      'brain',
      'world',
    ]);
  });
});

describe('resolve_take_proposal', () => {
  test('does not resolve a numeric id outside the caller write source', async () => {
    await seedSource('source-a');
    await seedSource('source-b');
    const id = await seedProposal({
      sourceId: 'source-a',
      pageSlug: 'proposal-page',
      claimText: 'Source A only',
      proposedAt: '2026-07-20T10:00:00Z',
    });

    await expect(resolveProposal(ctx('source-b'), {
      id,
      action: 'reject',
    })).rejects.toMatchObject({ code: 'not_found' });

    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('pending');
  });

  test('reject stamps the proposal without creating a take', async () => {
    const id = await seedProposal({
      pageSlug: 'proposal-page',
      claimText: 'Reject this claim',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    const operationCtx = ctx('default', {
      remote: true,
      auth: {
        token: 'test-token',
        clientId: 'review-client',
        scopes: ['write'],
        sourceId: 'default',
        allowedSources: ['default'],
      },
    });

    const result = await resolveProposal(operationCtx, {
      id,
      action: 'reject',
      notes: 'Contradicted by the source material.',
    });

    expect(result).toMatchObject({
      id,
      status: 'rejected',
      acted_by: 'review-client',
      resolution_note: 'Contradicted by the source material.',
    });
    expect(result.acted_at).toBeTruthy();
    const takes = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes`,
    );
    expect(Number(takes[0]?.count)).toBe(0);
  });

  test('accept writes exactly one fence row and one mirrored take, then stamps the proposal', async () => {
    const pagePath = await seedProposalPage('proposal-page');
    const id = await seedProposal({
      pageSlug: 'proposal-page',
      claimText: 'Original proposal',
      kind: 'take',
      holder: 'world',
      weight: 0.6,
      proposedAt: '2026-07-20T10:00:00Z',
    });

    const result = await resolveProposal(ctx(), {
      id,
      action: 'accept',
      claim_text: 'Edited accepted claim',
      kind: 'fact',
      holder: 'brain',
      weight: 0.9,
      since_date: '2026-07-19',
      notes: 'Verified during review.',
    });

    expect(result).toMatchObject({
      id,
      status: 'accepted',
      promoted_row_num: 1,
      acted_by: 'local',
      resolution_note: 'Verified during review.',
    });
    const fence = parseTakesFence(readFileSync(pagePath, 'utf8'));
    expect(fence.takes).toHaveLength(1);
    expect(fence.takes[0]).toMatchObject({
      rowNum: 1,
      claim: 'Edited accepted claim',
      kind: 'fact',
      holder: 'brain',
      weight: 0.9,
      sinceDate: '2026-07-19',
      source: `proposal:${id}`,
    });
    const takes = await engine.executeRaw<{
      row_num: number;
      claim: string;
      kind: string;
      holder: string;
      weight: number;
      since_date: string;
      source: string;
    }>(
      `SELECT row_num, claim, kind, holder, weight,
              since_date::text AS since_date, source
         FROM takes`,
    );
    expect(takes).toEqual([{
      row_num: 1,
      claim: 'Edited accepted claim',
      kind: 'fact',
      holder: 'brain',
      weight: 0.9,
      since_date: '2026-07-19',
      source: `proposal:${id}`,
    }]);
  });

  test('accept follows page and holder aliases into the canonical page', async () => {
    const canonicalSlug = 'people/alice-example';
    const aliasSlug = 'people/alice-typo';
    const canonicalPath = await seedProposalPage(canonicalSlug);
    const aliasPath = await seedProposalPage(aliasSlug);
    await engine.softDeletePage(aliasSlug, { sourceId: 'default' });
    await seedSlugAlias(aliasSlug, canonicalSlug);
    rmSync(aliasPath);
    const id = await seedProposal({
      pageSlug: aliasSlug,
      claimText: 'Alias-targeted proposal',
      holder: aliasSlug,
      proposedAt: '2026-07-20T10:00:00Z',
    });

    const result = await resolveProposal(ctx(), { id, action: 'accept' });

    expect(result).toMatchObject({ page_slug: canonicalSlug });
    const fence = parseTakesFence(readFileSync(canonicalPath, 'utf8'));
    expect(fence.takes).toHaveLength(1);
    expect(fence.takes[0]).toMatchObject({
      claim: 'Alias-targeted proposal',
      holder: canonicalSlug,
      source: `proposal:${id}`,
    });
    expect(existsSync(aliasPath)).toBe(false);
    const takes = await engine.executeRaw<{
      page_slug: string;
      holder: string;
    }>(
      `SELECT p.slug AS page_slug, t.holder
         FROM takes t
         JOIN pages p ON p.id = t.page_id`,
    );
    expect(takes).toEqual([{
      page_slug: canonicalSlug,
      holder: canonicalSlug,
    }]);
  });

  test('accept rejects a soft-deleted page without recreating its file', async () => {
    const slug = 'people/deleted-example';
    const pagePath = await seedProposalPage(slug);
    await engine.softDeletePage(slug, { sourceId: 'default' });
    rmSync(pagePath);
    const id = await seedProposal({
      pageSlug: slug,
      claimText: 'Tombstoned proposal',
      proposedAt: '2026-07-20T10:00:00Z',
    });

    await expect(resolveProposal(ctx(), {
      id,
      action: 'accept',
    })).rejects.toMatchObject({
      code: 'page_deleted',
      message: `Page is soft-deleted: ${slug}`,
    });

    expect(existsSync(pagePath)).toBe(false);
    const proposals = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM take_proposals WHERE id = $1`,
      [id],
    );
    expect(proposals[0]?.status).toBe('pending');
    const takes = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes`,
    );
    expect(Number(takes[0]?.count)).toBe(0);
  });

  test('accept preserves page_not_found for a never-ingested slug without writing', async () => {
    const slug = 'people/missing-example';
    const pagePath = join(brainDir, `${slug}.md`);
    await engine.setConfig('sync.repo_path', brainDir);
    const id = await seedProposal({
      pageSlug: slug,
      claimText: 'Never-ingested proposal',
      proposedAt: '2026-07-20T10:00:00Z',
    });

    await expect(resolveProposal(ctx(), {
      id,
      action: 'accept',
    })).rejects.toMatchObject({ code: 'page_not_found' });
    expect(existsSync(pagePath)).toBe(false);
  });

  test('dry-run reports canonical page and holder aliases without writing', async () => {
    const canonicalSlug = 'people/alice-example';
    const aliasSlug = 'people/alice-typo';
    const originalMarkdown = `# ${canonicalSlug}\n`;
    const canonicalPath = await seedProposalPage(
      canonicalSlug,
      'default',
      originalMarkdown,
    );
    const aliasPath = await seedProposalPage(aliasSlug);
    await engine.softDeletePage(aliasSlug, { sourceId: 'default' });
    await seedSlugAlias(aliasSlug, canonicalSlug);
    rmSync(aliasPath);
    const id = await seedProposal({
      pageSlug: aliasSlug,
      claimText: 'Preview alias proposal',
      holder: aliasSlug,
      proposedAt: '2026-07-20T10:00:00Z',
    });

    const result = await resolveProposal(ctx(), {
      id,
      action: 'accept',
      dry_run: true,
    });

    expect(result).toMatchObject({
      dry_run: true,
      action: 'accept',
      id,
      page_slug: canonicalSlug,
      holder: canonicalSlug,
    });
    expect(readFileSync(canonicalPath, 'utf8')).toBe(originalMarkdown);
    expect(existsSync(aliasPath)).toBe(false);
  });

  test('dry-run rejects the same soft-deleted page as a real accept', async () => {
    const slug = 'people/deleted-example';
    const pagePath = await seedProposalPage(slug);
    await engine.softDeletePage(slug, { sourceId: 'default' });
    rmSync(pagePath);
    const id = await seedProposal({
      pageSlug: slug,
      claimText: 'Preview tombstoned proposal',
      proposedAt: '2026-07-20T10:00:00Z',
    });

    await expect(resolveProposal(ctx(), {
      id,
      action: 'accept',
      dry_run: true,
    })).rejects.toMatchObject({
      code: 'page_deleted',
      message: `Page is soft-deleted: ${slug}`,
    });
    expect(existsSync(pagePath)).toBe(false);
  });

  test('dry-run returns effective fields without mutating the file or database', async () => {
    const originalMarkdown = '# Proposal page\n';
    const pagePath = await seedProposalPage(
      'proposal-page',
      'default',
      originalMarkdown,
    );
    const id = await seedProposal({
      pageSlug: 'proposal-page',
      claimText: 'Original proposal',
      kind: 'bet',
      holder: 'world',
      weight: 0.4,
      proposedAt: '2026-07-20T10:00:00Z',
    });

    const result = await resolveProposal(ctx(), {
      id,
      action: 'accept',
      claim_text: 'Preview edit',
      dry_run: true,
    });

    expect(result).toEqual({
      dry_run: true,
      action: 'accept',
      id,
      page_slug: 'proposal-page',
      claim_text: 'Preview edit',
      kind: 'bet',
      holder: 'world',
      weight: 0.4,
      since_date: '2026-07-20',
      source: `proposal:${id}`,
    });
    expect(readFileSync(pagePath, 'utf8')).toBe(originalMarkdown);
    const proposal = await engine.executeRaw<{
      status: string;
      acted_at: string | null;
    }>(
      `SELECT status, acted_at FROM take_proposals WHERE id = $1`,
      [id],
    );
    expect(proposal[0]).toMatchObject({ status: 'pending', acted_at: null });
    const takes = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes`,
    );
    expect(Number(takes[0]?.count)).toBe(0);
  });

  test('a second resolution fails with the current non-pending status', async () => {
    const id = await seedProposal({
      pageSlug: 'proposal-page',
      claimText: 'Resolve once',
      proposedAt: '2026-07-20T10:00:00Z',
    });
    await resolveProposal(ctx(), { id, action: 'reject' });

    try {
      await resolveProposal(ctx(), { id, action: 'reject' });
      throw new Error('Expected the second resolution to fail.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'not_pending',
        status: 'rejected',
      });
      expect((error as { toJSON: () => unknown }).toJSON()).toMatchObject({
        code: 'not_pending',
        status: 'rejected',
      });
    }
  });

  test('accept defaults since_date to the proposal date', async () => {
    await seedProposalPage('proposal-page');
    const id = await seedProposal({
      pageSlug: 'proposal-page',
      claimText: 'Gradeable by default',
      proposedAt: '2026-07-20T23:59:59Z',
    });

    await resolveProposal(ctx(), { id, action: 'accept' });

    const takes = await engine.executeRaw<{ since_date: string }>(
      `SELECT since_date::text AS since_date FROM takes`,
    );
    expect(takes[0]?.since_date).toBe('2026-07-20');
  });

  test('accept writes into the source local_path working tree when configured', async () => {
    // Multi-source deployments (e.g. sequid) configure per-source working
    // trees on sources.local_path and never set sync.repo_path.
    const sourceDir = mkdtempSync(join(import.meta.dir, '.take-proposals-src-'));
    try {
      await seedSource('source-a');
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = 'source-a'`,
        [sourceDir],
      );
      writeFileSync(join(sourceDir, 'tree-page.md'), '# tree-page\n', 'utf8');
      await engine.putPage('tree-page', {
        type: 'note',
        title: 'tree-page',
        compiled_truth: '# tree-page\n',
        timeline: '',
      }, { sourceId: 'source-a' });
      const id = await seedProposal({
        sourceId: 'source-a',
        pageSlug: 'tree-page',
        claimText: 'Tree-scoped claim',
        proposedAt: '2026-07-20T10:00:00Z',
      });

      const result = await resolveProposal(ctx('source-a'), {
        id,
        action: 'accept',
      });

      expect(result).toMatchObject({ id, status: 'accepted' });
      const fence = parseTakesFence(
        readFileSync(join(sourceDir, 'tree-page.md'), 'utf8'),
      );
      expect(fence.takes).toHaveLength(1);
      expect(fence.takes[0]).toMatchObject({
        claim: 'Tree-scoped claim',
        source: `proposal:${id}`,
      });
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('dry-run accept surfaces brain_dir_not_found on a misconfigured deployment', async () => {
    // No sync.repo_path and no source local_path: the preview must fail the
    // same way a real acceptance would instead of reporting success.
    const id = await seedProposal({
      pageSlug: 'missing-tree',
      claimText: 'Unpromotable claim',
      proposedAt: '2026-07-20T10:00:00Z',
    });

    await expect(resolveProposal(ctx(), {
      id,
      action: 'accept',
      dry_run: true,
    })).rejects.toMatchObject({ code: 'brain_dir_not_found' });
  });
});
