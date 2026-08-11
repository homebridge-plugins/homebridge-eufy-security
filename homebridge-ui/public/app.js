const shell = document.querySelector('[data-ui-shell]');
const firstSetup = document.querySelector('[data-first-setup]');
const setupContent = document.querySelector('[data-setup-content]');
const acknowledgement = document.querySelector('[data-first-setup-ack]');
const continueButton = document.querySelector('[data-first-setup-continue]');

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
  let messages;

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

homebridge.addEventListener('ready', async () => {
  shell.dataset.theme = await homebridge.userCurrentLightingMode();
  const [pluginConfig, language] = await Promise.all([
    homebridge.getPluginConfig(),
    homebridge.i18nCurrentLang(),
  ]);
  await applyTranslations(language);
  const hasConfiguredAccount = pluginConfig.some(
    (block) => typeof block.username === 'string' && block.username.trim().length > 0,
  );

  firstSetup.hidden = hasConfiguredAccount;
  setupContent.hidden = !hasConfiguredAccount;
  acknowledgement.checked = false;
  continueButton.disabled = true;
});
