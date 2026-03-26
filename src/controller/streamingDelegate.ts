import {
  AudioStreamingCodecType,
  CameraController,
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
} from 'homebridge';
import { createSocket, Socket } from 'dgram';
import { Logger, ILogObj } from 'tslog';
import { pickPort } from 'pick-port';
import { Camera, PropertyName } from 'eufy-security-client';

import { CameraAccessory } from '../accessories/CameraAccessory.js';
import { SessionInfo, VideoConfig } from '../utils/configTypes.js';
import { FFmpeg, FFmpegParameters } from '../utils/ffmpeg.js';
import { TalkbackStream } from '../utils/Talkback.js';
import { HAP, isRtspReady, applyP2PAudioFormat, ffmpegLoggerFactory } from '../utils/utils.js';
import { LocalLivestreamManager } from './LocalLivestreamManager.js';
import { snapshotDelegate } from './snapshotDelegate.js';

type ActiveSession = {
  videoProcess?: FFmpeg;
  audioProcess?: FFmpeg;
  returnProcess?: FFmpeg;
  timeout?: NodeJS.Timeout;
  graceTimeout?: NodeJS.Timeout;
  socket?: Socket;
  talkbackStream?: TalkbackStream;
};

/** Grace period (ms) before the first RTCP keep-alive is expected. */
const STREAM_INITIAL_GRACE_MS = 15_000;

export class StreamingDelegate implements CameraStreamingDelegate {

  private controller?: CameraController;

  private readonly log: Logger<ILogObj>;
  private readonly ffmpegLog: Logger<ILogObj>;

  private readonly localLivestreamManager: LocalLivestreamManager;
  private readonly snapshotDelegate: snapshotDelegate;

  // keep track of sessions
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();

  private get device(): Camera {
    return this.camera.device;
  }

  private get videoConfig(): VideoConfig {
    return this.camera.cameraConfig.videoConfig!;
  }

  constructor(
    private camera: CameraAccessory,
  ) {
    this.log = camera.log;
    this.ffmpegLog = ffmpegLoggerFactory.forCamera(camera.device.getSerial());

    this.localLivestreamManager = new LocalLivestreamManager(camera);

    this.snapshotDelegate = new snapshotDelegate(
      this.camera,
      this.localLivestreamManager,
    );
  }

  public setController(controller: CameraController) {
    this.controller = controller;
  }

  public getLivestreamManager(): LocalLivestreamManager {
    return this.localLivestreamManager;
  }

  public getSnapshotDelegate(): snapshotDelegate {
    return this.snapshotDelegate;
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.log.debug(`Snapshot requested: ${request.width}x${request.height}`);

    try {
      const snapshot = await this.snapshotDelegate.getSnapshotBufferResized(request);
      this.log.debug('Snapshot byte length: ' + snapshot?.byteLength);
      callback(undefined, snapshot);
    } catch (error) {
      this.log.error(error as string);
      callback();
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    this.log.debug(`stream prepare request with session id ${request.sessionID} was received.`);

    const [videoReturnPort, audioReturnPort] = await Promise.all([
      pickPort({ type: 'udp' }),
      pickPort({ type: 'udp' }),
    ]);

    const videoSSRC = HAP.CameraController.generateSynchronisationSource();
    const audioSSRC = HAP.CameraController.generateSynchronisationSource();

    const srtpBuffer = (m: PrepareStreamRequest['video']) => Buffer.concat([m.srtp_key, m.srtp_salt]);

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6: request.addressVersion === 'ipv6',
      videoPort: request.video.port,
      videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: srtpBuffer(request.video),
      videoSSRC,
      audioPort: request.audio.port,
      audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: srtpBuffer(request.audio),
      audioSSRC,
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);

    const response: PrepareStreamResponse = {
      video: this.buildMediaResponse(videoReturnPort, videoSSRC, request.video),
      audio: this.buildMediaResponse(audioReturnPort, audioSSRC, request.audio),
    };

    callback(undefined, response);
  }

  private buildMediaResponse(
    returnPort: number,
    ssrc: number,
    media: PrepareStreamRequest['video'],
  ): PrepareStreamResponse['video'] {
    return {
      port: returnPort,
      ssrc,
      srtp_key: media.srtp_key,
      srtp_salt: media.srtp_salt,
    };
  }

  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions.get(request.sessionID);

    if (!sessionInfo) {
      this.log.error('Error finding session information.');
      callback(new Error('Error finding session information'));
      return;
    }

    try {
      const activeSession: ActiveSession = {};

      activeSession.socket = this.createKeepAliveSocket(sessionInfo, request, activeSession);

      const { videoParams, audioParams } = await this.buildStreamParameters(sessionInfo, request);

      const isP2P = await this.configureStreamInput(videoParams, audioParams);

      // Record a parallel copy of the video stream to disk for debugging.
      // For P2P cameras, the raw recording (DebugRecordingManager) captures
      // both video+audio from the P2P feed — the file tee here would only
      // duplicate the raw video without audio. For RTSP cameras, this tee
      // is the only recording mechanism since DebugRecordingManager is P2P-only.
      if (this.camera.platform.config.debugLivestream && !isP2P) {
        const recDir = this.camera.platform.eufyPath + '/recordings';
        const recPath = videoParams.setFileRecording(recDir, this.device.getSerial());
        this.log.info(`Recording RTSP stream to ${recPath}`);
      }

      await this.startFFmpegProcesses(activeSession, videoParams, audioParams, request, callback, isP2P);

      await this.setupTalkback(activeSession, sessionInfo, request);

      this.finalizeSession(request.sessionID, activeSession);

      // Opportunistically capture a snapshot from the running livestream
      this.captureSnapshotFromLivestream();

    } catch (error) {
      this.log.error('Stream could not be started: ' + error);
      callback(error as Error);
      this.pendingSessions.delete(request.sessionID);
    }
  }

  /**
   * Creates a UDP socket that monitors RTCP keep-alive messages.
   * If no message is received within 5x the RTCP interval, the stream is considered inactive.
   */
  private createKeepAliveSocket(
    sessionInfo: SessionInfo,
    request: StartStreamRequest,
    activeSession: ActiveSession,
  ): Socket {
    const socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
    let firstMessageReceived = false;

    socket.on('error', (err: Error) => {
      this.log.error('Socket error: ' + err.message);
      this.stopStream(request.sessionID);
    });

    socket.on('message', () => {
      if (!firstMessageReceived) {
        firstMessageReceived = true;
        if (activeSession.graceTimeout) {
          clearTimeout(activeSession.graceTimeout);
          activeSession.graceTimeout = undefined;
        }
        this.log.debug('First RTCP keep-alive received — stream health monitoring active.');
      }
      if (activeSession.timeout) {
        clearTimeout(activeSession.timeout);
      }
      activeSession.timeout = setTimeout(() => {
        this.log.debug('Device appears to be inactive. Stopping video stream.');
        this.controller?.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, request.video.rtcp_interval * 5 * 1000);
    });

    // Initial grace period: warn if no RTCP arrives at all
    // (helps diagnose "stream starts but shows black screen" issues)
    activeSession.graceTimeout = setTimeout(() => {
      if (!firstMessageReceived) {
        this.log.warn(
          'No RTCP keep-alive received within initial grace period (' +
          `${STREAM_INITIAL_GRACE_MS / 1000}s). Stream may not be reaching the Home app.`,
        );
      }
    }, STREAM_INITIAL_GRACE_MS);

    socket.bind(sessionInfo.videoReturnPort);
    return socket;
  }

  /**
   * Builds FFmpeg parameters for video and (optionally) audio streams.
   */
  private async buildStreamParameters(
    sessionInfo: SessionInfo,
    request: StartStreamRequest,
  ): Promise<{ videoParams: FFmpegParameters; audioParams?: FFmpegParameters }> {
    const videoParams = await FFmpegParameters.forVideo(this.videoConfig.debug);
    videoParams.setup(this.camera.cameraConfig, request);
    videoParams.setRTPTarget(sessionInfo, request);

    const isCodecSupported = request.audio.codec === AudioStreamingCodecType.OPUS
      || request.audio.codec === AudioStreamingCodecType.AAC_ELD;

    if (!isCodecSupported) {
      this.log.warn(`An unsupported audio codec (type: ${request.audio.codec}) was requested. Audio streaming will be omitted.`);
    }

    let audioParams: FFmpegParameters | undefined;
    if (isCodecSupported && this.camera.cameraConfig.audio !== false) {
      audioParams = await FFmpegParameters.forAudio(this.videoConfig.debug);
      audioParams.setup(this.camera.cameraConfig, request);
      audioParams.setRTPTarget(sessionInfo, request);
    }

    return { videoParams, audioParams };
  }

  /**
   * Configures the input source (RTSP URL or P2P livestream) for the FFmpeg parameters.
   *
   * @returns `true` when the stream is a P2P livestream, `false` for RTSP.
   */
  private async configureStreamInput(
    videoParams: FFmpegParameters,
    audioParams?: FFmpegParameters,
  ): Promise<boolean> {
    if (isRtspReady(this.device, this.camera.cameraConfig)) {
      const url = this.device.getPropertyValue(PropertyName.DeviceRTSPStreamUrl) as string;
      this.log.debug('RTSP URL: ' + url);
      videoParams.setInputSource(url);
      audioParams?.setInputSource(url);
      return false;
    }

    this.log.debug(
      `Using P2P local livestream for ${this.device.getName()} ` +
      `(serial: ${this.device.getSerial()}, type: ${this.device.getDeviceType()})`,
    );
    const streamData = await this.localLivestreamManager.getLocalLiveStream();
    this.log.debug('Livestream obtained successfully. Setting up FFmpeg input streams...');
    await videoParams.setInputStream(streamData.videostream);
    if (audioParams) {
      applyP2PAudioFormat(audioParams, streamData.metadata.audioCodec);
      await audioParams.setInputStream(streamData.audiostream);
    }
    this.log.debug('FFmpeg input streams configured.');
    return true;
  }

  /** Delay before extracting a snapshot from a running livestream (ms). */
  private static readonly LIVESTREAM_SNAPSHOT_DELAY_MS = 2_000;

  /** Grace period for a P2P audio process before it is killed for inactivity (ms). */
  private static readonly P2P_AUDIO_TIMEOUT_MS = 8_000;

  /**
   * Starts the video (and optionally separate audio) FFmpeg processes.
   *
   * For P2P streams the video and audio inputs arrive on separate TCP
   * connections.  Some camera models advertise an audio codec in their
   * stream metadata but never deliver any audio data.  When video and
   * audio share a single FFmpeg process the stalled audio input blocks
   * video output, causing HomeKit to time out the stream.
   *
   * To prevent that, P2P streams always use separate FFmpeg processes:
   * the video process starts immediately and independently of the audio
   * process.  If the audio process fails to produce output within
   * {@link P2P_AUDIO_TIMEOUT_MS} it is killed silently so that resources
   * are not wasted on a stalled input.
   */
  private async startFFmpegProcesses(
    activeSession: ActiveSession,
    videoParams: FFmpegParameters,
    audioParams: FFmpegParameters | undefined,
    request: StartStreamRequest,
    callback: StreamRequestCallback,
    isP2P = false,
  ): Promise<void> {
    const videoProcess = new FFmpeg(
      '[Video Process]',
      !isP2P && audioParams ? [videoParams, audioParams] : videoParams,
      this.ffmpegLog,
    );
    videoProcess.on('started', () => callback());
    videoProcess.on('error', (error) => {
      this.log.error('Video process ended with error: ' + error);
      this.stopStream(request.sessionID);
    });
    activeSession.videoProcess = videoProcess;
    await videoProcess.start();

    if (isP2P && audioParams) {
      const audioProcess = new FFmpeg('[Audio Process]', audioParams, this.ffmpegLog);

      if (isP2P) {
        // For P2P, audio failure must not tear down the video stream.
        // Set up a timeout: if FFmpeg never reports progress (i.e. the
        // camera is not providing audio data), kill the process early.
        let audioStarted = false;
        const audioTimeout = setTimeout(() => {
          if (!audioStarted) {
            this.log.warn(
              `No audio data received from ${this.device.getName()} — ` +
              'killing audio process (video continues).',
            );
            audioProcess.stop();
            activeSession.audioProcess = undefined;
          }
        }, StreamingDelegate.P2P_AUDIO_TIMEOUT_MS);

        audioProcess.on('started', () => {
          audioStarted = true;
          clearTimeout(audioTimeout);
        });

        audioProcess.on('error', (error) => {
          clearTimeout(audioTimeout);
          if (audioStarted) {
            // Audio was working but failed mid-stream — log but keep video.
            this.log.warn('P2P audio process ended unexpectedly: ' + error);
          }
          activeSession.audioProcess = undefined;
        });
      } else {
        audioProcess.on('error', (error) => {
          this.log.error('Audio process ended with error: ' + error);
          this.stopStream(request.sessionID);
        });
      }

      activeSession.audioProcess = audioProcess;
      await audioProcess.start();
    }
  }

  /**
   * Sets up talkback (return audio) if enabled in the camera config.
   *
   * The pipeline: HomeKit SRTP → FFmpeg (decode & re-encode to AAC ADTS)
   * → TalkbackStream → eufy P2P talkback channel.
   */
  private async setupTalkback(
    activeSession: ActiveSession,
    sessionInfo: SessionInfo,
    request: StartStreamRequest,
  ): Promise<void> {
    if (!this.camera.cameraConfig.talkback) {
      return;
    }

    const talkbackParams = await FFmpegParameters.forAudio(this.videoConfig.debug);
    await talkbackParams.setTalkbackInput(sessionInfo, request);

    if (this.camera.cameraConfig.talkbackChannels) {
      talkbackParams.setTalkbackChannels(this.camera.cameraConfig.talkbackChannels);
    }

    activeSession.talkbackStream = new TalkbackStream(
      this.camera.platform,
      this.device,
      this.log,
    );
    activeSession.returnProcess = new FFmpeg('[Talkback Process]', talkbackParams, this.ffmpegLog);
    activeSession.returnProcess.on('error', (error) => {
      this.log.error('Talkback process ended with error: ' + error);
    });
    await activeSession.returnProcess.start();
    activeSession.returnProcess.stdout?.pipe(activeSession.talkbackStream);
  }

  /**
   * Transfers session from pending to ongoing, or stops it immediately if it was cancelled.
   */
  private finalizeSession(sessionId: string, activeSession: ActiveSession): void {
    const pendingSession = this.pendingSessions.get(sessionId);
    this.ongoingSessions.set(sessionId, activeSession);

    if (pendingSession) {
      this.pendingSessions.delete(sessionId);
    } else {
      this.log.info('Session was cancelled before start completed. Stopping immediately.');
      this.stopStream(sessionId);
    }
  }

  /**
   * Captures a snapshot from the currently running livestream after a brief
   * delay to allow the stream to produce stable frames.
   */
  private captureSnapshotFromLivestream(): void {
    setTimeout(() => {
      this.snapshotDelegate.captureSnapshotFromActiveLivestream().catch((error) => {
        this.log.debug('Snapshot capture from livestream failed: ' + error);
      });
    }, StreamingDelegate.LIVESTREAM_SNAPSHOT_DELAY_MS);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.log.debug(`Received request to start stream with id ${request.sessionID}`, request);
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(
          `Reconfigure request: ${request.video.width}x${request.video.height}, ` +
          `${request.video.fps} fps, ${request.video.max_bit_rate} kbps (Ignored)`,
        );
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.log.debug('Receive Apple HK Stop request', request);
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  public stopStream(sessionId: string): void {
    this.log.debug('Stopping session with id: ' + sessionId);

    this.pendingSessions.delete(sessionId);

    const session = this.ongoingSessions.get(sessionId);
    if (!session) {
      this.log.debug('No session to stop.');
      return;
    }

    if (session.timeout) {
      clearTimeout(session.timeout);
    }
    if (session.graceTimeout) {
      clearTimeout(session.graceTimeout);
    }

    const cleanupSteps: Array<[string, () => void]> = [
      ['returnAudio FFmpeg process', () => {
        session.talkbackStream?.stopTalkbackStream();
        session.returnProcess?.stdout?.unpipe();
        session.returnProcess?.stop();
      }],
      ['video FFmpeg process', () => session.videoProcess?.stop()],
      ['audio FFmpeg process', () => session.audioProcess?.stop()],
      ['socket', () => session.socket?.close()],
      ['Eufy Station livestream', () => {
        if (!isRtspReady(this.device, this.camera.cameraConfig)) {
          this.localLivestreamManager.stopLocalLiveStream();
        }
      }],
    ];

    for (const [label, cleanup] of cleanupSteps) {
      try {
        cleanup();
      } catch (error) {
        this.log.error(`Error occurred terminating ${label}: ${error}`);
      }
    }

    this.ongoingSessions.delete(sessionId);
    this.log.info('Stopped video stream.');
  }
}