import { PlatformAccessory, Characteristic, CharacteristicValue } from 'homebridge';

import { EufySecurityPlatform } from '../platform.js';
import { DeviceAccessory } from './Device.js';

import { Camera, PropertyName, GarageDoorState } from 'eufy-security-client';

import { CHAR, SERV } from '../utils/utils.js';

/**
 * Garage Door Accessory — registered as a separate PlatformAccessory so it
 * gets its own tile and name in HomeKit, independent of the parent camera.
 */
export class GarageDoorAccessory extends DeviceAccessory {
  private doorState: number | undefined;
  private currentChar: Characteristic | undefined;
  private targetChar: Characteristic | undefined;

  constructor(
    platform: EufySecurityPlatform,
    accessory: PlatformAccessory,
    device: Camera,
    private readonly doorId: 1 | 2,
  ) {
    super(platform, accessory, device);

    // Override AccessoryInformation name to match the accessory's display name
    // (BaseAccessory sets it to the device name, which is the camera's name)
    this.getService(SERV.AccessoryInformation).updateCharacteristic(CHAR.Name, accessory.displayName);

    this.log.debug(`Constructed GarageDoorAccessory: ${accessory.displayName} (door ${doorId})`);

    this.setupGarageDoor();
    this.setupDoorSensorBattery();
    this.setupStationEventListener();

    this.pruneUnusedServices();
  }

  private setupGarageDoor() {
    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.CurrentDoorState,
      getValue: () => this.getDoorCurrentState(),
      onValue: (_service, characteristic) => {
        this.currentChar = characteristic;
      },
    });

    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.TargetDoorState,
      getValue: () => this.targetFromCurrent(this.getDoorCurrentState()),
      setValue: (value) => this.setDoorTargetState(value),
      onValue: (_service, characteristic) => {
        this.targetChar = characteristic;
      },
    });

    this.registerCharacteristic({
      serviceType: SERV.GarageDoorOpener,
      characteristicType: CHAR.ObstructionDetected,
      getValue: () => false,
    });
  }

  private setupDoorSensorBattery() {
    const batteryLevelProp =
      this.doorId === 1 ? PropertyName.DeviceDoorSensor1BatteryLevel : PropertyName.DeviceDoorSensor2BatteryLevel;
    const lowBatteryProp =
      this.doorId === 1 ? PropertyName.DeviceDoorSensor1LowBattery : PropertyName.DeviceDoorSensor2LowBattery;

    if (!this.device.hasProperty(batteryLevelProp)) {
      this.log.debug(`Door ${this.doorId} sensor battery properties not available`);
      return;
    }

    this.registerCharacteristic({
      serviceType: SERV.Battery,
      characteristicType: CHAR.BatteryLevel,
      getValue: () => {
        // eufy reports battery on a 0-5 scale; HomeKit expects 0-100
        const raw = this.device.getPropertyValue(batteryLevelProp) as number;
        return raw != null ? Math.round((raw / 5) * 100) : 100;
      },
    });

    if (this.device.hasProperty(lowBatteryProp)) {
      this.registerCharacteristic({
        serviceType: SERV.Battery,
        characteristicType: CHAR.StatusLowBattery,
        getValue: () => {
          const isLow = this.device.getPropertyValue(lowBatteryProp);
          return isLow ? CHAR.StatusLowBattery.BATTERY_LEVEL_LOW : CHAR.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        },
      });
    }
  }

  private async setupStationEventListener() {
    try {
      const station = await this.platform.eufyClient.getStation(this.device.getStationSerial());
      station.on('garage door status', (_station: any, _channel: number, doorId: number, status: number) => {
        if (doorId !== this.doorId) return;

        const hkState = this.mapGarageDoorState(status);
        this.doorState = hkState;
        this.log.debug(`Door ${this.doorId} status event: ${status} -> HomeKit state ${hkState}`);

        if (this.currentChar) {
          this.currentChar.updateValue(hkState);
        }
        if (this.targetChar) {
          this.targetChar.updateValue(this.targetFromCurrent(hkState));
        }
      });
    } catch (error) {
      this.log.warn(`Could not set up garage door station event listener: ${error}`);
    }
  }

  private getDoorCurrentState(): number {
    // Use cached event state only for transitional states (OPENING/CLOSING)
    // that the boolean property can't represent. For resting states, always
    // read the property so that manual/physical door changes are reflected.
    if (this.doorState === 2 || this.doorState === 3) {
      return this.doorState;
    }
    const prop = this.doorId === 1 ? PropertyName.DeviceDoor1Open : PropertyName.DeviceDoor2Open;
    const doorOpen = this.device.getPropertyValue(prop);
    return doorOpen ? 0 : 1; // true=OPEN(0), false=CLOSED(1)
  }

  private async setDoorTargetState(state: CharacteristicValue) {
    try {
      const shouldOpen = state === 0;
      this.log.debug(`Setting door ${this.doorId} target state: ${shouldOpen ? 'Open' : 'Closed'}`);
      const station = await this.platform.eufyClient.getStation(this.device.getStationSerial());
      station.openDoor(this.device, shouldOpen, this.doorId);
    } catch (error) {
      this.log.error(`Door ${this.doorId} target state could not be set: ${error}`);
    }
  }

  private mapGarageDoorState(status: number): number {
    // Negative values are standalone transitional states
    if (status < 0) {
      switch (status) {
        case GarageDoorState.A_OPENING:
        case GarageDoorState.B_OPENING:
          return 2; // OPENING
        case GarageDoorState.A_CLOSING:
        case GarageDoorState.B_CLOSING:
          return 3; // CLOSING
        default: // NO_MOTOR
          return 4; // STOPPED
      }
    }

    // Positive values are bitmasks — extract bits for this door
    if (this.doorId === 1) {
      if (status & GarageDoorState.A_OPENED) return 0; // OPEN
      if (status & GarageDoorState.A_CLOSED) return 1; // CLOSED
    } else {
      if (status & GarageDoorState.B_OPENED) return 0; // OPEN
      if (status & GarageDoorState.B_CLOSED) return 1; // CLOSED
    }

    return 4; // UNKNOWN → STOPPED
  }

  private targetFromCurrent(currentState: number): number {
    switch (currentState) {
      case 0: // OPEN
      case 2: // OPENING
        return 0; // Target: OPEN
      case 1: // CLOSED
      case 3: // CLOSING
      default:
        return 1; // Target: CLOSED
    }
  }
}
