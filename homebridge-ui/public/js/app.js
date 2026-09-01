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
const diagnosticsFrequency = document.querySelector('[data-diagnostics-frequency]');
const diagnosticsFrequencyHeading = document.querySelector('#diagnostics-frequency-heading');
const diagnosticsFrequencyNow = document.querySelector('[data-diagnostics-frequency-answer="now"]');
const diagnosticsFrequencyIntermittent = document.querySelector('[data-diagnostics-frequency-answer="intermittent"]');
const diagnosticsFrequencyBack = document.querySelector('[data-diagnostics-frequency-back]');
const diagnosticsMatch = document.querySelector('[data-diagnostics-match]');
const diagnosticsReject = document.querySelector('[data-diagnostics-reject]');
const diagnosticsProfile = document.querySelector('[data-diagnostics-profile]');
const diagnosticsAuthorize = document.querySelector('[data-diagnostics-authorize]');
const diagnosticsReproduction = document.querySelector('[data-diagnostics-reproduction]');
const diagnosticsStatus = document.querySelector('[data-diagnostics-status]');
const diagnosticsIssue = document.querySelector('[data-diagnostics-issue]');
const diagnosticsResult = document.querySelector('[data-diagnostics-result]');
const diagnosticsActions = document.querySelector('[data-diagnostics-actions]');
const diagnosticsGuidanceTitle = document.querySelector('[data-diagnostics-guidance-title]');
const diagnosticsModeSummary = document.querySelector('[data-diagnostics-mode-summary]');
const diagnosticsGuidance = document.querySelector('[data-diagnostics-guidance]');
const diagnosticsPhaseTitle = document.querySelector('[data-diagnostics-phase-title]');
const diagnosticsGuidanceBeforeSection = document.querySelector('[data-diagnostics-guidance-before-section]');
const diagnosticsGuidanceBefore = document.querySelector('[data-diagnostics-guidance-before]');
const diagnosticsGuidanceAction = document.querySelector('[data-diagnostics-guidance-action]');
const diagnosticsReview = document.querySelector('[data-diagnostics-review]');
const diagnosticsManifest = document.querySelector('[data-diagnostics-manifest]');
const diagnosticsReviewConfirm = document.querySelector('[data-diagnostics-review-confirm]');
const diagnosticsReviewConfirmLabel = document.querySelector('[data-diagnostics-review-confirm-label]');
const diagnosticsExport = document.querySelector('[data-diagnostics-export]');
const diagnosticsResultHeading = document.querySelector('[data-diagnostics-result-heading]');
const diagnosticsStartAnother = document.querySelector('[data-diagnostics-start-another]');
const diagnosticsBackgroundAction = document.querySelector('[data-diagnostics-background-action]');
const advancedPanel = document.querySelector('[data-advanced-settings]');
const advancedClose = document.querySelector('[data-advanced-close]');
const advancedPolling = document.querySelector('[data-advanced-polling]');
const advancedConcurrentMedia = document.querySelector('[data-advanced-concurrent-media]');
const advancedFfmpeg = document.querySelector('[data-advanced-ffmpeg]');
const warmUpAvailable = document.querySelector('[data-warm-up-available]');
const warmUpChosen = document.querySelector('[data-warm-up-chosen]');
const warmUpAdd = document.querySelector('[data-warm-up-add]');
const warmUpAddAll = document.querySelector('[data-warm-up-add-all]');
const warmUpRemove = document.querySelector('[data-warm-up-remove]');
const warmUpRemoveAll = document.querySelector('[data-warm-up-remove-all]');
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

function isDashboardUiReproducing(state = diagnosticsState) {
  return diagnosticsWizard.backgroundActive(state);
}

async function recordActiveUiEvent(event) {
  if (!isDashboardUiReproducing()) return;
  await requestWithinDeadline('/diagnostics/ui-event', { event }, 12000);
}

function recordActiveUiEventBestEffort(event) {
  void recordActiveUiEvent(event).catch(() => undefined);
}

acknowledgement.addEventListener('change', () => {
  continueButton.disabled = !acknowledgement.checked;
});

continueButton.addEventListener('click', () => {
  if (!acknowledgement.checked) return;
  firstSetup.hidden = true;
  setupContent.hidden = false;
});

/**
 * Declares the resolved locale on both the document root and the shell.
 *
 * The root element is what assistive technology reads to choose pronunciation and what a translation tool
 * reads to identify the page's language; the shell attribute is what this script's own date formatting reads.
 */
function applyLocale(locale) {
  document.documentElement.lang = locale;
  shell.lang = locale;
}

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
      applyLocale(locale);
      return;
    }
  }

  applyLocale(locale);
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
  diagnosticsPhaseTitle.textContent = messages[guidance.title] ?? '';
  diagnosticsGuidanceBefore.textContent = messages[guidance.before] ?? '';
  diagnosticsGuidanceAction.textContent = messages[guidance.action] ?? '';
}

function renderDiagnosticsWizard() {
  diagnosticsQuestion.hidden = diagnosticsWizardState.mode !== 'questions';
  diagnosticsDirectPanel.hidden = diagnosticsWizardState.mode !== 'direct';
  diagnosticsFrequency.hidden = diagnosticsWizardState.mode !== 'frequency';
  diagnosticsMatch.hidden = diagnosticsWizardState.mode !== 'match';
  if (diagnosticsWizardState.mode === 'questions') {
    const question = diagnosticsWizard.questions[diagnosticsWizardState.questionIndex];
    diagnosticsQuestionText.textContent = messages[question.message] ?? '';
  }
  if (diagnosticsWizardState.mode === 'match') {
    diagnosticsProfile.value = diagnosticsWizardState.profile;
    renderDiagnosticsGuidance(diagnosticsWizardState.profile);
    diagnosticsModeSummary.textContent =
      messages[
        diagnosticsWizardState.reproductionMode === 'intermittent'
          ? 'diagnosticsModeIntermittentSummary'
          : 'diagnosticsModeNowSummary'
      ] ?? '';
  }
}

function renderDiagnostics(state) {
  diagnosticsState = state;
  const screen = diagnosticsWizard.screen(state, diagnosticsStartingAnother);
  const choosing = screen === 'choose';
  const reviewing = screen === 'review';
  const reproductionMode = state.reproductionMode ?? 'now';
  const dashboardBackground = isDashboardUiReproducing(state);
  diagnosticsBackgroundAction.hidden = !dashboardBackground;
  diagnosticsWizardPanel.hidden = !choosing;
  diagnosticsGuidance.hidden = screen !== 'reproduce' || dashboardBackground;
  diagnosticsGuidanceBeforeSection.hidden = state.status === 'reproducing';
  diagnosticsActions.hidden = screen !== 'reproduce' || dashboardBackground;
  diagnosticsReproduction.disabled = !['authorized', 'reproducing'].includes(state.status);
  diagnosticsReproduction.textContent =
    reproductionMode === 'intermittent'
      ? state.status === 'reproducing'
        ? messages.diagnosticsIntermittentIssueHappened
        : messages.diagnosticsIntermittentStartWaiting
      : state.status === 'reproducing'
        ? messages.diagnosticsNowFinish
        : messages.diagnosticsStartCollection;
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
  if (screen === 'reproduce') {
    renderDiagnosticsGuidance(state.profile);
    if (reproductionMode === 'intermittent') {
      diagnosticsGuidanceBeforeSection.hidden = true;
      diagnosticsGuidanceAction.textContent =
        messages[
          state.status === 'reproducing'
            ? 'diagnosticsIntermittentWaitingGuidance'
            : 'diagnosticsIntermittentReadyGuidance'
        ] ?? '';
    }
  }
  if (choosing) renderDiagnosticsWizard();
  const statusKey = dashboardBackground
    ? 'diagnosticsBackgroundActive'
    : reviewing
      ? state.missingEvidence?.length
        ? 'diagnosticsMissingEvidence'
        : 'diagnosticsComplete'
      : {
          inactive: 'diagnosticsInactive',
          authorized:
            reproductionMode === 'intermittent' ? 'diagnosticsIntermittentAuthorized' : 'diagnosticsAuthorized',
          reproducing:
            reproductionMode === 'intermittent' ? 'diagnosticsIntermittentReproducing' : 'diagnosticsReproducing',
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
  const mode =
    messages[manifest.reproductionMode === 'intermittent' ? 'diagnosticsModeIntermittent' : 'diagnosticsModeNow'] ??
    manifest.reproductionMode;
  summary.textContent = `${manifest.archiveFormat} v${manifest.version} · ${manifest.keyId} · ${messages.diagnosticsArchiveMode ?? ''} ${mode} · ${(messages.diagnosticsArchiveExpires ?? '').replace('{expiresAt}', new Date(manifest.archiveExpiresAt).toLocaleString(shell.lang || 'en'))}`;
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
  const uncovered = (manifest.evidence ?? []).filter((item) => item.coversReproduction === false);
  if (uncovered.length > 0) {
    const gap = document.createElement('p');
    gap.textContent = (messages.diagnosticsArchiveCoverageGap ?? '')
      .replace('{classes}', uncovered.map((item) => item.evidence).join(', '))
      .replace(
        '{retainedFrom}',
        new Date(
          Math.min(...uncovered.map((item) => Date.parse(item.retainedFrom))),
        ).toLocaleString(shell.lang || 'en'),
      );
    diagnosticsManifest.append(gap);
  }
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
      {
        profile: diagnosticsWizardState.profile,
        reproductionMode: diagnosticsWizardState.reproductionMode,
      },
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
      } else if (refreshed.status === 'authorized') diagnosticsGuidance.focus?.();
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
  diagnosticsFrequencyHeading.focus?.();
});

diagnosticsNo.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.answer(diagnosticsWizardState, false);
  renderDiagnosticsWizard();
  if (diagnosticsWizardState.mode === 'frequency') diagnosticsFrequencyHeading.focus?.();
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
  diagnosticsFrequencyHeading.focus?.();
});

diagnosticsDirectBack.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.start();
  renderDiagnosticsWizard();
  diagnosticsQuestionText.focus?.();
});

function chooseDiagnosticsReproductionMode(reproductionMode) {
  diagnosticsWizardState = diagnosticsWizard.chooseReproductionMode(diagnosticsWizardState, reproductionMode);
  renderDiagnosticsWizard();
  diagnosticsGuidanceTitle.focus?.();
}

diagnosticsFrequencyNow.addEventListener('click', () => chooseDiagnosticsReproductionMode('now'));
diagnosticsFrequencyIntermittent.addEventListener('click', () => chooseDiagnosticsReproductionMode('intermittent'));

diagnosticsFrequencyBack.addEventListener('click', () => {
  diagnosticsWizardState = diagnosticsWizard.backFromFrequency(diagnosticsWizardState);
  renderDiagnosticsWizard();
  if (diagnosticsWizardState.mode === 'direct') diagnosticsProfile.focus?.();
  else diagnosticsQuestionText.focus?.();
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
    diagnosticsState.status === 'reproducing' ? '/diagnostics/reproduction/end' : '/diagnostics/reproduction/start';
  try {
    let state = await requestWithinDeadline(path, undefined, 12000);
    if (state.status === 'complete' && state.missingEvidence?.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
    }
    renderDiagnostics(state);
    if (previousStatus === 'authorized' && isDashboardUiReproducing(state)) {
      await recordActiveUiEvent('background-started').catch(() => undefined);
      closeDashboardPanel();
      return;
    }
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
  recordActiveUiEventBestEffort('dashboard-opened');
}

function openCompletedDiagnostics(trigger) {
  firstSetup.hidden = true;
  setupContent.hidden = true;
  dashboard.hidden = false;
  masthead.hidden = true;
  openDashboardPanel(diagnosticsPanel, trigger);
  diagnosticsResultHeading.focus?.();
}

diagnosticsBackgroundAction.addEventListener('click', async () => {
  diagnosticsBackgroundAction.disabled = true;
  try {
    await recordActiveUiEvent('issue-observed').catch(() => undefined);
    let state = await requestWithinDeadline('/diagnostics/reproduction/end', undefined, 12000);
    if (state.status === 'complete' && state.missingEvidence?.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
    }
    renderDiagnostics(state);
    openCompletedDiagnostics(diagnosticsBackgroundAction);
  } catch {
    await recordActiveUiEvent('request-failed').catch(() => undefined);
    try {
      const state = await requestWithinDeadline('/diagnostics/status', undefined, 12000);
      renderDiagnostics(state);
      if (state.status === 'complete' || state.partialExportAvailable) {
        openCompletedDiagnostics(diagnosticsBackgroundAction);
      } else {
        diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
      }
    } catch {
      diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    }
  } finally {
    diagnosticsBackgroundAction.disabled = false;
  }
});

menuDiagnostics.addEventListener('click', async () => {
  openDashboardPanel(diagnosticsPanel, menuDiagnostics);
  try {
    renderDiagnostics(await requestWithinDeadline('/diagnostics/status', undefined, 12000));
  } catch {
    diagnosticsStatus.textContent = messages.diagnosticsFailed ?? '';
    recordActiveUiEventBestEffort('request-failed');
  }
});
menuAdvanced.addEventListener('click', async () => {
  const config = configuredBlock() ?? {};
  advancedPolling.value = String(config.pollingIntervalMinutes ?? 10);
  advancedConcurrentMedia.value = String(config.maxConcurrentMediaSessions ?? 0);
  warmUpSelection = [...new Set(Array.isArray(config.warmUpEvents) ? config.warmUpEvents : ['doorbellPress'])].sort();
  warmUpMarked = new Set();
  renderWarmUp();
  advancedFfmpeg.value = config.ffmpegPath ?? '';
  openDashboardPanel(advancedPanel, menuAdvanced);
  /**
   * The panel asks for its own candidates rather than relying on the devices view having been opened first.
   * Without this a user who came straight here sees an empty left column, and clearing the right one would leave
   * the setting with no way back. Best effort: an unanswered request leaves whatever is already chosen.
   */
  if (warmUpCandidates.length === 0) {
    try {
      const snapshot = await requestWithinDeadline('/dashboard', { representationPreferences: {} }, 12000);
      warmUpCandidates = Array.isArray(snapshot.warmUpCandidates) ? snapshot.warmUpCandidates : [];
      renderWarmUp();
    } catch {
      recordActiveUiEventBestEffort('request-failed');
    }
  }
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
  const rawConcurrentMedia = advancedConcurrentMedia.value.trim();
  const maxConcurrentMediaSessions = rawConcurrentMedia === '' ? 0 : Number(rawConcurrentMedia);
  if (!Number.isInteger(maxConcurrentMediaSessions) || maxConcurrentMediaSessions < 0) {
    advancedConcurrentMedia.setCustomValidity?.(messages.advancedConcurrentMediaInvalid ?? '');
    advancedConcurrentMedia.reportValidity?.();
    return;
  }
  advancedConcurrentMedia.setCustomValidity?.('');
  const ffmpegPath = advancedFfmpeg.value.trim();
  const next = { ...existing };
  if (pollingIntervalMinutes === 10) delete next.pollingIntervalMinutes;
  else next.pollingIntervalMinutes = pollingIntervalMinutes;
  if (maxConcurrentMediaSessions === 0) delete next.maxConcurrentMediaSessions;
  else next.maxConcurrentMediaSessions = maxConcurrentMediaSessions;
  if (ffmpegPath) next.ffmpegPath = ffmpegPath;
  else delete next.ffmpegPath;
  // The default is what the plugin applies when the key is absent, so storing it would only pin today's default.
  if (warmUpSelection.length === 1 && warmUpSelection[0] === 'doorbellPress') delete next.warmUpEvents;
  else next.warmUpEvents = [...warmUpSelection];
  try {
    await updateConfig(next);
    advancedStatus.textContent = '';
  } catch {
    advancedStatus.textContent = messages.advancedSaveFailed ?? '';
    recordActiveUiEventBestEffort('request-failed');
  }
}

advancedPolling.addEventListener('change', updateAdvancedSettings);
advancedConcurrentMedia.addEventListener('change', updateAdvancedSettings);
advancedFfmpeg.addEventListener('change', updateAdvancedSettings);
warmUpAdd.addEventListener('click', () => moveWarmUp('available'));
warmUpAddAll.addEventListener('click', () => moveWarmUp('available', true));
warmUpRemove.addEventListener('click', () => moveWarmUp('chosen'));
warmUpRemoveAll.addEventListener('click', () => moveWarmUp('chosen', true));

let warmUpSelection = ['doorbellPress'];
let warmUpCandidates = [];
/**
 * The entries the user has marked, in whichever column they sit.
 *
 * One set is enough because an event is in exactly one column: the column follows from whether the selection
 * holds it. Marking is what makes the single arrows act on a choice rather than on whatever came first.
 */
let warmUpMarked = new Set();

/**
 * The events this interface may offer: whatever the discovered devices report, plus anything already chosen.
 *
 * Keeping a chosen event that no device currently reports is deliberate — a camera may be offline, and dropping
 * the entry would silently rewrite the user's setting on the next save.
 */
function warmUpOffered() {
  return [...new Set([...warmUpCandidates, ...warmUpSelection])].sort();
}

/**
 * A readable name for one event: the translation where this build has one, and otherwise a label derived from
 * the reported name. Deriving it is what lets a newly reported event appear without a release here.
 */
function warmUpLabel(event) {
  const translated = messages[`advancedWarmUpEvent_${event}`];
  if (translated) return translated;
  const spaced = event.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Draws both columns from the selection.
 *
 * Each entry is a button rather than an option, so a keyboard reaches it and a screen reader announces the
 * column it belongs to. The move buttons are disabled while there is nothing to move, because a control that
 * looks available and does nothing is worse than one that says it cannot.
 */
function renderWarmUp() {
  if (!warmUpAvailable || !warmUpChosen) return;
  const offered = warmUpOffered();
  const columns = [
    { list: warmUpAvailable, column: 'available', events: offered.filter((e) => !warmUpSelection.includes(e)) },
    { list: warmUpChosen, column: 'chosen', events: offered.filter((e) => warmUpSelection.includes(e)) },
  ];
  for (const { list, column, events } of columns) {
    list.textContent = '';
    for (const event of events) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = warmUpLabel(event);
      button.setAttribute('aria-pressed', String(warmUpMarked.has(event)));
      button.addEventListener('click', () => {
        if (warmUpMarked.has(event)) warmUpMarked.delete(event);
        else warmUpMarked.add(event);
        renderWarmUp();
      });
      item.append(button);
      list.append(item);
    }
  }
  const availableEvents = offered.filter((event) => !warmUpSelection.includes(event));
  // A control that looks available and moves nothing is worse than one that says it cannot.
  if (warmUpAdd) warmUpAdd.disabled = !availableEvents.some((event) => warmUpMarked.has(event));
  if (warmUpAddAll) warmUpAddAll.disabled = availableEvents.length === 0;
  if (warmUpRemove) warmUpRemove.disabled = !warmUpSelection.some((event) => warmUpMarked.has(event));
  if (warmUpRemoveAll) warmUpRemoveAll.disabled = warmUpSelection.length === 0;
}

/**
 * Moves every marked entry of one column across, or every entry of it when asked for all.
 *
 * The marks are cleared afterwards rather than carried over: the entry has visibly changed column, which is the
 * feedback, and leaving it marked would arm the opposite arrow with what was just moved.
 */
function moveWarmUp(from, all = false) {
  const offered = warmUpOffered();
  const source = from === 'available' ? offered.filter((event) => !warmUpSelection.includes(event)) : warmUpSelection;
  const moving = all ? source : source.filter((event) => warmUpMarked.has(event));
  if (moving.length === 0) return;
  warmUpSelection =
    from === 'available'
      ? [...new Set([...warmUpSelection, ...moving])].sort()
      : warmUpSelection.filter((event) => !moving.includes(event));
  warmUpMarked = new Set();
  renderWarmUp();
  void updateAdvancedSettings();
}

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
  recordActiveUiEventBestEffort('authentication-opened');
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
    [
      'pollingIntervalMinutes',
      'sessionWarmUp',
      'ffmpegPath',
      'entityPreferences',
      'discardedV4Settings',
      'discardedV4Acknowledged',
    ]
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
    recordActiveUiEventBestEffort('request-failed');
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
    recordActiveUiEventBestEffort('request-failed');
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
      const snapshot = await requestWithinDeadline('/dashboard', { representationPreferences }, 12000);
      // What the warm-up setting may offer comes from the devices themselves, so it is learnt here.
      warmUpCandidates = Array.isArray(snapshot.warmUpCandidates) ? snapshot.warmUpCandidates : [];
      dashboardView.render(snapshot, configuredBlock() ?? {}, messages, dashboardElements);
    } catch {
      dashboardView.render({ state: 'missing', devices: [] }, configuredBlock() ?? {}, messages, dashboardElements);
      recordActiveUiEventBestEffort('request-failed');
    }
    recordActiveUiEventBestEffort('dashboard-opened');
  }
});
