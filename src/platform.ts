import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, APIEvent } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import { DEFAULT_CONFIG_VALUES, EufySecurityPlatformConfig } from './config.js';

import { DeviceIdentifier, StationContainer, DeviceContainer } from './interfaces.js';

import { StationAccessory } from './accessories/StationAccessory.js';
import { EntrySensorAccessory } from './accessories/EntrySensorAccessory.js';
import { MotionSensorAccessory } from './accessories/MotionSensorAccessory.js';
import { CameraAccessory } from './accessories/CameraAccessory.js';
import { LockAccessory } from './accessories/LockAccessory.js';
import { SmartDropAccessory } from './accessories/SmartDropAccessory.js';
import { GarageDoorAccessory } from './accessories/GarageDoorAccessory.js';
import { AutoSyncStationAccessory } from './accessories/AutoSyncStationAccessory.js';

import {
  EufySecurity,
  EufySecurityConfig,
  Device,
  Station,
  EntrySensor,
  MotionSensor,
  Camera,
  UserType,
  Lock,
  SmartDrop,
  PropertyName,
  libVersion,
  LogLevel,
} from 'eufy-security-client';

import fs from 'fs';

import os from 'node:os';
import { platform } from 'node:process';
import { readFileSync } from 'node:fs';

import { initLog, log, tsLogger, HAP, configureLogStreams } from './utils/utils.js';
import { hasFdkAac, probeHardwareEncoder } from './utils/ffmpeg.js';
import { AccessoriesStore } from './utils/accessoriesStore.js';
import { LIB_VERSION } from './version.js';
import { DebugRecordingManager } from './controller/DebugRecordingManager.js';

export class EufySecurityPlatform implements DynamicPlatformPlugin {
  public eufyClient: EufySecurity = {} as EufySecurity;

  /** Shared debug recording manager — created when debugLivestream is enabled. */
  public debugRecordingManager: DebugRecordingManager | null = null;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private already_shutdown: boolean = false;

  public readonly eufyPath: string;

  private activeAccessoryIds: string[] = [];
  private discoveryDebounceTimeout?: NodeJS.Timeout;

  private pendingStations: Station[] = [];
  private pendingDevices: Device[] = [];

  /** Seconds to wait after the last station/device event before processing. */
  private static readonly DISCOVERY_DEBOUNCE_SEC = 10;

  /** Maximum number of connection attempts before giving up. */
  private static readonly MAX_CONNECT_ATTEMPTS = 3;

  /** Seconds to wait between connection retry attempts. */
  private static readonly CONNECT_RETRY_DELAY_SEC = 30;

  /** Whether the initial batch discovery has finished. */
  private initialDiscoveryComplete: boolean = false;

  /** Maps UUID → PlatformAccessory for every registered accessory (needed for hot-remove). */
  private registeredAccessories: Map<string, PlatformAccessory> = new Map();

  private _hostSystem: string = '';

  private accessoriesStore?: AccessoriesStore;

  constructor(
    hblog: Logger,
    public config: EufySecurityPlatformConfig,
    public readonly api: API,
  ) {
    this.eufyPath = this.api.user.storagePath() + '/eufysecurity';

    if (!fs.existsSync(this.eufyPath)) {
      fs.mkdirSync(this.eufyPath);
    }

    // Identify what we're running on so we can take advantage of hardware-specific features.
    this.probeHwOs();

    this.initConfig(config);

    this.configureLogger();

    // Initialize debug recording manager when debugLivestream is enabled.
    if (this.config.debugLivestream) {
      this.debugRecordingManager = new DebugRecordingManager(log, this.eufyPath);
    }

    this.initSetup();
  }

  /**
   * Initializes the configuration object with default values where properties are not provided.
   * If a property is provided in the config object, it overrides the default value.
   * Additionally, certain numeric properties are parsed to ensure they are of the correct type.
   * @param config - Partial configuration object with user-provided values.
   */
  private initConfig(config: Partial<EufySecurityPlatformConfig>): void {
    // Assigns the provided config object to this.config, casting it to the EufySecurityPlatformConfig type.
    this.config = config as EufySecurityPlatformConfig;

    // Iterates over each key in the DEFAULT_CONFIG_VALUES object.
    Object.keys(DEFAULT_CONFIG_VALUES).forEach((key) => {
      // Checks if the corresponding property in the config object is undefined or null.
      // If it is, assigns the default value from DEFAULT_CONFIG_VALUES to it.
      this.config[key] ??= DEFAULT_CONFIG_VALUES[key];
    });

    // List of properties that need to be parsed as numeric values
    const numericProperties: (keyof EufySecurityPlatformConfig)[] = [
      'CameraMaxLivestreamDuration',
      'pollingIntervalMinutes',
      'hkHome',
      'hkAway',
      'hkNight',
      'hkOff',
    ];

    // Iterate over each property in the config object
    Object.entries(this.config).forEach(([key, value]) => {
      // Check if the property is one of the numeric properties
      if (numericProperties.includes(key)) {
        // Parse the value to ensure it is of the correct type (number)
        this.config[key] = typeof value === 'string' ? parseInt(value as string) : value;
      }
    });
  }

  /**
   * Configures the logging mechanism for the plugin.
   */
  private configureLogger() {
    // Define options for logging
    const logOptions = {
      name: '[EufySecurity]', // Name prefix for log messages
      prettyLogTemplate: '[{{mm}}/{{dd}}/{{yyyy}}, {{hh}}:{{MM}}:{{ss}}]\t{{name}}\t{{logLevelName}}\t', // Template for pretty log output
      prettyErrorTemplate: '\n{{errorName}} {{errorMessage}}\nerror stack:\n{{errorStack}}', // Template for pretty error output
      prettyErrorStackTemplate: '  • {{fileName}}\t{{method}}\n\t{{fileNameWithLine}}', // Template for error stack trace
      prettyErrorParentNamesSeparator: '', // Separator for parent names in error messages
      prettyErrorLoggerNameDelimiter: '\t', // Delimiter for logger name in error messages
      stylePrettyLogs: true, // Enable styling for logs
      minLevel: 3, // Minimum log level to display (3 corresponds to INFO)
      prettyLogTimeZone: 'local' as 'local' | 'local', // Time zone for log timestamps
      prettyLogStyles: {
        // Styles for different log elements
        logLevelName: {
          // Styles for log level names
          '*': ['bold', 'black', 'bgWhiteBright', 'dim'], // Default style
          SILLY: ['bold', 'white'], // Style for SILLY level
          TRACE: ['bold', 'whiteBright'], // Style for TRACE level
          DEBUG: ['bold', 'green'], // Style for DEBUG level
          INFO: ['bold', 'blue'], // Style for INFO level
          WARN: ['bold', 'yellow'], // Style for WARN level
          ERROR: ['bold', 'red'], // Style for ERROR level
          FATAL: ['bold', 'redBright'], // Style for FATAL level
        },
        dateIsoStr: 'gray', // Style for ISO date strings
        filePathWithLine: 'white', // Style for file paths with line numbers
        name: 'green', // Style for logger names
        nameWithDelimiterPrefix: ['white', 'bold'], // Style for logger names with delimiter prefix
        nameWithDelimiterSuffix: ['white', 'bold'], // Style for logger names with delimiter suffix
        errorName: ['bold', 'bgRedBright', 'whiteBright'], // Style for error names
        fileName: ['yellow'], // Style for file names
      },
    };

    // Modify log options if detailed logging is enabled
    if (this.config.enableDetailedLogging) {
      logOptions.name = `[EufySecurity-${LIB_VERSION}]`; // Modify logger name with plugin version
      logOptions.prettyLogTemplate =
        '[{{mm}}/{{dd}}/{{yyyy}} {{hh}}:{{MM}}:{{ss}}]\t{{name}}\t{{logLevelName}}\t[{{fileNameWithLine}}]\t'; // Modify log template
      logOptions.minLevel = 2; // Adjust minimum log level
    }

    // Initialize the global logger with the configured options
    initLog(logOptions);

    // Configures log streams for various log files
    configureLogStreams(this.eufyPath, this.config.omitLogFiles);
  }

  // This function is responsible for identifying the hardware and operating system environment the application is running on.
  private probeHwOs(): void {
    // Start off with a generic identifier.
    this._hostSystem = 'generic';

    // Take a look at the platform we're on for an initial hint of what we are.
    switch (platform) {
      // The beloved macOS.
      case 'darwin':
        // For macOS, we check the CPU model to determine if it's an Apple CPU or an Intel CPU.
        this._hostSystem = 'macOS.' + (os.cpus()[0].model.includes('Apple') ? 'Apple' : 'Intel');

        break;

      // The indomitable Linux.
      case 'linux':
        // Let's further see if we're a small, but scrappy, Raspberry Pi.
        try {
          // As of the 4.9 kernel, Raspberry Pi prefers to be identified using this method and has deprecated cpuinfo.
          const systemId = readFileSync('/sys/firmware/devicetree/base/model', { encoding: 'utf8' });

          // Check if it's a Raspberry Pi 4.
          if (/Raspberry Pi (Compute Module )?4/.test(systemId)) {
            // If it's a Pi 4, we identify the system as running Raspbian.
            this._hostSystem = 'raspbian';
          }
        } catch {
          // Errors encountered while attempting to identify the system are ignored.
          // We prioritize getting system information through hints rather than comprehensive detection.
        }

        break;

      default:
        // We aren't trying to solve for every system type.
        // If the platform doesn't match macOS or Linux, we keep the generic identifier.
        break;
    }
  }

  // Utility to return the hardware environment we're on.
  public get hostSystem(): string {
    return this._hostSystem;
  }

  private initSetup() {
    log.debug('plugin data store:', this.eufyPath);
    log.debug('OS is', this.hostSystem);
    log.debug('Using bropats @homebridge-eufy-security/eufy-security-client library in version ', libVersion);

    // Probe ffmpeg capabilities early so warnings show at boot.
    hasFdkAac();
    probeHardwareEncoder(this.hostSystem);

    // Log the final configuration object for debugging purposes
    log.debug('The config is:', this.config);

    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    const nativePKCS1Restored = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 5);
    if (nativePKCS1Restored && this.config.enableEmbeddedPKCS1Support) {
      log.info(
        'Native PKCS1 padding support available (Node.js >= 24.5.0) — ignoring enableEmbeddedPKCS1Support config option',
      );
    }

    const eufyConfig = {
      username: this.config.username,
      password: this.config.password,
      country: this.config.country,
      trustedDeviceName: this.config.deviceName,
      language: 'en',
      persistentDir: this.eufyPath,
      p2pConnectionSetup: 0,
      pollingIntervalMinutes: this.config.pollingIntervalMinutes,
      enableEmbeddedPKCS1Support: nativePKCS1Restored ? false : this.config.enableEmbeddedPKCS1Support,
      eventDurationSeconds: 10,
      logging: {
        level: this.config.enableDetailedLogging ? LogLevel.Debug : LogLevel.Info,
      },
    } as EufySecurityConfig;

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      await this.pluginSetup(eufyConfig);
    });

    this.api.on(APIEvent.SHUTDOWN, async () => {
      await this.pluginShutdown();
    });

    log.debug('Finished booting!');
  }

  private async pluginSetup(eufyConfig: EufySecurityConfig) {
    let connected = false;

    for (let attempt = 1; attempt <= EufySecurityPlatform.MAX_CONNECT_ATTEMPTS; attempt++) {
      // If a fatal handler (captcha/tfa) triggered shutdown during a previous attempt, stop
      if (this.already_shutdown) {
        return;
      }

      if (attempt > 1) {
        log.warn(`Connection attempt ${attempt}/${EufySecurityPlatform.MAX_CONNECT_ATTEMPTS}...`);
      }

      connected = await this.attemptConnect(eufyConfig);

      if (connected || this.already_shutdown) {
        break;
      }

      if (attempt < EufySecurityPlatform.MAX_CONNECT_ATTEMPTS) {
        log.warn(`Retrying in ${EufySecurityPlatform.CONNECT_RETRY_DELAY_SEC} seconds...`);
        await this.delay(EufySecurityPlatform.CONNECT_RETRY_DELAY_SEC * 1000);
      }
    }

    if (!connected) {
      if (!this.already_shutdown) {
        log.error(`All ${EufySecurityPlatform.MAX_CONNECT_ATTEMPTS} connection attempts failed. Shutting down plugin.`);
        await this.pluginShutdown();
      }
      return;
    }

    log.info('Connected to Eufy. Waiting for stations and devices to be discovered...');

    if (this.config.CameraMaxLivestreamDuration > 86400) {
      this.config.CameraMaxLivestreamDuration = 86400;
      log.warn(
        'Your maximum livestream duration value is too large. Since this can cause problems it was reset to 86400 seconds (1 day maximum).',
      );
    }

    this.eufyClient.setCameraMaxLivestreamDuration(this.config.CameraMaxLivestreamDuration);
    log.debug(`CameraMaxLivestreamDuration: ${this.eufyClient.getCameraMaxLivestreamDuration()}`);
  }

  /**
   * Attempts a single connection to the Eufy cloud service.
   * Initializes the client, sets up event handlers, and connects.
   * @returns true if connected successfully, false otherwise.
   */
  private async attemptConnect(eufyConfig: EufySecurityConfig): Promise<boolean> {
    try {
      this.eufyClient = await EufySecurity.initialize(
        eufyConfig,
        this.config.enableDetailedLogging ? tsLogger : undefined,
      );

      // Each camera adds listeners (livestream, talkback) on top of the base ones.
      // Raise limit to prevent MaxListenersExceededWarning in Node 22+.
      this.eufyClient.setMaxListeners(30);

      this.eufyClient.on('station added', this.stationAdded.bind(this));
      this.eufyClient.on('station removed', this.stationRemoved.bind(this));
      this.eufyClient.on('device added', this.deviceAdded.bind(this));
      this.eufyClient.on('device removed', this.deviceRemoved.bind(this));

      // Initialise the accessories store for UI consumption
      this.accessoriesStore = new AccessoriesStore(this.eufyClient, this.config, this.eufyPath);

      this.eufyClient.on('push connect', () => {
        log.debug('Push Connected!');
      });
      this.eufyClient.on('push close', () => {
        log.debug('Push Closed!');
      });
      this.eufyClient.on('connect', () => {
        log.debug('Connected!');
      });
      this.eufyClient.on('close', () => {
        log.debug('Closed!');
      });
      this.eufyClient.on('connection error', (error: Error) => {
        log.warn(`Connection error: ${error}`);
      });
      this.eufyClient.once('captcha request', async () => {
        log.error(`
        ***************************
        ***** WARNING MESSAGE *****
        ***************************
        Important Notice: CAPTCHA Required
        Your account requires CAPTCHA verification to log in.
        The plugin will now shut down.
        Please open the Homebridge UI, go to the homebridge-eufy-security plugin settings, and complete the CAPTCHA to reconnect.
        ***************************
        `);
        await this.pluginShutdown();
      });
      this.eufyClient.on('tfa request', async () => {
        log.error(`
        ***************************
        ***** WARNING MESSAGE *****
        ***************************
        Attention: Two-Factor Authentication (2FA) Required
        Your account requires 2FA verification to log in.
        The plugin will now shut down.
        Please open the Homebridge UI, go to the homebridge-eufy-security plugin settings, and complete the 2FA verification to reconnect.
        ***************************
        `);
        await this.pluginShutdown();
      });
    } catch (e) {
      log.error(`Error while setup: ${e}`);
      return false;
    }

    try {
      await this.eufyClient.connect();
      log.debug('EufyClient connected ' + this.eufyClient?.isConnected?.());
    } catch (e) {
      log.error(`Error authenticating Eufy: ${e}`);
      try {
        this.eufyClient.close();
      } catch {
        /* ignore cleanup errors */
      }
      return false;
    }

    if (!this.eufyClient?.isConnected?.()) {
      log.error("Not connected can't continue!");
      try {
        this.eufyClient.close();
      } catch {
        /* ignore cleanup errors */
      }
      return false;
    }

    return true;
  }

  /**
   * Generates a UUID based on the given identifier and station flag.
   * @param identifier The unique identifier.
   * @param isStation Flag indicating whether the identifier belongs to a station.
   * @returns The generated UUID.
   */
  private generateUUID(identifier: string, isStation: boolean): string {
    // Add prefix 's_' if it's a station identifier, otherwise, no prefix.
    const prefix = isStation ? 's1_' : 'd1_';
    // Generate UUID based on the prefix + identifier.
    return HAP.uuid.generate(prefix + identifier);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Defines an accessory for a device or station.
   *
   * @param deviceContainer The container holding information about the device or station.
   * @param isStation A boolean indicating whether the container represents a station.
   * @returns A tuple containing the created or cached accessory and a boolean indicating whether the accessory was cached.
   */
  private defineAccessory(
    deviceContainer: StationContainer | DeviceContainer,
    isStation: boolean,
  ): [PlatformAccessory, boolean] {
    // Generate UUID for the accessory based on device's unique identifier and whether it's a station
    const uuid = this.generateUUID(deviceContainer.deviceIdentifier.uniqueId, isStation);

    // Check if the accessory is already cached
    const cachedAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    // If the accessory is cached, remove it from the accessories array
    if (cachedAccessory) {
      this.accessories.splice(this.accessories.indexOf(cachedAccessory), 1);
    }

    // Determine if the device is a camera
    const isCamera: boolean =
      deviceContainer.eufyDevice instanceof Device ? deviceContainer.eufyDevice.isCamera() : false;

    // Create a new accessory if not cached, otherwise use the cached one
    const accessory =
      cachedAccessory ||
      new this.api.platformAccessory(
        deviceContainer.deviceIdentifier.displayName,
        uuid,
        isCamera ? HAP.Categories.CAMERA : HAP.Categories.SECURITY_SYSTEM,
      );

    // Store device information in accessory context
    accessory.context['device'] = deviceContainer.deviceIdentifier;
    accessory.displayName = deviceContainer.deviceIdentifier.displayName;

    return [accessory, !!cachedAccessory];
  }

  /**
   * Adds or updates an accessory for a device or station.
   *
   * @param deviceContainer The container holding information about the device or station.
   * @param isStation A boolean indicating whether the container represents a station.
   */
  private async addOrUpdateAccessory(deviceContainer: StationContainer | DeviceContainer, isStation: boolean) {
    try {
      // Define the accessory and check if it already exists
      const [accessory, isExist] = this.defineAccessory(deviceContainer, isStation);

      // Register the accessory based on whether it's a station or device
      try {
        if (isStation) {
          this.register_station(accessory, deviceContainer as StationContainer);
        } else {
          this.register_device(accessory, deviceContainer as DeviceContainer);
        }
      } catch (error) {
        // Remove station or device accessories created prior to plugin upgrade,
        // which may have been subject to removal due to newly introduced logic.
        if (isExist) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        throw error;
      }

      // Add the accessory's UUID to activeAccessoryIds if it's not already present
      if (this.activeAccessoryIds.indexOf(accessory.UUID) === -1) {
        this.activeAccessoryIds.push(accessory.UUID);
      }

      // Update or register the accessory with the platform
      if (isExist) {
        this.api.updatePlatformAccessories([accessory]);
        log.info(`Updating existing accessory: ${accessory.displayName}`);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        log.info(`Registering new accessory: ${accessory.displayName}`);
      }

      // Track the accessory so we can unregister it on hot-remove
      this.registeredAccessories.set(accessory.UUID, accessory);
    } catch (error) {
      // Log any errors that occur during accessory addition or update
      log.error(`Error in ${isStation ? 'stationAdded' : 'deviceAdded'}:`, error);
    }
  }

  private async stationAdded(station: Station) {
    try {
      if (this.config.ignoreStations.includes(station.getSerial())) {
        log.debug(`${station.getName()}: Station ignored`);
        return;
      }

      const rawStation = station.getRawStation();
      if (rawStation.member.member_type !== UserType.ADMIN) {
        await this.pluginShutdown();
        log.error(`
          #########################
          ######### ERROR #########
          #########################
          You're not using a guest admin account with this plugin! You must use a guest admin account!
          Please look here for more details: 
          https://github.com/homebridge-plugins/homebridge-eufy-security/wiki/Create-a-dedicated-admin-account-for-Homebridge-Eufy-Security-Plugin
          #########################
        `);
        return;
      }

      if (this.initialDiscoveryComplete) {
        // Hot-add: process immediately
        await this.hotAddStation(station);
        return;
      }

      // Store station for batch processing later
      this.pendingStations.push(station);
      log.debug(`${station.getName()}: Station queued for processing`);
      this.resetDiscoveryDebounce();
    } catch (error) {
      log.error(`Error in stationAdded:, ${error}`);
    }
  }

  private async deviceAdded(device: Device) {
    try {
      if (this.config.ignoreDevices.includes(device.getSerial())) {
        log.debug(`${device.getName()}: Device ignored`);
        return;
      }

      // Check if the device is a keypad and ignore it from the start
      const deviceType = device.getDeviceType();
      if (Device.isKeyPad(deviceType)) {
        log.warn(
          `${device.getName()}: The keypad is ignored as it serves no purpose in this plugin. You can ignore this message.`,
        );
        return;
      }

      if (this.initialDiscoveryComplete) {
        // Hot-add: process immediately
        await this.hotAddDevice(device);
        return;
      }

      // Store device for batch processing later
      this.pendingDevices.push(device);
      log.debug(`${device.getName()}: Device queued for processing`);
      this.resetDiscoveryDebounce();
    } catch (error) {
      log.error(`Error in deviceAdded: ${error}`);
    }
  }

  private async stationRemoved(station: Station) {
    const serial = station.getSerial();
    const name = station.getName();
    log.info(`Station removed event received: ${name} (${serial})`);

    const uuid = this.generateUUID(serial, true);
    this.removeAccessoryByUUID(uuid, name);
  }

  private async deviceRemoved(device: Device) {
    const serial = device.getSerial();
    const name = device.getName();
    log.info(`Device removed event received: ${name} (${serial})`);

    const uuid = this.generateUUID(serial, false);
    this.removeAccessoryByUUID(uuid, name);
  }

  /**
   * Unregisters an accessory from HomeKit by its UUID.
   * Used by hot-remove handlers to cleanly remove devices/stations at runtime.
   */
  private removeAccessoryByUUID(uuid: string, displayName: string): void {
    const accessory = this.registeredAccessories.get(uuid);
    if (!accessory) {
      log.debug(
        `No registered accessory found for UUID ${uuid} (${displayName}) — may have been ignored or already removed`,
      );
      return;
    }

    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registeredAccessories.delete(uuid);

      const idx = this.activeAccessoryIds.indexOf(uuid);
      if (idx !== -1) {
        this.activeAccessoryIds.splice(idx, 1);
      }

      log.info(`Successfully removed accessory: ${displayName}`);

      // Refresh the accessories store so the UI reflects the change
      this.accessoriesStore?.persistNow();
    } catch (error) {
      log.error(`Error removing accessory ${displayName}: ${error}`);
    }
  }

  /**
   * Hot-adds a single device after initial discovery is complete.
   * Processes it immediately without debouncing.
   */
  private async hotAddDevice(device: Device): Promise<void> {
    const deviceType = device.getDeviceType();

    if (!Device.isSupported(deviceType)) {
      log.warn(`[HOT-ADD] "${device.getName()}" (type ${deviceType}) is unsupported — skipping`);
      return;
    }

    const deviceContainer: DeviceContainer = {
      deviceIdentifier: {
        uniqueId: device.getSerial(),
        displayName: 'DEVICE ' + device.getName().replace(/[^a-zA-Z0-9]/g, ''),
        type: deviceType,
      } as DeviceIdentifier,
      eufyDevice: device,
    };

    log.info(`[HOT-ADD] Adding new device: ${device.getName()} (${device.getSerial()})`);
    await this.addOrUpdateAccessory(deviceContainer, false);

    // Refresh the accessories store so the UI reflects the change
    this.accessoriesStore?.persistNow();
  }

  /**
   * Hot-adds a single station after initial discovery is complete.
   * Processes it immediately without debouncing.
   */
  private async hotAddStation(station: Station): Promise<void> {
    const stationType = station.getDeviceType();
    const stationSerial = station.getSerial();

    const isKnownStation = Device.isStation(stationType);
    if (!isKnownStation && !Device.isSupported(stationType)) {
      log.warn(`[HOT-ADD] "${station.getName()}" (type ${stationType}) is unsupported — skipping`);
      return;
    }

    const stationContainer: StationContainer = {
      deviceIdentifier: {
        uniqueId: stationSerial,
        displayName: 'STATION ' + station.getName().replace(/[^a-zA-Z0-9]/g, ''),
        type: stationType,
      } as DeviceIdentifier,
      eufyDevice: station,
    };

    log.info(`[HOT-ADD] Adding new station: ${station.getName()} (${stationSerial})`);
    await this.addOrUpdateAccessory(stationContainer, true);

    // Refresh the accessories store so the UI reflects the change
    this.accessoriesStore?.persistNow();
  }

  /**
   * Processes pending stations and devices in batch.
   * Only creates station entities if:
   * 1. It's a hub/base station (Device.isStation) OR
   * 2. It has at least one device attached
   *
   * All discovered devices are processed since they are already verified by bropat/eufy-security-client.
   */
  /**
   * Resets the discovery debounce timer.
   * Each time a station or device is emitted, the timer restarts.
   * Processing begins once no new events arrive for DISCOVERY_DEBOUNCE_SEC seconds.
   */
  private resetDiscoveryDebounce(): void {
    if (this.discoveryDebounceTimeout) {
      clearTimeout(this.discoveryDebounceTimeout);
    }
    const delaySec = EufySecurityPlatform.DISCOVERY_DEBOUNCE_SEC;
    log.debug(
      `Discovery debounce reset — will process in ${delaySec}s if no more devices arrive ` +
        `(${this.pendingStations.length} station(s), ${this.pendingDevices.length} device(s) queued)`,
    );
    this.discoveryDebounceTimeout = setTimeout(async () => {
      await this.processPendingDevices();
      this.cleanCachedAccessories();
    }, delaySec * 1000);
  }

  private async processPendingDevices(): Promise<void> {
    log.debug(
      `[PROCESSING START] Processing ${this.pendingStations.length} stations and ${this.pendingDevices.length} devices`,
    );

    if (this.pendingStations.length === 0 || this.pendingDevices.length === 0) {
      log.warn(
        `[DISCOVERY WARNING] Discovery finished with ${this.pendingStations.length} station(s) and ${this.pendingDevices.length} devices(s). ` +
          'If this is unexpected, please verify your Eufy account has devices and the credentials used are for a guest admin account.',
      );
    }

    // Build set of stations that have at least one device
    const stationsWithDevices = new Set<string>();

    // Create all queued devices (they are already verified by bropat/eufy-security-client)
    log.debug(`[DEVICES PROCESSING] Starting to process ${this.pendingDevices.length} devices`);

    for (const device of this.pendingDevices) {
      stationsWithDevices.add(device.getStationSerial());

      try {
        const deviceType = device.getDeviceType();

        // Skip devices that the client declares as unsupported
        if (!Device.isSupported(deviceType)) {
          log.warn(
            `[DEVICE SKIP] "${device.getName()}" (type ${deviceType}) is unsupported by eufy-security-client — skipping accessory creation`,
          );
          continue;
        }

        const deviceContainer: DeviceContainer = {
          deviceIdentifier: {
            uniqueId: device.getSerial(),
            displayName: 'DEVICE ' + device.getName().replace(/[^a-zA-Z0-9]/g, ''),
            type: deviceType,
          } as DeviceIdentifier,
          eufyDevice: device,
        };

        log.debug(`[DEVICE] Processing: ${deviceContainer.deviceIdentifier.displayName}`);
        await this.addOrUpdateAccessory(deviceContainer, false);
        log.debug(`[DEVICE] Completed: ${deviceContainer.deviceIdentifier.displayName}`);
      } catch (error) {
        log.error(`[DEVICE ERROR] Error processing device "${device.getName()}": ${error}`);
      }
    }

    log.debug(`[DEVICES COMPLETE] All ${this.pendingDevices.length} devices processed`);

    // Create queued stations that should be created
    log.debug(`[STATIONS PROCESSING] Starting to process ${this.pendingStations.length} stations`);
    let stationsSkipped = 0;

    for (const station of this.pendingStations) {
      const stationType = station.getDeviceType();
      const stationSerial = station.getSerial();

      // Hub/base stations (type 0, HB3, etc.) are always valid — they don't
      // appear in DeviceProperties so Device.isSupported() returns false for them.
      // For standalone cameras acting as their own station, fall back to Device.isSupported().
      const isKnownStation = Device.isStation(stationType);
      if (!isKnownStation && !Device.isSupported(stationType)) {
        log.warn(
          `[STATION SKIP] "${station.getName()}" (type ${stationType}) is unsupported by eufy-security-client — skipping accessory creation`,
        );
        continue;
      }

      // Create if: it's a hub/base station OR it has devices
      const shouldCreate = isKnownStation || stationsWithDevices.has(stationSerial);

      if (!shouldCreate) {
        stationsSkipped++;
        log.debug(`[STATION SKIP] "${station.getName()}" has no devices and will be skipped`);
        continue;
      }

      try {
        const deviceContainer: StationContainer = {
          deviceIdentifier: {
            uniqueId: stationSerial,
            displayName: 'STATION ' + station.getName().replace(/[^a-zA-Z0-9]/g, ''),
            type: stationType,
          } as DeviceIdentifier,
          eufyDevice: station,
        };

        log.debug(`[STATION] Processing: ${deviceContainer.deviceIdentifier.displayName}`);
        await this.addOrUpdateAccessory(deviceContainer, true);
        log.debug(`[STATION] Completed: ${deviceContainer.deviceIdentifier.displayName}`);
      } catch (error) {
        log.error(`[STATION ERROR] Error processing station "${station.getName()}": ${error}`);
      }
    }

    log.debug(
      `[STATIONS COMPLETE] ${this.pendingStations.length - stationsSkipped} stations created, ${stationsSkipped} skipped`,
    );

    // Persist the discovered accessories for the UI (immediate, no debounce)
    this.accessoriesStore?.persistNow();

    // Clear pending queues
    this.pendingStations = [];
    this.pendingDevices = [];

    // Mark initial discovery as complete — subsequent events will be processed immediately
    this.initialDiscoveryComplete = true;

    log.info(`[PROCESSING COMPLETE] All pending devices and stations processed`);
  }

  private async pluginShutdown() {
    // Ensure a single shutdown to prevent corruption of the persistent file.
    // This also enables captcha through the GUI and prevents repeated captcha or 2FA prompts upon plugin restart.
    if (this.already_shutdown) {
      return;
    }

    this.already_shutdown = true;

    if (this.discoveryDebounceTimeout) {
      clearTimeout(this.discoveryDebounceTimeout);
    }

    this.accessoriesStore?.cancelPending();

    try {
      if (this.eufyClient?.isConnected?.()) {
        this.eufyClient.close();
      }
      log.info('Finished shutdown!');
    } catch (e) {
      log.error(`Error while shutdown: ${e}`);
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    log.debug(`Loading accessory from cache: ${accessory.displayName}`);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  private cleanCachedAccessories() {
    if (this.config.cleanCache) {
      log.debug('Looking for old cached accessories that seem to be outdated...');
      let num = 0;

      const staleAccessories = this.accessories.filter((item) => {
        return this.activeAccessoryIds.indexOf(item.UUID) === -1;
      });

      staleAccessories.forEach((staleAccessory) => {
        log.info(`Removing cached accessory ${staleAccessory.UUID} ${staleAccessory.displayName}`);
        num++;
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [staleAccessory]);
      });

      if (num > 0) {
        log.info('Removed ' + num + ' cached accessories');
      } else {
        log.info('No outdated cached accessories found.');
      }
    }
  }

  private register_station(accessory: PlatformAccessory, container: StationContainer): void {
    log.debug(accessory.displayName + ' UUID:' + accessory.UUID);

    const type = container.deviceIdentifier.type;
    const station = container.eufyDevice;

    if (!Device.isStation(type)) {
      // Standalone Lock or Doorbell doesn't have Security Control
      if (Device.isDoorbell(type) || Device.isLock(type)) {
        throw new Error(
          `looks station but it's not could imply some errors! Type: ${type}. You can ignore this message.`,
        );
      }
    }

    if (this.config.autoSyncStation) {
      new AutoSyncStationAccessory(this, accessory, station as Station);
    } else {
      new StationAccessory(this, accessory, station as Station);
    }
  }

  private register_device(accessory: PlatformAccessory, container: DeviceContainer): void {
    log.debug(accessory.displayName + ' UUID:' + accessory.UUID);
    const device = container.eufyDevice;
    const type = container.deviceIdentifier.type;

    if (Device.isMotionSensor(type)) {
      log.debug(accessory.displayName + ' isMotionSensor!');
      new MotionSensorAccessory(this, accessory, device as MotionSensor);
    }

    if (Device.isEntrySensor(type)) {
      log.debug(accessory.displayName + ' isEntrySensor!');
      new EntrySensorAccessory(this, accessory, device as EntrySensor);
    }

    if (Device.isSmartDrop(type)) {
      log.debug(accessory.displayName + ' isSmartDrop!');
      new SmartDropAccessory(this, accessory, device as SmartDrop);
    }

    if (Device.isLock(type)) {
      log.debug(accessory.displayName + ' isLock!');
      new LockAccessory(this, accessory, device as Lock);
    }

    if (Device.isCamera(type) || Device.isLockWifiVideo(type)) {
      log.debug(accessory.displayName + ' isCamera!');
      new CameraAccessory(this, accessory, device as Camera);

      // Register garage door(s) as separate accessories for individual naming
      if ((device as Camera).isGarageCamera()) {
        this.registerGarageDoors(device as Camera, container);
      }
    }
  }

  private registerGarageDoors(device: Camera, container: DeviceContainer) {
    const cameraConfig = this.config.cameras?.find((e) => e.serialNumber === device.getSerial()) ?? {};

    const doors: { doorId: 1 | 2; prop: PropertyName; enableKey: string; nameKey: string }[] = [
      { doorId: 1, prop: PropertyName.DeviceDoor1Open, enableKey: 'enableDoor1', nameKey: 'door1Name' },
      { doorId: 2, prop: PropertyName.DeviceDoor2Open, enableKey: 'enableDoor2', nameKey: 'door2Name' },
    ];

    for (const door of doors) {
      const enabled = (cameraConfig as any)[door.enableKey] ?? door.doorId === 1;
      if (!enabled || !device.hasProperty(door.prop)) continue;

      const doorName = (cameraConfig as any)[door.nameKey] || `Garage Door ${door.doorId}`;
      const doorSerial = device.getSerial() + `_door_${door.doorId}`;
      const uuid = HAP.uuid.generate('d1_' + doorSerial);

      const cachedAccessory = this.accessories.find((a) => a.UUID === uuid);
      if (cachedAccessory) {
        this.accessories.splice(this.accessories.indexOf(cachedAccessory), 1);
      }

      const doorAccessory = cachedAccessory || new this.api.platformAccessory(doorName, uuid);

      doorAccessory.context['device'] = container.deviceIdentifier;
      doorAccessory.displayName = doorName;

      new GarageDoorAccessory(this, doorAccessory, device, door.doorId);

      if (this.activeAccessoryIds.indexOf(doorAccessory.UUID) === -1) {
        this.activeAccessoryIds.push(doorAccessory.UUID);
      }

      if (cachedAccessory) {
        this.api.updatePlatformAccessories([doorAccessory]);
        log.info(`Updating existing accessory: ${doorAccessory.displayName}`);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [doorAccessory]);
        log.info(`Registering new accessory: ${doorAccessory.displayName}`);
      }

      this.registeredAccessories.set(doorAccessory.UUID, doorAccessory);
    }
  }
}
