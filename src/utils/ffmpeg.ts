// Node built-ins
import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'child_process';
import EventEmitter from 'events';
import { mkdirSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';

// External packages
import ffmpegPath from 'ffmpeg-for-homebridge';
import {
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  CameraRecordingConfiguration,
  H264Level,
  H264Profile,
  ReconfigureStreamRequest,
  SnapshotRequest,
  StartStreamRequest,
  SRTPCryptoSuites,
} from 'homebridge';
import { pickPort } from 'pick-port';

// Internal modules
import { ILogObj, Logger } from 'tslog';
import { CameraConfig, SessionInfo, VideoConfig } from './configTypes.js';
import { ffmpegLogger } from './utils.js';

/** Timeout for one-shot TCP servers waiting for a connection (ms) */
const TCP_SERVER_TIMEOUT_MS = 30_000;
/** Timeout for ffmpeg getResult() before force-killing the process (ms) */
const PROCESS_RESULT_TIMEOUT_MS = 15_000;
/** Grace period after SIGTERM before sending SIGKILL (ms) */
const KILL_GRACE_PERIOD_MS = 2_000;
/** Maximum allowed fMP4 box size (50 MB). Anything larger is likely corruption. */
const MAX_FRAG_BOX_SIZE = 50 * 1024 * 1024;

/** Returns true when the value is a non-empty string (guards `undefined | ''`). */
function isNonEmpty(value: string | undefined): value is string {
  return !!value && value !== '';
}

/**
 * Cached result of probing the ffmpeg binary for libfdk_aac support.
 * `undefined` means we haven't checked yet.
 */
let _hasFdkAac: boolean | undefined;

/**
 * Returns true when the ffmpeg binary on this system supports the libfdk_aac
 * encoder.  The result is cached after the first call.
 */
export function hasFdkAac(): boolean {
  if (_hasFdkAac !== undefined) {
    return _hasFdkAac;
  }
  const ffmpegExec: string = (ffmpegPath as unknown as string) || 'ffmpeg';
  try {
    const output = execFileSync(ffmpegExec, ['-encoders'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _hasFdkAac = output.includes('libfdk_aac');
  } catch {
    _hasFdkAac = false;
  }
  if (_hasFdkAac) {
    ffmpegLogger.info('libfdk_aac encoder available.');
  } else {
    ffmpegLogger.warn(
      'libfdk_aac encoder is NOT available — falling back to the native aac encoder (AAC-LC instead of AAC-ELD). ' +
        'This usually means the ffmpeg-for-homebridge binary could not be installed on your platform. ' +
        'You can install a compatible ffmpeg manually (built with --enable-libfdk-aac --enable-nonfree) ' +
        "and set the path in your camera's videoConfig.videoProcessor setting.",
    );
  }
  return _hasFdkAac;
}

/** Description of a detected hardware encoder. */
export interface HardwareEncoder {
  encoder: string;
  decoder?: string;
  hwaccel?: string;
  /** Encoder-specific options (replaces libx264's `-preset`/`-tune`). */
  customOptions: string;
}

/** Cached result: `undefined` = not yet probed, `null` = no hardware encoder found. */
let _hwEncoder: HardwareEncoder | null | undefined;

/**
 * Probes for hardware H.264 encoders by running a real test encode.
 * Result is cached after the first call. Call early at platform init.
 */
export function probeHardwareEncoder(hostSystem: string): HardwareEncoder | null {
  if (_hwEncoder !== undefined) return _hwEncoder;

  const ffmpegExec: string = (ffmpegPath as unknown as string) || 'ffmpeg';

  const candidates: Array<{
    systems: string[];
    encoder: string;
    decoder?: string;
    hwaccel?: string;
    options: string;
  }> = [
    {
      systems: ['macOS.Apple', 'macOS.Intel'],
      encoder: 'h264_videotoolbox',
      hwaccel: 'videotoolbox',
      options: '-allow_sw 1 -realtime 1',
    },
    {
      systems: ['raspbian'],
      encoder: 'h264_v4l2m2m',
      options: '',
    },
    {
      systems: ['generic', 'raspbian'],
      encoder: 'h264_vaapi',
      hwaccel: 'vaapi',
      options: '',
    },
    {
      systems: ['generic'],
      encoder: 'h264_qsv',
      hwaccel: 'qsv',
      options: '-preset veryfast',
    },
  ];

  const toTry = candidates.filter((c) => c.systems.includes(hostSystem) || c.systems.includes('generic'));

  for (const candidate of toTry) {
    try {
      // Include candidate-specific options (e.g. `-allow_sw 1` for VideoToolbox)
      // so the probe reflects actual encoding conditions.
      const extraArgs = candidate.options ? candidate.options.split(/\s+/) : [];
      execFileSync(
        ffmpegExec,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=black:s=64x64:d=0.1',
          '-c:v',
          candidate.encoder,
          ...extraArgs,
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      _hwEncoder = {
        encoder: candidate.encoder,
        decoder: candidate.decoder,
        hwaccel: candidate.hwaccel,
        customOptions: candidate.options,
      };
      ffmpegLogger.info(`Hardware encoder detected and validated: ${candidate.encoder}`);
      return _hwEncoder;
    } catch {
      // This encoder doesn't work — try next candidate
    }
  }

  _hwEncoder = null;
  ffmpegLogger.info(
    'No hardware H.264 encoder available — using software encoding (libx264). ' +
      'If running in Docker, make sure hardware devices are exposed to the container ' +
      '(e.g. --device /dev/dri for VAAPI, --device /dev/video* for V4L2).',
  );
  return _hwEncoder;
}

/**
 * Returns the preferred AAC encoder and codec options for AAC-ELD output.
 * Falls back to the built-in `aac` encoder when `libfdk_aac` is absent.
 */
function getAacEldCodecAndOptions(): { codec: string; codecOptions: string } {
  if (hasFdkAac()) {
    return { codec: 'libfdk_aac', codecOptions: '-profile:a aac_eld' };
  }
  // The native aac encoder doesn't support ELD, but LC works with HomeKit.
  return { codec: 'aac', codecOptions: '-profile:a aac_low' };
}

/**
 * Returns the preferred AAC encoder for a given recording codec type.
 * Falls back to the built-in `aac` encoder when `libfdk_aac` is absent.
 */
function getAacRecordingCodecAndOptions(codecType: AudioRecordingCodecType): { codec: string; codecOptions: string } {
  const isLC = codecType === AudioRecordingCodecType.AAC_LC;
  if (hasFdkAac()) {
    return {
      codec: 'libfdk_aac',
      codecOptions: isLC ? '-profile:a aac_low' : '-profile:a aac_eld',
    };
  }
  return {
    codec: 'aac',
    codecOptions: '-profile:a aac_low',
  };
}

/** Map HomeKit audio samplerate enum values to kHz strings for ffmpeg `-ar`. */
const SAMPLERATE_MAP: ReadonlyMap<AudioRecordingSamplerate, string> = new Map([
  [AudioRecordingSamplerate.KHZ_8, '8'],
  [AudioRecordingSamplerate.KHZ_16, '16'],
  [AudioRecordingSamplerate.KHZ_24, '24'],
  [AudioRecordingSamplerate.KHZ_32, '32'],
  [AudioRecordingSamplerate.KHZ_44_1, '44.1'],
  [AudioRecordingSamplerate.KHZ_48, '48'],
]);

/**
 * Creates a TCP server that accepts exactly one connection, then auto-closes.
 * If no connection arrives within the timeout, the server closes anyway.
 * @returns The port the server is listening on.
 */
async function createOneShotTcpServer(
  onConnection: (socket: net.Socket) => void,
  existingPort?: number,
): Promise<{ port: number; server: net.Server }> {
  const port = existingPort ?? (await pickPort({ type: 'tcp' }));
  // eslint-disable-next-line prefer-const
  let killTimeout: NodeJS.Timeout | undefined;

  const server = net.createServer((socket) => {
    if (killTimeout) {
      clearTimeout(killTimeout);
    }
    server.close();
    socket.on('error', () => {}); // ignore — handled elsewhere
    onConnection(socket);
  });

  server.on('error', () => {}); // ignore — handled elsewhere

  killTimeout = setTimeout(() => {
    server.close();
  }, TCP_SERVER_TIMEOUT_MS);

  server.listen(port);
  return { port, server };
}

class FFmpegProgress extends EventEmitter {
  private started = false;

  private constructor() {
    super();
  }

  static async create(port: number): Promise<FFmpegProgress> {
    const instance = new FFmpegProgress();
    const { server } = await createOneShotTcpServer((socket) => {
      socket.on('data', instance.analyzeProgress.bind(instance));
    }, port);
    server.on('close', () => instance.emit('progress stopped'));
    return instance;
  }

  private analyzeProgress(progressData: Buffer) {
    const progress = new Map<string, string>();
    progressData
      .toString()
      .split(/\r?\n/)
      .forEach((line) => {
        const split = line.split('=', 2);
        if (split.length !== 2) {
          return;
        }
        progress.set(split[0], split[1]);
      });

    if (!this.started) {
      if (progress.get('progress') !== undefined) {
        this.started = true;
        this.emit('progress started');
      }
    }
  }
}

/**
 * Build an AAC AudioSpecificConfig hex string for the SDP fmtp line.
 * This replaces the previously hardcoded `F8F0212C00BC00` which was
 * only valid for AAC-ELD at 16 kHz mono.
 *
 * AudioSpecificConfig structure (ISO 14496-3):
 *   audioObjectType (5 bits) — 39 for AAC-ELD
 *   samplingFrequencyIndex (4 bits)
 *   channelConfiguration (4 bits)
 *   ELD-specific config follows
 */
function buildAacEldAudioSpecificConfig(sampleRateKHz: number, channels: number): string {
  // Sampling frequency index lookup (ISO 14496-3 Table 1.18)
  const sampleRateHz = sampleRateKHz * 1000;
  // AAC-ELD = audioObjectType 39 (5-bit overflow: write 31 then 8 more bits for 39-32=7)
  // Bit layout: 11111 | 00000111 | freqIndex(4) | channels(4) | ELD-specific...
  // The ELD-specific config for basic ELD (no SBR): frameLengthFlag=0, aacSectionDataResilienceFlag=0, etc.
  // For simplicity and compatibility, use known-good configs per sample rate
  const configs: Record<number, Record<number, string>> = {
    8000: { 1: 'F8E85C00' },
    16000: { 1: 'F8F0212C00BC00', 2: 'F8F0612C00BC00' },
    24000: { 1: 'F8EC212C00BC00', 2: 'F8EC612C00BC00' },
  };

  const config = configs[sampleRateHz]?.[channels];
  if (!config) {
    ffmpegLogger.warn(
      `No AAC-ELD AudioSpecificConfig for ${sampleRateKHz} kHz / ${channels} ch — ` +
        'falling back to 16 kHz mono. Return audio may not work correctly.',
    );
  }
  return config ?? configs[16000][1];
}

/** Build an SDP session description for AAC-ELD return audio from HomeKit. */
function buildAacEldSdp(
  ipVer: string,
  sessionInfo: SessionInfo,
  payloadType: number,
  sampleRateKHz: number,
  channels: number,
  maxBitrate: number,
  srtpSuite: string,
): string {
  const sampleRateHz = sampleRateKHz * 1000;
  const config = buildAacEldAudioSpecificConfig(sampleRateKHz, channels);

  return (
    'v=0\r\n' +
    `o=- 0 0 IN ${ipVer} ${sessionInfo.address}\r\n` +
    's=Talk\r\n' +
    `c=IN ${ipVer} ${sessionInfo.address}\r\n` +
    't=0 0\r\n' +
    `m=audio ${sessionInfo.audioReturnPort} RTP/AVP ${payloadType}\r\n` +
    `b=AS:${maxBitrate}\r\n` +
    `a=rtpmap:${payloadType} MPEG4-GENERIC/${sampleRateHz}/${channels}\r\n` +
    'a=rtcp-mux\r\n' +
    `a=fmtp:${payloadType} ` +
    `profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; ` +
    `config=${config}\r\n` +
    `a=crypto:1 ${srtpSuite} inline:${sessionInfo.audioSRTP.toString('base64')}\r\n`
  );
}

/** Build an SDP session description for Opus return audio from HomeKit. */
function buildOpusSdp(
  ipVer: string,
  sessionInfo: SessionInfo,
  payloadType: number,
  sampleRateKHz: number,
  channels: number,
  maxBitrate: number,
  srtpSuite: string,
): string {
  // Opus in RTP always uses 48000 Hz clock rate (RFC 7587), regardless of actual sample rate
  const clockRate = 48000;

  return (
    'v=0\r\n' +
    `o=- 0 0 IN ${ipVer} ${sessionInfo.address}\r\n` +
    's=Talk\r\n' +
    `c=IN ${ipVer} ${sessionInfo.address}\r\n` +
    't=0 0\r\n' +
    `m=audio ${sessionInfo.audioReturnPort} RTP/AVP ${payloadType}\r\n` +
    `b=AS:${maxBitrate}\r\n` +
    `a=rtpmap:${payloadType} opus/${clockRate}/${channels}\r\n` +
    'a=rtcp-mux\r\n' +
    `a=fmtp:${payloadType} minptime=10;useinbandfec=1;sprop-maxcapturerate=${sampleRateKHz * 1000}${channels === 2 ? ';sprop-stereo=1' : ''}\r\n` +
    `a=crypto:1 ${srtpSuite} inline:${sessionInfo.audioSRTP.toString('base64')}\r\n`
  );
}

export class FFmpegParameters {
  public progressPort: number;
  public debug: boolean;

  // default parameters
  processor?: string;
  private hideBanner = true;
  private useWallclockAsTimestamp = true;

  private inputSource = '-i pipe:';
  private protocolWhitelist?: string;
  private inputCodec?: string;
  private inputFormat?: string;
  private output = 'pipe:1';

  public isVideo: boolean;
  public isAudio: boolean;
  public isSnapshot: boolean;

  // generic options
  private analyzeDuration?: number;
  private probeSize?: number;
  private stimeout?: number;
  private readrate?: boolean;
  private codec = 'copy';
  private codecOptions?: string;
  private bitrate?: number;

  // output options
  private payloadType?: number;
  private ssrc?: number;
  private srtpSuite?: string;
  private srtpParams?: string;
  private format?: string;

  // video options
  private fps?: number;
  private pixFormat?: string;
  private colorRange?: string;
  private filters?: string;
  private width?: number;
  private height?: number;
  private bufsize?: number;
  private maxrate?: number;
  private crop = false;

  // audio options
  private sampleRate?: number | string;
  private channels?: number;
  private flagsGlobalHeader = false;

  // snapshot options
  private numberFrames?: number;
  private delaySnapshot = false;

  // recording options / fragmented mp4
  private movflags?: string;
  private maxMuxingQueueSize?: number;
  private iFrameInterval?: number;
  private processAudio = true;

  // debug file recording (parallel copy of stream to disk)
  public fileRecordingPath?: string;

  private constructor(port: number, isVideo: boolean, isAudio: boolean, isSnapshot: boolean, debug = false) {
    this.progressPort = port;
    this.isVideo = isVideo;
    this.isAudio = isAudio;
    this.isSnapshot = isSnapshot;
    this.debug = debug;
  }

  /** Allocate a progress port and construct an instance. */
  private static async create(
    isVideo: boolean,
    isAudio: boolean,
    isSnapshot: boolean,
    debug: boolean,
  ): Promise<FFmpegParameters> {
    const port = await pickPort({ type: 'tcp' });
    return new FFmpegParameters(port, isVideo, isAudio, isSnapshot, debug);
  }

  static async forAudio(debug = false): Promise<FFmpegParameters> {
    const ffmpeg = await FFmpegParameters.create(false, true, false, debug);
    ffmpeg.useWallclockAsTimestamp = false;
    ffmpeg.flagsGlobalHeader = true;
    return ffmpeg;
  }

  static async forVideo(debug = false): Promise<FFmpegParameters> {
    return FFmpegParameters.create(true, false, false, debug);
  }

  static async forSnapshot(debug = false): Promise<FFmpegParameters> {
    const ffmpeg = await FFmpegParameters.create(false, false, true, debug);
    ffmpeg.useWallclockAsTimestamp = false;
    ffmpeg.numberFrames = 1;
    ffmpeg.format = 'image2';
    return ffmpeg;
  }

  static async forVideoRecording(debug = false): Promise<FFmpegParameters> {
    const ffmpeg = await FFmpegParameters.create(true, false, false, debug);
    ffmpeg.useWallclockAsTimestamp = true;
    return ffmpeg;
  }

  static async forAudioRecording(debug = false): Promise<FFmpegParameters> {
    return FFmpegParameters.create(false, true, false, debug);
  }

  public setResolution(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  public usesStdInAsInput(): boolean {
    return this.inputSource === '-i pipe:';
  }

  public setInputSource(value: string) {
    this.inputSource = `-i ${value}`;
  }

  public setInputFormat(value: string) {
    this.inputFormat = value;
  }

  public setInputCodec(value: string) {
    this.inputCodec = value;
  }

  public async setInputStream(input: Readable) {
    const { port } = await createOneShotTcpServer((socket) => {
      // Manual backpressure handling instead of pipe() — prevents
      // unbounded memory growth when FFmpeg is slower than the camera
      // (common on Raspberry Pi during HKSV transcoding).
      socket.on('drain', () => input.resume());

      input.on('data', (chunk: Buffer) => {
        if (!socket.write(chunk)) {
          input.pause();
        }
      });

      input.on('end', () => socket.end());
      input.on('error', () => socket.destroy());
      socket.on('error', () => {
        if (!input.destroyed) input.destroy();
      });
      socket.on('close', () => {
        if (!input.destroyed) input.destroy();
      });
    });
    this.setInputSource(`tcp://127.0.0.1:${port}`);
  }

  public setDelayedSnapshot() {
    this.delaySnapshot = true;
  }

  public setup(
    cameraConfig: CameraConfig,
    request: StartStreamRequest | ReconfigureStreamRequest | SnapshotRequest | undefined,
  ) {
    const videoConfig = (cameraConfig.videoConfig ??= {});
    if (isNonEmpty(videoConfig.videoProcessor)) {
      this.processor = videoConfig.videoProcessor;
    }
    if (videoConfig.readRate) {
      this.readrate = videoConfig.readRate;
    }
    if (videoConfig.stimeout) {
      this.stimeout = videoConfig.stimeout;
    }
    if (videoConfig.probeSize) {
      this.probeSize = videoConfig.probeSize;
    }
    if (videoConfig.analyzeDuration) {
      this.analyzeDuration = videoConfig.analyzeDuration;
    }

    if (this.isVideo) {
      const req = request as StartStreamRequest | ReconfigureStreamRequest;
      if (isNonEmpty(videoConfig.vcodec)) {
        this.codec = videoConfig.vcodec;
      } else {
        const hw = probeHardwareEncoder('generic');
        this.codec = hw?.encoder ?? 'libx264';
      }
      if (this.codec !== 'copy') {
        this.fps = videoConfig.maxFPS ?? req.video.fps;
        const bitrate = videoConfig.maxBitrate ?? req.video.max_bit_rate;
        this.bitrate = bitrate;
        this.bufsize = bitrate * 2;
        this.maxrate = bitrate;

        // Resolve H.264 profile & level from the HomeKit request.
        const startReq = request as StartStreamRequest;
        const profile =
          startReq.video.profile === H264Profile.HIGH
            ? 'high'
            : startReq.video.profile === H264Profile.MAIN
              ? 'main'
              : 'baseline';
        const level =
          startReq.video.level === H264Level.LEVEL4_0
            ? '4.0'
            : startReq.video.level === H264Level.LEVEL3_2
              ? '3.2'
              : '3.1';

        if (isNonEmpty(videoConfig.encoderOptions)) {
          this.codecOptions = videoConfig.encoderOptions;
        } else if (this.codec === 'libx264') {
          this.codecOptions = `-preset ultrafast -tune zerolatency -profile:v ${profile} -level:v ${level}`;
        } else {
          const hw = probeHardwareEncoder('generic');
          const hwOpts = hw && this.codec === hw.encoder ? hw.customOptions : '';
          this.codecOptions = `${hwOpts} -profile:v ${profile} -level:v ${level}`.trim();
        }
        this.pixFormat = 'yuv420p';
        this.colorRange = 'mpeg';
        this.applyVisualConfig(req.video.width, req.video.height, videoConfig);
      }
    }
    if (this.isAudio) {
      const req = request as StartStreamRequest;
      let codec: string;
      let codecOptions: string;
      switch (req.audio.codec) {
        case AudioStreamingCodecType.OPUS:
          codec = 'libopus';
          codecOptions = '-application lowdelay';
          break;
        default: {
          const aac = getAacEldCodecAndOptions();
          codec = aac.codec;
          codecOptions = aac.codecOptions;
          break;
        }
      }

      if (isNonEmpty(videoConfig.acodec)) {
        codec = videoConfig.acodec;
        codecOptions = '';
      }
      if (videoConfig.acodecOptions !== undefined) {
        codecOptions = videoConfig.acodecOptions;
      }
      if (this.flagsGlobalHeader) {
        if (codecOptions !== '') {
          codecOptions += ' ';
        }
        codecOptions += '-flags +global_header';
      }
      this.codec = codec;
      this.codecOptions = codecOptions;
      if (this.codec !== 'copy') {
        this.sampleRate = req.audio.sample_rate;
        this.channels = req.audio.channel;
        this.bitrate = videoConfig.audioBitrate ? videoConfig.audioBitrate : req.audio.max_bit_rate;
      }
    }
    if (this.isSnapshot) {
      const req = request as SnapshotRequest;
      this.applyVisualConfig(req.width, req.height, videoConfig);
    }
  }

  public setRTPTarget(sessionInfo: SessionInfo, request: StartStreamRequest) {
    const isVideo = this.isVideo;
    const mediaRequest = isVideo ? request.video : request.audio;
    const port = isVideo ? sessionInfo.videoPort : sessionInfo.audioPort;
    const pktSize = isVideo ? 1128 : 188;

    this.payloadType = mediaRequest.pt;
    this.ssrc = isVideo ? sessionInfo.videoSSRC : sessionInfo.audioSSRC;
    this.srtpParams = (isVideo ? sessionInfo.videoSRTP : sessionInfo.audioSRTP).toString('base64');
    this.srtpSuite = 'AES_CM_128_HMAC_SHA1_80';
    this.format = 'rtp';
    this.output = `srtp://${sessionInfo.address}:${port}?rtcpport=${port}&pkt_size=${pktSize}`;
  }

  public setOutput(output: string) {
    this.output = output;
  }

  public setupForRecording(videoConfig: VideoConfig, configuration: CameraRecordingConfiguration) {
    this.movflags = 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset';
    this.maxMuxingQueueSize = 1024;

    if (isNonEmpty(videoConfig.videoProcessor)) {
      this.processor = videoConfig.videoProcessor;
    }

    if (this.isVideo) {
      if (isNonEmpty(videoConfig.vcodec)) {
        this.codec = videoConfig.vcodec;
      } else {
        const hw = probeHardwareEncoder('generic');
        this.codec = hw?.encoder ?? 'libx264';
      }

      const profile =
        configuration.videoCodec.parameters.profile === H264Profile.HIGH
          ? 'high'
          : configuration.videoCodec.parameters.profile === H264Profile.MAIN
            ? 'main'
            : 'baseline';
      const level =
        configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
          ? '4.0'
          : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2
            ? '3.2'
            : '3.1';

      if (this.codec === 'libx264') {
        this.pixFormat = 'yuv420p';
        this.codecOptions = `-preset ultrafast -tune zerolatency -profile:v ${profile} -level:v ${level}`;
      } else if (this.codec !== 'copy') {
        this.pixFormat = 'yuv420p';
        const hw = probeHardwareEncoder('generic');
        const hwOpts = hw && this.codec === hw.encoder ? hw.customOptions : '';
        this.codecOptions = `${hwOpts} -profile:v ${profile} -level:v ${level}`.trim();
      }
      if (this.codec !== 'copy') {
        this.bitrate = videoConfig.maxBitrate ?? configuration.videoCodec.parameters.bitRate;
        this.width = configuration.videoCodec.resolution[0];
        this.height = configuration.videoCodec.resolution[1];
        this.fps = videoConfig.maxFPS ?? configuration.videoCodec.resolution[2];
        this.crop = videoConfig.crop !== false; // only false if 'crop: false' was specifically set
      }

      this.iFrameInterval = configuration.videoCodec.parameters.iFrameInterval;
    }

    if (this.isAudio) {
      if (isNonEmpty(videoConfig.acodec)) {
        this.codec = videoConfig.acodec;
      } else {
        const aac = getAacRecordingCodecAndOptions(configuration.audioCodec.type);
        this.codec = aac.codec;
        this.codecOptions = aac.codecOptions + ' -flags +global_header';
      }

      if (isNonEmpty(videoConfig.acodec) && (this.codec === 'libfdk_aac' || this.codec === 'aac')) {
        this.codecOptions =
          configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC
            ? '-profile:a aac_low'
            : '-profile:a aac_eld';
        this.codecOptions += ' -flags +global_header';
      }

      if (this.codec !== 'copy') {
        const samplerate = SAMPLERATE_MAP.get(configuration.audioCodec.samplerate);
        if (!samplerate) {
          throw new Error(`Unsupported audio samplerate: ${configuration.audioCodec.samplerate}`);
        }
        this.sampleRate = samplerate;
        this.bitrate = configuration.audioCodec.bitrate;
        this.channels = configuration.audioCodec.audioChannels;
      }
    }
  }

  /**
   * Configure this FFmpegParameters instance to receive return audio from
   * HomeKit via SRTP, decode it, and re-encode to AAC ADTS for the eufy
   * P2P talkback channel.
   *
   * The SDP is generated dynamically based on the codec and sample rate
   * that HomeKit negotiated during the stream setup.
   */
  public async setTalkbackInput(sessionInfo: SessionInfo, request?: StartStreamRequest): Promise<void> {
    this.useWallclockAsTimestamp = false;
    this.protocolWhitelist = 'pipe,udp,rtp,file,crypto,tcp';
    this.inputFormat = 'sdp';

    // Output: always AAC ADTS — this is what the eufy P2P layer expects
    const outputCodec = hasFdkAac() ? 'libfdk_aac' : 'aac';
    this.codec = outputCodec;
    this.sampleRate = 16;
    this.channels = 1;
    this.bitrate = 20;
    this.format = 'adts';

    // Determine input codec from HomeKit's negotiated parameters
    const audioCodec = request?.audio.codec ?? AudioStreamingCodecType.AAC_ELD;
    const sampleRateKHz = request?.audio.sample_rate ?? 16;
    const channels = request?.audio.channel ?? 1;
    const payloadType = request?.audio.pt ?? 110;
    const maxBitrate = request?.audio.max_bit_rate ?? 24;

    const isOpus = audioCodec === AudioStreamingCodecType.OPUS;

    // Set the input decoder to match what HomeKit is sending
    if (isOpus) {
      this.inputCodec = 'libopus';
    } else {
      this.inputCodec = hasFdkAac() ? 'libfdk_aac' : 'aac';
    }

    const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4';
    const srtpSuite =
      sessionInfo.audioCryptoSuite === SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80
        ? 'AES_CM_256_HMAC_SHA1_80'
        : 'AES_CM_128_HMAC_SHA1_80';

    const sdpInput = isOpus
      ? buildOpusSdp(ipVer, sessionInfo, payloadType, sampleRateKHz, channels, maxBitrate, srtpSuite)
      : buildAacEldSdp(ipVer, sessionInfo, payloadType, sampleRateKHz, channels, maxBitrate, srtpSuite);

    const { port } = await createOneShotTcpServer((socket) => {
      socket.end(sdpInput);
    });
    this.setInputSource(`tcp://127.0.0.1:${port}`);
  }

  public setTalkbackChannels(channels: number) {
    this.channels = channels;
  }

  /**
   * Enable parallel file recording.  Generates a timestamped mp4
   * filename inside `recordingDir`, creates the directory if needed,
   * and configures this parameter set so the ffmpeg command will
   * include an additional output that writes a copy of the encoded
   * video to disk (mp4 container, fragmented).
   *
   * @returns The absolute path to the recording file.
   */
  public setFileRecording(recordingDir: string, serial: string, sessionId?: string): string {
    const sanitizedSerial = serial.replace(/[^A-Za-z0-9_-]/g, '');
    const ts = sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync(recordingDir, { recursive: true });
    this.fileRecordingPath = path.join(recordingDir, `${sanitizedSerial}_${ts}_processed.mp4`);
    return this.fileRecordingPath;
  }

  private buildGenericParameters(): string[] {
    const params: string[] = [];

    if (this.hideBanner) params.push('-hide_banner');
    params.push('-loglevel level+verbose');
    if (this.useWallclockAsTimestamp) params.push('-use_wallclock_as_timestamps 1');

    return params;
  }

  private buildInputParameters(): string[] {
    const params: string[] = [];

    if (this.analyzeDuration) params.push(`-analyzeduration ${this.analyzeDuration}`);
    if (this.probeSize) params.push(`-probesize ${this.probeSize}`);
    if (this.stimeout) params.push(`-stimeout ${this.stimeout * 10000000}`);
    if (this.readrate) params.push('-re');
    if (this.protocolWhitelist) params.push(`-protocol_whitelist ${this.protocolWhitelist}`);
    if (this.inputFormat) params.push(`-f ${this.inputFormat}`);
    if (this.inputCodec) params.push(`-c:a ${this.inputCodec}`);
    params.push(this.inputSource);
    if (this.isVideo) params.push('-an -sn -dn');
    if (this.isAudio) params.push('-vn -sn -dn');

    return params;
  }

  /** Clamp a requested dimension to an optional max from the video config. */
  private static clampDimension(requested: number, max?: number): number {
    return max && max < requested ? max : requested;
  }

  /** Apply common visual settings (dimensions, filters, crop) from the video config. */
  private applyVisualConfig(width: number, height: number, videoConfig: VideoConfig) {
    this.width = FFmpegParameters.clampDimension(width, videoConfig.maxWidth);
    this.height = FFmpegParameters.clampDimension(height, videoConfig.maxHeight);
    if (isNonEmpty(videoConfig.videoFilter)) {
      this.filters = videoConfig.videoFilter;
    }
    if (videoConfig.crop) {
      this.crop = videoConfig.crop;
    }
  }

  /**
   * Builds scale/crop video filter arguments based on current width, height, crop settings,
   * and any user-specified filters. Shared between video and snapshot encoding.
   */
  private buildVideoFilterParams(): string[] {
    const filters: string[] = this.filters ? this.filters.split(',') : [];
    const noneFilter = filters.indexOf('none');
    if (noneFilter >= 0) {
      filters.splice(noneFilter, 1);
    }
    if (noneFilter < 0 && this.width && this.height) {
      if (this.crop) {
        filters.push(`scale=${this.width}:${this.height}:force_original_aspect_ratio=increase`);
        filters.push(`crop=${this.width}:${this.height}`);
        filters.push(`scale='trunc(${this.width}/2)*2:trunc(${this.height}/2)*2'`);
      } else {
        filters.push(`scale='min(${this.width},iw)':'min(${this.height},ih)':force_original_aspect_ratio=decrease`);
        filters.push("scale='trunc(iw/2)*2:trunc(ih/2)*2'");
      }
    }
    if (filters.length > 0) {
      return ['-filter:v ' + filters.join(',')];
    }
    return [];
  }

  private buildEncodingParameters(): string[] {
    const params: string[] = [];
    if (this.isVideo) {
      if (this.fps) params.push(`-r ${this.fps}`);
      params.push(`-vcodec ${this.codec}`);
      if (this.pixFormat) params.push(`-pix_fmt ${this.pixFormat}`);
      if (this.colorRange) params.push(`-color_range ${this.colorRange}`);
      if (this.codecOptions) params.push(this.codecOptions);
      if (this.codec === 'libx264') params.push('-sc_threshold 0');

      params.push(...this.buildVideoFilterParams());

      if (this.bitrate) params.push(`-b:v ${this.bitrate}k`);
      if (this.bufsize) params.push(`-bufsize ${this.bufsize}k`);
      if (this.maxrate) params.push(`-maxrate ${this.maxrate}k`);
    }

    if (this.isAudio && this.processAudio) {
      params.push(`-acodec ${this.codec}`);
      if (this.codecOptions) params.push(this.codecOptions);
      if (this.bitrate) params.push(`-b:a ${this.bitrate}k`);
      if (this.sampleRate) params.push(`-ar ${this.sampleRate}k`);
      if (this.channels) params.push(`-ac ${this.channels}`);
    }

    if (this.isSnapshot) {
      if (this.numberFrames) params.push(`-frames:v ${this.numberFrames}`);
      if (this.delaySnapshot) params.push('-ss 00:00:00.500');

      params.push(...this.buildVideoFilterParams());
    }
    return params;
  }

  private buildOutputParameters(): string[] {
    const params: string[] = [];
    if (this.payloadType) params.push(`-payload_type ${this.payloadType}`);
    if (this.ssrc) params.push(`-ssrc ${this.ssrc}`);
    if (this.format) params.push(`-f ${this.format}`);
    if (this.srtpSuite) params.push(`-srtp_out_suite ${this.srtpSuite}`);
    if (this.srtpParams) params.push(`-srtp_out_params ${this.srtpParams}`);
    params.push(this.output);
    return params;
  }

  private buildParameters(): string[] {
    const params = [
      ...this.buildGenericParameters(),
      ...this.buildInputParameters(),
      ...this.buildEncodingParameters(),
      ...this.buildOutputParameters(),
      `-progress tcp://127.0.0.1:${this.progressPort}`,
    ];
    return params;
  }

  static getRecordingArguments(parameters: FFmpegParameters[]): string[] {
    if (parameters.length === 0) {
      return [];
    }

    const params = [...parameters[0].buildGenericParameters()];

    // input
    params.push(parameters[0].inputSource);
    if (parameters.length > 1 && parameters[0].inputSource !== parameters[1].inputSource) {
      if (parameters[1].processAudio) {
        // Include audio input format/codec hints so FFmpeg can detect the
        // raw AAC ADTS stream without slow probing.  Cannot use full
        // buildInputParameters() here because its -vn flag would suppress
        // video in this combined (single-process) recording command.
        if (parameters[1].inputFormat) params.push(`-f ${parameters[1].inputFormat}`);
        if (parameters[1].inputCodec) params.push(`-c:a ${parameters[1].inputCodec}`);
        params.push(parameters[1].inputSource);
      } else {
        params.push('-f lavfi -i anullsrc -shortest');
      }
    }
    if (parameters.length === 1) {
      params.push('-an');
    }
    params.push('-sn -dn');

    // video encoding
    params.push(...parameters[0].buildEncodingParameters());
    if (parameters[0].iFrameInterval) {
      params.push(`-force_key_frames expr:gte(t,n_forced*${parameters[0].iFrameInterval / 1000})`);
      params.push('-sc_threshold 0');
    }

    // audio encoding
    if (parameters.length > 1) {
      if (parameters[1].processAudio) {
        params.push('-bsf:a aac_adtstoasc');
      }
      params.push(...parameters[1].buildEncodingParameters());
    }

    // fragmented mp4 options
    if (parameters[0].movflags) params.push(`-movflags ${parameters[0].movflags}`);
    if (parameters[0].maxMuxingQueueSize) params.push(`-max_muxing_queue_size ${parameters[0].maxMuxingQueueSize}`);

    // output
    params.push('-f mp4');
    params.push(parameters[0].output);
    params.push(`-progress tcp://127.0.0.1:${parameters[0].progressPort}`);

    return params;
  }

  static getCombinedArguments(parameters: FFmpegParameters[]): string[] {
    if (parameters.length === 0) {
      return [];
    }

    const params = [...parameters[0].buildGenericParameters()];
    for (const p of parameters) {
      params.push(...p.buildInputParameters());
      params.push(...p.buildEncodingParameters());
      params.push(...p.buildOutputParameters());
    }

    // Append a parallel file-recording output when configured.
    // Video-only copy — for P2P streams video and audio use separate
    // FFmpeg processes, so only the video track is available here.
    const recPath = parameters[0].fileRecordingPath;
    if (recPath) {
      params.push('-map 0:v -c:v copy -f mp4 -movflags frag_keyframe+empty_moov');
      params.push(recPath);
    }

    params.push(`-progress tcp://127.0.0.1:${parameters[0].progressPort}`);

    return params;
  }

  public getStreamStartText(): string {
    if (this.isVideo) {
      const detail =
        this.codec === 'copy' ? 'native' : `${this.width}x${this.height}, ${this.fps} fps, ${this.bitrate} kbps`;
      return `Starting video stream: ${detail}`;
    }
    if (this.isAudio) {
      const detail =
        this.codec === 'copy' ? 'native' : `${this.sampleRate} kHz, ${this.bitrate} kbps, codec: ${this.codec}`;
      return `Starting audio stream: ${detail}`;
    }
    return 'Starting unknown stream';
  }
}

export class FFmpeg extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;

  private name: string;
  private progress?: FFmpegProgress;
  private parameters: FFmpegParameters[];

  private ffmpegExec: string = (ffmpegPath as unknown as string) || 'ffmpeg';

  public stdin?: Writable;
  public stdout?: Readable;

  private starttime?: number;
  private killTimeout?: NodeJS.Timeout;

  private log: Logger<ILogObj>;

  constructor(name: string, parameters: FFmpegParameters | FFmpegParameters[], logger?: Logger<ILogObj>) {
    super();
    this.name = name;
    this.log = logger ?? ffmpegLogger;
    if (Array.isArray(parameters)) {
      if (parameters.length === 0) {
        throw new Error('No ffmpeg parameters found.');
      }
      this.parameters = parameters;
    } else {
      this.parameters = [parameters];
    }

    if (this.parameters[0].processor) {
      this.ffmpegExec = this.parameters[0].processor;
    }
  }

  /**
   * Shared initialisation: timestamps the start, creates the progress monitor,
   * spawns the ffmpeg process, and wires up stderr logging.
   */
  private async spawnProcess(
    processArgs: string[],
    label: string,
    opts?: { attachLifecycle?: boolean },
  ): Promise<ChildProcessWithoutNullStreams> {
    this.starttime = Date.now();

    this.progress = await FFmpegProgress.create(this.parameters[0].progressPort);
    this.progress.on('progress started', this.onProgressStarted.bind(this));

    this.log.debug(this.name, `${label}: ${this.ffmpegExec} ${processArgs.join(' ')}`);
    this.parameters.forEach((p) => this.log.info(this.name, p.getStreamStartText()));

    const child = spawn(this.ffmpegExec, processArgs.join(' ').split(/\s+/), { env: process.env });
    child.stderr.on('data', this.handleStderrData.bind(this));

    if (opts?.attachLifecycle) {
      child.on('error', this.onProcessError.bind(this));
      child.on('exit', this.onProcessExit.bind(this));
    }

    this.process = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    return child;
  }

  public async start() {
    const processArgs = FFmpegParameters.getCombinedArguments(this.parameters);
    await this.spawnProcess(processArgs, 'Stream command', { attachLifecycle: true });
  }

  public async getResult(input?: Buffer): Promise<Buffer> {
    const processArgs = FFmpegParameters.getCombinedArguments(this.parameters);
    const child = await this.spawnProcess(processArgs, 'Process command');

    return new Promise((resolve, reject) => {
      const killTimeout = setTimeout(() => {
        this.stop();
        reject('ffmpeg process timed out.');
      }, PROCESS_RESULT_TIMEOUT_MS);

      child.on('error', (error) => {
        reject(error);
        this.onProcessError(error);
      });

      let resultBuffer = Buffer.alloc(0);
      child.stdout.on('data', (data) => {
        resultBuffer = Buffer.concat([resultBuffer, data]);
      });
      child.on('exit', () => {
        if (killTimeout) {
          clearTimeout(killTimeout);
        }

        if (resultBuffer.length > 0) {
          resolve(resultBuffer);
        } else {
          reject('Failed to fetch data.');
        }
      });
      if (input) {
        child.stdin.end(input);
      }
    });
  }

  public async startFragmentedMP4Session(): Promise<{
    socket: net.Socket;
    process?: ChildProcessWithoutNullStreams;
    ffmpeg: FFmpeg;
    generator: AsyncGenerator<{
      header: Buffer;
      length: number;
      type: string;
      data: Buffer;
    }>;
  }> {
    const port = await pickPort({ type: 'tcp' });

    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        server.close();

        resolve({
          socket: socket,
          process: this.process,
          ffmpeg: this,
          generator: this.parseFragmentedMP4(socket),
        });
      });

      server.listen(port, async () => {
        this.parameters[0].setOutput(`tcp://127.0.0.1:${port}`);
        const processArgs = FFmpegParameters.getRecordingArguments(this.parameters);
        await this.spawnProcess(processArgs, 'Stream command', { attachLifecycle: true });
      });
    });
  }

  private async *parseFragmentedMP4(socket: net.Socket) {
    while (true) {
      const header = await this.readLength(socket, 8);
      const length = header.readInt32BE(0) - 8;
      const type = header.slice(4).toString();

      if (length > MAX_FRAG_BOX_SIZE) {
        throw new Error(
          `fMP4 box '${type}' reports size ${length} bytes, exceeding limit of ${MAX_FRAG_BOX_SIZE}. Stream likely corrupted.`,
        );
      }

      const data = await this.readLength(socket, length);

      yield {
        header,
        length,
        type,
        data,
      };
    }
  }

  private async readLength(socket: net.Socket, length: number): Promise<Buffer> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }

    const value = socket.read(length);
    if (value) {
      return value;
    }

    return new Promise((resolve, reject) => {
      const readHandler = () => {
        const value = socket.read(length);

        if (value) {
          cleanup();
          resolve(value);
        }
      };

      const endHandler = () => {
        cleanup();
        reject(new Error(`FFMPEG socket closed during read for ${length} bytes!`));
      };

      const cleanup = () => {
        socket.removeListener('readable', readHandler);
        socket.removeListener('close', endHandler);
      };

      if (!socket) {
        throw new Error('FFMPEG socket is closed now!');
      }

      socket.on('readable', readHandler);
      socket.on('close', endHandler);
    });
  }

  public stop(): void {
    const usesStdIn = this.parameters.some((p) => p.usesStdInAsInput());

    if (usesStdIn) {
      this.process?.stdin.destroy();
      this.process?.kill('SIGTERM');
    } else {
      this.process?.stdin.write('q' + os.EOL);
    }

    this.killTimeout = setTimeout(() => {
      this.process?.kill('SIGKILL');
    }, KILL_GRACE_PERIOD_MS);
  }

  private onProgressStarted() {
    this.emit('started');
    const runtime = this.starttime ? (Date.now() - this.starttime) / 1000 : undefined;
    this.log.debug(this.name, `process started. Getting the first response took ${runtime} seconds.`);
  }

  private handleStderrData(chunk: Buffer) {
    const output = chunk.toString();
    const isError = output.includes('[panic]') || output.includes('[error]') || output.includes('[fatal]');

    if (isError) {
      this.log.error(this.name, 'ffmpeg log message:\n' + output);
    } else if (this.parameters[0].debug) {
      this.log.debug(this.name, 'ffmpeg log message:\n' + output);
    }
  }

  private onProcessError(error: Error) {
    this.emit('error', error);
  }

  private onProcessExit(code: number, signal: NodeJS.Signals) {
    this.emit('exit');

    const wasStopRequested = !!this.killTimeout;
    if (this.killTimeout) {
      clearTimeout(this.killTimeout);
    }

    const message = 'FFmpeg exited with code: ' + code + ' and signal: ' + signal;
    if (wasStopRequested) {
      // stop() was called — any exit code is expected (non-zero typically
      // means broken pipe from socket teardown during HKSV recording close).
      this.log.debug(this.name, message + ' (Expected)');
    } else if (code === null || code === 255) {
      if (this.process?.killed) {
        this.log.info(this.name, message + ' (Forced)');
      } else {
        this.log.error(this.name, message + ' (Unexpected)');
      }
    } else {
      this.emit('error', message + ' (Error)');
      // this.log.error(this.name, message + ' (Error)');
    }
  }
}
