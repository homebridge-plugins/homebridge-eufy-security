import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface WizardState {
  mode: string;
  profile?: string;
  questionIndex: number;
  source: string;
}

interface DiagnosticsWizard {
  answer(state: WizardState, matches: boolean): WizardState;
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
      'startup-authentication',
      'device-representation',
      'control-state',
      'live-media',
      'hksv-recording',
      'dashboard-ui',
    ]);

    let state = wizard.start();
    state = wizard.answer(state, false);
    state = wizard.answer(state, false);
    expect(state).toMatchObject({ mode: 'questions', questionIndex: 2, profile: undefined });
    expect(wizard.answer(state, true)).toMatchObject({ mode: 'match', profile: 'control-state' });

    state = wizard.start();
    for (let question = 0; question < wizard.questions.length; question++) state = wizard.answer(state, false);
    expect(state).toMatchObject({ mode: 'match', profile: 'other' });
  });

  it('supports direct selection and returns a rejected match to its source', () => {
    const wizard = loadWizard();
    const direct = wizard.direct();
    const matched = wizard.selectDirect(direct, 'live-media');

    expect(direct).toMatchObject({ mode: 'direct', source: 'direct' });
    expect(matched).toMatchObject({ mode: 'match', profile: 'live-media', source: 'direct' });
    expect(wizard.reject(matched)).toMatchObject({ mode: 'direct', profile: undefined });

    const questionnaireMatch = wizard.answer(wizard.start(), true);
    expect(wizard.reject(questionnaireMatch)).toMatchObject({ mode: 'questions', questionIndex: 0 });
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
  });

  it('prioritizes completed evidence until another session is explicitly started', () => {
    const wizard = loadWizard();

    expect(wizard.screen({ status: 'complete', partialExportAvailable: true }, false)).toBe('review');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: true }, false)).toBe('review');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: true }, true)).toBe('choose');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: false }, false)).toBe('choose');
    expect(wizard.screen({ status: 'authorized' }, false)).toBe('reproduce');
  });
});
