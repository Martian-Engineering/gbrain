import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  parseProposalPage,
} from '../src/core/ingestion-proposal-contract.ts';
import {
  applyAgentJobProposalPage,
} from '../src/core/minions/agent-job-proposal-apply.ts';
import {
  finalizeAgentJobProposal,
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

/** Create one proposal-capable job bound to the synthetic company source. */
async function seedProposalJob(overrides: Record<string, unknown> = {}): Promise<number> {
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

/** Freeze one exact full-page rewrite against the current source page. */
async function finalizeRewrite(bodyMarkdown: string) {
  const proposalJobId = await seedProposalJob();
  const staged = await stageAgentJobProposalPage(engine, proposalJobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    sequence: 1,
    total_pages: 1,
    page_inventory: [{ slug: 'sources/example', effect: 'update' }],
    page: {
      slug: 'sources/example',
      effect: 'update',
      title: 'Synthesized source',
      bodyMarkdown,
      baseMarkdown: '# Existing',
      expectedContentHash: 'b'.repeat(64),
    },
  });
  const manifest = await finalizeAgentJobProposal(engine, proposalJobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    total_pages: 1,
    summary: 'One full-page update is ready for review.',
  });
  return { proposalJobId, staged, manifest };
}

/** Bind a separate apply job to one approved frozen proposal. */
async function seedApplyJob(frozen: Awaited<ReturnType<typeof finalizeRewrite>>): Promise<number> {
  return seedProposalJob({
    approved_proposal_job_id: frozen.proposalJobId,
    approved_proposal_digest: frozen.manifest.proposalDigest,
    approved_proposal_page_digests: frozen.manifest.pageDigests,
    approved_proposal_timeline_digests: frozen.manifest.timelineDigests,
    approved_proposal_link_digests: frozen.manifest.linkDigests,
    approved_proposal_inventory_digest: frozen.manifest.inventoryDigest,
  });
}

/** Seed the exact page state used as the frozen rewrite baseline. */
async function seedExistingPage(): Promise<void> {
  await seedProposalJob();
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
     VALUES ('company', 'sources/example', 'note', 'Existing', '# Existing', $1)`,
    ['b'.repeat(64)],
  );
}

describe('full-page ingestion update contract', () => {
  it('accepts complete creates and conditional full-page updates', () => {
    expect(parseProposalPage({
      slug: 'sources/example',
      effect: 'create',
      title: 'Example',
      bodyMarkdown: '# Example',
    })).toMatchObject({ effect: 'create', bodyMarkdown: '# Example' });
    expect(parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      title: 'Example',
      bodyMarkdown: '# Rewritten',
      baseMarkdown: '# Existing',
      expectedContentHash: 'b'.repeat(64),
    })).toMatchObject({ effect: 'update', bodyMarkdown: '# Rewritten' });
  });

  it('rejects the removed appendMarkdown update shape', () => {
    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '## Dated addendum',
    })).toThrow(/must contain exactly/i);
  });

  it('keeps server-managed timeline structure out of full-page bodies', () => {
    expect(() => parseProposalPage({
      slug: 'sources/example',
      effect: 'update',
      title: 'Example',
      bodyMarkdown: '# Example\n\n---\n## Timeline\n- Hidden event',
      baseMarkdown: '# Existing',
      expectedContentHash: 'b'.repeat(64),
    })).toThrow(/timeline or history sentinel/i);
  });

  it('applies and idempotently replays the exact reviewed full body', async () => {
    await seedExistingPage();
    const desired = '# Synthesized source\n\nOne coherent account of the durable facts.';
    const frozen = await finalizeRewrite(desired);
    const applyJobId = await seedApplyJob(frozen);
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

    expect(applied).toMatchObject({ status: 'applied', effect: 'update', rebased: false });
    expect(replay).toEqual({
      ...applied,
      status: 'already_applied',
      write_through: { written: true },
    });
    expect(page).toMatchObject({ title: 'Synthesized source', compiled_truth: desired });
  });

  it('rejects a stale update without rebasing or mutation', async () => {
    await seedExistingPage();
    const frozen = await finalizeRewrite('# Synthesized source');
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = '# Concurrent edit', content_hash = $1
        WHERE source_id = 'company' AND slug = 'sources/example'`,
      ['c'.repeat(64)],
    );
    const applyJobId = await seedApplyJob(frozen);

    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.staged.digest,
      source_id: 'company',
    })).rejects.toMatchObject({ code: 'stale_page' });
    expect(await engine.getPage('sources/example', { sourceId: 'company' }))
      .toMatchObject({ title: 'Existing', compiled_truth: '# Concurrent edit' });
  });
});
