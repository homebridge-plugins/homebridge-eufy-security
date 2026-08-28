# Configuration reference

V5 uses a fresh configuration model. Legacy camera arrays, ignore lists, stream presets, guard maps,
and debug toggles are not imported.

::: warning Breaking V5 platform identity
V5 registers only `HomebridgeEufy`. A V4 configuration block using `EufySecurity` is not loaded or
migrated; create a fresh V5 block through the custom UI.
:::

| Key                           | Type              | Default           | Purpose                                       |
| ----------------------------- | ----------------- | ----------------- | --------------------------------------------- |
| `platform`                    | string            | `HomebridgeEufy`  | Homebridge V5 platform alias                  |
| `username`                    | string            | —                 | Dedicated account email                       |
| `password`                    | string            | —                 | Dedicated account password                    |
| `country`                     | two-letter string | `US`              | Account country/region                        |
| `trustedDeviceName`           | string            | `Homebridge Eufy` | Name shown in eufy trusted devices            |
| `pollingIntervalMinutes`      | integer           | `10`              | SDK cloud inventory polling interval          |
| `warmUpEvents`                | string array      | `['doorbellPress']` | Events that open a camera's connection early |
| `maxConcurrentMediaSessions`  | integer           | `0`               | Cameras streaming or taking a still at once   |
| `ffmpegPath`                  | string            | bundled binary    | Optional FFmpeg override                      |
| `entityPreferences`           | object            | `{}`              | Sparse serial-keyed preferences               |

Entity preferences support `represented`, `audio`, and `snapshotMode`. Snapshot mode is one of `Cloud`,
`Live`, or `Refresh`. Configuration cannot manufacture a capability the SDK did not report.

`warmUpEvents` names the SDK's own semantic events, so an unrecognised entry is kept rather than refused;
the custom UI offers whatever the discovered devices actually report. Warming is per camera: an event opens
the connection of the camera that reported it and no other. A camera on its own battery is held awake for
the idle window that follows, so a camera reporting often may never sleep.

`maxConcurrentMediaSessions` is `0` for no limit, which is the default and preserves the behaviour of every
installation that does not set it. It counts live sessions and fresh stills together, because each is one
SDK pull and at least one FFmpeg process. Once the limit is reached a new live session is refused and a new
still is answered with that camera's most recent retained picture; a session already established is never
interrupted to make room. The plugin does not infer this number, because a core count and a container quota
are both unusable — see [architecture](../architecture.md).

When the custom UI finds effectful V4-only values, it stores only their setting names in
`discardedV4Settings`. It never copies or executes their values. `discardedV4Acknowledged` records the
user's acknowledgement and suppresses the migration summary and startup warning. These two internal
notice fields are managed by the custom UI rather than exposed as device preferences.
