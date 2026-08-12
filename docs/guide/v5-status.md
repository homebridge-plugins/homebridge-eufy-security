# V5 closed-beta status

V5 is a clean integration built on `@mega-yfue/eufy-sdk`; it is not a feature-for-feature port of V4.
The beta is closed to maintainers and enrollment is not open.

## Available foundation

- Homebridge 2 platform registration under the V5 `HomebridgeEufy` alias
- Temporary authentication with captcha and two-factor continuation
- Atomic account replacement and persisted session handoff
- One account-scoped runtime owner
- Complete device discovery, canonical registry, and versioned runtime snapshot
- Explicit coverage matrix and the first contact-sensor adapter implementation

## Not yet available as HomeKit behavior

- Accessory publication and reconciliation
- Camera streaming, snapshots, talkback, and HomeKit Secure Video
- Motion and doorbell events
- Security modes, locks, lights, sirens, and battery services

An SDK-recognized device is not automatically represented in HomeKit. See
[supported capabilities](/reference/supported-capabilities).
