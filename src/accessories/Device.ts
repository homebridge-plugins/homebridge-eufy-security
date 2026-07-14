import { PlatformAccessory, Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { BaseAccessory } from './BaseAccessory.js';
import { Device, PropertyName } from 'eufy-security-client';
import { CHAR, SERV } from '../utils/utils.js';

export type CharacteristicType = WithUUID<{ new (): Characteristic }>;
export type ServiceType = WithUUID<typeof Service> | Service;

export abstract class DeviceAccessory extends BaseAccessory {
  constructor(platform: EufySecurityPlatform, accessory: PlatformAccessory, device: Device) {
    super(platform, accessory, device);
  }

  /**
   * Get the current value of the "propertyName" characteristic
   */
  public getPropertyValue(characteristic: string, propertyName: PropertyName): CharacteristicValue {
    try {
      const value = this.device.getPropertyValue(propertyName);
      this.log.debug(`GET '${characteristic}' ${propertyName}: ${value}`);
      return value as CharacteristicValue;
    } catch (error) {
      this.log.debug(`Error getting '${characteristic}' ${propertyName}: ${error}`);
      return false;
    }
  }

  public async setPropertyValue(propertyName: PropertyName, value: unknown) {
    await this.platform.eufyClient.setDeviceProperty(this.SN, propertyName, value);
  }

  protected onPushNotification(
    characteristicType: CharacteristicType,
    serviceType: ServiceType,
    value: CharacteristicValue,
  ): void {
    this.log.debug(`ON '${serviceType.name}': ${value}`);
    this.getService(serviceType).getCharacteristic(characteristicType).updateValue(value);
  }

  initSensorService() {
    const propertiesToRegister = [
      {
        property: 'battery',
        characteristicType: CHAR.BatteryLevel,
        propertyName: PropertyName.DeviceBattery,
        onSimpleValue: null,
        fallback: 100,
      },
      {
        property: 'batteryLow',
        characteristicType: CHAR.StatusLowBattery,
        propertyName: PropertyName.DeviceBatteryLow,
        onSimpleValue: 'low battery',
        fallback: false,
      },
      {
        property: 'batteryIsCharging',
        characteristicType: CHAR.ChargingState,
        propertyName: PropertyName.DeviceBatteryIsCharging,
        onSimpleValue: null,
        fallback: false,
      },
    ];

    propertiesToRegister.forEach((propertyConfig) => {
      if (this.device.hasProperty(propertyConfig.property)) {
        this.registerCharacteristic({
          serviceType: SERV.Battery,
          characteristicType: propertyConfig.characteristicType,
          getValue: () => this.device.getPropertyValue(propertyConfig.propertyName) || propertyConfig.fallback,
          onSimpleValue: propertyConfig.onSimpleValue,
        });
      }
    });
  }
}
