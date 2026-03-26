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
    info.innerHTML = Helpers.iconHtml('info.svg') + ' <strong>Raw</strong> recordings capture the P2P feed directly from the camera (before FFmpeg). <strong>Processed</strong> recordings capture the re-encoded stream sent to HomeKit. Compare them to narrow down where an issue originates.';
    container.appendChild(info);

    // Loading spinner
    const spinner = document.createElement('div');
    spinner.id = 'recordings-spinner';
    spinner.className = 'd-flex justify-content-center my-3';
    spinner.innerHTML = '<div class="spinner-border spinner-border-sm text-primary" role="status"><span class="visually-hidden">Loading...</span></div>';
    container.appendChild(spinner);

    // Recordings list container
    const listContainer = document.createElement('div');
    listContainer.id = 'recordings-list';
    container.appendChild(listContainer);

    // Actions row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'mt-3';
    actionsRow.id = 'recordings-actions';
    actionsRow.style.display = 'none';

    const btnDeleteAll = document.createElement('button');
    btnDeleteAll.className = 'btn btn-outline-danger btn-sm';
    btnDeleteAll.innerHTML = '';
    btnDeleteAll.appendChild(Helpers.icon('delete.svg'));
    btnDeleteAll.append(' Delete All Recordings');
    btnDeleteAll.addEventListener('click', () => this._confirmDeleteAll(container));

    actionsRow.appendChild(btnDeleteAll);
    container.appendChild(actionsRow);

    // Download progress area
    const progressArea = document.createElement('div');
    progressArea.id = 'recording-download-progress';
    container.appendChild(progressArea);

    // Load recordings
    await this._loadRecordings(container);
  },

  async _loadRecordings(container) {
    const spinner = container.querySelector('#recordings-spinner');
    const listContainer = container.querySelector('#recordings-list');
    const actionsRow = container.querySelector('#recordings-actions');

    try {
      const result = await Api.listDebugRecordings();
      const recordings = result.recordings || [];

      if (spinner) spinner.style.display = 'none';

      if (recordings.length === 0) {
        listContainer.innerHTML = `
          <div class="text-muted text-center py-4" style="font-size: 0.9rem;">
            No debug recordings found.<br>
            <small>Enable <strong>Debug Livestream</strong> in Diagnostics, restart the plugin, then open a camera in the Home app.</small>
          </div>
        `;
        return;
      }

      if (actionsRow) actionsRow.style.display = '';

      // Group by serial
      const grouped = {};
      for (const rec of recordings) {
        if (!grouped[rec.serial]) grouped[rec.serial] = [];
        grouped[rec.serial].push(rec);
      }

      listContainer.innerHTML = '';

      for (const [serial, recs] of Object.entries(grouped)) {
        const section = document.createElement('div');
        section.className = 'settings-section';

        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'detail-section__title';
        sectionTitle.textContent = serial;
        section.appendChild(sectionTitle);

        const table = document.createElement('table');
        table.className = 'table table-sm';
        table.style.fontSize = '0.85rem';

        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Type</th><th>Date</th><th>Size</th><th></th></tr>';
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        for (const rec of recs) {
          const tr = document.createElement('tr');

          // Type badge
          const tdType = document.createElement('td');
          const badge = document.createElement('span');
          badge.className = rec.type === 'raw'
            ? 'badge bg-success'
            : 'badge bg-primary';
          badge.textContent = rec.type === 'raw' ? 'Raw' : 'Processed';
          tdType.appendChild(badge);
          tr.appendChild(tdType);

          // Date
          const tdDate = document.createElement('td');
          tdDate.textContent = rec.createdAtISO
            ? new Date(rec.createdAtISO).toLocaleString()
            : rec.timestamp || 'Unknown';
          tr.appendChild(tdDate);

          // Size
          const tdSize = document.createElement('td');
          tdSize.textContent = rec.sizeMB + ' MB';
          tr.appendChild(tdSize);

          // Actions
          const tdActions = document.createElement('td');
          tdActions.className = 'text-end';

          const btnDownload = document.createElement('button');
          btnDownload.className = 'btn btn-outline-primary btn-sm me-1';
          btnDownload.title = 'Download';
          btnDownload.appendChild(Helpers.icon('download.svg'));
          btnDownload.addEventListener('click', () => this._downloadRecording(container, rec.filename, rec.sizeBytes));
          tdActions.appendChild(btnDownload);

          const btnDelete = document.createElement('button');
          btnDelete.className = 'btn btn-outline-danger btn-sm';
          btnDelete.title = 'Delete';
          btnDelete.appendChild(Helpers.icon('delete.svg'));
          btnDelete.addEventListener('click', async () => {
            try {
              await Api.deleteDebugRecording(rec.filename);
              homebridge.toast.success('Deleted ' + rec.filename);
              await this._loadRecordings(container);
            } catch (e) {
              homebridge.toast.error('Delete failed: ' + (e.message || e));
            }
          });
          tdActions.appendChild(btnDelete);

          tr.appendChild(tdActions);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        section.appendChild(table);
        listContainer.appendChild(section);
      }
    } catch (e) {
      if (spinner) spinner.style.display = 'none';
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

      const blob = new Blob([combined], { type: 'video/mp4' });
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
