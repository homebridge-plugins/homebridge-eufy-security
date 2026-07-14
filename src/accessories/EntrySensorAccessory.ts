import { PlatformAccessory } from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { DeviceAccessory } from './Device.js';

// @ts-ignore
import { EntrySensor, PropertyName } from 'eufy-security-client';
import { CHAR, SERV } from '../utils/utils.js';

/**
 * EntrySensorAccessory Class
 *
 * This class represents an entry sensor accessory within a home automation system. It is designed
 * to integrate entry sensors into the system, register appropriate characteristics, and provide
 * necessary functionality for monitoring the open or closed state of doors or windows.
 *
 * @class EntrySensorAccessory
 * @extends DeviceAccessory
 */
export class EntrySensorAccessory extends DeviceAccessory {
  /**
   * Constructor for EntrySensorAccessory.
   *
   * @param {EufySecurityPlatform} platform - The platform instance managing accessories.
   * @param {PlatformAccessory} accessory - The platform-specific accessory.
   * @param {EntrySensor} device - The entry sensor device being represented.
   */
  constructor(platform: EufySecurityPlatform, accessory: PlatformAccessory, device: EntrySensor) {
    // Call the constructor of the parent class DeviceAccessory.
    super(platform, accessory, device);

    // Log a debug message indicating the construction of the Entry Sensor.
    this.log.debug(`Constructed Entry Sensor`);

    // Check if the device has the 'sensorOpen' property.
    if (this.device.hasProperty('sensorOpen')) {
      // Register the Contact Sensor characteristic.
      this.registerCharacteristic({
        serviceType: SERV.ContactSensor,
        characteristicType: CHAR.ContactSensorState,
        getValue: () => this.device.getPropertyValue(PropertyName.DeviceSensorOpen),
        onSimpleValue: 'open',
      });

      // Initialize the sensor service.
      this.initSensorService();
    } else {
      // Log an error if the 'sensorOpen' property is not available for this device.
      this.log.error(`has no sensorOpen`);
    }

    // Remove any unused services.
    this.pruneUnusedServices();
  }
}
