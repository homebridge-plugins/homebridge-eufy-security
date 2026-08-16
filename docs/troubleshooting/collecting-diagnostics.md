# Collecting diagnostics safely

V5 diagnostics are still under development. Until the guided encrypted support archive is available:

- Reproduce one issue at a time.
- Include timestamps and the action taken.
- Use the human-readable Homebridge console to identify the relevant condition code.
- Keep `homebridge-eufy/logs/homebridge-eufy.jsonl` local unless a maintainer requests a bounded excerpt.
- Share runtime state names, not raw tracker files.
- Remove serials, device names, account IDs, addresses, tokens, URLs, keys, and session records.
- Never upload Homebridge storage, captures, or raw SDK objects.
- Do not grant camera or account access unless a documented support process explicitly requires it.

The JSONL file combines bounded plugin and SDK events in timestamp order and rotates into three gzip
archives. It is not a support archive. If a maintainer needs more evidence, wait for a precise
allowlisted request rather than posting the complete log publicly.
