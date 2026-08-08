import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PROPOSAL_AGGREGATE_MAX_BYTES,
  PROPOSAL_ESCAPED_PLAN_MAX_BYTES,
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
  type ProposalPageInventoryEntry,
  type ScopedProposalPage,
} from '../src/core/minions/agent-job-proposals.ts';
import { compactToolLoopMessages } from '../src/core/ai/tool-loop-context.ts';
import { proposalInventoryContextPolicy } from '../src/core/ingestion-proposal-context-policy.ts';
import { importFromContent } from '../src/core/import-file.ts';
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

async function seedStoredPage(
  slug: string,
  sourceId = 'company',
  deleted = false,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
  await importFromContent(engine, slug, '# Existing page\n\nExisting body.', {
    noEmbed: true,
    sourceId,
  });
  if (deleted) {
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2`,
      [sourceId, slug],
    );
  }
}

function createPage(slug: string, bodyMarkdown = '# Page'): ScopedProposalPage {
  return { slug, effect: 'create', title: 'Page', bodyMarkdown };
}

function updatePage(slug: string, suffix = ''): ScopedProposalPage {
  return {
    slug,
    effect: 'update',
    appendMarkdown: `## Updated${suffix}`,
  };
}

function pageInventory(...pages: ScopedProposalPage[]): ProposalPageInventoryEntry[] {
  return pages.map(({ slug, effect }) => ({ slug, effect }));
}

async function stage(
  jobId: number,
  sequence: number,
  totalPages: number,
  page: ScopedProposalPage,
  admissionScope = 'Include project delivery notes.',
  inventory: ProposalPageInventoryEntry[] = pageInventory(page),
) {
  return stageAgentJobProposalPage(engine, jobId, {
    artifact_id: 'artifact-1',
    source_id: 'company',
    admission_scope: admissionScope,
    sequence,
    total_pages: totalPages,
    page_inventory: inventory,
    page,
  });
}

describe('proposal turn pre-persistence boundary', () => {
  it('uses immutable job identity when a compacted stage call omits it', async () => {
    const jobId = await seedJob();
    const page = createPage('sources/example');
    const input = {
      sequence: 1,
      total_pages: 1,
      page_inventory: pageInventory(page),
      page,
    };

    await expect(assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input,
    }], {
      artifactId: 'artifact-1',
      sourceId: 'company',
      admissionScope: 'Include project delivery notes.',
    })).resolves.toBeUndefined();

    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_job_proposal_fragments
        WHERE job_id = $1`,
      [jobId],
    );
    expect(rows[0]?.count).toBe('0');
  });

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
  it('rejects proposal page counts above the shared 32-page contract', async () => {
    const jobId = await seedJob();
    await expect(stage(jobId, 1, 33, createPage('sources/too-many')))
      .rejects.toMatchObject({ code: 'invalid_total_pages' });
    expect(PROPOSAL_MAX_PAGES).toBe(32);
  });

  it('uses the same lowercase ASCII-and-CJK slug contract as Lore', async () => {
    const jobId = await seedJob();
    await expect(stage(jobId, 1, 1, createPage('sources/éclair')))
      .rejects.toMatchObject({ code: 'invalid_slug' });
    await expect(stage(jobId, 1, 1, createPage('sources/αθήνα')))
      .rejects.toMatchObject({ code: 'invalid_slug' });
    const cjkJobId = await seedJob({ proposal_capture_page_slug: 'sources/東京' });
    await expect(stage(cjkJobId, 1, 1, createPage('sources/東京')))
      .resolves.toMatchObject({ slug: 'sources/東京' });
  });

  it('rejects blank create bodies and update appends', async () => {
    const createJob = await seedJob();
    await expect(stage(createJob, 1, 1, createPage('sources/example', ' \n\t ')))
      .rejects.toMatchObject({ code: 'invalid_string' });

    const updateJob = await seedJob();
    await expect(stage(updateJob, 1, 1, {
      slug: 'sources/example',
      effect: 'update',
      appendMarkdown: '   ',
    })).rejects.toMatchObject({ code: 'invalid_string' });
  });

  it('stages exact pages, finalizes an ordered manifest, and retrieves the full owned plan', async () => {
    await seedStoredPage('projects/example');
    const jobId = await seedJob();
    const pages = [createPage('sources/example'), updatePage('projects/example')];
    const inventory = pageInventory(...pages);
    const first = await stage(jobId, 1, 2, pages[0]!, undefined, inventory);
    const second = await stage(jobId, 2, 2, pages[1]!, undefined, inventory);

    expect(first.nextExpectedSlot).toEqual({ sequence: 2, ...inventory[1]! });
    expect(second.nextExpectedSlot).toBeNull();

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

    expect(manifest.pageDigests).toEqual([
      { sequence: first.sequence, slug: first.slug, digest: first.digest },
      { sequence: second.sequence, slug: second.slug, digest: second.digest },
    ]);
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

  it('finalizes durably while the newest retained stage call carries the full inventory', async () => {
    const jobId = await seedJob();
    const pages = [
      createPage('sources/example'),
      createPage('projects/example-2'),
      createPage('projects/example-3'),
      createPage('projects/example-4'),
    ];
    const inventory = pageInventory(...pages);
    const largeBodyMarker = `LARGE_STAGED_PAGE_${'x'.repeat(22_000)}`;
    const staged = [
      await stage(jobId, 1, 4, pages[0]!, undefined, inventory),
      await stage(jobId, 2, 4, pages[1]!, undefined, inventory),
      await stage(jobId, 3, 4, pages[2]!, undefined, inventory),
      await stage(jobId, 4, 4, pages[3]!, undefined, inventory),
    ];
    const messages: ChatMessage[] = [{ role: 'user', content: 'Build the exact ingestion proposal.' }];
    for (const page of staged) {
      const proposedPage = pages[page.sequence - 1]!;
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `stage-${page.sequence}`,
          toolName: 'brain_stage_ingestion_proposal_page',
          input: {
            artifact_id: 'artifact-1',
            source_id: 'company',
            admission_scope: 'Include project delivery notes.',
            sequence: page.sequence,
            total_pages: inventory.length,
            page_inventory: inventory,
            page: { ...proposedPage, bodyMarkdown: largeBodyMarker },
          },
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
    const compacted = compactToolLoopMessages(messages, 5_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
    });
    const compactedJson = JSON.stringify(compacted);
    expect(compactedJson).toContain(staged[3]!.digest);
    expect(compactedJson).toContain('sources/example');
    expect(compactedJson).toContain('working_context_projection');
    expect(compactedJson).not.toContain('LARGE_STAGED_PAGE_');
    const latestCall = compacted
      .flatMap(message => typeof message.content === 'string' ? [] : message.content)
      .findLast(block => block.type === 'tool-call');
    expect(latestCall?.type).toBe('tool-call');
    if (latestCall?.type !== 'tool-call') throw new Error('Missing retained stage call');
    expect((latestCall.input as Record<string, unknown>).page_inventory).toEqual(inventory);

    const manifest = await finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 4,
      summary: 'Ready after compaction.',
    });
    expect(manifest.pageDigests).toEqual(staged.map(({ sequence, slug, digest }) => ({
      sequence, slug, digest,
    })));
  });

  it('rejects duplicate inventory only at execution and leaves first-stage binding untouched', async () => {
    const jobId = await seedJob({ proposal_admission_scope: null });
    const page = createPage('sources/example');
    const input = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Derived resolver scope.',
      sequence: 1, total_pages: 2,
      page_inventory: [
        { slug: 'sources/example', effect: 'create' },
        { slug: 'sources/example', effect: 'update' },
      ],
      page,
    };

    await expect(assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input,
    }])).resolves.toBeUndefined();
    await expect(stageAgentJobProposalPage(engine, jobId, input))
      .rejects.toMatchObject({
        code: 'duplicate_page_inventory',
        message: expect.stringMatching(/sources\/example.*positions 1 and 2.*consolidate.*retry/i),
      });

    const [row] = await engine.executeRaw<{ scope: string | null; inventory: unknown; fragment_count: string }>(
      `SELECT data->>'proposal_admission_scope' AS scope,
              data->'proposal_page_inventory' AS inventory,
              (SELECT count(*)::text FROM agent_job_proposal_fragments WHERE job_id = minion_jobs.id) AS fragment_count
         FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(row).toMatchObject({ scope: null, inventory: null, fragment_count: '0' });
  });

  it('validates the complete inventory before freezing it', async () => {
    const cases: Array<{ inventory: unknown; page: ScopedProposalPage; code: string }> = [
      {
        inventory: [
          { slug: 'sources/example', effect: 'create' },
          { slug: 'projects/extra', effect: 'create' },
        ],
        page: createPage('sources/example'),
        code: 'invalid_page_inventory',
      },
      {
        inventory: [{ slug: 'projects/example', effect: 'create' }],
        page: createPage('projects/example'),
        code: 'missing_capture_inventory',
      },
      {
        inventory: [
          { slug: 'sources/example', effect: 'create' },
          { slug: 'private/example', effect: 'create' },
        ],
        page: createPage('private/example'),
        code: 'slug_not_allowed',
      },
      {
        inventory: [{ slug: 'sources/example', effect: 'update' }],
        page: createPage('sources/example'),
        code: 'inventory_slot_mismatch',
      },
    ];

    for (const testCase of cases) {
      const jobId = await seedJob({ proposal_admission_scope: null });
      await expect(stageAgentJobProposalPage(engine, jobId, {
        artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Derived scope.',
        sequence: testCase.code === 'slug_not_allowed' ? 2 : 1,
        total_pages: testCase.code === 'invalid_page_inventory'
          ? 1
          : Array.isArray(testCase.inventory) ? testCase.inventory.length : 1,
        page_inventory: testCase.inventory,
        page: testCase.page,
      })).rejects.toMatchObject({ code: testCase.code });
      const [row] = await engine.executeRaw<{ scope: string | null; inventory: unknown }>(
        `SELECT data->>'proposal_admission_scope' AS scope,
                data->'proposal_page_inventory' AS inventory
           FROM minion_jobs WHERE id = $1`,
        [jobId],
      );
      expect(row).toEqual({ scope: null, inventory: null });
    }
  });

  it('reports every first-stage effect mismatch without freezing the correctable plan', async () => {
    await seedStoredPage('sources/example');
    await seedStoredPage('projects/other-source', 'other');
    await seedStoredPage('projects/deleted', 'company', true);
    const jobId = await seedJob({ proposal_admission_scope: null });
    const mismatchedInventory: ProposalPageInventoryEntry[] = [
      { slug: 'sources/example', effect: 'create' },
      { slug: 'projects/missing', effect: 'update' },
      { slug: 'projects/other-source', effect: 'create' },
      { slug: 'projects/deleted', effect: 'create' },
    ];

    const mismatch = await stage(
      jobId,
      1,
      mismatchedInventory.length,
      createPage('sources/example'),
      'Correctable scope.',
      mismatchedInventory,
    ).then(() => null, error => error as Error & { code: string });
    expect(mismatch).toMatchObject({
      code: 'inventory_effect_mismatch',
      message: expect.stringMatching(
        /sources\/example.*exists.*marked create.*use update.*exact baseline.*projects\/missing.*does not exist.*marked update.*use create.*projects\/deleted.*soft-deleted.*restore.*repair/is,
      ),
    });
    const mismatchText = String(mismatch);
    expect(mismatchText).not.toContain('projects/other-source');

    const [untouched] = await engine.executeRaw<{
      scope: string | null;
      inventory: unknown;
      fragment_count: string;
    }>(
      `SELECT data->>'proposal_admission_scope' AS scope,
              data->'proposal_page_inventory' AS inventory,
              (SELECT count(*)::text FROM agent_job_proposal_fragments WHERE job_id = minion_jobs.id) AS fragment_count
         FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(untouched).toEqual({ scope: null, inventory: null, fragment_count: '0' });

    await expect(stage(
      jobId,
      1,
      1,
      updatePage('sources/example'),
      'Correctable scope.',
      [{ slug: 'sources/example', effect: 'update' }],
    )).resolves.toMatchObject({ nextExpectedSlot: null });
  });

  it('rejects a soft-deleted capture before freezing proposal state', async () => {
    await seedStoredPage('sources/example', 'company', true);
    const jobId = await seedJob({ proposal_admission_scope: null });

    await expect(stage(
      jobId,
      1,
      1,
      createPage('sources/example'),
      'Correctable scope.',
    )).rejects.toMatchObject({
      code: 'inventory_effect_mismatch',
      message: expect.stringMatching(/sources\/example.*soft-deleted.*restore.*repair.*do not mark it create/is),
    });

    const [untouched] = await engine.executeRaw<{
      scope: string | null;
      inventory: unknown;
      fragment_count: string;
    }>(
      `SELECT data->>'proposal_admission_scope' AS scope,
              data->'proposal_page_inventory' AS inventory,
              (SELECT count(*)::text FROM agent_job_proposal_fragments WHERE job_id = minion_jobs.id) AS fragment_count
         FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(untouched).toEqual({ scope: null, inventory: null, fragment_count: '0' });
  });

  it('freezes one exact inventory and rejects changed later calls before inserting a fragment', async () => {
    const jobId = await seedJob();
    const pages = [createPage('sources/example'), createPage('projects/example')];
    const inventory = pageInventory(...pages);
    await stage(jobId, 1, 2, pages[0]!, undefined, inventory);

    const [frozen] = await engine.executeRaw<{ inventory: unknown }>(
      `SELECT data->'proposal_page_inventory' AS inventory FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(frozen!.inventory).toEqual(inventory);
    await expect(stage(jobId, 2, 2, pages[1]!, undefined, [
      inventory[0]!, { slug: 'projects/changed', effect: 'create' },
    ])).rejects.toMatchObject({ code: 'inventory_mismatch' });
    const [{ count }] = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_job_proposal_fragments WHERE job_id = $1`,
      [jobId],
    );
    expect(count).toBe('1');
  });

  it('revalidates the frozen inventory against every fragment at finalization', async () => {
    const jobId = await seedJob();
    const page = createPage('sources/example');
    await stage(jobId, 1, 1, page);
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET data = jsonb_set(data, '{proposal_page_inventory}', $2::text::jsonb, true)
        WHERE id = $1`,
      [jobId, JSON.stringify([{ slug: 'sources/example', effect: 'update' }])],
    );

    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      total_pages: 1, summary: 'Tampered inventory.',
    })).rejects.toMatchObject({ code: 'inventory_slot_mismatch' });
  });

  it('freezes a previously-null admission scope on the first stage only', async () => {
    const jobId = await seedJob({ proposal_admission_scope: null });
    const pages = [createPage('sources/example'), createPage('projects/example')];
    const inventory = pageInventory(...pages);
    const page = pages[0]!;
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
    const first = await stage(jobId, 1, 2, page, 'Derived resolver scope.', inventory);
    expect(await stage(jobId, 1, 2, page, 'Derived resolver scope.', inventory)).toEqual(first);
    const [row] = await engine.executeRaw<{ scope: string | null }>(
      `SELECT data->>'proposal_admission_scope' AS scope FROM minion_jobs WHERE id = $1`,
      [jobId],
    );
    expect(row!.scope).toBe('Derived resolver scope.');
    await expect(stage(jobId, 2, 2, pages[1]!, 'Different scope.', inventory))
      .rejects.toMatchObject({ code: 'binding_mismatch' });
  });

  it('shares Lore\'s exact 4,000-character admission-scope ceiling', async () => {
    const maximumScope = 's'.repeat(4_000);
    const acceptedJobId = await seedJob({ proposal_admission_scope: null });
    await stage(acceptedJobId, 1, 1, createPage('sources/example'), maximumScope);
    const manifest = await finalizeAgentJobProposal(engine, acceptedJobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: maximumScope,
      total_pages: 1, summary: 'Boundary scope.',
    });
    expect(manifest.admissionScope).toBe(maximumScope);

    const oversizedScope = `${maximumScope}s`;
    const rejectedJobId = await seedJob({ proposal_admission_scope: null });
    await expect(stage(rejectedJobId, 1, 1, createPage('sources/example'), oversizedScope))
      .rejects.toMatchObject({ code: 'invalid_string' });
    await expect(finalizeAgentJobProposal(engine, acceptedJobId, {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: oversizedScope,
      total_pages: 1, summary: 'Oversized scope.',
    })).rejects.toMatchObject({ code: 'invalid_string' });
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
    const unauthorizedPages = [createPage('sources/example'), createPage('private/example')];
    await expect(stage(
      unauthorizedJob,
      2,
      2,
      unauthorizedPages[1]!,
      undefined,
      pageInventory(...unauthorizedPages),
    ))
      .rejects.toMatchObject({ code: 'slug_not_allowed' });

    const jobId = await seedJob();
    const pages = [createPage('sources/example'), createPage('projects/example')];
    const inventory = pageInventory(...pages);
    await stage(jobId, 1, 2, pages[0]!, undefined, inventory);
    await stage(jobId, 2, 2, pages[1]!, undefined, inventory);
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
    await expect(stage(missingCaptureJob, 1, 1, createPage('projects/example')))
      .rejects.toMatchObject({ code: 'missing_capture_inventory' });
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
    const gapPage = createPage('sources/gap');
    await stage(gapJob, 1, 2, gapPage, undefined, [
      { slug: gapPage.slug, effect: gapPage.effect },
      { slug: 'sources/example', effect: 'create' },
    ]);
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

    const duplicatePageJob = await seedJob({ proposal_capture_page_slug: 'sources/same' });
    await seedStoredPage('projects/other');
    const uniquePages = [createPage('sources/same'), updatePage('projects/other')];
    const uniqueInventory = pageInventory(...uniquePages);
    await stage(duplicatePageJob, 1, 2, uniquePages[0]!, undefined, uniqueInventory);
    await stage(duplicatePageJob, 2, 2, uniquePages[1]!, undefined, uniqueInventory);
    const duplicatePage = updatePage('sources/same');
    const privateBaseline = await engine.getPage('projects/other', { sourceId: 'company' });
    const duplicateDigest = digestProposalValue({
      page: duplicatePage,
      baselineTitle: privateBaseline!.title,
      baselineMarkdown: privateBaseline!.compiled_truth,
      baselineContentHash: privateBaseline!.content_hash,
    });
    await engine.executeRaw(
      `UPDATE agent_job_proposal_fragments
          SET page = $2::text::jsonb, page_digest = $3
        WHERE job_id = $1 AND sequence = 2`,
      [duplicatePageJob, canonicalProposalJson(duplicatePage), duplicateDigest],
    );
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
      sequence: 1, total_pages: 1,
      page_inventory: [{ slug: 'sources/example', effect: 'create' }],
      page: createPage('sources/example'),
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
      .rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
    await expect(getOwnedAgentJobProposal(engine, jobId, 'lore-client', 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'proposal_authority_unavailable' });
  });

  it('rejects cumulative staged pages over the aggregate ceiling without persisting the crossing fragment', async () => {
    const jobId = await seedJob({ proposal_capture_page_slug: 'sources/large-1' });
    const pageCount = 2;
    const pages = Array.from({ length: pageCount }, (_, index) => (
      createPage(`sources/large-${index + 1}`, 'x'.repeat(80_000))
    ));
    const inventory = pageInventory(...pages);
    for (let sequence = 1; sequence < pageCount; sequence++) {
      await stage(jobId, sequence, pageCount, pages[sequence - 1]!, undefined, inventory);
    }
    const crossingInput = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: pageCount, total_pages: pageCount,
      page_inventory: inventory,
      page: pages[pageCount - 1]!,
    };
    await expect(assertProposalToolTurnPersistableForJob(engine, jobId, [{
      type: 'tool-call', toolName: 'brain_stage_ingestion_proposal_page', input: crossingInput,
    }])).rejects.toMatchObject({ code: 'proposal_too_large' });
    const replayInput = {
      artifact_id: 'artifact-1', source_id: 'company', admission_scope: 'Include project delivery notes.',
      sequence: pageCount - 1, total_pages: pageCount,
      page_inventory: inventory,
      page: pages[pageCount - 2]!,
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
    expect(PROPOSAL_AGGREGATE_MAX_BYTES).toBe(96 * 1024);
    expect(PROPOSAL_ESCAPED_PLAN_MAX_BYTES).toBe(96 * 1024);
    expect(PROPOSAL_MANIFEST_MAX_BYTES).toBe(256 * 1024);
  });

  it('accepts an escaped canonical plan exactly at the shared ceiling', async () => {
    const jobId = await seedJob();
    const pageCount = 1;
    const pages = Array.from({ length: pageCount }, (_, index) =>
      createPage(index === 0 ? 'sources/example' : `sources/boundary-${index + 1}`, 'x'));
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
    const remaining = PROPOSAL_ESCAPED_PLAN_MAX_BYTES -
      Buffer.byteLength(JSON.stringify(canonicalProposalJson(basePlan)), 'utf8');
    const boundaryPage = pages[pageCount - 1]!;
    if (boundaryPage.effect !== 'create') throw new Error('Expected create boundary page');
    boundaryPage.bodyMarkdown += 'y'.repeat(remaining);
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
    expect(Buffer.byteLength(JSON.stringify(canonicalProposalJson(owned.plan)), 'utf8'))
      .toBe(PROPOSAL_ESCAPED_PLAN_MAX_BYTES);
    expect(Buffer.byteLength(canonicalProposalJson(owned.plan), 'utf8'))
      .toBeLessThan(PROPOSAL_AGGREGATE_MAX_BYTES);
  });

  it('rejects a raw plan whose JSON-string escaped representation exceeds 96 KiB', async () => {
    const jobId = await seedJob();
    await stage(jobId, 1, 1, createPage('sources/example', `x${'\n'.repeat(40_000)}`));

    await expect(finalizeAgentJobProposal(engine, jobId, {
      artifact_id: 'artifact-1', source_id: 'company',
      admission_scope: 'Include project delivery notes.',
      total_pages: 1, summary: 'Escaped boundary.',
    })).rejects.toMatchObject({ code: 'proposal_too_large' });
  });
});
