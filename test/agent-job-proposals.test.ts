import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  AgentJobProposalError,
  PROPOSAL_AGGREGATE_MAX_BYTES,
  PROPOSAL_STAGE_INPUT_MAX_BYTES,
  assertProposalToolTurnPersistable,
  digestProposalValue,
  finalizeAgentJobProposal,
  getOwnedAgentJobProposal,
  stageAgentJobProposalPage,
  type ScopedProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';

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

async function seedJob(overrides: Record<string, unknown> = {}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::text::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({
      __owner_client_id: 'lore-client',
      source_id: 'company',
      proposal_artifact_id: 'artifact-1',
      proposal_admission_scope: 'Include project delivery notes.',
      ...overrides,
    })],
  );
  return Number(rows[0]!.id);
}

function createPage(slug: string, bodyMarkdown = '# Page'): ScopedProposalPage {
  return { slug, effect: 'create', title: 'Page', bodyMarkdown };
}

function updatePage(slug: string, suffix = ''): ScopedProposalPage {
  return {
    slug,
    effect: 'update',
    title: 'Page',
    bodyMarkdown: `# Updated${suffix}`,
    baseMarkdown: '# Existing',
    expectedContentHash: 'a'.repeat(64),
  };
}

async function stage(
  jobId: number,
  sequence: number,
  totalPages: number,
  page: ScopedProposalPage,
) {
  return stageAgentJobProposalPage(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include project delivery notes.',
    sequence,
    total_pages: totalPages,
    page,
  });
}

describe('proposal turn pre-persistence boundary', () => {
  it('rejects oversized stage input and multiple stages before persistence callbacks run', () => {
    const oversized = {
      type: 'tool-call',
      toolName: 'brain_stage_ingestion_proposal_page',
      input: { body: 'x'.repeat(PROPOSAL_STAGE_INPUT_MAX_BYTES) },
    };
    expect(() => assertProposalToolTurnPersistable([oversized])).toThrow(/maximum/i);
    expect(() => assertProposalToolTurnPersistable([
      { type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: { page: 1 } },
      { type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: { page: 2 } },
    ])).toThrow(/exactly one/i);
  });

  it('rejects a turn that mixes page staging with finalization', () => {
    expect(() => assertProposalToolTurnPersistable([
      { type: 'tool_use', name: 'brain_stage_ingestion_proposal_page', input: { page: 1 } },
      { type: 'tool_use', name: 'brain_finalize_ingestion_proposal', input: { total_pages: 1 } },
    ])).toThrow(/separate agent turns/i);
  });
});

describe('durable agent-job proposal staging', () => {
  it('stages exact pages, finalizes an ordered manifest, and retrieves the full owned plan', async () => {
    const jobId = await seedJob();
    const first = await stage(jobId, 1, 2, createPage('sources/example'));
    const second = await stage(jobId, 2, 2, updatePage('projects/example'));

    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 2,
      page_digests: [
        { sequence: 1, digest: first.digest },
        { sequence: 2, digest: second.digest },
      ],
      summary: 'Two exact pages are ready for review.',
      proposed_timeline_entries: [{
        pageSlug: 'projects/existing',
        date: '2026-08-07',
        text: 'Delivery review completed.',
        ref: 'sources/example',
      }],
      proposed_links: [{ from: 'sources/example', to: 'projects/example', type: 'documents' }],
      unresolved: [],
    });

    expect(manifest.pageDigests).toEqual([first, second]);
    expect(manifest.status).toBe('staged_proposal');
    expect(manifest.proposalDigest).toMatch(/^[a-f0-9]{64}$/);
    const owned = await getOwnedAgentJobProposal(
      engine,
      jobId,
      'lore-client',
      manifest.proposalDigest,
    );
    expect(owned.page_digests).toEqual(manifest.pageDigests);
    expect(owned.plan.proposedPages).toEqual([
      createPage('sources/example'),
      updatePage('projects/example'),
    ]);
    expect(owned.plan.proposedTimelineEntries[0]!.pageSlug).toBe('projects/existing');
    expect(digestProposalValue(owned.plan)).toBe(manifest.proposalDigest);
  });

  it('makes identical staging and finalization replay-safe but rejects conflicts', async () => {
    const jobId = await seedJob();
    const page = createPage('sources/example');
    const first = await stage(jobId, 1, 1, page);
    expect(await stage(jobId, 1, 1, page)).toEqual(first);
    await expect(stage(jobId, 1, 1, createPage('sources/example', '# Different')))
      .rejects.toMatchObject({ code: 'conflicting_fragment' });

    const input = {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      page_digests: [{ sequence: 1, digest: first.digest }],
      summary: 'Ready.',
    };
    const finalized = await finalizeAgentJobProposal(engine, jobId, input);
    expect(await finalizeAgentJobProposal(engine, jobId, input)).toEqual(finalized);
    await expect(finalizeAgentJobProposal(engine, jobId, { ...input, summary: 'Changed.' }))
      .rejects.toMatchObject({ code: 'conflicting_finalization' });
  });

  it('allows different jobs owned by the same client to finalize an identical proposal', async () => {
    const firstJobId = await seedJob();
    const secondJobId = await seedJob();
    const page = createPage('sources/example');
    const firstPage = await stage(firstJobId, 1, 1, page);
    const secondPage = await stage(secondJobId, 1, 1, page);
    const input = {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      page_digests: [{ sequence: 1, digest: firstPage.digest }],
      summary: 'Ready.',
    };

    const first = await finalizeAgentJobProposal(engine, firstJobId, input);
    const second = await finalizeAgentJobProposal(engine, secondJobId, {
      ...input,
      page_digests: [{ sequence: 1, digest: secondPage.digest }],
    });

    expect(second.proposalDigest).toBe(first.proposalDigest);
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_job_proposals
        WHERE owner_client_id = 'lore-client' AND proposal_digest = $1`,
      [first.proposalDigest],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('rejects gaps, duplicate manifest sequences, digest mismatches, and duplicate page slugs', async () => {
    const gapJob = await seedJob();
    const gap = await stage(gapJob, 1, 2, createPage('sources/gap'));
    await expect(finalizeAgentJobProposal(engine, gapJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, page_digests: [{ sequence: 1, digest: gap.digest }, { sequence: 2, digest: gap.digest }], summary: 'Gap.',
    })).rejects.toMatchObject({ code: 'fragment_gap' });

    const duplicateManifestJob = await seedJob();
    const one = await stage(duplicateManifestJob, 1, 2, createPage('sources/one'));
    const two = await stage(duplicateManifestJob, 2, 2, createPage('sources/two'));
    await expect(finalizeAgentJobProposal(engine, duplicateManifestJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, page_digests: [{ sequence: 1, digest: one.digest }, { sequence: 1, digest: two.digest }], summary: 'Duplicate.',
    })).rejects.toBeInstanceOf(AgentJobProposalError);
    await expect(finalizeAgentJobProposal(engine, duplicateManifestJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, page_digests: [{ sequence: 1, digest: one.digest }, { sequence: 2, digest: 'f'.repeat(64) }], summary: 'Mismatch.',
    })).rejects.toMatchObject({ code: 'digest_mismatch' });

    const duplicatePageJob = await seedJob();
    const a = await stage(duplicatePageJob, 1, 2, createPage('sources/same'));
    const b = await stage(duplicatePageJob, 2, 2, updatePage('sources/same'));
    await expect(finalizeAgentJobProposal(engine, duplicatePageJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, page_digests: [{ sequence: 1, digest: a.digest }, { sequence: 2, digest: b.digest }], summary: 'Duplicate page.',
    })).rejects.toMatchObject({ code: 'duplicate_page' });
  });

  it('rejects calendar-normalized dates instead of accepting them as strict dates', async () => {
    const jobId = await seedJob();
    const page = await stage(jobId, 1, 1, createPage('sources/example'));
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      page_digests: [{ sequence: 1, digest: page.digest }],
      summary: 'Invalid date.',
      proposed_timeline_entries: [{
        pageSlug: 'sources/example',
        date: '2026-02-31',
        text: 'Impossible date.',
        ref: 'sources/example',
      }],
    })).rejects.toMatchObject({ code: 'invalid_timeline' });
  });

  it('rejects job, owner, source, artifact, scope, and stored-fragment binding mismatches', async () => {
    const jobId = await seedJob();
    await expect(stageAgentJobProposalPage(engine, jobId, {
      artifact_id: 'other', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: 1, total_pages: 1, page: createPage('sources/example'),
    })).rejects.toMatchObject({ code: 'binding_mismatch' });

    const staged = await stage(jobId, 1, 1, createPage('sources/example'));
    await engine.executeRaw(
      `UPDATE agent_job_proposal_fragments SET source_id = 'other' WHERE job_id = $1`,
      [jobId],
    );
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, page_digests: [{ sequence: 1, digest: staged.digest }], summary: 'Ready.',
    })).rejects.toMatchObject({ code: 'binding_mismatch' });

    const unbound = await seedJob({ proposal_artifact_id: null });
    await expect(stage(unbound, 1, 1, createPage('sources/unbound')))
      .rejects.toMatchObject({ code: 'job_not_bound' });
  });

  it('requires exact owner and proposal digest on retrieval', async () => {
    const jobId = await seedJob();
    const page = await stage(jobId, 1, 1, createPage('sources/example'));
    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, page_digests: [{ sequence: 1, digest: page.digest }], summary: 'Ready.',
    });
    await expect(getOwnedAgentJobProposal(engine, jobId, 'other', manifest.proposalDigest))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(getOwnedAgentJobProposal(engine, jobId, 'lore-client', 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects an aggregate plan over the explicit ceiling without finalizing it', async () => {
    const jobId = await seedJob();
    const pageCount = 5;
    const digests = [];
    for (let sequence = 1; sequence <= pageCount; sequence++) {
      const page = createPage(`sources/large-${sequence}`, 'x'.repeat(165_000));
      digests.push(await stage(jobId, sequence, pageCount, page));
    }
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: pageCount,
      page_digests: digests.map(({ sequence, digest }) => ({ sequence, digest })),
      summary: 'Too large.',
    })).rejects.toMatchObject({ code: 'proposal_too_large' });
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_job_proposals WHERE job_id = $1`,
      [jobId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
    expect(PROPOSAL_AGGREGATE_MAX_BYTES).toBe(786_432);
  });
});
