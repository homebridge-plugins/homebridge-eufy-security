import { Device, EufySecurity, PropertyName, CommandName, DeviceType } from 'eufy-security-client';

import fs from 'fs';

import { log } from './utils.js';
import { LIB_VERSION } from '../version.js';
import { EufySecurityPlatformConfig } from '../config.js';

/** Seconds between heartbeat writes so the UI can detect a running plugin. */
const HEARTBEAT_SEC = 60;

/**
 * Manages the accessories.json file that the Eufy Plugin UI reads.
 *
 * Builds the station/device tree from live eufy-security-client objects
 * and writes it to disk. A periodic heartbeat keeps `storedAt` fresh so
 * the UI can detect whether the plugin is still running.
 */
export class AccessoriesStore {
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(
    private readonly eufyClient: EufySecurity,
    private readonly config: EufySecurityPlatformConfig,
    private readonly storagePath: string,
  ) {}

  /** Write accessories.json immediately and start the heartbeat. */
  public async persistNow(): Promise<void> {
    this.cancelPending();
    await this.persist();
    this.startHeartbeat();
  }

  /** Stop the heartbeat. */
  public cancelPending(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /** Start a periodic heartbeat that rewrites accessories.json every HEARTBEAT_SEC seconds. */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return; // already running
    }
    this.heartbeatInterval = setInterval(() => this.persist(), HEARTBEAT_SEC * 1000);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async persist(): Promise<void> {
    try {
      if (!this.eufyClient?.isConnected?.()) {
        return;
      }

      const [stations, devices] = await Promise.all([this.eufyClient.getStations(), this.eufyClient.getDevices()]);

      // Group devices by their parent station serial
      const devicesByStation = new Map<string, Device[]>();
      for (const device of devices) {
        const stationSN = device.getStationSerial();
        if (!devicesByStation.has(stationSN)) {
          devicesByStation.set(stationSN, []);
        }
        devicesByStation.get(stationSN)!.push(device);
      }

      const storedStations: Record<string, any>[] = [];

      for (const station of stations) {
        const stationType = station.getDeviceType();
        const stationSerial = station.getSerial();
        const isKnownStation = Device.isStation(stationType);

        const stationRecord: Record<string, any> = {
          uniqueId: stationSerial,
          displayName: station.getName(),
          type: stationType,
          typename: DeviceType[stationType],
          disabled: false,
          devices: [],
          properties: { ...station.getProperties() },
          unsupported: false,
          ignored: (this.config.ignoreStations ?? []).includes(stationSerial),
          power: computePower(station.getProperties()),
        };

        try {
          delete stationRecord.properties.picture;
        } catch {
          /* ignore */
        }

        if (!isKnownStation) {
          if (!Device.isSupported(stationType)) {
            stationRecord.unsupported = true;
          } else {
            const hasMatchingDevice = devicesByStation.has(stationSerial);
            if (hasMatchingDevice) {
              stationRecord.standalone = true;
              stationRecord.disabled = true;
              if (Device.isLock(stationType) || Device.isDoorbell(stationType) || Device.isSmartDrop(stationType)) {
                stationRecord.noSecurityControl = true;
              }
            } else {
              stationRecord.unsupported = true;
            }
          }
        }

        // Attach devices to this station
        const stationDevices = devicesByStation.get(stationSerial) ?? [];
        for (const device of stationDevices) {
          const devType = device.getDeviceType();

          const deviceRecord: Record<string, any> = {
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
            properties: { ...device.getProperties() },
            unsupported: !Device.isSupported(devType),
            ignored: (this.config.ignoreDevices ?? []).includes(device.getSerial()),
            power: computePower(device.getProperties()),
          };

          try {
            delete deviceRecord.properties.picture;
          } catch {
            /* ignore */
          }

          if (stationRecord.unsupported) {
            deviceRecord.unsupported = true;
          }

          stationRecord.devices.push(deviceRecord);
        }

        storedStations.push(stationRecord);
      }

      if (!fs.existsSync(this.storagePath)) {
        fs.mkdirSync(this.storagePath, { recursive: true });
      }
      const filePath = this.storagePath + '/accessories.json';
      const data = { version: LIB_VERSION, storedAt: new Date().toISOString(), stations: storedStations };
      fs.writeFileSync(filePath, JSON.stringify(data));
      log.debug(`Persisted ${storedStations.length} station(s) to accessories.json`);
    } catch (error) {
      log.error(`Failed to write accessories.json: ${error}`);
    }
  }
}

/**
 * Compute a unified power descriptor from a properties object.
 * Works for both devices and stations.
 */
function computePower(props: Record<string, any>): Record<string, any> {
  const power: Record<string, any> = { source: null, icon: null, label: null };

  if (props.battery !== undefined) {
    power.battery = props.battery;
  } else if (props.batteryLow !== undefined) {
    power.batteryLow = props.batteryLow;
  }

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

  if (props.powerSource === 1) {
    power.source = 'solar';
    power.icon = 'solar_power.svg';
    power.label = 'Solar';
  } else if (props.powerSource === 0) {
    power.source = 'battery';
  } else if (power.battery === undefined && power.batteryLow === undefined) {
    power.source = 'plugged';
    power.icon = 'bolt.svg';
    power.label = 'Plugged In';
  } else {
    power.source = 'battery';
  }

  return power;
}
