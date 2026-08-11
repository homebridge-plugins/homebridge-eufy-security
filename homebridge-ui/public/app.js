const shell = document.querySelector('[data-ui-shell]');
const firstSetup = document.querySelector('[data-first-setup]');
const setupContent = document.querySelector('[data-setup-content]');
const acknowledgement = document.querySelector('[data-first-setup-ack]');
const continueButton = document.querySelector('[data-first-setup-continue]');
const authForm = document.querySelector('[data-auth-form]');
const challengeForm = document.querySelector('[data-challenge-form]');
const accountInput = document.querySelector('[data-account]');
const passwordInput = document.querySelector('[data-password]');
const countryInput = document.querySelector('[data-country]');
const trustedDeviceInput = document.querySelector('[data-trusted-device-name]');
const challengeAnswer = document.querySelector('[data-challenge-answer]');
const challengeImage = document.querySelector('[data-challenge-image]');
const challengeLabel = document.querySelector('[data-challenge-label]');
const authStatus = document.querySelector('[data-auth-status]');
const authSubmit = document.querySelector('[data-auth-submit]');
const challengeSubmit = document.querySelector('[data-challenge-submit]');

let messages = {};
let pluginConfig = [];
let pendingConfig;
let challenge = '';

function requestWithinDeadline(path, body, timeoutMs = 320000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
  });
  return Promise.race([homebridge.request(path, body), timeout]).finally(() => clearTimeout(timer));
}

acknowledgement.addEventListener('change', () => {
  continueButton.disabled = !acknowledgement.checked;
});

continueButton.addEventListener('click', () => {
  if (!acknowledgement.checked) return;
  firstSetup.hidden = true;
  setupContent.hidden = false;
});

async function loadMessages(locale) {
  const response = await fetch(`i18n/${locale}.json`);
  if (!response.ok) {
    throw new Error(`Unable to load ${locale} translations`);
  }
  return response.json();
}

async function applyTranslations(language) {
  let locale = language.toLowerCase().split('-')[0] === 'fr' ? 'fr' : 'en';
  try {
    messages = await loadMessages(locale);
  } catch {
    locale = 'en';
    try {
      messages = await loadMessages(locale);
    } catch {
      shell.lang = locale;
      return;
    }
  }

  shell.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = messages[element.dataset.i18n] ?? element.textContent;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', messages[element.dataset.i18nAriaLabel] ?? '');
  });
}

function setBusy(busy) {
  authSubmit.disabled = busy;
  challengeSubmit.disabled = busy;
}

async function saveAuthenticatedConfig() {
  try {
    await homebridge.updatePluginConfig([pendingConfig]);
    await homebridge.savePluginConfig();
    pluginConfig = [pendingConfig];
  } catch {
  } finally {
    passwordInput.value = '';
    pendingConfig = undefined;
  }
}

async function handleResult(result) {
  if (result.status === 'captcha') {
    challenge = 'captcha';
    challengeImage.src = result.image;
    challengeImage.hidden = false;
    challengeLabel.textContent = messages.captchaLabel ?? '';
    challengeForm.hidden = false;
    authStatus.textContent = '';
    return;
  }
  if (result.status === 'two-factor') {
    challenge = 'two-factor';
    challengeImage.hidden = true;
    challengeLabel.textContent = messages.twoFactorLabel ?? '';
    challengeForm.hidden = false;
    authStatus.textContent = result.method;
    return;
  }

  challengeForm.hidden = true;
  if (result.status === 'restart-required') {
    await saveAuthenticatedConfig();
    authStatus.textContent = messages.authSuccess ?? '';
  } else if (result.status === 'blocked' || result.status === 'plugin-running') {
    authStatus.textContent = messages.authBlocked ?? '';
  } else if (result.status === 'timed-out') {
    authStatus.textContent = messages.authTimedOut ?? '';
  } else {
    authStatus.textContent = messages.authFailed ?? '';
  }
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const existing = pluginConfig.find((block) => block.platform === 'EufySecurity') ?? pluginConfig[0] ?? {};
  pendingConfig = {
    ...existing,
    platform: 'EufySecurity',
    username: accountInput.value.trim(),
    password: passwordInput.value,
    country: countryInput.value.trim().toUpperCase(),
    trustedDeviceName: trustedDeviceInput.value.trim(),
  };
  setBusy(true);
  try {
    await handleResult(await requestWithinDeadline('/auth/start', { configuration: pendingConfig }));
  } catch {
    authStatus.textContent = messages.authFailed ?? '';
  } finally {
    setBusy(false);
  }
});

challengeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const path = challenge === 'captcha' ? '/auth/captcha' : '/auth/two-factor';
  const body = challenge === 'captcha' ? { answer: challengeAnswer.value } : { code: challengeAnswer.value };
  challengeAnswer.value = '';
  setBusy(true);
  try {
    await handleResult(await requestWithinDeadline(path, body));
  } catch {
    authStatus.textContent = messages.authFailed ?? '';
  } finally {
    setBusy(false);
  }
});

window.addEventListener('pagehide', () => {
  void requestWithinDeadline('/auth/close', undefined, 12000).catch(() => undefined);
});

homebridge.addEventListener('ready', async () => {
  shell.dataset.theme = await homebridge.userCurrentLightingMode();
  const language = await homebridge.i18nCurrentLang();
  pluginConfig = await homebridge.getPluginConfig();
  await applyTranslations(language);
  const configured = pluginConfig.find((block) => typeof block.username === 'string' && block.username.trim().length > 0);

  firstSetup.hidden = Boolean(configured);
  setupContent.hidden = !configured;
  acknowledgement.checked = false;
  continueButton.disabled = true;
  accountInput.value = configured?.username ?? '';
  passwordInput.value = configured?.password ?? '';
  countryInput.value = configured?.country ?? 'US';
  trustedDeviceInput.value = configured?.trustedDeviceName ?? 'Homebridge Eufy';
});
