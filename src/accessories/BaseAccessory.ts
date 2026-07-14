// Servicing and caching strategy inspired
// by homebridge-ring — https://github.com/dgreif/ring

import { PlatformAccessory, Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { DeviceType, DeviceEvents, PropertyValue, Device, Station, StationEvents } from 'eufy-security-client';
import { EventEmitter } from 'events';
import { CHAR, SERV, log } from '../utils/utils.js';
import { ILogObj, Logger } from 'tslog';

/**
 * Determine if the serviceType is an instance of Service (as opposed to a
 * Service *constructor*).  Constructors are functions, while instances are
 * objects that carry a `characteristics` array.
 *
 * @param {WithUUID<typeof Service> | Service} serviceType - The service type to be checked.
 * @returns {boolean} Returns true if the serviceType is an instance of Service, otherwise false.
 */
function isServiceInstance(serviceType: WithUUID<typeof Service> | Service): serviceType is Service {
  return typeof serviceType === 'object' && serviceType !== null && 'characteristics' in serviceType;
}

export type CharacteristicType = WithUUID<{ new (): Characteristic }>;
export type ServiceType = WithUUID<typeof Service> | Service;

export abstract class BaseAccessory extends EventEmitter {
  /**
   * Cameras accumulate many listeners (property changes, events, snapshots,
   * streaming).  Raise the limit to prevent MaxListenersExceededWarning in
   * Node 22+.
   */
  private static readonly MAX_DEVICE_LISTENERS = 30;

  /**
   * Service UUIDs managed by CameraController that must never be pruned.
   * CameraController creates these automatically during configureController()
   * and they are not tracked in servicesInUse.
   *
   * Built lazily because SERV is only available after setHap() has been called,
   * which happens after module import.
   */
  private static _cameraControllerServiceUUIDs: Set<string> | undefined;
  private static get CAMERA_CONTROLLER_SERVICE_UUIDS(): Set<string> {
    if (!BaseAccessory._cameraControllerServiceUUIDs) {
      BaseAccessory._cameraControllerServiceUUIDs = new Set([
        SERV.CameraRTPStreamManagement.UUID,
        SERV.CameraOperatingMode.UUID,
        SERV.CameraRecordingManagement.UUID,
        SERV.DataStreamTransportManagement.UUID,
        SERV.Microphone.UUID,
        SERV.Speaker.UUID,
      ]);
    }
    return BaseAccessory._cameraControllerServiceUUIDs;
  }

  protected servicesInUse: Service[];
  public readonly SN: string;
  public readonly name: string;
  public readonly log: Logger<ILogObj>;

  /**
   * Tracks characteristics with getValue for cache-based updates.
   * Values are seeded once at registration and refreshed via
   * the device's 'property changed' event (push-based).
   */
  private registeredGetters: {
    getValue: (data: any, characteristic?: Characteristic, service?: Service) => any;
    characteristic: Characteristic;
    service: Service;
    serviceTypeName: string;
    characteristicTypeName: string;
    lastValue: any;
  }[] = [];

  constructor(
    public readonly platform: EufySecurityPlatform,
    public readonly accessory: PlatformAccessory,

    public device: any,
  ) {
    super();

    this.device = device as Device | Station;

    // Share servicesInUse across all BaseAccessory instances on the same
    // PlatformAccessory so that pruneUnusedServices() won't remove services
    // registered by a sibling accessor (e.g. LockAccessory + CameraAccessory
    // on combo devices like the T8530).
    if (!(accessory as any)._servicesInUse) {
      (accessory as any)._servicesInUse = [];
    }
    this.servicesInUse = (accessory as any)._servicesInUse;

    this.SN = this.device.getSerial();
    this.name = this.device.getName();

    this.log = log.getSubLogger({
      name: '',
      prefix: [this.name],
    });

    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.Manufacturer,
      getValue: () => 'Eufy',
    });
    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.Name,
      getValue: () => this.name || 'Unknown',
    });
    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.Model,
      getValue: () => DeviceType[this.device.getDeviceType()] || 'Unknown',
    });
    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.SerialNumber,
      getValue: () => this.SN || 'Unknown',
    });
    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.FirmwareRevision,
      getValue: () => this.device.getSoftwareVersion() || 'Unknown',
    });
    this.registerCharacteristic({
      serviceType: SERV.AccessoryInformation,
      characteristicType: CHAR.HardwareRevision,
      getValue: () => this.device.getHardwareVersion() || 'Unknown',
    });

    if (typeof this.device.setMaxListeners === 'function') {
      this.device.setMaxListeners(BaseAccessory.MAX_DEVICE_LISTENERS);
    }

    if (this.platform.config.enableDetailedLogging) {
      this.device.on('raw property changed', this.handleRawPropertyChange.bind(this));
      this.device.on('property changed', this.handlePropertyChange.bind(this));
    }

    // Refresh cached characteristic values on any device property change.
    // This keeps all getValue-based characteristics up-to-date via push
    // without requiring HomeKit to poll through onGet.
    this.device.on('property changed', this.refreshCachedValues.bind(this));

    this.logDeviceProperties();
  }

  private logDeviceProperties() {
    this.log.debug(`Device Properties:`, this.device.getProperties());
  }

  /**
   * Re-evaluate every registered getValue and push updates to HomeKit
   * only when the returned value has actually changed.
   * Triggered by the device's 'property changed' event.
   */
  private refreshCachedValues(): void {
    for (const reg of this.registeredGetters) {
      try {
        const newValue = reg.getValue(undefined, reg.characteristic, reg.service);
        if (newValue !== reg.lastValue) {
          reg.lastValue = newValue;
          reg.characteristic.updateValue(newValue);
          this.log.debug(`CACHE '${reg.serviceTypeName} / ${reg.characteristicTypeName}':`, newValue);
        }
      } catch (e) {
        this.log.debug(`Cache refresh error for '${reg.serviceTypeName} / ${reg.characteristicTypeName}':`, e);
      }
    }
  }

  protected handleRawPropertyChange(device: any, type: number, value: string): void {
    this.log.debug(`Raw Property Changes:`, type, value);
  }

  protected handlePropertyChange(device: any, name: string, value: PropertyValue): void {
    this.log.debug(`Property Changes:`, name, value);
  }

  /**
   * Register characteristics for a given Homebridge service.
   *
   * This method handles the registration of Homebridge characteristics.
   * It includes optional features like value debouncing and event triggers.
   *
   * @param {Object} params - Parameters needed for registering characteristics.
   */
  protected registerCharacteristic({
    characteristicType,
    serviceType,
    getValue,
    setValue,
    onValue,
    onSimpleValue,
    onMultipleValue,
    name,
    serviceSubType,
    setValueDebounceTime = 0,
  }: {
    characteristicType: CharacteristicType;
    serviceType: ServiceType;
    serviceSubType?: string;
    name?: string;

    getValue?: (data: any, characteristic?: Characteristic, service?: Service) => any;

    setValue?: (value: any, characteristic?: Characteristic, service?: Service) => any;

    onValue?: (service: Service, characteristic: Characteristic) => any;

    onSimpleValue?: any;
    onMultipleValue?: (keyof DeviceEvents | StationEvents)[];
    setValueDebounceTime?: number;
  }) {
    this.log.debug(`REGISTER CHARACTERISTIC ${serviceType.name} / ${characteristicType.name} / ${name}`);

    const service = this.getService(serviceType, name, serviceSubType);
    const characteristic = service.getCharacteristic(characteristicType);

    this.log.debug(`REGISTER CHARACTERISTIC (${service.UUID}) / (${characteristic.UUID})`);

    if (getValue) {
      // Seed initial value and track for property-change refresh.
      // No onGet handler is registered — HomeKit uses the value set by
      // updateValue(), making polls (every ~10s) zero-cost.
      // Fresh values are pushed via 'property changed', onSimpleValue,
      // onValue, and onMultipleValue events.
      let initialValue: any;
      try {
        initialValue = getValue(undefined, characteristic, service);
        this.log.debug(`SEED '${serviceType.name} / ${characteristicType.name}':`, initialValue);
      } catch (e) {
        this.log.debug(`SEED FAIL '${serviceType.name} / ${characteristicType.name}':`, e);
      }

      this.registeredGetters.push({
        getValue,
        characteristic,
        service,
        serviceTypeName: serviceType.name || 'unknown',
        characteristicTypeName: characteristicType.name || 'unknown',
        lastValue: initialValue,
      });

      if (initialValue !== undefined && initialValue !== null) {
        characteristic.updateValue(initialValue);
      }
    }

    if (setValue && setValueDebounceTime) {
      let timeoutId: NodeJS.Timeout | null = null;

      characteristic.onSet(async (value: CharacteristicValue) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
          timeoutId = null;
          setValue(value, characteristic, service);
        }, setValueDebounceTime);
      });
    } else if (setValue) {
      characteristic.onSet(async (value: CharacteristicValue) => {
        await setValue(value, characteristic, service);
      });
    }

    if (onSimpleValue) {
      this.device.on(onSimpleValue, (device: any, value: any) => {
        this.log.info(`ON '${serviceType.name} / ${characteristicType.name} / ${onSimpleValue}':`, value);
        characteristic.updateValue(value);
      });
    }

    if (onValue) {
      this.log.debug(`ON '${serviceType.name} / ${characteristicType.name}'`);
      onValue(service, characteristic);
    }

    if (onMultipleValue) {
      // Attach the common event handler to each event type
      onMultipleValue.forEach((eventType) => {
        this.device.on(eventType as keyof any, (device: any, value: any) => {
          this.log.info(`ON '${serviceType.name} / ${characteristicType.name} / ${eventType}':`, value);
          characteristic.updateValue(value);
        });
      });
    }
  }

  /**
   * Retrieve an existing service or create a new one if it doesn't exist.
   *
   * @param {ServiceType} serviceType - The type of service to retrieve or create.
   * @param {string} [name] - The name of the service (optional).
   * @param {string} [subType] - The subtype of the service (optional).
   * @returns {Service} Returns the existing or newly created service.
   * @throws Will throw an error if there are overlapping services.
   */
  public getService(serviceType: ServiceType, name = this.name, subType?: string): Service {
    if (isServiceInstance(serviceType)) {
      return serviceType;
    }

    const existingService = subType
      ? this.accessory.getServiceById(serviceType, subType)
      : this.accessory.getService(serviceType);

    const service = existingService || this.accessory.addService(serviceType, name, subType!);

    if (existingService && existingService.displayName && name !== existingService.displayName) {
      throw new Error(
        `Overlapping services for device ${this.name} - ${name} != ${existingService.displayName} - ${serviceType}`,
      );
    }

    if (!this.servicesInUse.includes(service)) {
      this.servicesInUse.push(service);
    }

    return service;
  }

  protected pruneUnusedServices() {
    this.accessory.services.forEach((service) => {
      if (!this.servicesInUse.includes(service) && !BaseAccessory.CAMERA_CONTROLLER_SERVICE_UUIDS.has(service.UUID)) {
        this.log.debug(`Pruning unused service ${service.UUID} ${service.displayName || service.name}`);
        this.accessory.removeService(service);
      }
    });
  }
}
