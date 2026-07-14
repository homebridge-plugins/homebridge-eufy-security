import { PlatformAccessory } from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { AlarmEvent, GuardMode, Station } from 'eufy-security-client';
import { StationAccessory } from './StationAccessory.js';
import { CHAR, SERV, log } from '../utils/utils.js';

/**
 * Platform Auto Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AutoSyncStationAccessory {
  private static first: boolean = true;
  private static alarmFired: boolean = false;
  private static childs: AutoSyncStationAccessory[] = [];
  private static first_station: StationAccessory = {} as StationAccessory;

  public readonly name: string;

  protected guardModeChangeTimeout: {
    timeout: NodeJS.Timeout | null;
    delay: number;
  } = { timeout: null, delay: 5000 };

  protected static alarmFiredTimeout: {
    timeout: NodeJS.Timeout | null;
    delay: number;
  } = { timeout: null, delay: 5000 };

  constructor(
    platform: EufySecurityPlatform,
    private accessory: PlatformAccessory,
    private device: Station,
  ) {
    // Must be subsecond since station are initiated in //
    let first = false;
    if (AutoSyncStationAccessory.first) {
      AutoSyncStationAccessory.first = false;
      first = true;
    }

    this.name = this.device.getName();

    // if it's the first we do create a full station accessory and then store it
    // if not we need to fire event from Eufy to push to HK and vice versa
    if (first) {
      log.debug(`${this.accessory.displayName} Constructed First Station`);

      // Create the Station accessory
      AutoSyncStationAccessory.first_station = new StationAccessory(platform, accessory, device);

      this.device.on('guard mode', this.changeModeToAllChilds.bind(this));
      this.device.on('alarm event', this.fireAlarmToAllChilds.bind(this));
    } else {
      log.debug(`${this.accessory.displayName} Constructed Child Station`);

      // Register to Eufy event of all childs
      this.initChildEventRegister();
    }

    // Register child
    AutoSyncStationAccessory.childs.push(this);
  }

  private initChildEventRegister() {
    const first_station = AutoSyncStationAccessory.first_station;

    this.device.on('current mode', (station: Station, currentMode: number) => {
      log.debug(`FWD ${this.name} 'current mode' TO clearTimeout (${currentMode})`);
      if (this.guardModeChangeTimeout.timeout) {
        // If there's an existing timeout, clear it
        clearTimeout(this.guardModeChangeTimeout.timeout);
      }
    });

    this.device.on('alarm arm delay event', (station: Station, armDelay: number) => {
      log.debug(`FWD ${this.name} 'alarm arm delay event' TO ${first_station.name}`);
      first_station.onStationAlarmDelayedEvent(station, armDelay);
    });

    this.device.on('alarm armed event', () => {
      log.debug(`FWD ${this.name} 'alarm armed event' TO ${first_station.name}`);
      first_station.onStationAlarmArmedEvent();
    });

    this.device.on('alarm event', this.fireAlarmToAllChilds.bind(this));
  }

  /**
   * Handle requests to set the 'Security System Target State' to all childs
   */
  private changeModeToAllChilds(station: Station, guardMode: number) {
    log.info(`FWD ${this.name} 'guard mode (${GuardMode[guardMode]})' TO all the childs`);
    AutoSyncStationAccessory.childs.forEach((child, index) => {
      if (index === 0) {
        return;
      } // Already changed so do nothing for him
      child.handleSecuritySystemTargetStateSet(guardMode);
    });
  }

  /**
   * Handle requests to synchronize alarm events to all child stations.
   * @param station The station triggering the alarm event.
   * @param alarmEvent The type of alarm event.
   */
  private fireAlarmToAllChilds(station: Station, alarmEvent: AlarmEvent) {
    const first_station = AutoSyncStationAccessory.first_station;
    const manualAlarmSeconds = first_station.stationConfig.manualAlarmSeconds;

    // Log the received alarm event
    log.debug(`RECEIVED ${this.name} 'alarm event' REASON ${AlarmEvent[alarmEvent]}`);

    // Prevent looping with multiple received events
    // Reinit after manualAlarmSeconds * 4 / 5
    if (AutoSyncStationAccessory.alarmFired) {
      return;
    } else {
      AutoSyncStationAccessory.alarmFired = true;
      log.debug(
        `SET TIMEOUT ${this.name} 'alarm event' REASON ${AlarmEvent[alarmEvent]} FOR ${(manualAlarmSeconds * 4) / 5}sec`,
      );
      AutoSyncStationAccessory.alarmFiredTimeout.timeout = setTimeout(
        () => {
          AutoSyncStationAccessory.alarmFired = false;
          log.debug(`TIMEOUT ${this.name} 'alarm event' REASON ${AlarmEvent[alarmEvent]}`);
        },
        ((manualAlarmSeconds * 4) / 5) * 1000,
      );
    }

    // List of alarm events fired to stop alarm
    const pluginFiredAlarmStopEvents = [
      AlarmEvent.HUB_STOP,
      AlarmEvent.HUB_STOP_BY_APP,
      AlarmEvent.HUB_STOP_BY_HAND,
      AlarmEvent.HUB_STOP_BY_KEYPAD,
      AlarmEvent.DEV_STOP,
    ];

    // Check if the alarm event is a plugin-fired alarm stop event
    if (pluginFiredAlarmStopEvents.includes(alarmEvent)) {
      return;
    }

    const characteristic = first_station
      .getService(SERV.SecuritySystem)
      .getCharacteristic(CHAR.SecuritySystemCurrentState);

    first_station.onStationAlarmEventPushNotification(characteristic, alarmEvent);

    // Iterate over child stations to synchronize the alarm event
    AutoSyncStationAccessory.childs.forEach((child) => {
      // Check if the alarm is already handled by the child itself
      if (this.device.getSerial() === child.device.getSerial()) {
        return; // Already fired by itself so do nothing for him
      }

      // Log the forwarded alarm event along with the reason and duration
      log.debug(
        `FWD ${this.name} 'alarm event' TO ${child.name} REASON ${AlarmEvent[alarmEvent]} FOR ${manualAlarmSeconds}sec`,
      );
      // Trigger the alarm sound on the child station with the specified duration
      child.device.triggerStationAlarmSound(manualAlarmSeconds);
    });
  }

  /**
   * Handle requests to set the 'Security System Target State' characteristic
   */
  protected handleSecuritySystemTargetStateSet(mode: number) {
    try {
      log.debug(`${this.name} SET StationGuardMode Eufy: ${GuardMode[mode]}(${mode})`);

      // Call the device's setGuardMode method to initiate the action
      this.device.setGuardMode(mode);

      // Set a new timeout
      this.guardModeChangeTimeout.timeout = setTimeout(() => {
        // This code is executed when the timeout elapses, indicating that the action may not have completed yet.
        // You can include a message indicating that the action is being retried.
        log.warn(`${this.accessory.displayName} Changing guard mode to ${GuardMode[mode]} did not complete. Retry...'`);

        // Call the device's setGuardMode method to initiate the action
        this.device.setGuardMode(mode);

        // Set a secondary timeout for retry, if needed
        const retryTimeout = setTimeout(() => {
          // This code is executed if the retry also times out, indicating a failure.
          log.error(`${this.accessory.displayName} Changing guard mode to ${GuardMode[mode]} timed out!`);
        }, this.guardModeChangeTimeout.delay);

        // Store the retry timeout as part of guardModeChangeTimeout
        this.guardModeChangeTimeout.timeout = retryTimeout;
      }, this.guardModeChangeTimeout.delay);
    } catch (error) {
      log.error(`${this.name} Error Setting security mode! ${error}`);
    }
  }
}
