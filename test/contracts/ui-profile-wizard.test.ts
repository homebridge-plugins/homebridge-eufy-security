import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface WizardState {
  mode: string;
  profile?: string;
  questionIndex: number;
  reproductionMode?: 'now' | 'intermittent';
  source: string;
}

interface DiagnosticsWizard {
  answer(state: WizardState, matches: boolean): WizardState;
  backFromFrequency(state: WizardState): WizardState;
  backgroundActive(session: { profile?: string; status: string }): boolean;
  chooseReproductionMode(state: WizardState, mode: 'now' | 'intermittent'): WizardState;
  direct(): WizardState;
  questions: Array<{ message: string; profile: string }>;
  reject(state: WizardState): WizardState;
  screen(session: { partialExportAvailable?: boolean; status: string }, startingAnother: boolean): string;
  selectDirect(state: WizardState, profile: string): WizardState;
  start(): WizardState;
}

function loadWizard(): DiagnosticsWizard {
  const script = readFileSync(new URL('../../homebridge-ui/public/js/profile-wizard.js', import.meta.url), 'utf8');
  const window = {} as { HomebridgeEufyDiagnosticsWizard?: DiagnosticsWizard };
  runInNewContext(script, { window });
  return window.HomebridgeEufyDiagnosticsWizard!;
}

describe('diagnostics profile wizard', () => {
  it('asks one ordered question at a time and maps the first yes to its profile', () => {
    const wizard = loadWizard();
    expect(wizard.questions.map(({ profile }) => profile)).toEqual([
      'dashboard-ui',
      'startup-authentication',
      'device-representation',
      'control-state',
      'live-media',
      'hksv-recording',
    ]);

    let state = wizard.start();
    state = wizard.answer(state, false);
    state = wizard.answer(state, false);
    expect(state).toMatchObject({ mode: 'questions', questionIndex: 2, profile: undefined });
    expect(wizard.answer(state, true)).toMatchObject({ mode: 'frequency', profile: 'device-representation' });

    expect(wizard.answer(wizard.start(), true)).toMatchObject({
      mode: 'frequency',
      profile: 'dashboard-ui',
    });
    expect(wizard.answer(wizard.start(), false)).toMatchObject({
      mode: 'questions',
      questionIndex: 1,
      profile: undefined,
    });

    state = wizard.start();
    for (let question = 0; question < wizard.questions.length; question++) state = wizard.answer(state, false);
    expect(state).toMatchObject({ mode: 'frequency', profile: 'other' });
  });

  it('asks for reproduction frequency after questionnaire and direct profile selection', () => {
    const wizard = loadWizard();
    const direct = wizard.direct();
    const frequency = wizard.selectDirect(direct, 'live-media');
    const intermittent = wizard.chooseReproductionMode(frequency, 'intermittent');

    expect(direct).toMatchObject({ mode: 'direct', source: 'direct' });
    expect(frequency).toMatchObject({ mode: 'frequency', profile: 'live-media', source: 'direct' });
    expect(intermittent).toMatchObject({
      mode: 'match',
      profile: 'live-media',
      reproductionMode: 'intermittent',
      source: 'direct',
    });
    expect(wizard.reject(intermittent)).toMatchObject({ mode: 'direct', profile: undefined });
    expect(wizard.backFromFrequency(frequency)).toMatchObject({ mode: 'direct', profile: undefined });

    const questionnaireFrequency = wizard.answer(wizard.start(), true);
    const now = wizard.chooseReproductionMode(questionnaireFrequency, 'now');
    expect(now).toMatchObject({ mode: 'match', reproductionMode: 'now' });
    expect(wizard.reject(now)).toMatchObject({ mode: 'questions', questionIndex: 0, profile: undefined });
  });

  it('has matching English and French copy for every question', () => {
    const wizard = loadWizard();
    const english = JSON.parse(
      readFileSync(new URL('../../homebridge-ui/public/i18n/en.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const french = JSON.parse(
      readFileSync(new URL('../../homebridge-ui/public/i18n/fr.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;

    expect(Object.keys(french).sort()).toEqual(Object.keys(english).sort());
    for (const { message } of wizard.questions) {
      expect(english[message]).toBeTruthy();
      expect(french[message]).toBeTruthy();
    }
    expect(english.diagnosticsQuestionDevices).toBe(
      'Is an accessory missing, duplicated, or shown as the wrong type in HomeKit?',
    );
    expect(french.diagnosticsQuestionDevices).toBe(
      'Un accessoire est-il absent, dupliqué ou affiché avec le mauvais type dans HomeKit ?',
    );
    expect(english.diagnosticsQuestionReproduceNow).toBe('Can you reproduce the problem now?');
    expect(french.diagnosticsQuestionReproduceNow).toBe('Pouvez-vous reproduire le problème maintenant ?');
    expect(english.diagnosticsQuestionDashboard).toBe('Is the problem in the dashboard, login, or setup screens?');
    expect(french.diagnosticsQuestionDashboard).toBe(
      'Le problème se situe-t-il dans les écrans du tableau de bord, de connexion ou de configuration ?',
    );

    const normalFlowKeys = [
      'diagnosticsControlAction',
      'diagnosticsControlBefore',
      'diagnosticsControlSummary',
      'diagnosticsDashboardAction',
      'diagnosticsDashboardBefore',
      'diagnosticsDashboardSummary',
      'diagnosticsDevicesAction',
      'diagnosticsDevicesBefore',
      'diagnosticsDevicesSummary',
      'diagnosticsEvidenceReady',
      'diagnosticsLiveAction',
      'diagnosticsLiveBefore',
      'diagnosticsLiveSummary',
      'diagnosticsMissingEvidence',
      'diagnosticsOtherAction',
      'diagnosticsOtherBefore',
      'diagnosticsOtherSummary',
      'diagnosticsPrivacy',
      'diagnosticsRecordingAction',
      'diagnosticsRecordingBefore',
      'diagnosticsRecordingSummary',
      'diagnosticsStartupAction',
      'diagnosticsStartupBefore',
      'diagnosticsStartupSummary',
      'diagnosticsSummary',
    ];
    expect(normalFlowKeys.map((key) => english[key]).join('\n')).not.toMatch(
      /bounded|evidence|observation|adapter|capability-admission|FFmpeg|reproduction interval|72-hour/i,
    );
    expect(normalFlowKeys.map((key) => french[key]).join('\n')).not.toMatch(
      /preuves|observation|adaptation|admission|FFmpeg|intervalle de reproduction|autorisation de 72/i,
    );
  });

  it('prioritizes completed evidence until another session is explicitly started', () => {
    const wizard = loadWizard();

    expect(wizard.screen({ status: 'complete', partialExportAvailable: true }, false)).toBe('review');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: true }, false)).toBe('review');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: true }, true)).toBe('choose');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: false }, false)).toBe('choose');
    expect(wizard.screen({ status: 'authorized' }, false)).toBe('reproduce');
  });

  it('shows the background action only for an active dashboard reproduction', () => {
    const wizard = loadWizard();

    expect(wizard.backgroundActive({ status: 'reproducing', profile: 'dashboard-ui' })).toBe(true);
    expect(wizard.backgroundActive({ status: 'authorized', profile: 'dashboard-ui' })).toBe(false);
    expect(wizard.backgroundActive({ status: 'complete', profile: 'dashboard-ui' })).toBe(false);
    expect(wizard.backgroundActive({ status: 'reproducing', profile: 'control-state' })).toBe(false);
  });
});
