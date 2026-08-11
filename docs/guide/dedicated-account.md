# Dedicated eufy account

Use a separate eufy account for Homebridge instead of the personal account used by the official app.
This prevents two long-lived clients from competing for the same session.

1. Create a secondary account with a different email address.
2. From the primary account, share only the required home and devices.
3. Accept and verify the share in the official eufy app.
4. Use the same account country/region during Homebridge setup.
5. Authenticate the secondary account in the plugin custom UI.

See eufy's [sharing guide](https://support.eufylife.com/s/article/Share-Your-eufySecurity-Devices-With-Your-Family).
