# Claude guidance

Read and follow root [`AGENTS.md`](../AGENTS.md) before changing this repository. It is the normative
source for architecture, code practice, verification, and workflow.

Read root [`CONTEXT.md`](../CONTEXT.md) and relevant files under [`docs/adr/`](../docs/adr/) before
device-mapping work. The SDK owns verified Eufy device truth; the plugin owns HomeKit representation.

Repository-specific reminders:

- Work from the active beta branch and target pull requests to it.
- Use Conventional Commits and do not add `Co-authored-by` trailers automatically.
- Run `npm run verify` before review.
- `src/version.ts` is generated and must not be edited manually.
- Diagnostics and real-device data are sensitive; use synthetic values in committed material.
- Existing skills under `.claude/skills/` may contain V4 or `eufy-security-client` assumptions. Treat
  `AGENTS.md`, `CONTEXT.md`, and current ADRs as authoritative when they conflict.
