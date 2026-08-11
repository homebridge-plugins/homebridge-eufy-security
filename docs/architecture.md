# Architecture

V5 separates verified device truth from HomeKit policy.

```text
Homebridge platform adapter
  -> runtime owner
     -> account ownership and persisted generation
     -> @mega-yfue/eufy-sdk
     -> canonical device registry and complete snapshot
  -> explicit HomeKit capability adapters
```

## Domain modules

```text
src/
  account/   lease ownership, persisted generations, temporary authentication
  device/    complete snapshot and canonical discovery
  homekit/   coverage matrix and explicit adapters
  runtime/   runtime owner, SDK adapter, status tracker
  ui/        Homebridge custom UI server
```

## Ground rules

- The SDK owns verified device capabilities, observations, operations, events, and transport behavior.
- The plugin owns Homebridge lifecycle, accessory identity, HomeKit representation, configuration,
  diagnostics, and media adaptation.
- A missing SDK fact is not guessed in the plugin.
- Partial inventory updates included members only; only a complete snapshot can withdraw capability
  evidence.
- Successful command delivery is not a physical device observation.
