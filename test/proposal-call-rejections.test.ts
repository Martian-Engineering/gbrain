import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PROPOSAL_REJECTION_V1_ERROR_CODES,
  recordRejectedProposalToolTurn,
  readProposalCallRejections,
} from '../src/core/minions/agent-job-proposal-rejections.ts';
import { AgentJobProposalError } from '../src/core/minions/agent-job-proposals.ts';

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

async function seedJob(status = 'active', attemptsStarted = 1, attemptsMade = 0): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs
       (name, status, data, queue, priority, attempts_started, attempts_made, created_at)
     VALUES ('subagent', $1, '{}'::text::jsonb, 'default', 0, $2, $3, now())
     RETURNING id`,
    [status, attemptsStarted, attemptsMade],
  );
  return Number(rows[0]!.id);
}

function rejectionInput(feedbackMessageIndex: number) {
  const secret = 'private proposal body and source identifier';
  return {
    jobId: 0,
    turnIndex: 0,
    feedbackMessageIndex,
    blocks: [{
      type: 'tool-call' as const,
      toolName: 'brain_stage_ingestion_proposal_page',
      input: {
        artifact_id: 'artifact-private',
        source_id: 'source-private',
        admission_scope: 'private scope',
        sequence: 1,
        total_pages: 1,
        page: { bodyMarkdown: secret },
        page_inventory: [],
        unknown_secret_key: secret,
      },
    }],
    error: new AgentJobProposalError('stage_input_too_large', 'provider text must not persist'),
  };
}

describe('proposal call rejection ledger', () => {
  it('records bounded allow-listed paths and a server-generated correction envelope', async () => {
    const jobId = await seedJob();
    const input = rejectionInput(1);
    await recordRejectedProposalToolTurn(engine, { ...input, jobId });

    const projection = await readProposalCallRejections(engine, jobId, 'active');
    expect(projection).toEqual({
      schema_version: 1,
      events: [{
        sequence: 1,
        attempt_generation: 0,
        attempt_no: 1,
        turn_index: 0,
        feedback_message_index: 1,
        error_code: 'stage_input_too_large',
        calls: [{
          call_ordinal: 0,
          tool_name: 'brain_stage_ingestion_proposal_page',
          proposal_page_sequence: 1,
          fields: [
            { path: 'artifact_id', kind: 'string' },
            { path: 'source_id', kind: 'string' },
            { path: 'admission_scope', kind: 'string' },
            { path: 'sequence', kind: 'number' },
            { path: 'total_pages', kind: 'number' },
            { path: 'page_inventory', kind: 'array' },
            { path: 'page', kind: 'object' },
            { path: 'page.bodyMarkdown', kind: 'string' },
          ],
          fields_truncated: false,
          unknown_key_count: 1,
          unknown_key_count_truncated: false,
        }],
        omitted_call_count: 0,
        omitted_call_count_truncated: false,
      }],
      omitted_event_count: 0,
      omitted_event_count_truncated: false,
      terminal_event: null,
    });

    const rows = await engine.executeRaw<{ content_blocks: unknown }>(
      'SELECT content_blocks FROM subagent_messages WHERE job_id = $1',
      [jobId],
    );
    const serialized = JSON.stringify({ projection, rows });
    expect(serialized).not.toContain('private proposal body');
    expect(serialized).not.toContain('artifact-private');
    expect(serialized).not.toContain('source-private');
    expect(serialized).not.toContain('unknown_secret_key');
    expect(serialized).not.toContain('provider text must not persist');
    expect(serialized).toContain('page.bodyMarkdown');
    expect(serialized).toContain('stage_input_too_large');
  });

  it('makes the event and correction message an idempotent matched pair', async () => {
    const jobId = await seedJob();
    const input = rejectionInput(1);
    await recordRejectedProposalToolTurn(engine, { ...input, jobId });
    await recordRejectedProposalToolTurn(engine, { ...input, jobId });

    const events = await engine.executeRaw(
      'SELECT sequence FROM agent_job_proposal_call_rejections WHERE job_id = $1',
      [jobId],
    );
    const messages = await engine.executeRaw(
      'SELECT message_idx FROM subagent_messages WHERE job_id = $1',
      [jobId],
    );
    expect(events).toHaveLength(1);
    expect(messages).toEqual([{ message_idx: 1 }]);
  });

  it('maps unknown regex-valid errors to the finite public fallback code', async () => {
    const jobId = await seedJob();
    const input = rejectionInput(1);
    await recordRejectedProposalToolTurn(engine, {
      ...input,
      jobId,
      error: new AgentJobProposalError('future_guard_code', 'private'),
    });

    const event = (await readProposalCallRejections(engine, jobId, 'active')).events[0]!;
    expect(event.error_code).toBe('proposal_guard_rejected');
    expect(PROPOSAL_REJECTION_V1_ERROR_CODES).toEqual([
      'baseline_unavailable',
      'binding_mismatch',
      'conflicting_fragment',
      'digest_mismatch',
      'job_not_bound',
      'mixed_proposal_calls',
      'multiple_stage_calls',
      'proposal_guard_rejected',
      'proposal_too_large',
      'slug_not_allowed',
      'stage_input_too_large',
    ]);
  });

  it('keeps retry-reset attempts distinct and binds terminal evidence to the current generation', async () => {
    const jobId = await seedJob('dead', 1, 1);
    const first = rejectionInput(1);
    await recordRejectedProposalToolTurn(engine, { ...first, jobId });

    const queue = new MinionQueue(engine);
    await queue.retryJob(jobId);
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET status = 'failed', attempts_started = 1, attempts_made = 1
        WHERE id = $1`,
      [jobId],
    );
    expect((await readProposalCallRejections(engine, jobId, 'failed')).terminal_event).toBeNull();

    const second = rejectionInput(2);
    await recordRejectedProposalToolTurn(engine, { ...second, jobId });
    const projection = await readProposalCallRejections(engine, jobId, 'failed');
    expect(projection.events.map(event => [event.sequence, event.attempt_generation, event.attempt_no]))
      .toEqual([[1, 0, 1], [2, 1, 1]]);
    expect(projection.terminal_event).toMatchObject({ sequence: 2, attempt_generation: 1 });
  });

  it('never marks completed or cancelled jobs as rejection-terminal', async () => {
    const jobId = await seedJob('failed', 1, 1);
    await recordRejectedProposalToolTurn(engine, { ...rejectionInput(1), jobId });

    expect((await readProposalCallRejections(engine, jobId, 'completed')).terminal_event).toBeNull();
    expect((await readProposalCallRejections(engine, jobId, 'cancelled')).terminal_event).toBeNull();
    expect((await readProposalCallRejections(engine, jobId, 'failed')).terminal_event)
      .toMatchObject({ sequence: 1 });
    expect((await readProposalCallRejections(engine, jobId, 'dead')).terminal_event)
      .toMatchObject({ sequence: 1 });
  });

  it('caps calls, fields, and unknown-key metadata without keeping unknown names', async () => {
    const jobId = await seedJob();
    const blocks = Array.from({ length: 12 }, (_, index) => ({
      type: 'tool-call' as const,
      toolName: 'brain_stage_ingestion_proposal_page',
      input: {
        artifact_id: index,
        source_id: index,
        admission_scope: index,
        sequence: index,
        total_pages: index,
        page_inventory: index,
        page: {
          slug: index,
          effect: index,
          title: index,
          bodyMarkdown: index,
          appendMarkdown: index,
        },
        ...Object.fromEntries(Array.from({ length: 70 }, (_, key) => [`secret_${key}`, key])),
      },
    }));
    await recordRejectedProposalToolTurn(engine, {
      jobId,
      turnIndex: 0,
      feedbackMessageIndex: 1,
      blocks,
      error: new AgentJobProposalError('multiple_stage_calls', 'private'),
    });

    const event = (await readProposalCallRejections(engine, jobId, 'active')).events[0]!;
    expect(event.calls).toHaveLength(8);
    expect(event.omitted_call_count).toBe(4);
    expect(event.calls[0]!.fields).toHaveLength(12);
    expect(event.calls[0]!.unknown_key_count).toBe(64);
    expect(event.calls[0]!.unknown_key_count_truncated).toBe(true);
    expect(JSON.stringify(event)).not.toContain('secret_0');
  });

  it('enforces the JSONB-array and bounded-call schema contract', async () => {
    const jobId = await seedJob();
    const insert = (sequence: number, calls: unknown) => engine.executeRaw(
      `INSERT INTO agent_job_proposal_call_rejections
         (job_id, sequence, attempt_generation, attempt_no, turn_index,
          feedback_message_index, error_code, calls)
       VALUES ($1, $2, 0, 1, 0, $2, 'stage_input_too_large', $3::text::jsonb)`,
      [jobId, sequence, JSON.stringify(calls)],
    );

    await expect(insert(1, { unsafe: true })).rejects.toThrow();
    await expect(insert(2, Array.from({ length: 9 }, () => ({})))).rejects.toThrow();
    await expect(insert(3, [{ nested: 'x'.repeat(16_385) }])).rejects.toThrow();
  });

  it('bounds malformed stored field arrays before mapping and marks truncation', async () => {
    const jobId = await seedJob();
    await engine.executeRaw(
      `INSERT INTO agent_job_proposal_call_rejections
         (job_id, sequence, attempt_generation, attempt_no, turn_index,
          feedback_message_index, error_code, calls)
       VALUES ($1, 1, 0, 1, 0, 1, 'stage_input_too_large', $2::text::jsonb)`,
      [jobId, JSON.stringify([{
        call_ordinal: 0,
        tool_name: 'brain_stage_ingestion_proposal_page',
        fields: Array.from({ length: 20 }, () => ({ path: 'page', kind: 'object' })),
        unknown_key_count: 0,
      }])],
    );

    const call = (await readProposalCallRejections(engine, jobId, 'active')).events[0]!.calls[0]!;
    expect(call.fields).toEqual([{ path: 'page', kind: 'object' }]);
    expect(call.fields_truncated).toBe(true);
  });

  it('returns only the newest bounded event window with explicit omission metadata', async () => {
    const jobId = await seedJob();
    for (let index = 0; index < 26; index++) {
      await recordRejectedProposalToolTurn(engine, {
        jobId,
        turnIndex: index,
        feedbackMessageIndex: index + 1,
        blocks: [{
          type: 'tool-call',
          toolName: 'brain_finalize_ingestion_proposal',
          input: { summary: index },
        }],
        error: new AgentJobProposalError('mixed_proposal_calls', 'private'),
      });
    }

    const projection = await readProposalCallRejections(engine, jobId, 'active');
    expect(projection.events).toHaveLength(25);
    expect(projection.events[0]!.sequence).toBe(2);
    expect(projection.events.at(-1)!.sequence).toBe(26);
    expect(projection.omitted_event_count).toBe(1);
    expect(projection.omitted_event_count_truncated).toBe(false);
  });

  it('executes the runtime embedded schema with normal stable error codes', async () => {
    const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS agent_job_proposal_call_rejections');
    const end = SCHEMA_SQL.indexOf('\n);', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    await engine.executeRaw('DROP TABLE agent_job_proposal_call_rejections');
    await engine.executeRaw(SCHEMA_SQL.slice(start, end + 3));

    const jobId = await seedJob();
    await expect(engine.executeRaw(
      `INSERT INTO agent_job_proposal_call_rejections
         (job_id, sequence, attempt_generation, attempt_no, turn_index,
          feedback_message_index, error_code, calls)
       VALUES ($1, 1, 0, 1, 0, 1, 'stage_input_too_large', '[]'::text::jsonb)`,
      [jobId],
    )).resolves.toEqual([]);
  });
});
