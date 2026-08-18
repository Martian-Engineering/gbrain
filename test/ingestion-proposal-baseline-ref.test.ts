import { describe, expect, it } from 'bun:test';
import {
  executionIdFromProposalBaselineRef,
  exposeProposalBaselineRef,
  proposalBaselineRefForExecution,
} from '../src/core/minions/ingestion-proposal-baseline-ref.ts';

const EXECUTION_ID = '018f1f25-89ab-7def-8123-456789abcdef';

describe('ingestion proposal baseline references', () => {
  it('round-trips a versioned durable execution reference', () => {
    const ref = proposalBaselineRefForExecution(EXECUTION_ID);
    expect(ref).toBe(`gbrain.proposal-baseline.v1:${EXECUTION_ID}`);
    expect(executionIdFromProposalBaselineRef(ref)).toBe(EXECUTION_ID);
  });

  it('decorates only complete page results from the proposal source', () => {
    const page = {
      source_id: 'company',
      slug: 'projects/example',
      content_hash: 'a'.repeat(64),
      compiled_truth: '# Example',
    };
    expect(exposeProposalBaselineRef(page, EXECUTION_ID, 'company')).toEqual({
      ...page,
      proposal_baseline_ref: `gbrain.proposal-baseline.v1:${EXECUTION_ID}`,
    });
    expect(exposeProposalBaselineRef(page, EXECUTION_ID, 'other')).toBe(page);
    expect(exposeProposalBaselineRef('Page not found', EXECUTION_ID, 'company'))
      .toBe('Page not found');
  });

  it('rejects malformed execution references', () => {
    expect(executionIdFromProposalBaselineRef('gbrain.proposal-baseline.v1:not-a-uuid')).toBeNull();
    expect(() => proposalBaselineRefForExecution('inline-0-0')).toThrow(/durable UUID/i);
  });
});
