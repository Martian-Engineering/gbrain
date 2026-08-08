import { describe, expect, it } from 'bun:test';
import {
  compactToolLoopMessages,
} from '../../src/core/ai/tool-loop-context.ts';
import type { ChatBlock, ChatMessage } from '../../src/core/ai/gateway.ts';

interface RoundEntry {
  id: string;
  callName: string;
  input: unknown;
  output: unknown;
  resultName?: string;
  isError?: boolean;
}

/** Build one provider-valid parallel tool round after a task message. */
function buildRound(task: string, entries: RoundEntry[]): ChatMessage[] {
  return [
    { role: 'user', content: task },
    {
      role: 'assistant',
      content: entries.map(entry => ({
        type: 'tool-call' as const,
        toolCallId: entry.id,
        toolName: entry.callName,
        input: entry.input,
      })),
    },
    {
      role: 'user',
      content: entries.map(entry => ({
        type: 'tool-result' as const,
        toolCallId: entry.id,
        toolName: entry.resultName ?? entry.callName,
        output: entry.output,
        ...(entry.isError ? { isError: true } : {}),
      })),
    },
  ];
}

/** Read one result output from a compacted provider projection. */
function resultOutput(messages: ChatMessage[], toolCallId: string): unknown {
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    const result = message.content.find(block => (
      block.type === 'tool-result' && block.toolCallId === toolCallId
    ));
    if (result?.type === 'tool-result') return result.output;
  }
  throw new Error(`Missing tool result ${toolCallId}`);
}

describe('tool-loop exact non-mutating result retention', () => {
  it('retains an exact successful read from a projected parallel round when one fits', () => {
    const smallOutput = {
      content_hash: 'a'.repeat(64),
      body: `EXACT_SMALL_${'s'.repeat(5_000)}`,
    };
    const queryOutput = { hits: `EXACT_QUERY_${'q'.repeat(11_800)}` };
    const messages = buildRound(
      `Complete ingestion task\n${'t'.repeat(116_000)}`,
      [
        { id: 'read-small', callName: 'get_page', input: { slug: 'people/small' }, output: smallOutput },
        {
          id: 'read-small-two',
          callName: 'get_page',
          input: { slug: 'people/small-two' },
          output: { content_hash: 'b'.repeat(64), body: `EXACT_SMALL_TWO_${'n'.repeat(8_700)}` },
        },
        {
          id: 'read-medium',
          callName: 'get_page',
          input: { slug: 'people/medium' },
          output: { content_hash: 'c'.repeat(64), body: `EXACT_MEDIUM_${'m'.repeat(14_000)}` },
        },
        {
          id: 'read-large',
          callName: 'get_page',
          input: { slug: 'people/large' },
          output: { content_hash: 'd'.repeat(64), body: `EXACT_LARGE_${'l'.repeat(45_000)}` },
        },
        {
          id: 'query-related',
          callName: 'query',
          input: { query: 'related context' },
          output: queryOutput,
        },
      ],
    );
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 130_000, {
      mutatingToolNames: new Set(),
    });
    const serialized = JSON.stringify(compacted);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(130_000);
    expect(resultOutput(compacted, 'query-related')).toEqual(queryOutput);
    expect(serialized).toContain('working_context_projection');
    expect(serialized).not.toContain('EXACT_LARGE_');
    expect(messages).toEqual(durableSnapshot);

    const assistant = compacted.at(-2)!;
    const result = compacted.at(-1)!;
    const callIds = new Set(
      typeof assistant.content === 'string'
        ? []
        : assistant.content
          .filter(block => block.type === 'tool-call')
          .map(block => block.toolCallId),
    );
    const resultIds = new Set(
      typeof result.content === 'string'
        ? []
        : result.content
          .filter(block => block.type === 'tool-result')
          .map(block => block.toolCallId),
    );
    expect(resultIds).toEqual(callIds);
  });

  it('keeps a successful singleton read exactly equal under the same byte budget', () => {
    const singletonOutput = {
      content_hash: 'e'.repeat(64),
      body: `EXACT_SINGLETON_${'p'.repeat(8_000)}`,
    };
    const messages = buildRound(
      `Complete ingestion task\n${'t'.repeat(116_000)}`,
      [{
        id: 'read-singleton',
        callName: 'get_page',
        input: { slug: 'people/singleton' },
        output: singletonOutput,
      }],
    );

    const compacted = compactToolLoopMessages(messages, 130_000, {
      mutatingToolNames: new Set(),
    });

    expect(resultOutput(compacted, 'read-singleton')).toEqual(singletonOutput);
    expect(JSON.stringify(compacted)).not.toContain('working_context_projection');
  });

  it('keeps every read projected when no exact result fits beside the task', () => {
    const messages = buildRound(
      `Complete ingestion task\n${'t'.repeat(126_000)}`,
      [
        {
          id: 'read-one',
          callName: 'get_page',
          input: { slug: 'people/one' },
          output: { content_hash: 'f'.repeat(64), body: `NO_FIT_ONE_${'x'.repeat(8_000)}` },
        },
        {
          id: 'read-two',
          callName: 'get_page',
          input: { slug: 'people/two' },
          output: { content_hash: 'g'.repeat(64), body: `NO_FIT_TWO_${'y'.repeat(8_000)}` },
        },
      ],
    );
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 130_000, {
      mutatingToolNames: new Set(),
    });
    const serialized = JSON.stringify(compacted);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(130_000);
    expect(serialized).toContain('working_context_projection');
    expect(serialized).not.toContain('NO_FIT_ONE_');
    expect(serialized).not.toContain('NO_FIT_TWO_');
    expect(messages).toEqual(durableSnapshot);
  });

  it('projects a large input when a lower tier can retain the exact read result', () => {
    const exactOutput = {
      content_hash: 'h'.repeat(64),
      body: `TIER_PRIORITY_RESULT_${'r'.repeat(13_000)}`,
    };
    const messages = buildRound('Read the exact page.', [{
      id: 'tier-priority',
      callName: 'get_page',
      input: { slug: 'people/tier-priority', detail: 'i'.repeat(11_000) },
      output: exactOutput,
    }]);

    const compacted = compactToolLoopMessages(messages, 16_000, {
      mutatingToolNames: new Set(),
    });

    expect(resultOutput(compacted, 'tier-priority')).toEqual(exactOutput);
    const assistant = compacted[1]!;
    const input = typeof assistant.content === 'string'
      ? null
      : (assistant.content[0] as Extract<ChatBlock, { type: 'tool-call' }>).input;
    expect(JSON.stringify(input)).toContain('working_context_projection');
  });

  it('prefers the largest exact read when only one projected result fits', () => {
    const smallerOutput = {
      content_hash: 'i'.repeat(64),
      body: `SMALLER_EXACT_${'s'.repeat(13_000)}`,
    };
    const largerOutput = {
      content_hash: 'j'.repeat(64),
      body: `LARGER_EXACT_${'l'.repeat(20_000)}`,
    };
    const messages = buildRound('Retain the most complete read evidence.', [
      {
        id: 'smaller-read',
        callName: 'get_page',
        input: { slug: 'people/smaller' },
        output: smallerOutput,
      },
      {
        id: 'larger-read',
        callName: 'get_page',
        input: { slug: 'people/larger' },
        output: largerOutput,
      },
    ]);

    const compacted = compactToolLoopMessages(messages, 22_000, {
      mutatingToolNames: new Set(),
    });

    expect(resultOutput(compacted, 'larger-read')).toEqual(largerOutput);
    expect(resultOutput(compacted, 'smaller-read')).not.toEqual(smallerOutput);
  });

  it('never restores a mutation result whose block is mislabeled as a read', () => {
    const mutationOutput = { body: `MUTATION_OUTPUT_${'w'.repeat(13_000)}` };
    const messages = buildRound('Write the page once.', [{
      id: 'mislabeled-mutation',
      callName: 'put_page',
      resultName: 'get_page',
      input: { slug: 'wiki/target', content: 'i'.repeat(13_000) },
      output: mutationOutput,
    }]);

    const compacted = compactToolLoopMessages(messages, 16_000, {
      mutatingToolNames: new Set(['put_page']),
    });
    const serialized = JSON.stringify(compacted);

    expect(resultOutput(compacted, 'mislabeled-mutation')).not.toEqual(mutationOutput);
    expect(serialized).toContain('working_context_projection');
    expect(serialized).not.toContain('MUTATION_OUTPUT_');
  });
});
