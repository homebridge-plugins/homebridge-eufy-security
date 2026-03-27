/**
 * Device Detail View — per-device/station settings with progressive disclosure.
 * Simple mode shows 3-4 toggles, Advanced expands full options.
 */
// eslint-disable-next-line no-unused-vars
const DeviceDetailView = {

  _container: null,
  _advancedOpen: false,
  _expertOpen: false,

  /**
   * @param {HTMLElement} container
   * @param {string} type - 'device' or 'station'
   * @param {string} id - uniqueId / serial number
   */
  async render(container, type, id) {
    this._container = container;
    this._advancedOpen = false;
    this._expertOpen = false;
    container.innerHTML = '';

    const config = await Config.get();
    const { station, device } = this._findAccessory(type, id);

    if (!station && !device) {
      container.innerHTML = `
        <div class="text-center text-muted py-5">
          <p>Device not found.</p>
          <button class="btn btn-outline-secondary btn-sm" id="btn-back">Back to Dashboard</button>
        </div>`;
      container.querySelector('#btn-back').addEventListener('click', () => App.navigate('dashboard'));
      return;
    }

    // For unsupported standalone stations routed as 'device', the device is null — use station
    const accessory = (type === 'station' ? station : device) || station;
    const isUnsupported = accessory && accessory.unsupported === true;

    // Redirect unsupported devices to their dedicated view
    if (isUnsupported) {
      App.navigate('unsupported/' + accessory.uniqueId);
      return;
    }

    // Header with back button + device image
    this._renderHeader(container, accessory, type);

    // Main content area
    const content = document.createElement('div');

    if (type === 'device' && device) {
      const accessoryConfig = type === 'station'
        ? Config.getStationConfig(id)
        : Config.getDeviceConfig(id);
      this._renderDeviceSettings(content, device, accessoryConfig || {}, config);

      // For standalone devices, also show station settings (if station supports security control)
      if (device.standalone && station && !station.noSecurityControl) {
        const stationConfig = Config.getStationConfig(station.uniqueId) || {};
        this._renderStandaloneStationSection(content, station, stationConfig, config);
      }
    } else if (type === 'station' && station) {
      const accessoryConfig = Config.getStationConfig(id);
      this._renderStationSettings(content, station, accessoryConfig || {}, config);
    }

    container.appendChild(content);


  },

  // ===== Header =====
  _renderHeader(container, accessory, type) {
    const header = document.createElement('div');
    header.className = 'detail-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-link p-0';
    backBtn.innerHTML = '← Back';
    backBtn.style.textDecoration = 'none';
    backBtn.addEventListener('click', () => App.navigate('dashboard'));

    const info = document.createElement('div');
    info.className = 'detail-header__info';
    info.innerHTML = `
      <h5>${this._escHtml(accessory.displayName)}</h5>
      <small>${accessory.typename || ('Type ' + accessory.type)} · ${accessory.uniqueId}</small>
    `;

    header.appendChild(backBtn);

    const img = document.createElement('img');
    img.className = 'detail-header__image';
    img.src = DeviceImages.getPath(accessory.type);
    img.alt = accessory.displayName;
    header.appendChild(img);

    header.appendChild(info);
    container.appendChild(header);
  },

  // ===== Device Settings (Camera/Doorbell/Sensor/Lock) =====
  _renderDeviceSettings(content, device, deviceConfig, config) {
    const ignoreDevices = config.ignoreDevices || [];
    const isIgnored = ignoreDevices.includes(device.uniqueId);

    // ── Enable in HomeKit (always visible) ──
    const enableSection = document.createElement('div');
    enableSection.className = 'detail-section';

    const enableTitle = document.createElement('div');
    enableTitle.className = 'detail-section__title';
    enableTitle.textContent = 'Device Settings';
    enableSection.appendChild(enableTitle);

    Toggle.render(enableSection, {
      id: 'toggle-enable',
      label: 'Enable in HomeKit',
      help: 'When disabled, this device will not appear in the Home app.',
      checked: !isIgnored,
      onChange: async (checked) => {
        await Config.toggleIgnore(device.uniqueId, !checked, 'device');
        const rest = content.querySelector('#device-rest-settings');
        if (rest) rest.style.display = checked ? '' : 'none';
      },
    });

    content.appendChild(enableSection);

    // Wrapper for all settings below Enable toggle — hidden when device is ignored
    const restSettings = document.createElement('div');
    restSettings.id = 'device-rest-settings';
    if (isIgnored) restSettings.style.display = 'none';

    // ── Simple Settings ──
    const simpleSection = document.createElement('div');
    simpleSection.className = 'detail-section';

    // Camera-specific simple settings
    if (device.isCamera) {
      Toggle.render(simpleSection, {
        id: 'toggle-camera-enable',
        label: 'Camera Feed',
        help: 'Show camera feed in HomeKit. Disable to expose only sensors.',
        checked: deviceConfig.enableCamera !== false,
        onChange: async (checked) => {
          await Config.updateDeviceConfig(device.uniqueId, { enableCamera: checked });
        },
      });

      if (device.DeviceMotionDetection) {
        Toggle.render(simpleSection, {
          id: 'toggle-motion',
          label: 'Motion Detection',
          help: 'Expose motion detection as a sensor in HomeKit.',
          checked: deviceConfig.motionButton !== false,
          onChange: async (checked) => {
            await Config.updateDeviceConfig(device.uniqueId, { motionButton: checked });
          },
        });
      }
    }

    restSettings.appendChild(simpleSection);

    // ── Advanced Settings (collapsed by default) ──
    if (device.isCamera) {
      this._renderAdvancedToggle(restSettings, () => {
        this._advancedOpen = !this._advancedOpen;
        const advSection = content.querySelector('#advanced-section');
        if (advSection) advSection.style.display = this._advancedOpen ? 'block' : 'none';
        const chevron = content.querySelector('.advanced-toggle__chevron');
        if (chevron) chevron.classList.toggle('advanced-toggle__chevron--open', this._advancedOpen);
      });

      const advSection = document.createElement('div');
      advSection.id = 'advanced-section';
      advSection.style.display = 'none';

      // ── Streaming ──
      const streamTitle = document.createElement('div');
      streamTitle.className = 'detail-section__title';
      streamTitle.textContent = 'Streaming';
      advSection.appendChild(streamTitle);

      if (device.supportsRTSP) {
        Toggle.render(advSection, {
          id: 'toggle-rtsp',
          label: 'RTSP Streaming',
          help: 'Use RTSP stream instead of P2P. Requires the camera to have RTSP enabled in the Eufy app.',
          checked: !!deviceConfig.rtsp,
          onChange: async (checked) => {
            await Config.updateDeviceConfig(device.uniqueId, { rtsp: checked });
          },
        });
      }

      Toggle.render(advSection, {
        id: 'toggle-audio',
        label: 'Audio',
        help: 'Include audio in camera streams and recordings.',
        checked: deviceConfig.audio !== false,
        onChange: async (checked) => {
          await Config.updateDeviceConfig(device.uniqueId, { audio: checked });
        },
      });

      if (device.supportsTalkback) {
        Toggle.render(advSection, {
          id: 'toggle-talkback',
          label: 'Two-Way Audio',
          help: 'Enable talkback / two-way audio in HomeKit.',
          checked: !!deviceConfig.talkback,
          onChange: async (checked) => {
            await Config.updateDeviceConfig(device.uniqueId, { talkback: checked });
          },
        });
      }

      // ── HomeKit Secure Video ──
      const hsvTitle = document.createElement('div');
      hsvTitle.className = 'detail-section__title';
      hsvTitle.textContent = 'HomeKit Secure Video';
      advSection.appendChild(hsvTitle);

      NumberInput.render(advSection, {
        id: 'num-hsv-duration',
        label: 'HSV Recording Duration',
        help: 'Maximum recording duration in seconds for HSV clips.',
        value: deviceConfig.hsvRecordingDuration || 90,
        min: 10,
        max: 300,
        step: 10,
        suffix: 'sec',
        onChange: async (val) => {
          await Config.updateDeviceConfig(device.uniqueId, { hsvRecordingDuration: val });
        },
      });

      // ── Snapshots ──
      const snapTitle = document.createElement('div');
      snapTitle.className = 'detail-section__title';
      snapTitle.textContent = 'Snapshots';
      advSection.appendChild(snapTitle);

      Select.render(advSection, {
        id: 'select-snapshot-method',
        label: 'Snapshot Method',
        help: 'How to capture snapshots. "Auto" lets the plugin decide the best method.',
        options: [
          { value: '0', label: 'Auto' },
          { value: '1', label: 'From Livestream' },
          { value: '2', label: 'From Cloud' },
          { value: '3', label: 'Preload on Event' },
        ],
        value: String(deviceConfig.snapshotHandlingMethod || 0),
        onChange: async (val) => {
          await Config.updateDeviceConfig(device.uniqueId, { snapshotHandlingMethod: parseInt(val) });
        },
      });

      Toggle.render(advSection, {
        id: 'toggle-delay-snapshot',
        label: 'Delay Snapshot Capture',
        help: 'Wait briefly before taking a snapshot to get a clearer image.',
        checked: !!deviceConfig.delayCameraSnapshot,
        onChange: async (checked) => {
          await Config.updateDeviceConfig(device.uniqueId, { delayCameraSnapshot: checked });
        },
      });

      // ── Camera Buttons ──
      const btnTitle = document.createElement('div');
      btnTitle.className = 'detail-section__title';
      btnTitle.textContent = 'Camera Buttons';
      advSection.appendChild(btnTitle);

      Toggle.render(advSection, {
        id: 'toggle-enable-btn',
        label: 'Enable Switch',
        help: 'Add a switch to enable/disable the camera from HomeKit.',
        checked: !!deviceConfig.enableButton,
        onChange: async (checked) => {
          await Config.updateDeviceConfig(device.uniqueId, { enableButton: checked });
        },
      });

      if (device.DeviceLight) {
        Toggle.render(advSection, {
          id: 'toggle-light-btn',
          label: 'Light Switch',
          help: 'Add a switch to control the camera\'s spotlight/floodlight.',
          checked: !!deviceConfig.lightButton,
          onChange: async (checked) => {
            await Config.updateDeviceConfig(device.uniqueId, { lightButton: checked });
          },
        });
      }

      if (device.DeviceChimeIndoor) {
        Toggle.render(advSection, {
          id: 'toggle-chime-btn',
          label: 'Indoor Chime Switch',
          help: 'Add a switch to control the indoor chime.',
          checked: !!deviceConfig.indoorChimeButton,
          onChange: async (checked) => {
            await Config.updateDeviceConfig(device.uniqueId, { indoorChimeButton: checked });
          },
        });
      }

      // ── Expert: Video Config ──
      this._renderExpertToggle(advSection, () => {
        this._expertOpen = !this._expertOpen;
        const expertSection = advSection.querySelector('#expert-section');
        if (expertSection) expertSection.style.display = this._expertOpen ? 'block' : 'none';
        const chevron = advSection.querySelector('#expert-chevron');
        if (chevron) chevron.classList.toggle('advanced-toggle__chevron--open', this._expertOpen);
      });

      const expertSection = document.createElement('div');
      expertSection.id = 'expert-section';
      expertSection.style.display = 'none';

      const videoTitle = document.createElement('div');
      videoTitle.className = 'detail-section__title';
      videoTitle.textContent = 'Video Encoding (Expert)';
      expertSection.appendChild(videoTitle);

      const vc = deviceConfig.videoConfig || {};

      NumberInput.render(expertSection, {
        id: 'num-maxWidth',
        label: 'Max Width',
        help: 'Maximum video width in pixels.',
        value: vc.maxWidth || 1920,
        min: 320, max: 3840, step: 160,
        suffix: 'px',
        onChange: async (val) => {
          const existing = deviceConfig.videoConfig || {};
          await Config.updateDeviceConfig(device.uniqueId, { videoConfig: { ...existing, maxWidth: val } });
        },
      });

      NumberInput.render(expertSection, {
        id: 'num-maxHeight',
        label: 'Max Height',
        help: 'Maximum video height in pixels.',
        value: vc.maxHeight || 1080,
        min: 240, max: 2160, step: 120,
        suffix: 'px',
        onChange: async (val) => {
          const existing = deviceConfig.videoConfig || {};
          await Config.updateDeviceConfig(device.uniqueId, { videoConfig: { ...existing, maxHeight: val } });
        },
      });

      NumberInput.render(expertSection, {
        id: 'num-maxFPS',
        label: 'Max FPS',
        help: 'Maximum frames per second.',
        value: vc.maxFPS || 30,
        min: 10, max: 60, step: 5,
        onChange: async (val) => {
          const existing = deviceConfig.videoConfig || {};
          await Config.updateDeviceConfig(device.uniqueId, { videoConfig: { ...existing, maxFPS: val } });
        },
      });

      NumberInput.render(expertSection, {
        id: 'num-maxBitrate',
        label: 'Max Bitrate',
        help: 'Maximum video bitrate in kbps.',
        value: vc.maxBitrate || 1800,
        min: 300, max: 8000, step: 100,
        suffix: 'kbps',
        onChange: async (val) => {
          const existing = deviceConfig.videoConfig || {};
          await Config.updateDeviceConfig(device.uniqueId, { videoConfig: { ...existing, maxBitrate: val } });
        },
      });

      advSection.appendChild(expertSection);
      restSettings.appendChild(advSection);
    }

    content.appendChild(restSettings);
  },

  // ===== Station Settings =====
  _renderStationSettings(content, station, stationConfig, config) {
    const ignoreStations = config.ignoreStations || [];
    const isIgnored = ignoreStations.includes(station.uniqueId);

    // Simple
    const section = document.createElement('div');
    section.className = 'detail-section';

    const title = document.createElement('div');
    title.className = 'detail-section__title';
    title.textContent = 'Station Settings';
    section.appendChild(title);

    Toggle.render(section, {
      id: 'toggle-station-enable',
      label: 'Enable in HomeKit',
      help: 'When disabled, this station\'s security panel will not appear in HomeKit.',
      checked: !isIgnored,
      onChange: async (checked) => {
        await Config.toggleIgnore(station.uniqueId, !checked, 'station');
        const rest = content.querySelector('#station-rest-settings');
        if (rest) rest.style.display = checked ? '' : 'none';
      },
    });

    content.appendChild(section);

    // Wrapper for all settings below Enable toggle — hidden when station is ignored
    const stationRest = document.createElement('div');
    stationRest.id = 'station-rest-settings';
    if (isIgnored) stationRest.style.display = 'none';

    // Advanced — Guard Modes Mapping
    this._renderAdvancedToggle(stationRest, () => {
      this._advancedOpen = !this._advancedOpen;
      const advSection = content.querySelector('#advanced-section');
      if (advSection) advSection.style.display = this._advancedOpen ? 'block' : 'none';
      const chevron = content.querySelector('.advanced-toggle__chevron');
      if (chevron) chevron.classList.toggle('advanced-toggle__chevron--open', this._advancedOpen);
    });

    const advSection = document.createElement('div');
    advSection.id = 'advanced-section';
    advSection.style.display = 'none';

    const guardTitle = document.createElement('div');
    guardTitle.className = 'detail-section__title';
    guardTitle.textContent = 'Guard Mode Mapping';
    advSection.appendChild(guardTitle);

    const guardHelp = document.createElement('p');
    guardHelp.className = 'text-muted';
    guardHelp.style.fontSize = '0.8rem';
    guardHelp.textContent = 'Map HomeKit security modes to Eufy guard modes for this station.';
    advSection.appendChild(guardHelp);

    GuardModes.render(advSection, {
      hkHome: stationConfig.hkHome ?? config.hkHome ?? 1,
      hkAway: stationConfig.hkAway ?? config.hkAway ?? 0,
      hkNight: stationConfig.hkNight ?? config.hkNight ?? 1,
      hkOff: stationConfig.hkOff ?? config.hkOff ?? 63,
      onChange: async (modes) => {
        await Config.updateStationConfig(station.uniqueId, modes);
      },
    });

    // Manual Alarm
    const alarmTitle = document.createElement('div');
    alarmTitle.className = 'detail-section__title mt-3';
    alarmTitle.textContent = 'Manual Alarm';
    advSection.appendChild(alarmTitle);

    NumberInput.render(advSection, {
      id: 'num-alarm-seconds',
      label: 'Alarm Duration',
      help: 'How long (in seconds) a manually triggered alarm should sound.',
      value: stationConfig.manualAlarmSeconds || 30,
      min: 5,
      max: 300,
      step: 5,
      suffix: 'sec',
      onChange: async (val) => {
        await Config.updateStationConfig(station.uniqueId, { manualAlarmSeconds: val });
      },
    });

    stationRest.appendChild(advSection);
    content.appendChild(stationRest);
  },

  // ===== Standalone Station Settings (shown in device detail for standalone devices) =====
  _renderStandaloneStationSection(content, station, stationConfig, config) {
    const ignoreStations = config.ignoreStations || [];
    const isIgnored = ignoreStations.includes(station.uniqueId);

    // Divider
    const divider = document.createElement('hr');
    divider.className = 'my-4';
    content.appendChild(divider);

    // Enable toggle section
    const section = document.createElement('div');
    section.className = 'detail-section';

    const title = document.createElement('div');
    title.className = 'detail-section__title';
    title.textContent = 'Security Panel';
    section.appendChild(title);

    const helpText = document.createElement('p');
    helpText.className = 'text-muted';
    helpText.style.fontSize = '0.8rem';
    helpText.textContent = 'This device acts as its own station. Configure the security panel independently from the device.';
    section.appendChild(helpText);

    Toggle.render(section, {
      id: 'toggle-station-enable',
      label: 'Enable Security Panel',
      help: 'When disabled, the security panel will not appear in HomeKit. The device itself remains active.',
      checked: !isIgnored,
      onChange: async (checked) => {
        await Config.toggleIgnore(station.uniqueId, !checked, 'station');
        const rest = content.querySelector('#standalone-station-rest');
        if (rest) rest.style.display = checked ? '' : 'none';
      },
    });

    content.appendChild(section);

    // Rest of station settings (hidden when disabled)
    const stationRest = document.createElement('div');
    stationRest.id = 'standalone-station-rest';
    if (isIgnored) stationRest.style.display = 'none';

    // Guard Mode Mapping
    const guardSection = document.createElement('div');
    guardSection.className = 'detail-section';

    const guardTitle = document.createElement('div');
    guardTitle.className = 'detail-section__title';
    guardTitle.textContent = 'Guard Mode Mapping';
    guardSection.appendChild(guardTitle);

    const guardHelp = document.createElement('p');
    guardHelp.className = 'text-muted';
    guardHelp.style.fontSize = '0.8rem';
    guardHelp.textContent = 'Map HomeKit security modes to Eufy guard modes.';
    guardSection.appendChild(guardHelp);

    GuardModes.render(guardSection, {
      hkHome: stationConfig.hkHome ?? config.hkHome ?? 1,
      hkAway: stationConfig.hkAway ?? config.hkAway ?? 0,
      hkNight: stationConfig.hkNight ?? config.hkNight ?? 1,
      hkOff: stationConfig.hkOff ?? config.hkOff ?? 63,
      onChange: async (modes) => {
        await Config.updateStationConfig(station.uniqueId, modes);
      },
    });

    // Manual Alarm
    const alarmTitle = document.createElement('div');
    alarmTitle.className = 'detail-section__title mt-3';
    alarmTitle.textContent = 'Manual Alarm';
    guardSection.appendChild(alarmTitle);

    NumberInput.render(guardSection, {
      id: 'num-station-alarm-seconds',
      label: 'Alarm Duration',
      help: 'How long (in seconds) a manually triggered alarm should sound.',
      value: stationConfig.manualAlarmSeconds || 30,
      min: 5,
      max: 300,
      step: 5,
      suffix: 'sec',
      onChange: async (val) => {
        await Config.updateStationConfig(station.uniqueId, { manualAlarmSeconds: val });
      },
    });

    stationRest.appendChild(guardSection);
    content.appendChild(stationRest);
  },

  // ===== Helpers =====

  _findAccessory(type, id) {
    const stations = App.state.stations || [];
    let foundStation = null;
    let foundDevice = null;

    for (const s of stations) {
      if (s.uniqueId === id) foundStation = s;
      for (const d of s.devices || []) {
        if (d.uniqueId === id) {
          foundDevice = d;
          foundStation = s;
        }
      }
    }

    return { station: foundStation, device: foundDevice };
  },

  _renderAdvancedToggle(container, onClick) {
    const btn = document.createElement('button');
    btn.className = 'advanced-toggle';
    btn.innerHTML = `
      <span class="advanced-toggle__chevron">▶</span>
      Advanced Settings
    `;
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
  },

  _renderExpertToggle(container, onClick) {
    const btn = document.createElement('button');
    btn.className = 'advanced-toggle';
    btn.innerHTML = `
      <span class="advanced-toggle__chevron" id="expert-chevron">▶</span>
      Video Encoding (Expert)
    `;
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
  },

  _escHtml(str) {
    return Helpers.escHtml(str);
  },
};
