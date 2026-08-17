(function attachDiagnosticsWizard(global) {
  const questions = [
    { profile: 'startup-authentication', message: 'diagnosticsQuestionStartup' },
    { profile: 'device-representation', message: 'diagnosticsQuestionDevices' },
    { profile: 'control-state', message: 'diagnosticsQuestionControl' },
    { profile: 'live-media', message: 'diagnosticsQuestionLiveMedia' },
    { profile: 'hksv-recording', message: 'diagnosticsQuestionRecording' },
    { profile: 'dashboard-ui', message: 'diagnosticsQuestionDashboard' },
  ];

  function start() {
    return { mode: 'questions', questionIndex: 0, profile: undefined, source: 'questions' };
  }

  function answer(state, matches) {
    if (matches) {
      return { ...state, mode: 'match', profile: questions[state.questionIndex].profile };
    }
    if (state.questionIndex === questions.length - 1) {
      return { ...state, mode: 'match', profile: 'other' };
    }
    return { ...state, questionIndex: state.questionIndex + 1 };
  }

  function direct() {
    return { mode: 'direct', questionIndex: 0, profile: undefined, source: 'direct' };
  }

  function selectDirect(state, profile) {
    return { ...state, mode: 'match', profile, source: 'direct' };
  }

  function reject(state) {
    return state.source === 'direct' ? direct() : start();
  }

  function screen(session, startingAnother) {
    if (session.partialExportAvailable && !startingAnother) return 'review';
    if (startingAnother || session.status === 'inactive' || session.status === 'expired') return 'choose';
    if (session.status === 'authorized' || session.status === 'reproducing') return 'reproduce';
    return 'status';
  }

  global.HomebridgeEufyDiagnosticsWizard = { answer, direct, questions, reject, screen, selectDirect, start };
})(window);
