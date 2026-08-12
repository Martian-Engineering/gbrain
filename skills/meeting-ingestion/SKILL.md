---
name: meeting-ingestion
version: 1.1.0
description: |
  Ingest meeting transcripts into brain pages with attendee provenance,
  evidence-driven entity enrichment, and timeline merge.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Meeting page created with attendees, summary, key decisions, action items
- Every confidently resolved attendee is linked from the meeting page
- Every confidently resolved attendee gets a dated attendance timeline entry
- Dossier pages are created or rewritten only when the admitted evidence
  materially improves their current best synthesis
- Material dated events propagate to the affected entity timelines
- Back-links created bidirectionally

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every confidently resolved attendee MUST get a meeting-page link whose inverse
is visible from the attendee page. A resolved attendee without that graph edge
is a broken brain. Link other entities when the meeting establishes a useful
relationship, not merely because their names appear in passing.

## Phases

### Phase 1: Parse the transcript

Extract from the transcript:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

### Phase 2: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context}

## Action Items
{Tasks with owners and deadlines}

## Discussion Notes
{Structured notes by topic}
```

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If identity is ambiguous → leave the attendee unresolved rather than
   guessing or creating a duplicate.
3. If NO page exists → create one via the enrich skill only when the admitted
   evidence establishes enough identity and useful context for a real dossier.
   Do not create a name-only attendee stub.
4. If YES → read the current page. Rewrite its complete compiled truth with
   `put_page` only when the admitted meeting evidence materially improves the
   current best synthesis. Otherwise leave the page body unchanged.
5. Link every confidently resolved attendee from the meeting page. If resolving
   an attendee changes the meeting page, rewrite the complete meeting page.
6. Add a timeline entry on every confidently resolved attendee's page,
   independently of whether the dossier body changed:
   `gbrain timeline-add <person-slug> <date> "Attended <meeting-title>"`

**Note (v0.10.1):** Once the meeting page is written via `gbrain put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `gbrain link` for attendees. You DO still need `gbrain timeline-add`
for dated events (auto-link only handles links, not timeline entries).

### Phase 4: Entity propagation (MANDATORY)

For each company, project, or concept discussed:
1. Check brain for existing page
2. Create or rewrite its complete page only when the admitted evidence
   materially improves the current best synthesis
3. Add a timeline entry only for a material dated event, not a passing mention
4. Link it to the meeting when the meeting establishes a useful relationship

### Phase 5: Timeline merge

Attendance appears on every confidently resolved attendee's timeline. Other
material dated events appear on each affected entity's timeline. A passing
mention alone does not justify a timeline entry or dossier rewrite.

### Phase 6: Sync

`gbrain sync` to update the index.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees linked, {N}
attendance events recorded, {N} dossiers updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without resolving and linking identifiable attendees
- Rewriting an attendee dossier solely to record attendance
- Skipping an attendance timeline entry because the dossier body did not change
- Adding timeline entries or dossier prose for passing entity mentions
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking confidently resolved participants
