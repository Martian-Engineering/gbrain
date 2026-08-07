import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { getSkillAgentBindings } from '../src/core/skill-catalog.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

const skillsDir = join(import.meta.dir, '..', 'skills');
const skill = readFileSync(
  join(skillsDir, 'granola-meeting-ingestion', 'SKILL.md'),
  'utf8',
);

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
    expect(skill).toContain('version: 1.3.0');
    expect(getSkillAgentBindings(skillsDir, 'granola-meeting-ingestion')).toEqual({
      tools: expectedTools,
      writes_to: expectedPrefixes,
    });
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
    expect(skill).toContain("Lore's local Markdown mirror");
    expect(skill).toContain('Read the source page back with `get_page`');
    expect(skill).toContain('artifact source-record read-back');
    expect(skill).toContain('local-mirror provenance statement');
    expect(skill).not.toContain('the complete transcript Markdown');
    expect(skill).not.toContain('raw-data retrieval');
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
    expect(skill).toContain('admissionScope: <required in propose and apply modes>');
    expect(skill).toContain('In `propose` mode, do not call any corpus-mutating tool');
    expect(skill).toMatch(/`put_page`,\s+`add_link`, or `add_timeline_entry`/);
    expect(skill).toContain('complete set of pages that `apply` will write');
    expect(skill).toContain('full intended `bodyMarkdown`, never a diff');
    expect(skill).toContain('262,144 UTF-8 bytes');
    expect(skill).toMatch(/[Rr]eturn `failed`\s+with an operational summary/);
    expect(skill).toMatch(/Never truncate or split a\s+proposal/);
    expect(skill).toMatch(/must not\s+name or describe the excluded material/);
    expect(skill).toMatch(/local Markdown artifact is the\s+complete verbatim record/);
    expect(skill).toContain('"status": "staged_proposal"');
    expect(skill).toContain('"pageDigests": [');
    expect(skill).toContain('"proposalDigest": "64 lowercase hex characters"');
    expect(skill).toContain('brain_stage_ingestion_proposal_page');
    expect(skill).toContain('Stage only one page per turn');
    expect(skill).toContain('brain_finalize_ingestion_proposal');
    expect(skill).toContain('server derives the ordered');
    expect(skill).not.toContain('ordered\n`page_digests`');
    expect(skill).toContain('"effect": "create | update"');
    expect(skill).toContain('Create entries have');
    expect(skill).toMatch(/Update entries add\s+exactly `baseMarkdown` and `expectedContentHash`/);
    expect(skill).toContain('Omit both fields for a create');
  });

  test('carries bounded timeline and link mutations in the scoped proposal', () => {
    expect(skill).toContain(
      'proposedTimelineEntries: <optional frozen timeline entries in apply mode>',
    );
    expect(skill).toContain('proposedLinks: <optional frozen typed links in apply mode>');
    expect(skill).toMatch(/`proposedTimelineEntries` may contain at most 40 entries/);
    expect(skill).toMatch(/`proposedLinks` may contain at most 40 entries/);
    expect(skill).toMatch(/strict `YYYY-MM-DD` date/);
    expect(skill).toMatch(/`ref` must equal the plan's\s+`capturePageSlug`/);
    expect(skill).toMatch(/`from` must\s+equal a slug in `proposedPages`/);
    expect(skill).toMatch(
      /No proposed page, timeline entry, or link may derive from excluded material/,
    );
    expect(skill).toMatch(
      /timeline entries only for material dated events with the\s+capture-page reference/,
    );
    expect(skill).toMatch(
      /typed links only for\s+relationships that the planned Markdown does not express accurately/,
    );
    expect(skill).toMatch(
      /compact manifest over 262,144 UTF-8 bytes/,
    );
    expect(skill).toContain('"proposedTimelineEntries": [');
    expect(skill).toContain('"refLabel": "meeting capture"');
    expect(skill).toContain('"proposedLinks": [');
    expect(skill).toContain('"type": "discusses"');
    expect(skill).toMatch(
      /cannot be\s+represented by `proposedPages`, `proposedTimelineEntries`, or `proposedLinks`/,
    );

    const [proposalJson] = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)];
    const proposal = JSON.parse(proposalJson![1]!);
    expect(proposal.proposedTimelineEntries).toEqual([
      {
        pageSlug: 'projects/example',
        date: '2026-08-03',
        text: 'material dated event',
        ref: 'sources/granola/example',
        refLabel: 'meeting capture',
      },
    ]);
    expect(proposal.proposedLinks).toEqual([
      { from: 'meetings/example', to: 'projects/example', type: 'discusses' },
    ]);
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
      'updatedPages:', 'verifiedPages:', 'pageResults:', 'slugAdjustments:',
      'timelineResults:', 'linkResults:',
    ]) expect(skill).toContain(field);
    expect(skill).toMatch(/never contains a top-level summary, unresolved list, raw error, or a nested\s+result `error`/);
    expect(skill).toMatch(/Durable GBrain state remains authoritative/);
    expect(skill).toMatch(/never skip a\s+mutation based on the projection alone/);
  });

  test('applies only the frozen plan with resumable page and collision results', () => {
    expect(skill).toContain('proposedPages: <required frozen proposal pages in apply mode>');
    expect(skill).toMatch(/write the supplied title\s+and full body exactly/);
    expect(skill).toContain('slug collision discovered at write time');
    expect(skill).toMatch(/No other plan\s+adjustment is allowed/);
    expect(skill).toMatch(/does not\s+contradict `admissionScope`/);
    expect(skill).toMatch(/Skip a prior `applied` result only after\s+read-back/);
    expect(skill).toContain('"pageResults":');
    expect(skill).toContain(
      '"status": "pending | written | applied | rebased | already_applied | refresh_required | failed"',
    );
    expect(skill).toContain('immediately after a successful mutation');
    expect(skill).toMatch(/Resume a prior `written`\s+result at its recorded actual slug/);
    expect(skill).toContain('"slugAdjustments":');
    expect(skill).toContain('"reason": "slug_collision"');
    expect(skill).toContain('pass its `expectedContentHash` as');
    expect(skill).toContain('Before the first write, read every approved target page');
    expect(skill).toContain('additions-only three-way rebase');
    expect(skill).toMatch(/Never use a model to regenerate, reinterpret, or improve the approved body/);
    expect(skill).toContain('refresh_required');
    expect(skill).toContain('already_applied');
    expect(skill).toContain('rebased');
    expect(skill).toContain('appliedContentHash');
  });

  test('applies frozen timeline and link mutations after pages with resumable results', () => {
    expect(skill).toMatch(
      /Do not begin\s+timeline or link mutations until every proposed page is applied/,
    );
    expect(skill).toMatch(
      /map `pageSlug` to `slug`, `text` to `summary`, and `refLabel` to `ref_label`/,
    );
    expect(skill).toMatch(/map `type` to `link_type`/);
    expect(skill).toMatch(
      /apply every recorded slug adjustment to\s+`pageSlug`, `ref`, `from`, and `to`/,
    );
    expect(skill).toMatch(
      /Read the\s+actual timeline target back with `get_page` and confirm the exact dated entry/,
    );
    expect(skill).toMatch(/Verify the exact edge with both\s+`get_links` and `get_backlinks`/);
    expect(skill).toContain('"timelineResults": [');
    expect(skill).toContain('"linkResults": [');
    expect(skill).toContain('"status": "pending | applied | failed"');
    expect(skill).toMatch(/Retry\s+only `pending` and `failed` timeline or link results/);
    expect(skill).toMatch(
      /Before retrying a\s+`pending` or `failed` timeline result, read the target page and check for the\s+exact frozen entry/,
    );
    expect(skill).toMatch(
      /When that entry is already visible, mark the result\s+`applied` without calling `add_timeline_entry` again/,
    );
    expect(skill).toMatch(
      /Skip a prior `applied`\s+mutation only after its read-back\s+verification still passes/,
    );

    const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)];
    const apply = JSON.parse(examples[3]![1]!);
    expect(apply.timelineResults).toEqual([
      {
        pageSlug: 'projects/example',
        date: '2026-08-03',
        text: 'material dated event',
        ref: 'sources/granola/example',
        refLabel: 'meeting capture',
        status: 'pending | applied | failed',
        error: 'null or compact failure',
      },
    ]);
    expect(apply.linkResults).toEqual([
      {
        from: 'meetings/example',
        to: 'projects/example',
        type: 'discusses',
        status: 'pending | applied | failed',
        error: 'null or compact failure',
      },
    ]);
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

  test('keeps early refresh receipts complete without attempting mutations', () => {
    expect(skill).toMatch(
      /An early `refresh_required` return must still include one `pageResults`,\s+`timelineResults`, and `linkResults` entry per frozen mutation in proposal\s+order/,
    );
    expect(skill).toMatch(
      /Leave every unattempted result `pending` with a null error/,
    );
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

  test('requires rich meeting enrichment before reporting success', () => {
    expect(skill).toContain('Every unambiguous attendee must have a substantive `people/` dossier');
    expect(skill).toContain('Every substantive organization, project, concept, and durable decision');
    expect(skill).toContain('The meeting is not complete until every resolved entity dossier');
    expect(skill).toContain('Every page created or updated during enrichment must appear');
    expect(skill).toContain('Check `get_links`');
    expect(skill).toContain('Check `get_backlinks`');
    expect(skill).not.toContain('For each notable, unambiguous attendee');
  });
});
