export enum SnapshotHandlingMethod {
  /** Let the plugin decide the best method (defaults to CloudOnly) */
  Auto = 0,
  /** Always fetch a fresh snapshot from the camera (highest battery drain) */
  AlwaysFresh = 1,
  /** Return cached snapshot if recent, otherwise fetch fresh */
  Balanced = 2,
  /** Always return cached/cloud snapshot (lowest battery drain) */
  CloudOnly = 3,
}

export type CameraConfig = {
  name?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  firmwareRevision?: string;
  motion?: boolean;
  doorbell?: boolean;
  switches?: boolean;
  motionTimeout?: number;
  motionDoorbell?: boolean;
  videoConfig?: VideoConfig;
  enableButton: boolean;
  motionButton: boolean;
  lightButton: boolean;
  rtsp: boolean;
  enableCamera: boolean;
  snapshotHandlingMethod?: SnapshotHandlingMethod;
  delayCameraSnapshot?: boolean;
  audio?: boolean;
  talkback?: boolean;
  talkbackChannels?: number;
  hsvRecordingDuration?: number;
  indoorChimeButton?: boolean;
};

export const DEFAULT_CAMERACONFIG_VALUES: CameraConfig = {
  name: '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  firmwareRevision: '',
  enableButton: true,
  motionButton: true,
  lightButton: true,
  audio: true,
  talkback: false,
  talkbackChannels: 1,
  hsvRecordingDuration: 90,
  rtsp: false,
  enableCamera: true,
  snapshotHandlingMethod: SnapshotHandlingMethod.CloudOnly,
  delayCameraSnapshot: false,
  indoorChimeButton: false,
};

export type VideoConfig = {
  source?: string;
  stillImageSource?: string;
  returnAudioTarget?: string;
  analyzeDuration?: number;
  probeSize?: number;
  maxStreams?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFPS?: number;
  maxBitrate?: number;
  readRate?: boolean;
  vcodec?: string;
  acodec?: string;
  packetSize?: number;
  stimeout?: number;
  videoFilter?: string;
  encoderOptions?: string;
  audioSampleRate?: number;
  audioBitrate?: number;
  acodecHK?: string;
  acodecOptions?: string;
  debug?: boolean;
  debugReturn?: boolean;
  crop?: boolean;
  videoProcessor?: string;
};

export const DEFAULT_VIDEOCONFIG_VALUES: VideoConfig = {
  probeSize: 16384,
  vcodec: 'copy',
  acodec: 'copy',
};

import { SRTPCryptoSuites } from 'homebridge';

export type SessionInfo = {
  address: string;
  ipv6: boolean;

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites;
  videoSRTP: Buffer;
  videoSSRC: number;

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

export type StationConfig = {
  serialNumber?: string;
  hkHome: number;
  hkAway: number;
  hkNight: number;
  hkOff: number;
  manualTriggerModes: number[];
  manualAlarmSeconds: number;
};