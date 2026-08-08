/**
 * Pure contracts for staged ingestion proposal pages and their bounded model context.
 *
 * This module owns proposal inventory shape, page identity, and projection rules.
 * Database state, effect checks, job bindings, and transactions remain in the
 * agent-job proposal runtime.
 */

import { createHash } from 'node:crypto';
import { assertValidSourceId } from './source-id.ts';

/** Maximum number of pages in one finalized proposal. */
export const PROPOSAL_MAX_PAGES = 32;

/** Maximum UTF-8 size of one page-staging tool input. */
export const PROPOSAL_STAGE_INPUT_MAX_BYTES = 196_608;

/** Maximum characters in the shared Lore/GBrain admission-scope contract. */
export const PROPOSAL_ADMISSION_SCOPE_MAX_CHARS = 4_000;

/** Canonical operation used to stage one ingestion proposal page. */
export const STAGE_PROPOSAL_TOOL_NAME = 'brain_stage_ingestion_proposal_page';

const SHA256_RE = /^[a-f0-9]{64}$/;
const CANONICAL_SLUG_CHARS = 'a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af';
const PAGE_SLUG_SEGMENT = `[${CANONICAL_SLUG_CHARS}][${CANONICAL_SLUG_CHARS}-]*`;
const PAGE_SLUG_RE = new RegExp(`^${PAGE_SLUG_SEGMENT}(\\/${PAGE_SLUG_SEGMENT})*$`);

/** Error raised when staged proposal evidence violates its durable contract. */
export class AgentJobProposalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentJobProposalError';
  }
}

/** Stable digest identity for one staged proposal page. */
export interface ProposalPageDigest {
  sequence: number;
  slug: string;
  digest: string;
}

/** One immutable page slot in a staged ingestion proposal. */
export interface ProposalPageInventoryEntry {
  slug: string;
  effect: 'create' | 'update';
}

/** Successful staging receipt, including the next incomplete inventory slot. */
export interface StageProposalPageResult extends ProposalPageDigest {
  nextExpectedSlot: ({ sequence: number } & ProposalPageInventoryEntry) | null;
}

/** Complete page mutation admitted to one scoped ingestion proposal. */
export interface ScopedProposalPage {
  slug: string;
  effect: 'create' | 'update';
  title: string;
  bodyMarkdown: string;
  baseMarkdown?: string;
  expectedContentHash?: string;
}

/** External tool input for one ordered proposal page. */
export interface StageProposalPageInput {
  artifact_id: string;
  source_id: string;
  admission_scope: string;
  sequence: number;
  total_pages: number;
  page_inventory: unknown;
  page: unknown;
}

/** Validated page-stage fields before inventory semantics are checked. */
export interface ParsedStageProposalPageCore {
  artifactId: string;
  sourceId: string;
  admissionScope: string;
  sequence: number;
  totalPages: number;
  page: ScopedProposalPage;
  pageDigest: string;
}

/** Fully validated page-stage input with its normalized repeated inventory. */
export interface ParsedStageProposalPageInput extends ParsedStageProposalPageCore {
  pageInventory: ProposalPageInventoryEntry[];
}

/** Return the canonical JSON encoding used for every proposal digest. */
export function canonicalProposalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProposalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalProposalJson(record[key])}`
  )).join(',')}}`;
}

/** Hash one canonical proposal value with SHA-256. */
export function digestProposalValue(value: unknown): string {
  return createHash('sha256').update(canonicalProposalJson(value), 'utf8').digest('hex');
}

/** Measure one tool input using the canonical persisted representation. */
export function proposalToolInputBytes(input: unknown): number {
  return Buffer.byteLength(canonicalProposalJson(input ?? null), 'utf8');
}

/** Parse and normalize the bounded fields shared by proposal stage calls. */
export function parseStageProposalPageCore(raw: unknown): ParsedStageProposalPageCore {
  if (proposalToolInputBytes(raw) > PROPOSAL_STAGE_INPUT_MAX_BYTES) {
    throw new AgentJobProposalError('stage_input_too_large', 'Proposal page input exceeds the staging byte limit.');
  }
  const input = readRecord(raw, 'stage proposal input');
  const artifactId = readBoundedString(input.artifact_id, 'artifact_id', 255);
  const sourceId = readBoundedString(input.source_id, 'source_id', 255);
  assertValidSourceId(sourceId);
  const admissionScope = readBoundedString(
    input.admission_scope,
    'admission_scope',
    PROPOSAL_ADMISSION_SCOPE_MAX_CHARS,
  );
  const sequence = readPositiveInteger(input.sequence, 'sequence');
  const totalPages = readProposalPageCount(input.total_pages);
  if (sequence > totalPages) {
    throw new AgentJobProposalError('invalid_sequence', 'sequence must be within 1..total_pages.');
  }
  const page = parseProposalPage(input.page);
  return {
    artifactId,
    sourceId,
    admissionScope,
    sequence,
    totalPages,
    page,
    pageDigest: digestProposalValue(page),
  };
}

/** Parse and normalize a complete page-staging input at tool execution time. */
export function parseStageProposalPageInput(raw: unknown): ParsedStageProposalPageInput {
  const core = parseStageProposalPageCore(raw);
  const input = readRecord(raw, 'stage proposal input');
  return {
    ...core,
    pageInventory: parseProposalPageInventory(input.page_inventory, core.totalPages),
  };
}

/** Parse the exact ordered inventory repeated with every successful stage call. */
export function parseProposalPageInventory(
  raw: unknown,
  totalPages: number,
): ProposalPageInventoryEntry[] {
  const inventory = parseInventoryEntries(raw, totalPages);
  const positionsBySlug = new Map<string, number[]>();
  for (const [index, entry] of inventory.entries()) {
    const positions = positionsBySlug.get(entry.slug) ?? [];
    positions.push(index + 1);
    positionsBySlug.set(entry.slug, positions);
  }
  const duplicates = [...positionsBySlug]
    .filter(([, positions]) => positions.length > 1)
    .map(([slug, positions]) => `${slug} at positions ${joinPositions(positions)}`);
  if (duplicates.length > 0) {
    throw new AgentJobProposalError(
      'duplicate_page_inventory',
      `page_inventory repeats ${duplicates.join('; ')}. Consolidate all material for each slug into one complete page entry, remove duplicates, renumber the inventory, and retry.`,
    );
  }
  return inventory;
}

/** Return a normalized safe inventory for model context, retaining correctable duplicates. */
export function safeProposalPageInventory(raw: unknown): ProposalPageInventoryEntry[] | null {
  try {
    return parseInventoryEntries(raw);
  } catch (error) {
    if (error instanceof AgentJobProposalError) return null;
    throw error;
  }
}

/** Require the staged page to implement its exact one-based inventory slot. */
export function assertPageMatchesInventorySlot(input: {
  sequence: number;
  page: Pick<ScopedProposalPage, 'slug' | 'effect'>;
  pageInventory: readonly ProposalPageInventoryEntry[];
}): void {
  const expected = input.pageInventory[input.sequence - 1];
  if (!expected || input.page.slug !== expected.slug || input.page.effect !== expected.effect) {
    const wanted = expected ? `${expected.effect} ${expected.slug}` : 'a valid inventory entry';
    throw new AgentJobProposalError(
      'inventory_slot_mismatch',
      `Sequence ${input.sequence} must stage ${wanted}; received ${input.page.effect} ${input.page.slug}. Correct this page call and retry the same inventory slot.`,
    );
  }
}

/** Require an incoming repeated inventory to equal the frozen plan. */
export function assertExactPageInventory(
  frozen: readonly ProposalPageInventoryEntry[],
  requested: readonly ProposalPageInventoryEntry[],
): void {
  if (canonicalProposalJson(frozen) !== canonicalProposalJson(requested)) {
    throw new AgentJobProposalError(
      'inventory_mismatch',
      'page_inventory does not exactly match the inventory frozen by the first successful stage. Repeat the unchanged frozen inventory and retry.',
    );
  }
}

/** Identify the earliest inventory slot absent from the durable sequence ledger. */
export function nextExpectedInventorySlot(
  inventory: readonly ProposalPageInventoryEntry[],
  fragments: readonly { sequence: number }[],
): ({ sequence: number } & ProposalPageInventoryEntry) | null {
  const staged = new Set(fragments.map(fragment => Number(fragment.sequence)));
  const index = inventory.findIndex((_, candidateIndex) => !staged.has(candidateIndex + 1));
  return index < 0 ? null : { sequence: index + 1, ...inventory[index]! };
}

/** Return whether a value uses the canonical proposal page slug grammar. */
export function isCanonicalProposalSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && PAGE_SLUG_RE.test(value);
}

/** Parse structurally exact inventory entries, optionally requiring one length. */
function parseInventoryEntries(raw: unknown, totalPages?: number): ProposalPageInventoryEntry[] {
  const validLength = Array.isArray(raw)
    && (totalPages === undefined
      ? raw.length >= 1 && raw.length <= PROPOSAL_MAX_PAGES
      : raw.length === totalPages);
  if (!validLength) {
    const message = totalPages === undefined
      ? `page_inventory must contain 1-${PROPOSAL_MAX_PAGES} ordered entries.`
      : `page_inventory must contain exactly ${totalPages} ordered entries to match total_pages.`;
    throw new AgentJobProposalError('invalid_page_inventory', message);
  }
  return raw.map((entry, index) => {
    const record = readRecord(entry, `page_inventory[${index}]`);
    assertExactKeys(record, ['slug', 'effect'], `page_inventory[${index}]`);
    const slug = readCanonicalSlug(record.slug, `page_inventory[${index}].slug`);
    if (record.effect !== 'create' && record.effect !== 'update') {
      throw new AgentJobProposalError(
        'invalid_page_inventory',
        `page_inventory[${index}].effect must be create or update.`,
      );
    }
    return { slug, effect: record.effect };
  });
}

/** Parse one complete create or update page under the staged proposal contract. */
export function parseProposalPage(raw: unknown): ScopedProposalPage {
  const page = readRecord(raw, 'page');
  if (page.effect !== 'create' && page.effect !== 'update') {
    throw new AgentJobProposalError('invalid_page', 'page.effect must be create or update.');
  }
  const allowed = page.effect === 'create'
    ? ['slug', 'effect', 'title', 'bodyMarkdown']
    : ['slug', 'effect', 'title', 'bodyMarkdown', 'baseMarkdown', 'expectedContentHash'];
  assertExactKeys(page, allowed, 'page');
  const slug = readCanonicalSlug(page.slug, 'page.slug');
  const title = readBoundedString(page.title, 'page.title', 1_000);
  const bodyMarkdown = readNonBlankString(page.bodyMarkdown, 'page.bodyMarkdown');
  if (page.effect === 'create') return { slug, effect: page.effect, title, bodyMarkdown };
  const baseMarkdown = readNonBlankString(page.baseMarkdown, 'page.baseMarkdown');
  const expectedContentHash = readString(page.expectedContentHash, 'page.expectedContentHash');
  if (!SHA256_RE.test(expectedContentHash)) {
    throw new AgentJobProposalError('invalid_page', 'page.expectedContentHash must be a lowercase SHA-256 digest.');
  }
  return { slug, effect: page.effect, title, bodyMarkdown, baseMarkdown, expectedContentHash };
}

/** Format one-based duplicate positions as a compact correction hint. */
function joinPositions(positions: readonly number[]): string {
  if (positions.length === 1) return String(positions[0]);
  if (positions.length === 2) return `${positions[0]} and ${positions[1]}`;
  return `${positions.slice(0, -1).join(', ')}, and ${positions.at(-1)}`;
}

function readPositiveInteger(raw: unknown, name: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 1_000) {
    throw new AgentJobProposalError('invalid_integer', `${name} must be an integer from 1 to 1000.`);
  }
  return Number(raw);
}

function readProposalPageCount(raw: unknown): number {
  const totalPages = readPositiveInteger(raw, 'total_pages');
  if (totalPages > PROPOSAL_MAX_PAGES) {
    throw new AgentJobProposalError(
      'invalid_total_pages',
      `total_pages must be at most ${PROPOSAL_MAX_PAGES}.`,
    );
  }
  return totalPages;
}

function readRecord(raw: unknown, name: string): Record<string, unknown> {
  const record = recordValue(raw);
  if (!record) throw new AgentJobProposalError('invalid_object', `${name} must be an object.`);
  return record;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(raw: unknown, name: string): string {
  if (typeof raw !== 'string') {
    throw new AgentJobProposalError('invalid_string', `${name} must be a string.`);
  }
  return raw;
}

function readBoundedString(raw: unknown, name: string, maxLength: number): string {
  const value = readString(raw, name).trim();
  if (!value || value.length > maxLength) {
    throw new AgentJobProposalError('invalid_string', `${name} must contain 1-${maxLength} characters.`);
  }
  return value;
}

function readNonBlankString(raw: unknown, name: string): string {
  const value = readString(raw, name);
  if (!value.trim()) {
    throw new AgentJobProposalError('invalid_string', `${name} must not be blank.`);
  }
  return value;
}

function readCanonicalSlug(raw: unknown, name: string): string {
  const slug = readString(raw, name);
  if (!isCanonicalProposalSlug(slug)) {
    throw new AgentJobProposalError('invalid_slug', `${name} is not a canonical page slug.`);
  }
  return slug;
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], name: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AgentJobProposalError('invalid_keys', `${name} must contain exactly: ${expected.join(', ')}.`);
  }
}
