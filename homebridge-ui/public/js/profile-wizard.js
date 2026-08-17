(function attachDiagnosticsWizard(global) {
  const questions = [
    { profile: 'dashboard-ui', message: 'diagnosticsQuestionDashboard' },
    { profile: 'startup-authentication', message: 'diagnosticsQuestionStartup' },
    { profile: 'device-representation', message: 'diagnosticsQuestionDevices' },
    { profile: 'control-state', message: 'diagnosticsQuestionControl' },
    { profile: 'live-media', message: 'diagnosticsQuestionLiveMedia' },
    { profile: 'hksv-recording', message: 'diagnosticsQuestionRecording' },
  ];

  function start() {
    return { mode: 'questions', questionIndex: 0, profile: undefined, source: 'questions' };
  }

  function answer(state, matches) {
    if (matches) {
      return { ...state, mode: 'frequency', profile: questions[state.questionIndex].profile };
    }
    if (state.questionIndex === questions.length - 1) {
      return { ...state, mode: 'frequency', profile: 'other' };
    }
    return { ...state, questionIndex: state.questionIndex + 1 };
  }

  function direct() {
    return { mode: 'direct', questionIndex: 0, profile: undefined, source: 'direct' };
  }

  function selectDirect(state, profile) {
    return { ...state, mode: 'frequency', profile, source: 'direct' };
  }

  function reject(state) {
    return state.source === 'direct' ? direct() : start();
  }

  function chooseReproductionMode(state, reproductionMode) {
    return { ...state, mode: 'match', reproductionMode };
  }

  function backFromFrequency(state) {
    return state.source === 'direct' ? direct() : start();
  }

  function screen(session, startingAnother) {
    if (session.partialExportAvailable && !startingAnother) return 'review';
    if (startingAnother || session.status === 'inactive' || session.status === 'expired') return 'choose';
    if (session.status === 'authorized' || session.status === 'reproducing') return 'reproduce';
    return 'status';
  }

  function backgroundActive(session) {
    return session.status === 'reproducing' && session.profile === 'dashboard-ui';
  }

  global.HomebridgeEufyDiagnosticsWizard = {
    answer,
    backFromFrequency,
    backgroundActive,
    chooseReproductionMode,
    direct,
    questions,
    reject,
    screen,
    selectDirect,
    start,
  };
})(window);
