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
    const represented = preference.represented;
    const dependent = key === 'represented' ? '' : ` data-requires-representation${represented ? '' : ' hidden'}`;
    if (key === 'snapshotMode') {
      const descriptions = {
        Cloud: messages.snapshotModeCloudDescription,
        Live: messages.snapshotModeLiveDescription,
        Refresh: messages.snapshotModeRefreshDescription,
      };
      return `<div class="snapshot-setting" data-setting${dependent}><span class="setting-label">${escapeHtml(labels[key])}</span><div class="snapshot-segments" role="radiogroup" aria-label="${escapeHtml(labels[key])}">${['Cloud', 'Live', 'Refresh'].map((mode) => `<label class="snapshot-segment"><input type="radio" name="snapshot-${escapeHtml(device.serial)}" value="${mode}" data-preference="${key}" data-serial="${escapeHtml(device.serial)}" data-original="${escapeHtml(preference.snapshotMode)}" data-description="${escapeHtml(descriptions[mode])}"${preference.snapshotMode === mode ? ' checked' : ''}><span>${mode}</span></label>`).join('')}</div><p class="snapshot-description" data-snapshot-description>${escapeHtml(descriptions[preference.snapshotMode])}</p></div>`;
    }
    return `<label class="toggle" data-setting${dependent}><input type="checkbox" data-preference="${key}" data-serial="${escapeHtml(device.serial)}" data-original="${String(preference[key])}"${preference[key] ? ' checked' : ''}><span>${escapeHtml(labels[key])}</span></label>`;
  }

  function markPendingPreference(control, key, value) {
    if (!control?.classList || control.dataset.original === undefined) return;
    const current = key === 'snapshotMode' ? String(value) : String(Boolean(value));
    const setting = control.closest('[data-setting]');
    const changed = current !== control.dataset.original;
    if (key === 'snapshotMode') {
      setting.querySelectorAll('[data-preference="snapshotMode"]').forEach((entry) => {
        entry.classList.remove('preference-control-changed');
      });
    }
    control.classList.toggle('preference-control-changed', changed);
    setting?.classList.toggle('preference-changed', changed);
    const tile = control.closest('.device-tile');
    tile?.classList.toggle('device-tile-changed', Boolean(tile.querySelector('.preference-control-changed')));
  }

  function renderDevices(devices, config, messages, deviceGroups) {
    const preferences = config.entityPreferences ?? {};
    deviceGroups.innerHTML = ['security', 'life', 'clean']
      .map((category) => {
        const categoryDevices = devices
          .filter((device) => device.category === category)
          .map((device) => ({
            device,
            rank: device.diagnosticOnly
              ? 2
              : preferences[device.serial]?.represented === false
                ? 1
                : 0,
          }))
          .sort(
            (left, right) =>
              left.rank - right.rank ||
              left.device.deviceClass.localeCompare(right.device.deviceClass) ||
              left.device.modelName.localeCompare(right.device.modelName) ||
              left.device.name.localeCompare(right.device.name),
          );
        if (categoryDevices.length === 0) return '';
        const tiles = categoryDevices
          .map(({ device, rank }) => {
            const preference = {
              represented: preferences[device.serial]?.represented ?? true,
              audio: preferences[device.serial]?.audio ?? true,
              snapshotMode: preferences[device.serial]?.snapshotMode ?? 'Refresh',
            };
            const badges = [
              device.diagnosticOnly ? { icon: 'troubleshoot', label: messages.diagnosticOnly } : undefined,
            ].filter(Boolean);
            const artwork = device.artwork
              ? `<img src="${escapeHtml(device.artwork)}" alt="" loading="lazy" data-device-artwork>`
              : '';
            const tile = `
              <div class="device-art" aria-hidden="true"><img class="device-class-icon" src="assets/icons/inventory.svg" alt=""><span>${escapeHtml(device.deviceClass)}</span>${artwork}</div>
              <div class="device-copy"><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(device.modelName)}</p></div>
              <div class="device-badges">${badges.map(({ icon, label }) => `<span class="device-badge device-badge-${icon}" role="img" tabindex="0" aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}"><img src="assets/icons/${icon}.svg" alt=""></span>`).join('')}</div>`;
            if (device.diagnosticOnly) {
              return `<article class="device-tile device-tile-flippable" data-category="${category}" data-rank="${rank}"><div class="device-card-inner"><div class="device-card-face device-card-front"><button class="device-summary device-flip-control" type="button" aria-expanded="false">${tile}</button></div><div class="device-card-face device-card-back"><button class="device-mobile-close" type="button" aria-label="${escapeHtml(messages.closeDetails)}">×</button><div class="diagnostic-panel"><img src="assets/icons/troubleshoot.svg" alt=""><strong>${escapeHtml(messages.diagnosticOnly)}</strong><p>${escapeHtml(messages.diagnosticDescription)}</p></div></div></div></article>`;
            }
            const controls = device.preferences
              .map((key) => preferenceControl(device, key, preference, messages))
              .join('');
            const disabledClass = rank === 1 ? ' device-tile-disabled' : '';
            return `<article class="device-tile device-tile-flippable${disabledClass}" data-category="${category}" data-rank="${rank}"><div class="device-card-inner"><div class="device-card-face device-card-front"><button class="device-summary device-flip-control" type="button" aria-expanded="false">${tile}</button></div><div class="device-card-face device-card-back device-card-settings"><button class="device-mobile-close" type="button" aria-label="${escapeHtml(messages.closeDetails)}">×</button><div class="preference-panel"><div class="preference-grid">${controls}</div></div></div></div></article>`;
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
    elements.masthead.hidden = true;
    renderDevices(result.devices, config, messages, elements.groups);
    elements.setup.hidden = true;
    elements.authenticate.hidden = false;
    if (result.devices.length > 0) {
      elements.pageTitle.textContent = messages.dashboardPageTitle;
    } else if (result.state === 'authentication-required') {
      elements.setup.hidden = false;
    }
  }

  function bindPreferences(elements, getConfig, saveConfig, getMessages) {
    elements.groups.addEventListener('click', (event) => {
      const front = event.target.closest?.('.device-flip-control');
      const close = event.target.closest?.('.device-mobile-close');
      const back = event.target.closest?.('.device-card-back');
      if (!front && !close && (!back || event.target.closest('input, select, option, label, button, a'))) return;
      const tile = (front ?? close ?? back).closest('.device-tile-flippable');
      const flipped = Boolean(front);
      tile.classList.toggle('device-tile-flipped', flipped);
      tile.querySelector('.device-flip-control').setAttribute('aria-expanded', String(flipped));
    });
    elements.groups.addEventListener(
      'load',
      (event) => {
        if (event.target?.dataset?.deviceArtwork !== undefined) {
          event.target.parentElement.dataset.artworkLoaded = '';
        }
      },
      true,
    );
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
      markPendingPreference(control, key, value);
      if (key === 'snapshotMode') {
        control.closest('.snapshot-setting')?.querySelector('[data-snapshot-description]').replaceChildren(
          control.dataset.description,
        );
      }
      const entityPreferences = { ...(existing.entityPreferences ?? {}) };
      const preference = { ...(entityPreferences[serial] ?? {}) };
      if (value === defaults[key]) delete preference[key];
      else preference[key] = value;
      if (Object.keys(preference).length === 0) delete entityPreferences[serial];
      else entityPreferences[serial] = preference;
      try {
        await saveConfig({ ...existing, entityPreferences });
        if (key === 'represented') {
          const tile = control.closest?.('.device-tile');
          if (tile) {
            tile.classList.toggle('device-tile-disabled', !value);
            tile.querySelectorAll('[data-requires-representation]').forEach((setting) => {
              setting.hidden = !value;
            });
          }
        }
      } catch {
        elements.summary.textContent = getMessages().preferenceSaveFailed;
      }
    });
  }

  global.HomebridgeEufyDashboard = { bindPreferences, render };
})(window);
