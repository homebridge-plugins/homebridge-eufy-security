/**
 * API service — wraps homebridge.request() and push event listeners.
 * Communicates with server.ts endpoints.
 */
// eslint-disable-next-line no-unused-vars
const Api = {
  /** @private Track registered listeners to prevent stacking on re-render */
  _listeners: {},

  /**
   * Register an event listener, replacing any previous listener for the same event.
   * Prevents listener stacking when views re-render.
   * @param {string} event
   * @param {function} handler
   */
  _on(event, handler) {
    if (this._listeners[event]) {
      homebridge.removeEventListener(event, this._listeners[event]);
    }
    this._listeners[event] = handler;
    homebridge.addEventListener(event, handler);
  },

  /**
   * Remove a previously registered listener for an event.
   * Views can call this on teardown to explicitly detach their callbacks.
   * @param {string} event
   */
  _off(event) {
    if (this._listeners[event]) {
      homebridge.removeEventListener(event, this._listeners[event]);
      delete this._listeners[event];
    }
  },

  /**
   * Login with credentials, TFA code, or captcha
   * @param {object} options - { username, password, country, deviceName } | { verifyCode } | { captcha: { captchaCode, captchaId } }
   * @returns {Promise<{success: boolean, failReason?: number, data?: any}>}
   */
  async login(options) {
    return homebridge.request('/login', options);
  },

  /**
   * Check if a valid persistent cache file exists on the server.
   * @returns {Promise<{valid: boolean}>}
   */
  async checkCache() {
    return homebridge.request('/checkCache');
  },

  /**
   * Load stored accessories from server (cached from last login)
   * @returns {Promise<Array>} Array of L_Station objects
   */
  async loadStoredAccessories() {
    return homebridge.request('/storedAccessories');
  },

  /**
   * Load unsupported device intel from server (raw properties for triage)
   * @returns {Promise<{devices: Array}>} Array of unsupported device entries
   */
  async loadUnsupportedDevices() {
    return homebridge.request('/unsupportedDevices');
  },

  /**
   * Reset plugin data (removes persistent storage)
   * @returns {Promise<{result: number}>}
   */
  async resetPlugin() {
    return homebridge.request('/reset');
  },

  /**
   * Download compressed diagnostics archive (logs + accessories)
   * @returns {Promise<{buffer: Buffer, filename: string}>}
   */
  async downloadDiagnostics(payload = {}) {
    return homebridge.request('/downloadDiagnostics', payload);
  },

  /**
   * Delete all files except persistent data and accessories
   * @returns {Promise<{deleted: number}>}
   */
  async cleanStorage() {
    return homebridge.request('/cleanStorage');
  },

  /**
   * Register a listener for the 'addAccessory' push event.
   * Fired by server after batch processing completes (~45s after login).
   * Replaces any previously registered listener.
   * @param {function} callback - receives array of L_Station objects
   */
  onAccessoriesReady(callback) {
    this._on('addAccessory', (event) => {
      callback(event.data);
    });
  },

  /**
   * Register a listener for discovery warnings (e.g. extended discovery due to unsupported devices)
   * @param {function} callback - receives { unsupportedCount, unsupportedNames, waitSeconds, message }
   */
  onDiscoveryWarning(callback) {
    this._on('discoveryWarning', (event) => {
      callback(event.data);
    });
  },

  /**
   * Register a listener for real-time discovery progress events.
   * @param {function} callback - receives { phase, stations?, devices?, message }
   */
  onDiscoveryProgress(callback) {
    this._on('discoveryProgress', (event) => {
      callback(event.data);
    });
  },
  /**
   * Register a listener for TFA (two-factor auth) request from the server.
   * Fired when the Eufy server requires a verification code.
   * @param {function} callback - receives no arguments
   */
  onTfaRequest(callback) {
    this._on('tfaRequest', () => callback());
  },

  /**
   * Register a listener for Captcha request from the server.
   * Fired when the Eufy server requires captcha verification.
   * @param {function} callback - receives { id, captcha }
   */
  onCaptchaRequest(callback) {
    this._on('captchaRequest', (event) => callback(event.data));
  },

  /**
   * Register a listener for successful authentication.
   * @param {function} callback - receives no arguments
   */
  onAuthSuccess(callback) {
    this._on('authSuccess', () => callback());
  },

  /**
   * Register a listener for authentication errors (timeout, bad credentials, etc.).
   * @param {function} callback - receives { message }
   */
  onAuthError(callback) {
    this._on('authError', (event) => callback(event.data));
  },
  /**
   * Tell the server to skip the unsupported-device intel wait and proceed immediately.
   * @returns {Promise<{ok: boolean}>}
   */
  async skipIntelWait() {
    return homebridge.request('/skipIntelWait');
  },

  /**
   * Get the current discovery state (phase + pending counts).
   * Used by the discovery UI to catch up on events that fired during login.
   * @returns {Promise<{phase: string, stations: number, devices: number}>}
   */
  async getDiscoveryState() {
    return homebridge.request('/discoveryState');
  },

  /**
   * Register a listener for admin account error.
   * Replaces any previously registered listener.
   * @param {function} callback
   */
  onAdminAccountUsed(callback) {
    this._on('AdminAccountUsed', () => {
      callback();
    });
  },

  /**
   * Register a listener for cache warnings (stale, version mismatch).
   * Replaces any previously registered listener.
   * @param {function} callback - receives { reason, ageDays?, currentVersion?, storedVersion? }
   */
  onCacheWarning(callback) {
    this._on('cacheWarning', (event) => {
      callback(event.data);
    });
  },

  /**
   * Register a listener for diagnostics download progress.
   * Replaces any previously registered listener.
   * @param {function} callback - receives { progress, status }
   */
  onDiagnosticsProgress(callback) {
    this._on('diagnosticsProgress', (event) => {
      callback(event.data);
    });
  },

  /**
   * Get system and environment information for issue reporting
   * @returns {Promise<{pluginVersion: string, eufyClientVersion: string, homebridgeVersion: string, nodeVersion: string, os: string, devices: Array}>}
   */
  async getSystemInfo() {
    return homebridge.request('/systemInfo');
  },

  /**
   * List all available debug recordings.
   * @returns {Promise<{recordings: Array}>}
   */
  async listDebugRecordings() {
    return homebridge.request('/debugRecordings');
  },

  /**
   * Download a chunk of a debug recording file.
   * @param {string} filename
   * @param {number} offset
   * @param {number} chunkSize
   * @returns {Promise<{data: Buffer, totalSize: number, offset: number, chunkSize: number, done: boolean, filename: string}>}
   */
  async downloadDebugRecording(filename, offset = 0, chunkSize = 256 * 1024) {
    return homebridge.request('/downloadDebugRecording', { filename, offset, chunkSize });
  },

  /**
   * Delete a specific debug recording file.
   * @param {string} filename
   * @returns {Promise<{deleted: boolean, filename: string}>}
   */
  async deleteDebugRecording(filename) {
    return homebridge.request('/deleteDebugRecording', { filename });
  },

  /**
   * Delete all debug recording files.
   * @returns {Promise<{deleted: number}>}
   */
  async deleteAllDebugRecordings() {
    return homebridge.request('/deleteAllDebugRecordings');
  },
};
