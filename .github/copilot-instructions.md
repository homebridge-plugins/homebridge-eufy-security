# Copilot instructions

Read and follow root [`AGENTS.md`](../AGENTS.md). It is the normative source for architecture, code
practice, verification, and contribution workflow.

Before device-mapping work, also read root [`CONTEXT.md`](../CONTEXT.md) and relevant decisions under
[`docs/adr/`](../docs/adr/). Never restore `eufy-security-client` APIs or infer HomeKit representation
from an SDK member's primitive shape.

Run `npm run verify` before proposing a change. Do not edit generated `src/version.ts`, include real
device/account data, or add `Co-authored-by` trailers automatically.
