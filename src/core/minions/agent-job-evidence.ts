import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

const MAX_EVIDENCE_OPERATIONS = 500;
const TRACKED_TOOLS = [
  'brain_put_page',
  'brain_get_page',
  'brain_add_timeline_entry',
  'brain_add_link',
  'brain_remove_link',
  'brain_apply_ingestion_proposal_page',
  'brain_apply_ingestion_proposal_relation',
  'brain_finalize_ingestion_proposal_application',
] as const;

type ExecutionStatus = 'pending' | 'complete' | 'failed';

const PROPOSAL_FAILURE_CODES = new Set([
  'proposal_authority_unavailable',
  'proposal_authority_expired',
  'proposal_authority_page_missing',
  'apply_failed',
  'baseline_unavailable',
  'digest_mismatch',
  'incomplete_application',
  'invalid_apply_receipt',
  'invalid_digest',
  'invalid_integer',
  'invalid_job_id',
  'invalid_keys',
  'invalid_object',
  'invalid_page',
  'invalid_page_inventory',
  'invalid_params',
  'invalid_sequence',
  'invalid_slug',
  'invalid_string',
  'job_not_bound',
  'off_plan_page',
  'off_plan_relation',
  'out_of_order',
  'page_unavailable',
  'permission_denied',
  'relation_collision',
  'relation_target_unavailable',
  'slug_not_allowed',
  'stage_input_too_large',
  'stale_page',
  'stale_relation',
  'proposal_application_failed',
] as const);

type ProposalFailureCode = typeof PROPOSAL_FAILURE_CODES extends Set<infer T> ? T : never;

interface ToolExecutionRow {
  tool_name: string;
  input: unknown;
  status: ExecutionStatus;
  output: unknown;
}

type RecoveryAction =
  | 'finalize_verified_success'
  | 'continue_approved_work'
  | 'retry_filing_from_current_state'
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
  const pendingMutation = operations.some((operation) =>
    isMutationOperation(operation) && operation.execution_status === 'pending'
  );
  const failedMutation = operations.some((operation) =>
    isMutationOperation(operation) && operation.execution_status === 'failed'
  );
  const proposalFinalizers = operations.filter((operation) =>
    operation.operation === 'finalize_ingestion_proposal_application'
  );
  const latestProposalFinalizer = proposalFinalizers.at(-1);
  const usesProposalApplication = operations.some((operation) => [
    'apply_ingestion_proposal_page',
    'apply_ingestion_proposal_relation',
    'finalize_ingestion_proposal_application',
  ].includes(String(operation.operation)));
  const proposalFinalizationVerified = latestProposalFinalizer?.execution_status === 'complete'
    && !completedMutationLacksProof(latestProposalFinalizer);
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
      pendingMutation,
      failedMutation,
      usesProposalApplication,
      proposalFinalizationVerified,
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
  if (operation.operation === 'apply_ingestion_proposal_page') {
    return operation.outcome === 'unknown' ||
      typeof operation.proposal_job_id !== 'number' ||
      typeof operation.proposal_sequence !== 'number' ||
      typeof operation.slug !== 'string' ||
      typeof operation.proposal_digest !== 'string' ||
      typeof operation.page_digest !== 'string' ||
      typeof operation.applied_content_hash !== 'string' ||
      (operation.effect !== 'create' && operation.effect !== 'update') ||
      typeof operation.rebased !== 'boolean' ||
      (operation.effect === 'create' && operation.previous_content_hash !== null) ||
      (operation.effect === 'update' && typeof operation.previous_content_hash !== 'string');
  }
  if (operation.operation === 'apply_ingestion_proposal_relation') {
    return operation.outcome === 'unknown' ||
      typeof operation.proposal_job_id !== 'number' ||
      typeof operation.proposal_sequence !== 'number' ||
      typeof operation.proposal_digest !== 'string' ||
      typeof operation.relation_digest !== 'string' ||
      typeof operation.target_slug !== 'string' ||
      !['timeline', 'link'].includes(String(operation.relation_kind)) ||
      (operation.relation_kind === 'timeline' &&
        !['written', 'skipped'].includes(String(operation.write_through_status))) ||
      (operation.relation_kind === 'link' && operation.write_through_status !== null);
  }
  if (operation.operation === 'finalize_ingestion_proposal_application') {
    return operation.outcome === 'unknown' ||
      typeof operation.proposal_job_id !== 'number' ||
      typeof operation.proposal_digest !== 'string' ||
      typeof operation.inventory_digest !== 'string' ||
      typeof operation.receipt_digest !== 'string' ||
      [
        'pages_total', 'pages_applied', 'pages_rebased',
        'timeline_total', 'timeline_applied', 'links_total', 'links_applied',
      ].some(key => typeof operation[key] !== 'number');
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
  pendingMutation: boolean;
  failedMutation: boolean;
  usesProposalApplication: boolean;
  proposalFinalizationVerified: boolean;
  unsupportedMutationCount: number;
}): RecoveryAction[] {
  const retryFilingFromCurrentState = input.terminal &&
    input.availability === 'complete' && !input.truncated &&
    input.unsupportedMutationCount === 0 && !input.pendingMutation &&
    input.failedMutation;
  if (!input.terminal || input.pending) return [];
  const closeOrRefresh: RecoveryAction[] = [
    'refresh_proposal',
    'close_without_remaining_writes',
  ];
  if (input.truncated || input.unsupportedMutationCount > 0) {
    return closeOrRefresh;
  }
  if (input.availability === 'complete') {
    const canFinalizeVerifiedSuccess = !input.usesProposalApplication
      || input.proposalFinalizationVerified;
    return [
      ...(canFinalizeVerifiedSuccess
        ? ['finalize_verified_success' as const]
        : []),
      'continue_approved_work',
      ...(retryFilingFromCurrentState
        ? ['retry_filing_from_current_state' as const]
        : []),
      ...closeOrRefresh,
    ];
  }
  return ['continue_approved_work', ...closeOrRefresh];
}

function isMutationOperation(operation: Record<string, unknown>): boolean {
  return [
    'put_page',
    'apply_ingestion_proposal_page',
    'apply_ingestion_proposal_relation',
    'finalize_ingestion_proposal_application',
    'add_timeline_entry',
    'add_link',
    'remove_link',
  ]
    .includes(String(operation.operation));
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
  if (row.tool_name === 'brain_apply_ingestion_proposal_page') {
    const proposalJobId = integerValue(input.proposal_job_id);
    const proposalSequence = integerValue(input.sequence);
    const proposalDigest = hashValue(input.proposal_digest);
    const pageDigest = hashValue(input.page_digest);
    const requestedSource = stringValue(input.source_id);
    const outputMatchesRequest = row.status === 'complete' &&
      output.proposal_job_id === proposalJobId &&
      output.sequence === proposalSequence &&
      output.proposal_digest === proposalDigest &&
      output.page_digest === pageDigest &&
      output.source_id === requestedSource &&
      requestedSource === sourceId;
    const effect = output.effect === 'create' || output.effect === 'update'
      ? output.effect
      : null;
    const status = output.status === 'applied' || output.status === 'already_applied'
      ? output.status
      : null;
    return {
      ...base,
      proposal_job_id: proposalJobId,
      proposal_sequence: proposalSequence,
      proposal_digest: proposalDigest,
      page_digest: pageDigest,
      effect,
      slug: outputMatchesRequest ? stringValue(output.slug) : null,
      previous_content_hash: outputMatchesRequest
        ? nullableHash(output.previous_content_hash)
        : null,
      applied_content_hash: outputMatchesRequest ? hashValue(output.content_hash) : null,
      rebased: outputMatchesRequest ? booleanValue(output.rebased) : null,
      outcome: outputMatchesRequest && effect && status ? status : 'unknown',
      failure_code: proposalFailureCode(row.status, output.failure_code),
    };
  }
  if (row.tool_name === 'brain_apply_ingestion_proposal_relation') {
    const proposalJobId = integerValue(input.proposal_job_id);
    const proposalSequence = integerValue(input.sequence);
    const proposalDigest = hashValue(input.proposal_digest);
    const requestedSource = stringValue(input.source_id);
    const relationKind = input.relation_kind === 'timeline' || input.relation_kind === 'link'
      ? input.relation_kind
      : null;
    const status = output.status === 'applied' || output.status === 'already_applied'
      ? output.status
      : null;
    const outputMatchesRequest = row.status === 'complete' &&
      output.proposal_job_id === proposalJobId &&
      output.sequence === proposalSequence &&
      output.proposal_digest === proposalDigest &&
      output.source_id === requestedSource &&
      output.relation_kind === relationKind &&
      requestedSource === sourceId;
    return {
      ...base,
      proposal_job_id: proposalJobId,
      proposal_digest: proposalDigest,
      relation_kind: relationKind,
      proposal_sequence: proposalSequence,
      relation_digest: outputMatchesRequest ? hashValue(output.relation_digest) : null,
      target_slug: outputMatchesRequest ? stringValue(output.target_slug) : null,
      outcome: outputMatchesRequest && status ? status : 'unknown',
      write_through_status: outputMatchesRequest
        ? relationWriteThroughStatus(relationKind, output.write_through)
        : null,
      failure_code: proposalFailureCode(row.status, output.failure_code),
    };
  }
  if (row.tool_name === 'brain_finalize_ingestion_proposal_application') {
    const proposalJobId = integerValue(input.proposal_job_id);
    const proposalDigest = hashValue(input.proposal_digest);
    const requestedSource = stringValue(input.source_id);
    const status = output.status === 'applied_proposal' || output.status === 'already_finalized'
      ? output.status
      : null;
    const outputMatchesRequest = row.status === 'complete' &&
      output.proposal_job_id === proposalJobId &&
      output.proposal_digest === proposalDigest &&
      output.source_id === requestedSource &&
      requestedSource === sourceId;
    const pages = objectValue(output.pages);
    const timeline = objectValue(output.timeline_entries);
    const links = objectValue(output.links);
    return {
      ...base,
      proposal_job_id: proposalJobId,
      proposal_digest: proposalDigest,
      inventory_digest: outputMatchesRequest ? hashValue(output.inventory_digest) : null,
      receipt_digest: outputMatchesRequest ? hashValue(output.receipt_digest) : null,
      pages_total: outputMatchesRequest ? nonnegativeIntegerValue(pages.total) : null,
      pages_applied: outputMatchesRequest ? nonnegativeIntegerValue(pages.applied) : null,
      pages_rebased: outputMatchesRequest ? nonnegativeIntegerValue(pages.rebased) : null,
      timeline_total: outputMatchesRequest ? nonnegativeIntegerValue(timeline.total) : null,
      timeline_applied: outputMatchesRequest ? nonnegativeIntegerValue(timeline.applied) : null,
      links_total: outputMatchesRequest ? nonnegativeIntegerValue(links.total) : null,
      links_applied: outputMatchesRequest ? nonnegativeIntegerValue(links.applied) : null,
      outcome: outputMatchesRequest && status ? status : 'unknown',
      failure_code: proposalFailureCode(row.status, output.failure_code),
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

function nullableHash(value: unknown): string | null {
  return value === null ? null : hashValue(value);
}

function integerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nonnegativeIntegerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function relationWriteThroughStatus(
  relationKind: 'timeline' | 'link' | null,
  value: unknown,
): 'written' | 'skipped' | 'failed' | null {
  if (relationKind !== 'timeline') return null;
  const writeThrough = objectValue(value);
  if (writeThrough.written === true) return 'written';
  if (typeof writeThrough.skipped === 'string') return 'skipped';
  if (typeof writeThrough.error === 'string') return 'failed';
  return null;
}

function proposalFailureCode(
  status: ExecutionStatus,
  value: unknown,
): ProposalFailureCode | null {
  if (status !== 'failed') return null;
  return typeof value === 'string' && PROPOSAL_FAILURE_CODES.has(value as ProposalFailureCode)
    ? value as ProposalFailureCode
    : 'proposal_application_failed';
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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
