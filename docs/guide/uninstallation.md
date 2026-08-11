# Uninstallation

The V5 removal contract is still being finalized. Do not follow legacy V4 reset screenshots or settings.

For a normal package removal, uninstall the plugin through Homebridge UI. For complete account cleanup:

1. Stop Homebridge.
2. Remove the plugin package.
3. Revoke the shared home/device access from the dedicated eufy account if no longer needed.
4. Remove persisted plugin state under the Homebridge storage directory only if you intentionally want
   to discard the active session and device snapshot.

Keep a Homebridge backup before removing persisted state. V5 does not currently publish production
accessories, so accessory-cache removal guidance will be documented when that behavior ships.
