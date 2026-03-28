import { EufySecurity, libVersion, Device, PropertyName, CommandName, DeviceType, UserType } from 'eufy-security-client';
import * as fs from 'fs';
import { Logger as TsLogger } from 'tslog';
import { createStream } from 'rotating-file-stream';
import { create as tarCreate } from 'tar';
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import os from 'os';
import { setTimeout as delay } from 'node:timers/promises';
import { encryptDiagnostics } from './diagnosticsCrypto.js';

const require = createRequire(import.meta.url);
const { version: LIB_VERSION } = require('../package.json');

/** Max time (ms) to wait for the client to populate raw data on unsupported items. */
const UNSUPPORTED_INTEL_WAIT_MS = 2 * 60 * 1000; // 2 minutes

class UiServer extends HomebridgePluginUiServer {

  stations = [];
  eufyClient = null;
  log;
  tsLog;
  storagePath;
  storedAccessoriesPath;

  adminAccountUsed = false;

  // Batch processing for stations and devices
  pendingStations = [];
  pendingDevices = [];
  processingTimeout;

  /** Set to true when the user clicks "Skip" in the UI to abort the unsupported intel wait. */
  _skipIntelWait = false;

  /** Current discovery phase — exposed via /discoveryState for UI catch-up. */
  _discoveryPhase = 'idle';

  /** Timestamp (ms) of the last diagnostics download — used for rate-limiting. */
  _lastDiagnosticsTime = 0;

  /** Seconds to wait after the last station/device event before processing. */
  static DISCOVERY_DEBOUNCE_SEC = 10;

  /** Seconds to wait after auth before giving up on device discovery. */
  static DISCOVERY_INACTIVITY_SEC = 30;

  /** Minimum cooldown between diagnostics downloads (ms). */
  static DIAGNOSTICS_COOLDOWN_MS = 60_000;

  config = {
    username: '',
    password: '',
    language: 'en',
    country: 'US',
    trustedDeviceName: 'My Phone',
    persistentDir: '',
    p2pConnectionSetup: 0,
    pollingIntervalMinutes: 1,
    eventDurationSeconds: 10,
    acceptInvitations: true,
    logging: {
      level: 1, // LogLevel.Debug — enables eufy-security-client internal logging to configui-lib.log
    },
  };

  constructor() {
    super();

    this.storagePath = this.homebridgeStoragePath + '/eufysecurity';
    this.storedAccessoriesPath = this.storagePath + '/accessories.json';
    this.unsupportedPath = this.storagePath + '/unsupported.json';
    this.config.persistentDir = this.storagePath;

    this.initLogger();
    this.initTransportStreams();
    this.initEventListeners();
    this.ready();
  }

  /** Build a unified power descriptor (source, icon, label, battery) from a properties object. */
  _computePower(props) {
    const power = { source: null, icon: null, label: null };

    // Battery level
    if (props.battery !== undefined) {
      power.battery = props.battery;
    } else if (props.batteryLow !== undefined) {
      // Simple sensors only expose batteryLow boolean
      power.batteryLow = props.batteryLow;
    }

    // Charging status (bitmask)
    if (props.chargingStatus !== undefined) {
      const cs = props.chargingStatus;
      const isSolar = ((cs >> 2) & 1) === 1;
      const isPlugSolar = ((cs >> 3) & 1) === 1;
      const isUsb = (cs & 1) === 1;

      if (isSolar || isPlugSolar) {
        power.source = 'solar';
        power.icon = 'solar_power.svg';
        power.label = 'Solar Charging';
        return power;
      }
      if (isUsb) {
        power.source = 'plugged';
        power.icon = 'bolt.svg';
        power.label = 'Charging';
        return power;
      }
    }

    // PowerSource property (cameras with battery/solar panel)
    // 0 = BATTERY, 1 = SOLAR_PANEL
    if (props.powerSource === 1) {
      power.source = 'solar';
      power.icon = 'solar_power.svg';
      power.label = 'Solar';
    } else if (props.powerSource === 0) {
      power.source = 'battery';
    } else if (power.battery === undefined && power.batteryLow === undefined) {
      // No battery info at all — AC powered (indoor cameras, stations)
      power.source = 'plugged';
      power.icon = 'bolt.svg';
      power.label = 'Plugged In';
    } else {
      // Has battery/batteryLow but no powerSource — simple battery device (sensors)
      power.source = 'battery';
    }

    return power;
  }

  initLogger() {
    const logOptions = {
      name: `[UI-${LIB_VERSION}]`,
      prettyLogTemplate: '[{{mm}}/{{dd}}/{{yyyy}}, {{hh}}:{{MM}}:{{ss}}]\t{{name}}\t{{logLevelName}}\t',
      prettyErrorTemplate: '\n{{errorName}} {{errorMessage}}\nerror stack:\n{{errorStack}}',
      prettyErrorStackTemplate: '  • {{fileName}}\t{{method}}\n\t{{fileNameWithLine}}',
      prettyErrorParentNamesSeparator: '',
      prettyErrorLoggerNameDelimiter: '\t',
      stylePrettyLogs: true,
      minLevel: 2,
      prettyLogTimeZone: 'local',
      prettyLogStyles: {
        logLevelName: {
          '*': ['bold', 'black', 'bgWhiteBright', 'dim'],
          SILLY: ['bold', 'white'],
          TRACE: ['bold', 'whiteBright'],
          DEBUG: ['bold', 'green'],
          INFO: ['bold', 'blue'],
          WARN: ['bold', 'yellow'],
          ERROR: ['bold', 'red'],
          FATAL: ['bold', 'redBright'],
        },
        dateIsoStr: 'gray',
        filePathWithLine: 'white',
        name: 'green',
        nameWithDelimiterPrefix: ['white', 'bold'],
        nameWithDelimiterSuffix: ['white', 'bold'],
        errorName: ['bold', 'bgRedBright', 'whiteBright'],
        fileName: ['yellow'],
      },
    };
    this.log = new TsLogger(logOptions);
    this.tsLog = new TsLogger({ ...logOptions, type: 'hidden', minLevel: 2 });
  }

  initTransportStreams() {
    fs.mkdirSync(this.storagePath, { recursive: true });

    const logStreams = [
      { name: 'configui-server.log', logger: this.log },
      { name: 'configui-lib.log', logger: this.tsLog },
    ];

    for (const { name, logger } of logStreams) {
      const logStream = createStream(name, { path: this.storagePath, interval: '1d', rotate: 3, maxSize: '200M', compress: 'gzip' });

      logger.attachTransport((logObj) => {
        const meta = logObj['_meta'];
        const logName = meta.name;
        const level = meta.logLevelName;
        const date = meta.date.toISOString();

        let message = '';
        for (let i = 0; i <= 5; i++) {
          if (logObj[i]) {
            message += ' ' + (typeof logObj[i] === 'string' ? logObj[i] : JSON.stringify(logObj[i]));
          }
        }

        logStream.write(date + '\t' + logName + '\t' + level + '\t' + message + '\n');
      });
    }

    this.log.debug('Using bropats eufy-security-client library in version ' + libVersion);
  }

  initEventListeners() {
    this.onRequest('/login', this.login.bind(this));
    this.onRequest('/checkCache', this.checkCache.bind(this));
    this.onRequest('/storedAccessories', this.loadStoredAccessories.bind(this));
    this.onRequest('/reset', this.resetPlugin.bind(this));
    this.onRequest('/downloadDiagnostics', this.downloadDiagnostics.bind(this));
    this.onRequest('/cleanStorage', this.cleanStorage.bind(this));
    this.onRequest('/systemInfo', this.getSystemInfo.bind(this));
    this.onRequest('/skipIntelWait', this.skipIntelWait.bind(this));
    this.onRequest('/discoveryState', this.getDiscoveryState.bind(this));
    this.onRequest('/unsupportedDevices', this.loadUnsupportedDevices.bind(this));
    this.onRequest('/debugRecordings', this.listDebugRecordings.bind(this));
    this.onRequest('/downloadDebugRecording', this.downloadDebugRecording.bind(this));
    this.onRequest('/deleteDebugRecording', this.deleteDebugRecording.bind(this));
    this.onRequest('/deleteAllDebugRecordings', this.deleteAllDebugRecordings.bind(this));
  }

  skipIntelWait() {
    this._skipIntelWait = true;
    this.log.info('User requested to skip unsupported intel wait');
    return { ok: true };
  }

  /** Lazily load and cache valid ISO 3166-1 alpha-2 country codes from countries.js. */
  _getValidCountryCodes() {
    if (!this._validCountryCodes) {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const source = fs.readFileSync(path.join(__dirname, 'public/utils/countries.js'), 'utf-8');
      this._validCountryCodes = new Set(source.match(/\b[A-Z]{2}(?=\s*:)/g));
    }
    return this._validCountryCodes;
  }

  getDiscoveryState() {
    return {
      phase: this._discoveryPhase,
      progress: this._discoveryPhase === 'queuing' ? 30 : this._discoveryPhase === 'processing' ? 50 : 0,
      stations: this.pendingStations.length,
      devices: this.pendingDevices.length,
      message: this.pendingStations.length > 0 || this.pendingDevices.length > 0
        ? `Discovered ${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s)...`
        : '',
    };
  }

  /** Emit a discovery progress event to the UI. */
  _emitProgress(phase, progress, message) {
    this.pushEvent('discoveryProgress', {
      phase,
      progress,
      stations: this.pendingStations.length,
      devices: this.pendingDevices.length,
      message,
    });
  }

  async deleteFileIfExists(filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async resetPersistentData() {
    return this.deleteFileIfExists(this.storagePath + '/persistent.json');
  }

  async resetAccessoryData() {
    return this.deleteFileIfExists(this.storedAccessoriesPath);
  }

  async checkCache() {
    const persistentFile = this.storagePath + '/persistent.json';
    try {
      if (fs.existsSync(persistentFile)) {
        const data = JSON.parse(await fs.promises.readFile(persistentFile, 'utf-8'));
        // Basic validity check: ensure it has some expected content
        if (data && Object.keys(data).length > 0) {
          this.log.debug('Persistent cache file found and valid.');
          return { valid: true };
        }
      }
    } catch (error) {
      this.log.warn('Error checking persistent cache: ' + error);
    }
    return { valid: false };
  }

  async login(options) {
    clearTimeout(this._loginTimeout);

    // Block login if the plugin is already running (accessories updated within 90s)
    if (!this.eufyClient) {
      try {
        if (fs.existsSync(this.storedAccessoriesPath)) {
          const data = JSON.parse(fs.readFileSync(this.storedAccessoriesPath, 'utf-8'));
          if (data?.storedAt) {
            const ageMs = Date.now() - new Date(data.storedAt).getTime();
            if (ageMs < 90_000) {
              this.log.warn('Plugin heartbeat is fresh — blocking UI login to avoid duplicate eufy client. Please stop and wait 90sec before trying again!');
              this.pushEvent('authError', {
                message: 'The plugin is currently running. Please stop it before logging in from the UI. Please stop and wait 90sec before trying again!',
              });
              return { success: false, pluginRunning: true };
            }
          }
        }
      } catch (error) {
        this.log.debug('Heartbeat check failed (non-blocking): ' + error);
      }
    }

    try {
      if (options && options.username && options.password && !options.reconnect) {
        this.log.info('deleting persistent.json and accessories due to new login');
        // Tear down any existing client so the new device name and credentials take effect
        if (this.eufyClient) {
          this.log.debug('Tearing down previous eufy client before fresh login');
          this.eufyClient.removeAllListeners();
          this.eufyClient.close();
          this.eufyClient = null;
        }
        await this.resetAccessoryData();
        await this.resetPersistentData();
      } else if (options && options.reconnect) {
        this.log.info('Reconnecting using persistent cache (skipping data reset)');
      }
    } catch (error) {
      this.log.error('Could not delete persistent.json due to error: ' + error);
    }

    if (!this.eufyClient && options && options.username && options.password && options.country) {
      this._clearAllTimers();
      this.stations = [];
      this.pendingStations = [];
      this.pendingDevices = [];
      this._discoveryPhase = 'authenticating';
      this.log.debug('init eufyClient');

      // Validate country code
      const country = typeof options.country === 'string' ? options.country.trim().toUpperCase() : '';
      if (!this._getValidCountryCodes().has(country)) {
        const raw = typeof options.country === 'object' ? JSON.stringify(options.country) : String(options.country);
        this.log.warn(`Invalid country code received: ${raw} — falling back to login.`);
        this.pushEvent('authError', { message: `Invalid country code "${raw}". Please select a valid country and try again.` });
        this._discoveryPhase = 'idle';
        return { success: false };
      }

      this.config.username = options.username;
      this.config.password = options.password;
      this.config.country = country;
      this.config.trustedDeviceName = (typeof options.deviceName === 'string' && options.deviceName.trim()) || this.config.trustedDeviceName;
      try {
        this.eufyClient = await EufySecurity.initialize(this.config, this.tsLog);
        this.eufyClient?.on('station added', this._onStationDiscovered.bind(this));
        this.eufyClient?.on('device added', this._onDeviceDiscovered.bind(this));
        this.eufyClient?.on('push connect', () => this.log.debug('Push Connected!'));
        this.eufyClient?.on('push close', () => this.log.debug('Push Closed!'));
        this.eufyClient?.on('connect', () => this.log.debug('Connected!'));
        this.eufyClient?.on('close', () => this.log.debug('Closed!'));
      } catch (error) {
        this.log.error(error);
        this.pushEvent('authError', { message: `Initialization failed: ${error.message || error}` });
        this._discoveryPhase = 'idle';
        return { success: false };
      }
    }

    // Timeout — fire authError event after 25s if nothing else resolved
    this._loginTimeout = setTimeout(() => {
      this.pushEvent('authError', { message: 'Authentication timed out. Please try again.' });
    }, 25 * 1000);

    if (options && options.username && options.password && options.country) {
      this.log.debug('login with credentials');
      try {
        this._registerOneTimeAuthHandlers();
        this.eufyClient?.connect()
          .then(() => this.log.debug('connected?: ' + this.eufyClient?.isConnected()))
          .catch((error) => this.log.error(error));
      } catch (error) {
        this.log.error(error);
        clearTimeout(this._loginTimeout);
        this.pushEvent('authError', { message: 'Login error: ' + (error.message || error) });
      }
    } else if (options && options.verifyCode) {
      this.log.debug('login with TFA code');
      this._emitProgress('authenticating', 10, 'Verifying TFA code...');
      try {
        this._registerOneTimeAuthHandlers();
        this.eufyClient?.connect({ verifyCode: options.verifyCode, force: false })
          .then(() => this.log.debug('TFA connect resolved, connected?: ' + this.eufyClient?.isConnected()))
          .catch((error) => {
            this.log.error('TFA connect error: ' + error);
            clearTimeout(this._loginTimeout);
            this.pushEvent('authError', { message: 'TFA verification failed: ' + (error.message || error) });
          });
      } catch (error) {
        clearTimeout(this._loginTimeout);
        this.pushEvent('authError', { message: 'TFA verification error: ' + (error.message || error) });
      }
    } else if (options && options.captcha) {
      this.log.debug('login with captcha');
      this._emitProgress('authenticating', 10, 'Verifying captcha...');
      try {
        this._registerOneTimeAuthHandlers();
        this.eufyClient?.connect({ captcha: { captchaCode: options.captcha.captchaCode, captchaId: options.captcha.captchaId }, force: false })
          .then(() => this.log.debug('Captcha connect resolved, connected?: ' + this.eufyClient?.isConnected()))
          .catch((error) => {
            this.log.error('Captcha connect error: ' + error);
            clearTimeout(this._loginTimeout);
            this.pushEvent('authError', { message: 'Captcha verification failed: ' + (error.message || error) });
          });
      } catch (error) {
        clearTimeout(this._loginTimeout);
        this.pushEvent('authError', { message: 'Captcha verification error: ' + (error.message || error) });
      }
    } else {
      clearTimeout(this._loginTimeout);
      this.pushEvent('authError', { message: 'Unsupported login method.' });
    }

    // Resolve immediately — all outcomes are delivered via push events
    return { pending: true };
  }

  /** Register once-only auth event handlers (TFA, captcha, connect) on the eufy client. */
  _registerOneTimeAuthHandlers() {
    this.eufyClient?.once('tfa request', () => {
      clearTimeout(this._loginTimeout);
      this.pushEvent('tfaRequest', {});
    });
    this.eufyClient?.once('captcha request', (id, captcha) => {
      clearTimeout(this._loginTimeout);
      this.pushEvent('captchaRequest', { id, captcha });
    });
    this.eufyClient?.once('connect', () => {
      clearTimeout(this._loginTimeout);
      if (this.adminAccountUsed) {
        return;
      }
      this.pushEvent('authSuccess', {});
      this._emitProgress('authenticating', 15, 'Authenticated — waiting for devices...');
      this._startDiscoveryInactivityTimer();
    });
  }

  /** Start a timer that gives up on device discovery after DISCOVERY_INACTIVITY_SEC seconds. */
  _startDiscoveryInactivityTimer() {
    if (this.pendingStations.length > 0 || this.pendingDevices.length > 0) {
      this.log.debug('Devices already discovered before connect event — skipping inactivity timeout');
      return;
    }
    this._clearDiscoveryInactivityTimer();
    const totalSec = UiServer.DISCOVERY_INACTIVITY_SEC;
    const start = Date.now();

    this._discoveryInactivityTickInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const remaining = Math.max(0, totalSec - elapsed);
      const pct = Math.min(95, 15 + Math.floor((elapsed / totalSec) * 80));
      this._emitProgress('waitingForDevices', pct, `Authenticated — waiting for devices... ${remaining}s`);
    }, 1000);

    this._discoveryInactivityTimeout = setTimeout(() => {
      clearInterval(this._discoveryInactivityTickInterval);
      this._discoveryInactivityTickInterval = null;
      this.log.warn(
        `No stations or devices discovered within ${totalSec}s after authentication. ` +
        'The account may have no devices or the guest invitation has not been accepted yet.',
      );
      this._discoveryPhase = 'done';
      this.stations = [];
      try {
        this.storeAccessories();
      } catch (error) {
        this.log.error('Error storing empty accessories:', error);
      }
      this._emitProgress('done', 100, 'No devices found.');
      this.pushEvent('addAccessory', { stations: [], noDevices: true });
      this.eufyClient?.removeAllListeners();
      this.eufyClient?.close();
    }, totalSec * 1000);
  }

  /** Return true if the station's account is the main admin (not a guest admin). */
  _isMainAdminAccount(station) {
    const rawStation = station.getRawStation();
    return rawStation.member.member_type !== UserType.ADMIN;
  }

  /** Abort login: tear down client, cancel timers, notify UI, and reset plugin storage. */
  _abortNonGuestAdminLogin() {
    this.adminAccountUsed = true;
    this._clearAllTimers();
    this.eufyClient?.removeAllListeners();
    this.eufyClient?.close();
    this.pushEvent('AdminAccountUsed', true);
    this.resetPlugin();
    this.log.error(`
      #########################
      ######### ERROR #########
      #########################
      You're not using a guest admin account with this plugin! You must use a guest admin account!
      Please look here for more details: 
      https://github.com/homebridge-plugins/homebridge-eufy-security/wiki/Create-a-dedicated-admin-account-for-Homebridge-Eufy-Security-Plugin
      #########################
    `);
  }

  /** Clear all pending timers (login, processing, close, debounce tick, discovery inactivity). */
  _clearAllTimers() {
    clearTimeout(this._loginTimeout);
    this._loginTimeout = null;
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }
    if (this._closeTimeout) {
      clearTimeout(this._closeTimeout);
      this._closeTimeout = null;
    }
    if (this._debounceTickInterval) {
      clearInterval(this._debounceTickInterval);
      this._debounceTickInterval = null;
    }
    this._clearDiscoveryInactivityTimer();
  }

  /** Clear the post-auth discovery inactivity timer. */
  _clearDiscoveryInactivityTimer() {
    if (this._discoveryInactivityTickInterval) {
      clearInterval(this._discoveryInactivityTickInterval);
      this._discoveryInactivityTickInterval = null;
    }
    if (this._discoveryInactivityTimeout) {
      clearTimeout(this._discoveryInactivityTimeout);
      this._discoveryInactivityTimeout = null;
    }
  }

  /** Parse a semver string (e.g. '4.4.2-beta.18') into [major, minor, patch]. */
  _parseSemver(ver) {
    return (ver || '0.0.0').replace(/-.*$/, '').split('.').map(Number);
  }

  async loadStoredAccessories() {
    try {
      if (!fs.existsSync(this.storedAccessoriesPath)) {
        this.log.debug('Stored accessories file does not exist.');
        return [];
      }

      const storedData = await fs.promises.readFile(this.storedAccessoriesPath, { encoding: 'utf-8' });
      const { version: storedVersion, storedAt, stations: storedAccessories } = JSON.parse(storedData);

      // --- Cache age check (30 days) ---
      if (storedAt) {
        const ageMs = Date.now() - new Date(storedAt).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        if (ageDays >= 30) {
          this.pushEvent('cacheWarning', { reason: 'stale', ageDays });
          this.log.warn(`Stored accessories are ${ageDays} days old. User should re-login to refresh.`);
        }
      }

      // --- Version branch check ---
      if (storedVersion && storedVersion !== LIB_VERSION) {
        const [curMajor, curMinor] = this._parseSemver(LIB_VERSION);
        const [stoMajor, stoMinor] = this._parseSemver(storedVersion);

        if (curMajor !== stoMajor || curMinor !== stoMinor) {
          // Different minor (or major) branch → force re-login
          this.pushEvent('cacheWarning', {
            reason: 'versionForce',
            currentVersion: LIB_VERSION,
            storedVersion,
          });
          this.log.warn(`Stored version (${storedVersion}) is on a different branch than current (${LIB_VERSION}). Forcing re-login.`);
          return { stations: [], storedAt: null }; // Return empty to force login flow
        } else {
          // Same minor branch, different patch → soft warning
          this.pushEvent('cacheWarning', {
            reason: 'versionWarn',
            currentVersion: LIB_VERSION,
            storedVersion,
          });
          this.log.warn(`Stored version (${storedVersion}) differs from current (${LIB_VERSION}) but same branch. Consider re-login.`);
        }
      }

      return { stations: storedAccessories, storedAt: storedAt || null };
    } catch (error) {
      this.log.error('Could not get stored accessories. Most likely no stored accessories yet: ' + error);
      return { stations: [], storedAt: null };
    }
  }

  async _onStationDiscovered(station) {
    if (this.adminAccountUsed) {
      return;
    }

    if (this._isMainAdminAccount(station)) {
      this._abortNonGuestAdminLogin();
      return;
    }

    this._clearDiscoveryInactivityTimer();
    this.pendingStations.push(station);
    this.log.debug(`${station.getName()}: Station queued for processing`);
    this._discoveryPhase = 'queuing';
    this._emitProgress('queuing', 30, `Discovered ${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s)...`);
    this._restartDiscoveryDebounce();
  }

  async _onDeviceDiscovered(device) {
    if (this.adminAccountUsed) {
      this.pushEvent('AdminAccountUsed', true);
      return;
    }

    const deviceType = device.getDeviceType();
    if (Device.isKeyPad(deviceType)) {
      this.log.warn(`${device.getName()}: The keypad is ignored as it serves no purpose in this plugin. You can ignore this message.`);
      return;
    }

    this._clearDiscoveryInactivityTimer();
    this.pendingDevices.push(device);
    this.log.debug(`${device.getName()}: Device queued for processing`);
    this._discoveryPhase = 'queuing';
    this._emitProgress('queuing', 30, `Discovered ${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s)...`);
    this._restartDiscoveryDebounce();
  }

  /** Restart the debounce timer — processing fires after DISCOVERY_DEBOUNCE_SEC of silence. */
  _restartDiscoveryDebounce() {
    this._clearAllTimers();
    const delaySec = UiServer.DISCOVERY_DEBOUNCE_SEC;
    this.log.debug(
      `Discovery debounce reset — will process in ${delaySec}s if no more devices arrive ` +
      `(${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s) queued)`,
    );

    // Tick progress from 30 → 95 during the debounce wait
    const debounceStart = Date.now();
    this._debounceTickInterval = setInterval(() => {
      const elapsed = (Date.now() - debounceStart) / 1000;
      const pct = Math.min(95, 30 + Math.floor((elapsed / delaySec) * 65));
      const remaining = Math.max(0, Math.ceil(delaySec - elapsed));
      this._emitProgress('queuing', pct, `Discovered ${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s) — waiting for more... ${remaining}s`);
    }, 1000);

    this.processingTimeout = setTimeout(() => {
      clearInterval(this._debounceTickInterval);
      this._debounceTickInterval = null;
      this._processPendingAccessories().catch(error => this.log.error('Error processing pending accessories:', error));
    }, delaySec * 1000);
    // Close connection after processing + potential 2-min unsupported intel wait
    const closeAfterSec = delaySec + (UNSUPPORTED_INTEL_WAIT_MS / 1000) + 15;
    this._closeTimeout = setTimeout(() => {
      this.eufyClient?.removeAllListeners();
      this.eufyClient?.close();
    }, closeAfterSec * 1000);
  }

  /** Process all queued stations and devices after the debounce window closes. */
  async _processPendingAccessories() {
    this.log.debug(`Processing ${this.pendingStations.length} stations and ${this.pendingDevices.length} devices`);

    this._discoveryPhase = 'processing';
    this._emitProgress('processing', 95, `Processing ${this.pendingStations.length} station(s) and ${this.pendingDevices.length} device(s)...`);

    if (this.pendingStations.length === 0 || this.pendingDevices.length === 0) {
      this.log.warn(
        `Discovery finished with ${this.pendingStations.length} station(s) and ${this.pendingDevices.length} device(s). ` +
        'If this is unexpected, please verify your Eufy account has devices and the credentials used are for a guest admin account.',
      );
    }

    // Collect unsupported items (exclude hub/base station types that aren't in DeviceProperties)
    const unsupportedItems = [];

    for (const station of this.pendingStations) {
      try {
        const st = station.getDeviceType();
        if (!Device.isStation(st) && !Device.isSupported(st)) unsupportedItems.push(station);
      } catch (e) { /* ignore */ }
    }
    for (const device of this.pendingDevices) {
      try {
        if (!Device.isSupported(device.getDeviceType())) unsupportedItems.push(device);
      } catch (e) { /* ignore */ }
    }

    // Wait for raw data on unsupported items (user can skip via /skipIntelWait)
    if (unsupportedItems.length > 0) {
      const names = unsupportedItems.map(i => `${i.getName()} (type ${i.getDeviceType()})`).join(', ');
      this._skipIntelWait = false;

      this.pushEvent('discoveryWarning', {
        unsupportedCount: unsupportedItems.length,
        unsupportedNames: names,
        waitSeconds: UNSUPPORTED_INTEL_WAIT_MS / 1000,
        message: `${unsupportedItems.length} unsupported device(s) detected: ${names}`,
      });

      this.log.info(`Unsupported intel: waiting up to ${UNSUPPORTED_INTEL_WAIT_MS / 1000}s for raw data (user can skip)`);

      // Poll every second, ticking progress 50 → 95
      const pollMs = 1000;
      let waited = 0;
      while (waited < UNSUPPORTED_INTEL_WAIT_MS && !this._skipIntelWait) {
        await delay(pollMs);
        waited += pollMs;
        const pct = Math.min(95, 50 + Math.floor((waited / UNSUPPORTED_INTEL_WAIT_MS) * 45));
        const remaining = Math.max(0, Math.ceil((UNSUPPORTED_INTEL_WAIT_MS - waited) / 1000));
        this._emitProgress('unsupportedWait', pct, `Collecting data for ${unsupportedItems.length} unsupported device(s)... ${remaining}s`);
      }

      if (this._skipIntelWait) {
        this.log.info(`Unsupported intel wait skipped by user after ${waited / 1000}s`);
      } else {
        this.log.info(`Unsupported intel wait completed (${waited / 1000}s)`);
      }
    }

    this._emitProgress('buildingStations', 96, 'Building station list...');

    // Process queued stations
    for (const station of this.pendingStations) {
      const stationType = station.getDeviceType();
      const stationSerial = station.getSerial();

      const s = {
        uniqueId: stationSerial,
        displayName: station.getName(),
        type: stationType,
        typename: DeviceType[stationType],
        disabled: false,
        devices: [],
        properties: station.getProperties(),
        unsupported: false,
      };

      try {
        delete s.properties.picture;
      } catch (error) {
        // ignore
      }

      s.ignored = (this.config['ignoreStations'] ?? []).includes(s.uniqueId);

      // Pre-compute power info for the UI
      s.power = this._computePower(s.properties);

      if (!Device.isStation(stationType)) {
        // Not a hub/base station — the station IS a standalone device (station.type == device.type)

        if (!Device.isSupported(stationType)) {
          // Device type not recognized by eufy-security-client — truly unsupported
          s.unsupported = true;

          this.log.warn(`Station "${station.getName()}" (type ${stationType}) is not supported by eufy-security-client`);

          // Immediately add the unsupported station and skip further processing
          this.stations.push(s);
          continue;
        } else {
          // Check if the matching device was emitted by the client
          const hasMatchingDevice = this.pendingDevices.some(d => d.getSerial() === stationSerial);

          if (hasMatchingDevice) {
            s.standalone = true;
            s.disabled = true; // No separate station card; settings accessible via device card

            // Standalone Locks, Doorbells and SmartDrops don't have Security Control
            if (Device.isLock(s.type) || Device.isDoorbell(s.type) || Device.isSmartDrop(s.type)) {
              s.noSecurityControl = true;
            }
          } else {
            // Station exists but no device counterpart was emitted — unsupported
            s.unsupported = true;
            this.log.warn(`Station "${station.getName()}" (${DeviceType[stationType]}) has no matching device and will be marked as unsupported`);

            // Short-circuit processing for unsupported station
            this.stations.push(s);
            continue;
          }
        }
      }

      this.stations.push(s);
    }

    this._emitProgress('buildingDevices', 98, 'Building device list...');

    // Process queued devices and attach them to stations
    for (const device of this.pendingDevices) {
      const devType = device.getDeviceType();

      const d = {
        uniqueId: device.getSerial(),
        displayName: device.getName(),
        type: devType,
        typename: DeviceType[devType],
        standalone: device.getSerial() === device.getStationSerial(),
        hasBattery: device.hasBattery(),
        isCamera: device.isCamera() || Device.isLockWifiVideo(devType),
        isDoorbell: device.isDoorbell(),
        isKeypad: device.isKeyPad(),
        isMotionSensor: Device.isMotionSensor(devType),
        isEntrySensor: Device.isEntrySensor(devType),
        isLock: Device.isLock(devType),
        isSmartDrop: Device.isSmartDrop(devType),
        supportsRTSP: device.hasPropertyValue(PropertyName.DeviceRTSPStream),
        supportsTalkback: device.hasCommand(CommandName.DeviceStartTalkback),
        DeviceEnabled: device.hasProperty(PropertyName.DeviceEnabled),
        DeviceMotionDetection: device.hasProperty(PropertyName.DeviceMotionDetection),
        DeviceLight: device.hasProperty(PropertyName.DeviceLight),
        DeviceChimeIndoor: device.hasProperty(PropertyName.DeviceChimeIndoor),
        disabled: false,
        properties: device.getProperties(),
        unsupported: false,
      };

      // Mark device as unsupported if eufy-security-client doesn't recognize this device type
      if (!Device.isSupported(devType)) {
        d.unsupported = true;
      }

      // Pre-compute power info for the UI
      d.power = this._computePower(d.properties);

      try {
        delete d.properties.picture;
      } catch (error) {
        this.log.error(error);
      }

      d.ignored = (this.config['ignoreDevices'] ?? []).includes(d.uniqueId);

      const stationUniqueId = device.getStationSerial();
      const stationIndex = this.stations.findIndex(station => station.uniqueId === stationUniqueId);

      if (stationIndex !== -1) {
        // If parent station is unsupported, propagate flag to device
        if (this.stations[stationIndex].unsupported) {
          d.unsupported = true;
        }

        if (!this.stations[stationIndex].devices) {
          this.stations[stationIndex].devices = [];
        }
        this.stations[stationIndex].devices.push(d);
      } else {
        this.log.error('Station not found for device:', d.displayName);
      }
    }

    // Write unsupported.json with raw device intel for triage (before clearing pending queues)
    try {
      this.storeUnsupportedDevices(this.pendingStations, this.pendingDevices);
    } catch (error) {
      this.log.error('Error storing unsupported devices:', error);
    }

    // Clear pending queues
    this.pendingStations = [];
    this.pendingDevices = [];

    // Always send the final list to the UI, even if empty
    try {
      this.storeAccessories();
    } catch (error) {
      this.log.error('Error storing accessories:', error);
    }

    this._emitProgress('done', 100, 'Discovery complete!');

    this.pushEvent('addAccessory', { stations: this.stations, extendedDiscovery: unsupportedItems.length > 0 });
  }

  /** Persist discovered stations/devices to accessories.json. */
  storeAccessories() {
    fs.mkdirSync(this.storagePath, { recursive: true });
    const dataToStore = { version: LIB_VERSION, storedAt: new Date().toISOString(), stations: this.stations };
    fs.writeFileSync(this.storedAccessoriesPath, JSON.stringify(dataToStore));
  }

  // ── Sensitive-field redaction ──────────────────────────────────────────────

  /** Keys whose string values are partially masked before persisting to unsupported.json. */
  static SENSITIVE_KEYS = new Map([
    // Serial numbers — keep model prefix (e.g. T8170)
    ['station_sn',        [5, 0]],
    ['device_sn',         [5, 0]],

    // Network / connectivity
    ['wifi_ssid',         [3, 0]],
    ['wifi_mac',          [4, 0]],
    ['ip_addr',           [3, 0]],
    ['local_ip',          [3, 0]],

    // Hardware identifiers
    ['cpuid',             [4, 0]],

    // P2P identifiers & key-exchange material
    ['p2p_did',           [7, 0]],
    ['push_did',          [7, 0]],
    ['ndt_did',           [7, 0]],
    ['query_server_did',  [7, 0]],
    ['p2p_conn',          [4, 0]],
    ['app_conn',          [4, 0]],
    ['p2p_license',       [2, 0]],
    ['push_license',      [2, 0]],
    ['ndt_license',       [2, 0]],
    ['wakeup_key',        [4, 0]],
    ['dsk_key',           [4, 0]],
    ['setup_code',        [2, 0]],
    ['setup_id',          [2, 0]],

    // User / account identifiers
    ['account_id',        [4, 0]],
    ['admin_user_id',     [4, 0]],
    ['member_user_id',    [4, 0]],
    ['action_user_id',    [4, 0]],
    ['short_user_id',     [4, 0]],
    ['email',             [3, 0]],
    ['action_user_email', [3, 0]],
    ['member_nick',       [3, 0]],
    ['nick_name',         [3, 0]],
    ['action_user_name',  [3, 0]],
    ['avatar',            [0, 0]],
    ['member_avatar',     [0, 0]],

    // House / location
    ['house_id',          [4, 0]],

    // Misc identifiers
    ['volume',            [6, 0]],
  ]);

  /**
   * Partially mask a string value, keeping the first `keepStart` and last
   * `keepEnd` characters visible.  Returns the original if it is empty or
   * too short to meaningfully mask.
   */
  static _partialMask(value, keepStart, keepEnd) {
    if (typeof value !== 'string' || !value) return value;
    const minLen = keepStart + keepEnd + 1;
    if (value.length <= minLen) return value.length <= 2 ? '***' : value[0] + '***';
    return value.slice(0, keepStart) + '***' + (keepEnd > 0 ? value.slice(-keepEnd) : '');
  }

  /**
   * Deep-walk an object and partially redact every value whose key appears
   * in SENSITIVE_KEYS.  Returns a new object — the original is not mutated.
   */
  static _redactSensitiveFields(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => UiServer._redactSensitiveFields(item));
    }
    if (obj !== null && typeof obj === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(obj)) {
        const rule = UiServer.SENSITIVE_KEYS.get(key);
        if (rule && typeof val === 'string') {
          out[key] = UiServer._partialMask(val, rule[0], rule[1]);
        } else if (typeof val === 'object' && val !== null) {
          out[key] = UiServer._redactSensitiveFields(val);
        } else {
          out[key] = val;
        }
      }
      return out;
    }
    return obj;
  }

  // ── Unsupported device storage ──────────────────────────────────────────

  /** Collect raw intel for unsupported devices/stations and write to unsupported.json. */
  storeUnsupportedDevices(pendingStations, pendingDevices) {
    const unsupportedEntries = [];

    // Collect unsupported standalone stations
    for (const station of pendingStations) {
      const stationType = station.getDeviceType();
      if (!Device.isStation(stationType) && !Device.isSupported(stationType)) {
        unsupportedEntries.push(this._buildUnsupportedStationEntry(station));
      }
    }

    // Collect unsupported devices
    for (const device of pendingDevices) {
      if (!Device.isSupported(device.getDeviceType())) {
        unsupportedEntries.push(this._buildUnsupportedDeviceEntry(device));
      }
    }

    fs.mkdirSync(this.storagePath, { recursive: true });

    const dataToStore = { version: LIB_VERSION, storedAt: new Date().toISOString(), devices: unsupportedEntries };
    fs.writeFileSync(this.unsupportedPath, JSON.stringify(dataToStore));
    this.log.debug(`Persisted ${unsupportedEntries.length} unsupported device(s) to unsupported.json`);
  }

  /** Build a triage-ready intel object for an unsupported device. */
  _buildUnsupportedDeviceEntry(device) {
    const rawDevice = device.getRawDevice ? device.getRawDevice() : {};
    const rawProps = device.getRawProperties ? device.getRawProperties() : {};

    const wifiSsid = rawDevice.wifi_ssid || undefined;
    const localIp = rawDevice.ip_addr || rawDevice.local_ip || undefined;

    return {
      uniqueId: device.getSerial(),
      displayName: device.getName(),
      type: device.getDeviceType(),
      typename: DeviceType[device.getDeviceType()] || undefined,
      stationSerialNumber: device.getStationSerial(),
      model: rawDevice.device_model,
      hardwareVersion: rawDevice.main_hw_version,
      softwareVersion: rawDevice.main_sw_version,
      wifiSsid: wifiSsid ? UiServer._partialMask(wifiSsid, 3, 0) : undefined,
      localIp: localIp ? UiServer._partialMask(localIp, 3, 0) : undefined,
      rawDevice: UiServer._redactSensitiveFields(rawDevice),
      rawProperties: rawProps,
    };
  }

  /** Build a triage-ready intel object for an unsupported standalone station. */
  _buildUnsupportedStationEntry(station) {
    const rawStation = station.getRawStation ? station.getRawStation() : {};
    const rawProps = station.getRawProperties ? station.getRawProperties() : {};

    const wifiSsid = rawStation.wifi_ssid || undefined;
    const localIp = rawStation.ip_addr || undefined;

    return {
      uniqueId: station.getSerial(),
      displayName: station.getName(),
      type: station.getDeviceType(),
      typename: DeviceType[station.getDeviceType()] || undefined,
      stationSerialNumber: station.getSerial(),
      model: rawStation.station_model,
      hardwareVersion: rawStation.main_hw_version,
      softwareVersion: rawStation.main_sw_version,
      wifiSsid: wifiSsid ? UiServer._partialMask(wifiSsid, 3, 0) : undefined,
      localIp: localIp ? UiServer._partialMask(localIp, 3, 0) : undefined,
      rawDevice: UiServer._redactSensitiveFields(rawStation),
      rawProperties: rawProps,
    };
  }

  /** Load unsupported device intel from disk. */
  async loadUnsupportedDevices() {
    try {
      if (!fs.existsSync(this.unsupportedPath)) {
        return { devices: [] };
      }
      const data = JSON.parse(await fs.promises.readFile(this.unsupportedPath, 'utf-8'));
      return { devices: data.devices || [] };
    } catch (error) {
      this.log.error('Could not load unsupported devices: ' + error);
      return { devices: [] };
    }
  }

  async resetPlugin() {
    try {
      fs.rmSync(this.storagePath, { recursive: true, force: true });
      return { result: 1 };
    } catch (error) {
      this.log.error('Could not reset plugin: ' + error);
      return { result: 0 };
    }
  }

  async getLogFiles() {
    const files = await fs.promises.readdir(this.storagePath);

    const logFiles = files.filter(file => {
      return file.endsWith('.log') || file.endsWith('.log.gz');
    });

    const nonEmptyLogFiles = await Promise.all(logFiles.map(async file => {
      const filePath = path.join(this.storagePath, file);
      const stats = await fs.promises.stat(filePath);
      if (stats.size > 0) {
        return file;
      }
      return null;
    }));

    return nonEmptyLogFiles.filter(file => file !== null);
  }

  async downloadDiagnostics(options = {}) {
    const skipEncryption = !!options.skipEncryption;

    // Rate-limit: one download per DIAGNOSTICS_COOLDOWN_MS
    const now = Date.now();
    const elapsed = now - this._lastDiagnosticsTime;
    if (elapsed < UiServer.DIAGNOSTICS_COOLDOWN_MS) {
      const waitSec = Math.ceil((UiServer.DIAGNOSTICS_COOLDOWN_MS - elapsed) / 1000);
      throw new Error(`Please wait ${waitSec}s before downloading diagnostics again.`);
    }
    this._lastDiagnosticsTime = now;

    this.pushEvent('diagnosticsProgress', { progress: 10, status: 'Collecting log files' });
    const finalLogFiles = await this.getLogFiles();

    this.pushEvent('diagnosticsProgress', { progress: 30, status: 'Collecting diagnostic files' });
    const filesToArchive = [...finalLogFiles];

    // Include accessories.json for diagnostics
    if (fs.existsSync(this.storedAccessoriesPath)) {
      filesToArchive.push(path.basename(this.storedAccessoriesPath));
    }

    // Include unsupported.json for diagnostics
    if (fs.existsSync(this.unsupportedPath)) {
      filesToArchive.push(path.basename(this.unsupportedPath));
    }

    this.pushEvent('diagnosticsProgress', { progress: 40, status: 'Checking archive content' });
    if (filesToArchive.length === 0) {
      throw new Error('No diagnostic files were found');
    }

    try {
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
      const archiveName = `diagnostics-${timestamp}.tar.gz`;

      this.pushEvent('diagnosticsProgress', { progress: 45, status: `Compressing ${filesToArchive.length} files` });

      // Snapshot files to a temp directory before archiving.
      // Log files are actively written to — reading them directly with tar
      // causes "did not encounter expected EOF" when file size changes mid-read.

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eufy-diag-'));
      let fileBuffer;
      try {
        await Promise.all(filesToArchive.map((file) =>
          fs.promises.copyFile(
            path.join(this.storagePath, file),
            path.join(tmpDir, file),
          ),
        ));

        const tarStream = tarCreate({ gzip: true, cwd: tmpDir }, filesToArchive);
        const chunks = [];
        for await (const chunk of tarStream) {
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
      } finally {
        fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }

      if (skipEncryption) {
        this.pushEvent('diagnosticsProgress', { progress: 90, status: 'Returning plain archive' });
        return { buffer: fileBuffer, filename: archiveName };
      }

      this.pushEvent('diagnosticsProgress', { progress: 80, status: 'Encrypting archive' });
      const encryptedBuffer = encryptDiagnostics(fileBuffer);

      this.pushEvent('diagnosticsProgress', { progress: 90, status: 'Returning encrypted archive' });
      return { buffer: encryptedBuffer, filename: archiveName };
    } catch (error) {
      this.log.error('Error while generating diagnostics archive: ' + error);
      throw error;
    }
  }

  async cleanStorage() {
    const preserved = new Set([
      'accessories.json',
      'persistent.json',
      'eufy-security.log',
      'eufy-lib.log',
      'ffmpeg.log',
      'configui-server.log',
      'configui-lib.log',
    ]);
    const entries = await fs.promises.readdir(this.storagePath, { withFileTypes: true });
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile() || preserved.has(entry.name)) continue;
      const filePath = path.join(this.storagePath, entry.name);
      try {
        await fs.promises.unlink(filePath);
        deleted++;
        this.log.debug(`Deleted: ${entry.name}`);
      } catch (error) {
        this.log.warn(`Failed to delete ${entry.name}: ${error}`);
      }
    }
    this.log.info(`Cleaned ${deleted} file(s)`);
    return { deleted };
  }

  async getSystemInfo() {

    let homebridgeVersion = 'unknown';
    try {
      const hbPkg = require('homebridge/package.json');
      homebridgeVersion = hbPkg.version;
    } catch {
      // Homebridge package not resolvable from here
    }

    let deviceSummary = [];
    try {
      if (fs.existsSync(this.storedAccessoriesPath)) {
        const storedData = JSON.parse(fs.readFileSync(this.storedAccessoriesPath, 'utf-8'));
        if (storedData.stations) {
          deviceSummary = storedData.stations.map(s => ({
            name: s.displayName,
            type: s.typename,
            devices: (s.devices || []).map(d => ({
              name: d.displayName,
              type: d.typename,
            })),
          }));
        }
      }
    } catch {
      // ignore
    }

    this.log.debug('System info requested by UI');

    return {
      pluginVersion: LIB_VERSION,
      eufyClientVersion: libVersion,
      homebridgeVersion,
      nodeVersion: process.version,
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      devices: deviceSummary,
    };
  }

  /** Resolve and validate a recording filename, returning the absolute path. */
  _resolveRecordingPath(filename) {
    if (!filename || typeof filename !== 'string') {
      throw new Error('Missing or invalid filename parameter.');
    }
    const recordingsDir = path.join(this.storagePath, 'recordings');
    const sanitized = path.basename(filename);
    if (!sanitized.endsWith('.mp4')) {
      throw new Error('Invalid filename.');
    }
    const resolved = path.resolve(path.join(recordingsDir, sanitized));
    if (!resolved.startsWith(path.resolve(recordingsDir))) {
      throw new Error('Invalid filename.');
    }
    return resolved;
  }

  /**
   * List all debug recording files available for download.
   */
  async listDebugRecordings() {
    const recordingsDir = path.join(this.storagePath, 'recordings');
    try {
      if (!fs.existsSync(recordingsDir)) {
        return { recordings: [] };
      }
      const files = fs.readdirSync(recordingsDir)
        .filter(f => f.endsWith('.mp4'))
        .map(filename => {
          const filePath = path.join(recordingsDir, filename);
          try {
            const stats = fs.statSync(filePath);
            // Parse filename: <serial>_<timestamp>_<type>.mp4
            // Types: hksv, livestream (current), raw, processed (legacy)
            const match = filename.match(/^([A-Za-z0-9_-]+?)_(\d{4}-\d{2}-\d{2}T[\d-]+Z?)(?:_(hksv|livestream|raw|processed))?\.mp4$/);
            const rawType = match && match[3] ? match[3] : 'processed';
            // Normalize legacy 'raw' → 'livestream'
            const type = rawType === 'raw' ? 'livestream' : rawType;
            return {
              filename,
              serial: match ? match[1] : 'unknown',
              timestamp: match ? match[2] : '',
              type,
              sizeBytes: stats.size,
              sizeMB: (stats.size / (1024 * 1024)).toFixed(1),
              createdAt: stats.mtimeMs,
              createdAtISO: new Date(stats.mtimeMs).toISOString(),
            };
          } catch {
            return null;
          }
        })
        .filter(f => f !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
      return { recordings: files };
    } catch (error) {
      this.log.error('Error listing debug recordings: ' + error);
      throw error;
    }
  }

  /**
   * Download a debug recording file in chunks to avoid memory spikes.
   * Request: { filename: string, offset?: number, chunkSize?: number }
   * Returns: { data: Buffer (base64), totalSize: number, offset: number, chunkSize: number, done: boolean }
   */
  async downloadDebugRecording(options = {}) {
    const { filename, offset: rawOffset = 0, chunkSize: rawChunkSize = 256 * 1024 } = options;
    const resolved = this._resolveRecordingPath(filename);

    // Coerce and clamp parameters
    const numOffset = Number(rawOffset) || 0;
    if (numOffset < 0) throw new Error('Invalid offset.');
    const MAX_CHUNK = 2 * 1024 * 1024; // 2 MB
    const numChunkSize = Math.min(Number(rawChunkSize) || 256 * 1024, MAX_CHUNK);

    if (!fs.existsSync(resolved)) {
      throw new Error('Recording file not found.');
    }

    const stats = fs.statSync(resolved);
    const totalSize = stats.size;
    const readSize = Math.min(numChunkSize, totalSize - numOffset);

    if (numOffset >= totalSize || readSize <= 0) {
      return { data: null, totalSize, offset: numOffset, chunkSize: 0, done: true };
    }

    const fh = await fs.promises.open(resolved, 'r');
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, numOffset);
    await fh.close();

    const newOffset = numOffset + readSize;

    return {
      data: buf,
      totalSize,
      offset: newOffset,
      chunkSize: readSize,
      done: newOffset >= totalSize,
      filename: path.basename(resolved),
    };
  }

  /**
   * Delete a specific debug recording file.
   */
  async deleteDebugRecording(options = {}) {
    const resolved = this._resolveRecordingPath(options.filename);

    if (!fs.existsSync(resolved)) {
      throw new Error('Recording file not found.');
    }

    fs.unlinkSync(resolved);
    const sanitized = path.basename(resolved);
    this.log.info(`Deleted debug recording: ${sanitized}`);
    return { deleted: true, filename: sanitized };
  }

  /**
   * Delete all debug recording files.
   */
  async deleteAllDebugRecordings() {
    const recordingsDir = path.join(this.storagePath, 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      return { deleted: 0 };
    }

    const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.mp4'));
    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(recordingsDir, file));
        deleted++;
      } catch {
        // ignore individual failures
      }
    }
    this.log.info(`Deleted ${deleted} debug recording(s)`);
    return { deleted };
  }
}

(() => new UiServer())();
