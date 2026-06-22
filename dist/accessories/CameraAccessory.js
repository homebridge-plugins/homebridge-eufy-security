import { DeviceAccessory } from './Device.js';
// @ts-ignore  
import { PropertyName, CommandName } from 'eufy-security-client';
import { DEFAULT_CAMERACONFIG_VALUES } from '../utils/configTypes.js';
import { probeHardwareEncoder } from '../utils/ffmpeg.js';
import { CHAR, SERV, isRtspReady } from '../utils/utils.js';
import { StreamingDelegate } from '../controller/streamingDelegate.js';
import { RecordingDelegate } from '../controller/recordingDelegate.js';
import { PREBUFFER_DURATION_MS } from '../settings.js';
import { createServer as createHttpServer } from 'node:http';
/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class CameraAccessory extends DeviceAccessory {
    // Define the object variable to hold the boolean and timestamp
    cameraStatus;
    notificationTimeout = null;
    cameraConfig;
    hardwareTranscoding = true;
    hardwareDecoding = true;
    timeshift = false;
    hksvRecording = true;
    HksvErrors = 0;
    isOnline = true;
    rtsp_url = '';
    metadata;
    standalone = false;
    // List of event types
    eventTypesToHandle = [
        'motion detected',
        'person detected',
        'pet detected',
        'vehicle detected',
        'sound detected',
        'crying detected',
        'dog detected',
        'stranger person detected',
    ];
    streamingDelegate = null;
    recordingDelegate = null;
    resolutions = [
        [1920, 1024, 30],
        [1280, 720, 30],
        [1024, 768, 30],
        [640, 480, 30],
        [640, 360, 30],
        [480, 360, 30],
        [480, 270, 30],
        [320, 240, 30],
        [320, 240, 15], // Apple Watch requires this configuration
        [320, 180, 30],
    ];
    constructor(platform, accessory, device) {
        super(platform, accessory, device);
        this.cameraConfig = {};
        this.cameraStatus = { isEnabled: false, timestamp: 0 }; // Initialize the cameraStatus object
        this.log.debug(`Constructed Camera`);
        this.cameraConfig = this.getCameraConfig();
        const hw = probeHardwareEncoder(this.platform.hostSystem);
        this.hardwareTranscoding = hw !== null;
        this.hardwareDecoding = hw?.decoder !== undefined;
        if (hw) {
            this.log.debug(`Using hardware encoder: ${hw.encoder}`);
        }
        this.standalone = device.getSerial() === device.getStationSerial();
        this.log.debug(`Is standalone?`, this.standalone);
        if (this.cameraConfig.enableCamera) {
            this.log.debug(`has a camera: Setting up camera.`);
            this.setupCamera();
        }
        else {
            this.log.debug(`has a motion sensor: Setting up motion.`);
            this.setupMotionFunction();
        }
        this.initSensorService();
        this.setupEnableButton();
        this.setupMotionButton();
        this.setupLightButton();
        this.setupChimeButton();
        this.pruneUnusedServices();
    }
    setupCamera() {
        try {
            this.cameraFunction();
        }
        catch (error) {
            this.log.error(`while happending CameraFunction ${error}`);
        }
        // Register Doorbell service BEFORE configureVideoStream() so that
        // CameraController is aware of it when EventTriggerOption.DOORBELL
        // is set in the recording options.
        if (this.cameraConfig.doorbellHttpPort) {
            this.setupDoorbellHttpServer(this.cameraConfig.doorbellHttpPort);
        }
        try {
            this.configureVideoStream();
        }
        catch (error) {
            this.log.error(`while happending Delegate ${error}`);
        }
    }
    setupDoorbellHttpServer(port) {
        const doorbellService = this.accessory.getService(this.platform.api.hap.Service.Doorbell)
            ?? this.accessory.addService(this.platform.api.hap.Service.Doorbell, this.accessory.displayName);
        const doorbellChar = doorbellService.getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent);
        this.log.info(`Doorbell service registered via HTTP trigger on port ${port}`);
        const self = this;
        createHttpServer((req, res) => {
            if (req.url && req.url.startsWith('/doorbell')) {
                self.log.info('Doorbell HTTP trigger received');
                self.onDeviceRingsPushNotification(doorbellChar);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: false, message: `Doorbell triggered for ${self.accessory.displayName}` }));
            }
            else {
                res.writeHead(404);
                res.end();
            }
        }).listen(port, () => {
            self.log.info(`Doorbell HTTP server listening on port ${port}`);
        }).on('error', (err) => {
            self.log.error(`Doorbell HTTP server error: ${err.message}`);
        });
    }
    setupButtonService(serviceName, configValue, PropertyName, serviceType) {
        try {
            this.log.debug(`${serviceName} config:`, configValue);
            if (configValue && this.device.hasProperty(PropertyName)) {
                this.log.debug(`has a ${PropertyName}, so append ${serviceType}${serviceName} characteristic to it.`);
                this.setupSwitchService(serviceName, serviceType, PropertyName);
            }
            else {
                this.log.debug(`Looks like not compatible with ${PropertyName} or this has been disabled within configuration`);
            }
        }
        catch (error) {
            this.log.error(`raise error to check and attach ${serviceType}${serviceName}.`, error);
            throw error;
        }
    }
    setupSwitchService(serviceName, serviceType, propertyName) {
        const platformServiceMapping = {
            switch: SERV.Switch,
            lightbulb: SERV.Lightbulb,
            outlet: SERV.Outlet,
        };
        this.registerCharacteristic({
            serviceType: platformServiceMapping[serviceType] || SERV.Switch,
            characteristicType: CHAR.On,
            name: this.accessory.displayName + ' ' + serviceName,
            serviceSubType: serviceName,
            getValue: (data, characteristic) => this.getCameraPropertyValue(characteristic, propertyName),
            setValue: (value, characteristic) => this.setCameraPropertyValue(characteristic, propertyName, value),
        });
    }
    async setupEnableButton() {
        this.setupButtonService('Enabled', this.cameraConfig.enableButton, PropertyName.DeviceEnabled, 'switch');
    }
    async setupMotionButton() {
        this.setupButtonService('Motion', this.cameraConfig.motionButton, PropertyName.DeviceMotionDetection, 'switch');
    }
    async setupLightButton() {
        this.setupButtonService('Light', this.cameraConfig.lightButton, PropertyName.DeviceLight, 'lightbulb');
    }
    async setupChimeButton() {
        this.setupButtonService('IndoorChime', this.cameraConfig.indoorChimeButton, PropertyName.DeviceChimeIndoor, 'switch');
    }
    getCameraConfig() {
        const foundConfig = this.platform.config.cameras?.find(e => e.serialNumber === this.device.getSerial()) ?? {};
        const config = {
            ...DEFAULT_CAMERACONFIG_VALUES,
            ...foundConfig,
            name: this.accessory.displayName,
        };
        if (!config.videoConfig) {
            config.videoConfig = {};
        }
        config.videoConfig.debug = config.videoConfig?.debug ?? true;
        if (config.talkback && !this.device.hasCommand(CommandName.DeviceStartTalkback)) {
            this.log.warn('Talkback for this device is not supported!');
            config.talkback = false;
        }
        if (config.talkback && config.rtsp) {
            this.log.warn('Talkback cannot be used with rtsp option. Ignoring talkback setting.');
            config.talkback = false;
        }
        this.log.debug(`config is`, config);
        return config;
    }
    cameraFunction() {
        this.registerCharacteristic({
            serviceType: SERV.MotionSensor,
            characteristicType: CHAR.MotionDetected,
            getValue: () => this.device.getPropertyValue(PropertyName.DeviceMotionDetected),
            onValue: (service, characteristic) => {
                this.eventTypesToHandle.forEach(eventType => {
                    this.device.on(eventType, (device, state) => {
                        this.log.info(`MOTION DETECTED (${eventType})': ${state}`);
                        characteristic.updateValue(state);
                        if (state && this.streamingDelegate && this.recordingDelegate
                            && !this.recordingDelegate.isRecording()
                            && !isRtspReady(this.device, this.cameraConfig)) {
                            const manager = this.streamingDelegate.getLivestreamManager();
                            manager.preWarmStream().catch((err) => {
                                this.log.debug('P2P pre-warm failed (non-fatal): ' + err);
                            });
                        }
                    });
                });
            },
        });
        if (this.device.isDoorbell()) {
            this.registerCharacteristic({
                serviceType: SERV.Doorbell,
                characteristicType: CHAR.ProgrammableSwitchEvent,
                onValue: (service, characteristic) => {
                    this.device.on('rings', () => this.onDeviceRingsPushNotification(characteristic));
                },
            });
        }
    }
    setupMotionFunction() {
        this.registerCharacteristic({
            serviceType: SERV.MotionSensor,
            characteristicType: CHAR.MotionDetected,
            getValue: () => this.device.getPropertyValue(PropertyName.DeviceMotionDetected),
            onMultipleValue: this.eventTypesToHandle,
        });
        this.registerCharacteristic({
            serviceType: SERV.MotionSensor,
            characteristicType: CHAR.StatusTampered,
            getValue: () => {
                const tampered = this.device.getPropertyValue(PropertyName.DeviceEnabled);
                this.log.debug(`TAMPERED? ${!tampered}`);
                return tampered
                    ? CHAR.StatusTampered.NOT_TAMPERED
                    : CHAR.StatusTampered.TAMPERED;
            },
        });
        if (this.device.isDoorbell()) {
            this.registerCharacteristic({
                serviceType: SERV.Doorbell,
                characteristicType: CHAR.ProgrammableSwitchEvent,
                onValue: (service, characteristic) => {
                    this.device.on('rings', () => this.onDeviceRingsPushNotification(characteristic));
                },
            });
        }
    }
    getCameraPropertyValue(characteristic, propertyName) {
        try {
            const value = this.device.getPropertyValue(propertyName);
            return this.applyPropertyValue(characteristic, propertyName, value);
        }
        catch (error) {
            this.log.debug(`Error getting '${characteristic.displayName}' ${propertyName}: ${error}`);
            return false;
        }
    }
    applyPropertyValue(characteristic, propertyName, value) {
        this.log.debug(`GET '${characteristic.displayName}' ${propertyName}: ${value}`);
        if (propertyName === PropertyName.DeviceNightvision) {
            return value === 1;
        }
        if (propertyName === PropertyName.DeviceEnabled &&
            Date.now() - this.cameraStatus.timestamp <= 60000) {
            this.log.debug(`CACHED for (1 min) '${characteristic.displayName}' ${propertyName}: ${this.cameraStatus.isEnabled}`);
            value = this.cameraStatus.isEnabled;
        }
        if (characteristic.displayName === 'Manually Disabled') {
            value = !value;
            this.log.debug(`INVERSED '${characteristic.displayName}' ${propertyName}: ${value}`);
        }
        if (value === undefined) {
            throw new Error(`Value is undefined: this shouldn't happend`);
        }
        return value;
    }
    async setCameraPropertyValue(characteristic, propertyName, value) {
        try {
            this.log.debug(`SET '${characteristic.displayName}' ${propertyName}: ${value}`);
            await this.setPropertyValue(propertyName, value);
            if (propertyName === PropertyName.DeviceEnabled &&
                characteristic.displayName === 'On') {
                characteristic.updateValue(value);
                this.cameraStatus = { isEnabled: value, timestamp: Date.now() };
                characteristic = this.getService(SERV.CameraOperatingMode)
                    .getCharacteristic(CHAR.ManuallyDisabled);
                this.log.debug(`INVERSED '${characteristic.displayName}' ${propertyName}: ${!value}`);
                value = !value;
            }
            characteristic.updateValue(value);
        }
        catch (error) {
            this.log.debug(`Error setting '${characteristic.displayName}' ${propertyName}: ${error}`);
        }
    }
    onDeviceRingsPushNotification(characteristic) {
        if (!this.notificationTimeout) {
            this.log.debug(`DoorBell ringing`);
            characteristic.updateValue(CHAR.ProgrammableSwitchEvent.SINGLE_PRESS);
            this.notificationTimeout = setTimeout(() => {
                this.notificationTimeout = null;
            }, 15 * 1000);
        }
    }
    getBitrate() {
        return -1;
    }
    async setBitrate() {
        return true;
    }
    configureVideoStream() {
        this.log.debug(`configureVideoStream`);
        try {
            this.log.debug(`StreamingDelegate`);
            this.streamingDelegate = new StreamingDelegate(this);
            this.log.debug(`RecordingDelegate`);
            this.recordingDelegate = new RecordingDelegate(this.platform, this.accessory, this.device, this.cameraConfig, this.streamingDelegate.getLivestreamManager(), this.streamingDelegate.getSnapshotDelegate());
            this.log.debug(`Controller`);
            const controller = new this.platform.api.hap.CameraController(this.getCameraControllerOptions());
            this.log.debug(`streamingDelegate.setController`);
            this.streamingDelegate.setController(controller);
            this.log.debug(`recordingDelegate.setController`);
            this.recordingDelegate.setController(controller);
            this.log.debug(`configureController (${this.accessory.services.length} cached services)`);
            this.accessory.configureController(controller);
        }
        catch (error) {
            this.log.error(`configureController failed: ${error}`);
        }
        return true;
    }
    getCameraControllerOptions() {
        const option = {
            cameraStreamCount: this.cameraConfig.videoConfig?.maxStreams || 2,
            delegate: this.streamingDelegate,
            streamingOptions: {
                supportedCryptoSuites: [0 /* SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80 */],
                video: {
                    resolutions: this.resolutions,
                    codec: {
                        profiles: [0 /* H264Profile.BASELINE */, 1 /* H264Profile.MAIN */, 2 /* H264Profile.HIGH */],
                        levels: [0 /* H264Level.LEVEL3_1 */, 1 /* H264Level.LEVEL3_2 */, 2 /* H264Level.LEVEL4_0 */],
                    },
                },
                audio: {
                    twoWayAudio: this.cameraConfig.talkback,
                    codecs: [
                        {
                            type: "AAC-eld" /* AudioStreamingCodecType.AAC_ELD */,
                            samplerate: 16 /* AudioStreamingSamplerate.KHZ_16 */,
                        },
                        {
                            type: "OPUS" /* AudioStreamingCodecType.OPUS */,
                            samplerate: 16 /* AudioStreamingSamplerate.KHZ_16 */,
                        },
                    ],
                },
            },
            recording: {
                options: {
                    overrideEventTriggerOptions: [
                        1 /* EventTriggerOption.MOTION */,
                        2 /* EventTriggerOption.DOORBELL */,
                    ],
                    prebufferLength: (isRtspReady(this.device, this.cameraConfig) || this.device.hasBattery()) ? 0 : PREBUFFER_DURATION_MS,
                    mediaContainerConfiguration: [
                        {
                            type: 0 /* MediaContainerType.FRAGMENTED_MP4 */,
                            fragmentLength: 4000,
                        },
                    ],
                    video: {
                        type: 0 /* VideoCodecType.H264 */,
                        parameters: {
                            profiles: [0 /* H264Profile.BASELINE */, 1 /* H264Profile.MAIN */, 2 /* H264Profile.HIGH */],
                            levels: [0 /* H264Level.LEVEL3_1 */, 1 /* H264Level.LEVEL3_2 */, 2 /* H264Level.LEVEL4_0 */],
                        },
                        resolutions: this.resolutions,
                    },
                    audio: {
                        codecs: {
                            type: 1 /* AudioRecordingCodecType.AAC_ELD */,
                            samplerate: 2 /* AudioRecordingSamplerate.KHZ_24 */,
                            bitrateMode: 0,
                            audioChannels: 1,
                        },
                    },
                },
                delegate: this.recordingDelegate,
            },
            sensors: {
                motion: this.getService(SERV.MotionSensor),
                occupancy: undefined,
            },
        };
        return option;
    }
}
