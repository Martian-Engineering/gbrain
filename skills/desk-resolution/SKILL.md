---
name: desk-resolution
version: 1.0.0
description: |
  Resolve a Lore desk item (a chronicle commitment or open loop) on behalf of
  a person, as an agent. The recipe is two writes: a desk tag on every event
  page in the group, and one attestation timeline entry on the source meeting
  page naming the principal you act for. Use when your principal asks you to
  mark a commitment done or let it go.
triggers:
  - "mark that done"
  - "mark it done on my desk"
  - "let that one go"
  - "resolve the commitment"
  - "clear that off the desk"
tools:
  - whoami
  - chronicle_since
  - get_page
  - add_tag
  - add_timeline_entry
mutating: true
---

# Desk resolution for agents

Lore's "On your desk" view derives open loops from chronicle events
(`life/events/*` pages, kinds like commitment). A desk item is settled by
brain state, not app state, so an agent can settle one with the same two
writes the Lore interface makes. Lore renders the result identically either
way.

## Who you act for

Call `whoami` first. Your OAuth client's `bound_principal` (e.g.
`people/josh-lehman`) is the person you act for. If `bound_principal` is
null, you are not bound to a person: stop and ask your operator rather than
attesting on someone's behalf.

## The two writes

For the event group you are settling (the item's event page slugs — often
one, sometimes several near-duplicates sharing the same source meeting):

1. **Tag every event page in the group.** One `add_tag` per event slug:
   - done: tag `desk:done`
   - let go: tag `desk:let-go`

2. **One attestation on the source page.** The event page's frontmatter
   (`event.source_page` or the `depth` slug) names the meeting page the
   event was extracted from. Add a timeline entry there:

   - `date`: today (YYYY-MM-DD)
   - `summary`: `Marked done — <principal name> asked; settled by <your
     client_name> ([[<bound_principal>]]).` For let-go, start with
     `Let go —` instead. The wiki-link to the person page is required: it
     places the attestation in the principal's backlink graph.
   - `detail`: `attested via <your client_name> for <bound_principal>`
   - `source`: `lore-agent-attestation`

Both writes support `dry_run: true`; preview both before committing, and
commit only when both previews succeed.

## Undo

Remove the `desk:done` / `desk:let-go` tag from every event slug in the
group (`remove_tag`). Timeline attestations are append-only history; do not
delete them — add a new entry noting the reversal if your principal asks.

## What not to do

- Never attest as the person ("Marked done by Josh") — you are the agent,
  and the summary must say the settlement came through you.
- Never settle an item your principal did not name; desk state is shared
  and other viewers see it change.
- Do not edit the event or meeting page bodies; tags and timeline entries
  are the whole contract.
