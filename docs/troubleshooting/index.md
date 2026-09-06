# Troubleshooting

Start with one reproducible failure and the smallest relevant evidence.

1. Confirm Node.js and Homebridge meet the [requirements](/guide/requirements).
2. Identify whether the failure is authentication, runtime discovery, or HomeKit representation.
3. Restart once and reproduce the exact action.
4. Record the runtime state without posting the complete tracker or snapshot.
5. Check the relevant focused guide before opening an issue.

- [Authentication problems](/troubleshooting/authentication)
- [Discovery and runtime problems](/troubleshooting/discovery-runtime)
- [Node.js compatibility](/troubleshooting/node-compatibility)
- [Collecting diagnostics safely](/troubleshooting/collecting-diagnostics)
- [Validating a local plugin build](/troubleshooting/live-plugin-validation)
- [Qualifying the live authentication handoff](/troubleshooting/live-authentication-handoff)

## Live view away from home

Opening a camera from outside the home network currently delivers no picture, and no configuration of this
plugin changes that. The cause is above it: since the Apple TV home hub was updated to tvOS 26.6, the hub
stops delivering the request to the Homebridge bridge, so the plugin is never asked for a stream. A
reproduction recorded with the `live-media` diagnostics profile shows no record at all for the attempt, while
a session on the local network negotiates, adapts and streams normally.

It is tracked upstream as [HAP-NodeJS#1128](https://github.com/homebridge/HAP-NodeJS/issues/1128), and was
seen after tvOS 26.5 as [homebridge#3937](https://github.com/homebridge/homebridge/issues/3937). Streaming on
the local network is unaffected. Please add to the upstream issue rather than opening one here.

Legacy debug buttons, separate plugin/library logs, camera presets, and reset screenshots do not
describe V5.
