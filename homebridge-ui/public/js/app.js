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
const dashboardState = document.querySelector('[data-dashboard-state]');
const dashboardTitle = document.querySelector('[data-dashboard-title]');
const dashboardBadge = document.querySelector('[data-dashboard-badge]');
const dashboardSummary = document.querySelector('[data-dashboard-summary]');
const dashboardAuthenticate = document.querySelector('[data-dashboard-authenticate]');
const deviceGroups = document.querySelector('[data-device-groups]');
const pageTitle = document.querySelector('[data-page-title]');
const legacyNotice = document.querySelector('[data-legacy-notice]');
const legacySettings = document.querySelector('[data-legacy-settings]');
const legacyAcknowledge = document.querySelector('[data-legacy-acknowledge]');
const menuDiagnostics = document.querySelector('[data-menu-diagnostics]');
const menuAdvanced = document.querySelector('[data-menu-advanced]');
const diagnosticsPanel = document.querySelector('[data-diagnostics]');
const diagnosticsClose = document.querySelector('[data-diagnostics-close]');
const diagnosticsWizardPanel = document.querySelector('[data-diagnostics-wizard]');
const diagnosticsQuestion = document.querySelector('[data-diagnostics-question]');
const diagnosticsQuestionText = document.querySelector('[data-diagnostics-question-text]');
const diagnosticsYes = document.querySelector('[data-diagnostics-answer="yes"]');
const diagnosticsNo = document.querySelector('[data-diagnostics-answer="no"]');
const diagnosticsDirect = document.querySelector('[data-diagnostics-direct]');
const diagnosticsDirectPanel = document.querySelector('[data-diagnostics-direct-panel]');
const diagnosticsDirectChoose = document.querySelector('[data-diagnostics-direct-choose]');
const diagnosticsDirectBack = document.querySelector('[data-diagnostics-direct-back]');
const diagnosticsMatch = document.querySelector('[data-diagnostics-match]');
const diagnosticsReject = document.querySelector('[data-diagnostics-reject]');
const diagnosticsProfile = document.querySelector('[data-diagnostics-profile]');
const diagnosticsAuthorize = document.querySelector('[data-diagnostics-authorize]');
const diagnosticsReproduction = document.querySelector('[data-diagnostics-reproduction]');
const diagnosticsStatus = document.querySelector('[data-diagnostics-status]');
const diagnosticsIssue = document.querySelector('[data-diagnostics-issue]');
const diagnosticsResult = document.querySelector('[data-diagnostics-result]');
const diagnosticsSteps = document.querySelector('[data-diagnostics-steps]');
const diagnosticsActions = document.querySelector('[data-diagnostics-actions]');
const diagnosticsGuidanceTitle = document.querySelector('[data-diagnostics-guidance-title]');
const diagnosticsGuidanceSummary = document.querySelector('[data-diagnostics-guidance-summary]');
const diagnosticsGuidance = document.querySelector('[data-diagnostics-guidance]');
const diagnosticsPhaseTitle = document.querySelector('[data-diagnostics-phase-title]');
const diagnosticsGuidanceBeforeSection = document.querySelector('[data-diagnostics-guidance-before-section]');
const diagnosticsGuidanceBefore = document.querySelector('[data-diagnostics-guidance-before]');
const diagnosticsGuidanceAction = document.querySelector('[data-diagnostics-guidance-action]');
const diagnosticsCase = document.querySelector('[data-diagnostics-case]');
const diagnosticsReview = document.querySelector('[data-diagnostics-review]');
const diagnosticsManifest = document.querySelector('[data-diagnostics-manifest]');
const diagnosticsReviewConfirm = document.querySelector('[data-diagnostics-review-confirm]');
const diagnosticsReviewConfirmLabel = document.querySelector('[data-diagnostics-review-confirm-label]');
const diagnosticsExport = document.querySelector('[data-diagnostics-export]');
const diagnosticsResultHeading = document.querySelector('[data-diagnostics-result-heading]');
const diagnosticsStartAnother = document.querySelector('[data-diagnostics-start-another]');
const advancedPanel = document.querySelector('[data-advanced-settings]');
const advancedClose = document.querySelector('[data-advanced-close]');
const advancedPolling = document.querySelector('[data-advanced-polling]');
const advancedFfmpeg = document.querySelector('[data-advanced-ffmpeg]');
const advancedStatus = document.querySelector('[data-advanced-status]');

let messages = {};
let pluginConfig = [];
let savedConfigSignature = '';
let pendingConfig;
let challenge = '';
let legacyNames = [];
let legacyAcknowledged = false;
let diagnosticsState = { status: 'inactive', missingEvidence: [] };
let diagnosticsReviewId = '';
let diagnosticsStartingAnother = false;
let dashboardPanelTrigger;
const dashboardView = window.HomebridgeEufyDashboard;
const legacySettingsView = window.HomebridgeEufyLegacySettings;
const diagnosticsWizard = window.HomebridgeEufyDiagnosticsWizard;
let diagnosticsWizardState = diagnosticsWizard.start();
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

const diagnosticsProfiles = {
  'startup-authentication': {
    title: 'diagnosticsProfileStartup',
    summary: 'diagnosticsStartupSummary',
    before: 'diagnosticsStartupBefore',
    action: 'diagnosticsStartupAction',
  },
  'device-representation': {
    title: 'diagnosticsProfileDevices',
    summary: 'diagnosticsDevicesSummary',
    before: 'diagnosticsDevicesBefore',
    action: 'diagnosticsDevicesAction',
  },
  'control-state': {
    title: 'diagnosticsProfileControl',
    summary: 'diagnosticsControlSummary',
    before: 'diagnosticsControlBefore',
    action: 'diagnosticsControlAction',
  },
  'live-media': {
    title: 'diagnosticsProfileLiveMedia',
    summary: 'diagnosticsLiveSummary',
    before: 'diagnosticsLiveBefore',
    action: 'diagnosticsLiveAction',
  },
  'hksv-recording': {
    title: 'diagnosticsProfileRecording',
    summary: 'diagnosticsRecordingSummary',
    before: 'diagnosticsRecordingBefore',
    action: 'diagnosticsRecordingAction',
  },
  'dashboard-ui': {
    title: 'diagnosticsProfileDashboard',
    summary: 'diagnosticsDashboardSummary',
    before: 'diagnosticsDashboardBefore',
    action: 'diagnosticsDashboardAction',
  },
  other: {
    title: 'diagnosticsProfileOther',
    summary: 'diagnosticsOtherSummary',
    before: 'diagnosticsOtherBefore',
    action: 'diagnosticsOtherAction',
  },
};

function renderDiagnosticsGuidance(profile) {
  const guidance = diagnosticsProfiles[profile] ?? diagnosticsProfiles.other;
  diagnosticsGuidanceTitle.textContent = messages[guidance.title] ?? '';
  diagnosticsGuidanceSummary.textContent = messages[guidance.summary] ?? '';
  diagnosticsPhaseTitle.textContent = messages[guidance.title] ?? '';
  diagnosticsGuidanceBefore.textContent = messages[guidance.before] ?? '';
  diagnosticsGuidanceAction.textContent = messages[guidance.action] ?? '';
}

function renderDiagnosticsWizard() {
  diagnosticsQuestion.hidden = diagnosticsWizardState.mode !== 'questions';
  diagnosticsDirectPanel.hidden = diagnosticsWizardState.mode !== 'direct';
  diagnosticsMatch.hidden = diagnosticsWizardState.mode !== 'match';
  if (diagnosticsWizardState.mode === 'questions') {
    const question = diagnosticsWizard.questions[diagnosticsWizardState.questionIndex];
    diagnosticsQuestionText.textContent = messages[question.message] ?? '';
  }
  if (diagnosticsWizardState.mode === 'match') {
    diagnosticsProfile.value = diagnosticsWizardState.profile;
    renderDiagnosticsGuidance(diagnosticsWizardState.profile);
  }
}

function renderDiagnostics(state) {
  diagnosticsState = state;
  const screen = diagnosticsWizard.screen(state, diagnosticsStartingAnother);
  const phase = screen === 'review' ? 'review' : screen === 'reproduce' ? 'reproduce' : 'choose';
  diagnosticsSteps.dataset.phase = phase;
  const choosing = screen === 'choose';
  const reviewing = screen === 'review';
  diagnosticsWizardPanel.hidden = !choosing;
  diagnosticsGuidance.hidden = screen !== 'reproduce';
  diagnosticsGuidanceBeforeSection.hidden = state.status === 'reproducing';
  diagnosticsActions.hidden = screen !== 'reproduce';
  diagnosticsReproduction.disabled = !['authorized', 'reproducing'].includes(state.status);
  diagnosticsReproduction.textContent =
    state.status === 'reproducing' ? messages.diagnosticsEndReproduction : messages.diagnosticsStartReproduction;
  diagnosticsIssue.hidden = !reviewing;
  diagnosticsIssue.href = state.issueUrl ?? '';
  diagnosticsResult.hidden = !reviewing;
  diagnosticsReview.hidden = !reviewing;
  diagnosticsManifest.hidden = true;
  diagnosticsReviewConfirmLabel.hidden = true;
  diagnosticsReviewConfirm.checked = false;
  diagnosticsExport.hidden = true;
  diagnosticsExport.disabled = true;
  diagnosticsReviewId = '';
  if (state.profile) diagnosticsProfile.value = state.profile;
  if (screen === 'reproduce') renderDiagnosticsGuidance(state.profile);
  if (choosing) renderDiagnosticsWizard();
  diagnosticsCase.hidden = diagnosticsStartingAnother || !state.supportCaseId;
  diagnosticsCase.textContent = state.supportCaseId
    ? (messages.diagnosticsCase ?? '')
        .replace('{caseId}', state.supportCaseId)
        .replace('{expiresAt}', new Date(state.expiresAt).toLocaleString(shell.lang || 'en'))
    : '';
  const statusKey = reviewing
    ? state.missingEvidence?.length
      ? 'diagnosticsMissingEvidence'
      : 'diagnosticsComplete'
    : {
        inactive: 'diagnosticsInactive',
        authorized: 'diagnosticsAuthorized',
        reproducing: 'diagnosticsReproducing',
        complete: state.missingEvidence?.length ? 'diagnosticsMissingEvidence' : 'diagnosticsComplete',
        expired: 'diagnosticsExpired',
      }[state.status];
  diagnosticsStatus.textContent = (
    choosing && (state.status === 'inactive' || diagnosticsStartingAnother) ? '' : (messages[statusKey] ?? '')
  ).replace('{evidence}', state.missingEvidence?.join(', ') ?? '');
}

function renderArchiveManifest(manifest) {
  diagnosticsManifest.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = `${manifest.archiveFormat} v${manifest.version} · ${manifest.keyId} · ${(messages.diagnosticsArchiveExpires ?? '').replace('{expiresAt}', new Date(manifest.archiveExpiresAt).toLocaleString(shell.lang || 'en'))}`;
  const evidence = document.createElement('ul');
  for (const item of manifest.evidence ?? []) {
    const row = document.createElement('li');
    const size = item.bytes === undefined ? '' : ` · ${item.bytes} B`;
    const truncated = item.truncated ? ` · ${messages.diagnosticsArchiveTruncated ?? ''}` : '';
    const missing = item.missingReason ? ` · ${item.missingReason}` : '';
    const fields = (item.fields ?? []).map((field) => `${field.field}: ${field.privacyClass}`).join(', ');
    row.textContent = `${item.evidence} · ${item.privacyClass} · ${item.status}${missing}${size}${truncated}${fields ? ` · ${messages.diagnosticsArchiveFields ?? ''} ${fields}` : ''}`;
    evidence.append(row);
  }
  const exclusions = document.createElement('p');
  exclusions.textContent = `${messages.diagnosticsArchiveExcluded ?? ''} ${(manifest.excludedClasses ?? []).join(', ')}`;
  diagnosticsManifest.append(summary, evidence, exclusions);
  diagnosticsManifest.hidden = false;
}

diagnosticsReview.addEventListener('click', async () => {
  diagnosticsReview.disabled = true;
  try {
    const review = await requestWithinDeadline('/diagnostics/archive/review', undefined, 12000);
    diagnosticsReviewId = review.reviewId;
    renderArchiveManifest(review.manifest);
    diagnosticsReviewConfirmLabel.hidden = false;
    diagnosticsExport.hidden = false;
  } catch {
    try {
      renderDiagnostics(await requestWithinDeadline('/diagnostics/status', undefined, 12000));
      diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    } catch {
      diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    }
  } finally {
    diagnosticsReview.disabled = false;
  }
});

diagnosticsReviewConfirm.addEventListener('change', () => {
  diagnosticsExport.disabled = !diagnosticsReviewConfirm.checked || !diagnosticsReviewId;
});

diagnosticsExport.addEventListener('click', async () => {
  if (!diagnosticsReviewConfirm.checked || !diagnosticsReviewId) return;
  diagnosticsExport.disabled = true;
  try {
    const exported = await requestWithinDeadline(
      '/diagnostics/archive/export',
      { reviewId: diagnosticsReviewId },
      12000,
    );
    const download = document.createElement('a');
    download.href = `data:${exported.mediaType};base64,${exported.archive}`;
    download.download = exported.filename;
    document.body.appendChild(download);
    download.click();
    document.body.removeChild(download);
    diagnosticsReviewId = '';
    diagnosticsReviewConfirm.checked = false;
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
  }
});

diagnosticsAuthorize.addEventListener('click', async () => {
  diagnosticsAuthorize.disabled = true;
  let focusAuthorizeAfter = false;
  const previousStatus = diagnosticsState.status;
  try {
    const authorized = await requestWithinDeadline(
      '/diagnostics/authorize',
      { profile: diagnosticsWizardState.profile },
      12000,
    );
    diagnosticsStartingAnother = false;
    renderDiagnostics(authorized);
    if (diagnosticsState.status === 'authorized') diagnosticsGuidance.focus?.();
  } catch {
    try {
      const refreshed = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
      if (refreshed.status !== previousStatus) diagnosticsStartingAnother = false;
      renderDiagnostics(refreshed);
      if (refreshed.status === previousStatus) {
        diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
        focusAuthorizeAfter = true;
      }
      else if (refreshed.status === 'authorized') diagnosticsGuidance.focus?.();
    } catch {
      diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    }
  } finally {
    diagnosticsAuthorize.disabled = false;
    if (focusAuthorizeAfter) diagnosticsAuthorize.focus?.();
  }
});

diagnosticsYes.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.answer(diagnosticsWizardState, true);
  renderDiagnosticsWizard();
  diagnosticsGuidanceTitle.focus?.();
});

diagnosticsNo.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.answer(diagnosticsWizardState, false);
  renderDiagnosticsWizard();
  if (diagnosticsWizardState.mode === 'match') diagnosticsGuidanceTitle.focus?.();
  else diagnosticsQuestionText.focus?.();
});

diagnosticsDirect.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.direct();
  renderDiagnosticsWizard();
  diagnosticsProfile.focus?.();
});

diagnosticsDirectChoose.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.selectDirect(diagnosticsWizardState, diagnosticsProfile.value);
  renderDiagnosticsWizard();
  diagnosticsGuidanceTitle.focus?.();
});

diagnosticsDirectBack.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.start();
  renderDiagnosticsWizard();
  diagnosticsQuestionText.focus?.();
});

diagnosticsReject.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.reject(diagnosticsWizardState);
  renderDiagnosticsWizard();
  if (diagnosticsWizardState.mode === 'direct') diagnosticsProfile.focus?.();
  else diagnosticsQuestionText.focus?.();
});

diagnosticsStartAnother.addEventListener('click', () => {
  diagnosticsStartingAnother = true;
  diagnosticsWizardState = diagnosticsWizard.start();
  renderDiagnostics(diagnosticsState);
  diagnosticsQuestionText.focus?.();
});

diagnosticsReproduction.addEventListener('click', async () => {
  diagnosticsReproduction.disabled = true;
  const previousStatus = diagnosticsState.status;
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
    if (state.status === 'complete' || state.partialExportAvailable) diagnosticsResultHeading.focus?.();
  } catch {
    try {
      const refreshed = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
      renderDiagnostics(refreshed);
      if (refreshed.status === previousStatus) diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
      if (refreshed.status === 'complete' || refreshed.partialExportAvailable) diagnosticsResultHeading.focus?.();
      else if (refreshed.status === 'authorized' || refreshed.status === 'reproducing') diagnosticsGuidance.focus?.();
    } catch {
      diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    }
  } finally {
    diagnosticsReproduction.disabled = !['authorized', 'reproducing'].includes(diagnosticsState.status);
  }
});

function openDashboardPanel(panel, trigger) {
  dashboardPanelTrigger = trigger;
  dashboardState.hidden = true;
  dashboardSummary.hidden = true;
  deviceGroups.hidden = true;
  diagnosticsPanel.hidden = panel !== diagnosticsPanel;
  advancedPanel.hidden = panel !== advancedPanel;
  panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  (panel === diagnosticsPanel ? diagnosticsClose : advancedClose).focus?.();
}

function closeDashboardPanel() {
  diagnosticsPanel.hidden = true;
  advancedPanel.hidden = true;
  dashboardState.hidden = false;
  dashboardSummary.hidden = false;
  deviceGroups.hidden = false;
  dashboardPanelTrigger?.focus?.();
}

menuDiagnostics.addEventListener('click', async () => {
  openDashboardPanel(diagnosticsPanel, menuDiagnostics);
  try {
    renderDiagnostics(await requestWithinDeadline('/diagnostics/status', undefined, 12000));
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
  }
});
menuAdvanced.addEventListener('click', () => {
  const config = configuredBlock() ?? {};
  advancedPolling.value = String(config.pollingIntervalMinutes ?? 10);
  advancedFfmpeg.value = config.ffmpegPath ?? '';
  openDashboardPanel(advancedPanel, menuAdvanced);
});
diagnosticsClose.addEventListener('click', () => {
  diagnosticsStartingAnother = false;
  renderDiagnostics(diagnosticsState);
  closeDashboardPanel();
});
advancedClose.addEventListener('click', () => {
  closeDashboardPanel();
});

async function updateAdvancedSettings() {
  const existing = configuredBlock();
  if (!existing) return;
  const rawPolling = advancedPolling.value.trim();
  const pollingIntervalMinutes = rawPolling === '' ? 10 : Number(rawPolling);
  if (!Number.isInteger(pollingIntervalMinutes) || pollingIntervalMinutes < 0) {
    advancedPolling.setCustomValidity?.(messages.advancedPollingInvalid ?? '');
    advancedPolling.reportValidity?.();
    return;
  }
  advancedPolling.setCustomValidity?.('');
  const ffmpegPath = advancedFfmpeg.value.trim();
  const next = { ...existing };
  if (pollingIntervalMinutes === 10) delete next.pollingIntervalMinutes;
  else next.pollingIntervalMinutes = pollingIntervalMinutes;
  if (ffmpegPath) next.ffmpegPath = ffmpegPath;
  else delete next.ffmpegPath;
  try {
    await updateConfig(next);
    advancedStatus.textContent = '';
  } catch {
    advancedStatus.textContent = messages.advancedSaveFailed ?? '';
  }
}

advancedPolling.addEventListener('change', updateAdvancedSettings);
advancedFfmpeg.addEventListener('change', updateAdvancedSettings);

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
  const nextConfig = pluginConfig.map((candidate) => (candidate.platform === 'HomebridgeEufy' ? block : candidate));
  if (!nextConfig.includes(block)) nextConfig.push(block);
  await homebridge.updatePluginConfig(nextConfig);
  pluginConfig = nextConfig;
  if (configSignature(nextConfig) === savedConfigSignature) homebridge.disableSaveButton();
  else homebridge.enableSaveButton();
}

dashboardView.bindPreferences(dashboardElements, configuredBlock, updateConfig, () => messages);

dashboardAuthenticate.addEventListener('click', () => {
  diagnosticsPanel.hidden = true;
  advancedPanel.hidden = true;
  dashboard.hidden = true;
  setupContent.hidden = false;
  masthead.hidden = false;
  pageTitle.textContent = messages.pageTitle;
  accountInput.focus?.();
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
