# Nightly actionable repair proposals

## Objective

Make the GBrain nightly worker produce reviewable semantic-repair decisions
with the quality demonstrated by the controlled Terra/high corpus sample.

The worker must:

- identify a unique canonical replacement and the exact edit when evidence
  supports one;
- distinguish a missing source from a replaceable reference;
- retain candidate evidence, confidence, rationale, and unresolved questions;
- support an operator proposal-only run with zero page writes;
- keep recurring nightly operation write-enabled;
- charge every run mode to the same 1,500-cent UTC-day budget.

The first production acceptance corpus is the three unresolved references in
the `martian` source on 2026-07-28:

1. `companies/lucky-strike-entertainment` should propose
   `companies/lucky-strike`.
2. The missing Michael onboarding meeting should recommend source recovery.
3. Gmail thread `199e999cef850b78` should recommend source recovery.

## Tech stack

- Bun and TypeScript
- Existing Minions PostgreSQL/PGLite job and progress storage
- Existing GBrain gateway-native agent loop
- `openai:gpt-5.6-terra` with `high` reasoning
- Existing shared spend reservation and settlement ledger

No dependency changes are permitted.

## Commands

Focused tests:

```sh
bun test \
  test/nightly-maintenance-contract.test.ts \
  test/nightly-repair-agent.test.ts \
  test/nightly-maintenance-handler.test.ts \
  test/nightly-semantic-repair-skill.test.ts
```

Type check:

```sh
bun run typecheck
```

Repository validation:

```sh
bun run check:all
```

Controlled proposal-only production run:

```sh
gbrain jobs nightly-maintenance \
  --mode proposal-only \
  --request-id operator-review-YYYYMMDD-HHMM \
  --sources martian \
  --budget-cents 1500 \
  --max-page-mutations 10
```

The exact CLI spelling above is part of this specification.

## Project structure

- `src/core/minions/nightly-maintenance.ts`
  - run mode, run identity, shared budget identity, report types
- `src/core/minions/handlers/nightly-repair-agent.ts`
  - decision parsing, tool fence, verification, child receipt
- `src/core/minions/handlers/nightly-maintenance.ts`
  - root orchestration, checkpointing, durable decision reporting
- `src/commands/jobs.ts`
  - operator CLI flags
- `skills/nightly-semantic-repair/SKILL.md`
  - agent research and output contract
- `test/nightly-*.test.ts`
  - contract, child, root, and skill regression coverage
- `docs/guides/nightly-maintenance.md`
  - operator workflow

## Code style

Use explicit discriminated unions and small validators. The decision contract
must make invalid combinations unrepresentable after parsing.

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

## Behavioral contract

### Run identity

`NightlyMaintenanceInput` gains:

```ts
mode: 'apply' | 'proposal_only';
request_id: string | null;
```

- Timer/default mode is `apply`.
- `proposal_only` requires an operator-supplied request ID.
- Apply run ID remains `nightly-maintenance:<UTC date>`.
- Preview run ID is
  `nightly-maintenance:<UTC date>:proposal:<request-id>`.
- Every mode uses budget client
  `nightly-maintenance:<UTC date>`.
- Request IDs are bounded safe identifiers and cannot contain `:` or path
  separators.

Thus a preview does not collide with the scheduled root, while repeated
experiments cannot obtain another daily allowance.

### Decision schema

Every semantic child returns a strict JSON receipt containing:

```json
{
  "status": "applied | proposal | failed",
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
  "unresolved_questions": []
}
```

The server validates:

- immutable source, page, and manifest identity;
- supported status and decision combinations;
- confidence values in `[0, 1]`;
- bounded candidate and evidence counts;
- bounded string sizes;
- source-local candidate existence for `replace_reference`;
- `proposed_replacement` is present only for `replace_reference`;
- the replacement appears among the candidate slugs;
- the broken reference matches the manifest finding.

The normalized decision is retained in:

- the child result;
- `progress.semantic_receipts`;
- the semantic-repair checkpoint summary;
- the final root report.

### Proposal-only mode

- Semantic children receive read tools only.
- `put_page` and every other write operation are absent.
- The child researches each finding even when its normal manifest disposition
  is `repair`.
- An unchanged page plus a valid decision is a passed semantic outcome.
- The handler does not create a page version/snapshot in this mode.
- Root deterministic link repair remains non-semantic and may continue its
  existing safe behavior; the acceptance corpus is captured after that phase.
- The root report states `mode: proposal_only` and records zero semantic page
  mutations.

### Apply mode

- Preserve exact source and page tool fences.
- Preserve prewrite version capture, rollback, and deterministic post-write
  verification.
- The agent researches before choosing whether to write.
- `applied` must include the same evidence-rich decision that justified the
  edit.
- A valid `recover_source` or `leave_unresolved` decision with no mutation is
  retained as a passed proposal outcome, not reported as
  `failed_rolled_back`.
- Manifest freshness is an authoritative server precondition. The skill tells
  the model not to compare the manifest semantic hash to `get_page`'s
  `content_hash`.

### Outcome taxonomy

- `replace_reference`
  - one concrete replacement and exact edit;
  - usable as a future Lore approval card;
  - apply mode may write when the agent determines the evidence is unique.
- `recover_source`
  - the original provenance object appears missing or was not ingested;
  - no page rewrite;
  - future Lore presentation is maintenance work, not content approval.
- `leave_unresolved`
  - no safe replacement and no specific recoverable source;
  - retained in diagnostics, not promoted as a review card.
- `update_frontmatter`
  - concrete frontmatter correction governed by existing validation.

## Testing strategy

Use TDD and keep the focused tests small.

1. Contract tests:
   - preview run and scheduled run have different run IDs;
   - both use the same daily budget client ID;
   - proposal-only requires a safe request ID;
   - default mode remains apply.
2. Receipt parser tests:
   - normalize a unique replacement result;
   - normalize source-recovery and unresolved results;
   - reject invalid confidence, oversized evidence, mismatched identity, and
     invalid decision/status combinations.
3. Child tests:
   - proposal-only receives no write tool;
   - proposal-only creates no snapshot and accepts an unchanged page;
   - apply mode preserves write verification and rollback;
   - apply-mode recovery is retained without false rollback failure.
4. Root tests:
   - full decisions survive checkpoints and retries;
   - proposal counts and decisions appear in the final report;
   - a retry does not resubmit a completed manifest.
5. Skill tests:
   - require candidate evidence and exact edits;
   - explain the server-owned semantic hash;
   - distinguish source recovery from replacement.
6. Production acceptance:
   - deploy with the timer disabled;
   - run `proposal-only` against `martian`;
   - confirm all three expected outcome classes;
   - confirm zero page hash changes;
   - confirm settled plus pending spend never exceeds 1,500 cents.

## Boundaries

Always:

- retain the existing source/page/tool fences;
- reserve budget before every paid call;
- persist receipts after each completed child;
- validate all model output before reporting it;
- keep proposal-only mode unable to write by construction.

Ask first:

- adding a new database table;
- enabling the recurring timer;
- automatically running Gmail or Granola re-ingestion;
- changing the `$15` limit or ten-page mutation ceiling.

Never:

- trust model-reported confidence without retaining its evidence;
- let a request ID create a new daily budget identity;
- allow proposal-only mode to receive `put_page`;
- replace a provenance link with a merely related source;
- hide missing-source conditions by removing citations automatically.

## Success criteria

- GBrain's own worker produces materially equivalent decisions to the
  controlled Codex sample for the three live findings.
- Lucky Strike yields a concrete `replace_reference` decision for
  `companies/lucky-strike`.
- The unavailable Granola meeting and Gmail thread yield `recover_source`.
- No semantic page is written during the controlled proposal-only run.
- The root report retains all candidates, evidence, exact edits, rationale,
  confidence, and questions.
- The run uses Terra/high through the GBrain gateway loop.
- UTC-day GBrain model spend remains at or below `$15`.

## Open questions

None required for implementation. Automated source recovery and Lore
presentation remain separate follow-up work.
