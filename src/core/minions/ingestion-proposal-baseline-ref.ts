const PROPOSAL_BASELINE_REF_PREFIX = 'gbrain.proposal-baseline.v1:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposalBaselinePageResult {
  source_id: string;
  slug: string;
  content_hash: string;
  compiled_truth: string;
}

/** Build the opaque model-facing reference for one durable page-read execution. */
export function proposalBaselineRefForExecution(executionId: string): string {
  if (!UUID_RE.test(executionId)) {
    throw new Error('Proposal baseline references require a durable UUID execution id.');
  }
  return `${PROPOSAL_BASELINE_REF_PREFIX}${executionId.toLowerCase()}`;
}

/** Parse a model-supplied proposal baseline reference into its durable execution id. */
export function executionIdFromProposalBaselineRef(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(PROPOSAL_BASELINE_REF_PREFIX)) {
    return null;
  }
  const executionId = value.slice(PROPOSAL_BASELINE_REF_PREFIX.length);
  return UUID_RE.test(executionId) ? executionId.toLowerCase() : null;
}

/** Add a baseline reference only to a complete page result from the bound source. */
export function exposeProposalBaselineRef(
  output: unknown,
  executionId: string,
  sourceId: string,
): unknown {
  const page = proposalBaselinePageResult(output);
  if (!page || page.source_id !== sourceId) return output;
  return {
    ...(output as Record<string, unknown>),
    proposal_baseline_ref: proposalBaselineRefForExecution(executionId),
  };
}

/** Recognize the minimum exact get_page shape required for proposal authority. */
function proposalBaselinePageResult(value: unknown): ProposalBaselinePageResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.source_id !== 'string'
    || typeof record.slug !== 'string'
    || typeof record.content_hash !== 'string'
    || typeof record.compiled_truth !== 'string'
  ) {
    return null;
  }
  return record as unknown as ProposalBaselinePageResult;
}
