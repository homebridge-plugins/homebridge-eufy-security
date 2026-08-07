# Domain docs

This is a single-context repository.

## Before exploring

- Read root [CONTEXT.md](../../CONTEXT.md) for canonical vocabulary.
- Read relevant decisions under [`docs/adr/`](../adr/), beginning with
  [Explicit capability adapters](../adr/0001-explicit-capability-adapters.md) for device mapping work.
- If a document is absent, proceed silently. Domain documents are created only when a term or durable
  decision is resolved.

## Rules

- Use the glossary's terms in issue titles, specifications, tests, and code.
- Do not use an avoided synonym where the glossary defines a canonical term.
- Surface conflicts with an ADR explicitly rather than silently overriding it.
- Keep `CONTEXT.md` implementation-free. It defines domain language, not plans or code structure.
