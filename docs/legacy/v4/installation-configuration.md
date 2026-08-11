# V4 installation and configuration

::: danger Legacy V4 only
Do not apply these settings to V5. Use the current [installation](/guide/installation) and
[configuration reference](/reference/configuration).
:::

V4 used the unscoped `homebridge-eufy-security` package, Homebridge 1.x-compatible configuration, and
`eufy-security-client`. Its custom UI included per-device camera, audio, bridge, stream, HKSV, ignore,
guard-mode, and detailed-logging options.

Those configuration keys are intentionally not imported by V5. V5 keeps only the stable platform
alias and explicit fresh configuration fields.
