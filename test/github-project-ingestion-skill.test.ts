import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { getSkillAgentBindings } from '../src/core/skill-catalog.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

const skillsDir = join(import.meta.dir, '..', 'skills');
const skill = readFileSync(
  join(skillsDir, 'github-project-ingestion', 'SKILL.md'),
  'utf8',
);
const resolver = readFileSync(join(skillsDir, 'RESOLVER.md'), 'utf8');

const expectedTools = [
  'get_active_schema_pack',
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
  'put_page',
  'add_link',
  'add_timeline_entry',
  'validate_links',
];

const expectedPrefixes = [
  'sources/',
  'people/',
  'companies/',
  'projects/',
  'concepts/',
  'decisions/',
];

describe('github-project-ingestion skill', () => {
  test('derives the exact reviewed agent bindings', () => {
    expect(skill).toContain('version: 1.3.0');
    expect(getSkillAgentBindings(skillsDir, 'github-project-ingestion')).toEqual({
      tools: expectedTools,
      writes_to: expectedPrefixes,
    });
  });

  test('declares only Minion-supported canonical operations', () => {
    const operationNames = new Set(operations.map(operation => operation.name));
    for (const tool of expectedTools) {
      expect(operationNames.has(tool)).toBe(true);
      expect(BRAIN_TOOL_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  test('keeps acquisition and code interpretation outside the Minion', () => {
    expect(skill).toContain('does not acquire data from GitHub');
    expect(skill).toContain('does not ingest or reconstruct repository code');
    expect(skill).toContain('choose among sources');
    expect(skill).toContain('manage checkpoints');
    expect(skill).toContain('Do not read another source');
  });

  test('declares the complete resolver route as a trigger', () => {
    const route =
      'Prompt-supplied GitHub issue, pull request, or Markdown project-document revision for one already-selected source';
    expect(skill).toContain(`- "${route}"`);
    expect(resolver).toContain(`| ${route} |`);
  });

  test('handles canonical revisions without duplicating upstream objects', () => {
    expect(skill).toContain('canonicalExternalId');
    expect(skill).toContain('captureExternalId');
    expect(skill).toContain('predecessorExternalId');
    expect(skill).toContain('newer revision of the same canonical object');
    expect(skill).toContain('tombstone');
    expect(skill).toContain("Lore's local Markdown mirror");
  });

  test('treats GitHub objects as evidence for durable features, not projects', () => {
    expect(skill).toMatch(
      /An issue, pull request, or plan document is evidence about work; it is not a\s+project merely because it is a canonical upstream object\./,
    );
    expect(skill).toMatch(
      /Multiple GitHub objects about the same feature or initiative must converge on\s+one durable project page\./,
    );
    expect(skill).toMatch(
      /When no durable feature or initiative can be resolved, keep the exact capture\s+and report the relationship as unresolved without creating a project stub\./,
    );
    expect(skill).toMatch(
      /Reuse a source record only when its stored `captureExternalId` matches\s+exactly\./,
    );
    expect(skill).toMatch(
      /never overwrite an earlier capture with a newer revision\./,
    );
    expect(skill).toMatch(
      /A newer revision of the same canonical object records its own exact capture/,
    );
    expect(skill).toMatch(
      /When `tombstone` is true, record or reuse only the exact tombstone capture\./,
    );
    expect(skill).toMatch(
      /A\s+tombstone changes the availability of the upstream object, not the existence of\s+the feature or initiative it discussed\./,
    );
    expect(skill).not.toContain(
      'create or update one canonical project page for the upstream object',
    );
  });

  test('prescribes current-state page anatomy for historical captures', () => {
    expect(skill).toMatch(
      /The feature or initiative page body records current understanding only:\s+purpose, scope, behavior, decisions, constraints, status, and open questions\./,
    );
    expect(skill).toMatch(
      /Record every material dated change exclusively with `add_timeline_entry`,\s+dated by the upstream event time/,
    );
    expect(skill).toMatch(
      /Still write dated, cited timeline entries for material feature or initiative\s+events\. Being historical is never a reason to skip the timeline\./,
    );
    expect(skill).toMatch(
      /Update the body's current understanding only when the capture is the newest\s+evidence recorded for that page, judged by `upstreamOrder` and revision dates\s+already recorded\./,
    );
    expect(skill).toMatch(
      /Appending dated capture sections or per-artifact narration to a feature or\s+initiative page body\./,
    );
  });

  test('separates capture-page provenance from derived-page citations', () => {
    expect(skill).toMatch(
      /On the exact\s+capture page, never cite or link to `capturePageSlug` itself/,
    );
    expect(skill).toMatch(
      /Attribute\s+capture-page prose directly to GitHub using the repository, object URL or\s+document path, exact commit or revision, and upstream date/,
    );
    expect(skill).toMatch(
      /Include one\s+clickable upstream GitHub link in the capture page's Source section/,
    );
    expect(skill).toMatch(
      /On every other page, cite each GitHub-derived\s+claim with a single-line `\[Source: \.\.\.\]` citation whose first reference is a\s+wikilink to the exact `sources\/` capture page/,
    );
    expect(skill).toContain(
      '`[Source: [[sources/github/<id>|pull request #80 capture]], 2026-07-07]`',
    );
    expect(skill).toMatch(
      /Reference pages anywhere in page content with `\[\[slug\|label\]\]` wikilinks,\s+never relative Markdown links\./,
    );
    expect(skill).toMatch(
      /Citing with relative Markdown links, or nesting Markdown links inside a\s+`\[Source: \.\.\.\]` citation bracket\./,
    );
  });

  test('defines the capture as concise provenance and synthesis, not the raw record', () => {
    expect(skill).toMatch(
      /Lore's local artifact package is the complete\s+source record\. This page is its brain-facing provenance and synthesis record\./,
    );
    expect(skill).not.toMatch(
      /local Markdown artifact is the\s+complete normalized record/,
    );
    expect(skill).toMatch(
      /Keep machine audit identity in frontmatter and do not duplicate it in the\s+human-readable body/,
    );
    expect(skill).toMatch(
      /Do not write a resolver assessment, routing rationale, prompt field names,\s+Minion mechanics, receipt details, or review-control state into the capture body/,
    );
  });

  test('verifies direct capture provenance and rejects capture self-citations', () => {
    expect(skill).toMatch(
      /confirm it contains the exact upstream identity\s+and clickable GitHub URL/,
    );
    expect(skill).toMatch(
      /confirm it contains no citation or wikilink to\s+its own slug/,
    );
    expect(skill).toMatch(
      /verify every GitHub-derived claim on every other written page cites the\s+exact source capture/,
    );
    expect(skill).toMatch(
      /Citing or linking `capturePageSlug` from within the capture page itself/,
    );
  });

  test('routes timeline writes through add_timeline_entry refs, not put_page', () => {
    expect(skill).toMatch(
      /Always pass `ref` with the exact\s+`sources\/` capture page slug/,
    );
    expect(skill).toMatch(
      /the operation owns the page's\s+`## Timeline` section — never write or edit that section through\s+`put_page`\./,
    );
    expect(skill).toMatch(
      /Calling `add_timeline_entry` without a `ref` to the exact `sources\/`\s+capture page, or hand-writing a `## Timeline` section through `put_page`\./,
    );
  });

  test('returns the exact Lore ingestion receipt', () => {
    expect(skill).toContain('"status": "succeeded | failed"');
    expect(skill).toContain('"artifactId": "copied exactly from the prompt"');
    expect(skill).toContain('"sourceId": "verified source id"');
    expect(skill).toContain('qualify every page as `<sourceId>:<slug>`');
    expect(skill).toContain('"createdPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"updatedPages": ["<sourceId>:<slug>"]');
    expect(skill).toContain('"verifiedPages": ["<sourceId>:<slug>"]');
    expect(skill).not.toContain('<sourceId>:<slug> created');
  });

  test('supports a zero-mutation scoped proposal with a bounded complete plan', () => {
    expect(skill).toContain('mode: <propose | apply | omit for normal mode>');
    expect(skill).toContain('brain_stage_ingestion_proposal_page');
    expect(skill).toContain('brain_finalize_ingestion_proposal');
    expect(skill).toContain('at most 32 pages');
    expect(skill).toContain('262,144 UTF-8 bytes');
    expect(skill).toContain('{slug,effect:"create",title,bodyMarkdown}');
    expect(skill).toContain('{slug,effect:"update",appendMarkdown}');
    expect(skill).toMatch(/Never send a full update body, title, baseline, or content hash/);
    expect(skill).toMatch(/server freezes the current private baseline/);
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
    expect(skill).toMatch(/Working-context projection or omission\s+markers[\s\S]*never treat them\s+as proof that the original artifact is incomplete/);
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
    expect(skill).toMatch(/never send `slug`, `effect`,\s+`title`, `bodyMarkdown`, `appendMarkdown`, a baseline, or an expected\s+content hash/);
    expect(skill).toMatch(/Do not pre-read or reimplement its compare-and-swap\s+logic with `get_page` or `put_page`/);
    expect(skill).toContain('"proposalSequence": 1');
    expect(skill).toContain('"status": "pending | applied | already_applied | failed"');
    expect(skill).toContain('"previousContentHash":');
    expect(skill).toContain('"appliedContentHash":');
    expect(skill).toContain('"rebased": false');
  });
  test('fails closed for relation effects until they have server-bound proposal operations', () => {
    expect(skill).toMatch(/This operation authorizes pages only/);
    expect(skill).toMatch(/return `failed` without calling generic\s+`add_timeline_entry`, `add_link`, or `put_page`/);
    expect(skill).toMatch(/Never report the proposal fully\s+applied while any planned effect lacks an authorized actionable outcome/);
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
});
