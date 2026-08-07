import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PROPOSAL_AGGREGATE_MAX_BYTES,
  PROPOSAL_MANIFEST_MAX_BYTES,
  PROPOSAL_MAX_PAGES,
  PROPOSAL_STAGE_INPUT_MAX_BYTES,
  assertProposalToolTurnPersistable,
  assertProposalToolTurnPersistableForJob,
  canonicalProposalJson,
  digestProposalValue,
  finalizeAgentJobProposal,
  getOwnedAgentJobProposal,
  stageAgentJobProposalPage,
  type ScopedProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';
import { compactToolLoopMessages } from '../src/core/ai/tool-loop-context.ts';
import type { ChatMessage } from '../src/core/ai/gateway.ts';

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
      proposal_capture_page_slug: 'sources/example',
      proposal_admission_scope: 'Include project delivery notes.',
      allowed_slug_prefixes: ['sources/*', 'projects/*'],
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
  admissionScope = 'Include project delivery notes.',
) {
  return stageAgentJobProposalPage(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: admissionScope,
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
  it('rejects proposal page counts above the shared 100-page contract', async () => {
    const jobId = await seedJob();
    await expect(stage(jobId, 1, 101, createPage('sources/too-many')))
      .rejects.toMatchObject({ code: 'invalid_total_pages' });
    expect(PROPOSAL_MAX_PAGES).toBe(100);
  });

  it('stages exact pages, finalizes an ordered manifest, and retrieves the full owned plan', async () => {
    const jobId = await seedJob();
    const first = await stage(jobId, 1, 2, createPage('sources/example'));
    const second = await stage(jobId, 2, 2, updatePage('projects/example'));

    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 2,
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

  it('finalizes from the durable ordered manifest after old stage outputs compact away', async () => {
    const jobId = await seedJob();
    const first = await stage(jobId, 1, 2, createPage('sources/example'));
    const second = await stage(jobId, 2, 2, createPage('projects/example'));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Build the exact ingestion proposal.' }];
    for (const page of [first, second]) {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `stage-${page.sequence}`,
          toolName: 'brain_stage_ingestion_proposal_page',
          input: { sequence: page.sequence, body: 'x'.repeat(1_500) },
        }],
      });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: `stage-${page.sequence}`,
          toolName: 'brain_stage_ingestion_proposal_page',
          output: page,
        }],
      });
    }
    const compacted = compactToolLoopMessages(messages, 2_000, { mutatingToolNames: new Set() });
    expect(JSON.stringify(compacted)).not.toContain(first.digest);

    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 2,
      summary: 'Ready after compaction.',
    });
    expect(manifest.pageDigests).toEqual([first, second]);
  });

  it('freezes a previously-null admission scope on the first stage only', async () => {
    const jobId = await seedJob({ proposal_admission_scope: null });
    const page = createPage('sources/example');
    const firstInput = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Derived resolver scope.',
      sequence: 1, total_pages: 2, page,
    };
    await assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: firstInput,
    }]);
    const [preflightRow] = await engine.executeRaw<{ scope: string | null }>(
      `SELECT data->>'proposal_admission_scope' AS scope FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(preflightRow!.scope).toBeNull();
    const first = await stage(jobId, 1, 2, page, 'Derived resolver scope.');
    expect(await stage(jobId, 1, 2, page, 'Derived resolver scope.')).toEqual(first);
    const [row] = await engine.executeRaw<{ scope: string | null }>(
      `SELECT data->>'proposal_admission_scope' AS scope FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(row!.scope).toBe('Derived resolver scope.');
    await expect(stage(jobId, 2, 2, createPage('projects/example'), 'Different scope.'))
      .rejects.toMatchObject({ code: 'binding_mismatch' });
  });

  it('requires pre-bound owner, source, artifact, capture slug, and slug fences', async () => {
    for (const overrides of [
      { __owner_client_id: null },
      { source_id: null },
      { proposal_artifact_id: null },
      { proposal_capture_page_slug: null },
      { allowed_slug_prefixes: [] },
    ]) {
      const jobId = await seedJob(overrides);
      await expect(stage(jobId, 1, 1, createPage('sources/example')))
        .rejects.toMatchObject({ code: 'job_not_bound' });
    }
  });

  it('fences proposed page, timeline target, link source, and exact capture provenance', async () => {
    const unauthorizedJob = await seedJob();
    await expect(stage(unauthorizedJob, 1, 1, createPage('private/example')))
      .rejects.toMatchObject({ code: 'slug_not_allowed' });

    const jobId = await seedJob();
    await stage(jobId, 1, 2, createPage('sources/example'));
    await stage(jobId, 2, 2, createPage('projects/example'));
    const common = {
      artifact_id: 'artifact-1', source_id: 'company',
      admission_scope: 'Include project delivery notes.', total_pages: 2,
      summary: 'Ready.',
    };
    await expect(finalizeAgentJobProposal(engine, jobId, {
      ...common,
      proposed_timeline_entries: [{
        pageSlug: 'private/existing', date: '2026-08-07', text: 'Event.', ref: 'sources/example',
      }],
    })).rejects.toMatchObject({ code: 'slug_not_allowed' });
    await expect(finalizeAgentJobProposal(engine, jobId, {
      ...common,
      proposed_timeline_entries: [{
        pageSlug: 'projects/example', date: '2026-08-07', text: 'Event.', ref: 'projects/example',
      }],
    })).rejects.toMatchObject({ code: 'invalid_timeline_capture' });
    await expect(finalizeAgentJobProposal(engine, jobId, {
      ...common,
      proposed_links: [{ from: 'private/example', to: 'projects/example', type: 'documents' }],
    })).rejects.toMatchObject({ code: 'slug_not_allowed' });

    const missingCaptureJob = await seedJob();
    await stage(missingCaptureJob, 1, 1, createPage('projects/example'));
    await expect(finalizeAgentJobProposal(engine, missingCaptureJob, {
      artifact_id: 'artifact-1', source_id: 'company',
      admission_scope: 'Include project delivery notes.', total_pages: 1, summary: 'Missing capture.',
    })).rejects.toMatchObject({ code: 'missing_capture_page' });
  });

  it('rejects duplicate canonical timeline and link mutations', async () => {
    const jobId = await seedJob();
    await stage(jobId, 1, 1, createPage('sources/example'));
    const common = {
      artifact_id: 'artifact-1', source_id: 'company',
      admission_scope: 'Include project delivery notes.', total_pages: 1, summary: 'Ready.',
    };
    const timeline = {
      pageSlug: 'sources/example', date: '2026-08-07', text: 'Event.',
      ref: 'sources/example', refLabel: 'Capture',
    };
    await expect(finalizeAgentJobProposal(engine, jobId, {
      ...common, proposed_timeline_entries: [timeline, { ...timeline }],
    })).rejects.toMatchObject({ code: 'duplicate_timeline' });
    const link = { from: 'sources/example', to: 'projects/example', type: 'documents' };
    await expect(finalizeAgentJobProposal(engine, jobId, {
      ...common, proposed_links: [link, { ...link }],
    })).rejects.toMatchObject({ code: 'duplicate_links' });
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
    await stage(firstJobId, 1, 1, page);
    await stage(secondJobId, 1, 1, page);
    const input = {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      summary: 'Ready.',
    };

    const first = await finalizeAgentJobProposal(engine, firstJobId, input);
    const second = await finalizeAgentJobProposal(engine, secondJobId, input);

    expect(second.proposalDigest).toBe(first.proposalDigest);
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_job_proposals
        WHERE owner_client_id = 'lore-client' AND proposal_digest = $1`,
      [first.proposalDigest],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('rejects gaps, corrupted stored digests, and duplicate page slugs', async () => {
    const gapJob = await seedJob();
    await stage(gapJob, 1, 2, createPage('sources/gap'));
    await expect(finalizeAgentJobProposal(engine, gapJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, summary: 'Gap.',
    })).rejects.toMatchObject({ code: 'fragment_gap' });

    const corruptedDigestJob = await seedJob();
    await stage(corruptedDigestJob, 1, 1, createPage('sources/example'));
    await engine.executeRaw(
      `UPDATE agent_job_proposal_fragments SET page_digest = $2 WHERE job_id = $1`,
      [corruptedDigestJob, 'f'.repeat(64)],
    );
    await expect(finalizeAgentJobProposal(engine, corruptedDigestJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, summary: 'Mismatch.',
    })).rejects.toMatchObject({ code: 'digest_mismatch' });

    const duplicatePageJob = await seedJob();
    await stage(duplicatePageJob, 1, 2, createPage('sources/same'));
    await stage(duplicatePageJob, 2, 2, updatePage('sources/same'));
    await expect(finalizeAgentJobProposal(engine, duplicatePageJob, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 2, summary: 'Duplicate page.',
    })).rejects.toMatchObject({ code: 'duplicate_page' });
  });

  it('rejects calendar-normalized dates instead of accepting them as strict dates', async () => {
    const jobId = await seedJob();
    await stage(jobId, 1, 1, createPage('sources/example'));
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      summary: 'Invalid date.',
      proposed_timeline_entries: [{
        pageSlug: 'sources/example',
        date: '2026-02-31',
        text: 'Impossible date.',
        ref: 'sources/example',
      }],
    })).rejects.toMatchObject({ code: 'invalid_timeline' });
  });

  it('rejects timeline reference labels above the shared 500-character contract', async () => {
    const jobId = await seedJob();
    await stage(jobId, 1, 1, createPage('sources/example'));
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1,
      summary: 'Invalid reference label.',
      proposed_timeline_entries: [{
        pageSlug: 'sources/example',
        date: '2026-08-07',
        text: 'Delivery review completed.',
        ref: 'sources/example',
        refLabel: 'x'.repeat(501),
      }],
    })).rejects.toMatchObject({ code: 'invalid_string' });
  });

  it('rejects job, owner, source, artifact, scope, and stored-fragment binding mismatches', async () => {
    const jobId = await seedJob();
    await expect(stageAgentJobProposalPage(engine, jobId, {
      artifact_id: 'other', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: 1, total_pages: 1, page: createPage('sources/example'),
    })).rejects.toMatchObject({ code: 'binding_mismatch' });

    await stage(jobId, 1, 1, createPage('sources/example'));
    await engine.executeRaw(
      `UPDATE agent_job_proposal_fragments SET source_id = 'other' WHERE job_id = $1`,
      [jobId],
    );
    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, summary: 'Ready.',
    })).rejects.toMatchObject({ code: 'binding_mismatch' });

    const unbound = await seedJob({ proposal_artifact_id: null });
    await expect(stage(unbound, 1, 1, createPage('sources/unbound')))
      .rejects.toMatchObject({ code: 'job_not_bound' });
  });

  it('requires exact owner and proposal digest on retrieval', async () => {
    const jobId = await seedJob();
    await stage(jobId, 1, 1, createPage('sources/example'));
    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, summary: 'Ready.',
    });
    await expect(getOwnedAgentJobProposal(engine, jobId, 'other', manifest.proposalDigest))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(getOwnedAgentJobProposal(engine, jobId, 'lore-client', 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('rejects cumulative staged pages over the aggregate ceiling without persisting the crossing fragment', async () => {
    const jobId = await seedJob();
    const pageCount = 5;
    for (let sequence = 1; sequence < pageCount; sequence++) {
      const page = createPage(`sources/large-${sequence}`, 'x'.repeat(165_000));
      await stage(jobId, sequence, pageCount, page);
    }
    const crossingInput = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: pageCount, total_pages: pageCount,
      page: createPage(`sources/large-${pageCount}`, 'x'.repeat(165_000)),
    };
    await expect(assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: crossingInput,
    }])).rejects.toMatchObject({ code: 'proposal_too_large' });
    const replayInput = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: pageCount - 1, total_pages: pageCount,
      page: createPage(`sources/large-${pageCount - 1}`, 'x'.repeat(165_000)),
    };
    await expect(assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: replayInput,
    }])).resolves.toBeUndefined();
    await expect(stageAgentJobProposalPage(engine, jobId, crossingInput))
      .rejects.toMatchObject({ code: 'proposal_too_large' });
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_job_proposal_fragments WHERE job_id = $1`,
      [jobId],
    );
    expect(Number(rows[0]!.count)).toBe(pageCount - 1);
    expect(PROPOSAL_AGGREGATE_MAX_BYTES).toBe(786_432);
    expect(PROPOSAL_MANIFEST_MAX_BYTES).toBe(256 * 1024);
  });

  it('accepts a raw aggregate plan exactly at the shared ceiling', async () => {
    const jobId = await seedJob();
    const pageCount = 5;
    const pages = Array.from({ length: pageCount }, (_, index) =>
      createPage(index === 0 ? 'sources/example' : `sources/boundary-${index + 1}`, 'x'.repeat(150_000)));
    const basePlan = {
      artifactId: 'artifact-1',
      sourceId: 'company',
      admissionScope: 'Include project delivery notes.',
      summary: 'Boundary.',
      proposedPages: pages,
      proposedTimelineEntries: [],
      proposedLinks: [],
      unresolved: [],
    };
    const remaining = PROPOSAL_AGGREGATE_MAX_BYTES -
      Buffer.byteLength(canonicalProposalJson(basePlan), 'utf8');
    pages[pageCount - 1]!.bodyMarkdown += 'y'.repeat(remaining);
    for (let sequence = 1; sequence <= pageCount; sequence++) {
      await stage(jobId, sequence, pageCount, pages[sequence - 1]!);
    }

    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: pageCount,
      summary: 'Boundary.',
    });
    const owned = await getOwnedAgentJobProposal(
      engine,
      jobId,
      'lore-client',
      manifest.proposalDigest,
    );
    expect(Buffer.byteLength(canonicalProposalJson(owned.plan), 'utf8'))
      .toBe(PROPOSAL_AGGREGATE_MAX_BYTES);
  });
});
