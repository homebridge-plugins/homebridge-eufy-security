# Collecting diagnostics safely

V5 diagnostics are still under development. Until the guided encrypted support archive is available:

- Reproduce one issue at a time.
- Include timestamps and the action taken.
- Share runtime state names, not raw tracker files.
- Remove serials, device names, account IDs, addresses, tokens, URLs, keys, and session records.
- Never upload Homebridge storage, captures, or raw SDK objects.
- Do not grant camera or account access unless a documented support process explicitly requires it.

If a maintainer needs more evidence, wait for a precise allowlisted request rather than posting a broad
log archive publicly.
