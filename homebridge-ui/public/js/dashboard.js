(function dashboardModule(global) {
  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function preferenceControl(device, key, preference, messages) {
    const labels = {
      represented: messages.preferenceRepresented,
      audio: messages.preferenceAudio,
      snapshotMode: messages.preferenceSnapshotMode,
    };
    if (key === 'snapshotMode') {
      return `<label><span>${escapeHtml(labels[key])}</span><select data-preference="${key}" data-serial="${escapeHtml(device.serial)}">
        ${['Cloud', 'Live', 'Refresh'].map((mode) => `<option${preference.snapshotMode === mode ? ' selected' : ''}>${mode}</option>`).join('')}
      </select></label>`;
    }
    return `<label class="toggle"><input type="checkbox" data-preference="${key}" data-serial="${escapeHtml(device.serial)}"${preference[key] ? ' checked' : ''}><span>${escapeHtml(labels[key])}</span></label>`;
  }

  function renderDevices(devices, config, messages, deviceGroups) {
    const preferences = config.entityPreferences ?? {};
    deviceGroups.innerHTML = ['security', 'life', 'clean']
      .map((category) => {
        const categoryDevices = devices.filter((device) => device.category === category);
        if (categoryDevices.length === 0) return '';
        const tiles = categoryDevices
          .map((device) => {
            const preference = {
              represented: preferences[device.serial]?.represented ?? true,
              audio: preferences[device.serial]?.audio ?? true,
              snapshotMode: preferences[device.serial]?.snapshotMode ?? 'Refresh',
            };
            const badges = [
              device.controllable && preference.represented
                ? { icon: 'bolt', label: messages.controllable }
                : undefined,
              device.diagnosticOnly ? { icon: 'info', label: messages.diagnosticOnly } : undefined,
            ].filter(Boolean);
            const artwork = device.artwork
              ? `<img src="${escapeHtml(device.artwork)}" alt="" loading="lazy" data-device-artwork>`
              : '';
            const controls = device.preferences.length
              ? device.preferences.map((key) => preferenceControl(device, key, preference, messages)).join('')
              : `<p>${escapeHtml(messages.diagnosticOnly)}</p>`;
            return `<details class="device-tile" data-category="${category}">
              <summary class="device-summary">
                <div class="device-art" aria-hidden="true"><img class="device-class-icon" src="assets/icons/inventory.svg" alt=""><span>${escapeHtml(device.deviceClass)}</span>${artwork}</div>
                <div class="device-copy"><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(device.modelName)}</p></div>
                <div class="device-badges">${badges.map(({ icon, label }) => `<span role="img" tabindex="0" aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}"><img src="assets/icons/${icon}.svg" alt=""></span>`).join('')}</div>
              </summary>
              <div class="preference-panel"><strong><img src="assets/icons/settings.svg" alt="">${escapeHtml(messages.preferences)}</strong><div class="preference-grid">${controls}</div></div>
            </details>`;
          })
          .join('');
        const categoryKey = `category${category[0].toUpperCase()}${category.slice(1)}`;
        return `<section class="device-group"><h2>${escapeHtml(messages[categoryKey])}</h2><div class="device-grid">${tiles}</div></section>`;
      })
      .join('');
  }

  function render(result, config, messages, elements) {
    const suffix = result.state
      .split('-')
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join('');
    elements.title.textContent = messages[`dashboard${suffix}Title`] ?? messages.dashboardIncompleteTitle;
    elements.badge.textContent = messages[`dashboard${suffix}Badge`] ?? messages.dashboardIncompleteBadge;
    elements.summary.textContent = messages[`dashboard${suffix}Summary`] ?? messages.dashboardIncompleteSummary;
    elements.dashboard.dataset.state = result.state;
    elements.dashboard.hidden = false;
    renderDevices(result.devices, config, messages, elements.groups);
    elements.setup.hidden = true;
    elements.authenticate.hidden = result.state !== 'authentication-required' || result.devices.length === 0;
    if (result.devices.length > 0) {
      elements.pageTitle.textContent = messages.dashboardPageTitle;
    } else if (result.state === 'authentication-required') {
      elements.setup.hidden = false;
    }
  }

  function bindPreferences(elements, getConfig, saveConfig, getMessages) {
    elements.groups.addEventListener(
      'error',
      (event) => {
        if (event.target?.dataset?.deviceArtwork !== undefined) event.target.hidden = true;
      },
      true,
    );
    elements.groups.addEventListener('change', async (event) => {
      const control = event.target;
      const serial = control?.dataset?.serial;
      const key = control?.dataset?.preference;
      const existing = getConfig();
      if (!existing || !serial || !key) return;
      const defaults = { represented: true, audio: true, snapshotMode: 'Refresh' };
      const value = key === 'snapshotMode' ? control.value : control.checked;
      const entityPreferences = { ...(existing.entityPreferences ?? {}) };
      const preference = { ...(entityPreferences[serial] ?? {}) };
      if (value === defaults[key]) delete preference[key];
      else preference[key] = value;
      if (Object.keys(preference).length === 0) delete entityPreferences[serial];
      else entityPreferences[serial] = preference;
      try {
        await saveConfig({ ...existing, entityPreferences });
        elements.restart.hidden = false;
      } catch {
        elements.summary.textContent = getMessages().preferenceSaveFailed;
      }
    });
  }

  global.HomebridgeEufyDashboard = { bindPreferences, render };
})(window);
