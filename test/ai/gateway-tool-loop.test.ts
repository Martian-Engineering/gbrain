import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  toolLoop,
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatBlock,
  type ChatMessage,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';
import {
  compactToolLoopMessages,
  resolveToolLoopMessageBudget,
  ToolLoopContextProjectionError,
} from '../../src/core/ai/tool-loop-context.ts';

describe('gateway.toolLoop (v0.38 D11 — provider-agnostic loop control)', () => {
  beforeEach(() => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  it('exits cleanly on end stop_reason with no tools', async () => {
    __setChatTransportForTests(async () => ({
      text: 'hello world',
      blocks: [{ type: 'text', text: 'hello world' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('hello world');
    expect(result.totalTurns).toBe(0); // First turn ended cleanly without tool dispatch
    expect(result.totalUsage.input_tokens).toBe(5);
  });

  it('dispatches a single tool call and feeds the result back to the next turn', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'final answer',
        blocks: [{ type: 'text', text: 'final answer' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let toolWasCalled = false;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        toolWasCalled = true;
        expect(input).toEqual({ q: 'foo' });
        return { ok: true, results: [{ slug: 'foo/bar' }] };
      },
    };

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'search', description: 'search the brain', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', handler]]),
    });

    expect(toolWasCalled).toBe(true);
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('final answer');
    expect(result.totalUsage.input_tokens).toBe(25); // 10 + 15
    expect(result.totalUsage.output_tokens).toBe(9); // 4 + 5
  });

  it('captures persistence callbacks in order: assistant → tool start → tool complete', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: { msg: 'hi' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const events: string[] = [];

    await toolLoop({
      initialMessages: [{ role: 'user', content: 'echo hi' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['echo', {
        idempotent: true,
        async execute(input) { events.push(`execute(${JSON.stringify(input)})`); return input; },
      }]]),
      onAssistantTurn: async (turnIdx, _msgIdx, _blocks, _usage, _model) => {
        events.push(`onAssistantTurn(${turnIdx})`);
      },
      onToolCallStart: async (turnIdx, _msgIdx, ordinal, toolName, _input, providerToolCallId) => {
        events.push(`onToolCallStart(turn=${turnIdx}, ordinal=${ordinal}, name=${toolName}, providerCallId=${providerToolCallId})`);
        return { gbrainToolUseId: `gb-${turnIdx}-${ordinal}` };
      },
      onToolCallComplete: async (gbrainToolUseId, _output) => {
        events.push(`onToolCallComplete(${gbrainToolUseId})`);
      },
    });

    // Write-ordering invariant: assistant persisted BEFORE pending tool row;
    // pending row persisted BEFORE execute; execute BEFORE complete.
    expect(events[0]).toBe('onAssistantTurn(0)');
    expect(events[1]).toMatch(/onToolCallStart\(turn=0, ordinal=0, name=echo/);
    expect(events[2]).toMatch(/execute/);
    expect(events[3]).toMatch(/onToolCallComplete\(gb-0-0\)/);
    expect(events[4]).toBe('onAssistantTurn(1)'); // final assistant turn
  });

  it('persists the tool-result user turn via onToolResultTurn before the next chat', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const resultTurns: Array<{ turnIdx: number; messageIdx: number; blocks: ChatBlock[] }> = [];
    await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'search', description: 's', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', { idempotent: true, async execute() { return { hits: 1 }; } }]]),
      onToolResultTurn: async (turnIdx, messageIdx, blocks) => {
        resultTurns.push({ turnIdx, messageIdx, blocks });
      },
    });

    // Fired exactly once, for the single tool round, carrying the tool-result.
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0].turnIdx).toBe(0);
    expect(resultTurns[0].blocks[0].type).toBe('tool-result');
    expect((resultTurns[0].blocks[0] as Extract<ChatBlock, { type: 'tool-result' }>).toolCallId).toBe('tc1');
  });

  it('replay short-circuits a complete prior tool execution', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async () => {
      chatCalls++;
      // Turn 1 emits a tool call. Turn 2 finishes.
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'provider-id-1', toolName: 'work', input: { x: 1 } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'fin',
        blocks: [{ type: 'text', text: 'fin' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let executed = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', {
        idempotent: false,
        async execute() { executed = true; return 'fresh'; },
      }]]),
      onToolCallStart: async () => ({ gbrainToolUseId: 'gb-replay-key' }),
      replayState: {
        priorMessages: [],
        priorTools: new Map([['gb-replay-key', {
          status: 'complete' as const,
          output: 'from-prior-run',
        }]]),
        nextTurnIdx: 0,
        nextMessageIdx: 0,
      },
    });

    expect(executed).toBe(false); // replay short-circuit
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('fin');
  });

  it('bounds a production-sized replay without mutating durable tool evidence', async () => {
    const task = 'Ingest this artifact and preserve the reviewed receipt contract.';
    const priorMessages: ChatMessage[] = [{ role: 'user', content: task }];
    for (let i = 0; i < 90; i++) {
      priorMessages.push({
        role: 'assistant' as const,
        content: [{
          type: 'tool-call' as const,
          toolCallId: `tc-${i}`,
          toolName: i % 3 === 0 ? 'put_page' : 'search',
          input: { round: i },
        }],
      });
      priorMessages.push({
        role: 'user' as const,
        content: [{
          type: 'tool-result' as const,
          toolCallId: `tc-${i}`,
          toolName: i % 3 === 0 ? 'put_page' : 'search',
          output: { round: i, body: 'x'.repeat(40_000) },
        }],
      });
    }
    const originalBytes = JSON.stringify(priorMessages).length;
    expect(originalBytes).toBeGreaterThan(3_400_000);

    let providerMessages: ChatMessage[] | undefined;
    __setChatTransportForTests(async (opts) => {
      providerMessages = opts.messages;
      return {
        text: 'completed from bounded context',
        blocks: [{ type: 'text', text: 'completed from bounded context' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 10_000, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-5.6-luna',
        providerId: 'openai',
      };
    });

    const result = await toolLoop({
      model: 'openai:gpt-5.6-luna',
      initialMessages: [],
      tools: [
        { name: 'search', description: 'read', inputSchema: { type: 'object' } },
        { name: 'put_page', description: 'write', inputSchema: { type: 'object' } },
      ],
      toolHandlers: new Map([
        ['search', { idempotent: true, mutating: false, async execute() { return null; } }],
        ['put_page', { idempotent: true, mutating: true, async execute() { return null; } }],
      ]),
      maxTurns: 100,
      contextWindowTokens: 20_000,
      replayState: {
        priorMessages,
        priorTools: new Map(),
        nextTurnIdx: 90,
        nextMessageIdx: 181,
      },
    });

    expect(providerMessages).toBeDefined();
    expect(JSON.stringify(providerMessages).length).toBeLessThan(30_000);
    expect(JSON.stringify(providerMessages)).toContain(task);
    expect(JSON.stringify(providerMessages)).toContain('tc-89');
    expect(JSON.stringify(providerMessages)).toContain('Distinct mutation evidence');
    expect(JSON.stringify(providerMessages)).toContain('call_id=tc-0');
    expect(JSON.stringify(providerMessages)).not.toContain('call_id=tc-1 ');

    const compacted = providerMessages!;
    for (let i = 0; i < compacted.length; i++) {
      const message = compacted[i]!;
      if (message.role !== 'assistant' || typeof message.content === 'string') continue;
      const calls = message.content.filter(block => block.type === 'tool-call');
      if (calls.length === 0) continue;
      const next = compacted[i + 1];
      expect(next?.role).toBe('user');
      expect(typeof next?.content).not.toBe('string');
      const resultIds = new Set(
        typeof next?.content === 'string'
          ? []
          : next?.content.filter(block => block.type === 'tool-result').map(block => block.toolCallId),
      );
      for (const call of calls) expect(resultIds.has(call.toolCallId)).toBe(true);
    }

    expect(JSON.stringify(priorMessages).length).toBe(originalBytes);
    expect(JSON.stringify(priorMessages[180])).toContain('x'.repeat(40_000));
    expect(JSON.stringify(result.messages).length).toBeGreaterThan(3_400_000);
  });

  it('preserves a production-sized original task while compacting tool history', () => {
    const task = [
      'Ingest the complete artifact exactly as assigned.\n',
      'a'.repeat(57_000),
      '\nTASK_MIDDLE_MUST_SURVIVE\n',
      'z'.repeat(57_000),
      '\nReturn the reviewed receipt.',
    ].join('');
    const messages: ChatMessage[] = [{ role: 'user', content: task }];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `read-${i}`,
          toolName: 'search',
          input: { query: `round-${i}` },
        }],
      });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: `read-${i}`,
          toolName: 'search',
          output: { body: 'x'.repeat(20_000) },
        }],
      });
    }

    const compacted = compactToolLoopMessages(messages, 130_000, {
      mutatingToolNames: new Set(),
    });

    expect(compacted[0]).toEqual({ role: 'user', content: task });
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(130_000);
    expect(JSON.stringify(compacted.slice(1))).toContain('working_context_projection');
    expect(JSON.stringify(compacted[0])).not.toContain('[middle omitted]');
  });

  it('projects large read results as explicit metadata without implying artifact truncation', () => {
    // Arrange a complete production-sized task followed by enough large reads
    // to force provider-only compaction of both get_page and search results.
    const completeArtifact = [
      'Ingest this complete artifact. artifactIntegrity.complete=true\n',
      'a'.repeat(50_000),
      '\nCOMPLETE_ARTIFACT_MIDDLE\n',
      'z'.repeat(50_000),
    ].join('');
    const messages: ChatMessage[] = [{ role: 'user', content: completeArtifact }];
    for (let i = 0; i < 12; i++) {
      const toolName = i % 2 === 0 ? 'get_page' : 'search';
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: `read-${i}`,
          toolName,
          input: toolName === 'get_page'
            ? { slug: `notes/page-${i}` }
            : { query: `artifact topic ${i}` },
        }],
      });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: `read-${i}`,
          toolName,
          output: { slug: `notes/page-${i}`, body: `${i}:`.repeat(20_000) },
        }],
      });
    }
    const durableSnapshot = structuredClone(messages);

    // Act on the provider projection only.
    const compacted = compactToolLoopMessages(messages, 130_000, {
      mutatingToolNames: new Set(),
    });
    const serialized = JSON.stringify(compacted);

    // Assert the complete task remains authoritative and projections are
    // checkable metadata, never source-looking omission previews.
    expect(compacted[0]).toEqual({ role: 'user', content: completeArtifact });
    expect(serialized).toContain('COMPLETE_ARTIFACT_MIDDLE');
    expect(serialized).toContain('working_context_projection');
    expect(serialized).toContain('original_json_utf8_bytes');
    expect(serialized).toContain('sha256');
    expect(serialized).toContain('Re-run search');
    expect(serialized).not.toContain('[middle omitted]');

    const lastResult = compacted.at(-1)!;
    expect(lastResult.role).toBe('user');
    expect(typeof lastResult.content).not.toBe('string');
    const resultBlock = typeof lastResult.content === 'string'
      ? undefined
      : lastResult.content.find(block => block.type === 'tool-result');
    const output = resultBlock && resultBlock.type === 'tool-result'
      ? resultBlock.output as Record<string, Record<string, unknown>>
      : {};
    const metadata = output.working_context_projection;
    const originalOutput = (messages.at(-1)!.content as ChatBlock[])[0]!;
    const originalJson = JSON.stringify(
      originalOutput.type === 'tool-result' ? originalOutput.output : null,
    );
    expect(metadata.original_json_utf8_bytes).toBe(Buffer.byteLength(originalJson, 'utf8'));
    expect(metadata.sha256).toBe(createHash('sha256').update(originalJson).digest('hex'));
    expect(metadata.interpretation).toBe('projection_metadata_not_source_content');
    expect(messages).toEqual(durableSnapshot);
  });

  it('tiers projections for tight budgets while preserving a balanced tool round', () => {
    // Arrange one round whose narrative and result both require projection.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the page and continue from verified evidence.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `Historical working note: ${'n'.repeat(4_000)}` },
          {
            type: 'tool-call',
            toolCallId: 'tight-read',
            toolName: 'get_page',
            input: { slug: 'notes/tight-budget' },
          },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'tight-read',
          toolName: 'get_page',
          output: { body: 'p'.repeat(20_000) },
        }],
      },
    ];

    // Act with a budget that requires the minimal metadata tier.
    const compacted = compactToolLoopMessages(messages, 500, {
      mutatingToolNames: new Set(),
    });
    const serialized = JSON.stringify(compacted);

    // Assert the tool call/result stay paired and even tighter budgets fail
    // closed instead of emitting an invalid provider transcript.
    expect(serialized.length).toBeLessThanOrEqual(500);
    expect(serialized).toContain('"working_context_projection":true');
    expect(serialized).toContain('gbrain working-context projection');
    expect(serialized).toContain('tight-read');
    expect(serialized).not.toContain('[middle omitted]');
    expect(compacted).toHaveLength(3);
    expect(() => compactToolLoopMessages(messages, 200, {
      mutatingToolNames: new Set(),
    })).toThrow(ToolLoopContextProjectionError);
  });

  it('retains only structural mutation identity when a large write input is projected', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write the page exactly once and report the target.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'large-write',
          toolName: 'put_page',
          input: {
            slug: 'wiki/critical-target',
            source_id: 'martian',
            content: 'PRIVATE_BODY_PROSE'.repeat(2_000),
          },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'large-write',
          toolName: 'put_page',
          output: { ok: true },
        }],
      },
    ];
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, 600, {
      mutatingToolNames: new Set(['put_page']),
    });
    const serialized = JSON.stringify(compacted);

    expect(serialized).toContain('wiki/critical-target');
    expect(serialized).toContain('martian');
    expect(serialized).not.toContain('PRIVATE_BODY_PROSE');
    expect(serialized).toContain('sha256');
    expect(messages).toEqual(durableSnapshot);
  });

  it('bounds projections by UTF-8 bytes for dense Unicode content', () => {
    const maxBytes = 2_000;
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Read the page and continue.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'unicode-read',
          toolName: 'get_page',
          input: { slug: 'notes/unicode' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'unicode-read',
          toolName: 'get_page',
          output: { body: `${'漢'.repeat(2_000)}${'🧠'.repeat(2_000)}` },
        }],
      },
    ];
    const durableSnapshot = structuredClone(messages);

    const compacted = compactToolLoopMessages(messages, maxBytes, {
      mutatingToolNames: new Set(),
    });

    expect(Buffer.byteLength(JSON.stringify(compacted), 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(JSON.stringify(compacted)).toContain('working_context_projection');
    expect(messages).toEqual(durableSnapshot);
  });

  it('fails closed when a dense-Unicode task exceeds its byte budget', () => {
    const task = `Preserve exactly:\n${'漢'.repeat(700)}`;
    expect(JSON.stringify([{ role: 'user', content: task }]).length).toBeLessThan(1_000);
    expect(Buffer.byteLength(JSON.stringify([{ role: 'user', content: task }]), 'utf8')).toBeGreaterThan(1_000);

    expect(() => compactToolLoopMessages([{ role: 'user', content: task }], 1_000))
      .toThrow(ToolLoopContextProjectionError);
  });

  it('reserves no more than one UTF-8 byte per available input token', () => {
    const budget = resolveToolLoopMessageBudget({
      model: 'openai:gpt-5.6-terra',
      maxOutputTokens: 32_768,
      contextWindowTokens: 200_000,
      system: '漢'.repeat(1_000),
      tools: [],
    });

    // A byte-level tokenizer cannot emit more tokens than the UTF-8 byte
    // count, so one byte per available token is conservative for ASCII,
    // CJK, emoji, and mixed JSON payloads.
    expect(budget).toBe(200_000 - 32_768 - Buffer.byteLength('漢'.repeat(1_000), 'utf8') - 2);
  });

  it('fails closed when the full original task and required evidence cannot fit', () => {
    const task = `Apply this exact plan:\n${'p'.repeat(1_800)}`;
    const messages: ChatMessage[] = [
      { role: 'user', content: task },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'write-required',
          toolName: 'put_page',
          input: { slug: 'wiki/required', content: 'x'.repeat(2_000) },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'write-required',
          toolName: 'put_page',
          output: { ok: true },
        }],
      },
    ];

    expect(() => compactToolLoopMessages(messages, 2_000, {
      mutatingToolNames: new Set(['put_page']),
    })).toThrow(ToolLoopContextProjectionError);
  });

  it('keeps distinct targets and per-call outcomes for omitted mutations', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Update both pages once.' }];
    for (const [id, slug, failed] of [
      ['write-a', 'wiki/alpha', false],
      ['write-b', 'wiki/beta', true],
      ['write-c', 'wiki/gamma', false],
      ['write-d', 'wiki/delta', false],
      ['write-e', 'wiki/epsilon', false],
    ] as const) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: id, toolName: 'put_page', input: { slug, content: 'x'.repeat(4_000) } }],
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: id, toolName: 'put_page', output: { body: 'y'.repeat(4_000) }, isError: failed }],
      });
    }

    const compacted = compactToolLoopMessages(messages, 2_000, {
      mutatingToolNames: new Set(['put_page']),
    });
    const serialized = JSON.stringify(compacted);

    expect(serialized.length).toBeLessThanOrEqual(2_000);
    expect(serialized).toContain('Distinct mutation evidence');
    expect(serialized).toContain('call_id=write-a');
    expect(serialized).toContain('target=slug:wiki/alpha');
    expect(serialized).toContain('call_id=write-b');
    expect(serialized).toContain('target=slug:wiki/beta');
    expect(serialized).toContain('outcome=failed');
    expect(serialized).toContain('outcome=failed are unverified');
    expect(serialized).toContain('write-e');
  });

  it('fails closed when an oversized parallel round cannot preserve valid pairing', () => {
    const calls: ChatBlock[] = [];
    const results: ChatBlock[] = [];
    for (let i = 0; i < 100; i++) {
      calls.push({ type: 'tool-call', toolCallId: `write-${i}`, toolName: 'put_page', input: { slug: `wiki/${i}` } });
      results.push({ type: 'tool-result', toolCallId: `write-${i}`, toolName: 'put_page', output: { ok: true } });
    }
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Write every page exactly once.' },
      { role: 'assistant', content: calls },
      { role: 'user', content: results },
    ];

    expect(() => compactToolLoopMessages(messages, 2_000, {
      mutatingToolNames: new Set(['put_page']),
    })).toThrow(ToolLoopContextProjectionError);
  });

  it('refuses replay of non-idempotent pending tool with unrecoverable error', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: 'tc-non-idem', toolName: 'mutate', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    await expect(
      toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'mutate', description: 'm', inputSchema: { type: 'object' } }],
        toolHandlers: new Map([['mutate', { idempotent: false, async execute() { return null; } }]]),
        onToolCallStart: async () => ({ gbrainToolUseId: 'gb-pending-key' }),
        replayState: {
          priorMessages: [],
          priorTools: new Map([['gb-pending-key', { status: 'pending' as const }]]),
          nextTurnIdx: 0,
          nextMessageIdx: 0,
        },
      }),
    ).rejects.toThrow(/non-idempotent.*pending/i);
  });

  it('defaults max output tokens per model: 4096 for non-thinking, 32000 for Claude 5', async () => {
    const seen: Array<number | undefined> = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.maxTokens);
      return {
        text: 'ok',
        blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model ?? 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    await toolLoop({ model: 'openai:gpt-4o', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-sonnet-4-6', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-sonnet-5', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-fable-5', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });

    // Non-thinking / non-Claude-5 stay 4096 (safe under openai-compat caps);
    // thinking-by-default Claude 5 models get 32000 headroom.
    expect(seen).toEqual([4096, 4096, 32000, 32000]);
  });

  it('applies the requested reasoning effort to every loop turn', async () => {
    const seen: Array<string | undefined> = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.reasoningEffort);
      return {
        text: 'ok',
        blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model ?? 'openai:gpt-5.6-terra',
        providerId: 'openai',
      };
    });

    await toolLoop({
      model: 'openai:gpt-5.6-terra',
      reasoningEffort: 'high',
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(seen).toEqual(['high']);
  });

  it('hits max_turns when the model keeps calling tools', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'loop', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'loop', description: 'l', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['loop', { idempotent: true, async execute() { return null; } }]]),
      maxTurns: 3,
    });

    expect(result.stopReason).toBe('max_turns');
    expect(result.totalTurns).toBeGreaterThanOrEqual(3);
  });

  it('returns refusal reason without dispatching tools when stopReason=refusal', async () => {
    __setChatTransportForTests(async () => ({
      text: 'I cannot help with that',
      blocks: [{ type: 'text', text: 'I cannot help with that' }] as ChatBlock[],
      stopReason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    let toolWasCalled = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'bad request' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', { idempotent: true, async execute() { toolWasCalled = true; return null; } }]]),
    });

    expect(toolWasCalled).toBe(false);
    expect(result.stopReason).toBe('refusal');
    expect(result.finalText).toBe('I cannot help with that');
  });
});
