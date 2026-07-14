// @ts-ignore
import { CharacteristicValue, PlatformAccessory } from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { DeviceAccessory } from './Device.js';
import { SmartDrop, PropertyName } from 'eufy-security-client';
import { CHAR, SERV } from '../utils/utils.js';

/**
 * SmartDropAccessory Class
 *
 * This class represents a SmartDrop accessory within a home automation system.
 * The SmartDrop is a smart package delivery box that can be remotely opened.
 * It is exposed as a LockMechanism service in HomeKit, allowing users to
 * open the SmartDrop lid from the Home app or via automation.
 *
 * Since the SmartDrop is a one-way latch (open only, closing is physical),
 * the lock mechanism is used to trigger the open command, and the current
 * state reflects whether the lid is currently open or closed.
 *
 * @class SmartDropAccessory
 * @extends DeviceAccessory
 * @see https://github.com/homebridge-plugins/homebridge-eufy-security/issues/770
 */
export class SmartDropAccessory extends DeviceAccessory {
  /**
   * Constructor for SmartDropAccessory.
   *
   * @param {EufySecurityPlatform} platform - The platform instance managing accessories.
   * @param {PlatformAccessory} accessory - The platform-specific accessory.
   * @param {SmartDrop} device - The SmartDrop device being represented.
   */
  constructor(platform: EufySecurityPlatform, accessory: PlatformAccessory, device: SmartDrop) {
    super(platform, accessory, device);

    this.log.debug(`Constructed SmartDrop`);

    // Initialize the Lock Mechanism service for open/close control.
    this.initLockMechanismService();

    // Initialize the Contact Sensor service for package delivery detection.
    this.initContactSensorService();

    // Initialize the battery service.
    this.initSensorService();

    // Prune any unused services.
    this.pruneUnusedServices();
  }

  /**
   * Initializes the Lock Mechanism Service.
   *
   * The SmartDrop lid is modeled as a lock:
   * - SECURED = lid closed
   * - UNSECURED = lid open
   * Setting the target state to UNSECURED triggers the open command.
   */
  private initLockMechanismService() {
    // LockCurrentState reflects the actual open/closed state of the lid.
    this.registerCharacteristic({
      serviceType: SERV.LockMechanism,
      characteristicType: CHAR.LockCurrentState,
      getValue: () => this.getLidStatus(),
      onValue: (service, characteristic) => {
        this.device.on('open', () => {
          characteristic.updateValue(this.getLidStatus());
        });
      },
    });

    // LockTargetState allows triggering the open command.
    this.registerCharacteristic({
      serviceType: SERV.LockMechanism,
      characteristicType: CHAR.LockTargetState,
      getValue: () => this.getLidStatus(),
      setValue: async (value) => {
        await this.setLidTargetState(value);
      },
      onValue: (service, characteristic) => {
        this.device.on('open', () => {
          characteristic.updateValue(this.getLidStatus());
        });
      },
    });
  }

  /**
   * Initializes the Contact Sensor Service.
   *
   * Exposes a contact sensor that indicates whether a package has been delivered.
   * - CONTACT_DETECTED = no package delivered (normal state)
   * - CONTACT_NOT_DETECTED = package delivered (alert state)
   */
  private initContactSensorService() {
    if (!this.device.hasProperty('packageDelivered')) {
      return;
    }

    this.registerCharacteristic({
      serviceType: SERV.ContactSensor,
      characteristicType: CHAR.ContactSensorState,
      name: 'Package Delivered',
      getValue: () => this.getPackageDeliveredStatus(),
      onSimpleValue: 'package delivered',
    });
  }

  /**
   * Gets the lid status and maps it to HomeKit lock states.
   *
   * @returns {CharacteristicValue} UNSECURED if open, SECURED if closed.
   */
  private getLidStatus(): CharacteristicValue {
    if (this.device.hasProperty('open')) {
      const isOpen = this.device.getPropertyValue(PropertyName.DeviceOpen);
      this.log.debug(`getLidStatus: ${isOpen}`);
      return isOpen ? CHAR.LockCurrentState.UNSECURED : CHAR.LockCurrentState.SECURED;
    }
    return CHAR.LockCurrentState.SECURED;
  }

  /**
   * Sets the lid target state.
   * Only the UNSECURED (open) action is meaningful for SmartDrop.
   * When set to UNSECURED, it sends the open command to the station.
   * Setting to SECURED is ignored as closing is a physical action.
   *
   * @param {CharacteristicValue} state - The target lock state.
   */
  private async setLidTargetState(state: CharacteristicValue) {
    if (state === CHAR.LockTargetState.UNSECURED) {
      try {
        this.log.info(`Opening SmartDrop lid...`);
        const station = await this.platform.eufyClient.getStation(this.device.getStationSerial());
        station.open(this.device);
      } catch (error) {
        this.log.error(`SmartDrop lid could not be opened: ${error}`);
      }
    } else {
      this.log.debug(`SmartDrop lid closing is a physical action, ignoring SECURED command.`);
    }
  }

  /**
   * Gets the package delivered status for the contact sensor.
   *
   * @returns {CharacteristicValue} CONTACT_NOT_DETECTED if package delivered, CONTACT_DETECTED otherwise.
   */
  private getPackageDeliveredStatus(): CharacteristicValue {
    const delivered = this.device.getPropertyValue(PropertyName.DevicePackageDelivered);
    this.log.debug(`getPackageDeliveredStatus: ${delivered}`);
    return delivered ? CHAR.ContactSensorState.CONTACT_NOT_DETECTED : CHAR.ContactSensorState.CONTACT_DETECTED;
  }
}
