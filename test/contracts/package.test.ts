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
) {
  function interactiveElement<T extends object>(state: T) {
    const listeners: Record<string, Array<() => void>> = {};
    return Object.assign(state, {
      addEventListener(event: string, listener: () => void) {
        (listeners[event] ??= []).push(listener);
      },
      dispatch(event: string) {
        listeners[event]?.forEach((listener) => listener());
      },
    });
  }

  const shell = { dataset: {} as Record<string, string>, lang: '' };
  const firstSetup = interactiveElement({ hidden: true });
  const setupContent = { hidden: true };
  const acknowledgement = interactiveElement({ checked: false });
  const continueButton = interactiveElement({ disabled: true });
  const translatedNodes = translationKeys.map((key) => ({ dataset: { i18n: key }, textContent: '__untranslated__' }));
  const translatedLabels = ['accountConnectionLabel', 'setupSequenceLabel'].map((key) => ({
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
    homebridge: {
      addEventListener(event: string, listener: () => Promise<void>) {
        if (event === 'ready') {
          ready = listener;
        }
      },
      getPluginConfig: async () => pluginConfig,
      i18nCurrentLang: async () => language,
      userCurrentLightingMode: async () => 'dark',
    },
  });

  await ready?.();
  return {
    firstSetup,
    acknowledgement,
    continueButton,
    setupContent,
    shell,
    translatedLabels: Object.fromEntries(
      translatedLabels.map((node) => [node.dataset.i18nAriaLabel, node.attributes['aria-label']]),
    ),
    translations: Object.fromEntries(translatedNodes.map((node) => [node.dataset.i18n, node.textContent])),
  };
}

describe('packed plugin', () => {
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
      const schema = JSON.parse(readFileSync(join(packageDirectory, 'config.schema.json'), 'utf8')) as {
        customUi?: boolean;
      };
      const document = readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'index.html'), 'utf8');
      const script = readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'app.js'), 'utf8');
      const stylesheet = readFileSync(join(packageDirectory, 'homebridge-ui', 'public', 'app.css'), 'utf8');
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
      const translationKeys = [...document.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]).sort();
      const translatedLabelKeys = [...document.matchAll(/data-i18n-aria-label="([^"]+)"/g)]
        .map((match) => match[1])
        .sort();
      const uiFiles = result.files
        .map((file) => file.path)
        .filter((path) => path.startsWith('homebridge-ui/'))
        .sort();

      expect(plugin.default).toBeTypeOf('function');
      expect(schema.customUi).toBe(true);
      expect(uiFiles).toEqual([
        'homebridge-ui/public/app.css',
        'homebridge-ui/public/app.js',
        'homebridge-ui/public/assets/logo-dark.svg',
        'homebridge-ui/public/assets/logo.svg',
        'homebridge-ui/public/i18n/en.json',
        'homebridge-ui/public/i18n/fr.json',
        'homebridge-ui/public/index.html',
      ]);
      expect(document).toContain('data-authentication="unavailable"');
      expect(document).toContain('aria-current="step"');
      expect(document).toContain('href="app.css"');
      expect(document).toContain('src="app.js"');
      expect(document).toContain('src="assets/logo.svg"');
      expect(document).toContain('src="assets/logo-dark.svg"');
      expect(document).toContain('data-first-setup hidden');
      expect(document).toContain('data-first-setup-ack');
      expect(document).toContain('data-first-setup-continue');
      expect(document).toMatch(/data-setup-content\s+hidden/);
      expect(document).toContain('support.eufylife.com/s/article/Share-Your-eufySecurity-Devices-With-Your-Family');
      expect(document).not.toContain('Connect your Eufy account');
      expect(document).not.toContain('First-time setup');
      expect(translationKeys).toEqual(
        [
          'authNotReady',
          'authSummary',
          'authUnavailable',
          'brand',
          'comingNext',
          'firstSetupEyebrow',
          'firstSetupIntro',
          'firstSetupAcknowledgement',
          'firstSetupContinue',
          'firstSetupReasonBody',
          'firstSetupReasonLabel',
          'firstSetupTitle',
          'footnote',
          'oneAccountSession',
          'pageTitle',
          'sessionDetails',
          'setupStatusEyebrow',
          'shareLink',
          'stepAuthenticate',
          'stepDevices',
          'stepDiscover',
        ].sort(),
      );
      expect(translatedLabelKeys).toEqual(['accountConnectionLabel', 'setupSequenceLabel']);
      const expectedCatalogKeys = [...translationKeys, ...translatedLabelKeys].sort();
      expect(Object.keys(catalogs['i18n/en.json']).sort()).toEqual(expectedCatalogKeys);
      expect(Object.keys(catalogs['i18n/fr.json']).sort()).toEqual(expectedCatalogKeys);
      expect([document, script, JSON.stringify(catalogs)].join('\n')).not.toMatch(/\b(?:SDK|runtime|IPC)\b/i);
      expect(logos.join('\n')).not.toMatch(/\bSDK\b/i);
      expect(document).not.toMatch(/<!doctype|<(?:html|head|body)(?:\s|>)/i);
      expect(script).toContain('homebridge.userCurrentLightingMode()');
      expect(stylesheet).toContain('--accent: #00bfc4');
      expect(darkTheme).toContain('--ink: #edf1f7');
      expect(darkTheme).not.toContain('var(--bs-');

      const firstSetupUi = await renderUi(script, [], catalogs);
      expect(firstSetupUi).toMatchObject({
        continueButton: { disabled: true },
        firstSetup: { hidden: false },
        setupContent: { hidden: true },
      });
      firstSetupUi.continueButton.dispatch('click');
      expect(firstSetupUi).toMatchObject({ firstSetup: { hidden: false }, setupContent: { hidden: true } });
      firstSetupUi.acknowledgement.checked = true;
      firstSetupUi.acknowledgement.dispatch('change');
      expect(firstSetupUi.continueButton.disabled).toBe(false);
      firstSetupUi.continueButton.dispatch('click');
      expect(firstSetupUi).toMatchObject({ firstSetup: { hidden: true }, setupContent: { hidden: false } });

      await expect(renderUi(script, [{ platform: 'EufySecurity' }], catalogs)).resolves.toMatchObject({
        firstSetup: { hidden: false },
        setupContent: { hidden: true },
      });
      await expect(
        renderUi(script, [{ platform: 'EufySecurity', username: 'guest@example.invalid' }], catalogs),
      ).resolves.toMatchObject({
        firstSetup: { hidden: true },
        setupContent: { hidden: false },
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
      await expect(renderUi(script, [], {}, 'fr', translationKeys)).resolves.toMatchObject({
        firstSetup: { hidden: false },
        shell: { lang: 'en' },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
