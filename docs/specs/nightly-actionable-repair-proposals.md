# Autonomous nightly semantic repair

## Objective

Make the GBrain nightly worker autonomously investigate and correct corpus
findings with `openai:gpt-5.6-terra` at `high` reasoning.

The agent may choose a replacement using normal source-scoped GBrain tools.
The manifest bounds the finding, source, page, and action class; it does not
need to name the semantic answer in advance.

The worker must:

- apply high-confidence, evidence-supported corrections immediately;
- preserve exact source and page write fences;
- retain the agent's evidence and decision in the nightly report;
- independently validate every page mutation and roll it back on failure;
- record missing-source and unresolved outcomes without requesting review;
- keep total model spend at or below 1,500 cents per UTC day.

The first production acceptance corpus is the three unresolved references in
the `martian` source on 2026-07-28:

1. `companies/lucky-strike-entertainment` should be replaced with
   `companies/lucky-strike`.
2. The missing Michael onboarding meeting should be classified
   `recover_source` without repointing its citation.
3. Gmail thread `199e999cef850b78` should be classified `recover_source`
   without repointing its five citations.

## Tech stack

- Bun and TypeScript
- Existing Minions PostgreSQL/PGLite job and progress storage
- Existing GBrain gateway-native agent loop
- Existing nightly spend reservation and settlement ledger
- Existing page-version, deterministic link-validation, lint, and rollback
  paths

No dependency or database-schema changes are permitted.

## Commands

Focused tests:

```sh
bun test \
  test/nightly-repair-decision.test.ts \
  test/nightly-repair-agent.test.ts \
  test/nightly-maintenance-handler.test.ts \
  test/nightly-semantic-repair-skill.test.ts
```

Type check and repository validation:

```sh
bun run typecheck
bun run check:all
```

Controlled production run, with the recurring timer disabled:

```sh
gbrain jobs nightly-maintenance \
  --sources martian \
  --budget-cents 1500 \
  --max-page-mutations 10
```

## Project structure

- `src/core/minions/nightly-repair-decision.ts`
  - strict model-output validation and normalized decision types
- `src/core/minions/nightly-maintenance.ts`
  - durable receipt and report types
- `src/core/minions/handlers/nightly-repair-agent.ts`
  - tool fence, autonomous execution, verification, rollback, receipts
- `skills/nightly-semantic-repair/SKILL.md`
  - investigation, action, confidence, and output contract
- `test/nightly-repair-decision.test.ts`
  - decision-parser contract tests
- `test/nightly-repair-agent.test.ts`
  - autonomous write/defer/rollback tests
- `test/nightly-semantic-repair-skill.test.ts`
  - agent instruction regression tests
- `docs/guides/nightly-maintenance.md`
  - operator workflow and outcome taxonomy

## Code style

Use explicit discriminated unions and small validators. Invalid model output
must not reach verification or reporting.

```ts
export type NightlyRepairDecision =
  | {
      kind: 'replace_reference';
      broken_reference: string;
      proposed_replacement: string;
      candidates: NightlyRepairCandidate[];
    }
  | {
      kind: 'recover_source' | 'leave_unresolved';
      broken_reference: string;
      proposed_replacement: null;
      candidates: NightlyRepairCandidate[];
    };
```

Public functions and types require purpose-oriented docstrings. Private
validators require comments when their contract is not evident from the name.
Do not disable lint rules.

## Decision contract

Every semantic child returns one JSON object:

```json
{
  "status": "applied | deferred | failed",
  "decision": "replace_reference | recover_source | leave_unresolved | update_frontmatter",
  "source_id": "martian",
  "page_slug": "people/michael-noronha",
  "manifest_hash": "server-issued hash",
  "broken_reference": "companies/lucky-strike-entertainment",
  "occurrence_context": "bounded excerpt",
  "candidates": [
    {
      "slug": "companies/lucky-strike",
      "title": "Lucky Strike",
      "evidence": [
        "Active company page for the same Connected Play customer"
      ],
      "confidence": 0.99
    }
  ],
  "proposed_replacement": "companies/lucky-strike",
  "exact_edit_description": "Replace only the link target.",
  "rationale": "Why this is the canonical entity.",
  "confidence": 0.99,
  "unresolved_questions": [],
  "operations": ["get_page", "search", "put_page", "validate_links"],
  "verification": {
    "page_reread": true,
    "links_validated": true
  }
}
```

The server validates:

- immutable source, page, manifest, and broken-reference identity;
- supported status and decision combinations;
- confidence values in `[0, 1]`;
- bounded candidate, evidence, operation, and question counts;
- bounded string sizes;
- `proposed_replacement` is present only for `replace_reference`;
- the replacement appears among the candidate slugs;
- `applied` is permitted only for a write decision;
- `recover_source` and `leave_unresolved` are always no-write outcomes.

The complete normalized decision is retained in the child result, root
checkpoint, and final nightly report.

## Autonomous action policy

The initial automatic threshold is `0.90`.

For `replace_reference`, the agent may write only when:

- it recommends exactly one replacement;
- its overall confidence is at least `0.90`;
- the replacement is present in its candidate evidence;
- evidence supports identity, not merely topical similarity;
- no credible conflicting candidate remains;
- the target page is active and visible in the same source;
- the edit changes only the diagnosed page and preserves unrelated content.

The numerical threshold is necessary but not sufficient. The server also
requires the original broken reference to disappear, the resulting references
to validate, the semantic page hash to change, and frontmatter lint to pass.
Any failed check restores the complete pre-write snapshot.

The agent must return:

- `applied + replace_reference` after a successful high-confidence write;
- `deferred + recover_source` when the cited source itself is unavailable and
  related pages do not substantiate the claim;
- `deferred + leave_unresolved` when evidence is insufficient and no specific
  source-recovery path is supported;
- `failed` only for an execution failure rather than a semantic abstention.

No outcome requires human approval. Deferred outcomes remain visible in the
maintenance report and can become inputs to future recovery automation.

## Tool contract

For repair-disposition link manifests, the child receives:

- `get_page`
- `search`
- `query`
- `resolve_slugs`
- `validate_links`
- `get_active_schema_pack`
- `put_page`

The child is bound to the finding's source and exact affected page slug.
Search and read results may inform the semantic choice; they do not permit
writing another page.

For ambiguous, blocked, or graph-parity manifests, `put_page` remains absent.

The current slice does not add Gmail or Granola connector operations to the
agent allowlist. Those cases are classified autonomously as `recover_source`;
executing recovery is separate follow-up work because normal GBrain agent
tools cannot currently perform provider re-ingestion.

## Hash ownership

The server verifies manifest freshness before the agent runs and verifies the
semantic page hash after it runs. The agent must not compare the manifest's
semantic hash with `get_page.content_hash`; they are not an agent-side
authorization check.

## Testing strategy

Use test-driven development.

1. Decision parser:
   - normalize a unique high-confidence replacement;
   - normalize source-recovery and unresolved outcomes;
   - reject low-confidence `applied`, invalid candidates, oversized evidence,
     and mismatched identity.
2. Child handler:
   - Terra/high receives normal research tools and exact-page `put_page`;
   - high-confidence applied repair passes deterministic verification;
   - source recovery with an unchanged page is retained as a passed outcome;
   - low-confidence or malformed applied output rolls back;
   - cost is reserved and settled through the shared nightly ledger.
3. Root handler:
   - complete decisions survive checkpoints and retries;
   - a completed manifest does not trigger a second paid call;
   - deferred outcomes do not consume the mutation limit;
   - final report retains the complete decision.
4. Skill:
   - explicitly authorizes evidence-based semantic choice;
   - requires immediate application when the policy is satisfied;
   - distinguishes missing-source recovery from replacement;
   - forbids model-side hash comparison.
5. Production:
   - run with the timer disabled;
   - inspect every changed page and deferred result;
   - confirm the Lucky Strike edit survives validation;
   - confirm both missing provenance targets are not repointed;
   - confirm actual plus reserved spend stays within 1,500 cents.

## Boundaries

Always:

- reserve budget before every paid call;
- retain source and exact-page write fences;
- snapshot before any potentially writing agent;
- validate model output before trusting its status;
- verify and roll back every mutation;
- preserve complete agent evidence in the report.

Ask first:

- adding provider-specific source-recovery operations;
- enabling the recurring timer;
- changing the `$15` limit, confidence threshold, or mutation ceiling;
- adding a database table or dependency.

Never:

- use raw confidence as the only condition for retaining a write;
- replace provenance with a merely related source;
- let tool results broaden the writable source or page;
- report semantic abstention as an execution failure;
- hide missing-source conditions by deleting citations automatically.

## Success criteria

- GBrain's own nightly worker produces materially equivalent decisions to the
  controlled Codex sample.
- Lucky Strike is corrected automatically to `companies/lucky-strike`.
- The unavailable Granola meeting and Gmail thread are classified
  `recover_source` without page mutation.
- Every retained mutation passes source, hash, link, and schema validation.
- Every failed mutation is restored from its pre-write snapshot.
- The report retains candidates, evidence, exact edits, rationale, confidence,
  questions, operations, and verification.
- The run uses Terra/high and total UTC-day GBrain model spend remains at or
  below `$15`.

## Open questions

Provider-specific automatic source recovery remains follow-up work. It is not
required for autonomous high-confidence page correction.
