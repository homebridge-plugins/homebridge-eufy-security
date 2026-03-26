/**
 * Recordings View — list, download, and manage debug livestream recordings.
 * Users can compare raw (pre-FFmpeg) vs processed (post-FFmpeg) MP4 files
 * to narrow down whether streaming issues originate in the underlying
 * library or in the plugin's FFmpeg pipeline.
 */
// eslint-disable-next-line no-unused-vars
const RecordingsView = {

  _downloadInProgress: false,

  async render(container) {
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'eufy-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-link p-0';
    backBtn.innerHTML = '&larr; Back';
    backBtn.style.textDecoration = 'none';
    backBtn.addEventListener('click', () => App.navigate('diagnostics'));

    const titleEl = document.createElement('h4');
    titleEl.textContent = 'Debug Recordings';

    header.appendChild(backBtn);
    header.appendChild(titleEl);
    header.appendChild(document.createElement('div'));
    container.appendChild(header);

    // Info banner
    const info = document.createElement('div');
    info.className = 'alert alert-info';
    info.style.fontSize = '0.85rem';
    info.innerHTML = Helpers.iconHtml('info.svg') + ' <strong>Raw</strong> = P2P feed (audio + video, before FFmpeg). <strong>Processed</strong> = re-encoded video sent to HomeKit. Compare to find where an issue originates.';
    container.appendChild(info);

    // Toolbar row (Reload + Delete All)
    const toolbar = document.createElement('div');
    toolbar.className = 'd-flex justify-content-between align-items-center mb-3';
    toolbar.id = 'recordings-toolbar';

    const btnReload = document.createElement('button');
    btnReload.className = 'btn btn-outline-primary btn-sm';
    btnReload.appendChild(Helpers.icon('refresh.svg'));
    btnReload.append(' Reload');
    btnReload.addEventListener('click', () => this._loadRecordings(container));

    const btnDeleteAll = document.createElement('button');
    btnDeleteAll.className = 'btn btn-outline-danger btn-sm';
    btnDeleteAll.id = 'recordings-delete-all';
    btnDeleteAll.style.display = 'none';
    btnDeleteAll.appendChild(Helpers.icon('delete.svg'));
    btnDeleteAll.append(' Delete All');
    btnDeleteAll.addEventListener('click', () => this._confirmDeleteAll(container));

    toolbar.appendChild(btnReload);
    toolbar.appendChild(btnDeleteAll);
    container.appendChild(toolbar);

    // Recordings list container
    const listContainer = document.createElement('div');
    listContainer.id = 'recordings-list';
    container.appendChild(listContainer);

    // Download progress area
    const progressArea = document.createElement('div');
    progressArea.id = 'recording-download-progress';
    container.appendChild(progressArea);

    // Load recordings
    await this._loadRecordings(container);
  },

  async _loadRecordings(container) {
    const listContainer = container.querySelector('#recordings-list');
    const btnDeleteAll = container.querySelector('#recordings-delete-all');

    try {
      const result = await Api.listDebugRecordings();
      const recordings = result.recordings || [];

      if (recordings.length === 0) {
        if (btnDeleteAll) btnDeleteAll.style.display = 'none';
        listContainer.innerHTML = `
          <div class="text-muted text-center py-4" style="font-size: 0.9rem;">
            No debug recordings found.<br>
            <small>Enable <strong>Debug Livestream</strong> in Diagnostics, restart the plugin, then open a camera in the Home app.</small>
          </div>
        `;
        return;
      }

      if (btnDeleteAll) btnDeleteAll.style.display = '';

      // Group by serial, then by session
      const bySerial = {};
      for (const rec of recordings) {
        if (!bySerial[rec.serial]) bySerial[rec.serial] = [];
        bySerial[rec.serial].push(rec);
      }

      listContainer.innerHTML = '';

      for (const [serial, recs] of Object.entries(bySerial)) {
        const section = document.createElement('div');
        section.className = 'settings-section';

        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'detail-section__title';
        sectionTitle.textContent = serial;
        section.appendChild(sectionTitle);

        // Group into sessions: recordings with matching timestamp are paired
        const sessions = this._groupIntoSessions(recs);

        for (const session of sessions) {
          const raw = session.find(r => r.type === 'raw');
          const processed = session.find(r => r.type === 'processed');
          const firstRec = session[0];

          const row = document.createElement('div');
          row.className = 'd-flex align-items-center justify-content-between py-2 border-bottom';
          row.style.fontSize = '0.85rem';

          // Left: date and size info
          const leftCol = document.createElement('div');
          const dateStr = firstRec.createdAtISO
            ? new Date(firstRec.createdAtISO).toLocaleString()
            : firstRec.timestamp || 'Unknown';
          const sizeInfo = session.map(r => {
            const label = r.type === 'raw' ? 'R' : 'P';
            return label + ':' + r.sizeMB + 'MB';
          }).join(' / ');

          const dateLine = document.createElement('div');
          dateLine.textContent = dateStr;
          const sizeLine = document.createElement('small');
          sizeLine.className = 'text-muted';
          sizeLine.textContent = sizeInfo;
          leftCol.appendChild(dateLine);
          leftCol.appendChild(sizeLine);

          // Right: action buttons
          const rightCol = document.createElement('div');
          rightCol.className = 'd-flex align-items-center gap-1';

          if (raw) {
            const btnRaw = document.createElement('button');
            btnRaw.className = 'btn btn-outline-success btn-sm';
            btnRaw.title = 'Download Raw';
            btnRaw.textContent = 'Raw';
            btnRaw.addEventListener('click', () => this._downloadRecording(container, raw.filename, raw.sizeBytes));
            rightCol.appendChild(btnRaw);
          }

          if (processed) {
            const btnProc = document.createElement('button');
            btnProc.className = 'btn btn-outline-primary btn-sm';
            btnProc.title = 'Download Processed';
            btnProc.textContent = 'Processed';
            btnProc.addEventListener('click', () => this._downloadRecording(container, processed.filename, processed.sizeBytes));
            rightCol.appendChild(btnProc);
          }

          const btnDelete = document.createElement('button');
          btnDelete.className = 'btn btn-outline-danger btn-sm';
          btnDelete.title = 'Delete';
          btnDelete.appendChild(Helpers.icon('delete.svg'));
          btnDelete.addEventListener('click', async () => {
            try {
              for (const rec of session) {
                await Api.deleteDebugRecording(rec.filename);
              }
              homebridge.toast.success('Deleted ' + session.length + ' file(s).');
              await this._loadRecordings(container);
            } catch (e) {
              homebridge.toast.error('Delete failed: ' + (e.message || e));
            }
          });
          rightCol.appendChild(btnDelete);

          row.appendChild(leftCol);
          row.appendChild(rightCol);
          section.appendChild(row);
        }

        listContainer.appendChild(section);
      }
    } catch (e) {
      listContainer.innerHTML = '<div class="alert alert-danger">Failed to load recordings: ' + Helpers.escHtml(e.message || String(e)) + '</div>';
    }
  },

  /**
   * Download a recording file in chunks and trigger browser download.
   * Uses paginated reads to avoid loading the entire file into memory at once.
   */
  async _downloadRecording(container, filename, totalSize) {
    if (this._downloadInProgress) {
      homebridge.toast.warning('A download is already in progress.');
      return;
    }
    this._downloadInProgress = true;

    const progressArea = container.querySelector('#recording-download-progress');
    if (progressArea) {
      progressArea.innerHTML = `
        <div class="mt-2">
          <div class="progress">
            <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%" id="rec-progress-bar"></div>
          </div>
          <small class="text-muted" id="rec-progress-status">Downloading...</small>
        </div>
      `;
    }

    try {
      const chunks = [];
      let offset = 0;
      const chunkSize = 256 * 1024; // 256 KB per request

      while (true) {
        const result = await Api.downloadDebugRecording(filename, offset, chunkSize);

        if (result.data) {
          const bytes = new Uint8Array(result.data.data || result.data);
          chunks.push(bytes);
        }

        // Update progress
        const pct = totalSize > 0 ? Math.min(100, Math.round((result.offset / totalSize) * 100)) : 0;
        const bar = document.querySelector('#rec-progress-bar');
        const status = document.querySelector('#rec-progress-status');
        if (bar) bar.style.width = pct + '%';
        if (status) status.textContent = `Downloading... ${pct}%`;

        if (result.done) break;
        offset = result.offset;
      }

      // Combine chunks and trigger browser download
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let pos = 0;
      for (const chunk of chunks) {
        combined.set(chunk, pos);
        pos += chunk.length;
      }

      const blob = new Blob([combined], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      homebridge.toast.success('Downloaded: ' + filename);
    } catch (e) {
      homebridge.toast.error('Download failed: ' + (e.message || e));
    } finally {
      this._downloadInProgress = false;
      if (progressArea) progressArea.innerHTML = '';
    }
  },

  /**
   * Group recordings into sessions by extracting the timestamp portion from
   * the filename. Recordings sharing a timestamp are a raw/processed pair.
   */
  _groupIntoSessions(recs) {
    const map = {};
    for (const rec of recs) {
      // Filename: <serial>_<timestamp>_<type>.mp4 — extract timestamp as session key
      const match = rec.filename.match(/^[A-Za-z0-9_-]+?_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3}Z)?)_/);
      const key = match ? match[1] : rec.filename;
      if (!map[key]) map[key] = [];
      map[key].push(rec);
    }
    // Sort sessions by newest first, within each session: raw before processed
    return Object.values(map)
      .sort((a, b) => (b[0].createdAt || 0) - (a[0].createdAt || 0))
      .map(session => session.sort((a, b) => (a.type === 'raw' ? 0 : 1) - (b.type === 'raw' ? 0 : 1)));
  },

  _confirmDeleteAll(container) {
    const existing = container.querySelector('#delete-all-confirm');
    if (existing) { existing.remove(); return; }

    const confirm = document.createElement('div');
    confirm.id = 'delete-all-confirm';
    confirm.className = 'alert alert-danger mt-2';
    confirm.innerHTML = `
      <strong>Delete all recordings?</strong> This cannot be undone.
      <div class="mt-2">
        <button class="btn btn-danger btn-sm me-2" id="btn-confirm-delete-all">Yes, Delete All</button>
        <button class="btn btn-outline-secondary btn-sm" id="btn-cancel-delete-all">Cancel</button>
      </div>
    `;

    confirm.querySelector('#btn-confirm-delete-all').addEventListener('click', async () => {
      try {
        const result = await Api.deleteAllDebugRecordings();
        homebridge.toast.success('Deleted ' + result.deleted + ' recording(s).');
        confirm.remove();
        await this._loadRecordings(container);
      } catch (e) {
        homebridge.toast.error('Delete failed: ' + (e.message || e));
      }
    });

    confirm.querySelector('#btn-cancel-delete-all').addEventListener('click', () => {
      confirm.remove();
    });

    container.appendChild(confirm);
  },
};
