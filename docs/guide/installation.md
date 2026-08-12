# Installation

## Stable public release

Install through the Homebridge UI by searching for **Homebridge Eufy**, or install the scoped
package:

```bash
npm install -g @homebridge-plugins/homebridge-eufy-security
```

## V5 closed beta

V5 is not an anonymously installable public beta. It currently depends on a private GitHub Packages SDK
prerelease. Registration is not open; please do not request access.

Maintainers developing from source use:

```bash
nvm use
GITHUB_TOKEN="$(gh auth token)" npm install
npm run verify
```
