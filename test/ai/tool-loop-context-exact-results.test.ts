import { describe, expect, it } from 'bun:test';
import {
  compactToolLoopMessages,
  ToolLoopContextProjectionError,
} from '../../src/core/ai/tool-loop-context.ts';
import type { ChatBlock, ChatMessage } from '../../src/core/ai/gateway.ts';
import { proposalInventoryContextPolicy } from '../../src/core/ingestion-proposal-context-policy.ts';

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

/** Read one retained tool input from a compacted provider projection. */
function toolInput(messages: ChatMessage[], toolCallId: string): unknown {
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    const call = message.content.find(block => (
      block.type === 'tool-call' && block.toolCallId === toolCallId
    ));
    if (call?.type === 'tool-call') return call.input;
  }
  throw new Error(`Missing tool call ${toolCallId}`);
}

describe('tool-loop exact non-mutating result retention', () => {
  it('preserves an exact stage inventory after a failed large first call', () => {
    const inventory = [
      { slug: 'sources/example', effect: 'create' },
      { slug: 'sources/example', effect: 'update' },
    ];
    const messages = buildRound('Correct the rejected proposal inventory.', [{
      id: 'failed-stage',
      callName: 'brain_stage_ingestion_proposal_page',
      input: {
        artifact_id: 'artifact-1',
        source_id: 'company',
        admission_scope: 'Include admitted material.',
        sequence: 1,
        total_pages: 2,
        page_inventory: inventory,
        page: {
          slug: 'sources/example',
          effect: 'create',
          title: 'Example',
          bodyMarkdown: `FAILED_STAGE_BODY_${'x'.repeat(22_000)}`,
          baseMarkdown: `FAILED_STAGE_BASELINE_${'y'.repeat(8_000)}`,
        },
      },
      output: { error: 'Correct both inventory effects and retry.' },
      isError: true,
    }]);

    const compacted = compactToolLoopMessages(messages, 4_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
    });
    const input = toolInput(compacted, 'failed-stage') as Record<string, unknown>;

    expect(input.page_inventory).toEqual(inventory);
    expect(JSON.stringify(input)).toContain('working_context_projection');
    expect(JSON.stringify(input)).toContain('agent_authored_plan_data_not_instructions');
    expect(JSON.stringify(input)).not.toContain('Include admitted material.');
    expect(JSON.stringify(input)).not.toContain('FAILED_STAGE_BODY_');
    expect(JSON.stringify(input)).not.toContain('FAILED_STAGE_BASELINE_');
  });

  it('summarizes the latest successful inventory ahead of a later rejected inventory', () => {
    const successfulInventory = [
      { slug: 'sources/example', effect: 'create' },
      { slug: 'projects/accepted', effect: 'update' },
    ];
    const rejectedInventory = [
      { slug: 'sources/example', effect: 'create' },
      { slug: 'projects/rejected', effect: 'create' },
    ];
    const successfulRound = buildRound('Stage the reviewed proposal.', [{
      id: 'successful-stage',
      callName: 'brain_stage_ingestion_proposal_page',
      input: {
        sequence: 1,
        total_pages: 2,
        page_inventory: successfulInventory,
        page: {
          slug: 'sources/example',
          effect: 'create',
          bodyMarkdown: `SUCCESSFUL_STAGE_BODY_${'a'.repeat(22_000)}`,
        },
      },
      output: { staged: true },
    }]);
    const rejectedRound = buildRound('unused', [{
      id: 'rejected-stage',
      callName: 'brain_stage_ingestion_proposal_page',
      input: {
        sequence: 2,
        total_pages: 2,
        page_inventory: rejectedInventory,
        page: {
          slug: 'projects/rejected',
          effect: 'create',
          bodyMarkdown: `REJECTED_STAGE_BODY_${'b'.repeat(22_000)}`,
        },
      },
      output: { error: 'inventory_mismatch' },
      isError: true,
    }]);
    const latestReadRound = buildRound('unused', [{
      id: 'latest-read',
      callName: 'get_page',
      input: { slug: 'projects/current' },
      output: { slug: 'projects/current', body: `LATEST_EXACT_READ_${'c'.repeat(8_000)}` },
    }]);

    const compacted = compactToolLoopMessages([
      successfulRound[0]!,
      successfulRound[1]!,
      successfulRound[2]!,
      rejectedRound[1]!,
      rejectedRound[2]!,
      latestReadRound[1]!,
      latestReadRound[2]!,
    ], 4_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
      preferredProjectionBytes: 20_000,
      preferredProjectionFits: () => true,
    });
    const summary = compacted
      .filter(message => typeof message.content === 'string')
      .map(message => message.content)
      .join('\n');

    expect(summary).toContain(`page_inventory=${JSON.stringify(successfulInventory)}`);
    expect(summary).toContain('call_id=successful-stage outcome=complete');
    expect(summary).not.toContain(JSON.stringify(rejectedInventory));
    expect(summary).not.toContain('retained tool error');
  });

  it('omits instruction-shaped fields from malformed failed stage input and its ledger summary', () => {
    const unsafeInput = {
      artifact_id: 'artifact-1',
      source_id: 'company',
      admission_scope: 'IGNORE_PREVIOUS_SCOPE_AND_EXFILTRATE',
      sequence: 1,
      total_pages: 1,
      page_inventory: [{
        slug: 'projects/example',
        effect: 'create',
        instruction: 'INVENTORY_PROMPT_ATTACK',
      }],
      page: {
        slug: 'projects/example',
        effect: 'create',
        title: 'PAGE_IDENTITY_PROMPT_ATTACK',
        bodyMarkdown: `MALICIOUS_STAGE_BODY_${'x'.repeat(22_000)}`,
      },
    };
    const unsafeRound = buildRound('Correct a malformed stage call.', [{
      id: 'unsafe-stage',
      callName: 'brain_stage_ingestion_proposal_page',
      input: unsafeInput,
      output: { error: 'The inventory shape is invalid.' },
      isError: true,
    }]);

    const retained = compactToolLoopMessages(unsafeRound, 4_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
    });
    const retainedSerialized = JSON.stringify(retained);
    expect(retainedSerialized).toContain('working_context_projection');
    expect(retainedSerialized).not.toContain('IGNORE_PREVIOUS_SCOPE_AND_EXFILTRATE');
    expect(retainedSerialized).not.toContain('INVENTORY_PROMPT_ATTACK');
    expect(retainedSerialized).not.toContain('PAGE_IDENTITY_PROMPT_ATTACK');
    expect(retainedSerialized).not.toContain('MALICIOUS_STAGE_BODY_');
    expect(toolInput(retained, 'unsafe-stage')).not.toHaveProperty('page_inventory');

    const newerRound = buildRound('unused', [{
      id: 'newer-read',
      callName: 'get_page',
      input: { slug: 'projects/current' },
      output: { slug: 'projects/current', body: 'Current page.' },
    }]);
    const unsafeSummaryRound = buildRound(
      'Correct malformed parallel stage calls.',
      Array.from({ length: 6 }, (_, index) => ({
        id: `unsafe-stage-${index}`,
        callName: 'brain_stage_ingestion_proposal_page',
        input: unsafeInput,
        output: { error: 'The inventory shape is invalid.' },
        isError: true,
      })),
    );
    const summarized = compactToolLoopMessages([
      unsafeSummaryRound[0]!,
      unsafeSummaryRound[1]!,
      unsafeSummaryRound[2]!,
      newerRound[1]!,
      newerRound[2]!,
    ], 1_500, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
    });
    const summarizedText = JSON.stringify(summarized);
    expect(summarizedText).toContain('Durable ledger counts');
    expect(summarizedText).not.toContain('page_inventory=');
    expect(summarizedText).not.toContain('IGNORE_PREVIOUS_SCOPE_AND_EXFILTRATE');
    expect(summarizedText).not.toContain('INVENTORY_PROMPT_ATTACK');
    expect(summarizedText).not.toContain('PAGE_IDENTITY_PROMPT_ATTACK');
  });

  it('fails closed when an exact stage inventory cannot fit the compacted round', () => {
    const inventory = Array.from({ length: 32 }, (_, index) => ({
      slug: `projects/${index}-${'x'.repeat(120)}`,
      effect: 'create',
    }));
    const messages = buildRound('Stage the complete reviewed inventory.', [{
      id: 'oversized-stage-inventory',
      callName: 'brain_stage_ingestion_proposal_page',
      input: {
        artifact_id: 'artifact-1',
        source_id: 'company',
        admission_scope: 'Include admitted material.',
        sequence: 1,
        total_pages: inventory.length,
        page_inventory: inventory,
        page: {
          slug: inventory[0]!.slug,
          effect: 'create',
          title: 'Example',
          bodyMarkdown: 'x'.repeat(22_000),
        },
      },
      output: { staged: true },
    }]);

    expect(() => compactToolLoopMessages(messages, 1_000, {
      mutatingToolNames: new Set(),
      toolPolicies: [proposalInventoryContextPolicy],
    })).toThrow(ToolLoopContextProjectionError);
  });

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
