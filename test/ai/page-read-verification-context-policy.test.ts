import { describe, expect, it } from 'bun:test';
import {
  compactToolLoopMessages,
} from '../../src/core/ai/tool-loop-context.ts';
import type { ChatMessage } from '../../src/core/ai/gateway.ts';
import { pageReadVerificationContextPolicy } from '../../src/core/page-read-verification-context-policy.ts';

const VALID_HASH = 'a'.repeat(64);

/** Build one complete get_page round around an authenticated result. */
function pageReadRound(output: unknown, isError = false): ChatMessage[] {
  return [
    { role: 'user', content: 'Verify the written page and continue.' },
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'page-read',
        toolName: 'brain_get_page',
        input: { source_id: 'company', slug: 'projects/large-filing' },
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'page-read',
        toolName: 'brain_get_page',
        output,
        ...(isError ? { isError: true } : {}),
      }],
    },
  ];
}

/** Return the only tool result from one compacted read round. */
function projectedResult(messages: ChatMessage[]): Record<string, unknown> {
  const resultMessage = messages.find(message => (
    typeof message.content !== 'string'
    && message.content.some(block => block.type === 'tool-result')
  ));
  const result = typeof resultMessage?.content === 'string'
    ? undefined
    : resultMessage?.content.find(block => block.type === 'tool-result');
  if (!result || result.type !== 'tool-result' || !result.output || typeof result.output !== 'object') {
    throw new Error('Expected one projected tool result.');
  }
  return result.output as Record<string, unknown>;
}

describe('page-read verification working-context policy', () => {
  it('projects a 140952-byte page body to authenticated identity and content hash', () => {
    const privateBodyMarker = 'PRIVATE_LARGE_FILING_';
    const compiledTruth = privateBodyMarker
      + 'x'.repeat(140_952 - Buffer.byteLength(privateBodyMarker, 'utf8'));
    const output = {
      source_id: 'company',
      slug: 'projects/large-filing',
      content_hash: VALID_HASH,
      title: 'Private filing title',
      compiled_truth: compiledTruth,
      tags: ['private-review'],
    };
    expect(Buffer.byteLength(output.compiled_truth, 'utf8')).toBe(140_952);
    const messages = pageReadRound(output);
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 4_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
    });
    const projected = projectedResult(compacted);

    expect(Object.keys(projected).sort()).toEqual([
      'content_hash',
      'slug',
      'source_id',
      'working_context_projection',
    ]);
    expect(projected).toMatchObject({
      source_id: 'company',
      slug: 'projects/large-filing',
      content_hash: VALID_HASH,
      working_context_projection: {
        schema: 'gbrain.page_read_verification_projection.v1',
        interpretation: 'authenticated_page_identity_and_content_hash_only',
        original_json_utf8_bytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
    });
    expect(JSON.stringify(compacted)).not.toContain('PRIVATE_LARGE_FILING_');
    expect(JSON.stringify(compacted)).not.toContain('Private filing title');
    expect(JSON.stringify(compacted)).not.toContain('private-review');
    expect(messages).toEqual(durableSnapshot);
  });

  it.each([
    ['missing source', { slug: 'projects/large-filing', content_hash: VALID_HASH }],
    ['malformed source', { source_id: 'Private Company', slug: 'projects/large-filing', content_hash: VALID_HASH }],
    ['missing slug', { source_id: 'company', content_hash: VALID_HASH }],
    ['malformed slug', { source_id: 'company', slug: '../../private', content_hash: VALID_HASH }],
    ['missing hash', { source_id: 'company', slug: 'projects/large-filing' }],
    ['short hash', { source_id: 'company', slug: 'projects/large-filing', content_hash: 'abc123' }],
    ['uppercase hash', { source_id: 'company', slug: 'projects/large-filing', content_hash: 'A'.repeat(64) }],
  ])('does not issue verification evidence for a %s', (_name, identity) => {
    const output = {
      ...identity,
      compiled_truth: `MALFORMED_PRIVATE_BODY_${'x'.repeat(20_000)}`,
    };
    const compacted = compactToolLoopMessages(pageReadRound(output), 2_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
    });
    const projected = projectedResult(compacted);

    expect(projected).toEqual({
      working_context_projection: {
        schema: 'gbrain.page_read_verification_projection.v1',
        verification: 'unavailable',
        interpretation: 'malformed_page_identity_or_content_hash',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('MALFORMED_PRIVATE_BODY_');
    expect(JSON.stringify(projected)).not.toContain('../../private');
    expect(JSON.stringify(projected)).not.toContain('Private Company');
    expect(JSON.stringify(projected)).not.toContain('abc123');
  });

  it('keeps a small malformed result exact when other history requires compaction', () => {
    const output = {
      error: 'page_not_found',
      message: 'Page not found: projects/missing-filing',
    };
    const round = pageReadRound(output);
    const messages: ChatMessage[] = [
      round[0]!,
      { role: 'assistant', content: `OLD_PRIVATE_HISTORY_${'x'.repeat(20_000)}` },
      ...round.slice(1),
    ];
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 2_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
    });

    expect(projectedResult(compacted)).toEqual(output);
    expect(JSON.stringify(compacted)).not.toContain('OLD_PRIVATE_HISTORY_');
    expect(JSON.stringify(compacted)).not.toContain('gbrain.page_read_verification_projection.v1');
    expect(messages).toEqual(durableSnapshot);
  });

  it('projects the canonical missing-page error to typed absence', () => {
    const output = 'Page not found: projects/missing-filing';
    const compacted = compactToolLoopMessages(pageReadRound(output, true), 1, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
      preferredProjectionBytes: 1_000,
      preferredProjectionFits: () => true,
    });

    expect(projectedResult(compacted)).toEqual({
      slug: 'projects/missing-filing',
      working_context_projection: {
        schema: 'gbrain.page_read_verification_projection.v1',
        verification: 'not_found',
        interpretation: 'authenticated_page_absence',
      },
    });
    expect(JSON.stringify(compacted)).not.toContain(output);
  });

  it('does not retain short noncanonical failure text', () => {
    const output = 'Database connection failed with private credentials';
    const compacted = compactToolLoopMessages(pageReadRound(output, true), 1, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
      preferredProjectionBytes: 1_000,
      preferredProjectionFits: () => true,
    });

    expect(projectedResult(compacted)).toEqual({
      working_context_projection: {
        schema: 'gbrain.page_read_verification_projection.v1',
        verification: 'unavailable',
        interpretation: 'malformed_page_identity_or_content_hash',
      },
    });
    expect(JSON.stringify(compacted)).not.toContain(output);
  });

  it.each([
    'companies/acme.io',
    'people/foo_bar',
    '会議/紀要',
  ])('retains authenticated hash evidence for canonical stored slug %s', slug => {
    const compacted = compactToolLoopMessages(pageReadRound({
      source_id: 'company',
      slug,
      content_hash: VALID_HASH,
      compiled_truth: `PRIVATE_CANONICAL_BODY_${'x'.repeat(20_000)}`,
    }), 2_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
    });

    expect(projectedResult(compacted)).toMatchObject({
      source_id: 'company',
      slug,
      content_hash: VALID_HASH,
      working_context_projection: {
        schema: 'gbrain.page_read_verification_projection.v1',
      },
    });
    expect(JSON.stringify(compacted)).not.toContain('PRIVATE_CANONICAL_BODY_');
  });

  it('measures dense Unicode results by UTF-8 bytes without altering the durable result', () => {
    const output = {
      source_id: 'company',
      slug: 'projects/unicode-filing',
      content_hash: VALID_HASH,
      compiled_truth: `${'漢'.repeat(47_000)}${'🧠'.repeat(1_000)}`,
    };
    const messages = pageReadRound(output);
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 1_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [pageReadVerificationContextPolicy],
    });
    const projected = projectedResult(compacted);

    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(1_000);
    expect(projected).toMatchObject({
      source_id: 'company',
      slug: 'projects/unicode-filing',
      content_hash: VALID_HASH,
      working_context_projection: {
        original_json_utf8_bytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
    });
    expect(messages).toEqual(durableSnapshot);
  });
});
