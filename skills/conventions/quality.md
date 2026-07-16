# Quality Convention

Cross-cutting quality rules for all brain-writing skills.

## Citations (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

- **User's statements:** `[Source: User, {context}, YYYY-MM-DD]`
- **Meeting data:** `[Source: Meeting "{title}", YYYY-MM-DD]`
- **Email/message:** `[Source: email from {name} re: {subject}, YYYY-MM-DD]`
- **Web content:** `[Source: {publication}, {URL}, YYYY-MM-DD]`
- **Social media:** `[Source: X/@handle, YYYY-MM-DD](URL)`
- **Synthesis:** `[Source: compiled from {sources}]`

### Source precedence (highest to lowest)

1. User's direct statements (highest authority)
2. Compiled truth (brain's synthesized understanding)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search)

## Back-Linking (MANDATORY)

Every explicit reference to a brain page MUST resolve, produce a graph edge,
and be discoverable from the target through `get_backlinks`. This is reverse
navigation over one canonical edge; it does not require a duplicate reverse
edge or reciprocal Markdown.

Add a dated entry to an entity's Timeline only when the source records a
material event or changes the durable understanding of that entity. Ordinary
mentions, raw artifacts, and routine attendance remain graph-discoverable
without becoming mechanical dossier prose.

Use `gbrain check-backlinks check` for the graph invariant. The legacy
reciprocal-Markdown audit remains available as `--materialized`.

## Notability Gate

Before creating a new brain page, check notability:

- **People:** Will you interact again? Relevant to work/interests?
- **Companies:** Relevant to work/investments/interests?
- **Concepts:** Reusable mental model? Worth referencing again?

When in doubt, DON'T create. A 400-follower person who tweeted once is not notable.
