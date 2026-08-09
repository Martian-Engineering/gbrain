import type { BrainEngine } from '../engine.ts';
import { AgentJobProposalError } from '../ingestion-proposal-contract.ts';
import {
  FINALIZE_PROPOSAL_TOOL_NAME,
  PROPOSAL_MAX_PAGES,
  STAGE_PROPOSAL_TOOL_NAME,
} from './agent-job-proposals.ts';

type ProposalTurnBlock = {
  type?: unknown;
  name?: unknown;
  toolName?: unknown;
  input?: unknown;
};

type ValueKind = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'unknown';

interface FieldKind {
  path: string;
  kind: ValueKind;
}

interface RejectionCall {
  call_ordinal: number;
  tool_name: string;
  proposal_page_sequence: number | null;
  fields: FieldKind[];
  fields_truncated: boolean;
  unknown_key_count: number;
  unknown_key_count_truncated: boolean;
}

interface RejectionEvent {
  sequence: number;
  attempt_generation: number;
  attempt_no: number;
  turn_index: number;
  feedback_message_index: number;
  error_code: ProposalRejectionV1ErrorCode;
  calls: RejectionCall[];
  omitted_call_count: number;
  omitted_call_count_truncated: boolean;
}

interface RejectionEnvelope {
  calls: RejectionCall[];
  omitted_call_count: number;
  omitted_call_count_truncated: boolean;
}

interface StoredRejectionEvent extends Omit<RejectionEvent, 'calls'> {
  calls: unknown;
}

/** Stable, privacy-bounded projection for rejected proposal calls. */
export interface ProposalCallRejections {
  schema_version: 1;
  events: RejectionEvent[];
  omitted_event_count: number;
  omitted_event_count_truncated: boolean;
  terminal_event: RejectionEvent | null;
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_EVENTS = 25;
const MAX_CALLS = 8;
const MAX_FIELDS = 16;
const MAX_UNKNOWN_KEYS = 64;
const MAX_OMITTED_COUNT = 999;

/**
 * Public v1 error codes safe to expose for rejected, pre-persistence proposal
 * turns. Keep this finite: unrecognized internal failures use the generic
 * guard code instead of expanding the Lore-facing contract implicitly.
 */
export const PROPOSAL_REJECTION_V1_ERROR_CODES = [
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
] as const;

/** One finite, Lore-facing v1 error code for rejected proposal calls. */
export type ProposalRejectionV1ErrorCode = typeof PROPOSAL_REJECTION_V1_ERROR_CODES[number];

const PROPOSAL_REJECTION_V1_ERROR_CODE_SET = new Set<string>(
  PROPOSAL_REJECTION_V1_ERROR_CODES,
);

const TOOL_FIELD_PATHS: Readonly<Record<string, readonly string[]>> = {
  [STAGE_PROPOSAL_TOOL_NAME]: [
    'artifact_id', 'source_id', 'admission_scope', 'sequence', 'total_pages',
    'page_inventory', 'page', 'page.slug', 'page.effect', 'page.title',
    'page.bodyMarkdown', 'page.appendMarkdown',
  ],
  [FINALIZE_PROPOSAL_TOOL_NAME]: [
    'artifact_id', 'source_id', 'admission_scope', 'total_pages', 'summary',
    'proposed_timeline_entries', 'proposed_links', 'unresolved',
  ],
};

/** Record a rejected proposal turn without retaining proposal values or provider text. */
export async function recordRejectedProposalToolTurn(
  engine: BrainEngine,
  input: {
    jobId: number;
    turnIndex: number;
    feedbackMessageIndex: number;
    blocks: readonly ProposalTurnBlock[];
    error: AgentJobProposalError;
  },
): Promise<void> {
  assertSafeNonnegativeInteger(input.turnIndex, 'turn index');
  assertSafeNonnegativeInteger(input.feedbackMessageIndex, 'feedback message index');
  const envelope = summarizeProposalCalls(input.blocks);
  const errorCode = stableErrorCode(input.error.code);
  const guidance = retryGuidance(errorCode, envelope);

  await engine.transaction(async (tx) => {
    const jobs = await tx.executeRaw<{
      attempts_started: number;
      attempts_made: number;
      proposal_rejection_generation: number;
    }>(
      `SELECT attempts_started, attempts_made, proposal_rejection_generation
         FROM minion_jobs
        WHERE id = $1 AND name = 'subagent'
        FOR UPDATE`,
      [input.jobId],
    );
    const job = jobs[0];
    if (!job) throw new Error('proposal rejection requires an active subagent job');
    const attemptNo = Number(job.attempts_started) > 0
      ? Number(job.attempts_started)
      : Number(job.attempts_made) + 1;
    const attemptGeneration = Number(job.proposal_rejection_generation);
    assertPositiveSafeInteger(attemptNo, 'attempt number');
    assertSafeNonnegativeInteger(attemptGeneration, 'attempt generation');

    const existing = await tx.executeRaw<StoredRejectionEvent>(
      `SELECT sequence, attempt_generation, attempt_no, turn_index,
              feedback_message_index, error_code, calls, omitted_call_count,
              omitted_call_count_truncated
         FROM agent_job_proposal_call_rejections
        WHERE job_id = $1 AND feedback_message_index = $2
        FOR UPDATE`,
      [input.jobId, input.feedbackMessageIndex],
    );
    const messages = await tx.executeRaw<{ role: unknown; content_blocks: unknown }>(
      `SELECT role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1 AND message_idx = $2
        FOR UPDATE`,
      [input.jobId, input.feedbackMessageIndex],
    );
    if (existing.length > 0) {
      if (!sameEnvelope(existing[0]!, {
        attemptGeneration,
        attemptNo,
        turnIndex: input.turnIndex,
        feedbackMessageIndex: input.feedbackMessageIndex,
        errorCode,
        envelope,
      }) || messages.length !== 1 || !isRetryGuidance(messages[0]!.role, messages[0]!.content_blocks, guidance)) {
        throw new Error('proposal rejection idempotency conflict has unsafe durable evidence');
      }
      return;
    }
    if (messages.length > 0) {
      throw new Error('proposal rejection feedback message index is already durable');
    }

    const sequenceRows = await tx.executeRaw<{ next_sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM agent_job_proposal_call_rejections
        WHERE job_id = $1`,
      [input.jobId],
    );
    const sequence = Number(sequenceRows[0]?.next_sequence);
    assertPositiveSafeInteger(sequence, 'sequence');
    await tx.executeRaw(
      `INSERT INTO agent_job_proposal_call_rejections
         (job_id, sequence, attempt_generation, attempt_no, turn_index,
          feedback_message_index, error_code, calls, omitted_call_count,
          omitted_call_count_truncated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10)`,
      [
        input.jobId,
        sequence,
        attemptGeneration,
        attemptNo,
        input.turnIndex,
        input.feedbackMessageIndex,
        errorCode,
        JSON.stringify(envelope.calls),
        envelope.omitted_call_count,
        envelope.omitted_call_count_truncated,
      ],
    );
    await tx.executeRaw(
      `INSERT INTO subagent_messages
         (job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
          tokens_cache_read, tokens_cache_create, model)
       VALUES ($1, $2, 'user', $3::text::jsonb, NULL, NULL, NULL, NULL, NULL)`,
      [input.jobId, input.feedbackMessageIndex, JSON.stringify(retryGuidanceBlocks(guidance))],
    );
  });
}

/** Read the append-only rejection ledger as a safe, bounded API projection. */
export async function readProposalCallRejections(
  engine: BrainEngine,
  jobId: number,
  jobStatus: string,
): Promise<ProposalCallRejections> {
  const rows = await engine.executeRaw<StoredRejectionEvent & { total: unknown }>(
    `SELECT sequence, attempt_generation, attempt_no, turn_index,
            feedback_message_index, error_code, calls, omitted_call_count,
            omitted_call_count_truncated, count(*) OVER() AS total
       FROM agent_job_proposal_call_rejections
      WHERE job_id = $1
      ORDER BY sequence DESC
      LIMIT $2`,
    [jobId, MAX_EVENTS],
  );
  const events = rows.reverse().map(parseEvent);
  const total = safeCount(rows[0]?.total, MAX_SAFE_INTEGER);
  const omitted = cappedCount(Math.max(0, total - events.length));
  const empty: ProposalCallRejections = {
    schema_version: 1,
    events,
    omitted_event_count: omitted.count,
    omitted_event_count_truncated: omitted.truncated,
    terminal_event: null,
  };
  if (!['failed', 'dead'].includes(jobStatus) || events.length === 0) return empty;

  const jobs = await engine.executeRaw<{
    attempts_made: number;
    proposal_rejection_generation: number;
  }>(
    `SELECT attempts_made, proposal_rejection_generation
       FROM minion_jobs WHERE id = $1`,
    [jobId],
  );
  const newest = events.at(-1)!;
  const job = jobs[0];
  if (!job) return empty;
  return {
    ...empty,
    terminal_event: Number(job.attempts_made) === newest.attempt_no
      && Number(job.proposal_rejection_generation) === newest.attempt_generation
      ? newest
      : null,
  };
}

/** Summarize static, allow-listed diagnostics and discard every proposal value. */
function summarizeProposalCalls(blocks: readonly ProposalTurnBlock[]): RejectionEnvelope {
  const calls: RejectionCall[] = [];
  let proposalCalls = 0;
  let toolOrdinal = 0;
  for (const block of blocks) {
    if (!isToolCall(block)) continue;
    const callOrdinal = toolOrdinal++;
    const name = blockName(block);
    const paths = TOOL_FIELD_PATHS[name];
    if (!paths) continue;
    proposalCalls++;
    if (calls.length >= MAX_CALLS) continue;
    const input = asRecord(block.input);
    const fields = paths.flatMap((path) => {
      const value = valueAtPath(input, path);
      return value.present ? [{ path, kind: valueKind(value.value) }] : [];
    });
    const boundedFields = fields.slice(0, MAX_FIELDS);
    const unknown = cappedCount(Object.keys(input).filter(key => !isKnownTopLevelPath(paths, key)).length, MAX_UNKNOWN_KEYS);
    calls.push({
      call_ordinal: callOrdinal,
      tool_name: name,
      proposal_page_sequence: proposalPageSequence(name, input),
      fields: boundedFields,
      fields_truncated: fields.length > boundedFields.length,
      unknown_key_count: unknown.count,
      unknown_key_count_truncated: unknown.truncated,
    });
  }
  const omitted = cappedCount(Math.max(0, proposalCalls - calls.length));
  return {
    calls,
    omitted_call_count: omitted.count,
    omitted_call_count_truncated: omitted.truncated,
  };
}

/** Convert a stored row defensively so malformed historical data cannot leak. */
function parseEvent(row: StoredRejectionEvent): RejectionEvent {
  const omitted = cappedCount(row.omitted_call_count);
  return {
    sequence: positiveOr(row.sequence, 1),
    attempt_generation: safeCount(row.attempt_generation, MAX_SAFE_INTEGER),
    attempt_no: positiveOr(row.attempt_no, 1),
    turn_index: safeCount(row.turn_index, MAX_SAFE_INTEGER),
    feedback_message_index: safeCount(row.feedback_message_index, MAX_SAFE_INTEGER),
    error_code: stableErrorCode(row.error_code),
    calls: parseCalls(row.calls),
    omitted_call_count: omitted.count,
    omitted_call_count_truncated: Boolean(row.omitted_call_count_truncated) || omitted.truncated,
  };
}

function parseCalls(raw: unknown): RejectionCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CALLS).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const name = typeof record.tool_name === 'string' && TOOL_FIELD_PATHS[record.tool_name]
      ? record.tool_name
      : null;
    if (!name) return [];
    const allowedPaths = TOOL_FIELD_PATHS[name];
    const seen = new Set<string>();
    const sourceFields = Array.isArray(record.fields) ? record.fields : [];
    const fields = sourceFields.slice(0, MAX_FIELDS).flatMap((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return [];
      const safeField = field as Record<string, unknown>;
      const path = typeof safeField.path === 'string' && allowedPaths.includes(safeField.path)
        ? safeField.path
        : null;
      if (!path || seen.has(path) || !isValueKind(safeField.kind)) return [];
      seen.add(path);
      return [{ path, kind: safeField.kind }];
    });
    const unknown = cappedCount(record.unknown_key_count, MAX_UNKNOWN_KEYS);
    return [{
      call_ordinal: safeCount(record.call_ordinal, MAX_SAFE_INTEGER),
      tool_name: name,
      proposal_page_sequence: parseProposalPageSequence(name, record.proposal_page_sequence),
      fields,
      fields_truncated: Boolean(record.fields_truncated) || sourceFields.length > MAX_FIELDS,
      unknown_key_count: unknown.count,
      unknown_key_count_truncated: Boolean(record.unknown_key_count_truncated) || unknown.truncated,
    }];
  });
}

function sameEnvelope(
  existing: StoredRejectionEvent,
  expected: {
    attemptGeneration: number;
    attemptNo: number;
    turnIndex: number;
    feedbackMessageIndex: number;
    errorCode: string;
    envelope: RejectionEnvelope;
  },
): boolean {
  const parsed = parseEvent(existing);
  return parsed.attempt_generation === expected.attemptGeneration
    && parsed.attempt_no === expected.attemptNo
    && parsed.turn_index === expected.turnIndex
    && parsed.feedback_message_index === expected.feedbackMessageIndex
    && parsed.error_code === expected.errorCode
    && parsed.omitted_call_count === expected.envelope.omitted_call_count
    && parsed.omitted_call_count_truncated === expected.envelope.omitted_call_count_truncated
    && JSON.stringify(parsed.calls) === JSON.stringify(expected.envelope.calls);
}

function retryGuidance(errorCode: string, envelope: RejectionEnvelope): string {
  return `Your proposal tool call was rejected before persistence. Correct only the reported schema shape and retry: ${JSON.stringify({ schema_version: 1, error_code: errorCode, calls: envelope.calls, omitted_call_count: envelope.omitted_call_count, omitted_call_count_truncated: envelope.omitted_call_count_truncated })}`;
}

function retryGuidanceBlocks(guidance: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: guidance }];
}

function isRetryGuidance(role: unknown, blocks: unknown, guidance: string): boolean {
  if (role !== 'user' || !Array.isArray(blocks) || blocks.length !== 1) return false;
  const block = blocks[0];
  return Boolean(block && typeof block === 'object' && !Array.isArray(block)
    && (block as Record<string, unknown>).type === 'text'
    && (block as Record<string, unknown>).text === guidance);
}

function isToolCall(block: ProposalTurnBlock): boolean {
  return block.type === 'tool-call' || block.type === 'tool_use';
}

function blockName(block: ProposalTurnBlock): string {
  if (typeof block.toolName === 'string') return block.toolName;
  return typeof block.name === 'string' ? block.name : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function valueAtPath(input: Record<string, unknown>, path: string): { present: boolean; value: unknown } {
  const [top, nested] = path.split('.', 2);
  if (!top || !Object.hasOwn(input, top)) return { present: false, value: undefined };
  if (!nested) return { present: true, value: input[top] };
  const record = asRecord(input[top]);
  return Object.hasOwn(record, nested)
    ? { present: true, value: record[nested] }
    : { present: false, value: undefined };
}

function isKnownTopLevelPath(paths: readonly string[], key: string): boolean {
  return paths.some(path => path.split('.', 1)[0] === key);
}

/** Return the only proposal value that is safe and useful to expose: a bounded page ordinal. */
function proposalPageSequence(toolName: string, input: Record<string, unknown>): number | null {
  return parseProposalPageSequence(toolName, input.sequence);
}

function parseProposalPageSequence(toolName: string, value: unknown): number | null {
  if (toolName !== STAGE_PROPOSAL_TOOL_NAME || !Number.isSafeInteger(value)) return null;
  const sequence = Number(value);
  return sequence >= 1 && sequence <= PROPOSAL_MAX_PAGES ? sequence : null;
}

function valueKind(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'string': return 'string';
    case 'object': return 'object';
    default: return 'unknown';
  }
}

function isValueKind(value: unknown): value is ValueKind {
  return ['array', 'boolean', 'null', 'number', 'object', 'string', 'unknown'].includes(String(value));
}

function cappedCount(value: unknown, cap = MAX_OMITTED_COUNT): { count: number; truncated: boolean } {
  const number = safeCount(value, MAX_SAFE_INTEGER);
  return { count: Math.min(number, cap), truncated: number > cap };
}

function safeCount(value: unknown, cap: number): number {
  const number = safeInteger(value);
  return number !== null && number >= 0
    ? Math.min(number, cap)
    : 0;
}

function positiveOr(value: unknown, fallback: number): number {
  const number = safeInteger(value);
  return number !== null && number > 0
    ? number
    : fallback;
}

/** Parse a database safe integer without accepting exponent, sign, or float syntax. */
function safeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value <= MAX_SAFE_INTEGER ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= MAX_SAFE_INTEGER ? number : null;
}

function stableErrorCode(code: unknown): ProposalRejectionV1ErrorCode {
  return typeof code === 'string' && PROPOSAL_REJECTION_V1_ERROR_CODE_SET.has(code)
    ? code as ProposalRejectionV1ErrorCode
    : 'proposal_guard_rejected';
}

function assertSafeNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`proposal rejection ${name} must be a non-negative integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`proposal rejection ${name} must be a positive safe integer`);
  }
}
