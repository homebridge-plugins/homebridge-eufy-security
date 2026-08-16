import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

async function renderUi(
  script: string,
  pluginConfig: Array<Record<string, unknown>>,
  catalogs: Record<string, Record<string, string>>,
  language = 'en',
  translationKeys: string[] = [],
  authenticationStart: Record<string, unknown> = {
    status: 'captcha',
    image: 'data:image/png;base64,c3ludGhldGlj',
    retry: false,
  },
  dashboardSnapshot: Record<string, unknown> = { state: 'ready', devices: [] },
  diagnosticsSnapshot: Record<string, unknown> = {
    status: 'inactive',
    selectedEvidence: [],
    missingEvidence: [],
    partialExportAvailable: false,
  },
) {
  function interactiveElement<T extends object>(state: T) {
    const listeners: Record<string, Array<(event?: { preventDefault(): void }) => void | Promise<void>>> = {};
    return Object.assign(state, {
      addEventListener(event: string, listener: (event?: { preventDefault(): void }) => void | Promise<void>) {
        (listeners[event] ??= []).push(listener);
      },
      async dispatch(event: string, detail: Record<string, unknown> = {}) {
        await Promise.all(listeners[event]?.map((listener) => listener({ preventDefault() {}, ...detail })) ?? []);
      },
    });
  }

  const shell = { dataset: {} as Record<string, string>, lang: '' };
  const masthead = { hidden: false };
  const firstSetup = interactiveElement({ hidden: true });
  const setupContent = { hidden: true };
  const acknowledgement = interactiveElement({ checked: false });
  const continueButton = interactiveElement({ disabled: true });
  const authForm = interactiveElement({ hidden: false });
  const challengeForm = interactiveElement({ hidden: true });
  const account = { value: '' };
  const password = { value: '' };
  const country = { value: '' };
  const trustedDeviceName = { value: '' };
  const challengeAnswer = { value: '' };
  const challengeImage = { hidden: true, src: '' };
  const challengeLabel = { textContent: '' };
  const authStatus = { textContent: '' };
  const authSubmit = { disabled: false };
  const challengeSubmit = { disabled: false };
  const dashboard = { hidden: true, dataset: {} as Record<string, string> };
  const dashboardState = { hidden: false };
  const dashboardTitle = { textContent: '' };
  const dashboardBadge = { textContent: '' };
  const dashboardSummary = { hidden: false, textContent: '' };
  const dashboardAuthenticate = interactiveElement({ hidden: true });
  const deviceGroups = interactiveElement({ hidden: false, innerHTML: '' });
  const pageTitle = { textContent: '' };
  const legacyNotice = { hidden: true };
  const legacySettings = { textContent: '' };
  const legacyAcknowledge = interactiveElement({});
  const dashboardMenuTrigger = interactiveElement({
    attributes: { 'aria-expanded': 'false' },
    focused: false,
    focus() {
      this.focused = true;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  });
  const dashboardMenu = { hidden: true };
  const menuDiagnostics = interactiveElement({});
  const menuAdvanced = interactiveElement({});
  const diagnosticsPanel = { hidden: true, scrollIntoView() {} };
  const diagnosticsClose = interactiveElement({ focus() {} });
  const diagnosticsProfile = interactiveElement({ disabled: false, value: 'startup-authentication' });
  const diagnosticsAuthorize = interactiveElement({ disabled: false, textContent: '' });
  const diagnosticsReproduction = interactiveElement({ disabled: true, textContent: '' });
  const diagnosticsStatus = { textContent: '' };
  const diagnosticsIssue = { hidden: true, href: '' };
  const diagnosticsResult = { hidden: true };
  const diagnosticsSteps = { dataset: {} as Record<string, string> };
  const diagnosticsGuidanceTitle = { textContent: '' };
  const diagnosticsGuidanceSummary = { textContent: '' };
  const diagnosticsGuidanceBefore = { textContent: '' };
  const diagnosticsGuidanceAction = { textContent: '' };
  const diagnosticsCase = { hidden: true, textContent: '' };
  const advancedPanel = { hidden: true, scrollIntoView() {} };
  const advancedClose = interactiveElement({ focus() {} });
  const advancedPolling = interactiveElement({
    value: '',
    validityMessage: '',
    setCustomValidity(message: string) {
      this.validityMessage = message;
    },
    reportValidity() {},
  });
  const advancedFfmpeg = interactiveElement({ value: '' });
  const advancedStatus = { textContent: '' };
  const browserWindow = interactiveElement({});
  const requests: Array<{ path: string; body: unknown }> = [];
  let updatedConfig: Array<Record<string, unknown>> | undefined;
  let saves = 0;
  let saveButtonDisables = 0;
  let saveButtonEnables = 0;
  const translatedNodes = translationKeys.map((key) => ({ dataset: { i18n: key }, textContent: '__untranslated__' }));
  const translatedLabels = [
    'accountConnectionLabel',
    'closeAdvanced',
    'closeDiagnostics',
    'dashboardMenuLabel',
    'setupSequenceLabel',
  ].map((key) => ({
    attributes: { 'aria-label': '__untranslated__' },
    dataset: { i18nAriaLabel: key },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  }));
  let ready: (() => Promise<void>) | undefined;

  runInNewContext(script, {
    document: {
      querySelector(selector: string) {
        return {
          '[data-first-setup]': firstSetup,
          '[data-first-setup-ack]': acknowledgement,
          '[data-first-setup-continue]': continueButton,
          '[data-setup-content]': setupContent,
          '[data-ui-shell]': shell,
          '[data-masthead]': masthead,
          '[data-auth-form]': authForm,
          '[data-challenge-form]': challengeForm,
          '[data-account]': account,
          '[data-password]': password,
          '[data-country]': country,
          '[data-trusted-device-name]': trustedDeviceName,
          '[data-challenge-answer]': challengeAnswer,
          '[data-challenge-image]': challengeImage,
          '[data-challenge-label]': challengeLabel,
          '[data-auth-status]': authStatus,
          '[data-auth-submit]': authSubmit,
          '[data-challenge-submit]': challengeSubmit,
          '[data-dashboard]': dashboard,
          '[data-dashboard-state]': dashboardState,
          '[data-dashboard-title]': dashboardTitle,
          '[data-dashboard-badge]': dashboardBadge,
          '[data-dashboard-summary]': dashboardSummary,
          '[data-dashboard-authenticate]': dashboardAuthenticate,
          '[data-device-groups]': deviceGroups,
          '[data-page-title]': pageTitle,
          '[data-legacy-notice]': legacyNotice,
          '[data-legacy-settings]': legacySettings,
          '[data-legacy-acknowledge]': legacyAcknowledge,
          '[data-dashboard-menu-trigger]': dashboardMenuTrigger,
          '[data-dashboard-menu]': dashboardMenu,
          '[data-menu-diagnostics]': menuDiagnostics,
          '[data-menu-advanced]': menuAdvanced,
          '[data-diagnostics]': diagnosticsPanel,
          '[data-diagnostics-close]': diagnosticsClose,
          '[data-diagnostics-profile]': diagnosticsProfile,
          '[data-diagnostics-authorize]': diagnosticsAuthorize,
          '[data-diagnostics-reproduction]': diagnosticsReproduction,
          '[data-diagnostics-status]': diagnosticsStatus,
          '[data-diagnostics-issue]': diagnosticsIssue,
          '[data-diagnostics-result]': diagnosticsResult,
          '[data-diagnostics-steps]': diagnosticsSteps,
          '[data-diagnostics-guidance-title]': diagnosticsGuidanceTitle,
          '[data-diagnostics-guidance-summary]': diagnosticsGuidanceSummary,
          '[data-diagnostics-guidance-before]': diagnosticsGuidanceBefore,
          '[data-diagnostics-guidance-action]': diagnosticsGuidanceAction,
          '[data-diagnostics-case]': diagnosticsCase,
          '[data-advanced-settings]': advancedPanel,
          '[data-advanced-close]': advancedClose,
          '[data-advanced-polling]': advancedPolling,
          '[data-advanced-ffmpeg]': advancedFfmpeg,
          '[data-advanced-status]': advancedStatus,
        }[selector];
      },
      querySelectorAll(selector: string) {
        return selector === '[data-i18n]' ? translatedNodes : translatedLabels;
      },
    },
    fetch: async (path: string) => ({
      json: async () => catalogs[path],
      ok: path in catalogs,
    }),
    clearTimeout,
    homebridge: {
      addEventListener(event: string, listener: () => Promise<void>) {
        if (event === 'ready') {
          ready = listener;
        }
      },
      getPluginConfig: async () => pluginConfig,
      disableSaveButton: () => {
        saveButtonDisables++;
      },
      enableSaveButton: () => {
        saveButtonEnables++;
      },
      i18nCurrentLang: async () => language,
      request: async (path: string, body: unknown) => {
        if (path === '/diagnostics/status') {
          return diagnosticsSnapshot;
        }
        requests.push({ path, body });
        if (path === '/auth/start') return authenticationStart;
        if (path === '/dashboard') return dashboardSnapshot;
        return { status: 'restart-required' };
      },
      savePluginConfig: async () => {
        saves++;
      },
      updatePluginConfig: async (config: Array<Record<string, unknown>>) => {
        updatedConfig = config;
        return config;
      },
      userCurrentLightingMode: async () => 'dark',
    },
    setTimeout,
    window: browserWindow,
  });

  await ready?.();
  return {
    firstSetup,
    authForm,
    authStatus,
    account,
    acknowledgement,
    challengeAnswer,
    challengeForm,
    challengeImage,
    continueButton,
    country,
    password,
    dashboard,
    dashboardState,
    dashboardBadge,
    dashboardSummary,
    dashboardAuthenticate,
    dashboardTitle,
    dashboardMenu,
    dashboardMenuTrigger,
    deviceGroups,
    menuAdvanced,
    menuDiagnostics,
    diagnosticsPanel,
    diagnosticsClose,
    diagnosticsProfile,
    diagnosticsAuthorize,
    diagnosticsReproduction,
    diagnosticsStatus,
    diagnosticsIssue,
    diagnosticsResult,
    diagnosticsGuidanceAction,
    diagnosticsGuidanceBefore,
    diagnosticsGuidanceSummary,
    diagnosticsGuidanceTitle,
    diagnosticsSteps,
    advancedPanel,
    advancedClose,
    advancedPolling,
    advancedFfmpeg,
    advancedStatus,
    legacyAcknowledge,
    legacyNotice,
    legacySettings,
    requests,
    setupContent,
    shell,
    masthead,
    get saves() {
      return saves;
    },
    get saveButtonDisables() {
      return saveButtonDisables;
    },
    get saveButtonEnables() {
      return saveButtonEnables;
    },
    get updatedConfig() {
      return updatedConfig;
    },
    trustedDeviceName,
    browserWindow,
    translatedLabels: Object.fromEntries(
      translatedLabels.map((node) => [node.dataset.i18nAriaLabel, node.attributes['aria-label']]),
    ),
    translations: Object.fromEntries(translatedNodes.map((node) => [node.dataset.i18n, node.textContent])),
  };
}

describe('packed plugin', () => {
  it('keeps the runtime dependency and entry-point surface closed', () => {
    const repository = fileURLToPath(new URL('../..', import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
      displayName: string;
      name: string;
      version: string;
      main?: string;
      dependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(join(repository, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const sdk = packageLock.packages['node_modules/@mega-yfue/eufy-sdk'];
    const generatedVersion = readFileSync(join(repository, 'src', 'version.ts'), 'utf8');

    expect(packageJson.displayName).toBe('Homebridge Eufy');
    expect(packageJson.name).toBe('@homebridge-plugins/homebridge-eufy-security');
    expect(packageJson.main).toBe('dist/index.js');
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      '@homebridge/plugin-ui-utils',
      '@mega-yfue/eufy-sdk',
      'ffmpeg-for-homebridge',
    ]);
    expect(packageJson.dependencies?.['@mega-yfue/eufy-sdk']).toBe('0.1.0-beta.17');
    expect(sdk).toEqual(
      expect.objectContaining({
        version: '0.1.0-beta.17',
        integrity: 'sha512-k5ai6k44JqR+fcxZxmL1NG2kP68T55V08C+W0w0x81N2H+gcmtPGha5flbqyYJV/sl4l8wWbHO3tR9OFG8xzyw==',
      }),
    );
    expect(generatedVersion).toBe(`export const LIB_VERSION = ${JSON.stringify(packageJson.version)};\n`);
  });

  it('contains an importable runtime and production custom UI shell', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'homebridge-eufy-security-'));
    const repository = fileURLToPath(new URL('../..', import.meta.url));

    try {
      const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
        cwd: repository,
        encoding: 'utf8',
      });
      const [result] = JSON.parse(output) as PackResult[];
      execFileSync('tar', ['-xzf', join(directory, result.filename), '-C', directory]);

      const entryPoint = pathToFileURL(join(directory, 'package', 'dist', 'index.js'));
      const plugin = (await import(entryPoint.href)) as { default: unknown };
      const packageDirectory = join(directory, 'package');
      const packedPackage = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
        name: string;
      };
      const schema = JSON.parse(readFileSync(join(packageDirectory, 'config.schema.json'), 'utf8')) as {
        customUi?: boolean;
      };
      const document = readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'index.html'), 'utf8');
      const script = ['dashboard.js', 'legacy-settings.js', 'app.js']
        .map((file) => readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'js', file), 'utf8'))
        .join('\n');
      const server = readFileSync(join(packageDirectory, 'homebridge-ui', 'server.js'), 'utf8');
      const stylesheet = readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'app.css'), 'utf8');
      const runtimeMessages = JSON.parse(
        readFileSync(join(packageDirectory, 'i18n', 'runtime', 'en.json'), 'utf8'),
      ) as Record<string, string>;
      const catalogs = Object.fromEntries(
        ['en', 'fr'].map((language) => [
          `i18n/${language}.json`,
          JSON.parse(
            readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'i18n', `${language}.json`), 'utf8'),
          ) as Record<string, string>,
        ]),
      );
      const logos = ['logo.svg', 'logo-dark.svg'].map((file) =>
        readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'assets', file), 'utf8'),
      );
      const darkTheme = stylesheet.match(/\.shell\[data-theme="dark"\] \{(?<declarations>[^}]+)\}/)?.groups
        ?.declarations;
      const translationKeys = [
        ...new Set([...document.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1])),
      ].sort();
      const translatedLabelKeys = [...document.matchAll(/data-i18n-aria-label="([^"]+)"/g)]
        .map((match) => match[1])
        .sort();
      const uiFiles = result.files
        .map((file) => file.path)
        .filter((path) => path.startsWith('homebridge-ui/'))
        .sort();
      const deviceArtworkFiles = uiFiles.filter((path) => path.startsWith('homebridge-ui/public/assets/devices/'));
      const uiShellFiles = uiFiles.filter((path) => !path.startsWith('homebridge-ui/public/assets/devices/'));

      expect(plugin.default).toBeTypeOf('function');
      expect(packedPackage.name).toBe('@homebridge-plugins/homebridge-eufy-security');
      expect(schema.customUi).toBe(true);
      expect(result.files.map((file) => file.path)).toContain('dist/ui/server.js');
      expect(result.files.map((file) => file.path)).toContain('i18n/runtime/en.json');
      expect(Object.keys(runtimeMessages).every((key) => key.startsWith('log.'))).toBe(true);
      expect(runtimeMessages['log.condition.active']).toContain('{summary}');
      expect(uiShellFiles).toEqual([
        'homebridge-ui/public/app.css',
        'homebridge-ui/public/assets/icons/bolt.svg',
        'homebridge-ui/public/assets/icons/bug-report.svg',
        'homebridge-ui/public/assets/icons/inventory.svg',
        'homebridge-ui/public/assets/icons/settings.svg',
        'homebridge-ui/public/assets/icons/settings_backup_restore.svg',
        'homebridge-ui/public/assets/icons/troubleshoot.svg',
        'homebridge-ui/public/assets/icons/warning.svg',
        'homebridge-ui/public/assets/logo-dark.svg',
        'homebridge-ui/public/assets/logo.svg',
        'homebridge-ui/public/i18n/en.json',
        'homebridge-ui/public/i18n/fr.json',
        'homebridge-ui/public/index.html',
        'homebridge-ui/public/js/app.js',
        'homebridge-ui/public/js/dashboard.js',
        'homebridge-ui/public/js/legacy-settings.js',
        'homebridge-ui/server.js',
      ]);
      expect(deviceArtworkFiles).toHaveLength(153);
      expect(
        deviceArtworkFiles.every((path) =>
          /^homebridge-ui\/public\/assets\/devices\/(?:clean|life|mower|security)\/[A-Za-z0-9-]+\.png$/.test(path),
        ),
      ).toBe(true);
      expect(document).toContain('data-authentication="ready"');
      expect(document).toContain('aria-current="step"');
      expect(document).toContain('href="app.css"');
      expect(document).toContain('src="js/app.js"');
      expect(document).toContain('src="js/dashboard.js"');
      expect(document).toContain('src="js/legacy-settings.js"');
      expect(document).toContain('src="assets/logo.svg"');
      expect(document).toContain('src="assets/logo-dark.svg"');
      expect(document).toContain('src="assets/icons/inventory.svg"');
      expect(document).toContain('src="assets/icons/bug-report.svg"');
      expect(document).toContain('src="assets/icons/settings.svg"');
      expect(document).toContain('src="assets/icons/warning.svg"');
      expect(document.match(/class="dashboard-page-back"/g)).toHaveLength(2);
      expect(document.match(/aria-hidden="true">←<\/span>/g)).toHaveLength(2);
      expect(document).toContain('homebridge-eufy-security/issues/1010');
      expect(document).toContain('data-first-setup hidden');
      expect(document).toContain('data-first-setup-ack');
      expect(document).toContain('data-first-setup-continue');
      expect(document).toContain('data-auth-form');
      expect(document).toContain('data-challenge-form');
      expect(document).toMatch(/data-setup-content\s+hidden/);
      expect(document).toContain('support.eufylife.com/s/article/Share-Your-eufySecurity-Devices-With-Your-Family');
      expect(document).not.toContain('Connect your Eufy account');
      expect(document).not.toContain('First-time setup');
      expect(translationKeys).toEqual(
        [
          'accountLabel',
          'acknowledge',
          'advancedDeviceHelp',
          'advancedEyebrow',
          'advancedFfmpegHelp',
          'advancedFfmpegLabel',
          'advancedPollingHelp',
          'advancedPollingLabel',
          'advancedSummary',
          'advancedTitle',
          'authenticate',
          'authReady',
          'authSummary',
          'available',
          'brand',
          'firstSetupEyebrow',
          'firstSetupIntro',
          'firstSetupAcknowledgement',
          'firstSetupContinue',
          'firstSetupReasonBody',
          'firstSetupReasonLabel',
          'firstSetupTitle',
          'footnote',
          'continueAuthentication',
          'countryLabel',
          'devicesEyebrow',
          'diagnosticsAuthorize',
          'diagnosticsActionLabel',
          'diagnosticsArchivePlan',
          'diagnosticsArchiveUnavailable',
          'diagnosticsBeforeLabel',
          'diagnosticsEvidenceReady',
          'diagnosticsEyebrow',
          'diagnosticsOpenIssue',
          'diagnosticsProfileControl',
          'diagnosticsProfileDashboard',
          'diagnosticsProfileDevices',
          'diagnosticsProfileLabel',
          'diagnosticsProfileLiveMedia',
          'diagnosticsProfileOther',
          'diagnosticsProfileRecording',
          'diagnosticsProfileStartup',
          'diagnosticsPrivacy',
          'diagnosticsStartReproduction',
          'diagnosticsStepChoose',
          'diagnosticsStepReproduce',
          'diagnosticsStepReview',
          'diagnosticsSummary',
          'diagnosticsTitle',
          'oneAccountSession',
          'pageTitle',
          'passwordLabel',
          'legacyEyebrow',
          'legacySummary',
          'legacyTitle',
          'menuAdvanced',
          'menuDiagnostics',
          'menuRelogin',
          'sessionDetails',
          'setupStatusEyebrow',
          'shareLink',
          'stepAuthenticate',
          'stepDevices',
          'stepDiscover',
          'trustedDeviceLabel',
        ].sort(),
      );
      expect(translatedLabelKeys).toEqual([
        'accountConnectionLabel',
        'closeAdvanced',
        'closeDiagnostics',
        'dashboardMenuLabel',
        'setupSequenceLabel',
      ]);
      const expectedCatalogKeys = [
        ...translationKeys,
        ...translatedLabelKeys,
        'authBlocked',
        'authFailed',
        'authSuccess',
        'authTimedOut',
        'advancedSaveFailed',
        'advancedPollingInvalid',
        'captchaLabel',
        'twoFactorLabel',
        'categoryClean',
        'categoryLife',
        'categorySecurity',
        'closeDetails',
        'dashboardAuthenticationRequiredBadge',
        'dashboardAuthenticationRequiredSummary',
        'dashboardAuthenticationRequiredTitle',
        'dashboardDegradedBadge',
        'dashboardDegradedSummary',
        'dashboardDegradedTitle',
        'dashboardIncompleteBadge',
        'dashboardIncompleteSummary',
        'dashboardIncompleteTitle',
        'dashboardMissingBadge',
        'dashboardMissingSummary',
        'dashboardMissingTitle',
        'dashboardOwnerConflictBadge',
        'dashboardOwnerConflictSummary',
        'dashboardOwnerConflictTitle',
        'dashboardPageTitle',
        'dashboardReadyBadge',
        'dashboardReadySummary',
        'dashboardReadyTitle',
        'dashboardStaleBadge',
        'dashboardStaleSummary',
        'dashboardStaleTitle',
        'diagnosticDescription',
        'diagnosticOnly',
        'diagnosticsAuthorized',
        'diagnosticsCase',
        'diagnosticsComplete',
        'diagnosticsControlAction',
        'diagnosticsControlBefore',
        'diagnosticsControlSummary',
        'diagnosticsDashboardAction',
        'diagnosticsDashboardBefore',
        'diagnosticsDashboardSummary',
        'diagnosticsDevicesAction',
        'diagnosticsDevicesBefore',
        'diagnosticsDevicesSummary',
        'diagnosticsEndReproduction',
        'diagnosticsExpired',
        'diagnosticsFailed',
        'diagnosticsInactive',
        'diagnosticsLiveAction',
        'diagnosticsLiveBefore',
        'diagnosticsLiveSummary',
        'diagnosticsMissingEvidence',
        'diagnosticsOtherAction',
        'diagnosticsOtherBefore',
        'diagnosticsOtherSummary',
        'diagnosticsProfileChanged',
        'diagnosticsReauthorize',
        'diagnosticsRecordingAction',
        'diagnosticsRecordingBefore',
        'diagnosticsRecordingSummary',
        'diagnosticsReproducing',
        'diagnosticsStartupAction',
        'diagnosticsStartupBefore',
        'diagnosticsStartupSummary',
        'preferenceAudio',
        'preferenceRepresented',
        'preferenceSaveFailed',
        'preferenceSnapshotMode',
        'snapshotModeCloudDescription',
        'snapshotModeLiveDescription',
        'snapshotModeRefreshDescription',
      ].sort();
      expect(Object.keys(catalogs['i18n/en.json']).sort()).toEqual(expectedCatalogKeys);
      expect(Object.keys(catalogs['i18n/fr.json']).sort()).toEqual(expectedCatalogKeys);
      expect([document, script, JSON.stringify(catalogs)].join('\n')).not.toMatch(/\b(?:SDK|runtime|IPC)\b/i);
      expect(logos.join('\n')).not.toMatch(/\bSDK\b/i);
      expect(document).not.toMatch(/<!doctype|<(?:html|head|body)(?:\s|>)/i);
      expect(script).toContain('homebridge.userCurrentLightingMode()');
      expect(server).toContain("from '../dist/ui/server.js'");
      expect(stylesheet).toContain('--accent: #00bfc4');
      expect(stylesheet).toContain('.device-tile-changed');
      expect(stylesheet).toContain('.preference-changed');
      expect(stylesheet).toContain('.device-card-settings::after');
      expect(darkTheme).toContain('--ink: #edf1f7');
      expect(darkTheme).not.toContain('var(--bs-');

      const firstSetupUi = await renderUi(script, [], catalogs);
      expect(firstSetupUi).toMatchObject({
        continueButton: { disabled: true },
        firstSetup: { hidden: false },
        setupContent: { hidden: true },
        saveButtonDisables: 1,
        saveButtonEnables: 0,
      });
      await firstSetupUi.continueButton.dispatch('click');
      expect(firstSetupUi).toMatchObject({ firstSetup: { hidden: false }, setupContent: { hidden: true } });
      firstSetupUi.acknowledgement.checked = true;
      await firstSetupUi.acknowledgement.dispatch('change');
      expect(firstSetupUi.continueButton.disabled).toBe(false);
      await firstSetupUi.continueButton.dispatch('click');
      expect(firstSetupUi).toMatchObject({ firstSetup: { hidden: true }, setupContent: { hidden: false } });

      await expect(renderUi(script, [{ platform: 'HomebridgeEufy' }], catalogs)).resolves.toMatchObject({
        firstSetup: { hidden: false },
        setupContent: { hidden: true },
      });
      await expect(
        renderUi(script, [{ platform: 'HomebridgeEufy', username: 'guest@example.invalid' }], catalogs),
      ).resolves.toMatchObject({
        firstSetup: { hidden: true },
        setupContent: { hidden: true },
        dashboard: { hidden: false, dataset: { state: 'ready' } },
        masthead: { hidden: true },
        shell: { dataset: { theme: 'dark' } },
      });

      const frenchUi = await renderUi(script, [], catalogs, 'fr-FR', translationKeys);
      expect(frenchUi).toMatchObject({
        shell: { lang: 'fr' },
        translations: {
          firstSetupTitle: 'Utilisez un compte invité Eufy dédié',
          footnote:
            'Indépendant et non officiel. Non affilié, approuvé ou sponsorisé par Anker Innovations ou eufy. « eufy » et « Anker » sont des marques de leurs propriétaires respectifs. Utilisez ce logiciel de manière responsable : des connexions rapides ou échouées peuvent déclencher un captcha ou une limitation temporaire.',
          pageTitle: 'Connectez votre compte Eufy',
        },
      });
      expect(Object.values(frenchUi.translations)).not.toContain('__untranslated__');
      expect(Object.values(frenchUi.translations)).not.toContain(undefined);
      expect(frenchUi.translatedLabels).toEqual({
        accountConnectionLabel: 'Informations sur la connexion du compte',
        closeAdvanced: 'Retour aux appareils',
        closeDiagnostics: 'Retour aux appareils',
        dashboardMenuLabel: 'Ouvrir le menu du tableau de bord',
        setupSequenceLabel: 'Étapes de configuration',
      });
      const englishUi = await renderUi(script, [], catalogs, 'es', translationKeys);
      expect(englishUi).toMatchObject({
        shell: { lang: 'en' },
        translations: {
          footnote:
            'Independent and unofficial. Not affiliated with, endorsed by, or sponsored by Anker Innovations or eufy. "eufy" and "Anker" are trademarks of their respective owners. Use responsibly — rapid or failed logins can trigger captcha or temporary cooldowns.',
          pageTitle: 'Connect your Eufy account',
        },
      });
      expect(Object.values(englishUi.translations)).not.toContain('__untranslated__');
      expect(Object.values(englishUi.translations)).not.toContain(undefined);

      const menuUi = await renderUi(
        script,
        [
          {
            platform: 'HomebridgeEufy',
            username: 'guest@example.invalid',
            pollingIntervalMinutes: 15,
            ffmpegPath: '/synthetic/ffmpeg',
          },
        ],
        catalogs,
      );
      await menuUi.dashboardMenuTrigger.dispatch('click');
      expect(menuUi.dashboardMenu).toMatchObject({ hidden: false });
      expect(menuUi.dashboardMenuTrigger.attributes['aria-expanded']).toBe('true');
      await menuUi.menuDiagnostics.dispatch('click');
      expect(menuUi).toMatchObject({
        dashboardMenu: { hidden: true },
        dashboardState: { hidden: true },
        dashboardSummary: { hidden: true },
        deviceGroups: { hidden: true },
        diagnosticsPanel: { hidden: false },
        diagnosticsIssue: { hidden: true },
        diagnosticsResult: { hidden: true },
        diagnosticsSteps: { dataset: { phase: 'choose' } },
        diagnosticsGuidanceTitle: { textContent: catalogs['i18n/en.json'].diagnosticsProfileStartup },
        diagnosticsGuidanceSummary: { textContent: catalogs['i18n/en.json'].diagnosticsStartupSummary },
      });
      menuUi.diagnosticsProfile.value = 'control-state';
      await menuUi.diagnosticsProfile.dispatch('change');
      expect(menuUi.diagnosticsGuidanceAction.textContent).toBe(catalogs['i18n/en.json'].diagnosticsControlAction);
      await menuUi.diagnosticsClose.dispatch('click');
      expect(menuUi.diagnosticsPanel.hidden).toBe(true);
      expect(menuUi).toMatchObject({
        dashboardState: { hidden: false },
        dashboardSummary: { hidden: false },
        deviceGroups: { hidden: false },
      });
      await menuUi.dashboardMenuTrigger.dispatch('click');
      await menuUi.menuAdvanced.dispatch('click');
      expect(menuUi).toMatchObject({
        advancedPanel: { hidden: false },
        advancedPolling: { value: '15' },
        advancedFfmpeg: { value: '/synthetic/ffmpeg' },
      });
      menuUi.advancedPolling.value = '5';
      await menuUi.advancedPolling.dispatch('change');
      expect(menuUi.updatedConfig?.[0]).toMatchObject({ pollingIntervalMinutes: 5, ffmpegPath: '/synthetic/ffmpeg' });
      menuUi.advancedPolling.value = '';
      await menuUi.advancedPolling.dispatch('change');
      expect(menuUi.updatedConfig?.[0]).not.toHaveProperty('pollingIntervalMinutes');
      menuUi.advancedPolling.value = '2.5';
      await menuUi.advancedPolling.dispatch('change');
      expect(menuUi.advancedPolling.validityMessage).toBe(catalogs['i18n/en.json'].advancedPollingInvalid);
      expect(menuUi.updatedConfig?.[0]).not.toHaveProperty('pollingIntervalMinutes');
      await menuUi.advancedClose.dispatch('click');
      expect(menuUi.advancedPanel.hidden).toBe(true);

      const completedDiagnosticsUi = await renderUi(
        script,
        [{ platform: 'HomebridgeEufy', username: 'guest@example.invalid' }],
        catalogs,
        'en',
        [],
        undefined,
        undefined,
        {
          status: 'complete',
          supportCaseId: 'support-00000000-0000-4000-8000-000000000000',
          profile: 'startup-authentication',
          expiresAt: '2026-08-19T10:18:42.832Z',
          selectedEvidence: ['plugin-log', 'sdk-log'],
          missingEvidence: [],
          partialExportAvailable: true,
          issueUrl: 'https://example.invalid/issue',
        },
      );
      expect(completedDiagnosticsUi).toMatchObject({
        diagnosticsSteps: { dataset: { phase: 'review' } },
        diagnosticsIssue: { hidden: false, href: 'https://example.invalid/issue' },
        diagnosticsResult: { hidden: false },
      });

      englishUi.account.value = 'guest@example.invalid';
      englishUi.password.value = 'synthetic-password';
      englishUi.country.value = 'US';
      englishUi.trustedDeviceName.value = 'Synthetic Homebridge';
      await englishUi.authForm.dispatch('submit');
      expect(englishUi.requests).toEqual([
        {
          path: '/auth/start',
          body: {
            configuration: {
              platform: 'HomebridgeEufy',
              username: 'guest@example.invalid',
              password: 'synthetic-password',
              country: 'US',
              trustedDeviceName: 'Synthetic Homebridge',
            },
          },
        },
      ]);
      expect(englishUi.challengeForm.hidden).toBe(false);
      expect(englishUi.authForm.hidden).toBe(true);
      expect(englishUi.challengeImage).toMatchObject({
        hidden: false,
        src: 'data:image/png;base64,c3ludGhldGlj',
      });
      englishUi.challengeAnswer.value = '1234';
      await englishUi.challengeForm.dispatch('submit');
      expect(englishUi.requests[1]).toEqual({ path: '/auth/captcha', body: { answer: '1234' } });
      expect(englishUi.updatedConfig).toEqual([
        {
          platform: 'HomebridgeEufy',
          username: 'guest@example.invalid',
          password: 'synthetic-password',
          country: 'US',
          trustedDeviceName: 'Synthetic Homebridge',
        },
      ]);
      expect(englishUi).toMatchObject({
        authForm: { hidden: true },
        authStatus: { textContent: catalogs['i18n/en.json'].authSuccess },
        challengeForm: { hidden: true },
      });
      expect(englishUi.saves).toBe(1);
      expect(englishUi.saveButtonEnables).toBe(2);
      expect(englishUi.saveButtonDisables).toBe(1);

      const migrationFixture = JSON.parse(
        readFileSync(join(repository, 'test', 'fixtures', 'v4-migration.json'), 'utf8'),
      ) as {
        cachedAccessory: { plugin: string };
        configuration: Record<string, unknown>;
      };
      expect(migrationFixture.cachedAccessory.plugin).toBe(packedPackage.name);
      const migratedUi = await renderUi(script, [migrationFixture.configuration], catalogs, 'en', [], {
        status: 'restart-required',
      });
      expect(migratedUi).toMatchObject({
        account: { value: '' },
        country: { value: 'US' },
        firstSetup: { hidden: false },
        trustedDeviceName: { value: 'Homebridge Eufy' },
      });
      migratedUi.account.value = 'replacement@example.invalid';
      migratedUi.password.value = 'replacement-password';
      migratedUi.country.value = 'GB';
      migratedUi.trustedDeviceName.value = 'Replacement bridge';
      await migratedUi.authForm.dispatch('submit');
      const expectedMigratedConfig = {
        platform: 'HomebridgeEufy',
        username: 'replacement@example.invalid',
        password: 'replacement-password',
        country: 'GB',
        trustedDeviceName: 'Replacement bridge',
        discardedV4Settings: [
          'cameras',
          'cleanCache',
          'enableDetailedLogging',
          'experimentalMode',
          'ignoreDevices',
          'ignoreStations',
          'stations',
          'syncStationModes',
          'useEmbeddedPKCS1Support',
        ],
      };
      expect(migratedUi.requests).toEqual([{ path: '/auth/start', body: { configuration: expectedMigratedConfig } }]);
      expect(migratedUi.updatedConfig).toEqual([expectedMigratedConfig]);
      expect(migratedUi.legacyNotice.hidden).toBe(false);
      await migratedUi.legacyAcknowledge.dispatch('click');
      expect(migratedUi.legacyNotice.hidden).toBe(true);
      expect(migratedUi.updatedConfig?.[0]).toMatchObject({ discardedV4Acknowledged: true });

      const dashboardUi = await renderUi(
        script,
        [
          {
            platform: 'HomebridgeEufy',
            username: 'guest@example.invalid',
            entityPreferences: {
              'synthetic-absent': { audio: false },
              'synthetic-contact': { represented: false },
            },
          },
        ],
        catalogs,
        'en',
        [],
        undefined,
        {
          state: 'degraded',
          devices: [
            {
              serial: 'synthetic-diagnostic',
              name: 'Unsupported sensor',
              modelName: 'Synthetic diagnostic sensor',
              category: 'security',
              deviceClass: 'sensor',
              recognized: true,
              represented: false,
              controllable: false,
              diagnosticOnly: true,
              preferences: [],
            },
            {
              serial: 'synthetic-contact',
              name: 'Front contact',
              modelName: 'Synthetic contact sensor',
              artwork: 'assets/devices/security/security-T8910.png',
              category: 'security',
              deviceClass: 'sensor',
              recognized: true,
              represented: true,
              controllable: false,
              diagnosticOnly: false,
              preferences: ['represented', 'audio', 'snapshotMode'],
            },
            {
              serial: 'synthetic-back-contact',
              name: 'Back contact',
              modelName: 'Synthetic contact sensor',
              category: 'security',
              deviceClass: 'sensor',
              recognized: true,
              represented: true,
              controllable: false,
              diagnosticOnly: false,
              preferences: ['represented'],
            },
            {
              serial: 'synthetic-camera',
              name: 'Entry camera',
              modelName: 'Synthetic camera',
              category: 'security',
              deviceClass: 'camera',
              recognized: true,
              represented: true,
              controllable: false,
              diagnosticOnly: false,
              preferences: ['represented'],
            },
            {
              serial: 'synthetic-vacuum',
              name: 'Floor cleaner',
              modelName: 'Synthetic vacuum',
              category: 'clean',
              deviceClass: 'vacuum',
              recognized: true,
              represented: false,
              controllable: false,
              diagnosticOnly: true,
              preferences: [],
            },
          ],
        },
      );
      expect(dashboardUi).toMatchObject({
        dashboard: { hidden: false, dataset: { state: 'degraded' } },
        dashboardBadge: { textContent: catalogs['i18n/en.json'].dashboardDegradedBadge },
        setupContent: { hidden: true },
      });
      expect(dashboardUi.deviceGroups.innerHTML).toContain('Front contact');
      expect(dashboardUi.deviceGroups.innerHTML).toContain('device-tile-disabled');
      expect(dashboardUi.deviceGroups.innerHTML).toContain('data-requires-representation hidden');
      expect(dashboardUi.deviceGroups.innerHTML).toContain('assets/devices/security/security-T8910.png');
      expect(dashboardUi.deviceGroups.innerHTML.indexOf('Back contact')).toBeLessThan(
        dashboardUi.deviceGroups.innerHTML.indexOf('Front contact'),
      );
      expect(dashboardUi.deviceGroups.innerHTML.indexOf('Entry camera')).toBeLessThan(
        dashboardUi.deviceGroups.innerHTML.indexOf('Back contact'),
      );
      expect(dashboardUi.deviceGroups.innerHTML.indexOf('Front contact')).toBeLessThan(
        dashboardUi.deviceGroups.innerHTML.indexOf('Unsupported sensor'),
      );
      expect(dashboardUi.deviceGroups.innerHTML).toContain('Floor cleaner');
      expect(dashboardUi.deviceGroups.innerHTML.indexOf('Front contact')).toBeLessThan(
        dashboardUi.deviceGroups.innerHTML.indexOf('Floor cleaner'),
      );
      expect(dashboardUi.deviceGroups.innerHTML).toContain(catalogs['i18n/en.json'].diagnosticOnly);
      expect(dashboardUi.deviceGroups.innerHTML.match(/device-tile-flippable/g)).toHaveLength(5);
      expect(dashboardUi.deviceGroups.innerHTML.match(/device-mobile-close/g)).toHaveLength(5);
      expect(dashboardUi.deviceGroups.innerHTML.match(/diagnostic-panel/g)).toHaveLength(2);
      expect(dashboardUi.deviceGroups.innerHTML.match(/preference-panel/g)).toHaveLength(3);
      await dashboardUi.deviceGroups.dispatch('change', {
        target: {
          checked: true,
          dataset: { preference: 'represented', serial: 'synthetic-contact' },
        },
      });
      expect(dashboardUi.updatedConfig?.[0].entityPreferences).toEqual({
        'synthetic-absent': { audio: false },
      });
      expect(dashboardUi.saveButtonEnables).toBe(1);
      expect(dashboardUi.saveButtonDisables).toBe(1);
      expect(dashboardUi.saves).toBe(0);
      await dashboardUi.deviceGroups.dispatch('change', {
        target: {
          checked: false,
          dataset: { preference: 'represented', serial: 'synthetic-contact' },
        },
      });
      expect(dashboardUi.updatedConfig?.[0].entityPreferences).toEqual({
        'synthetic-absent': { audio: false },
        'synthetic-contact': { represented: false },
      });
      expect(dashboardUi.saveButtonEnables).toBe(1);
      expect(dashboardUi.saveButtonDisables).toBe(2);
      expect(script).not.toContain('appendChild(entry)');

      const twoFactorUi = await renderUi(script, [], catalogs, 'en', [], {
        status: 'two-factor',
        method: 'Synthetic verification',
      });
      await twoFactorUi.authForm.dispatch('submit');
      expect(twoFactorUi).toMatchObject({
        authForm: { hidden: true },
        authStatus: { textContent: 'Synthetic verification' },
        challengeForm: { hidden: false },
        challengeImage: { hidden: true },
      });
      await englishUi.browserWindow.dispatch('pagehide');
      expect(englishUi.requests[2]).toEqual({ path: '/auth/close', body: undefined });
      await expect(renderUi(script, [], {}, 'fr', translationKeys)).resolves.toMatchObject({
        firstSetup: { hidden: false },
        shell: { lang: 'en' },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);
});
