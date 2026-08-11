# V4 bridged and unbridged modes

::: danger Legacy V4 only
V5 does not currently publish accessories or expose per-device bridge/unbridge settings.
:::

V4 could expose selected cameras as external accessories or run the plugin as a Homebridge child
bridge. This isolated camera streaming and reduced the effect of a slow accessory on other bridged
devices. Pairing and cache-recovery steps were tied to that accessory architecture.

For current Homebridge concepts, use the official
[child bridge documentation](https://github.com/homebridge/homebridge/wiki/Child-Bridges).
