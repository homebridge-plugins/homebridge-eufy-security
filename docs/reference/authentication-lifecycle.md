# Authentication lifecycle

Homebridge runtime and interactive authentication never intentionally own the same account session.

```text
Homebridge stopped
  -> custom UI acquires temporary ownership
  -> login / captcha / two-factor
  -> complete discovery
  -> atomic active-generation publication
  -> temporary client disconnects and releases ownership
  -> normal Homebridge restart
  -> runtime acquires ownership and restores the persisted session
```

Failed or abandoned authentication discards staging and preserves the previous active account.
A demonstrably live owner cannot be stolen; tracker freshness is advisory and never grants ownership.
