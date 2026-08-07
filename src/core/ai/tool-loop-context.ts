/**
 * Provider-facing context bounding for the gateway tool loop.
 *
 * The durable transcript remains the crash-replay source of truth. This module
 * only projects a bounded prompt: it keeps task intent, retains recent balanced
 * tool-call/result pairs, and replaces older raw payloads with deterministic
 * execution evidence. No durable tool evidence is deleted or rewritten.
 */

import { createHash } from 'node:crypto';
import { getProviderCapabilities } from './capabilities.ts';
import type { ChatBlock, ChatMessage, ChatToolDef } from './gateway.ts';

const CONTEXT_TARGET_FRACTION = 0.7;
const ESTIMATED_CHARS_PER_TOKEN = 2;
const FALLBACK_CONTEXT_TOKENS = 128_000;
const MIN_MESSAGE_BUDGET_CHARS = 2_000;
const PAYLOAD_LIMITS = [12_000, 4_000, 1_000, 256, 64, 0] as const;

interface ToolEvidence {
  toolCallId: string;
  toolName: string;
  input: unknown;
  failed: boolean;
}

interface ToolRound {
  assistant: ChatMessage;
  result: ChatMessage;
  evidence: ToolEvidence[];
}

export interface ToolLoopContextOptions {
  /** Tools whose effects must retain a distinct identity when raw rounds drop. */
  mutatingToolNames?: ReadonlySet<string>;
}

/** Raised when no valid, evidence-preserving provider projection can fit. */
export class ToolLoopContextProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolLoopContextProjectionError';
  }
}

/** Resolve a conservative message-character budget inside the model window. */
export function resolveToolLoopMessageBudget(args: {
  model: string;
  maxOutputTokens: number;
  system?: string;
  tools: ChatToolDef[];
  contextWindowTokens?: number;
}): number {
  let contextTokens = args.contextWindowTokens;
  if (contextTokens === undefined) {
    try {
      contextTokens = getProviderCapabilities(args.model).maxContext;
    } catch {
      contextTokens = FALLBACK_CONTEXT_TOKENS;
    }
  }

  const targetTokens = Math.floor(contextTokens * CONTEXT_TARGET_FRACTION);
  const messageTokens = Math.max(0, targetTokens - args.maxOutputTokens);
  const staticChars = (args.system?.length ?? 0) + jsonLength(args.tools);
  return Math.max(
    MIN_MESSAGE_BUDGET_CHARS,
    messageTokens * ESTIMATED_CHARS_PER_TOKEN - staticChars,
  );
}

/**
 * Return a bounded provider prompt without mutating the full replay transcript.
 * Balanced tool rounds are atomic: either both sides remain, or neither does.
 */
export function compactToolLoopMessages(
  messages: ChatMessage[],
  maxChars: number,
  options: ToolLoopContextOptions = {},
): ChatMessage[] {
  if (jsonLength(messages) <= maxChars) return messages;

  const { rounds, otherCount } = collectToolRounds(messages);
  const task = buildTaskAnchor(messages);
  const retained: ToolRound[] = [];
  let retainedStart = rounds.length;

  // Grow a suffix of newest atomic rounds. The summary shrinks as a round
  // becomes raw context, so each candidate is measured against its exact
  // evidence-preserving projection rather than a fixed reserve estimate.
  for (let i = rounds.length - 1; i >= 0; i--) {
    const summary = buildLedgerSummary(rounds.slice(0, i), otherCount, options);
    const base = [task, ...(summary ? [summary] : []), ...flattenRounds(retained)];
    const available = maxChars - jsonLength(base) - 32;
    const compacted = compactRoundToFit(rounds[i]!, available);
    if (!compacted) break;
    retained.unshift(compacted);
    retainedStart = i;
  }

  let summary = buildLedgerSummary(rounds.slice(0, retainedStart), otherCount, options);
  let projection = [task, ...(summary ? [summary] : []), ...flattenRounds(retained)];

  // JSON array delimiters can add a few bytes beyond individually-sized
  // elements. Drop the oldest raw round to its evidence record if necessary.
  while (jsonLength(projection) > maxChars && retained.length > 1) {
    retained.shift();
    retainedStart++;
    summary = buildLedgerSummary(rounds.slice(0, retainedStart), otherCount, options);
    projection = [task, ...(summary ? [summary] : []), ...flattenRounds(retained)];
  }

  if (rounds.length > 0 && retained.length === 0) {
    throw new ToolLoopContextProjectionError(
      `The latest balanced tool round cannot fit safely within the ${maxChars}-character context window budget.`,
    );
  }
  if (jsonLength(projection) > maxChars) {
    throw new ToolLoopContextProjectionError(
      `Required task and durable mutation evidence exceed the ${maxChars}-character context window budget.`,
    );
  }
  return projection;
}

/** Collect only complete adjacent assistant/tool-result pairs. */
function collectToolRounds(messages: ChatMessage[]): { rounds: ToolRound[]; otherCount: number } {
  const rounds: ToolRound[] = [];
  let otherCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const assistant = messages[i]!;
    const calls = toolCallBlocks(assistant);
    if (assistant.role !== 'assistant' || calls.length === 0) {
      if (!isTaskMessage(assistant)) otherCount++;
      continue;
    }

    const result = messages[i + 1];
    const results = result ? toolResultBlocks(result) : [];
    const resultsById = new Map(results.map(block => [block.toolCallId, block]));
    if (!result || calls.some(call => !resultsById.has(call.toolCallId))) {
      otherCount++;
      continue;
    }

    rounds.push({
      assistant,
      result,
      evidence: calls.map(call => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        failed: resultsById.get(call.toolCallId)?.isError === true,
      })),
    });
    i++;
  }
  return { rounds, otherCount };
}

/** Preserve the complete original task and any later user correction. */
function buildTaskAnchor(messages: ChatMessage[]): ChatMessage {
  const taskTexts = messages.filter(isTaskMessage).map(messageText).filter(Boolean);
  if (taskTexts.length === 0) {
    return { role: 'user', content: 'Continue the assigned task from the retained durable tool evidence.' };
  }
  const first = taskTexts[0]!;
  const latest = taskTexts[taskTexts.length - 1]!;
  const combined = first === latest
    ? first
    : `Original task:\n${first}\n\nLatest user direction:\n${latest}`;
  return { role: 'user', content: combined };
}

/** Find the largest payload representation whose complete round fits. */
function compactRoundToFit(round: ToolRound, availableChars: number): ToolRound | null {
  if (availableChars <= 0) return null;
  for (const perPayload of PAYLOAD_LIMITS) {
    const compacted = compactRound(round, perPayload);
    if (jsonLength([compacted.assistant, compacted.result]) <= availableChars) return compacted;
  }
  return null;
}

/** Bound historical tool inputs/results while keeping provider call IDs paired. */
function compactRound(round: ToolRound, perPayload: number): ToolRound {
  return {
    ...round,
    assistant: {
      ...round.assistant,
      content: mapBlocks(round.assistant, block => {
        if (block.type === 'text') return { ...block, text: boundMiddle(block.text, perPayload) };
        if (block.type !== 'tool-call') return block;
        return { ...block, input: boundValue(block.input, perPayload) };
      }),
    },
    result: {
      ...round.result,
      content: mapBlocks(round.result, block => {
        if (block.type !== 'tool-result') return block;
        return { ...block, output: boundValue(block.output, perPayload) };
      }),
    },
  };
}

/** Summarize omitted rounds without losing distinct mutation outcomes. */
function buildLedgerSummary(
  dropped: ToolRound[],
  otherCount: number,
  options: ToolLoopContextOptions,
): ChatMessage | null {
  if (dropped.length === 0 && otherCount === 0) return null;
  const counts = new Map<string, { ok: number; failed: number }>();
  const mutationEvidence: string[] = [];

  for (const evidence of dropped.flatMap(round => round.evidence)) {
    const count = counts.get(evidence.toolName) ?? { ok: 0, failed: 0 };
    if (evidence.failed) count.failed++;
    else count.ok++;
    counts.set(evidence.toolName, count);

    if (isMutationSensitive(evidence.toolName, options.mutatingToolNames)) {
      mutationEvidence.push(formatMutationEvidence(evidence));
    }
  }

  const details = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}: ${count.ok} complete, ${count.failed} failed`)
    .join('; ');
  const text = [
    `[Context compacted: ${dropped.length} earlier balanced tool round(s) omitted from this provider request${otherCount ? `; ${otherCount} other historical message(s) omitted` : ''}.]`,
    details ? `Durable ledger counts: ${details}.` : '',
    mutationEvidence.length > 0 ? `Distinct mutation evidence:\n${mutationEvidence.join('\n')}` : '',
    'The complete transcript and tool outputs remain in the durable execution ledger. Do not repeat entries marked outcome=complete. Entries marked outcome=failed are unverified; read back or otherwise reassess their effect before deciding whether a corrected retry is safe.',
  ].filter(Boolean).join('\n');
  return { role: 'user', content: text };
}

/** Render enough bounded identity to distinguish prior mutations safely. */
function formatMutationEvidence(evidence: ToolEvidence): string {
  const serialized = safeJson(evidence.input);
  const fingerprint = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  const target = mutationTarget(evidence.input);
  return [
    `- ${boundMiddle(evidence.toolName, 80)}`,
    `call_id=${boundMiddle(evidence.toolCallId, 96)}`,
    `outcome=${evidence.failed ? 'failed' : 'complete'}`,
    `input_sha256=${fingerprint}`,
    target ? `target=${target}` : '',
  ].filter(Boolean).join(' ');
}

/** Pick a bounded human-legible operation target without retaining whole input. */
function mutationTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['slug', 'page_slug', 'path', 'id', 'entity', 'title', 'name']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      return `${key}:${boundMiddle(String(value), 160)}`;
    }
  }
  return null;
}

function isMutationSensitive(name: string, names: ReadonlySet<string> | undefined): boolean {
  return names === undefined || names.has(name);
}

function flattenRounds(rounds: ToolRound[]): ChatMessage[] {
  return rounds.flatMap(round => [round.assistant, round.result]);
}

function isTaskMessage(message: ChatMessage): boolean {
  return message.role === 'user' && toolResultBlocks(message).length === 0 && messageText(message).trim() !== '';
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function toolCallBlocks(message: ChatMessage): Array<Extract<ChatBlock, { type: 'tool-call' }>> {
  if (typeof message.content === 'string') return [];
  return message.content.filter(
    (block): block is Extract<ChatBlock, { type: 'tool-call' }> => block.type === 'tool-call',
  );
}

function toolResultBlocks(message: ChatMessage): Array<Extract<ChatBlock, { type: 'tool-result' }>> {
  if (typeof message.content === 'string') return [];
  return message.content.filter(
    (block): block is Extract<ChatBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  );
}

function mapBlocks(message: ChatMessage, fn: (block: ChatBlock) => ChatBlock): ChatMessage['content'] {
  return typeof message.content === 'string' ? message.content : message.content.map(fn);
}

function boundValue(value: unknown, maxChars: number): unknown {
  const serialized = safeJson(value);
  if (serialized.length <= maxChars) return value;
  return {
    _gbrain_context_compacted: true,
    original_chars: serialized.length,
    ...(maxChars >= 64 ? { preview: boundMiddle(serialized, Math.max(16, maxChars - 80)) } : {}),
  };
}

function boundMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  const marker = '\n... [middle omitted] ...\n';
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

function jsonLength(value: unknown): number {
  return safeJson(value).length;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}
