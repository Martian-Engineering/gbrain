import { afterEach, describe, expect, it } from 'bun:test';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  toModelMessages,
  toolLoop,
} from '../../src/core/ai/gateway.ts';
import type {
  ChatBlock,
  ChatMessage,
  ChatToolDef,
} from '../../src/core/ai/gateway.ts';
import {
  compactToolLoopMessages,
  openAiToolLoopRequestFits,
  resolveToolLoopMessageBudgets,
} from '../../src/core/ai/tool-loop-context.ts';

/** Find a persisted tool result in the provider-facing prompt. */
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

describe('OpenAI tool-loop context budgeting', () => {
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  it('retains a production-sized latest read when exact OpenAI tokens fit', async () => {
    configureGateway({
      chat_model: 'openai:gpt-5.6-terra',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'openai:gpt-5.6-luna',
      env: { OPENAI_API_KEY: 'stub' },
    });
    const system = 'Published ingestion instructions.\n'.repeat(1_200);
    const tools: ChatToolDef[] = [
      {
        name: 'brain_search',
        description: 'Search the brain for relevant evidence. '.repeat(12),
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'brain_stage_ingestion_proposal_page',
        description: 'Stage one reviewed ingestion proposal page. '.repeat(12),
        inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
      },
      {
        name: 'brain_get_page',
        description: 'Read one canonical brain page. '.repeat(24),
        inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
      },
    ];
    const exactOutput = {
      id: 6_537,
      slug: 'companies/signalcore',
      source_id: 'martian',
      content_hash: 'a'.repeat(64),
      timeline: 't'.repeat(52_663),
      compiled_truth: 'b'.repeat(9_091),
    };
    expect(Buffer.byteLength(JSON.stringify(exactOutput), 'utf8')).toBe(61_933);
    const oldSearchBody = `OLD_SEARCH_RAW_${'s'.repeat(44_000)}`;
    const oldStageBody = `OLD_STAGE_RAW_${'m'.repeat(8_000)}`;
    const durableMessages: ChatMessage[] = [
      { role: 'user', content: 'p'.repeat(116_659) },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search-company',
            toolName: 'brain_search',
            input: { query: 'SignalCore company baseline' },
          },
          {
            type: 'tool-call',
            toolCallId: 'search-people',
            toolName: 'brain_search',
            input: { query: 'SignalCore meeting attendees' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'search-company',
            toolName: 'brain_search',
            output: { matches: oldSearchBody },
          },
          {
            type: 'tool-result',
            toolCallId: 'search-people',
            toolName: 'brain_search',
            output: { matches: oldSearchBody },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'stage-page-fragment',
          toolName: 'brain_stage_ingestion_proposal_page',
          input: {
            slug: 'companies/signalcore',
            source_id: 'martian',
            content: oldStageBody,
          },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'stage-page-fragment',
          toolName: 'brain_stage_ingestion_proposal_page',
          output: { staged: true, fragment: 1, total_fragments: 13 },
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'canonical-baseline',
          toolName: 'brain_get_page',
          input: { slug: 'companies/signalcore', source_id: 'martian' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'canonical-baseline',
          toolName: 'brain_get_page',
          output: exactOutput,
        }],
      },
    ];
    const durableSnapshot = structuredClone(durableMessages);
    const mutatingToolNames = new Set(['brain_stage_ingestion_proposal_page']);
    const budgets = resolveToolLoopMessageBudgets({
      model: 'openai:gpt-5.6-terra',
      maxOutputTokens: 32_768,
      contextWindowTokens: 200_000,
      system,
      tools,
    });
    expect(Buffer.byteLength(JSON.stringify(durableMessages), 'utf8'))
      .toBeGreaterThan(budgets.byteSafeBytes);
    const byteSafeOnly = compactToolLoopMessages(
      durableMessages,
      budgets.byteSafeBytes,
      { mutatingToolNames },
    );
    expect(resultOutput(byteSafeOnly, 'canonical-baseline')).not.toEqual(exactOutput);
    expect(JSON.stringify(resultOutput(byteSafeOnly, 'canonical-baseline')))
      .toContain('working_context_projection');

    let providerMessages: ChatMessage[] = [];
    __setChatTransportForTests(async options => {
      providerMessages = structuredClone(options.messages);
      return {
        text: 'safe to stage',
        blocks: [{ type: 'text', text: 'safe to stage' }] as ChatBlock[],
        stopReason: 'end',
        usage: {
          input_tokens: 75_000,
          output_tokens: 4,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'openai:gpt-5.6-terra',
        providerId: 'openai',
      };
    });

    await toolLoop({
      model: 'openai:gpt-5.6-terra',
      system,
      initialMessages: [],
      tools,
      toolHandlers: new Map([
        ['brain_search', {
          idempotent: true,
          mutating: false,
          async execute() { return null; },
        }],
        ['brain_stage_ingestion_proposal_page', {
          idempotent: false,
          mutating: true,
          async execute() { return null; },
        }],
        ['brain_get_page', {
          idempotent: true,
          mutating: false,
          async execute() { return null; },
        }],
      ]),
      maxTokens: 32_768,
      contextWindowTokens: 200_000,
      replayState: {
        priorMessages: durableMessages,
        priorTools: new Map(),
        nextTurnIdx: 1,
        nextMessageIdx: durableMessages.length,
      },
    });

    expect(resultOutput(providerMessages, 'canonical-baseline')).toEqual(exactOutput);
    expect(providerMessages).toHaveLength(4);
    expect(JSON.stringify(providerMessages)).toContain('Distinct mutation evidence');
    expect(JSON.stringify(providerMessages)).toContain('call_id=stage-page-fragment');
    expect(JSON.stringify(providerMessages)).not.toContain('OLD_SEARCH_RAW_');
    expect(JSON.stringify(providerMessages)).not.toContain('OLD_STAGE_RAW_');
    expect(Buffer.byteLength(JSON.stringify(providerMessages), 'utf8'))
      .toBeLessThanOrEqual(budgets.preferredProjectionBytes);
    expect(openAiToolLoopRequestFits({
      budgets,
      system,
      tools,
      modelMessages: toModelMessages(providerMessages),
    })).toBe(true);
    expect(durableMessages).toEqual(durableSnapshot);
  }, 15_000);

  it('rejects a preferred dense-Unicode result when exact tokens exceed the target', () => {
    const model = 'openai:gpt-5.6-terra';
    const system = 'Keep exact source text only when it fits.';
    const tools: ChatToolDef[] = [{
      name: 'brain_get_page',
      description: 'Read one page.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
    }];
    const budgets = resolveToolLoopMessageBudgets({
      model,
      maxOutputTokens: 1_000,
      contextWindowTokens: 10_000,
      system,
      tools,
    });
    const exactOutput = { body: '🧠'.repeat(2_500) };
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the latest page.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'unicode-read',
          toolName: 'brain_get_page',
          input: { slug: 'notes/unicode' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'unicode-read',
          toolName: 'brain_get_page',
          output: exactOutput,
        }],
      },
    ];
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, budgets.byteSafeBytes, {
      mutatingToolNames: new Set(),
      preferredProjectionBytes: budgets.preferredProjectionBytes,
      preferredProjectionFits: candidate => openAiToolLoopRequestFits({
        budgets,
        system,
        tools,
        modelMessages: toModelMessages(candidate),
      }),
    });

    expect(resultOutput(compacted, 'unicode-read')).not.toEqual(exactOutput);
    expect(JSON.stringify(compacted)).toContain('working_context_projection');
    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8'))
      .toBeLessThanOrEqual(budgets.byteSafeBytes);
    expect(messages).toEqual(durableSnapshot);
  });

  it('tries smaller input projections until the exact-result candidate fits', () => {
    const exactOutput = { body: `EXACT_RESULT_${'r'.repeat(4_000)}` };
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the page and continue.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'large-input-read',
          toolName: 'brain_get_page',
          input: { slug: 'notes/large-input', filter: '🧠'.repeat(2_500) },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'large-input-read',
          toolName: 'brain_get_page',
          output: exactOutput,
        }],
      },
    ];
    let preferredChecks = 0;

    const compacted = compactToolLoopMessages(messages, 1_000, {
      mutatingToolNames: new Set(),
      preferredProjectionBytes: 20_000,
      preferredProjectionFits: candidate => {
        preferredChecks++;
        return JSON.stringify(candidate).includes('working_context_projection');
      },
    });

    expect(preferredChecks).toBe(2);
    expect(resultOutput(compacted, 'large-input-read')).toEqual(exactOutput);
    expect(JSON.stringify(compacted)).toContain('working_context_projection');
  });

  it('leaves an already byte-safe transcript completely unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Compare both pages.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'first-read',
          toolName: 'brain_get_page',
          input: { slug: 'notes/first' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'first-read',
          toolName: 'brain_get_page',
          output: { body: 'first exact result' },
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'second-read',
          toolName: 'brain_get_page',
          input: { slug: 'notes/second' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'second-read',
          toolName: 'brain_get_page',
          output: { body: 'second exact result' },
        }],
      },
    ];
    let preferredChecks = 0;

    const compacted = compactToolLoopMessages(messages, 10_000, {
      mutatingToolNames: new Set(),
      preferredProjectionBytes: 20_000,
      preferredProjectionFits: () => {
        preferredChecks++;
        return true;
      },
    });

    expect(compacted).toBe(messages);
    expect(preferredChecks).toBe(0);
  });

  it('never restores mutation, mismatched-name, or failed singleton outputs', () => {
    const scenarios = [
      {
        id: 'mutation',
        callName: 'put_page',
        resultName: 'put_page',
        isError: false,
        mutating: new Set(['put_page']),
      },
      {
        id: 'mismatch',
        callName: 'brain_get_page',
        resultName: 'query',
        isError: false,
        mutating: new Set<string>(),
      },
      {
        id: 'failed',
        callName: 'brain_get_page',
        resultName: 'brain_get_page',
        isError: true,
        mutating: new Set<string>(),
      },
    ];

    for (const scenario of scenarios) {
      const exactOutput = { body: `FORBIDDEN_${scenario.id}_${'x'.repeat(4_000)}` };
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Continue safely.' },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: scenario.id,
            toolName: scenario.callName,
            input: { slug: `notes/${scenario.id}`, content: 'private'.repeat(500) },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: scenario.id,
            toolName: scenario.resultName,
            output: exactOutput,
            ...(scenario.isError ? { isError: true } : {}),
          }],
        },
      ];
      let preferredChecks = 0;

      const compacted = compactToolLoopMessages(messages, 1_000, {
        mutatingToolNames: scenario.mutating,
        preferredProjectionBytes: 20_000,
        preferredProjectionFits: () => {
          preferredChecks++;
          return true;
        },
      });

      expect(resultOutput(compacted, scenario.id)).not.toEqual(exactOutput);
      expect(JSON.stringify(compacted)).not.toContain(`FORBIDDEN_${scenario.id}_`);
      expect(preferredChecks).toBe(0);
    }
  });
});
