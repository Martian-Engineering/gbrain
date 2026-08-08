/** Validation for structured relation effects in an ingestion proposal. */

import {
  AgentJobProposalError,
  canonicalProposalJson,
  isCanonicalProposalSlug,
} from '../ingestion-proposal-contract.ts';
import { matchesSlugAllowList } from '../slug-allow-list.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProposalTimelineEntry {
  pageSlug: string;
  date: string;
  text: string;
  ref: string;
  refLabel?: string;
}

export interface ProposalLink {
  from: string;
  to: string;
  type: string;
}

/** Parse and deduplicate bounded timeline mutations. */
export function parseProposalTimelineEntries(raw: unknown): ProposalTimelineEntry[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_timeline', 'proposed_timeline_entries must be an array of at most 40 entries.');
  }
  const identities = new Set<string>();
  return raw.map((entry, index) => {
    const record = readRecord(entry, `proposed_timeline_entries[${index}]`);
    const keys = Object.keys(record);
    if (
      !keys.every(key => ['date', 'pageSlug', 'ref', 'refLabel', 'text'].includes(key))
      || !['date', 'pageSlug', 'ref', 'text'].every(key => key in record)
    ) {
      throw new AgentJobProposalError('invalid_timeline', `Invalid timeline entry at index ${index}.`);
    }
    const date = readString(record.date, 'timeline.date');
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!DATE_RE.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      throw new AgentJobProposalError('invalid_timeline', `Invalid timeline date ${date}.`);
    }
    const result: ProposalTimelineEntry = {
      pageSlug: readCanonicalSlug(record.pageSlug, 'timeline.pageSlug'),
      date,
      text: readBoundedString(record.text, 'timeline.text', 1_000),
      ref: readCanonicalSlug(record.ref, 'timeline.ref'),
    };
    if ('refLabel' in record) result.refLabel = readBoundedString(record.refLabel, 'timeline.refLabel', 500);
    assertUnique(identities, result, 'duplicate_timeline', 'Proposal contains duplicate timeline mutations.');
    return result;
  });
}

/** Parse and deduplicate bounded typed-link mutations. */
export function parseProposalLinks(raw: unknown): ProposalLink[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_links', 'proposed_links must be an array of at most 40 entries.');
  }
  const identities = new Set<string>();
  return raw.map((entry, index) => {
    const record = readRecord(entry, `proposed_links[${index}]`);
    assertExactKeys(record, ['from', 'to', 'type'], `proposed_links[${index}]`);
    const result: ProposalLink = {
      from: readCanonicalSlug(record.from, 'link.from'),
      to: readCanonicalSlug(record.to, 'link.to'),
      type: readBoundedString(record.type, 'link.type', 128),
    };
    assertUnique(identities, result, 'duplicate_links', 'Proposal contains duplicate link mutations.');
    return result;
  });
}

/** Parse bounded unresolved proposal notes. */
export function parseProposalUnresolved(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 40) {
    throw new AgentJobProposalError('invalid_unresolved', 'unresolved must be an array of at most 40 strings.');
  }
  return raw.map((entry, index) => readBoundedString(entry, `unresolved[${index}]`, 500));
}

/** Enforce capture provenance and the durable job slug fence on relations. */
export function validateProposalRelations(
  capturePageSlug: string,
  allowedSlugPrefixes: readonly string[],
  pageSlugs: ReadonlySet<string>,
  timeline: readonly ProposalTimelineEntry[],
  links: readonly ProposalLink[],
): void {
  if (!pageSlugs.has(capturePageSlug)) {
    throw new AgentJobProposalError('missing_capture_page', 'The exact job-bound capture page must be included in proposed pages.');
  }
  for (const entry of timeline) {
    assertSlugAllowed(entry.pageSlug, allowedSlugPrefixes, 'Timeline target');
    if (entry.ref !== capturePageSlug) {
      throw new AgentJobProposalError('invalid_timeline_capture', 'Every timeline ref must equal the exact job-bound capture page.');
    }
  }
  for (const link of links) {
    assertSlugAllowed(link.from, allowedSlugPrefixes, 'Link source');
    if (!pageSlugs.has(link.from)) {
      throw new AgentJobProposalError('invalid_links', 'Every proposed link from slug must name a proposed page.');
    }
  }
}

function assertSlugAllowed(slug: string, prefixes: readonly string[], label: string): void {
  if (!matchesSlugAllowList(slug, prefixes)) {
    throw new AgentJobProposalError('slug_not_allowed', `${label} ${slug} is outside the agent job slug fence.`);
  }
}

function assertUnique(identities: Set<string>, value: unknown, code: string, message: string): void {
  const identity = canonicalProposalJson(value);
  if (identities.has(identity)) throw new AgentJobProposalError(code, message);
  identities.add(identity);
}

function readRecord(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentJobProposalError('invalid_object', `${name} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

function readString(raw: unknown, name: string): string {
  if (typeof raw !== 'string') throw new AgentJobProposalError('invalid_string', `${name} must be a string.`);
  return raw;
}

function readBoundedString(raw: unknown, name: string, maxLength: number): string {
  const value = readString(raw, name).trim();
  if (!value || value.length > maxLength) {
    throw new AgentJobProposalError('invalid_string', `${name} must contain 1-${maxLength} characters.`);
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
