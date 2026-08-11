# First-time setup

1. Meet the [requirements](/guide/requirements) and prepare a [dedicated account](/guide/dedicated-account).
2. Install the plugin and open its custom UI in Homebridge.
3. Enter the account, password, country, and trusted-device name.
4. Complete captcha or two-factor verification if requested.
5. Wait for complete discovery and the success message.
6. Restart Homebridge normally.

Authentication stages a new account generation. Only a successful login and complete discovery replace
the active generation. The restart then transfers ownership to the long-lived runtime.

Credentials are persisted as part of the Homebridge/plugin configuration. Captcha and two-factor
answers are used only by the active temporary authentication flow.
