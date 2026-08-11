# Discovery and runtime problems

## State meanings

- `ready`: the persisted session, listeners, canonical registry, and complete snapshot are available.
- `degraded`: current discovery was partial; the latest complete snapshot remains authoritative.
- `authentication-required`: the persisted session is absent or rejected.
- `owner-conflict`: another live process owns the account.

## Safe checks

Inspect only allowlisted summary fields such as state, status, completeness, timestamp, and device count.
Do not post `tracker.json` or the persisted device snapshot unredacted: they contain device identifiers
and names.

If state is stale, verify the Homebridge process is still alive and inspect Homebridge logs for runtime
startup, shutdown, owner-conflict, or publication errors.
