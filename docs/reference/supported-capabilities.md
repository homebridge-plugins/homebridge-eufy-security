# Supported capabilities

V5 distinguishes three claims:

- **Recognized**: the SDK knows the device and its evidenced capabilities.
- **Represented**: at least one primary-purpose member has an explicit HomeKit adapter.
- **Controllable**: at least one verified operation is available through HomeKit.

## Current implementation status

| Area | Status |
|---|---|
| Account and device discovery | Runtime available |
| Contact sensor adapter | Implemented, not yet wired to production accessory publication |
| Cameras, streaming, snapshots, talkback, HKSV | Deferred/in progress |
| Motion and doorbell events | Deferred/in progress |
| Security modes, locks, lights, sirens, battery | Deferred/in progress |

Primitive type similarity never admits a mapping. Unsupported members remain diagnostic-only or blocked
until verified SDK evidence and a semantic HomeKit contract both exist.
