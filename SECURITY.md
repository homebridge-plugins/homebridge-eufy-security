# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub Security Advisories:

> [Report a vulnerability](https://github.com/homebridge-plugins/homebridge-eufy-security/security/advisories/new)

Include the affected version, reproduction steps, and impact where possible. Reports are handled
privately, and reporters are credited unless they prefer anonymity.

## Scope

In scope are vulnerabilities in this repository that weaken a user's Homebridge host, Eufy account,
devices, or private data, including credential and session handling, UI/runtime IPC, diagnostics,
media processing, configuration, and reachable dependency vulnerabilities.

Vulnerabilities in Eufy, Anker, Apple, or Homebridge services themselves are out of scope and should
be reported to the relevant vendor. A flaw in how this plugin integrates with those systems is in
scope.

## Supported versions

Only the latest stable release and current published beta receive security fixes.

## Credentials and diagnostics

Never commit Homebridge configuration, SDK sessions, diagnostics, or recordings. If Eufy credentials
or a session may have been exposed, invalidate active sessions from the Eufy app and change the
account password. Treat unencrypted diagnostics as sensitive even after automated redaction.
