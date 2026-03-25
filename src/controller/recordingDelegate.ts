 
import { ChildProcessWithoutNullStreams } from 'child_process';
import { Camera, PropertyName } from 'eufy-security-client';
import {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HDSProtocolSpecificErrorReason,
  PlatformAccessory,
  RecordingPacket,
} from 'homebridge';
import { EufySecurityPlatform } from '../platform.js';
import { CameraConfig, VideoConfig } from '../utils/configTypes.js';
import { FFmpeg, FFmpegParameters } from '../utils/ffmpeg.js';
import net from 'net';
import { CHAR, SERV, isRtspReady, applyP2PAudioFormat, log, ffmpegLoggerFactory } from '../utils/utils.js';
import { LocalLivestreamManager } from './LocalLivestreamManager.js';
import { snapshotDelegate } from './snapshotDelegate.js';

const MAX_RECORDING_MINUTES = 1; // should never be used
/** Max time (ms) to wait for the next fMP4 box before considering the stream stalled. */
const SEGMENT_HEARTBEAT_TIMEOUT_MS = 10_000;
/** Minimum moof+mdat fragments before honouring motion-stopped to avoid ultra-short recordings. */
const MIN_FRAGMENTS_BEFORE_STOP = 2;

const HKSVQuitReason = [
  'Normal',
  'Not allowed',
  'Busy',
  'Cancelled',
  'Unsupported',
  'Unexpected Failure',
  'Timeout',
  'Bad data',
  'Protocol error',
  'Invalid Configuration',
];

export class RecordingDelegate implements CameraRecordingDelegate {

  private configuration?: CameraRecordingConfiguration;

  private forceStopTimeout?: NodeJS.Timeout;
  private closeReason?: number;
  private handlingStreamingRequest = false;

  private controller?: CameraController;

  private session?: {
    socket: net.Socket;
    process?: ChildProcessWithoutNullStreams;
    ffmpeg?: FFmpeg;
    generator: AsyncGenerator<{
      header: Buffer;
      length: number;
      type: string;
      data: Buffer;
    }, any, unknown>;
  };

  /** Delay before extracting a snapshot from a running HKSV recording (ms). */
  private static readonly RECORDING_SNAPSHOT_DELAY_MS = 2_000;

  constructor(
    private platform: EufySecurityPlatform,
    private accessory: PlatformAccessory,
    private camera: Camera,
    private cameraConfig: CameraConfig,
    private localLivestreamManager: LocalLivestreamManager,
    private snapshotDlg: snapshotDelegate,
  ) {

  }

  public setController(controller: CameraController) {
    this.controller = controller;
  }

  public isRecording(): boolean {
    return this.handlingStreamingRequest;
  }

  private resetMotionSensor(): void {
    const motionDetected = this.accessory
      .getService(SERV.MotionSensor)?.getCharacteristic(CHAR.MotionDetected).value;
    if (motionDetected) {
      this.accessory
        .getService(SERV.MotionSensor)?.getCharacteristic(CHAR.MotionDetected)
        .updateValue(false);
    }
  }

  private clearForceStopTimeout(): void {
    if (this.forceStopTimeout) {
      clearTimeout(this.forceStopTimeout);
      this.forceStopTimeout = undefined;
    }
  }

  private isMotionDetected(): boolean {
    return !!this.accessory
      .getService(SERV.MotionSensor)?.getCharacteristic(CHAR.MotionDetected).value;
  }

  private async configureInputSource(
    videoParams: FFmpegParameters,
    audioParams: FFmpegParameters,
  ): Promise<void> {
    if (isRtspReady(this.camera, this.cameraConfig)) {
      const url = this.camera.getPropertyValue(PropertyName.DeviceRTSPStreamUrl) as string;
      log.debug(this.camera.getName(), 'RTSP URL: ' + url);
      videoParams.setInputSource(url);
      audioParams.setInputSource(url);
    } else {
      const streamData = await this.localLivestreamManager.getLocalLiveStream();
      await videoParams.setInputStream(streamData.videostream);
      applyP2PAudioFormat(audioParams, streamData.metadata.audioCodec);
      await audioParams.setInputStream(streamData.audiostream);
    }
  }

  async * handleRecordingStreamRequest(): AsyncGenerator<RecordingPacket, any, unknown> {
    this.handlingStreamingRequest = true;
    this.closeReason = undefined;
    log.info(this.camera.getName(), 'requesting recording for HomeKit Secure Video.');

    try {
      if (!this.configuration) {
        log.error(this.camera.getName(), 'No recording configuration available. Aborting.');
        yield { data: Buffer.alloc(0), isLast: true };
        return;
      }

      const audioEnabled = this.cameraConfig.audio !== false
        && this.controller?.recordingManagement?.recordingManagementService.getCharacteristic(CHAR.RecordingAudioActive).value;
      log.debug(this.camera.getName(), `HKSV audio recording: ${audioEnabled ? 'enabled' : 'disabled'}.`);

      const videoParams = await FFmpegParameters.forVideoRecording();
      const audioParams = await FFmpegParameters.forAudioRecording();

      const videoConfig: VideoConfig = this.cameraConfig.videoConfig ?? {};
      videoParams.setupForRecording(videoConfig, this.configuration);
      audioParams.setupForRecording(videoConfig, this.configuration);

      await this.configureInputSource(videoParams, audioParams);

      // Opportunistically capture a snapshot from the HKSV recording stream
      setTimeout(() => {
        this.snapshotDlg.captureSnapshotFromActiveLivestream().catch((error) => {
          log.debug(this.camera.getName(), 'Snapshot capture from HKSV recording failed: ' + error);
        });
      }, RecordingDelegate.RECORDING_SNAPSHOT_DELAY_MS);

      const ffmpeg = new FFmpeg(
        `[${this.camera.getName()}] [HSV Recording Process]`,
        audioEnabled ? [videoParams, audioParams] : videoParams,
        ffmpegLoggerFactory.forCamera(this.camera.getSerial()),
      );

      ffmpeg.on('error', (error) => {
        log.debug(this.camera.getName(), 'HKSV recording FFmpeg error: ' + error);
      });

      this.session = await ffmpeg.startFragmentedMP4Session();

      const maxDuration = Math.min(
        this.cameraConfig.hsvRecordingDuration ?? MAX_RECORDING_MINUTES * 60,
        this.platform.config.CameraMaxLivestreamDuration,
      );

      if (maxDuration > 0) {
        this.forceStopTimeout = setTimeout(() => {
          log.warn(this.camera.getName(), `Recording force-stopped after ${maxDuration}s.`);
          this.resetMotionSensor();
        }, maxDuration * 1000);
      }

      yield* this.generateFragments(this.session!.generator);
    } catch (error) {
      if (!this.handlingStreamingRequest && this.closeReason && this.closeReason === HDSProtocolSpecificErrorReason.CANCELLED) {
        log.debug(this.camera.getName(),
          'Recording encountered an error but that is expected, as the recording was canceled beforehand. Error: ' + error);
      } else {
        log.error(this.camera.getName(), 'Error while recording: ' + error);
      }
    } finally {
      this.logCloseReason();
      this.clearForceStopTimeout();
      this.resetMotionSensor();
      this.localLivestreamManager.stopLocalLiveStream();
    }
  }

  private logCloseReason(): void {
    if (!this.closeReason) {
      return;
    }

    if (this.closeReason === HDSProtocolSpecificErrorReason.CANCELLED) {
      log.debug(this.camera.getName(), 'The recording process was canceled by the HomeKit Controller.');
    } else if (this.closeReason !== HDSProtocolSpecificErrorReason.NORMAL) {
      log.warn(
        this.camera.getName(),
        `The recording process was aborted by HSV with reason "${HKSVQuitReason[this.closeReason]}"`,
      );
    }
  }

  /**
   * Assembles fragmented MP4 boxes into HKSV-compatible recording packets.
   * Yields an initialization segment (ftyp+moov), then paired moof+mdat fragments.
   */
  private async * generateFragments(
    generator: AsyncGenerator<{ header: Buffer; length: number; type: string; data: Buffer }>,
  ): AsyncGenerator<RecordingPacket> {
    const cameraName = this.camera.getName();
    let initPending: Buffer[] = [];
    let moofBuffer: Buffer | null = null;
    let isInit = true;
    let fragmentCount = 0;
    let sentLast = false;

    let heartbeatTimer: NodeJS.Timeout | undefined;
    const resetHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        log.error(cameraName,
          `No HKSV data received for ${SEGMENT_HEARTBEAT_TIMEOUT_MS / 1000}s — stream appears stalled. Ending recording.`);
        this.handlingStreamingRequest = false;
        this.session?.socket?.destroy();
      }, SEGMENT_HEARTBEAT_TIMEOUT_MS);
    };
    resetHeartbeat();

    try {
      for await (const { header, type, data } of generator) {
        if (!this.handlingStreamingRequest) {
          log.debug(cameraName, 'Recording was ended prematurely.');
          break;
        }
        resetHeartbeat();

        if (isInit) {
          initPending.push(header, data);
          if (type === 'moov') {
            const fragment = Buffer.concat(initPending);
            initPending = [];
            isInit = false;
            log.debug(cameraName, `HKSV: Sending initialization segment, size: ${fragment.length}`);
            yield { data: fragment, isLast: false };
          }
          continue;
        }

        if (type === 'moof') {
          moofBuffer = Buffer.concat([header, data]);
        } else if (type === 'mdat' && moofBuffer) {
          const fragment = Buffer.concat([moofBuffer, header, data]);
          moofBuffer = null;
          fragmentCount++;

          const motionStopped = !this.isMotionDetected() && fragmentCount >= MIN_FRAGMENTS_BEFORE_STOP;
          const isLast = motionStopped || !this.handlingStreamingRequest;

          log.debug(cameraName, `HKSV: Fragment #${fragmentCount}, size: ${fragment.length}${isLast ? ' (final)' : ''}`);
          yield { data: fragment, isLast };

          if (isLast) {
            sentLast = true;
            log.debug(cameraName, motionStopped
              ? 'Ending recording session due to motion stopped.'
              : 'Ending recording session due to stream close.');
            break;
          }
        }
      }
      if (!sentLast && !isInit) {
        log.warn(cameraName, `HKSV: Recording ended after ${fragmentCount} fragment(s) without signalling end-of-stream to HomeKit.`);
      }
    } finally {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
    }
  }

  updateRecordingActive(active: boolean): void {
    log.info(this.camera.getName(), `HKSV recording ${active ? 'enabled' : 'disabled'} by HomeKit.`);
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    log.info(this.camera.getName(), 'Closing recording process');

    this.closeReason = reason;
    this.handlingStreamingRequest = false;

    if (this.session) {
      log.debug(this.camera.getName(), 'Stopping recording session.');
      const isCancelled = reason === HDSProtocolSpecificErrorReason.CANCELLED;

      if (isCancelled) {
        this.session.socket?.destroy();
        this.session.ffmpeg?.stop();
      } else {
        this.session.ffmpeg?.stop();
        const socket = this.session.socket;
        setTimeout(() => socket?.destroy(), 2_500);
      }
      this.session = undefined;
    } else {
      log.warn('Recording session could not be closed gracefully.');
    }

    this.clearForceStopTimeout();
    this.resetMotionSensor();
  }

  acknowledgeStream(streamId) {
    log.debug('end of recording acknowledged!');
    this.closeRecordingStream(streamId, undefined);
  }
}