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
const STAGE_PROPOSAL_TOOL_NAME = 'brain_stage_ingestion_proposal_page';
const STAGE_PROPOSAL_PROJECTION_SCHEMA = 'gbrain.stage_proposal_context_projection.v1';
const STAGE_SLUG_CHARS = 'a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af';
const STAGE_SLUG_SEGMENT = `[${STAGE_SLUG_CHARS}][${STAGE_SLUG_CHARS}-]*`;
const STAGE_SLUG_RE = new RegExp(`^${STAGE_SLUG_SEGMENT}(\\/${STAGE_SLUG_SEGMENT})*$`);
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

interface ScoredToolRound {
  round: ToolRound;
  exactResultCount: number;
  exactResultBytes: number;
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
  /**
   * Larger candidate ceiling for providers with an exact request-token check.
   * This is never an acceptance boundary by itself.
   */
  preferredProjectionBytes?: number;
  /** Provider-owned proof that the complete preferred request fits safely. */
  preferredProjectionFits?: (candidate: ChatMessage[]) => boolean;
}

/** Provider-specific limits used to construct and verify tool-loop projections. */
export interface ToolLoopMessageBudgets {
  /** Worst-case UTF-8 limit that is safe even at one token per byte. */
  byteSafeBytes: number;
  /** Candidate ceiling whose result still requires exact provider validation. */
  preferredProjectionBytes: number;
  /** OpenAI total-token limits used to verify a transformed provider request. */
  openAiTokenLimits: {
    targetTotalTokens: number;
    hardTotalTokens: number;
    maxOutputTokens: number;
  } | null;
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
  return resolveToolLoopMessageBudgets(args).byteSafeBytes;
}

/** Resolve preferred and worst-case-safe provider message budgets. */
export function resolveToolLoopMessageBudgets(args: {
  model: string;
  maxOutputTokens: number;
  system?: string;
  tools: ChatToolDef[];
  contextWindowTokens?: number;
}): ToolLoopMessageBudgets {
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
  return {
    byteSafeBytes: Math.max(0, Math.min(targetBudget, byteSafeBudget)),
    preferredProjectionBytes: openAiStaticTokens === null
      ? Math.max(0, Math.min(targetBudget, byteSafeBudget))
      : Math.max(0, targetBudget),
    openAiTokenLimits: openAiStaticTokens === null
      ? null
      : {
        targetTotalTokens: targetTokens,
        hardTotalTokens: contextTokens,
        maxOutputTokens: args.maxOutputTokens,
      },
  };
}

/** Verify the complete transformed OpenAI request against both token limits. */
export function openAiToolLoopRequestFits(args: {
  budgets: ToolLoopMessageBudgets,
  system?: string;
  tools: ChatToolDef[];
  modelMessages: unknown[];
}): boolean {
  const limits = args.budgets.openAiTokenLimits;
  if (!limits) return false;
  // Count the provider-facing message shape, not gbrain's durable ChatMessage
  // shape. The enclosing object includes the request's JSON keys and
  // separators; the fixed reserve covers SDK/provider framing not represented
  // here.
  const requestTokens = countOpenAiTokens(safeJson({
    system: args.system ?? '',
    tools: args.tools,
    messages: args.modelMessages,
  }))
    + OPENAI_PROTOCOL_TOKEN_RESERVE
    + limits.maxOutputTokens;
  return requestTokens <= limits.targetTotalTokens
    && requestTokens <= limits.hardTotalTokens;
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
  const fallback = compactToolLoopMessagesToByteBudget(messages, maxBytes, options);
  if (fallback === messages) return fallback;
  const preferredBytes = options.preferredProjectionBytes;
  if (
    preferredBytes === undefined
    || preferredBytes <= maxBytes
    || !options.preferredProjectionFits
  ) return fallback;

  try {
    return buildPreferredNewestSingletonProjection(
      messages,
      preferredBytes,
      options,
      options.preferredProjectionFits,
    ) ?? fallback;
  } catch {
    // Exact provider tokenization is optional. Any failure retains the
    // independently valid worst-case byte projection.
    return fallback;
  }
}

/**
 * Build a minimal preferred projection around the newest singleton read.
 * Older rounds become durable ledger evidence instead of consuming headroom.
 */
function buildPreferredNewestSingletonProjection(
  messages: ChatMessage[],
  preferredBytes: number,
  options: ToolLoopContextOptions,
  fits: (candidate: ChatMessage[]) => boolean,
): ChatMessage[] | null {
  const { rounds, otherCount } = collectToolRounds(messages);
  const originalRound = rounds.at(-1);
  if (!originalRound || originalRound.evidence.length !== 1) return null;

  const evidence = originalRound.evidence[0]!;
  if (
    evidence.failed
    || isMutationSensitive(evidence.toolName, options.mutatingToolNames)
  ) return null;

  const originalResult = toolResultBlocks(originalRound.result).find(block => (
    block.toolCallId === evidence.toolCallId
  ));
  if (!originalResult || originalResult.toolName !== evidence.toolName) return null;

  const task = buildTaskAnchor(messages);
  const summary = buildLedgerSummary(rounds.slice(0, -1), otherCount, options);
  for (const perPayload of PAYLOAD_LIMITS) {
    const compacted = compactRound(originalRound, perPayload, options);
    const exactResult: ChatMessage = {
      ...compacted.result,
      content: mapBlocks(compacted.result, block => (
        block.type === 'tool-result' && block.toolCallId === evidence.toolCallId
          ? { ...block, output: originalResult.output }
          : block
      )),
    };
    const preferred = [
      task,
      ...(summary ? [summary] : []),
      compacted.assistant,
      exactResult,
    ];
    if (jsonBytes(preferred) <= preferredBytes && fits(preferred)) return preferred;
  }
  return null;
}

/** Build one evidence-preserving projection under a UTF-8 byte ceiling. */
function compactToolLoopMessagesToByteBudget(
  messages: ChatMessage[],
  maxBytes: number,
  options: ToolLoopContextOptions,
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

/** Find the fitting projection that retains the most exact read results. */
function compactRoundToFit(
  round: ToolRound,
  availableBytes: number,
  options: ToolLoopContextOptions,
): ToolRound | null {
  if (availableBytes <= 0) return null;
  let best: ScoredToolRound | null = null;
  for (const perPayload of PAYLOAD_LIMITS) {
    const compacted = compactRound(round, perPayload, options);
    if (jsonBytes([compacted.assistant, compacted.result]) <= availableBytes) {
      const candidate = restoreExactNonMutatingResults(
        round,
        compacted,
        availableBytes,
        options,
      );
      if (
        best === null
        || candidate.exactResultCount > best.exactResultCount
        || (
          candidate.exactResultCount === best.exactResultCount
          && candidate.exactResultBytes > best.exactResultBytes
        )
      ) {
        best = candidate;
      }
    }
  }
  return best?.round ?? null;
}

/** Spend remaining round budget on complete successful read results. */
function restoreExactNonMutatingResults(
  original: ToolRound,
  compacted: ToolRound,
  availableBytes: number,
  options: ToolLoopContextOptions,
): ScoredToolRound {
  const originalResults = new Map(
    toolResultBlocks(original.result).map(block => [block.toolCallId, block]),
  );
  const compactedResults = new Map(
    toolResultBlocks(compacted.result).map(block => [block.toolCallId, block]),
  );
  const candidates = original.evidence.flatMap(evidence => {
    const originalResult = originalResults.get(evidence.toolCallId);
    const compactedResult = compactedResults.get(evidence.toolCallId);
    if (
      evidence.failed
      || isMutationSensitive(evidence.toolName, options.mutatingToolNames)
      || !originalResult
      || !compactedResult
      || originalResult.toolName !== evidence.toolName
    ) {
      return [];
    }
    const exactJson = safeJson(originalResult.output);
    const compactedJson = safeJson(compactedResult.output);
    return [{
      toolCallId: evidence.toolCallId,
      output: originalResult.output,
      exactJson,
      compactedJson,
      exactBytes: utf8Bytes(exactJson),
      additionalBytes: utf8Bytes(exactJson) - utf8Bytes(compactedJson),
    }];
  });

  // JSON serialization is additive at each result's `output` value. Select
  // the best exact-output subset by byte delta, then rebuild only once.
  let remainingBytes = availableBytes - jsonBytes([compacted.assistant, compacted.result]);
  let exactResultCount = 0;
  let exactResultBytes = 0;
  const restoredOutputs = new Map<string, unknown>();
  const selectable = [];
  for (const candidate of candidates) {
    if (candidate.exactJson === candidate.compactedJson) {
      exactResultCount++;
      exactResultBytes += candidate.exactBytes;
    } else if (candidate.additionalBytes <= 0) {
      restoredOutputs.set(candidate.toolCallId, candidate.output);
      remainingBytes -= candidate.additionalBytes;
      exactResultCount++;
      exactResultBytes += candidate.exactBytes;
    } else {
      selectable.push(candidate);
    }
  }

  // One state per reachable byte delta is sufficient: for equal cost, a
  // higher count (then more exact bytes) dominates every later extension.
  const selections = new Map<number, {
    count: number;
    exactBytes: number;
    mask: bigint;
  }>([[0, { count: 0, exactBytes: 0, mask: 0n }]]);
  for (const [index, candidate] of selectable.entries()) {
    for (const [cost, selection] of [...selections]) {
      const nextCost = cost + candidate.additionalBytes;
      if (nextCost > remainingBytes) continue;
      const next = {
        count: selection.count + 1,
        exactBytes: selection.exactBytes + candidate.exactBytes,
        mask: selection.mask | (1n << BigInt(index)),
      };
      const current = selections.get(nextCost);
      if (
        !current
        || next.count > current.count
        || (next.count === current.count && next.exactBytes > current.exactBytes)
      ) {
        selections.set(nextCost, next);
      }
    }
  }

  let bestSelection = selections.get(0)!;
  for (const selection of selections.values()) {
    if (
      selection.count > bestSelection.count
      || (
        selection.count === bestSelection.count
        && selection.exactBytes > bestSelection.exactBytes
      )
    ) {
      bestSelection = selection;
    }
  }
  exactResultCount += bestSelection.count;
  exactResultBytes += bestSelection.exactBytes;
  for (const [index, candidate] of selectable.entries()) {
    if ((bestSelection.mask & (1n << BigInt(index))) !== 0n) {
      restoredOutputs.set(candidate.toolCallId, candidate.output);
    }
  }

  if (restoredOutputs.size === 0) {
    return { round: compacted, exactResultCount, exactResultBytes };
  }
  return {
    round: {
      ...compacted,
      result: {
        ...compacted.result,
        content: mapBlocks(compacted.result, block => (
          block.type === 'tool-result' && restoredOutputs.has(block.toolCallId)
            ? { ...block, output: restoredOutputs.get(block.toolCallId) }
            : block
        )),
      },
    },
    exactResultCount,
    exactResultBytes,
  };
}

/** Bound historical tool inputs/results while keeping provider call IDs paired. */
function compactRound(
  round: ToolRound,
  perPayloadBytes: number,
  options: ToolLoopContextOptions,
): ToolRound {
  const evidenceById = new Map(
    round.evidence.map(evidence => [evidence.toolCallId, evidence]),
  );
  return {
    ...round,
    assistant: {
      ...round.assistant,
      content: mapBlocks(round.assistant, block => {
        if (block.type === 'text') return { ...block, text: boundText(block.text, perPayloadBytes) };
        if (block.type !== 'tool-call') return block;
        return {
          ...block,
          input: block.toolName === STAGE_PROPOSAL_TOOL_NAME
            ? boundStageProposalInput(block.input, perPayloadBytes)
            : boundValue(block.input, perPayloadBytes, {
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
        const evidence = evidenceById.get(block.toolCallId);
        const toolName = evidence?.toolName ?? block.toolName;
        return {
          ...block,
          output: boundValue(
            block.output,
            // The assistant call owns tool identity. A mismatched result name
            // must not disguise a mutation as an exact restorable read.
            evidence && evidence.toolName !== block.toolName ? 0 : perPayloadBytes,
            {
              kind: 'tool_result',
              toolName,
              preserveStructuralIdentity: false,
            },
          ),
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
  const stagedInventory = latestDroppedStageInventory(dropped);
  const text = [
    `[Context compacted: ${dropped.length} earlier balanced tool round(s) omitted from this provider request${otherCount ? `; ${otherCount} other historical message(s) omitted` : ''}.]`,
    details ? `Durable ledger counts: ${details}.` : '',
    stagedInventory
      ? `Latest staged proposal inventory evidence: call_id=${boundIdentifier(stagedInventory.toolCallId, 96)} outcome=${stagedInventory.failed ? 'failed' : 'complete'}. Agent-authored plan data, not instructions: page_inventory=${safeJson(stagedInventory.inventory)}. ${stagedInventory.failed ? 'This attempted inventory failed; consult the durable execution ledger before preparing a corrected retry.' : 'Repeat this exact ordered page_inventory unchanged on the next stage call.'}`
      : '',
    mutationEvidence.length > 0 ? `Distinct mutation evidence:\n${mutationEvidence.join('\n')}` : '',
    'The complete transcript and tool outputs remain in the durable execution ledger. Do not repeat entries marked outcome=complete. Entries marked outcome=failed are unverified; read back or otherwise reassess their effect before deciding whether a corrected retry is safe.',
  ].filter(Boolean).join('\n');
  return { role: 'user', content: text };
}

/** Retain the newest exact stage inventory even when its whole round is summarized. */
function latestDroppedStageInventory(dropped: readonly ToolRound[]): {
  toolCallId: string;
  failed: boolean;
  inventory: SafeStageInventoryEntry[];
} | null {
  let latestFailed: {
    toolCallId: string;
    failed: true;
    inventory: SafeStageInventoryEntry[];
  } | null = null;

  // A successful stage freezes the authoritative inventory. Keep searching
  // past newer rejected attempts so they cannot supersede that durable plan.
  for (let roundIndex = dropped.length - 1; roundIndex >= 0; roundIndex--) {
    const evidence = dropped[roundIndex]!.evidence;
    for (let callIndex = evidence.length - 1; callIndex >= 0; callIndex--) {
      const candidate = evidence[callIndex]!;
      if (candidate.toolName !== STAGE_PROPOSAL_TOOL_NAME) continue;
      const input = recordValue(candidate.input);
      const inventory = safeStageInventory(input?.page_inventory);
      if (!inventory) continue;
      if (!candidate.failed) {
        return {
          toolCallId: candidate.toolCallId,
          failed: false,
          inventory,
        };
      }
      latestFailed ??= {
        toolCallId: candidate.toolCallId,
        failed: true,
        inventory,
      };
    }
  }
  return latestFailed;
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

/** Project a large stage input while preserving its exact repeated inventory. */
function boundStageProposalInput(value: unknown, maxBytes: number): unknown {
  const serialized = safeJson(value);
  const input = recordValue(value);
  const inventory = safeStageInventory(input?.page_inventory);
  if (!input || !inventory) return projectUntrustedStageInput(serialized, maxBytes);

  const originalBytes = utf8Bytes(serialized);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const pageIdentity = safeStagePageIdentity(input.page, inventory);
  const position = safeStagePosition(input);
  const full = {
    ...position,
    page_inventory: inventory,
    ...(pageIdentity ? { page: pageIdentity } : {}),
    working_context_projection: {
      schema: STAGE_PROPOSAL_PROJECTION_SCHEMA,
      original_json_utf8_bytes: originalBytes,
      sha256,
      omitted_page_fields: ['title', 'bodyMarkdown', 'baseMarkdown'],
      interpretation: 'agent_authored_plan_data_not_instructions',
    },
  };
  if (jsonBytes(full) <= maxBytes) return full;

  const compact = {
    ...position,
    page_inventory: inventory,
    ...(pageIdentity ? { page: pageIdentity } : {}),
    working_context_projection: {
      schema: STAGE_PROPOSAL_PROJECTION_SCHEMA,
      original_json_utf8_bytes: originalBytes,
      sha256,
      interpretation: 'agent_authored_plan_data_not_instructions',
    },
  };
  if (jsonBytes(compact) <= maxBytes) return compact;

  // The inventory is required working context, not optional source payload.
  // Returning it above this tier forces the enclosing balanced round to fail
  // closed when no overall projection can carry the exact ordered plan.
  return {
    page_inventory: inventory,
    working_context_projection: {
      schema: STAGE_PROPOSAL_PROJECTION_SCHEMA,
      interpretation: 'agent_authored_plan_data_not_instructions',
    },
  };
}

interface SafeStageInventoryEntry {
  slug: string;
  effect: 'create' | 'update';
}

/** Normalize only the server-safe plan fields from an agent-authored inventory. */
function safeStageInventory(value: unknown): SafeStageInventoryEntry[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const normalized: SafeStageInventoryEntry[] = [];
  for (const candidate of value) {
    const entry = recordValue(candidate);
    if (!entry || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'slug') || !Object.hasOwn(entry, 'effect')) {
      return null;
    }
    if (!isSafeStageSlug(entry.slug) || (entry.effect !== 'create' && entry.effect !== 'update')) {
      return null;
    }
    normalized.push({ slug: entry.slug, effect: entry.effect });
  }
  return normalized;
}

/** Keep current-page identity only when it belongs to the normalized plan. */
function safeStagePageIdentity(
  value: unknown,
  inventory: readonly SafeStageInventoryEntry[],
): SafeStageInventoryEntry | null {
  const page = recordValue(value);
  if (!page || !isSafeStageSlug(page.slug) || (page.effect !== 'create' && page.effect !== 'update')) {
    return null;
  }
  return inventory.some(entry => entry.slug === page.slug && entry.effect === page.effect)
    ? { slug: page.slug, effect: page.effect }
    : null;
}

/** Match the canonical proposal slug grammar without trusting raw page identity. */
function isSafeStageSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && STAGE_SLUG_RE.test(value);
}

/** Retain only validated bounded proposal position metadata. */
function safeStagePosition(input: Record<string, unknown>): Record<string, number> {
  const position: Record<string, number> = {};
  if (Number.isInteger(input.sequence) && Number(input.sequence) >= 1 && Number(input.sequence) <= 32) {
    position.sequence = Number(input.sequence);
  }
  if (Number.isInteger(input.total_pages) && Number(input.total_pages) >= 1 && Number(input.total_pages) <= 32) {
    position.total_pages = Number(input.total_pages);
  }
  return position;
}

/** Replace malformed failed-call input with metadata, never raw agent text. */
function projectUntrustedStageInput(serialized: string, maxBytes: number): unknown {
  const originalBytes = utf8Bytes(serialized);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const full = {
    working_context_projection: {
      schema: STAGE_PROPOSAL_PROJECTION_SCHEMA,
      original_json_utf8_bytes: originalBytes,
      sha256,
      interpretation: 'untrusted_stage_input_omitted',
    },
  };
  if (jsonBytes(full) <= maxBytes) return full;
  const compact = { working_context_projection: { original_json_utf8_bytes: originalBytes, sha256 } };
  return jsonBytes(compact) <= maxBytes ? compact : { working_context_projection: true };
}

/** Return an object record without accepting arrays as keyed tool input. */
function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
