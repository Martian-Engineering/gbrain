import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

const MAX_EVIDENCE_OPERATIONS = 500;
const TRACKED_TOOLS = [
  'brain_put_page',
  'brain_get_page',
  'brain_add_timeline_entry',
  'brain_add_link',
  'brain_remove_link',
] as const;

type ExecutionStatus = 'pending' | 'complete' | 'failed';

interface ToolExecutionRow {
  tool_name: string;
  input: unknown;
  status: ExecutionStatus;
  output: unknown;
}

type RecoveryAction =
  | 'finalize_verified_success'
  | 'continue_approved_work'
  | 'refresh_proposal'
  | 'close_without_remaining_writes';

/** Privacy-bounded durable evidence for one owner-scoped agent job. */
export interface AgentJobExecutionEvidence {
  schema_version: 1;
  availability: 'unavailable' | 'incomplete' | 'complete';
  truncated: boolean;
  unsupported_mutation_count: number;
  allowed_recovery_actions: RecoveryAction[];
  source_id: string | null;
  operations: Array<Record<string, unknown>>;
}

/**
 * Read the durable tool ledger without exposing prompts, page bodies, or raw
 * errors. Callers can compare these server-recorded facts with their own
 * frozen plan instead of trusting a model-authored final receipt.
 */
export async function readAgentJobExecutionEvidence(
  engine: BrainEngine,
  jobId: number,
  sourceId: string | null,
  jobStatus: string,
  mutatingToolNames: ReadonlySet<string>,
): Promise<AgentJobExecutionEvidence> {
  const evidenceToolNames = [...new Set([...TRACKED_TOOLS, ...mutatingToolNames])];
  const rows = await engine.executeRaw<ToolExecutionRow>(
    `SELECT tool_name, input, status, output
       FROM subagent_tool_executions
      WHERE job_id = $1
        AND tool_name IN (${evidenceToolNames.map((_, index) => `$${index + 2}`).join(', ')})
      ORDER BY message_idx, COALESCE(ordinal, 0), id
      LIMIT $${evidenceToolNames.length + 2}`,
    [jobId, ...evidenceToolNames, MAX_EVIDENCE_OPERATIONS + 1],
  );
  const truncated = rows.length > MAX_EVIDENCE_OPERATIONS;
  const boundedRows = rows.slice(0, MAX_EVIDENCE_OPERATIONS);
  const trackedRows = boundedRows.filter((row) => isTrackedTool(row.tool_name));
  const operations = completeAppliedHashes(
    trackedRows.map((row, sequence) => evidenceForRow(row, sequence, sourceId)),
  );
  const unsupportedMutationCount = boundedRows.filter((row) =>
    mutatingToolNames.has(row.tool_name) && !isTrackedTool(row.tool_name)
  ).length;
  const pending = boundedRows.some((row) => row.status === 'pending');
  const incompleteMutation = operations.some((operation) =>
    completedMutationLacksProof(operation)
  );
  const terminal = ['completed', 'failed', 'dead', 'cancelled'].includes(jobStatus);
  const availability = truncated || pending || incompleteMutation || unsupportedMutationCount > 0
    ? 'incomplete'
    : operations.length === 0
      ? 'unavailable'
      : !terminal
        ? 'incomplete'
        : 'complete';
  return {
    schema_version: 1,
    availability,
    truncated,
    unsupported_mutation_count: unsupportedMutationCount,
    allowed_recovery_actions: recoveryActions({
      availability,
      terminal,
      truncated,
      pending,
      unsupportedMutationCount,
    }),
    source_id: sourceId,
    operations,
  };
}

// A completed mutation is authoritative only when its durable row proves both
// the requested identity and the server-observed outcome.
function completedMutationLacksProof(operation: Record<string, unknown>): boolean {
  if (operation.execution_status !== 'complete') return false;
  if (operation.operation === 'put_page') {
    return typeof operation.applied_content_hash !== 'string' ||
      operation.outcome === 'unknown';
  }
  if (operation.operation === 'add_timeline_entry') {
    return typeof operation.timeline_payload_sha256 !== 'string' ||
      operation.outcome === 'unknown';
  }
  if (operation.operation === 'add_link' || operation.operation === 'remove_link') {
    return typeof operation.link_payload_sha256 !== 'string' ||
      operation.outcome !== 'applied';
  }
  return false;
}

// Older durable put_page outputs predate the returned content hash. A later
// completed get_page for the same slug is itself server-recorded read-back
// evidence, so use it to complete that historical write fact.
function completeAppliedHashes(
  operations: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return operations.map((operation, index) => {
    if (
      operation.operation !== 'put_page' ||
      operation.execution_status !== 'complete' ||
      operation.applied_content_hash !== null
    ) return operation;
    const later = operations.slice(index + 1);
    const nextWrite = later.findIndex((candidate) =>
      candidate.operation === 'put_page' &&
      candidate.source_id === operation.source_id &&
      candidate.slug === operation.slug
    );
    const readWindow = nextWrite === -1 ? later : later.slice(0, nextWrite);
    const read = readWindow.find((candidate) =>
      candidate.operation === 'get_page' &&
      candidate.execution_status === 'complete' &&
      candidate.source_id === operation.source_id &&
      candidate.slug === operation.slug &&
      typeof candidate.observed_content_hash === 'string'
    );
    return read
      ? { ...operation, applied_content_hash: read.observed_content_hash }
      : operation;
  });
}

// Authorize only idempotent frozen-plan recovery; Lore still narrows this set
// after comparing the ledger with the reviewed plan it owns.
function recoveryActions(input: {
  availability: AgentJobExecutionEvidence['availability'];
  terminal: boolean;
  truncated: boolean;
  pending: boolean;
  unsupportedMutationCount: number;
}): RecoveryAction[] {
  if (!input.terminal || input.pending) return [];
  const closeOrRefresh: RecoveryAction[] = [
    'refresh_proposal',
    'close_without_remaining_writes',
  ];
  if (input.truncated || input.unsupportedMutationCount > 0) {
    return closeOrRefresh;
  }
  if (input.availability === 'complete') {
    return [
      'finalize_verified_success',
      'continue_approved_work',
      ...closeOrRefresh,
    ];
  }
  return ['continue_approved_work', ...closeOrRefresh];
}

function isTrackedTool(toolName: string): toolName is typeof TRACKED_TOOLS[number] {
  return (TRACKED_TOOLS as readonly string[]).includes(toolName);
}

// Convert one supported operation to the smallest fact set needed for replay.
function evidenceForRow(
  row: ToolExecutionRow,
  sequence: number,
  sourceId: string | null,
): Record<string, unknown> {
  const input = objectValue(row.input);
  const output = objectValue(row.output);
  const base = {
    sequence,
    operation: row.tool_name.slice('brain_'.length),
    execution_status: row.status,
    source_id: sourceId,
  };
  if (row.tool_name === 'brain_put_page') {
    const requestedSlug = stringValue(input.slug);
    const outputMatchesRequest = requestedSlug !== null && output.slug === requestedSlug;
    return {
      ...base,
      slug: requestedSlug,
      expected_content_hash: expectedHash(input.expected_content_hash),
      content_sha256: sha256(stringValue(input.content)),
      applied_content_hash: outputMatchesRequest ? hashValue(output.content_hash) : null,
      outcome: outputMatchesRequest
        ? putPageOutcome(row.status, output.status)
        : 'unknown',
    };
  }
  if (row.tool_name === 'brain_get_page') {
    return {
      ...base,
      source_id: row.status === 'failed' ? sourceId : stringValue(output.source_id),
      slug: stringValue(input.slug),
      observed_content_hash: hashValue(output.content_hash),
    };
  }
  if (row.tool_name === 'brain_add_timeline_entry') {
    return {
      ...base,
      slug: stringValue(input.slug),
      timeline_payload_sha256: sha256(canonicalTimelinePayload(input)),
      outcome: timelineOutcome(row.status, output.inserted),
    };
  }
  return {
    ...base,
    from: stringValue(input.from),
    to: stringValue(input.to),
    link_type: canonicalLinkType(input.link_type, row.tool_name),
    link_payload_sha256: sha256(canonicalLinkPayload(input, row.tool_name)),
    outcome: row.status === 'complete' && output.status === 'ok'
      ? 'applied'
      : 'unknown',
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hashValue(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function expectedHash(value: unknown): string | null | 'unavailable' {
  if (value === null) return null;
  return hashValue(value) ?? 'unavailable';
}

function sha256(value: string | null): string | null {
  return value === null
    ? null
    : createHash('sha256').update(value, 'utf8').digest('hex');
}

function putPageOutcome(
  status: ExecutionStatus,
  outputStatus: unknown,
): 'changed' | 'unchanged' | 'unknown' {
  if (status !== 'complete') return 'unknown';
  if (outputStatus === 'created_or_updated') return 'changed';
  if (outputStatus === 'skipped') return 'unchanged';
  return 'unknown';
}

function timelineOutcome(
  status: ExecutionStatus,
  inserted: unknown,
): 'inserted' | 'unchanged' | 'unknown' {
  if (status !== 'complete') return 'unknown';
  if (inserted === true) return 'inserted';
  if (inserted === false) return 'unchanged';
  return 'unknown';
}

function canonicalTimelinePayload(input: Record<string, unknown>): string | null {
  const values = [
    input.slug,
    input.date,
    input.summary,
    optionalString(input.detail),
    optionalString(input.source),
    optionalString(input.ref),
    optionalString(input.ref_label),
  ];
  return values.slice(0, 3).every((value) => typeof value === 'string')
    ? JSON.stringify(values)
    : null;
}

function canonicalLinkPayload(
  input: Record<string, unknown>,
  toolName: string,
): string | null {
  const from = stringValue(input.from);
  const to = stringValue(input.to);
  if (from === null || to === null) return null;
  const values = [
    from,
    to,
    canonicalLinkType(input.link_type, toolName),
    optionalString(input.context),
    optionalString(input.link_source) ??
      (toolName === 'brain_add_link' ? 'manual' : null),
  ];
  return JSON.stringify(values);
}

function canonicalLinkType(value: unknown, toolName: string): string | null {
  if (typeof value === 'string') return value;
  return toolName === 'brain_add_link' ? '' : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
