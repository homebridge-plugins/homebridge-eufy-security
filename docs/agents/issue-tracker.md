# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI for all operations and
infer the repository from the current clone.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
- Close: `gh issue close <number> --comment "..."`
- Pull requests are not a triage request surface.

## Publishing and fetching

When a skill says to publish a spec or ticket, create a GitHub issue. When it asks for the relevant
ticket, read the issue and its comments. GitHub shares one number space between issues and pull
requests, so resolve ambiguous references before acting.

## Wayfinding operations

- A map is an issue labelled `wayfinder:map`.
- Tickets are child issues labelled `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Use GitHub sub-issues for parent/child relationships and native issue dependencies for blocking.
- The frontier is the map's open, unblocked, unassigned child issues in issue order.
- Claim a ticket before work with `gh issue edit <number> --add-assignee @me`.
- Resolve by posting the answer as a comment, closing the ticket, and appending a linked one-line gist
  to the map's Decisions-so-far section.
- If native relationships are unavailable, use a map task list and `Blocked by:` body lines as the
  fallback.
