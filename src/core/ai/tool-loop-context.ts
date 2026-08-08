/**
 * Provider-facing context bounding for the gateway tool loop.
 *
 * The durable transcript remains the crash-replay source of truth. This module
 * only projects a bounded prompt: it keeps task intent, retains recent balanced
 * tool-call/result pairs, and replaces older raw payloads with deterministic
 * execution evidence. No durable tool evidence is deleted or rewritten.
 */

import { createHash } from 'node:crypto';
import { get_encoding } from '@dqbd/tiktoken';
import { getProviderCapabilities } from './capabilities.ts';
import { splitProviderModelId } from '../model-id.ts';
import type { ChatBlock, ChatMessage, ChatToolDef } from './gateway.ts';

const CONTEXT_TARGET_FRACTION = 0.7;
const ESTIMATED_CHARS_PER_TOKEN = 2;
// Byte-level provider tokenizers cannot emit more tokens than UTF-8 bytes.
// One byte per token is intentionally conservative for ASCII, CJK, emoji,
// and mixed JSON without requiring a model-specific tokenizer at runtime.
const CONSERVATIVE_BYTES_PER_TOKEN = 1;
// The tokenizer counts static content exactly, but provider message/tool
// envelopes are not exposed by the API. Keep a fixed hard-window reserve for
// that framing rather than treating content tokenization as wire-exact.
const OPENAI_PROTOCOL_TOKEN_RESERVE = 1_024;
const FALLBACK_CONTEXT_TOKENS = 128_000;
const PAYLOAD_LIMITS = [12_000, 4_000, 1_000, 256, 64, 0] as const;
const MAX_STRUCTURAL_IDENTITY_VALUE_BYTES = 256;
const STRUCTURAL_IDENTITY_KEYS = [
  'slug',
  'page_slug',
  'page_id',
  'id',
  'source_id',
  'source',
  'from',
  'to',
  'from_slug',
  'to_slug',
  'old_slug',
  'new_slug',
  'page',
  'path',
  'ref',
  'date',
  'expected_content_hash',
  'link_type',
] as const;

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

interface WorkingContextProjectionSource {
  kind: 'tool_input' | 'tool_result';
  toolName: string;
  preserveStructuralIdentity: boolean;
}

let openAiEncoding: ReturnType<typeof get_encoding> | undefined;

function countOpenAiTokens(value: string): number {
  openAiEncoding ??= get_encoding('o200k_base');
  return openAiEncoding.encode(value).length;
}

function isOpenAiModel(model: string): boolean {
  return splitProviderModelId(model).provider?.toLowerCase() === 'openai';
}

export interface ToolLoopContextOptions {
  /** Tools whose effects must retain a distinct identity whenever context compacts. */
  mutatingToolNames?: ReadonlySet<string>;
}

/** Raised when no valid, evidence-preserving provider projection can fit. */
export class ToolLoopContextProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolLoopContextProjectionError';
  }
}

/** Resolve a conservative UTF-8 byte budget inside the model window. */
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
  const staticTools = safeJson(args.tools);
  const targetMessageTokens = Math.max(0, targetTokens - args.maxOutputTokens);
  const openAiStaticTokens = isOpenAiModel(args.model)
    ? countOpenAiTokens(args.system ?? '') + countOpenAiTokens(staticTools)
    : null;
  const targetBudget = openAiStaticTokens === null
    ? targetMessageTokens * ESTIMATED_CHARS_PER_TOKEN
      - (args.system?.length ?? 0)
      - staticTools.length
    : Math.max(0, targetMessageTokens - openAiStaticTokens)
      * ESTIMATED_CHARS_PER_TOKEN;

  // The historical two-character estimate keeps ordinary prompts near the
  // 70% target. A second absolute byte cap uses the model's whole declared
  // window, so dense Unicode cannot overflow while ordinary English is not
  // needlessly constrained to one byte per target token.
  const hardInputTokens = Math.max(0, contextTokens - args.maxOutputTokens);
  const byteSafeBudget = openAiStaticTokens === null
    ? hardInputTokens * CONSERVATIVE_BYTES_PER_TOKEN
      - utf8Bytes(args.system ?? '')
      - utf8Bytes(staticTools)
    : Math.max(
      0,
      hardInputTokens - openAiStaticTokens - OPENAI_PROTOCOL_TOKEN_RESERVE,
    ) * CONSERVATIVE_BYTES_PER_TOKEN;
  return Math.max(0, Math.min(targetBudget, byteSafeBudget));
}

/**
 * Return a bounded provider prompt without mutating the full replay transcript.
 * Balanced tool rounds are atomic: either both sides remain, or neither does.
 */
export function compactToolLoopMessages(
  messages: ChatMessage[],
  maxBytes: number,
  options: ToolLoopContextOptions = {},
): ChatMessage[] {
  if (jsonBytes(messages) <= maxBytes) return messages;

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
    const available = maxBytes - jsonBytes(base) - 32;
    const compacted = compactRoundToFit(rounds[i]!, available, options);
    if (!compacted) break;
    retained.unshift(compacted);
    retainedStart = i;
  }

  let summary = buildLedgerSummary(rounds.slice(0, retainedStart), otherCount, options);
  let projection = [task, ...(summary ? [summary] : []), ...flattenRounds(retained)];

  // JSON array delimiters can add a few bytes beyond individually-sized
  // elements. Drop the oldest raw round to its evidence record if necessary.
  while (jsonBytes(projection) > maxBytes && retained.length > 1) {
    retained.shift();
    retainedStart++;
    summary = buildLedgerSummary(rounds.slice(0, retainedStart), otherCount, options);
    projection = [task, ...(summary ? [summary] : []), ...flattenRounds(retained)];
  }

  if (rounds.length > 0 && retained.length === 0) {
    throw new ToolLoopContextProjectionError(
      `The latest balanced tool round cannot fit safely within the ${maxBytes}-byte context window budget.`,
    );
  }
  if (jsonBytes(projection) > maxBytes) {
    throw new ToolLoopContextProjectionError(
      `Required task and durable mutation evidence exceed the ${maxBytes}-byte context window budget.`,
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
function compactRoundToFit(
  round: ToolRound,
  availableBytes: number,
  options: ToolLoopContextOptions,
): ToolRound | null {
  if (availableBytes <= 0) return null;
  for (const perPayload of PAYLOAD_LIMITS) {
    const compacted = compactRound(round, perPayload, options);
    if (jsonBytes([compacted.assistant, compacted.result]) <= availableBytes) return compacted;
  }
  return null;
}

/** Bound historical tool inputs/results while keeping provider call IDs paired. */
function compactRound(
  round: ToolRound,
  perPayloadBytes: number,
  options: ToolLoopContextOptions,
): ToolRound {
  return {
    ...round,
    assistant: {
      ...round.assistant,
      content: mapBlocks(round.assistant, block => {
        if (block.type === 'text') return { ...block, text: boundText(block.text, perPayloadBytes) };
        if (block.type !== 'tool-call') return block;
        return {
          ...block,
          input: boundValue(block.input, perPayloadBytes, {
            kind: 'tool_input',
            toolName: block.toolName,
            preserveStructuralIdentity: isMutationSensitive(
              block.toolName,
              options.mutatingToolNames,
            ),
          }),
        };
      }),
    },
    result: {
      ...round.result,
      content: mapBlocks(round.result, block => {
        if (block.type !== 'tool-result') return block;
        return {
          ...block,
          output: boundValue(block.output, perPayloadBytes, {
            kind: 'tool_result',
            toolName: block.toolName,
            preserveStructuralIdentity: false,
          }),
        };
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
    `- ${boundIdentifier(evidence.toolName, 80)}`,
    `call_id=${boundIdentifier(evidence.toolCallId, 96)}`,
    `outcome=${evidence.failed ? 'failed' : 'complete'}`,
    `input_sha256=${fingerprint}`,
    target ? `target=${target}` : '',
  ].filter(Boolean).join(' ');
}

/** Pick a bounded human-legible operation target without retaining whole input. */
function mutationTarget(input: unknown): string | null {
  const identity = extractStructuralIdentity(input);
  const first = identity ? Object.entries(identity)[0] : undefined;
  return first ? `${first[0]}:${boundIdentifier(String(first[1]), 160)}` : null;
}

/** Bound trusted identifiers without retaining a source-looking fragment. */
function boundIdentifier(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
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

function boundValue(
  value: unknown,
  maxBytes: number,
  source: WorkingContextProjectionSource,
): unknown {
  const serialized = safeJson(value);
  if (utf8Bytes(serialized) <= maxBytes) return value;

  // Full projections carry enough identity to verify or re-read the exact
  // durable value without presenting any fragment as source content.
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const structuralIdentity = source.preserveStructuralIdentity
    ? extractStructuralIdentity(value)
    : undefined;
  const full = {
    working_context_projection: {
      schema: 'gbrain.working_context_projection.v1',
      kind: source.kind,
      tool_name: source.toolName,
      original_json_utf8_bytes: originalBytes,
      sha256,
      ...(structuralIdentity ? { structural_identity: structuralIdentity } : {}),
      interpretation: 'projection_metadata_not_source_content',
      re_read_guidance: source.kind === 'tool_result'
        ? `Re-run ${source.toolName} with focused input if exact content is needed.`
        : `Do not reconstruct the exact ${source.toolName} input from this projection; consult durable execution evidence.`,
    },
  };
  if (jsonBytes(full) <= maxBytes) return full;

  // Preserve the checkable identity under tighter budgets. The smallest
  // tier remains unmistakable metadata while letting atomic rounds fit.
  const compact = {
    working_context_projection: {
      original_json_utf8_bytes: originalBytes,
      sha256,
      ...(structuralIdentity ? { structural_identity: structuralIdentity } : {}),
    },
  };
  if (jsonBytes(compact) <= maxBytes) return compact;

  // A retained mutation round must never shed the only human-legible target.
  // Returning the identity-only envelope even when it exceeds this tier makes
  // compactRoundToFit try the remaining tiers and ultimately fail closed if
  // the complete balanced round cannot preserve it.
  if (structuralIdentity) {
    return { working_context_projection: { structural_identity: structuralIdentity } };
  }
  return { working_context_projection: true };
}

/** Keep compacted narrative unmistakable without retaining arbitrary prose. */
function boundText(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const full = '\n[gbrain working-context projection: exact text retained in durable execution ledger]\n';
  if (utf8Bytes(full) <= maxBytes) return full;
  const compact = '[gbrain working-context projection]';
  return utf8Bytes(compact) <= maxBytes ? compact : '';
}

/** Extract short operation identifiers, never body, summary, or evidence prose. */
function extractStructuralIdentity(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity: Record<string, string | number | boolean> = {};
  for (const key of STRUCTURAL_IDENTITY_KEYS) {
    const candidate = record[key];
    if (
      (typeof candidate === 'string' && utf8Bytes(candidate) <= MAX_STRUCTURAL_IDENTITY_VALUE_BYTES)
      || (typeof candidate === 'number' && Number.isFinite(candidate))
      || typeof candidate === 'boolean'
    ) {
      identity[key] = candidate;
    }
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(safeJson(value));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? String(value);
  } catch {
    return String(value);
  }
}
