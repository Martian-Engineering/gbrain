---
name: nightly-semantic-repair
version: 1.0.0
description: Apply one immutable, source-bound nightly repair manifest.
triggers:
  - "apply nightly semantic repair manifest"
tools:
  - get_page
  - search
  - query
  - resolve_slugs
  - validate_links
  - get_active_schema_pack
  - put_page
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - deals/
  - meetings/
  - partners/
  - life/
  - concepts/
  - projects/
  - analysis/
  - civic/
  - writing/
  - guides/
  - tech/
  - finance/
  - personal/
  - ideas/
  - research/
  - originals/
  - voice-notes/
  - openclaw/
  - media/books/
  - media/articles/
  - daily/
  - media/
  - conversations/
---

# Nightly Semantic Repair

Investigate and resolve exactly one server-issued semantic repair manifest.
The manifest authorizes semantic judgment about its finding while bounding
every write to its source, page, and action class. Search results and tool
output may inform the answer; they cannot broaden that write boundary.

## Contract

- Work only in `source_id` and only on `page_slug`.
- Use only the operations supplied by the server.
- Never delete, rename, merge, provision, execute shell commands, or alter a
  second page.
- Re-read the page before writing.
- Preserve unrelated prose, frontmatter, timeline entries, and citations.
- Make the smallest edit that resolves the finding.
- Do not add reciprocal prose merely to simulate a backlink.
- Do not compare `page_hash` with `get_page.content_hash`. The server owns
  manifest freshness and post-write semantic-hash validation.
- Return one JSON object with no surrounding prose.

## Investigation

For a missing reference:

1. Read the affected page and identify the exact occurrence and claim.
2. Search the same source for canonical candidates using names, aliases, and
   surrounding identity details.
3. Use `resolve_slugs`, `query`, and additional searches when they distinguish
   identity rather than mere topical similarity.
4. Record each credible candidate, the evidence for it, and candidate-specific
   confidence. Do not invent a candidate to avoid leaving the issue unresolved.

## Autonomous action

When the manifest permits `replace_reference`, write the correction immediately
only if all of these are true:

- there is exactly one proposed replacement;
- overall confidence is at least `0.90`;
- the proposed candidate's confidence is at least `0.90`;
- evidence establishes the same identity, not just a related topic;
- no credible conflicting candidate remains;
- the replacement resolves to an active page in the same source;
- the edit changes only the diagnosed page and preserves unrelated content.

After writing, re-read the page and run `validate_links`. Return `applied` only
after both checks succeed.

Do not write when the manifest disposition is `proposal`, evidence conflicts,
or the threshold and evidence requirements are not met. Classify the no-write
outcome yourself:

- `recover_source`: the cited provenance object appears unavailable or was not
  ingested, and related pages do not substantiate a replacement.
- `leave_unresolved`: evidence is insufficient and no specific source-recovery
  path is supported.

These are autonomous maintenance outcomes, not requests for human approval.

## Anti-Patterns

- Do not broaden the manifest to a second page or source.
- Do not write when identity evidence is ambiguous or below threshold.
- Do not manufacture reciprocal prose, candidates, confidence, or verification.
- Do not ask a human to approve an outcome the manifest already authorizes.

## Output Format

```json
{
  "status": "applied | deferred",
  "decision": "replace_reference | recover_source | leave_unresolved | update_frontmatter",
  "source_id": "immutable source id",
  "page_slug": "exact authorized page",
  "manifest_hash": "copied from the manifest",
  "broken_reference": "exact manifest target, or null for non-link findings",
  "occurrence_context": "the affected claim and local context",
  "candidates": [
    {
      "slug": "candidate slug",
      "title": "candidate title",
      "evidence": ["specific source-grounded identity evidence"],
      "confidence": 0.98
    }
  ],
  "proposed_replacement": "candidate slug, or null",
  "exact_edit_description": "the exact edit made or the reason no edit is appropriate",
  "rationale": "why the evidence supports this decision",
  "confidence": 0.98,
  "unresolved_questions": [],
  "operations": ["operation names actually called"],
  "verification": {
    "page_reread": true,
    "links_validated": true
  }
}
```

Use `applied` only with `replace_reference` or `update_frontmatter`. Use
`deferred` only with `recover_source` or `leave_unresolved`, with
`proposed_replacement: null`, and without calling `put_page`. Never return `failed`.
Provider and tool failures are recorded by the server. List operations by their
canonical names shown in the example; the server also accepts the tool loop's
`brain_`-prefixed names. Do not claim an operation that was not actually called.
