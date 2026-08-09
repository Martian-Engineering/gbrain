import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import {
  applyAgentJobProposalPage,
  getOwnedApprovedProposalAuthority,
} from '../src/core/minions/agent-job-proposal-apply.ts';
import {
  finalizeAgentJobProposal,
  getOwnedAgentJobProposal,
  stageAgentJobProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';
import { cleanupExpiredIngestionProposalAuthorities } from '../src/core/minions/ingestion-proposal-authority.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let migrationEngine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  migrationEngine = new PGLiteEngine();
  await migrationEngine.connect({});
  await migrationEngine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  await migrationEngine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('company', 'Company') ON CONFLICT (id) DO NOTHING`,
  );
});

interface FrozenCreateProposal {
  proposalJobId: number;
  manifest: Awaited<ReturnType<typeof finalizeAgentJobProposal>>;
  pageDigest: string;
}

/** Finalize one create proposal under the normal ingestion job binding. */
async function finalizeCreateProposal(
  suffix: string,
  queueOptions: {
    remove_on_complete?: boolean;
    remove_on_fail?: boolean;
    verbatimMarkdown?: string;
  } = {},
): Promise<FrozenCreateProposal> {
  const slug = `sources/durable-${suffix}`;
  const jobs = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs
       (name, status, data, queue, priority, created_at,
        remove_on_complete, remove_on_fail)
     VALUES ('subagent', 'waiting', $1::text::jsonb, 'default', 0, now(), $2, $3)
     RETURNING id`,
    [JSON.stringify({
    __owner_client_id: 'lore-client',
    source_id: 'company',
    proposal_artifact_id: `artifact-${suffix}`,
    proposal_capture_page_slug: slug,
    ...(queueOptions.verbatimMarkdown === undefined
      ? {}
      : { proposal_capture_page_verbatim_markdown: queueOptions.verbatimMarkdown }),
    proposal_admission_scope: 'Include durable proposal notes.',
    allowed_slug_prefixes: ['sources/*'],
    }), queueOptions.remove_on_complete ?? false, queueOptions.remove_on_fail ?? false],
  );
  const proposalJobId = Number(jobs[0]!.id);
  const staged = await stageAgentJobProposalPage(engine, proposalJobId, {
    artifact_id: `artifact-${suffix}`,
    source_id: 'company',
    admission_scope: 'Include durable proposal notes.',
    sequence: 1,
    total_pages: 1,
    page_inventory: [{ slug, effect: 'create' }],
    page: { slug, effect: 'create', title: `Durable ${suffix}`, bodyMarkdown: '# Durable' },
  });
  const manifest = await finalizeAgentJobProposal(engine, proposalJobId, {
    artifact_id: `artifact-${suffix}`,
    source_id: 'company',
    admission_scope: 'Include durable proposal notes.',
    total_pages: 1,
    summary: 'One durable page is ready.',
  });
  return { proposalJobId, manifest, pageDigest: staged.digest };
}

/** Submit an apply job bound to one exact finalized proposal. */
async function seedApplyJob(frozen: FrozenCreateProposal): Promise<number> {
  const plan = await getOwnedAgentJobProposal(
    engine,
    frozen.proposalJobId,
    'lore-client',
    frozen.manifest.proposalDigest,
  );
  const jobs = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'waiting', $1::text::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({
    __owner_client_id: 'lore-client',
    source_id: 'company',
    proposal_artifact_id: plan.plan.artifactId,
    proposal_capture_page_slug: plan.plan.proposedPages[0]!.slug,
    proposal_admission_scope: plan.plan.admissionScope,
    allowed_slug_prefixes: ['sources/*'],
    approved_proposal_job_id: frozen.proposalJobId,
    approved_proposal_digest: frozen.manifest.proposalDigest,
    approved_proposal_page_digests: frozen.manifest.pageDigests,
    approved_proposal_timeline_digests: frozen.manifest.timelineDigests,
    approved_proposal_link_digests: frozen.manifest.linkDigests,
    approved_proposal_inventory_digest: frozen.manifest.inventoryDigest,
    })],
  );
  return Number(jobs[0]!.id);
}

describe('durable ingestion proposal authority', () => {
  it('survives every ordinary origin-job deletion boundary', async () => {
    const removed = await finalizeCreateProposal('removed');
    await queue.cancelJob(removed.proposalJobId);
    expect(await queue.removeJob(removed.proposalJobId)).toBe(true);

    const pruned = await finalizeCreateProposal('pruned');
    await queue.cancelJob(pruned.proposalJobId);
    expect(await queue.prune({
      olderThan: new Date(Date.now() + 60_000),
      status: ['cancelled'],
    })).toBe(1);

    const completed = await finalizeCreateProposal('completed', { remove_on_complete: true });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'complete-token' WHERE id = $1`,
      [completed.proposalJobId],
    );
    await queue.completeJob(completed.proposalJobId, 'complete-token');

    const failed = await finalizeCreateProposal('failed', { remove_on_fail: true });
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET status = 'active', lock_token = 'fail-token', attempts_started = 1
        WHERE id = $1`,
      [failed.proposalJobId],
    );
    await queue.failJob(failed.proposalJobId, 'fail-token', 'expected test failure', 'dead');

    for (const frozen of [removed, pruned, completed, failed]) {
      const owned = await getOwnedAgentJobProposal(
        engine,
        frozen.proposalJobId,
        'lore-client',
        frozen.manifest.proposalDigest,
      );
      expect(owned.plan.summary).toBe('One durable page is ready.');
      const authority = await engine.executeRaw<{ origin_job_id: number | null }>(
        `SELECT origin_job_id FROM ingestion_proposal_authorities WHERE proposal_id = $1`,
        [frozen.proposalJobId],
      );
      expect(authority[0]?.origin_job_id).toBeNull();
    }
  });

  it('retrieves capture authority and applies after the origin job is pruned', async () => {
    const frozen = await finalizeCreateProposal('apply-after-prune');
    await queue.cancelJob(frozen.proposalJobId);
    await queue.prune({
      olderThan: new Date(Date.now() + 60_000),
      status: ['cancelled'],
    });

    const approved = await getOwnedApprovedProposalAuthority(
      engine,
      frozen.proposalJobId,
      'lore-client',
      frozen.manifest.proposalDigest,
    );
    const applyJobId = await seedApplyJob(frozen);
    const result = await applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.pageDigest,
      source_id: 'company',
    });

    expect(approved.capturePageSlug).toBe('sources/durable-apply-after-prune');
    expect(result.status).toBe('applied');
    expect(await engine.getPage('sources/durable-apply-after-prune', { sourceId: 'company' }))
      .not.toBeNull();
  });

  it('applies exact opaque source Markdown through the durable authority', async () => {
    const verbatimMarkdown = [
      '# Transcript',
      '',
      '<!-- timeline -->',
      '<!-- gbrain:source:begin -->',
      'Speaker: Exact source text.',
      '<!-- gbrain:source:end -->',
      '',
    ].join('\n');
    const frozen = await finalizeCreateProposal('opaque-source', {
      verbatimMarkdown,
    });
    const applyJobId = await seedApplyJob(frozen);
    await applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.pageDigest,
      source_id: 'company',
    });

    const page = await engine.getPage('sources/durable-opaque-source', {
      sourceId: 'company',
    });
    expect(page?.compiled_truth).toBe(verbatimMarkdown);
  });

  it('fails closed after expiry, mutates nothing, and cleans private authority explicitly', async () => {
    const frozen = await finalizeCreateProposal('expired');
    const applyJobId = await seedApplyJob(frozen);
    await engine.executeRaw(
      `UPDATE ingestion_proposal_authorities
          SET finalized_at = now() - interval '2 seconds',
              expires_at = now() - interval '1 second'
        WHERE proposal_id = $1`,
      [frozen.proposalJobId],
    );

    await expect(getOwnedAgentJobProposal(
      engine,
      frozen.proposalJobId,
      'lore-client',
      frozen.manifest.proposalDigest,
    )).rejects.toMatchObject({ code: 'proposal_authority_expired' });
    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.pageDigest,
      source_id: 'company',
    })).rejects.toMatchObject({ code: 'proposal_authority_expired' });

    expect(await engine.getPage('sources/durable-expired', { sourceId: 'company' })).toBeNull();
    const receipts = await engine.executeRaw<{ applied_at: string | null }>(
      `SELECT applied_at FROM ingestion_proposal_authority_pages WHERE proposal_id = $1`,
      [frozen.proposalJobId],
    );
    expect(receipts).toEqual([{ applied_at: null }]);

    expect(await cleanupExpiredIngestionProposalAuthorities(engine, new Date())).toBe(1);
    const remaining = await engine.executeRaw<{ count: string }>(
      `SELECT (
                SELECT count(*)
                  FROM ingestion_proposal_authority_pages
                 WHERE proposal_id = $1
              ) + (
                SELECT count(*)
                  FROM agent_job_proposal_fragments
                 WHERE job_id = $1
              ) + (
                SELECT count(*)
                  FROM agent_job_proposals
                 WHERE job_id = $1
              ) AS count`,
      [frozen.proposalJobId],
    );
    expect(Number(remaining[0]?.count)).toBe(0);
  });

  it('keeps missing, owner-mismatched, and digest-mismatched authority non-enumerable', async () => {
    const frozen = await finalizeCreateProposal('isolated');
    await expect(getOwnedAgentJobProposal(
      engine,
      frozen.proposalJobId,
      'other-client',
      frozen.manifest.proposalDigest,
    )).rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    await expect(getOwnedAgentJobProposal(
      engine,
      frozen.proposalJobId,
      'lore-client',
      'f'.repeat(64),
    )).rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    await expect(getOwnedAgentJobProposal(
      engine,
      frozen.proposalJobId + 100_000,
      'lore-client',
      frozen.manifest.proposalDigest,
    )).rejects.toMatchObject({ code: 'proposal_authority_unavailable' });

    const applyJobId = await seedApplyJob(frozen);
    const exactInput = {
      proposal_job_id: frozen.proposalJobId,
      proposal_digest: frozen.manifest.proposalDigest,
      sequence: 1,
      page_digest: frozen.pageDigest,
      source_id: 'company',
    };
    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      ...exactInput,
      proposal_digest: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    await expect(applyAgentJobProposalPage(engine, applyJobId, {
      ...exactInput,
      proposal_job_id: frozen.proposalJobId + 100_000,
    })).rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    await engine.executeRaw(
      `DELETE FROM ingestion_proposal_authority_pages
        WHERE proposal_id = $1 AND sequence = 1`,
      [frozen.proposalJobId],
    );
    await expect(applyAgentJobProposalPage(engine, applyJobId, exactInput))
      .rejects.toMatchObject({ code: 'proposal_authority_page_missing' });
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{__owner_client_id}', '"other-client"'::jsonb)
        WHERE id = $1`,
      [applyJobId],
    );
    await expect(applyAgentJobProposalPage(engine, applyJobId, exactInput))
      .rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    expect(await engine.getPage('sources/durable-isolated', { sourceId: 'company' })).toBeNull();
  });

  it('backfills legacy finalized evidence with non-cascading origin identity', async () => {
    await migrationEngine.executeRaw('DROP TABLE ingestion_proposal_authority_pages');
    await migrationEngine.executeRaw('DROP TABLE ingestion_proposal_authorities');
    const jobs = await migrationEngine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'completed', $1::text::jsonb, 'default', 0, now())
       RETURNING id`,
      [JSON.stringify({ proposal_capture_page_slug: 'sources/migrated' })],
    );
    const proposalId = Number(jobs[0]!.id);
    const digest = 'a'.repeat(64);
    await migrationEngine.executeRaw(
      `INSERT INTO agent_job_proposal_fragments
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          sequence, total_pages, page, page_digest)
       VALUES ($1, 'lore-client', 'company', 'artifact-migrated', 'scope',
               1, 1, $2::text::jsonb, $3)`,
      [
        proposalId,
        JSON.stringify({
          slug: 'sources/migrated',
          effect: 'create',
          title: 'Migrated',
          bodyMarkdown: '# Migrated',
        }),
        digest,
      ],
    );
    await migrationEngine.executeRaw(
      `INSERT INTO agent_job_proposals
         (job_id, owner_client_id, source_id, artifact_id, admission_scope,
          total_pages, page_digests, plan, proposal_digest, manifest)
       VALUES ($1, 'lore-client', 'company', 'artifact-migrated', 'scope',
               1, $2::text::jsonb, $3::text::jsonb, $4, $5::text::jsonb)`,
      [
        proposalId,
        JSON.stringify([{ sequence: 1, slug: 'sources/migrated', digest }]),
        JSON.stringify({ proposedPages: [{ slug: 'sources/migrated' }] }),
        digest,
        JSON.stringify({ status: 'staged_proposal' }),
      ],
    );

    const migrationSql = MIGRATIONS.find(candidate => candidate.version === 138)?.sqlFor?.pglite;
    expect(typeof migrationSql).toBe('string');
    await migrationEngine.runMigration(138, migrationSql!);
    const promoted = await migrationEngine.executeRaw<{
      origin_job_id: number | null;
      capture_page_slug: string;
      page_count: string;
      unexpired: boolean;
    }>(
      `SELECT p.origin_job_id, p.capture_page_slug,
              count(f.sequence)::text AS page_count,
              p.expires_at > now() AS unexpired
         FROM ingestion_proposal_authorities p
         JOIN ingestion_proposal_authority_pages f
           ON f.proposal_id = p.proposal_id
        WHERE p.proposal_id = $1
        GROUP BY p.proposal_id, p.origin_job_id, p.capture_page_slug, p.expires_at`,
      [proposalId],
    );
    expect(promoted).toEqual([{
      origin_job_id: proposalId,
      capture_page_slug: 'sources/migrated',
      page_count: '1',
      unexpired: true,
    }]);

    await migrationEngine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [proposalId]);
    const retained = await migrationEngine.executeRaw<{ origin_job_id: number | null }>(
      `SELECT origin_job_id FROM ingestion_proposal_authorities WHERE proposal_id = $1`,
      [proposalId],
    );
    expect(retained).toEqual([{ origin_job_id: null }]);
  });
});
