(function legacySettingsModule(global) {
  const keys = [
    'CameraMaxLivestreamDuration',
    'autoSyncStation',
    'cameras',
    'cleanCache',
    'debugLivestream',
    'enableDetailedLogging',
    'enableEmbeddedPKCS1Support',
    'experimentalMode',
    'hkAway',
    'hkHome',
    'hkNight',
    'hkOff',
    'ignoreDevices',
    'ignoreMultipleDevicesWarning',
    'ignoreStations',
    'omitLogFiles',
    'stations',
    'syncStationModes',
    'useEmbeddedPKCS1Support',
  ];

  function effectful(key, value) {
    const defaults = { CameraMaxLivestreamDuration: 30, hkHome: 1, hkAway: 0, hkNight: 3, hkOff: 63 };
    if (Object.hasOwn(defaults, key)) return value !== defaults[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  }

  function names(block) {
    return keys.filter((key) => Object.hasOwn(block, key) && effectful(key, block[key])).sort();
  }

  global.HomebridgeEufyLegacySettings = { names };
})(window);
