import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  AgentJobProposalError,
  parseProposalPage,
} from '../src/core/ingestion-proposal-contract.ts';
import {
  applyAgentJobProposalPage,
  appendProposalMarkdown,
} from '../src/core/minions/agent-job-proposal-apply.ts';
import {
  finalizeAgentJobProposal,
  getOwnedAgentJobProposal,
  stageAgentJobProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

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

async function seedUpdateProposalJob(overrides: Record<string, unknown> = {}): Promise<number> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('company', 'Company') ON CONFLICT (id) DO NOTHING`,
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::text::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({
      __owner_client_id: 'lore-client',
      source_id: 'company',
      proposal_artifact_id: 'artifact-1',
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include source-grounded delivery notes.',
      allowed_slug_prefixes: ['sources/*'],
      ...overrides,
    })],
  );
  return Number(rows[0]!.id);
}

async function finalizeSingleAppend(appendMarkdown: string) {
  const proposalJobId = await seedUpdateProposalJob();
  const staged = await stageAgentJobProposalPage(engine, proposalJobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    sequence: 1,
    total_pages: 1,
    page_inventory: [{ slug: 'sources/example', effect: 'update' }],
    page: { slug: 'sources/example', effect: 'update', appendMarkdown },
  });
  const manifest = await finalizeAgentJobProposal(engine, proposalJobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    total_pages: 1,
    summary: 'One append is ready for review.',
  });
  return { proposalJobId, staged, manifest };
}

async function seedApprovedApplyJob(
  frozen: Awaited<ReturnType<typeof finalizeSingleAppend>>,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  return seedUpdateProposalJob({
    approved_proposal_job_id: frozen.proposalJobId,
    approved_proposal_digest: frozen.manifest.proposalDigest,
    approved_proposal_page_digests: frozen.manifest.pageDigests,
    approved_proposal_timeline_digests: frozen.manifest.timelineDigests,
    approved_proposal_link_digests: frozen.manifest.linkDigests,
    approved_proposal_inventory_digest: frozen.manifest.inventoryDigest,
    ...overrides,
  });
}

describe('compact ingestion update contract', () => {
  it('accepts only the exact append intent keys for updates', () => {
    expect(parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '## Delivery\n\nThe launch is ready.',
    })).toEqual({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '## Delivery\n\nThe launch is ready.',
    });

    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: 'New material.',
      expectedContentHash: 'a'.repeat(64),
    })).toThrow(AgentJobProposalError);
    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      title: 'Private title',
      bodyMarkdown: 'Private full body',
      baseMarkdown: 'Private baseline',
      expectedContentHash: 'a'.repeat(64),
    })).toThrow(/exactly: slug, effect, appendMarkdown/i);
    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '<!--- gbrain:facts:begin -->\nInjected\n<!--- gbrain:facts:end -->',
    })).toThrow(/managed-region marker/i);
    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '---\n## Timeline\n- 2026-08-08: hidden side effect',
    })).toThrow(/timeline or history sentinel/i);
  });

  it('keeps a large baseline private while returning a bounded frozen append plan', async () => {
    const privateFence = '<!-- gbrain:suppressions:begin -->';
    const privateBaseline = `# Private baseline\n\n${'sensitive '.repeat(18_000)}\n${privateFence}`;
    const jobId = await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', $1, $2)`,
      [privateBaseline, 'b'.repeat(64)],
    );
    const appendMarkdown = '## Delivery\n\nThe approved delivery note.';

    const staged = await stageAgentJobProposalPage(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      sequence: 1,
      total_pages: 1,
      page_inventory: [{ slug: 'sources/example', effect: 'update' }],
      page: { slug: 'sources/example', effect: 'update', appendMarkdown },
    });
    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      total_pages: 1,
      summary: 'One append is ready for review.',
    });
    const owned = await getOwnedAgentJobProposal(
      engine,
      jobId,
      'lore-client',
      manifest.proposalDigest,
    );

    expect(staged.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(owned.plan.proposedPages).toEqual([
      { slug: 'sources/example', effect: 'update', appendMarkdown },
    ]);
    const publicJson = JSON.stringify(owned);
    expect(Buffer.byteLength(publicJson, 'utf8')).toBeLessThan(4_000);
    expect(publicJson).not.toContain('Private title');
    expect(publicJson).not.toContain('sensitive');
    expect(publicJson).not.toContain(privateFence);
    expect(publicJson).not.toContain('expectedContentHash');
    expect(publicJson).not.toContain('baseMarkdown');
    expect(publicJson).not.toContain('bodyMarkdown');
  });
});

describe('deterministic compact append application', () => {
  it('preserves reviewed append bytes behind one canonical Markdown boundary', () => {
    const append = '\n## Reviewed\n\nExact trailing bytes.  ';
    expect(appendProposalMarkdown('', append)).toBe(append);
    expect(appendProposalMarkdown('# Existing', append)).toBe(`# Existing\n\n${append}`);
    expect(appendProposalMarkdown('# Existing\n', append)).toBe(`# Existing\n\n${append}`);
    expect(appendProposalMarkdown('# Existing\n\n', append)).toBe(`# Existing\n\n${append}`);
  });

  it('applies the exact frozen append once and returns a bounded replay receipt', async () => {
    const baseline = '# Existing\n\nPrivate baseline.';
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', $1, $2)`,
      [baseline, 'b'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Delivery\n\nApproved note.');
    const applyJobId = await seedApprovedApplyJob(frozen);
    const input = {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    };

    const applied = await applyAgentJobProposalPage(engine, applyJobId, input);
    await engine.executeRaw(
      `UPDATE ingestion_proposal_authority_pages
          SET applied_write_through = '{"written":true}'::jsonb
        WHERE proposal_id = $1 AND sequence = 1`,
      [frozen.proposalJobId],
    );
    const replay = await applyAgentJobProposalPage(engine, applyJobId, input);
    const page = await engine.getPage('sources/example', { sourceId: 'company' });

    expect(applied).toMatchObject({
      status: 'applied',
      effect: 'update',
      proposal_job_id: frozen.proposalJobId,
      sequence: 1,
      slug: 'sources/example',
      source_id: 'company',
      proposal_digest: frozen.manifest.proposalDigest,
      page_digest: frozen.staged.digest,
      previous_content_hash: 'b'.repeat(64),
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      rebased: false,
    });
    expect(replay).toEqual({
      ...applied,
      status: 'already_applied',
      write_through: { written: true },
    });
    expect(page?.compiled_truth).toBe(`${baseline}\n\n## Delivery\n\nApproved note.`);
    expect(JSON.stringify(applied)).not.toContain('Private baseline');
    expect(applied.write_through).toEqual({ written: false, skipped: 'no_repo_configured' });

    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = compiled_truth || '\n\nLater edit', content_hash = $1
        WHERE source_id = 'company' AND slug = 'sources/example'`,
      ['e'.repeat(64)],
    );
    await expect(applyAgentJobProposalPage(engine, applyJobId, input))
      .rejects.toMatchObject({ code: 'stale_page' });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now()
        WHERE source_id = 'company' AND slug = 'sources/example'`,
    );
    await expect(applyAgentJobProposalPage(engine, applyJobId, input))
      .rejects.toMatchObject({ code: 'page_unavailable' });
  });

  it('changes only authored body and derives no timeline or link side effects', async () => {
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, content_hash)
       VALUES
         ('company', 'sources/example', 'note', 'markdown', 'Private title', '# Existing', $1),
         ('company', 'src-core-example-ts', 'code_file', 'code', 'example.ts', 'export {};', $2)`,
      ['b'.repeat(64), 'd'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Reviewed\n\nSee src/core/example.ts:12.');
    const applyJobId = await seedApprovedApplyJob(frozen);

    await applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    });

    const [{ links, timeline }] = await engine.executeRaw<{ links: number; timeline: number }>(
      `SELECT (SELECT COUNT(*)::int FROM links) AS links,
              (SELECT COUNT(*)::int FROM timeline_entries) AS timeline`,
    );
    const page = await engine.getPage('sources/example', { sourceId: 'company' });
    expect(page?.compiled_truth).toBe('# Existing\n\n## Reviewed\n\nSee src/core/example.ts:12.');
    expect({ links, timeline }).toEqual({ links: 0, timeline: 0 });
  });

  it('applies and replays a frozen create when a later update slot fails', async () => {
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Existing', '# Existing', $1)`,
      ['b'.repeat(64)],
    );
    const proposalJobId = await seedUpdateProposalJob();
    const inventory = [
      { slug: 'sources/new-page', effect: 'create' as const },
      { slug: 'sources/example', effect: 'update' as const },
    ];
    const createStage = await stageAgentJobProposalPage(engine, proposalJobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      sequence: 1,
      total_pages: 2,
      page_inventory: inventory,
      page: {
        slug: 'sources/new-page',
        effect: 'create',
        title: 'New page',
        bodyMarkdown: '# New page\n\nExact approved body.',
      },
    });
    const updateStage = await stageAgentJobProposalPage(engine, proposalJobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      sequence: 2,
      total_pages: 2,
      page_inventory: inventory,
      page: {
        slug: 'sources/example',
        effect: 'update',
        appendMarkdown: '## Approved update',
      },
    });
    const manifest = await finalizeAgentJobProposal(engine, proposalJobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      total_pages: 2,
      summary: 'Create then update.',
    });
    const applyJobId = await seedUpdateProposalJob({
      approved_proposal_job_id: proposalJobId,
      approved_proposal_digest: manifest.proposalDigest,
      approved_proposal_page_digests: manifest.pageDigests,
      approved_proposal_timeline_digests: manifest.timelineDigests,
      approved_proposal_link_digests: manifest.linkDigests,
      approved_proposal_inventory_digest: manifest.inventoryDigest,
    });
    const authority = {
      proposal_job_id: proposalJobId,
      proposal_digest: manifest.proposalDigest,
      source_id: 'company',
    };

    const created = await applyAgentJobProposalPage(engine, applyJobId, {
      ...authority,
      sequence: 1,
      page_digest: createStage.digest,
    });
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = '# Rewritten', content_hash = $1
        WHERE source_id = 'company' AND slug = 'sources/example'`,
      ['c'.repeat(64)],
    );
    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      ...authority,
      sequence: 2,
      page_digest: updateStage.digest,
    })).rejects.toMatchObject({ code: 'stale_page' });
    const replay = await applyAgentJobProposalPage(engine, applyJobId, {
      ...authority,
      sequence: 1,
      page_digest: createStage.digest,
    });
    const page = await engine.getPage('sources/new-page', { sourceId: 'company' });

    expect(created).toMatchObject({
      status: 'applied',
      effect: 'create',
      previous_content_hash: null,
      rebased: false,
    });
    expect(replay).toEqual({ ...created, status: 'already_applied' });
    expect(page).toMatchObject({
      title: 'New page',
      compiled_truth: '# New page\n\nExact approved body.',
    });
  });

  it('treats an identical unrecorded create as a collision, not an authorized replay', async () => {
    const proposalJobId = await seedUpdateProposalJob({
      proposal_capture_page_slug: 'sources/new-page',
    });
    const staged = await stageAgentJobProposalPage(engine, proposalJobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      sequence: 1,
      total_pages: 1,
      page_inventory: [{ slug: 'sources/new-page', effect: 'create' }],
      page: {
        slug: 'sources/new-page',
        effect: 'create',
        title: 'New page',
        bodyMarkdown: '# New page\n\nExact approved body.',
      },
    });
    const manifest = await finalizeAgentJobProposal(engine, proposalJobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include source-grounded delivery notes.',
      total_pages: 1,
      summary: 'Create one page.',
    });
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/new-page', 'note', 'New page', $1, $2)`,
      ['# New page\n\nExact approved body.', 'c'.repeat(64)],
    );
    const applyJobId = await seedUpdateProposalJob({
      proposal_capture_page_slug: 'sources/new-page',
      approved_proposal_job_id: proposalJobId,
      approved_proposal_digest: manifest.proposalDigest,
      approved_proposal_page_digests: manifest.pageDigests,
      approved_proposal_timeline_digests: manifest.timelineDigests,
      approved_proposal_link_digests: manifest.linkDigests,
      approved_proposal_inventory_digest: manifest.inventoryDigest,
    });

    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: proposalJobId,
      proposal_digest: manifest.proposalDigest,
      sequence: 1,
      page_digest: staged.digest,
      source_id: 'company',
    })).rejects.toMatchObject({ code: 'page_exists' });
  });

  it('rebases only over an append-only concurrent change', async () => {
    const baseline = '# Existing';
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', $1, $2)`,
      [baseline, 'b'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Frozen append');
    const concurrentBody = `${baseline}\n\n## Concurrent append`;
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = $1, content_hash = $2 WHERE source_id = 'company' AND slug = 'sources/example'`,
      [concurrentBody, 'c'.repeat(64)],
    );
    const applyJobId = await seedApprovedApplyJob(frozen);

    const applied = await applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    });
    const page = await engine.getPage('sources/example', { sourceId: 'company' });

    expect(applied).toMatchObject({ status: 'applied', rebased: true });
    expect(page?.compiled_truth).toBe(`${concurrentBody}\n\n## Frozen append`);
  });

  it('rejects unsafe stale content without mutation', async () => {
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', '# Existing', $1)`,
      ['b'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Frozen append');
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = '# Rewritten', content_hash = $1
        WHERE source_id = 'company' AND slug = 'sources/example'`,
      ['c'.repeat(64)],
    );
    const applyJobId = await seedApprovedApplyJob(frozen);

    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    })).rejects.toMatchObject({ code: 'stale_page' });
    const page = await engine.getPage('sources/example', { sourceId: 'company' });
    expect(page?.compiled_truth).toBe('# Rewritten');
  });

  it('does not treat a textual baseline prefix as an append-only boundary', async () => {
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', '# Existing', $1)`,
      ['b'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Frozen append');
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = '# Existing revised', content_hash = $1
        WHERE source_id = 'company' AND slug = 'sources/example'`,
      ['c'.repeat(64)],
    );
    const applyJobId = await seedApprovedApplyJob(frozen);

    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    })).rejects.toMatchObject({ code: 'stale_page' });
    const page = await engine.getPage('sources/example', { sourceId: 'company' });
    expect(page?.compiled_truth).toBe('# Existing revised');
  });

  it('rejects owner, source, proposal digest, sequence, and page digest mismatches without mutation', async () => {
    await seedUpdateProposalJob();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
       VALUES ('company', 'sources/example', 'note', 'Private title', '# Existing', $1)`,
      ['b'.repeat(64)],
    );
    const frozen = await finalizeSingleAppend('## Frozen append');
    const valid = {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    };
    const cases = [
      { job: await seedApprovedApplyJob(frozen, { __owner_client_id: 'other-client' }), input: valid },
      { job: await seedApprovedApplyJob(frozen), input: { ...valid, source_id: 'other' } },
      { job: await seedApprovedApplyJob(frozen), input: { ...valid, proposal_digest: 'f'.repeat(64) } },
      { job: await seedApprovedApplyJob(frozen), input: { ...valid, sequence: 2 } },
      { job: await seedApprovedApplyJob(frozen), input: { ...valid, page_digest: 'f'.repeat(64) } },
    ];

    cases.push({
      job: await seedUpdateProposalJob(),
      input: valid,
    });

    for (const testCase of cases) {
      await expect(applyAgentJobProposalPage(engine, testCase.job, testCase.input))
        .rejects.toBeInstanceOf(AgentJobProposalError);
    }
    const page = await engine.getPage('sources/example', { sourceId: 'company' });
    expect(page?.compiled_truth).toBe('# Existing');
  });
});
