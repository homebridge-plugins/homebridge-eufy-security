# Contributing

Thanks for helping. This file covers setup, development workflow, and pull requests. Architecture and
code rules are in [AGENTS.md](./AGENTS.md); read them before changing the plugin.

## License

The project is licensed under [Apache-2.0](./LICENSE). By opening a pull request, you agree that your
contribution is provided under the same license.

## Setup

```bash
nvm use
npm install
npm run verify
```

Node 24.5.0 or newer is required. `npm run verify` runs the same local quality gate expected before a
pull request: formatting, the guard against restoring `eufy-security-client`, the build, and the
hermetic Vitest contracts.

## Architecture

The SDK owns verified Eufy device truth and transport behavior. This plugin owns Homebridge lifecycle
and HomeKit representation. Use explicit capability and bundle adapters; do not infer services from
primitive SDK shapes and do not bypass evidence-gated SDK operations.

The current vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Development workflow

- Start from the active `beta-X.Y.Z` branch and open the pull request against that branch unless a
  maintainer says otherwise.
- Use Conventional Commits.
- Keep each change focused and run `npm run verify` before requesting review.
- Do not add `Co-authored-by` trailers automatically.
- Explain new runtime dependencies, including why existing dependencies or `node:*` APIs are
  insufficient and what transitive/audit cost is introduced.
- Treat real-device access as read-only unless the owner explicitly approves a write operation.

### Live camera snapshot qualification

`npm run verify` stays hermetic, so HomeKit-initiated snapshots are qualified separately by
`scripts/live-hap-snapshot-check.mjs`. It pairs one temporary HAP controller against a dedicated,
unpaired Homebridge instance running this plugin, issues real snapshot resource requests, checks the
retained last successful images on disk, and removes its own pairing. The script header states the
prerequisites, including why a production bridge cannot be used and how to provide `hap-controller`
without changing this repository's lockfile.

Record the result with the live acceptance evidence for the change. A live acquisition wakes a camera,
so the script uses wired cameras unless `--battery` is passed.

## Pull requests

Keep the body concise and developer-focused:

- what changed and why;
- what was verified;
- device, Homebridge, or Home app evidence used;
- anything unverified, intentionally omitted, or deferred;
- migration or release impact.

Never include real serials, P2P identifiers, account or user IDs, device names, addresses,
credentials, tokens, keys, logs, or captures. Use synthetic placeholders and review the diff before
submission.

## Release notes

Release notes are for users. Put required actions, compatibility changes, removed settings, and
behavior changes first. Avoid internal milestones and implementation detail.

## Working with AI agents

- Point the agent at [AGENTS.md](./AGENTS.md), [CONTEXT.md](./CONTEXT.md), and relevant ADRs.
- Verify every claimed SDK symbol and behavior against the current checkout.
- Do not let an agent infer protocol behavior from an older third-party Eufy client.
- Review generated output for secrets, real device data, incompatible code, and unsupported claims.
- The contributor remains responsible for every submitted line.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](./SECURITY.md).
