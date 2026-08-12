import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { getSkillAgentBindings } from '../src/core/skill-catalog.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

const skillsDir = join(import.meta.dir, '..', 'skills');
const skill = readFileSync(
  join(skillsDir, 'granola-meeting-ingestion', 'SKILL.md'),
  'utf8',
);
const meetingSkill = readFileSync(
  join(skillsDir, 'meeting-ingestion', 'SKILL.md'),
  'utf8',
);
const enrichSkill = readFileSync(
  join(skillsDir, 'enrich', 'SKILL.md'),
  'utf8',
);

const expectedTools = [
  'get_active_schema_pack',
  'get_skill',
  'search',
  'query',
  'get_page',
  'list_pages',
  'resolve_slugs',
  'get_links',
  'get_backlinks',
  'stage_ingestion_proposal_page',
  'finalize_ingestion_proposal',
  'apply_ingestion_proposal_page',
  'apply_ingestion_proposal_relation',
  'finalize_ingestion_proposal_application',
  'put_page',
  'add_link',
  'add_timeline_entry',
  'validate_links',
];

const expectedPrefixes = [
  'partners/',
  'sources/',
  'meetings/',
  'people/',
  'companies/',
  'projects/',
  'concepts/',
  'decisions/',
];

describe('granola-meeting-ingestion skill', () => {
  test('derives the exact reviewed agent bindings', () => {
    expect(skill).toContain('version: 1.6.0');
    expect(getSkillAgentBindings(skillsDir, 'granola-meeting-ingestion')).toEqual({
      tools: expectedTools,
      writes_to: expectedPrefixes,
    });
    expect(skill).toMatch(/put_page` creates or replaces a complete\s+page/);
    expect(skill).toMatch(/Rewrite compiled truth with the current best understanding; never\s+append to it/);
  });

  test('declares only canonical GBrain operations', () => {
    const operationNames = new Set(operations.map(operation => operation.name));
    for (const tool of expectedTools) {
      expect(operationNames.has(tool)).toBe(true);
      expect(BRAIN_TOOL_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  test('keeps acquisition, routing, and orchestration outside the Minion', () => {
    expect(skill).toContain('does not acquire data from Granola');
    expect(skill).toMatch(/choose\s+among sources/);
    expect(skill).toContain('manage checkpoints');
    expect(skill).toContain('provide a generic ingestion control plane');
    expect(skill).toContain('Do not read another source');
  });

  test('uses the source-bound credential and frozen resolver without inventing a page', () => {
    expect(skill).toContain('credential binds every tool call to the prompt');
    expect(skill).toContain('exact prompt-supplied resolver text and revision');
    expect(skill).not.toContain('exact `resolver` slug');
    expect(skill).not.toContain("source's `resolver` page");
    expect(skill).toContain("Lore's transcript Markdown as immutable source authority");
    expect(skill).toMatch(/exact\s+bound transcript before digesting the page/);
    expect(skill).toContain('artifact source-record read-back');
    expect(skill).not.toContain('local-mirror provenance statement');
    expect(skill).toContain('complete `transcript.md` is also frozen into');
    expect(skill).not.toContain('raw-data retrieval');
  });

  test('separates the fixed capture anchor from resolver-selected meeting taxonomy', () => {
    expect(skill).toMatch(
      /exact prompt-supplied `capturePageSlug` is a pre-authorized verbatim\s+source page/,
    );
    expect(skill).toMatch(/It is not a derived page/);
    expect(skill).toMatch(/exempt from resolver taxonomy\s+and path-selection rules/);
    expect(skill).toMatch(
      /Only that exact capture anchor is exempt; every\s+derived page path follows\s+the resolver-selected taxonomy/,
    );
    expect(skill).toMatch(
      /Derived pages\s+remain subject to the resolver's exclusions and privacy limits/,
    );
    expect(skill).toMatch(
      /derived analyzed meeting page must follow (?:the resolver-selected|that) taxonomy/i,
    );
    expect(skill).toContain('`partners/<partner>/meetings/`');
    expect(skill).not.toContain('Create or update a `meetings/` page containing:');
  });

  test('returns the Lore ingestion receipt without deterministic effects', () => {
    expect(skill).toContain('"status": "succeeded | failed"');
    expect(skill).toContain('"artifactId": "copied exactly from the prompt"');
    expect(skill).toContain('"sourceId": "verified source id"');
    expect(skill).toContain('"createdPages":');
    expect(skill).toContain('"updatedPages":');
    expect(skill).toContain('"verifiedPages":');
    expect(skill).toContain('qualify every page as `<sourceId>:<slug>`');
    expect(skill).toContain('with no status words or commentary');
    expect(skill).toContain('"createdPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"updatedPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"verifiedPages": ["<sourceId>:<slug>"]');
    expect(skill).not.toContain('<sourceId>:<slug> created');
    expect(skill).not.toContain('<sourceId>:<slug> updated');
    expect(skill).not.toContain('<sourceId>:<slug> read back and verified');
    expect(skill).toMatch(/Never return a bare\s+`sources\/\.\.\.`/);
    expect(skill).toContain('"unresolved":');
    expect(skill).not.toContain('effect list');
  });

  test('supports a zero-mutation scoped proposal with a bounded complete plan', () => {
    expect(skill).toContain('mode: <propose | apply | omit for normal mode>');
    expect(skill).toContain('brain_stage_ingestion_proposal_page');
    expect(skill).toContain('brain_finalize_ingestion_proposal');
    expect(skill).toContain('at most 32 pages');
    expect(skill).toContain('262,144 UTF-8 bytes');
    expect(skill).toContain('786,432 UTF-8 bytes');
    expect(skill).toContain('1,572,864 UTF-8 bytes');
    expect(skill).toContain('{slug,effect:"create",title,bodyMarkdown}');
    expect(skill).not.toContain('{slug,effect:"update",appendMarkdown}');
    expect(skill).toContain(
      '{slug,effect:"update",title,bodyMarkdown,baseMarkdown,expectedContentHash}',
    );
    expect(skill).toMatch(/bodyMarkdown` is the complete intended page, not a diff\s+or dated addendum/);
    expect(skill).toMatch(/Apply never rebases an update/);
    expect(skill).toContain('"status": "staged_proposal"');
    expect(skill).toContain('"proposalDigest": "64 lowercase hex characters"');
  });
  test('stages each update immediately after its sole exact baseline read', () => {
    expect(skill).toMatch(
      /Never request\s+more than one\s+`get_page` in the same assistant\s+turn or tool batch/,
    );
    expect(skill).toMatch(
      /After an update\s+target's `get_page` returns, the very next\s+assistant turn must call\s+`brain_stage_ingestion_proposal_page` for that same\s+update/,
    );
    expect(skill).toMatch(/as the only tool call\s+in that turn/);
    expect(skill).toMatch(
      /Do not call `get_page` for another\s+target, or make any other large\s+read, between that baseline read and its staging\s+call/,
    );
  });

  test('carries bounded timeline and link mutations in the scoped proposal', () => {
    expect(skill).toMatch(/`proposedTimelineEntries` may contain at most 40 entries/);
    expect(skill).toMatch(/`proposedLinks` may contain at most 40 entries/);
    expect(skill).toMatch(/strict `YYYY-MM-DD` date/);
    expect(skill).toContain('"proposedTimelineEntries": [');
    expect(skill).toContain('"proposedLinks": [');
    expect(skill).toMatch(/cannot be\s+represented by `proposedPages`, `proposedTimelineEntries`, or `proposedLinks`/);
  });
  test('splits partial disqualification from classed needs-attention outcomes', () => {
    expect(skill).toContain('partial disqualification');
    expect(skill).toMatch(/[Dd]erive `admissionScope` only from the resolver/);
    expect(skill).toContain('return `staged_proposal` directly');
    expect(skill).toMatch(/Do not mutate before returning that\s+proposal/);
    expect(skill).toContain('"reason_class": "resolver_ambiguity | operational"');
    expect(skill).toMatch(/Every `needs_attention`\s+receipt must include `reason_class`/);
  });

  test('verifies Lore artifact integrity without treating context projection as loss', () => {
    expect(skill).toContain('artifactIntegrity: # required normal/propose; omitted apply');
    expect(skill).toContain('complete: true');
    expect(skill).toContain('manifest: { sha256: <64 lowercase hex characters>, bytes: <exact UTF-8 byte count> }');
    expect(skill).toMatch(/`artifactIntegrity\.complete` is not exactly `true`/);
    expect(skill).toMatch(/Apply mode intentionally\s+omits `artifactIntegrity`/);
    expect(skill).toMatch(/exactly 64 lowercase hexadecimal characters/);
    expect(skill).toMatch(/authenticated OAuth caller deterministically\s+verified these values/);
    expect(skill).toMatch(/treat\s+the well-formed envelope as authoritative/);
    expect(skill).toMatch(/Do not attempt to recalculate,\s+estimate, or second-guess hashes or byte counts/);
    expect(skill).not.toContain('Recompute each SHA-256');
    expect(skill).toMatch(/Working-context projection or omission\s+markers[\s\S]*never treat them as proof\s+that the original artifact is incomplete/);
  });

  test('accepts only the bounded error-redacted prior-attempt projection', () => {
    expect(skill).toContain('priorAttempt: # optional; omitted for a clean no-write propose attempt');
    for (const field of [
      'failureCode:', 'terminalFailureClass:', 'receiptStatus:', 'createdPages:',
      'updatedPages:', 'verifiedPages:', 'pageResults:',
      'timelineResults:', 'linkResults:',
    ]) expect(skill).toContain(field);
    expect(skill).toMatch(/never contains a top-level summary, unresolved list, raw error, or a nested\s+result `error`/);
    expect(skill).toMatch(/Durable GBrain state remains authoritative/);
    expect(skill).toMatch(/never skip a\s+mutation based on the projection alone/);
  });

  test('uses the body-free server-bound apply operation with resumable sequence results', () => {
    expect(skill).toContain('approvedProposal: # required in apply mode');
    expect(skill).toContain('jobId: <positive proposal job id>');
    expect(skill).toContain('pages: <ordered sequence, slug, effect, pageDigest manifest>');
    expect(skill).toContain('brain_apply_ingestion_proposal_page');
    expect(skill).toContain('"proposal_job_id": 123');
    expect(skill).toContain('"proposal_digest": "64 lowercase hex characters"');
    expect(skill).toContain('"page_digest": "64 lowercase hex characters"');
    expect(skill).toContain('"source_id": "verified source id"');
    expect(skill).toMatch(/never send `slug`, `effect`,\s+`title`, `bodyMarkdown`, a baseline, or an expected\s+content hash/i);
    expect(skill).toContain('Do not pre-read or reimplement its compare-and-swap logic');
    expect(skill).toContain('`get_page` or `put_page`');
    expect(skill).toContain('"proposalSequence": 1');
    expect(skill).toContain('"status": "pending | applied | already_applied | failed"');
    expect(skill).toContain('"previousContentHash":');
    expect(skill).toContain('"appliedContentHash":');
    expect(skill).toContain('"rebased": false');
  });
  test('applies relations through frozen server authority and requires final proof', () => {
    expect(skill).toContain('brain_apply_ingestion_proposal_relation');
    expect(skill).toContain('brain_finalize_ingestion_proposal_application');
    expect(skill).toContain('timelineDigests: <ordered sequence and digest manifest>');
    expect(skill).toContain('inventoryDigest: <64-character lowercase digest>');
    expect(skill).toMatch(/Never send relation text, endpoints, type, reference, label, or the relation\s+digest/);
    expect(skill).toMatch(/preflights the whole frozen inventory before\s+any corpus mutation/);
    expect(skill).toMatch(/Never use\s+generic `put_page`, `add_timeline_entry`, or `add_link` in apply mode/);
    expect(skill).toMatch(/Report\s+success only from the finalizer/);
    expect(skill).toContain('"timelineResults": []');
    expect(skill).toContain('"linkResults": []');
  });
  test('rejects timeline refs and link sources outside the frozen plan', () => {
    expect(skill).toMatch(
      /Returning a timeline entry whose `ref` is not the planned capture page/,
    );
    expect(skill).toMatch(
      /Returning a link whose `from` slug is absent from `proposedPages`/,
    );
    expect(skill).toMatch(/Reject an invalid frozen plan before any\s+mutation/);
  });

  test('stops at the first failed sequence and leaves later pages pending', () => {
    expect(skill).toMatch(/Stop after the first failed call and leave later sequences\s+pending/);
    expect(skill).toMatch(/Retry only failed or pending sequences with the identical authority/);
    expect(skill).toMatch(/returns `already_applied` after checking current durable page state/);
  });
  test('requires canonical slugs before proposing or applying a plan', () => {
    expect(skill).toMatch(
      /Every slug in `proposedPages`,\s+`proposedTimelineEntries`, and `proposedLinks` must be canonical/,
    );
    expect(skill).toMatch(
      /lowercase ASCII alphanumeric or CJK characters plus hyphens\s+in non-empty forward-slash-separated segments/,
    );
    expect(skill).toMatch(/at most 255\s+characters/);
    expect(skill).toMatch(/Reject a non-canonical slug\s+before returning a proposal/);
  });

  test('loads canonical knowledge policies without maintaining a second copy', () => {
    expect(createHash('sha256').update(meetingSkill).digest('hex')).toBe(
      '7767334c63ff3bd8e60cd4d7cd1d1b44f0d6b0a7e0ac411529a1d59cc0a7781b',
    );
    expect(createHash('sha256').update(enrichSkill).digest('hex')).toBe(
      '14f961494d06fa707f9713d16f5445c28a87146c0b3c688172c0898eff47a9c0',
    );
    expect(skill).toMatch(/Outside apply mode[\s\S]{0,100}call `get_skill` for\s+each dependency/);
    expect(skill).toContain('"name": "meeting-ingestion"');
    expect(skill).toContain('"name": "enrich"');
    expect(skill).toContain('"path": "skills/_brain-filing-rules.md"');
    expect(skill).toContain('"path": "skills/conventions/quality.md"');
    expect(skill).toContain('Read each complete returned `body`');
    expect(skill).not.toContain('skills/meeting-ingestion/SKILL.md');
    expect(skill).toContain('Canonical policies control knowledge');
    expect(skill).toContain('does not define a second meeting-synthesis policy');
    expect(skill).toContain('does not acquire external enrichment data');
    expect(skill).not.toContain('Every unambiguous attendee must have');
    expect(skill).not.toContain('Add a dated timeline entry only when');
    expect(skill).toContain('Every page created or updated during enrichment must appear');
    expect(skill).toContain('Check `get_links`');
    expect(skill).toContain('Check `get_backlinks`');
  });
});
