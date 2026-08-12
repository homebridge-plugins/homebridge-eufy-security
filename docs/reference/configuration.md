# Configuration reference

V5 uses a fresh configuration model. Legacy camera arrays, ignore lists, stream presets, guard maps,
and debug toggles are not imported.

::: warning Breaking V5 platform identity
V5 registers only `HomebridgeEufy`. A V4 configuration block using `EufySecurity` is not loaded or
migrated; create a fresh V5 block through the custom UI.
:::

| Key | Type | Default | Purpose |
|---|---|---|---|
| `platform` | string | `HomebridgeEufy` | Homebridge V5 platform alias |
| `username` | string | — | Dedicated account email |
| `password` | string | — | Dedicated account password |
| `country` | two-letter string | `US` | Account country/region |
| `trustedDeviceName` | string | `Homebridge Eufy` | Name shown in eufy trusted devices |
| `pollingIntervalMinutes` | integer | `10` | SDK cloud inventory polling interval |
| `ffmpegPath` | string | bundled binary | Optional FFmpeg override |
| `entityPreferences` | object | `{}` | Sparse serial-keyed preferences |

Entity preferences support `represented`, `audio`, and `snapshotMode`. Snapshot mode is one of `Cloud`,
`Live`, or `Refresh`. Configuration cannot manufacture a capability the SDK did not report.
