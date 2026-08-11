<div align="center">

<!-- The suffix names the mode: logo-dark.svg is the white glyph for dark backgrounds. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/homebridge-plugins/homebridge-eufy-security/beta-5.0.0/homebridge-ui/public/assets/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/homebridge-plugins/homebridge-eufy-security/beta-5.0.0/homebridge-ui/public/assets/logo.svg" alt="Homebridge Eufy" height="96">
</picture>

**Bring verified eufy device capabilities into Apple Home through Homebridge.**

[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-eufy-security?logo=npm&color=cb3837)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-eufy-security)
[![beta](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-eufy-security/beta?label=beta)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-eufy-security)
[![CI](https://github.com/homebridge-plugins/homebridge-eufy-security/actions/workflows/ci.yml/badge.svg?branch=beta-5.0.0)](https://github.com/homebridge-plugins/homebridge-eufy-security/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@homebridge-plugins/homebridge-eufy-security?logo=nodedotjs)](./.nvmrc)
[![license](https://img.shields.io/npm/l/@homebridge-plugins/homebridge-eufy-security)](./LICENSE)

[Documentation](https://homebridge-plugins.github.io/homebridge-eufy-security/) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Releases](https://github.com/homebridge-plugins/homebridge-eufy-security/releases)

</div>

---

> [!IMPORTANT]
> **V5 is a closed maintainer beta, not yet a replacement for the stable plugin. Registration is not
> open; please do not request access.** Account authentication, single-owner session restore, complete
> device discovery, and the first explicit HomeKit adapter are implemented. Accessory publication,
> camera media, HKSV, motion
> and doorbell events, arming, locks, lights, and battery enrichment are still being rebuilt. A device
> discovered by the SDK is not automatically represented in HomeKit.

## What it is

Homebridge Eufy is a Homebridge 2 platform plugin for the eufy ecosystem. It maintains one persisted
eufy session, discovers the account's devices through
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk), and maps verified SDK capabilities to
official HomeKit services through explicit capability adapters.

The SDK owns device and transport truth. This plugin owns Homebridge lifecycle, stable accessory
identity, HomeKit representation and policy, configuration, diagnostics, and media adaptation. It
does not infer HomeKit meaning from raw value shapes or manufacture controls that the SDK cannot
verify.

## Requirements

- [Homebridge](https://homebridge.io/) 2.0 or newer
- Node.js 24.5.0 or newer
- A dedicated guest eufy account with the relevant home and devices shared to it

Using a guest account keeps the personal eufy app and Homebridge from competing for one session. See
eufy's [sharing guide](https://support.eufylife.com/s/article/Share-Your-eufySecurity-Devices-With-Your-Family).

## Install

Install stable releases through the Homebridge UI by searching for **Homebridge Eufy Security**, or
from npm:

```bash
npm install -g @homebridge-plugins/homebridge-eufy-security
```

The V5 branch is currently for development and a closed maintainer beta. Enrollment is not open. It
depends on a private GitHub Packages SDK prerelease and is not yet an anonymously installable public
beta.

## First-time setup

1. Create a dedicated guest eufy account and share the required home and devices with it.
2. Install the plugin and open its custom UI from Homebridge.
3. Enter the guest account details and complete captcha or two-factor verification if requested.
4. Wait for authentication and complete discovery to finish.
5. Restart Homebridge so the long-lived runtime can acquire the persisted session.

Credentials are persisted in Homebridge/plugin configuration. Challenge answers stay inside the
temporary authentication flow, and the runtime never falls back to interactive login.

## Current V5 scope

| Area | Status |
|---|---|
| Interactive login, captcha, and two-factor continuation | Available |
| Persisted session restore and single runtime ownership | Available |
| Complete device discovery and runtime snapshot | Available |
| Contact sensor adapter | Implemented; production accessory publication not yet connected |
| Camera streaming, snapshots, talkback, and HKSV | In progress |
| Motion and doorbell events | In progress |
| Security modes, locks, lights, sirens, and battery services | In progress |

Support is capability-led rather than model-led. Recognized devices may appear in discovery before an
explicit HomeKit adapter exists for their primary purpose.

## Documentation

The [documentation site](https://homebridge-plugins.github.io/homebridge-eufy-security/) contains the
current V5 contract and a clearly separated migration of useful legacy V4 wiki material. Current V5
work is tracked in the [beta issues](https://github.com/homebridge-plugins/homebridge-eufy-security/issues)
and release notes.

- [Installation](https://homebridge-plugins.github.io/homebridge-eufy-security/guide/installation)
- [Configuration](https://homebridge-plugins.github.io/homebridge-eufy-security/reference/configuration)
- [Troubleshooting](https://homebridge-plugins.github.io/homebridge-eufy-security/troubleshooting/)
- [Current releases](https://github.com/homebridge-plugins/homebridge-eufy-security/releases)
- [SDK documentation](https://mega-yfue.github.io/)

## Design

V5 uses one dependency direction:

```text
Homebridge lifecycle
  -> runtime and temporary authentication owners
  -> @mega-yfue/eufy-sdk
  -> canonical device registry and complete snapshot
  -> explicit capability and bundle adapters
  -> official HomeKit services and characteristics
```

Capability adapters are closed-world and semantic. Unsupported SDK capabilities remain visible as
diagnostics but do not receive a generic HomeKit fallback. The domain vocabulary lives in
[`CONTEXT.md`](./CONTEXT.md).

## Develop

```bash
nvm use
GITHUB_TOKEN="$(gh auth token)" npm install
npm run verify
```

For local SDK development, replace the SDK dependency with `file:../eufy-sdk` and run `npm install`
again. `npm run verify` is the complete repository gate: formatting, dependency guard, TypeScript
build, packed-artifact import, and contract tests.

## Contributing

Pull requests are welcome. [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers setup and workflow;
[`AGENTS.md`](./AGENTS.md) defines the code and architecture rules. Report security issues through
[`SECURITY.md`](./SECURITY.md), never through a public issue.

## Funding and credits

Development is supported by [Lenoxys](https://github.com/sponsors/lenoxys). The project was founded by
[samemory](https://ko-fi.com/S6S24XCVJ). Earlier releases were built on bropat's
[`eufy-security-client`](https://github.com/bropat/eufy-security-client); V5 uses
[`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk).

## License

[Apache-2.0](./LICENSE). Contributions are accepted under the same license.

## Disclaimer

Independent and unofficial, built for interoperability with eufy devices you own. **Not affiliated
with, endorsed by, or sponsored by Anker Innovations or eufy.** "eufy" and "Anker" are trademarks of
their respective owners and appear here only to identify compatible hardware. Use responsibly: rapid
or failed login attempts can trigger captcha challenges or temporary account cooldowns.
