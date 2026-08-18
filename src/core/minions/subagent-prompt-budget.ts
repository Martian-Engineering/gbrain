import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { resolveModel, TIER_DEFAULTS } from '../model-config.ts';
import {
  toModelMessages,
  type ChatMessage,
  type ChatToolDef,
} from '../ai/gateway.ts';
import {
  openAiToolLoopRequestFits,
  resolveToolLoopMessageBudgets,
} from '../ai/tool-loop-context.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { buildBrainTools, filterAllowedTools } from './tools/brain-allowlist.ts';
import { resolveSubagentMaxOutputTokens } from './subagent-limits.ts';

const FUTURE_JOB_ID = Number.MAX_SAFE_INTEGER;

export interface SubagentInitialPromptBudgetArgs {
  engine: BrainEngine;
  config: GBrainConfig;
  prompt: string;
  userSystem?: string;
  model?: string;
  maxOutputTokens?: number;
  allowedTools: string[];
  allowedSlugPrefixes: string[];
  sourceId?: string;
}

export interface SubagentInitialPromptBudget {
  model: string;
  maxOutputTokens: number;
  messageBytes: number;
  messageBudgetBytes: number;
  requestFits: boolean;
}

/** Resolve the provider-aware admission boundary for a fresh Minion job. */
export async function resolveSubagentInitialPromptBudget(
  args: SubagentInitialPromptBudgetArgs,
): Promise<SubagentInitialPromptBudget> {
  const model = args.model ?? await resolveModel(args.engine, {
    tier: 'subagent',
    configKey: 'models.subagent',
    fallback: TIER_DEFAULTS.subagent,
  });
  const maxOutputTokens = resolveSubagentMaxOutputTokens(
    args.maxOutputTokens,
    await args.engine.getConfig('agent.max_output_tokens').catch(() => null),
  );
  const registry = buildBrainTools({
    // A fresh job has no id yet. The widest safe integer is a conservative
    // stand-in for the only schema text whose bytes depend on that future id.
    subagentId: FUTURE_JOB_ID,
    engine: args.engine,
    config: args.config,
    allowedSlugPrefixes: args.allowedSlugPrefixes,
    sourceId: args.sourceId,
  });
  const toolDefs = args.allowedTools.length > 0
    ? filterAllowedTools(registry, args.allowedTools)
    : registry;
  const system = buildSystemPrompt(toolDefs, args.userSystem);
  const tools: ChatToolDef[] = toolDefs.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Record<string, unknown>,
  }));
  const message: ChatMessage[] = [{ role: 'user', content: args.prompt }];
  const budgets = resolveToolLoopMessageBudgets({
    model,
    maxOutputTokens,
    system,
    tools,
  });
  const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  let requestFits = messageBytes <= budgets.byteSafeBytes;

  // OpenAI models have an exact tokenizer available. Admit the complete
  // provider request when it fits the same target used by the running tool
  // loop; if tokenization ever fails, retain the byte-safe fallback above.
  if (budgets.openAiTokenLimits) {
    try {
      requestFits = openAiToolLoopRequestFits({
        budgets,
        system,
        tools,
        modelMessages: toModelMessages(message),
      });
    } catch {
      // The independently safe byte result remains authoritative.
    }
  }

  return {
    model,
    maxOutputTokens,
    messageBytes,
    messageBudgetBytes: budgets.byteSafeBytes,
    requestFits,
  };
}
