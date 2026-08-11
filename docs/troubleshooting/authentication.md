# Authentication problems

## Runtime is still active

Interactive login is blocked while a fresh runtime or live account lease exists. Stop Homebridge, wait
for shutdown, then reopen the custom UI.

## Captcha or two-factor challenge

The challenge replaces the login form and stays on the same temporary SDK client. Submit the answer in
the same setup window. Closing the window cleans up the staged account and temporary owner.

## Authentication succeeded but runtime asks again

1. Confirm the UI displayed the restart-required success message.
2. Restart Homebridge normally rather than starting another authentication flow.
3. Check for `authentication-required` or `owner-conflict` state.
4. Verify the account share remains active in the official eufy app.

Repeated failed logins can trigger temporary captcha or cooldown behavior. Pause before retrying.
