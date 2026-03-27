/**
 * Diagnostics View — troubleshooting tools.
 * Download diagnostics, enable debug logging, report issues, reset plugin.
 */
// eslint-disable-next-line no-unused-vars
const DiagnosticsView = {

  _downloadInProgress: false,

  async render(container) {
    container.innerHTML = '';

    const config = await Config.get();

    // Header
    const header = document.createElement('div');
    header.className = 'eufy-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-link p-0';
    backBtn.innerHTML = '← Back';
    backBtn.style.textDecoration = 'none';
    backBtn.addEventListener('click', () => App.navigate('dashboard'));

    const titleEl = document.createElement('h4');
    titleEl.textContent = 'Diagnostics';

    header.appendChild(backBtn);
    header.appendChild(titleEl);
    header.appendChild(document.createElement('div'));
    container.appendChild(header);

    // ── Troubleshooting Steps ──
    const stepsSection = document.createElement('div');
    stepsSection.className = 'settings-section';

    const stepsTitle = document.createElement('div');
    stepsTitle.className = 'detail-section__title';
    stepsTitle.textContent = 'Troubleshooting';
    stepsSection.appendChild(stepsTitle);

    // Step 1 — Enable Debug Logging
    const step1 = this._stepBlock('1', 'Enable Debug Logging', 'Capture verbose logs to help diagnose the issue.');
    Toggle.render(step1, {
      id: 'toggle-detailed-log',
      label: 'Debug Logging',
      help: 'Enable this, then reproduce the problem before downloading diagnostics.',
      checked: !!config.enableDetailedLogging,
      onChange: async (checked) => {
        await Config.updateGlobal({ enableDetailedLogging: checked });
        // Show/hide steps that depend on debug logging
        const debugHint = document.getElementById('diag-debug-hint');
        if (debugHint) debugHint.style.display = checked ? '' : 'none';
        const livestreamSection = document.getElementById('debug-livestream-section');
        if (livestreamSection) livestreamSection.style.display = checked ? '' : 'none';
        const restartHint = document.getElementById('diag-restart-hint');
        if (restartHint) restartHint.style.display = checked ? '' : 'none';
        // Hide livestream warning when debug logging is turned off
        if (!checked) {
          const lsHint = document.getElementById('diag-livestream-hint');
          if (lsHint) lsHint.style.display = 'none';
        }
        const debugSteps = document.getElementById('diag-debug-steps');
        if (debugSteps) debugSteps.classList.toggle('diag-debug-steps--active', checked);
        // Turn off livestream when debug logging is disabled
        if (!checked) {
          const livestreamInput = document.getElementById('toggle-debug-livestream');
          if (livestreamInput && livestreamInput.checked) {
            livestreamInput.checked = false;
            livestreamInput.dispatchEvent(new Event('change'));
          }
        }
      },
    });

    const debugHint = document.createElement('div');
    debugHint.id = 'diag-debug-hint';
    debugHint.className = 'alert alert-warning mt-2 mb-2';
    debugHint.style.fontSize = '0.85rem';
    debugHint.style.display = config.enableDetailedLogging ? '' : 'none';
    debugHint.innerHTML = Helpers.iconHtml('warning.svg') + ' Remember to <strong>disable debug logging</strong> once done — it generates a lot of data and may impact performance.';
    step1.appendChild(debugHint);

    // Debug Livestream — only visible when Debug Logging is enabled
    const livestreamSection = document.createElement('div');
    livestreamSection.id = 'debug-livestream-section';
    livestreamSection.style.display = config.enableDetailedLogging ? '' : 'none';

    Toggle.render(livestreamSection, {
      id: 'toggle-debug-livestream',
      label: 'Debug Livestream',
      help: 'Record every HomeKit livestream to an mp4 file on disk for troubleshooting.',
      checked: !!config.debugLivestream && !!config.enableDetailedLogging,
      onChange: async (checked) => {
        await Config.updateGlobal({ debugLivestream: checked });
        const lsHint = document.getElementById('diag-livestream-hint');
        if (lsHint) lsHint.style.display = checked ? '' : 'none';
      },
    });

    const livestreamHint = document.createElement('div');
    livestreamHint.id = 'diag-livestream-hint';
    livestreamHint.className = 'alert alert-danger mt-2 mb-2';
    livestreamHint.style.fontSize = '0.85rem';
    livestreamHint.style.display = (config.debugLivestream && config.enableDetailedLogging) ? '' : 'none';
    livestreamHint.innerHTML = Helpers.iconHtml('warning.svg') + ' <strong>Debug Livestream:</strong> Only enable this if asked by a developer. Diagnostics files may contain recorded video sessions. Use <strong>Clean Storage</strong> to remove them afterwards, or reposition the camera if you are not comfortable sharing recordings.';
    livestreamSection.appendChild(livestreamHint);

    // View Recordings button — always visible when debug livestream section is shown
    const recBtnWrapper = document.createElement('div');
    recBtnWrapper.className = 'mt-2';
    const btnRecordings = document.createElement('button');
    btnRecordings.className = 'btn btn-outline-info btn-sm';
    btnRecordings.innerHTML = '';
    btnRecordings.appendChild(Helpers.icon('inventory.svg'));
    btnRecordings.append(' View Recordings');
    btnRecordings.addEventListener('click', () => App.navigate('recordings'));
    recBtnWrapper.appendChild(btnRecordings);
    livestreamSection.appendChild(recBtnWrapper);

    step1.appendChild(livestreamSection);
    stepsSection.appendChild(step1);

    // Restart / reproduce instruction — visible when Debug Logging is enabled
    const restartHint = document.createElement('div');
    restartHint.id = 'diag-restart-hint';
    restartHint.className = 'alert alert-info mt-3 mb-3';
    restartHint.style.fontSize = '0.85rem';
    restartHint.style.display = config.enableDetailedLogging ? '' : 'none';
    restartHint.innerHTML = Helpers.iconHtml('info.svg') + ' <strong>Next:</strong> Restart the plugin, reproduce the issue you are experiencing, then come back here to download the diagnostics.';

    stepsSection.appendChild(restartHint);

    // Steps 2 & 3 — only visible when Debug Logging is enabled
    const debugSteps = document.createElement('div');
    debugSteps.id = 'diag-debug-steps';
    debugSteps.className = 'diag-debug-steps';
    if (config.enableDetailedLogging) debugSteps.classList.add('diag-debug-steps--active');

    // Step 2 — Download Diagnostics
    const step2 = this._stepBlock('2', 'Download Diagnostics', 'Download an encrypted archive containing log files and accessories data. Only developers can decrypt it.');
    step2.className += ' diag-step-reveal';

    const warning = document.createElement('div');
    warning.className = 'alert alert-warning mt-2 mb-2';
    warning.style.fontSize = '0.85rem';
    warning.innerHTML = Helpers.iconHtml('warning.svg') + ' <strong>Security notice:</strong> Diagnostics may contain sensitive session data. When encrypted, only developers can read the archive. If you disable encryption or share the archive with anyone, it is strongly recommended to reset your Eufy account password afterwards.';
    step2.appendChild(warning);

    // Download button + encrypt checkbox in a single row
    let encrypt = true;

    const downloadRow = document.createElement('div');
    downloadRow.className = 'diag-download-row';

    const btnDownload = document.createElement('button');
    btnDownload.className = 'btn btn-primary btn-sm';
    btnDownload.innerHTML = ''; btnDownload.appendChild(Helpers.icon('download.svg')); btnDownload.append(' Download Diagnostics');
    btnDownload.addEventListener('click', () => this._downloadDiagnostics(container, !encrypt));
    downloadRow.appendChild(btnDownload);

    const encLabel = document.createElement('label');
    encLabel.className = 'diag-encrypt-label';
    const encCheckbox = document.createElement('input');
    encCheckbox.type = 'checkbox';
    encCheckbox.checked = true;
    encCheckbox.addEventListener('change', (e) => { encrypt = e.target.checked; });
    encLabel.appendChild(encCheckbox);
    encLabel.append('Encrypt');
    downloadRow.appendChild(encLabel);

    step2.appendChild(downloadRow);

    const logProgress = document.createElement('div');
    logProgress.id = 'log-download-progress';
    step2.appendChild(logProgress);
    debugSteps.appendChild(step2);

    // Step 3 — Report Issue (hidden until download completes)
    const step3 = this._stepBlock('3', 'Report Issue', 'Open a pre-filled bug report on GitHub with your system information.');
    step3.className += ' diag-step-reveal diag-step-3';
    step3.id = 'diag-step-3';

    const attachHint = document.createElement('div');
    attachHint.className = 'alert alert-info mb-2';
    attachHint.style.fontSize = '0.85rem';
    attachHint.innerHTML = Helpers.iconHtml('attach.svg') + ' Don\'t forget to <strong>attach the diagnostics file</strong> downloaded in step 2 to your GitHub issue.';
    step3.appendChild(attachHint);

    const btnReport = document.createElement('button');
    btnReport.className = 'btn btn-outline-secondary btn-sm';
    btnReport.innerHTML = ''; btnReport.appendChild(Helpers.icon('bug-report.svg')); btnReport.append(' Report Issue');
    btnReport.addEventListener('click', () => this._reportIssue());
    step3.appendChild(btnReport);
    debugSteps.appendChild(step3);

    stepsSection.appendChild(debugSteps);
    container.appendChild(stepsSection);

    // ── Clean Storage ──
    const cleanSection = document.createElement('div');
    cleanSection.className = 'settings-section';

    const cleanTitle = document.createElement('div');
    cleanTitle.className = 'detail-section__title';
    cleanTitle.textContent = 'Clean Storage';
    cleanSection.appendChild(cleanTitle);

    const cleanDesc = document.createElement('p');
    cleanDesc.className = 'text-muted';
    cleanDesc.style.fontSize = '0.85rem';
    cleanDesc.textContent = 'Delete rotated logs, cached snapshots, and diagnostic archives to free disk space. Current log files, persistent data, and accessories are preserved.';
    cleanSection.appendChild(cleanDesc);

    const btnClean = document.createElement('button');
    btnClean.className = 'btn btn-outline-warning btn-sm';
    btnClean.innerHTML = ''; btnClean.appendChild(Helpers.icon('settings_backup_restore.svg')); btnClean.append(' Clean Storage');
    btnClean.addEventListener('click', async () => {
      try {
        const result = await Api.cleanStorage();
        homebridge.toast.success(`Deleted ${result.deleted} file(s).`);
      } catch (e) {
        homebridge.toast.error('Failed to clean storage: ' + (e.message || e));
      }
    });
    cleanSection.appendChild(btnClean);

    container.appendChild(cleanSection);

    // ── Reset Plugin ──
    const resetSection = document.createElement('div');
    resetSection.className = 'settings-section';

    const resetTitle = document.createElement('div');
    resetTitle.className = 'detail-section__title';
    resetTitle.textContent = 'Reset Plugin';
    resetSection.appendChild(resetTitle);

    const resetDesc = document.createElement('p');
    resetDesc.className = 'text-muted';
    resetDesc.style.fontSize = '0.85rem';
    resetDesc.textContent = 'Delete all persistent data, stored accessories, and logs. You will need to log in again.';
    resetSection.appendChild(resetDesc);

    const btnReset = document.createElement('button');
    btnReset.className = 'btn btn-outline-danger btn-sm';
    btnReset.innerHTML = ''; btnReset.appendChild(Helpers.icon('delete.svg')); btnReset.append(' Reset Plugin');
    btnReset.addEventListener('click', () => this._confirmReset(container));
    resetSection.appendChild(btnReset);

    container.appendChild(resetSection);
  },

  // ===== Report Issue =====
  async _reportIssue() {
    try {
      homebridge.toast.info('Gathering system info...', 'Report Issue');
      const info = await Api.getSystemInfo();

      const envSection = [
        `- **Plugin Version**: ${info.pluginVersion}`,
        `- **Homebridge Version**: ${info.homebridgeVersion}`,
        `- **Node.js Version**: ${info.nodeVersion}`,
        `- **OS**: ${info.os}`,
        `- **eufy-security-client**: ${info.eufyClientVersion}`,
      ].join('\n');

      const params = new URLSearchParams();
      params.set('template', 'bug_report.yml');
      params.set('environment', envSection);

      const url = 'https://github.com/homebridge-plugins/homebridge-eufy-security/issues/new?' + params.toString();
      window.open(url, '_blank');
    } catch (e) {
      homebridge.toast.error('Could not gather system info. Opening blank issue form.');
      window.open('https://github.com/homebridge-plugins/homebridge-eufy-security/issues/new?template=bug_report.yml', '_blank');
    }
  },

  // ===== Diagnostics Download =====
  async _downloadDiagnostics(container, skipEncryption = false) {
    if (this._downloadInProgress) return;
    this._downloadInProgress = true;

    const progressArea = container.querySelector('#log-download-progress');
    if (progressArea) {
      progressArea.innerHTML = `
        <div class="log-progress mt-2">
          <div class="progress">
            <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 10%" id="log-progress-bar"></div>
          </div>
          <small class="text-muted" id="log-progress-status">Preparing...</small>
        </div>
      `;
    }

    Api.onDiagnosticsProgress((data) => {
      const bar = document.querySelector('#log-progress-bar');
      const status = document.querySelector('#log-progress-status');
      if (bar) bar.style.width = data.progress + '%';
      if (status) status.textContent = data.status;
    });

    try {
      const result = await Api.downloadDiagnostics({ skipEncryption });
      const rawBuffer = result.buffer || result;
      const fallbackExt = skipEncryption ? '.tar.gz' : '.tar.gz.enc';
      const filename = result.filename || ('eufy-security-diagnostics' + fallbackExt);
      const bytes = new Uint8Array(rawBuffer.data || rawBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      const a = document.createElement('a');
      a.href = 'data:application/octet-stream;base64,' + base64;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      homebridge.toast.success('Diagnostics downloaded.');

      // Reveal step 3 (Report Issue) now that the file has been downloaded
      const step3El = container.querySelector('#diag-step-3');
      if (step3El) step3El.classList.remove('diag-step-3');
    } catch (e) {
      homebridge.toast.error('Failed to download diagnostics: ' + (e.message || e));
    } finally {
      this._downloadInProgress = false;
      if (progressArea) progressArea.innerHTML = '';
    }
  },

  // ===== Reset Confirmation =====
  _confirmReset(container) {
    const existing = container.querySelector('#reset-confirm');
    if (existing) { existing.remove(); return; }

    const confirm = document.createElement('div');
    confirm.id = 'reset-confirm';
    confirm.className = 'alert alert-danger mt-3';
    confirm.innerHTML = `
      <strong>Are you sure?</strong> This will delete all persistent data, stored accessories, and logs.
      You will need to log in again.
      <div class="mt-2">
        <button class="btn btn-danger btn-sm me-2" id="btn-confirm-reset">Yes, Reset Everything</button>
        <button class="btn btn-outline-secondary btn-sm" id="btn-cancel-reset">Cancel</button>
      </div>
    `;

    confirm.querySelector('#btn-confirm-reset').addEventListener('click', async () => {
      try {
        await Api.resetPlugin();
        await Config.update({ platform: 'EufySecurity' });
        await Config.save();
        homebridge.toast.success('Plugin reset. Please restart Homebridge.');
        App.state.stations = [];
        App.navigate('login');
      } catch (e) {
        homebridge.toast.error('Reset failed: ' + (e.message || e));
      }
    });

    confirm.querySelector('#btn-cancel-reset').addEventListener('click', () => {
      confirm.remove();
    });

    container.appendChild(confirm);
  },

  /**
   * Create a numbered step block with title and description.
   */
  _stepBlock(number, title, description) {
    const block = document.createElement('div');
    block.className = 'diag-step';

    const header = document.createElement('div');
    header.className = 'diag-step__header';

    const badge = document.createElement('span');
    badge.className = 'diag-step__badge';
    badge.textContent = number;
    header.appendChild(badge);

    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    header.appendChild(titleEl);

    block.appendChild(header);

    if (description) {
      const desc = document.createElement('p');
      desc.className = 'text-muted mb-2';
      desc.style.fontSize = '0.85rem';
      desc.textContent = description;
      block.appendChild(desc);
    }

    return block;
  },
};
