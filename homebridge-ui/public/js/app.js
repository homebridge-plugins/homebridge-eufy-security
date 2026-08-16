const shell = document.querySelector('[data-ui-shell]');
const masthead = document.querySelector('[data-masthead]');
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
const dashboard = document.querySelector('[data-dashboard]');
const dashboardTitle = document.querySelector('[data-dashboard-title]');
const dashboardBadge = document.querySelector('[data-dashboard-badge]');
const dashboardSummary = document.querySelector('[data-dashboard-summary]');
const dashboardAuthenticate = document.querySelector('[data-dashboard-authenticate]');
const deviceGroups = document.querySelector('[data-device-groups]');
const pageTitle = document.querySelector('[data-page-title]');
const legacyNotice = document.querySelector('[data-legacy-notice]');
const legacySettings = document.querySelector('[data-legacy-settings]');
const legacyAcknowledge = document.querySelector('[data-legacy-acknowledge]');
const diagnosticsProfile = document.querySelector('[data-diagnostics-profile]');
const diagnosticsAuthorize = document.querySelector('[data-diagnostics-authorize]');
const diagnosticsReproduction = document.querySelector('[data-diagnostics-reproduction]');
const diagnosticsStatus = document.querySelector('[data-diagnostics-status]');
const diagnosticsIssue = document.querySelector('[data-diagnostics-issue]');

let messages = {};
let pluginConfig = [];
let savedConfigSignature = '';
let pendingConfig;
let challenge = '';
let legacyNames = [];
let legacyAcknowledged = false;
let diagnosticsState = { status: 'inactive', missingEvidence: [] };
const dashboardView = window.HomebridgeEufyDashboard;
const legacySettingsView = window.HomebridgeEufyLegacySettings;
const dashboardElements = {
  dashboard,
  title: dashboardTitle,
  badge: dashboardBadge,
  summary: dashboardSummary,
  authenticate: dashboardAuthenticate,
  groups: deviceGroups,
  setup: setupContent,
  pageTitle,
  masthead,
};

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

function renderDiagnostics(state) {
  diagnosticsState = state;
  diagnosticsProfile.disabled = state.status === 'reproducing';
  diagnosticsAuthorize.disabled = state.status === 'reproducing';
  diagnosticsReproduction.disabled = !['authorized', 'reproducing'].includes(state.status);
  diagnosticsReproduction.textContent =
    state.status === 'reproducing' ? messages.diagnosticsEndReproduction : messages.diagnosticsStartReproduction;
  diagnosticsIssue.hidden = !state.partialExportAvailable;
  diagnosticsIssue.href = state.issueUrl ?? '';
  if (state.profile) diagnosticsProfile.value = state.profile;
  const statusKey = {
    inactive: 'diagnosticsInactive',
    authorized: 'diagnosticsAuthorized',
    reproducing: 'diagnosticsReproducing',
    complete: state.missingEvidence?.length ? 'diagnosticsMissingEvidence' : 'diagnosticsComplete',
    expired: 'diagnosticsExpired',
  }[state.status];
  diagnosticsStatus.textContent = (messages[statusKey] ?? '').replace(
    '{evidence}',
    state.missingEvidence?.join(', ') ?? '',
  );
}

diagnosticsAuthorize.addEventListener('click', async () => {
  diagnosticsAuthorize.disabled = true;
  try {
    renderDiagnostics(await requestWithinDeadline('/diagnostics/authorize', { profile: diagnosticsProfile.value }, 12000));
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
  } finally {
    diagnosticsAuthorize.disabled = diagnosticsState.status === 'reproducing';
  }
});

diagnosticsProfile.addEventListener('change', () => {
  if (diagnosticsProfile.value !== diagnosticsState.profile) diagnosticsReproduction.disabled = true;
});

diagnosticsReproduction.addEventListener('click', async () => {
  diagnosticsReproduction.disabled = true;
  const path =
    diagnosticsState.status === 'reproducing'
      ? '/diagnostics/reproduction/end'
      : '/diagnostics/reproduction/start';
  try {
    let state = await requestWithinDeadline(path, undefined, 12000);
    if (state.status === 'complete' && state.missingEvidence?.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
    }
    renderDiagnostics(state);
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
  } finally {
    diagnosticsReproduction.disabled = !['authorized', 'reproducing'].includes(diagnosticsState.status);
  }
});

function configuredBlock() {
  return pluginConfig.find((block) => block.platform === 'HomebridgeEufy');
}

function stableConfigValue(value) {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableConfigValue(value[key])]),
  );
}

function configSignature(config) {
  return JSON.stringify(stableConfigValue(config));
}

async function updateConfig(block) {
  pluginConfig = pluginConfig.map((candidate) => (candidate.platform === 'HomebridgeEufy' ? block : candidate));
  if (!pluginConfig.includes(block)) pluginConfig.push(block);
  await homebridge.updatePluginConfig(pluginConfig);
  if (configSignature(pluginConfig) === savedConfigSignature) homebridge.disableSaveButton();
  else homebridge.enableSaveButton();
}

dashboardView.bindPreferences(dashboardElements, configuredBlock, updateConfig, () => messages);

dashboardAuthenticate.addEventListener('click', () => {
  dashboard.hidden = true;
  setupContent.hidden = false;
  masthead.hidden = false;
  pageTitle.textContent = messages.pageTitle;
});

legacyAcknowledge.addEventListener('click', async () => {
  legacyAcknowledged = true;
  const existing = configuredBlock();
  if (existing) {
    try {
      await updateConfig({ ...existing, discardedV4Settings: legacyNames, discardedV4Acknowledged: true });
    } catch {
      return;
    }
  }
  legacyNotice.hidden = true;
});

async function saveAuthenticatedConfig() {
  homebridge.enableSaveButton();
  try {
    await homebridge.updatePluginConfig([pendingConfig]);
    await homebridge.savePluginConfig();
    pluginConfig = [pendingConfig];
    savedConfigSignature = configSignature(pluginConfig);
    homebridge.enableSaveButton();
  } catch {
  } finally {
    passwordInput.value = '';
    pendingConfig = undefined;
  }
}

async function handleResult(result) {
  if (result.status === 'captcha') {
    challenge = 'captcha';
    authForm.hidden = true;
    challengeImage.src = result.image;
    challengeImage.hidden = false;
    challengeLabel.textContent = messages.captchaLabel ?? '';
    challengeForm.hidden = false;
    authStatus.textContent = '';
    return;
  }
  if (result.status === 'two-factor') {
    challenge = 'two-factor';
    authForm.hidden = true;
    challengeImage.hidden = true;
    challengeLabel.textContent = messages.twoFactorLabel ?? '';
    challengeForm.hidden = false;
    authStatus.textContent = result.method;
    return;
  }

  challengeForm.hidden = true;
  if (result.status === 'restart-required') {
    authForm.hidden = true;
    authStatus.textContent = messages.authSuccess ?? '';
    await saveAuthenticatedConfig();
  } else if (result.status === 'blocked' || result.status === 'plugin-running') {
    authForm.hidden = false;
    authStatus.textContent = messages.authBlocked ?? '';
  } else if (result.status === 'timed-out') {
    authForm.hidden = false;
    authStatus.textContent = messages.authTimedOut ?? '';
  } else {
    authForm.hidden = false;
    authStatus.textContent = messages.authFailed ?? '';
  }
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const existing = pluginConfig.find((block) => block.platform === 'HomebridgeEufy') ?? {};
  const retained = Object.fromEntries(
    ['pollingIntervalMinutes', 'ffmpegPath', 'entityPreferences', 'discardedV4Settings', 'discardedV4Acknowledged']
      .filter((key) => Object.hasOwn(existing, key))
      .map((key) => [key, existing[key]]),
  );
  pendingConfig = {
    ...retained,
    platform: 'HomebridgeEufy',
    username: accountInput.value.trim(),
    password: passwordInput.value,
    country: countryInput.value.trim().toUpperCase(),
    trustedDeviceName: trustedDeviceInput.value.trim(),
    ...(legacyNames.length > 0 ? { discardedV4Settings: legacyNames } : {}),
    ...(legacyAcknowledged ? { discardedV4Acknowledged: true } : {}),
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
  homebridge.disableSaveButton();
  shell.dataset.theme = await homebridge.userCurrentLightingMode();
  const language = await homebridge.i18nCurrentLang();
  pluginConfig = await homebridge.getPluginConfig();
  savedConfigSignature = configSignature(pluginConfig);
  await applyTranslations(language);
  try {
    renderDiagnostics(await requestWithinDeadline('/diagnostics/status', undefined, 12000));
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
  }
  const configured = pluginConfig.find(
    (block) =>
      block.platform === 'HomebridgeEufy' && typeof block.username === 'string' && block.username.trim().length > 0,
  );
  const v5Block = configuredBlock();
  if (v5Block?.discardedV4Settings?.length) {
    legacyNames = v5Block.discardedV4Settings;
    legacyAcknowledged = v5Block.discardedV4Acknowledged === true;
  } else {
    const legacyBlock = pluginConfig.find((block) => block.platform === 'EufySecurity');
    if (legacyBlock) {
      legacyNames = legacySettingsView.names(legacyBlock);
    }
  }
  legacyNotice.hidden = legacyNames.length === 0 || legacyAcknowledged;
  legacySettings.textContent = legacyNames.join(', ');

  firstSetup.hidden = Boolean(configured);
  setupContent.hidden = !configured;
  acknowledgement.checked = false;
  continueButton.disabled = true;
  accountInput.value = configured?.username ?? '';
  passwordInput.value = configured?.password ?? '';
  countryInput.value = configured?.country ?? 'US';
  trustedDeviceInput.value = configured?.trustedDeviceName ?? 'Homebridge Eufy';
  if (configured) {
    const representationPreferences = Object.fromEntries(
      Object.entries(configuredBlock()?.entityPreferences ?? {})
        .filter(([, preference]) => typeof preference.represented === 'boolean')
        .map(([serial, preference]) => [serial, preference.represented]),
    );
    try {
      dashboardView.render(
        await requestWithinDeadline('/dashboard', { representationPreferences }, 12000),
        configuredBlock() ?? {},
        messages,
        dashboardElements,
      );
    } catch {
      dashboardView.render({ state: 'missing', devices: [] }, configuredBlock() ?? {}, messages, dashboardElements);
    }
  }
});
