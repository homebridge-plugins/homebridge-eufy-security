/**
 * App — main controller, hash-based SPA router, and global state.
 * Entry point initialized on homebridge 'ready' event.
 */
// eslint-disable-next-line no-unused-vars
const App = {
  /** Global state shared across views */
  state: {
    stations: [],
    cacheDate: null, // ISO string of when accessories were last fetched
    initialized: false,
    nodeVersionWarning: null, // { nodeVersion, affected, acknowledged }
  },

  /** Root container element */
  _root: null,

  /**
   * Initialize the app. Called once on homebridge 'ready' event.
   */
  async init() {
    this._root = document.getElementById('app');

    // Let Homebridge's native Save button handle saving to disk.
    // We call updatePluginConfig() on every change to keep config in sync.

    // Listen for admin account error globally
    Api.onAdminAccountUsed(() => {
      this._showAdminError();
    });

    // Listen for cache warnings (stale data, version mismatch)
    Api.onCacheWarning((data) => {
      switch (data.reason) {
        case 'stale':
          homebridge.toast.warning(
            `Your cached devices are ${data.ageDays} days old. Please re-login to refresh.`,
            'Stale Cache',
          );
          break;
        case 'versionWarn':
          homebridge.toast.warning(
            `Plugin updated (${data.storedVersion} → ${data.currentVersion}). Consider re-logging in to refresh devices.`,
            'Version Updated',
          );
          break;
        case 'versionForce':
          homebridge.toast.error(
            `Plugin version changed significantly (${data.storedVersion} → ${data.currentVersion}). Please re-login.`,
            'Re-login Required',
          );
          this.navigate('login');
          break;
      }
    });

    // Listen for hash changes
    window.addEventListener('hashchange', () => this._onRoute());

    // Determine initial route
    try {
      // Load config without pushing it back to Homebridge
      const config = await Config.load();
      if (!config.platform) {
        // Initialize default config only if truly empty
        await Config.update({ platform: 'EufySecurity', name: 'EufySecurity' });
      }

      const stored = await Api.loadStoredAccessories();
      const stations = stored.stations || stored;
      const cacheDate = stored.storedAt || null;
      if (stations && stations.length > 0) {
        this.state.stations = stations;
        this.state.cacheDate = cacheDate;
        // Check Node.js version for returning users (skipping login)
        await this.checkNodeVersion();
        if (!window.location.hash || window.location.hash === '#/') {
          this.navigate('dashboard');
        } else {
          this._onRoute();
        }
      } else {
        this.navigate('login');
      }
    } catch (e) {
      // No stored accessories — go to login
      this.navigate('login');
    }

    this.state.initialized = true;
  },

  /**
   * Navigate to a route.
   * @param {string} route - e.g. 'login', 'dashboard', 'detail/device/SERIAL', 'settings'
   */
  navigate(route) {
    window.location.hash = '#/' + route;
  },

  /**
   * Handle route changes.
   */
  _onRoute() {
    const hash = window.location.hash.replace('#/', '') || '';
    const parts = hash.split('/');
    const route = parts[0];

    // Clear the root container
    this._root.innerHTML = '';

    switch (route) {
      case 'login':
        homebridge.disableSaveButton();
        LoginView.render(this._root);
        break;

      case 'dashboard':
        homebridge.enableSaveButton();
        DashboardView.render(this._root);
        break;

      case 'detail': {
        homebridge.enableSaveButton();
        const type = parts[1]; // 'device' or 'station'
        const id = parts[2];   // uniqueId
        if (type && id) {
          DeviceDetailView.render(this._root, type, id);
        } else {
          this.navigate('dashboard');
        }
        break;
      }

      case 'unsupported': {
        homebridge.enableSaveButton();
        const uid = parts[1];
        if (uid) {
          UnsupportedDetailView.render(this._root, uid);
        } else {
          this.navigate('dashboard');
        }
        break;
      }

      case 'settings':
        homebridge.enableSaveButton();
        SettingsView.render(this._root);
        break;

      case 'diagnostics':
        homebridge.enableSaveButton();
        DiagnosticsView.render(this._root);
        break;

      case 'recordings':
        homebridge.enableSaveButton();
        RecordingsView.render(this._root);
        break;

      default:
        // Unknown route — try dashboard if we have stations, otherwise login
        if (this.state.stations.length > 0) {
          this.navigate('dashboard');
        } else {
          homebridge.disableSaveButton();
          this.navigate('login');
        }
        break;
    }
  },

  /**
   * Show a blocking error when admin account is detected.
   */
  _showAdminError() {
    this._root.innerHTML = `
      <div class="alert alert-danger alert-admin" role="alert">
        <h5 class="alert-heading">${Helpers.iconHtml('warning.svg')} Admin Account Detected</h5>
        <p>
          You are not using a <strong>dedicated guest admin account</strong>. 
          Using your primary Eufy account can cause conflicts with the Eufy app.
        </p>
        <hr>
        <p class="mb-0">
          Please create a dedicated admin account for this plugin.
          <a href="https://github.com/homebridge-plugins/homebridge-eufy-security/wiki/Create-a-dedicated-admin-account-for-Homebridge-Eufy-Security-Plugin" 
             target="_blank" class="alert-link">
            Follow this guide
          </a>
        </p>
      </div>
    `;
  },

  /**
   * Check if a Node.js version string is affected by the RSA_PKCS1_PADDING removal.
   * Affected: 18.19.1+, 20.11.1+, 21.6.2+, 22.x, 23.x, and 24.x < 24.5.0.
   * Safe: <= 18.19.0, <= 20.11.0, <= 21.6.1, and >= 24.5.0.
   * @param {string} versionStr - e.g. 'v20.18.1'
   * @returns {boolean}
   */
  isNodeVersionAffected(versionStr) {
    const parts = versionStr.replace('v', '').split('.').map(Number);
    const [major, minor, patch] = parts;

    if (major === 18 && (minor > 19 || (minor === 19 && patch >= 1))) return true;
    if (major === 20 && (minor > 11 || (minor === 11 && patch >= 1))) return true;
    if (major === 21 && (minor > 6 || (minor === 6 && patch >= 2))) return true;
    if (major === 22 || major === 23) return true;
    if (major === 24 && (minor < 5)) return true;

    return false;
  },

  /**
   * Fetch the Node.js version from the server and update state.
   */
  async checkNodeVersion() {
    try {
      const info = await Api.getSystemInfo();
      const affected = this.isNodeVersionAffected(info.nodeVersion);
      this.state.nodeVersionWarning = {
        nodeVersion: info.nodeVersion,
        affected,
        acknowledged: false,
      };
    } catch (e) {
      // Silently ignore — non-critical check
    }
  },
};

// ===== Bootstrap the app when Homebridge UI is ready =====
homebridge.addEventListener('ready', () => {
  App.init();
});
