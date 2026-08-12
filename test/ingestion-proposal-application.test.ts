import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  applyAgentJobProposalPage,
  getOwnedApprovedProposalAuthority,
  type ApprovedProposalAuthority,
} from '../src/core/minions/agent-job-proposal-apply.ts';
import {
  finalizeAgentJobProposalApplication,
} from '../src/core/minions/agent-job-proposal-application.ts';
import { applyAgentJobProposalRelation } from '../src/core/minions/agent-job-proposal-relation-apply.ts';
import {
  finalizeAgentJobProposal,
  stageAgentJobProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const APPROVED_UPDATE_MARKDOWN = '# Target\n\nApproved current synthesis.\n';

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

async function seedJob(data: Record<string, unknown>): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::text::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify(data)],
  );
  return Number(rows[0]!.id);
}

async function seedCorpus(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('company', 'Company') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
     VALUES ('company', 'projects/target', 'project', 'Target', '# Target', $1)`,
    ['b'.repeat(64)],
  );
}

async function freezeProposal(
  options: { ordinaryCreateBody?: string } = {},
): Promise<ApprovedProposalAuthority> {
  const jobId = await seedJob({
    __owner_client_id: 'lore-client',
    source_id: 'company',
    proposal_artifact_id: 'artifact-1',
    proposal_capture_page_slug: 'sources/capture',
    proposal_admission_scope: 'Include source-grounded delivery notes.',
    allowed_slug_prefixes: ['sources/*', 'projects/*'],
  });
  const secondSlug = options.ordinaryCreateBody === undefined
    ? 'projects/target'
    : 'projects/new-target';
  const inventory = [
    { slug: 'sources/capture', effect: 'create' as const },
    {
      slug: secondSlug,
      effect: options.ordinaryCreateBody === undefined
        ? 'update' as const
        : 'create' as const,
    },
  ];
  await stageAgentJobProposalPage(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    sequence: 1,
    total_pages: 2,
    page_inventory: inventory,
    page: {
      slug: 'sources/capture',
      effect: 'create',
      title: 'Capture',
      bodyMarkdown: '# Capture\n\nComplete source record.',
    },
  });
  await stageAgentJobProposalPage(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    sequence: 2,
    total_pages: 2,
    page_inventory: inventory,
    page: options.ordinaryCreateBody === undefined
      ? {
        slug: secondSlug,
        effect: 'update',
        title: 'Target',
        bodyMarkdown: APPROVED_UPDATE_MARKDOWN,
        baseMarkdown: '# Target',
        expectedContentHash: 'b'.repeat(64),
      }
      : {
        slug: secondSlug,
        effect: 'create',
        title: 'New target',
        bodyMarkdown: options.ordinaryCreateBody,
      },
  });
  const manifest = await finalizeAgentJobProposal(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: 'Include source-grounded delivery notes.',
    total_pages: 2,
    summary: 'Capture and target update.',
    proposed_timeline_entries: [{
      pageSlug: secondSlug,
      date: '2026-08-08',
      text: 'Approved delivery milestone.',
      ref: 'sources/capture',
      refLabel: 'Source record',
    }],
    proposed_links: [{
      from: 'sources/capture',
      to: secondSlug,
      type: 'documents',
    }],
  });
  return getOwnedApprovedProposalAuthority(
    engine,
    jobId,
    'lore-client',
    manifest.proposalDigest,
  );
}

async function seedApplyJob(authority: ApprovedProposalAuthority): Promise<number> {
  return seedJob({
    __owner_client_id: authority.ownerClientId,
    source_id: authority.sourceId,
    proposal_artifact_id: authority.artifactId,
    proposal_capture_page_slug: authority.capturePageSlug,
    proposal_admission_scope: authority.admissionScope,
    allowed_slug_prefixes: ['sources/*', 'projects/*'],
    approved_proposal_job_id: authority.proposalJobId,
    approved_proposal_digest: authority.proposalDigest,
    approved_proposal_page_digests: authority.pageDigests,
    approved_proposal_timeline_digests: authority.timelineDigests,
    approved_proposal_link_digests: authority.linkDigests,
    approved_proposal_inventory_digest: authority.inventoryDigest,
  });
}

function pageInput(authority: ApprovedProposalAuthority, sequence: number) {
  return {
    proposal_job_id: authority.proposalJobId,
    proposal_digest: authority.proposalDigest,
    source_id: authority.sourceId,
    sequence,
    page_digest: authority.pageDigests[sequence - 1]!.digest,
  };
}

function relationInput(
  authority: ApprovedProposalAuthority,
  relationKind: 'timeline' | 'link',
  sequence: number,
) {
  return {
    proposal_job_id: authority.proposalJobId,
    proposal_digest: authority.proposalDigest,
    source_id: authority.sourceId,
    relation_kind: relationKind,
    sequence,
  };
}

describe('approved ingestion proposal application contract', () => {
  it('publishes server-bound relation application and whole-plan finalization', () => {
    const relation = operationsByName.apply_ingestion_proposal_relation;
    const finalize = operationsByName.finalize_ingestion_proposal_application;

    expect(relation).toMatchObject({ mutating: true, scope: 'agent' });
    expect(Object.keys(relation!.params).sort()).toEqual([
      'proposal_digest',
      'proposal_job_id',
      'relation_kind',
      'sequence',
      'source_id',
    ]);
    expect(finalize).toMatchObject({ mutating: false, scope: 'agent' });
    expect(Object.keys(finalize!.params).sort()).toEqual([
      'proposal_digest',
      'proposal_job_id',
      'source_id',
    ]);
  });
});

describe('whole approved proposal application', () => {
  it('preserves an ordinary frozen create body byte-for-byte', async () => {
    await seedCorpus();
    const bodyMarkdown = [
      '---',
      'type: meeting',
      'date: 2026-08-09',
      '---',
      '',
      '# Exact approved body',
      '',
    ].join('\n');
    const authority = await freezeProposal({ ordinaryCreateBody: bodyMarkdown });
    const applyJobId = await seedApplyJob(authority);

    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 1));
    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 2));

    const page = await engine.getPage('projects/new-target', { sourceId: 'company' });
    expect(page?.compiled_truth).toBe(bodyMarkdown);
  });

  it('preflights every later slot before the first corpus mutation', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    const applyJobId = await seedApplyJob(authority);
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = '# Rewritten', content_hash = $1
        WHERE source_id = 'company' AND slug = 'projects/target'`,
      ['c'.repeat(64)],
    );

    await expect(applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 1)))
      .rejects.toMatchObject({ code: 'stale_page' });

    expect(await engine.getPage('sources/capture', { sourceId: 'company' })).toBeNull();
    const [counts] = await engine.executeRaw<{ links: number; timeline: number; outcomes: number }>(
      `SELECT (SELECT COUNT(*)::int FROM links) AS links,
              (SELECT COUNT(*)::int FROM timeline_entries) AS timeline,
              (SELECT COUNT(*)::int FROM ingestion_proposal_relation_outcomes) AS outcomes`,
    );
    expect(counts).toEqual({ links: 0, timeline: 0, outcomes: 0 });
  });

  it('rejects off-plan and out-of-order relations without accepting relation content', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    const applyJobId = await seedApplyJob(authority);

    await expect(applyAgentJobProposalRelation(engine, applyJobId, {
      ...relationInput(authority, 'timeline', 1),
      text: 'model-supplied mutation',
    } as never)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'timeline', 2),
    )).rejects.toMatchObject({ code: 'off_plan_relation' });
    await expect(applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'timeline', 1),
    )).rejects.toMatchObject({ code: 'out_of_order' });

    const [counts] = await engine.executeRaw<{ links: number; timeline: number }>(
      `SELECT (SELECT COUNT(*)::int FROM links) AS links,
              (SELECT COUNT(*)::int FROM timeline_entries) AS timeline`,
    );
    expect(counts).toEqual({ links: 0, timeline: 0 });
  });

  it('applies exact frozen relations once and returns replay proof', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    const applyJobId = await seedApplyJob(authority);
    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 1));
    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 2));

    const updated = await engine.getPage('projects/target', { sourceId: 'company' });
    expect(updated?.compiled_truth).toBe(APPROVED_UPDATE_MARKDOWN);

    const timeline = await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'timeline', 1),
    );
    await engine.executeRaw(
      `UPDATE ingestion_proposal_relation_outcomes
          SET write_through = '{"written":false,"error":"temporary disk failure"}'::jsonb
        WHERE proposal_id = $1 AND relation_kind = 'timeline' AND sequence = 1`,
      [authority.proposalJobId],
    );
    const timelineReplay = await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'timeline', 1),
    );
    const link = await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'link', 1),
    );
    const linkReplay = await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'link', 1),
    );

    expect(timeline).toMatchObject({
      status: 'applied',
      relation_kind: 'timeline',
      sequence: 1,
      relation_digest: authority.timelineDigests[0]!.digest,
      target_slug: 'projects/target',
    });
    expect(timelineReplay).toEqual({ ...timeline, status: 'already_applied' });
    expect(link).toMatchObject({
      status: 'applied',
      relation_kind: 'link',
      sequence: 1,
      relation_digest: authority.linkDigests[0]!.digest,
      target_slug: 'sources/capture',
    });
    expect(linkReplay).toEqual({ ...link, status: 'already_applied' });
    const [counts] = await engine.executeRaw<{ links: number; timeline: number; outcomes: number }>(
      `SELECT (SELECT COUNT(*)::int FROM links) AS links,
              (SELECT COUNT(*)::int FROM timeline_entries) AS timeline,
              (SELECT COUNT(*)::int FROM ingestion_proposal_relation_outcomes) AS outcomes`,
    );
    expect(counts).toEqual({ links: 1, timeline: 1, outcomes: 2 });
  });

  it('serializes two apply jobs racing for the same frozen slots', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    const firstApplyJobId = await seedApplyJob(authority);
    const secondApplyJobId = await seedApplyJob(authority);

    for (const sequence of [1, 2]) {
      const results = await Promise.all([
        applyAgentJobProposalPage(engine, firstApplyJobId, pageInput(authority, sequence)),
        applyAgentJobProposalPage(engine, secondApplyJobId, pageInput(authority, sequence)),
      ]);
      expect(results.map(result => result.status).sort()).toEqual(['already_applied', 'applied']);
    }

    for (const kind of ['timeline', 'link'] as const) {
      const results = await Promise.all([
        applyAgentJobProposalRelation(
          engine,
          firstApplyJobId,
          relationInput(authority, kind, 1),
        ),
        applyAgentJobProposalRelation(
          engine,
          secondApplyJobId,
          relationInput(authority, kind, 1),
        ),
      ]);
      expect(results.map(result => result.status).sort()).toEqual(['already_applied', 'applied']);
    }

    const [counts] = await engine.executeRaw<{
      links: number;
      timeline: number;
      outcomes: number;
      applicationRuns: number;
    }>(
      `SELECT (SELECT COUNT(*)::int FROM links) AS links,
              (SELECT COUNT(*)::int FROM timeline_entries) AS timeline,
              (SELECT COUNT(*)::int FROM ingestion_proposal_relation_outcomes) AS outcomes,
              (SELECT COUNT(*)::int FROM ingestion_proposal_application_runs) AS "applicationRuns"`,
    );
    expect(counts).toEqual({ links: 1, timeline: 1, outcomes: 2, applicationRuns: 1 });
  });

  it('resumes across apply jobs and finalizes only a complete current inventory', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    const firstApplyJobId = await seedApplyJob(authority);
    await applyAgentJobProposalPage(engine, firstApplyJobId, pageInput(authority, 1));
    await applyAgentJobProposalPage(engine, firstApplyJobId, pageInput(authority, 2));

    const resumedApplyJobId = await seedApplyJob(authority);
    await applyAgentJobProposalRelation(
      engine,
      resumedApplyJobId,
      relationInput(authority, 'timeline', 1),
    );
    await expect(finalizeAgentJobProposalApplication(engine, resumedApplyJobId, {
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
    })).rejects.toMatchObject({ code: 'incomplete_application' });
    await applyAgentJobProposalRelation(
      engine,
      resumedApplyJobId,
      relationInput(authority, 'link', 1),
    );

    const complete = await finalizeAgentJobProposalApplication(engine, resumedApplyJobId, {
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
    });
    const replay = await finalizeAgentJobProposalApplication(engine, resumedApplyJobId, {
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
    });
    expect(complete).toMatchObject({
      status: 'applied_proposal',
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
      inventory_digest: authority.inventoryDigest,
      pages: { total: 2, applied: 2 },
      timeline_entries: { total: 1, applied: 1 },
      links: { total: 1, applied: 1 },
      receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(replay).toEqual({ ...complete, status: 'already_finalized' });

    await engine.executeRaw(
      `DELETE FROM links WHERE id = (
        SELECT observed_row_id FROM ingestion_proposal_relation_outcomes
         WHERE proposal_id = $1 AND relation_kind = 'link' AND sequence = 1
      )`,
      [authority.proposalJobId],
    );
    await expect(finalizeAgentJobProposalApplication(engine, resumedApplyJobId, {
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
    })).rejects.toMatchObject({ code: 'stale_relation' });
  });

  it('applies and finalizes after ordinary retention removes the origin job', async () => {
    await seedCorpus();
    const authority = await freezeProposal();
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [authority.proposalJobId]);
    const [retained] = await engine.executeRaw<{ origin_job_id: number | null; pages: number }>(
      `SELECT p.origin_job_id,
              (SELECT COUNT(*)::int FROM ingestion_proposal_authority_pages f
                WHERE f.proposal_id = p.proposal_id) AS pages
         FROM ingestion_proposal_authorities p
        WHERE p.proposal_id = $1`,
      [authority.proposalJobId],
    );
    expect(retained).toEqual({ origin_job_id: null, pages: 2 });

    const applyJobId = await seedApplyJob(authority);
    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 1));
    await applyAgentJobProposalPage(engine, applyJobId, pageInput(authority, 2));
    await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'timeline', 1),
    );
    await applyAgentJobProposalRelation(
      engine,
      applyJobId,
      relationInput(authority, 'link', 1),
    );
    const receipt = await finalizeAgentJobProposalApplication(engine, applyJobId, {
      proposal_job_id: authority.proposalJobId,
      proposal_digest: authority.proposalDigest,
      source_id: authority.sourceId,
    });

    expect(receipt).toMatchObject({
      status: 'applied_proposal',
      inventory_digest: authority.inventoryDigest,
      pages: { total: 2, applied: 2 },
      timeline_entries: { total: 1, applied: 1 },
      links: { total: 1, applied: 1 },
    });
  });
});
