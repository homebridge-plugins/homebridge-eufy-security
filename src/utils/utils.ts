import { Logger, ILogObj } from 'tslog';
import { ILogObjMeta } from 'tslog';
import { createStream, RotatingFileStream } from 'rotating-file-stream';

import { HAP as HAPHB } from 'homebridge';
import type { Characteristic, Service } from 'homebridge';

import { CameraConfig } from './configTypes.js';
import { AudioCodec, Camera, PropertyName } from 'eufy-security-client';
import { FFmpegParameters, hasFdkAac } from './ffmpeg.js';

export let HAP!: HAPHB;
export let SERV!: typeof Service;
export let CHAR!: typeof Characteristic;

export function setHap(hapInstance: HAPHB) {
  HAP = hapInstance;
  SERV = hapInstance.Service;
  CHAR = hapInstance.Characteristic;
}

export let log!: Logger<ILogObj>;
export let tsLogger!: Logger<ILogObj>;
export let ffmpegLogger!: Logger<ILogObj>;

const LOG_ROTATION_OPTIONS = {
  interval: '1d',
  rotate: 3,
  maxSize: '200M',
  compress: 'gzip',
} as const;

export function initLog(logOptions: ILogObj) {
  log = new Logger(logOptions);
  tsLogger = new Logger({ ...logOptions, type: 'hidden' });
  ffmpegLogger = new Logger({ ...logOptions, type: 'hidden' });
}

/**
 * Configures rotating log-file transports for the main, ffmpeg, and library
 * loggers, and initialises the per-camera ffmpeg log factory.
 *
 * Call once from the platform constructor after `initLog()` and the storage
 * directory are available.
 */
export function configureLogStreams(eufyPath: string, omitLogFiles: boolean): void {
  if (omitLogFiles) {
    log.info('log file storage will be omitted.');
    return;
  }

  const parentName = log.settings.name ?? 'EufySecurity';

  // Initialise per-camera ffmpeg log factory
  ffmpegLoggerFactory.init(eufyPath, parentName);

  // Logs that include the source-file column
  const logsWithFile = [
    { name: 'eufy-security.log', logger: log },
    { name: 'ffmpeg.log', logger: ffmpegLogger },
  ];

  // Lib logs without source-file column
  const logsWithoutFile = [
    { name: 'eufy-lib.log', logger: tsLogger },
  ];

  for (const { name, logger } of logsWithFile) {
    const logStream = createStream(name, { path: eufyPath, ...LOG_ROTATION_OPTIONS });

    logger.attachTransport((logObj: ILogObjMeta) => {
      const meta = logObj['_meta'];
      const loggerName = meta.name || parentName;
      const level = meta.logLevelName;
      const date = meta.date.toISOString();
      const fileNameWithLine = meta.path?.fileNameWithLine || '';

      let message = '';
      for (let i = 0; i <= 5; i++) {
        if (logObj[i]) {
          message += ' ' + (typeof logObj[i] === 'string' ? logObj[i] : JSON.stringify(logObj[i]));
        }
      }

      logStream.write(date + '\t' + loggerName + '\t' + level + '\t' + fileNameWithLine + '\t' + message + '\n');
    });
  }

  for (const { name, logger } of logsWithoutFile) {
    const logStream = createStream(name, { path: eufyPath, ...LOG_ROTATION_OPTIONS });

    logger.attachTransport((logObj: ILogObjMeta) => {
      const meta = logObj['_meta'];
      const loggerName = meta.name;
      const level = meta.logLevelName;
      const date = meta.date.toISOString();

      let message = '';
      for (let i = 0; i <= 5; i++) {
        if (logObj[i]) {
          message += ' ' + (typeof logObj[i] === 'string' ? logObj[i] : JSON.stringify(logObj[i]));
        }
      }

      logStream.write(date + '\t' + loggerName + '\t' + level + '\t' + message + '\n');
    });
  }
}

/**
 * Sanitise a value for use as a filename.
 * Replaces characters that are invalid on common file systems with underscores
 * and collapses consecutive underscores.
 */
function sanitiseForFilename(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Creates and manages per-camera ffmpeg log files.
 *
 * Each camera gets its own rotating log file (`ffmpeg-{serialNumber}.log`) so that
 * streaming, recording, and snapshot logs are easy to read in isolation.
 *
 * A dedicated `ffmpeg-snapshots.log` collects all snapshot-related ffmpeg output.
 */
export class FfmpegLoggerFactory {
  private readonly loggers = new Map<string, Logger<ILogObj>>();
  private readonly streams = new Map<string, RotatingFileStream>();
  private parentName?: string;

  private eufyPath?: string;

  /**
   * Initialise the factory.  Must be called once from `platform.ts` after the
   * storage directory is known.  When `omitLogFiles` is true, loggers are still
   * created (so callers don't need null-checks) but no file transport is
   * attached.
   */
  init(eufyPath: string, parentName: string) {
    this.eufyPath = eufyPath;
    this.parentName = parentName;
  }

  /** Returns true when the factory has been initialised with a storage path. */
  get initialised(): boolean {
    return this.eufyPath !== undefined;
  }

  /**
   * Get (or create) a logger that writes to `ffmpeg-{serialNumber}.log`.
   */
  forCamera(serialNumber: string): Logger<ILogObj> {
    return this.getOrCreate(`camera:${serialNumber}`, `ffmpeg-${sanitiseForFilename(serialNumber)}.log`);
  }

  /**
   * Get (or create) a logger that writes to `ffmpeg-snapshots.log`.
   */
  forSnapshots(): Logger<ILogObj> {
    return this.getOrCreate('snapshots', 'ffmpeg-snapshots.log');
  }

  private getOrCreate(key: string, filename: string): Logger<ILogObj> {
    let logger = this.loggers.get(key);
    if (logger) {
      return logger;
    }

    // Create a hidden logger (file-only, no console output)
    logger = new Logger({ type: 'hidden' });
    this.loggers.set(key, logger);

    // Attach a rotating-file transport when storage is available
    if (this.eufyPath) {
      const logStream = createStream(filename, {
        path: this.eufyPath,
        ...LOG_ROTATION_OPTIONS,
      });
      this.streams.set(key, logStream);

      const parentName = this.parentName;
      logger.attachTransport((logObj: ILogObjMeta) => {
        const meta = logObj['_meta'];
        const loggerName = meta.name || parentName || '';
        const level = meta.logLevelName;
        const date = meta.date.toISOString();
        const fileNameWithLine = meta.path?.fileNameWithLine || '';

        let message = '';
        for (let i = 0; i <= 5; i++) {
          if (logObj[i]) {
            message += ' ' + (typeof logObj[i] === 'string' ? logObj[i] : JSON.stringify(logObj[i]));
          }
        }

        logStream.write(
          date + '\t' + loggerName + '\t' + level + '\t' + fileNameWithLine + '\t' + message + '\n',
        );
      });
    }

    return logger;
  }
}

/** Singleton factory — import and use from any module. */
export const ffmpegLoggerFactory = new FfmpegLoggerFactory();

export class Deferred<T> {
  finished = false;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (error: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = (v) => { this.finished = true; resolve(v); };
    this.reject = (e) => { this.finished = true; reject(e); };
  });
}

export function isRtspReady(device: Camera, cameraConfig: CameraConfig): boolean {
  const name = device.getName();

  const checks: [boolean, string][] = [
    [!device.hasProperty('rtspStream'), 'device not compatible with RTSP'],
    [!cameraConfig.rtsp, 'RTSP not enabled in camera config'],
    [!device.getPropertyValue(PropertyName.DeviceRTSPStream), 'RTSP capability not enabled on device'],
    [!device.getPropertyValue(PropertyName.DeviceRTSPStreamUrl), 'RTSP URL is unknown'],
  ];

  for (const [failed, reason] of checks) {
    if (failed) {
      log.debug(name, reason);
      return false;
    }
  }

  return true;
}

/**
 * Configure FFmpeg input format hints for a P2P audio stream based on the
 * audio codec reported by the eufy-security-client stream metadata.
 */
export function applyP2PAudioFormat(params: FFmpegParameters, codec: AudioCodec): void {
  switch (codec) {
    case AudioCodec.AAC:
    case AudioCodec.AAC_LC:
      params.setInputFormat('aac');
      // Some cameras (e.g. SoloCam E42) send multi-RDB ADTS frames that the
      // native FFmpeg AAC decoder cannot parse.  libfdk_aac handles them fine.
      if (hasFdkAac()) {
        params.setInputCodec('libfdk_aac');
      }
      break;
    case AudioCodec.AAC_ELD:
      params.setInputFormat('aac');
      params.setInputCodec('libfdk_aac');
      break;
    case AudioCodec.NONE:
    case AudioCodec.UNKNOWN:
      break;
  }
}