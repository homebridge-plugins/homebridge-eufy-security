# Runtime states

| State | Meaning |
|---|---|
| `stopped` | No active runtime owner |
| `acquiring-ownership` | Runtime is attempting to acquire the account lease |
| `starting` | Persisted session accepted; listeners and inventory are starting |
| `ready` | Canonical registry and complete snapshot are published |
| `degraded` | Connectivity was lost or current inventory is partial; latest complete snapshot is retained |
| `authentication-required` | Active session is missing or rejected |
| `owner-conflict` | Another demonstrably live owner holds the account lease |
| `failed` | Startup, runtime publication, or bounded cleanup failed; latest complete snapshot is retained |
| `stopping` | Bounded shutdown is in progress |

The runtime tracker is versioned and owner-only. It is a status channel, not ownership authority.
`authentication-required`, `failed`, `stopping`, and `stopped` do not withdraw the latest complete
snapshot. A reconnect restores `ready` only after another complete inventory is published.
