import { describe, expect, it } from 'bun:test';
import { generateText, jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { toAISDKTools, toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { __testing as brainToolTesting } from '../../src/core/minions/tools/brain-allowlist.ts';

// v0.42 AI SDK v6 fix — the regression guard that the original bug evaded.
// Every gateway/toolLoop test stubs the chat transport, which short-circuits
// BEFORE generateText runs, so neither asSchema() (tool schema normalization)
// nor ModelMessage conversion was ever exercised in CI. This test drives the
// REAL generateText with a MockLanguageModelV3 (no network/keys) so both
// failure points are validated against the actual installed AI SDK v6.

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  } as any);
}

const internalMessages: ChatMessage[] = [
  { role: 'user', content: 'find foo' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }],
  },
  {
    role: 'user', // toolLoop's internal feedback role; adapter must promote to 'tool'
    content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { hits: 3 } }],
  },
];

describe('gateway tool schema + message shape (real AI SDK v6)', () => {
  it('jsonSchema()-wrapped tools + adapted messages pass generateText without throwing', async () => {
    const model = mockModel();
    const tools = toAISDKTools([
      {
        name: 'search',
        description: 'search the brain',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);

    const result = await generateText({
      model: model as any,
      tools: tools as any,
      messages: toModelMessages(internalMessages) as any,
    });

    expect(result.text).toBe('ok');
    // The tool result was promoted to a role:'tool' message in the prompt the
    // model actually received — proving ModelMessage conversion accepted it.
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    expect(prompt.some((m) => m.role === 'tool')).toBe(true);
  });

  it('passes the subagent put_page baseline contract through the real AI SDK', async () => {
    const model = mockModel();
    const inputSchema = brainToolTesting.namespacedPutPageSchema(
      operationsByName.put_page,
      42,
      ['people/'],
    );
    const tools = toAISDKTools([{
      name: 'brain_put_page',
      description: operationsByName.put_page.description,
      inputSchema,
    }]);

    await generateText({
      model: model as any,
      tools: tools as any,
      messages: [{ role: 'user', content: 'Create people/alice-example.' }],
    });

    const providerTool = (model.doGenerateCalls[0]!.tools as any[])
      .find(tool => tool.name === 'brain_put_page');
    expect(providerTool.inputSchema.properties.expected_content_hash.type)
      .toEqual(['string', 'null']);
    expect(providerTool.inputSchema.required).toContain('expected_content_hash');
  });

  it('REGRESSION: the bare { jsonSchema } object (pre-fix shape) is rejected by v6', async () => {
    const model = mockModel();
    const badTools = {
      search: {
        description: 'search the brain',
        // The exact pre-v0.42 bug shape: a plain object, not a Schema.
        inputSchema: { jsonSchema: { type: 'object' } } as any,
      },
    };
    await expect(
      generateText({
        model: model as any,
        tools: badTools as any,
        messages: toModelMessages(internalMessages) as any,
      }),
    ).rejects.toThrow();
  });

  it('REGRESSION: raw tool-result in a role:user message (pre-fix shape) is rejected by v6', async () => {
    const model = mockModel();
    const tools = {
      search: {
        description: 'search',
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } } as any),
      },
    };
    // Pre-fix: toolLoop pushed { role:'user', content:[{type:'tool-result', output: <raw> }] }.
    const preFixMessages = [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { hits: 3 } }] },
    ];
    await expect(
      generateText({ model: model as any, tools: tools as any, messages: preFixMessages as any }),
    ).rejects.toThrow();
  });
});
