# Qualify the live authentication handoff

This procedure qualifies one real handoff of a dedicated guest account from temporary custom-UI
authentication to the long-lived Homebridge runtime. It is the live tier of
[the authentication lifecycle](/reference/authentication-lifecycle); the hermetic tier lives in
`test/contracts/`.

Run it when a beta changes authentication, ownership, session persistence, or the custom UI's login
flow. It requires a maintainer: every acceptance criterion needs a real account, an interactive
captcha or two-factor challenge, and a human judgement about what reached the logs.

## What is already proven without a live account

Do not re-derive these by hand. They are asserted hermetically and run in `npm run verify`:

| Claim | Contract |
| --- | --- |
| Credentials cannot cross into the runtime process | `test/contracts/architecture-boundaries.test.ts` |
| A failed login collapses to `failed` and discards the underlying error | `test/contracts/temporary-authentication.test.ts` |
| Malformed login and challenge payloads are refused without echoing the input | `test/contracts/ui-server-input.test.ts` |
| Advisory runtime evidence publishes a closed, credential-free record | `test/contracts/runtime-tracker.test.ts` |
| A live lease is refused, never stolen, across real processes | `test/contracts/account-ownership.test.ts` |
| A restart acquires ownership once and publishes a complete snapshot | `test/contracts/runtime-owner.test.ts` |
| The handoff reaches no device-write operation | `test/contracts/temporary-authentication.test.ts` |
| Session storage is owner-only | `test/contracts/session-persistence.test.ts` |

The live run exists to qualify what a fake cannot: that a real captcha or two-factor exchange leaks
nothing through the SDK's own logging, that a real persisted session is restored on restart without a
second remote login, and that a real fleet discovers completely.

## Prerequisites

- A **dedicated guest account**, not the home owner's account. See
  [Dedicated account](/guide/dedicated-account).
- A **throwaway Homebridge instance**. This procedure replaces the active Eufy account of whatever
  instance it runs against, so it must not run against a production service. The wizard refuses a
  production storage root outright.
- **Every other Homebridge instance stopped.** An ownership lease lives inside one storage root, so two
  instances with different roots cannot refuse each other the account even when they share one Eufy
  account. Authenticating while another instance holds that account's session creates two realtime
  owners, and the session the other instance restored can be invalidated underneath it. The wizard
  checks this before provisioning and again before the login, and refuses rather than warns.

  ```bash
  sudo systemctl stop homebridge     # or: hb-service stop
  ```

  Start it again when the qualification finishes. If you would rather leave your service running, use a
  second guest account instead, distinct from the one your service authenticated.
- A built checkout. The evidence harness imports the shipped ownership implementation from `dist/`,
  because a reimplementation would not qualify the lease the plugin actually takes.

## Run the wizard

```bash
npm run build
scripts/qualify-authentication-handoff.sh
```

The wizard walks the ten stages below, gates each acceptance criterion on a check it runs for you, and
writes a redacted report you can paste into the issue. Override the defaults with
`EUFY_QUALIFICATION_DIR`, `EUFY_QUALIFICATION_UI_PORT`, and `EUFY_QUALIFICATION_BRIDGE_PORT`.

**The wizard never asks for the account password.** You type it only into the Homebridge UI in your
browser. No credential passes through the script, its environment, or the files it writes — and that
absence is itself part of the evidence for the first criterion.

| Stage | Criterion | What it establishes |
| --- | --- | --- |
| 1 | — | The build, branch, and Node version under test |
| 2 | — | An isolated instance whose plugin is the checkout, not a published build |
| 3 | — | A dedicated guest account and a synthetic alias for the report |
| 4 | AC1, AC2 | Interactive login with Homebridge stopped, and a temporary lease observed mid-challenge |
| 5 | AC1 | No credential outside its declared sink, plus your search for the challenge answer |
| 6 | AC2 | Closing the UI leaves no lease record behind |
| 7 | AC2 | One session restore, one ready transition, a complete snapshot, no second login |
| 8 | AC3 | A concurrent second owner refused with the live lease intact |
| 9 | AC4 | No device changed state |
| 10 | — | A redacted evidence report |

Stage 4 deliberately pauses while the challenge is still on screen. Sampling ownership at that moment is
what makes stage 6 meaningful: without it, an absent lease afterwards would prove release from an
absence.

## Run one check on its own

The checks are also usable directly, for instance to audit an instance that already authenticated:

```bash
node scripts/authentication-handoff-evidence.mjs sinks       --storage <storage>/homebridge-eufy [--ui-log <path>]
node scripts/authentication-handoff-evidence.mjs ownership   --storage <storage>/homebridge-eufy --expect-kind runtime
node scripts/authentication-handoff-evidence.mjs acquisition --storage <storage>/homebridge-eufy --since <iso>
node scripts/authentication-handoff-evidence.mjs conflict    --storage <storage>/homebridge-eufy
```

`sinks`, `ownership`, and `acquisition` only read, so they are safe against a running production
instance. `conflict` writes one bakery-guard record and must only run against a throwaway instance.
Each subcommand exits non-zero when its criterion is not met, fails closed when the evidence it needs is
absent, and prints no credential, account address, device serial, or device name — nor a digest or length
of one, because the output is assembled into a report intended for a public issue.

The captcha or two-factor answer is the one thing no subcommand can probe: the plugin persists it
nowhere, so there is no stored value to compare against. Confirming it never reached a log is a human
search, and the wizard hands you the exact `grep` for it.

## Where the account password legitimately rests

A reviewer scoring the first criterion needs to know the deliberate sinks, so an expected value is not
mistaken for a leak. The password is stored in cleartext in:

- Homebridge `config.json`, because the plugin is configured like any other Homebridge plugin.
- `<storage>/homebridge-eufy/accounts/generations/<generation>/configuration.json`, because the
  runtime process re-creates its SDK client from it after a restart.

Both are mode `0600` inside a `0700` tree. Neither crosses a process boundary other than being read by
the runtime that owns the account. The criterion is that the credential appears **nowhere else** — not
in the tracker, the rotating JSONL logs, a support archive, or an error message.

## If a criterion fails

- **A credential reached a log.** Stop and treat it as a security defect, not a test failure. Capture
  the field name and the emitting subsystem, never the value.
- **The UI reports the plugin is already running.** Another owner holds the account. Run
  `ownership` to see which kind of owner, and confirm Homebridge is stopped before authenticating.
- **The restart asks for authentication again.** The persisted session was not accepted. See
  [Authentication problems](/troubleshooting/authentication).
- **The second owner acquired the lease.** The refusal path is broken. This is the most serious
  possible outcome of this procedure; the report records the incumbent and intruder leases.

Never paste a real account address, device serial, device name, or network address into the issue. The
harness redacts its own output; anything you add by hand is your responsibility.
