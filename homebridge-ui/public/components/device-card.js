/**
 * DeviceCard component — renders a single device/station card for the dashboard grid.
 *
 * Usage:
 *   DeviceCard.render(container, {
 *     device: { uniqueId, displayName, type, typename, ... },
 *     isStation: false,
 *     enabled: true,
 *     onClick: (device) => { ... },
 *     onToggle: (device, enabled) => { ... }
 *   });
 */
// eslint-disable-next-line no-unused-vars
const DeviceCard = {

  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {object} opts.device - L_Device or L_Station data
   * @param {boolean} [opts.isStation]
   * @param {boolean} opts.enabled - whether device is enabled (not ignored)
   * @param {function} opts.onClick - callback(device)
   * @param {function} opts.onToggle - callback(device, enabled)
   * @returns {HTMLElement}
   */
  render(container, opts) {
    const d = opts.device;
    const isUnsupported = d.unsupported === true;
    const isIgnored = d.ignored === true;
    const isKeypad = d.isKeypad === true;

    const col = document.createElement('div');
    col.className = 'col-6 col-md-4 col-lg-3 mb-3';

    const card = document.createElement('div');
    card.className = 'device-card';
    if (isUnsupported) card.classList.add('device-card--unsupported');
    if (isIgnored) card.classList.add('device-card--ignored');

    // Image (skip for unsupported)
    if (!isUnsupported) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'device-card__image-wrap';
      const img = document.createElement('img');
      img.src = DeviceImages.getPath(d.type);
      img.alt = d.displayName;
      img.loading = 'lazy';
      imgWrap.appendChild(img);
      card.appendChild(imgWrap);
    }

    // Body
    const body = document.createElement('div');
    body.className = 'device-card__body';

    const name = document.createElement('div');
    name.className = 'device-card__name';
    name.textContent = d.displayName;
    name.title = d.displayName;

    // Meta row: left side = battery/charging info, right side = toggle
    const metaRow = document.createElement('div');
    metaRow.className = 'device-card__meta-row';

    const meta = document.createElement('div');
    meta.className = 'device-card__meta';

    // Build meta line with DOM nodes so we can mix text and SVG icons
    const metaFragments = [];
    if (isUnsupported) {
      metaFragments.push('Type ' + d.type);
    }

    // Power info (pre-computed by server)
    const pw = d.power || {};
    if (pw.battery !== undefined) {
      metaFragments.push({ icon: Helpers.batteryIcon(pw.battery), text: pw.battery + '%' });
    } else if (pw.batteryLow === true) {
      metaFragments.push({ icon: Helpers.batteryIcon(0), text: 'Low' });
    } else if (pw.batteryLow === false) {
      metaFragments.push({ icon: Helpers.batteryIcon(100), text: 'OK' });
    }
    if (pw.icon && pw.label) {
      metaFragments.push({ icon: pw.icon, text: pw.label });
    }
    metaFragments.forEach((frag, i) => {
      if (i > 0) meta.append(' · ');
      if (typeof frag === 'string') {
        meta.append(frag);
      } else {
        meta.appendChild(Helpers.icon(frag.icon, 14, frag.text));
        meta.append(' ' + frag.text);
      }
    });

    metaRow.appendChild(meta);

    // Toggle — inline with meta, only for non-unsupported, non-keypad devices
    if (!isUnsupported && !isKeypad) {
      const switchWrap = document.createElement('div');
      switchWrap.className = 'form-check form-switch mb-0';
      switchWrap.addEventListener('click', (e) => e.stopPropagation());

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'form-check-input';
      toggle.checked = opts.enabled;
      toggle.role = 'switch';
      toggle.title = opts.enabled ? 'Enabled in HomeKit' : 'Disabled in HomeKit';

      toggle.addEventListener('change', (e) => {
        e.stopPropagation();
        if (opts.onToggle) opts.onToggle(d, toggle.checked);
      });

      switchWrap.appendChild(toggle);
      metaRow.appendChild(switchWrap);
    }

    body.appendChild(name);
    body.appendChild(metaRow);

    // Footer with badges (unsupported / disabled)
    const footer = document.createElement('div');
    footer.className = 'device-card__footer';

    const badgeArea = document.createElement('div');
    let hasBadge = false;

    if (isKeypad) {
      const badge = document.createElement('span');
      badge.className = 'badge bg-secondary';
      badge.textContent = 'Not available for HomeKit';
      badgeArea.appendChild(badge);
      hasBadge = true;
    } else if (isUnsupported) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-unsupported';
      badge.textContent = 'Not Supported';
      badgeArea.appendChild(badge);

      const hint = document.createElement('div');
      hint.className = 'device-card__hint';
      hint.textContent = 'Click to help us add support';
      badgeArea.appendChild(hint);
      hasBadge = true;
    } else if (isIgnored) {
      const badge = document.createElement('span');
      badge.className = 'badge bg-secondary';
      badge.textContent = 'Disabled';
      badgeArea.appendChild(badge);
      hasBadge = true;
    }

    footer.appendChild(badgeArea);

    card.appendChild(body);
    if (hasBadge) card.appendChild(footer);

    // Click handler — navigate to detail (disabled for keypads)
    if (isKeypad) {
      card.style.cursor = 'default';
      card.title = 'Keypads have no configurable HomeKit settings. The keypad works alongside your station but cannot be exposed to HomeKit.';
    } else {
      card.addEventListener('click', () => {
        if (opts.onClick) opts.onClick(d);
      });
    }

    col.appendChild(card);
    if (container) container.appendChild(col);
    return col;
  },
};
