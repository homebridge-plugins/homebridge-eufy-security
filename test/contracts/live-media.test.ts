import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame } from '@mega-yfue/eufy-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  FfmpegLiveMedia,
  type LiveMediaProcess,
  type LiveSessionOutcome,
  type NegotiatedLiveAudio,
  type NegotiatedLiveVideo,
} from '../../src/media/live-stream.js';

const NEGOTIATED_VIDEO: NegotiatedLiveVideo = {
  width: 1280,
  height: 720,
  fps: 30,
  maxBitRate: 300,
  profile: 'main',
  level: '3.1',
  payloadType: 99,
  ssrc: 1234,
  mtu: 1200,
  rtcpInterval: 0.5,
};

const AAC_ELD_16: NegotiatedLiveAudio = {
  codec: 'AAC-eld',
  channels: 1,
  sampleRate: 16,
  maxBitRate: 24,
  payloadType: 110,
  ssrc: 5678,
};

const KEYFRAME = {
  codec: 'h264' as const,
  width: 1280,
  height: 720,
  keyframe: true,
  data: Buffer.from([0, 0, 0, 1, 0x65]),
};

class SyntheticLiveStream extends EventEmitter implements LiveStreamHandle {
  start(): this {
    return this;
  }

  stop = vi.fn();

  video(frame: LiveVideoFrame): void {
    this.emit('video', frame);
  }

  audio(frame: LiveAudioFrame): void {
    this.emit('audio', frame);
  }
}

type SyntheticProcess = LiveMediaProcess & { emit(event: string, ...args: unknown[]): boolean };

/**
 * The options one adaptation process applies to its input, which is everything before `-i`. FFmpeg reads
 * the same option name on either side of the input, so an input contract has to be judged on this slice
 * rather than on the whole argument list.
 */
function inputOptions(args: readonly string[]): string[] {
  return args.slice(0, args.indexOf('-i'));
}

function process(): SyntheticProcess {
  const events = new EventEmitter();
  return {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    kill: vi.fn(() => true),
  };
}

/**
 * One prepared session that records every adaptation process, the arguments it was given, and every
 * reported outcome. `audio` negotiates the second output so the audio adaptation contracts share this setup.
 */
async function liveSession(
  source?: { live(): Promise<LiveStreamHandle> },
  { audio }: { audio?: NegotiatedLiveAudio } = {},
) {
  const stream = new SyntheticLiveStream();
  const onVideoFailure = vi.fn();
  const outcomes: LiveSessionOutcome[] = [];
  const children: SyntheticProcess[] = [];
  const spawned: string[][] = [];
  let receiverReport: (() => void) | undefined;
  const media = new FfmpegLiveMedia(
    '/synthetic/ffmpeg',
    (_executable, args) => {
      const child = process();
      children.push(child);
      spawned.push([...args]);
      return child;
    },
    async () => ({
      port: 41000,
      onMessage: (listener) => {
        receiverReport = listener;
      },
      close: vi.fn(),
    }),
  );
  const prepared = await media.prepare({
    addressVersion: 'ipv4',
    targetAddress: '192.0.2.10',
    video: {
      port: 50100,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: Buffer.alloc(16),
      srtpSalt: Buffer.alloc(14),
    },
    ...(audio
      ? {
          audio: {
            port: 50101,
            srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80' as const,
            srtpKey: Buffer.alloc(16),
            srtpSalt: Buffer.alloc(14),
          },
        }
      : {}),
    onVideoFailure,
    onSessionOutcome: (outcome) => outcomes.push(outcome),
  });
  return {
    prepared,
    stream,
    children,
    spawned,
    onVideoFailure,
    outcomes,
    start: (): Promise<void> =>
      prepared.start(source ?? { live: async () => stream }, { video: NEGOTIATED_VIDEO, ...(audio ? { audio } : {}) }),
    receiverReport: (): void => receiverReport?.(),
  };
}

describe('live media adaptation', () => {
  it('starts adaptation for a first keyframe delivered after the SDK warm-up window', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(22_000);

    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.stream.stop).not.toHaveBeenCalled();
    expect(session.children).toHaveLength(0);

    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(0);

    expect(session.children).toHaveLength(1);
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);
    session.prepared.stop();
    vi.useRealTimers();
  });

  it('fails a session on the SDK warm-up error before the video backstop', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(20_000);
    session.stream.emit('error', new Error('synthetic warm-up failure'));

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'source-error' }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.outcomes).toHaveLength(1);
    vi.useRealTimers();
  });

  it('bounds a silent source at the video backstop and reports the bounded reason', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(session.onVideoFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'no-video-within-backstop' }]);
    vi.useRealTimers();
  });

  it('arms the initial RTCP grace from first adaptation progress rather than session start', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();

    await vi.advanceTimersByTimeAsync(25_000);
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(14_999);

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);
    expect(session.onVideoFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([{ outcome: 'streaming' }, { outcome: 'failed', reason: 'rtcp-timeout' }]);
    vi.useRealTimers();
  });

  it('does not let an early receiver report bound a session before its media starts', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.receiverReport();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(session.onVideoFailure).not.toHaveBeenCalled();
    expect(session.outcomes).toEqual([]);

    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(4_999);

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);

    await vi.advanceTimersByTimeAsync(1);

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }, { outcome: 'failed', reason: 'rtcp-timeout' }]);
    vi.useRealTimers();
  });

  it('reports an upstream source end apart from a source failure', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    session.stream.emit('stop');

    expect(session.outcomes).toEqual([{ outcome: 'streaming' }, { outcome: 'failed', reason: 'source-stopped' }]);
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('timestamps live video by arrival and bounds the analysis that precedes a first coded frame', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);

    const options = inputOptions(session.spawned[0]!);
    expect(options).toEqual(
      expect.arrayContaining(['-use_wallclock_as_timestamps', '1', '-probesize', '32', '-analyzeduration', '1']),
    );
    expect(options.join(' ')).not.toContain('genpts');
    expect(options.join(' ')).not.toContain('nobuffer');
    session.prepared.stop();
  });

  it('transcodes H.264 when passthrough compliance cannot be proven from SDK frames', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: Array<{ executable: string; args: string[]; process: LiveMediaProcess }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[]) => {
      const child = process();
      spawned.push({ executable, args: [...args], process: child });
      return child;
    });
    const media = new FfmpegLiveMedia('/synthetic/ffmpeg', spawn, async () => ({
      port: 41000,
      onMessage: vi.fn(),
      close: vi.fn(),
    }));
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16, 1),
        srtpSalt: Buffer.alloc(14, 2),
      },
    });

    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
      },
    );
    stream.video({
      codec: 'h264',
      width: 1280,
      height: 720,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });

    expect(prepared.videoPort).toBe(41000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].executable).toBe('/synthetic/ffmpeg');
    expect(spawned[0].args).toEqual(
      expect.arrayContaining([
        '-c:v',
        'libx264',
        '-preset',
        'superfast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'main',
        '-level:v',
        '3.1',
        '-r',
        '30',
        '-b:v',
        '300k',
        '-payload_type',
        '99',
        '-ssrc',
        '1234',
        '-srtp_out_suite',
        'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params',
        Buffer.concat([Buffer.alloc(16, 1), Buffer.alloc(14, 2)]).toString('base64'),
        'srtp://192.0.2.10:50100?rtcpport=50100&pkt_size=1200',
      ]),
    );
    const extend = vi.fn();
    stream.emit('budget', { graceMs: 1_000, extend });
    expect(extend).toHaveBeenCalledOnce();
    prepared.stop();
    stream.emit('budget', { graceMs: 1_000, extend });
    expect(extend).toHaveBeenCalledOnce();
  });

  it('transcodes H.265 and resized H.264 to every negotiated video constraint after a keyframe', async () => {
    const cases = [
      { codec: 'h265' as const, width: 1920, height: 1080, inputFormat: 'hevc' },
      { codec: 'h264' as const, width: 1920, height: 1080, inputFormat: 'h264' },
    ];

    for (const candidate of cases) {
      const stream = new SyntheticLiveStream();
      const spawned: string[][] = [];
      const media = new FfmpegLiveMedia(
        '/synthetic/ffmpeg',
        (_executable, args) => {
          spawned.push([...args]);
          return process();
        },
        async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
      );
      const prepared = await media.prepare({
        addressVersion: 'ipv4',
        targetAddress: '192.0.2.10',
        video: {
          port: 50100,
          srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
          srtpKey: Buffer.alloc(16),
          srtpSalt: Buffer.alloc(14),
        },
      });
      await prepared.start(
        { live: async () => stream },
        {
          video: {
            width: 1280,
            height: 720,
            fps: 15,
            maxBitRate: 250,
            profile: 'high',
            level: '4.0',
            payloadType: 99,
            ssrc: 1234,
            mtu: 1200,
            rtcpInterval: 0.5,
          },
        },
      );

      stream.video({ ...candidate, keyframe: false, data: Buffer.from([0, 0, 1, 1]) });
      expect(spawned).toHaveLength(0);
      stream.video({ ...candidate, keyframe: true, data: Buffer.from([0, 0, 1, 0x65]) });

      expect(spawned[0]).toEqual(
        expect.arrayContaining([
          '-f',
          candidate.inputFormat,
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-level:v',
          '4.0',
          '-r',
          '15',
          '-g',
          '30',
          '-b:v',
          '250k',
          '-maxrate',
          '250k',
        ]),
      );
      expect(spawned[0]).toContain(
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      );
      prepared.stop();
    }
  });

  it('applies a reconfigured selection to adaptation while keeping the negotiated RTP identity', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      (_executable, args) => {
        spawned.push([...args]);
        return process();
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16, 5),
        srtpSalt: Buffer.alloc(14, 6),
      },
    });
    const video = {
      width: 1280,
      height: 720,
      fps: 30,
      maxBitRate: 300,
      profile: 'main' as const,
      level: '3.1' as const,
      payloadType: 99,
      ssrc: 1234,
      mtu: 1200,
      rtcpInterval: 0.5,
    };
    await prepared.start({ live: async () => stream }, { video });
    const keyframe = { codec: 'h264' as const, width: 1280, height: 720, keyframe: true, data: Buffer.from([0x65]) };
    stream.video(keyframe);

    prepared.reconfigure({ ...video, width: 640, height: 360, fps: 15, maxBitRate: 150 });
    stream.video({ ...keyframe, keyframe: false });
    expect(spawned).toHaveLength(1);
    stream.video(keyframe);

    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toContain(
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    );
    expect(spawned[1]).toContain('scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2');
    expect(spawned[1]).toEqual(expect.arrayContaining(['-r', '15', '-g', '30', '-b:v', '150k', '-maxrate', '150k']));
    expect(spawned[1]).toEqual(
      expect.arrayContaining([
        '-payload_type',
        '99',
        '-ssrc',
        '1234',
        '-srtp_out_params',
        Buffer.concat([Buffer.alloc(16, 5), Buffer.alloc(14, 6)]).toString('base64'),
        'srtp://192.0.2.10:50100?rtcpport=50100&pkt_size=1200',
      ]),
    );
    expect(stream.stop).not.toHaveBeenCalled();
    prepared.stop();
  });

  it('keeps the previous selection on the wire until a reconfigured one has a keyframe to start from', async () => {
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    expect(session.children).toHaveLength(1);
    const coding = vi.spyOn(session.children[0]!.stdin, 'write');

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360, maxBitRate: 132 });
    session.stream.video({ ...KEYFRAME, keyframe: false });

    expect(session.children).toHaveLength(1);
    expect(session.children[0]!.kill).not.toHaveBeenCalled();
    expect(coding).toHaveBeenCalledWith(KEYFRAME.data);

    session.stream.video(KEYFRAME);

    expect(session.children).toHaveLength(2);
    expect(session.children[0]!.kill).toHaveBeenCalled();
    expect(session.spawned[1]).toContain(
      'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
    );
    session.prepared.stop();
  });

  it('bounds a deferred reconfiguration even while the superseded selection keeps reporting progress', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.outcomes).toEqual([{ outcome: 'streaming' }]);

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360, maxBitRate: 132 });
    for (let elapsed = 0; elapsed < 32_000; elapsed += 2_000) {
      session.receiverReport();
      session.children[0]!.stderr.push('progress=continue\n');
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'no-video-within-backstop' },
    ]);
    vi.useRealTimers();
  });

  it('readapts a changed source codec at its next keyframe without changing negotiated output', async () => {
    const stream = new SyntheticLiveStream();
    const spawned: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      (_executable, args) => {
        spawned.push([...args]);
        return process();
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
      },
    );
    stream.video({ codec: 'h264', width: 1920, height: 1080, keyframe: true, data: Buffer.from([0x65]) });
    stream.video({ codec: 'h265', width: 1920, height: 1080, keyframe: false, data: Buffer.from([0x02]) });
    expect(spawned).toHaveLength(1);
    stream.video({ codec: 'h265', width: 1920, height: 1080, keyframe: true, data: Buffer.from([0x26]) });
    stream.video({ codec: 'h265', width: 1280, height: 720, keyframe: true, data: Buffer.from([0x26]) });

    expect(spawned.map((args) => args[args.indexOf('-f') + 1])).toEqual(['h264', 'hevc', 'hevc']);
    for (const args of spawned) {
      expect(args).toContain('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
      expect(args).toEqual(expect.arrayContaining(['-r', '30', '-b:v', '300k', '-payload_type', '99']));
    }
    expect(stream.stop).not.toHaveBeenCalled();
    prepared.stop();
  });

  it('starts and retains video when source audio is absent or its separate process fails', async () => {
    const stream = new SyntheticLiveStream();
    const children: SyntheticProcess[] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      () => {
        const child = process();
        children.push(child);
        return child;
      },
      async () => ({ port: 41000 + children.length, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      audio: {
        port: 50101,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
        audio: {
          codec: 'AAC-eld',
          channels: 1,
          sampleRate: 16,
          maxBitRate: 24,
          payloadType: 110,
          ssrc: 5678,
        },
      },
    );

    stream.video({
      codec: 'h264',
      width: 1280,
      height: 720,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });
    expect(children).toHaveLength(1);

    stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    expect(children).toHaveLength(2);
    children[1].emit('error', new Error('synthetic audio failure'));

    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(stream.stop).not.toHaveBeenCalled();
  });

  it('does not let a replaced audio process clear the process for a later source codec', async () => {
    const stream = new SyntheticLiveStream();
    const children: SyntheticProcess[] = [];
    const spawnedArgs: string[][] = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      (_executable, args) => {
        const child = process();
        children.push(child);
        spawnedArgs.push([...args]);
        return child;
      },
      async () => ({ port: 41000, onMessage: vi.fn(), close: vi.fn() }),
    );
    const prepared = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      audio: {
        port: 50101,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
    });
    await prepared.start(
      { live: async () => stream },
      {
        video: {
          width: 1280,
          height: 720,
          fps: 30,
          maxBitRate: 300,
          profile: 'main',
          level: '3.1',
          payloadType: 99,
          ssrc: 1234,
          mtu: 1200,
          rtcpInterval: 0.5,
        },
        audio: {
          codec: 'AAC-eld',
          channels: 1,
          sampleRate: 16,
          maxBitRate: 24,
          payloadType: 110,
          ssrc: 5678,
        },
      },
    );
    stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    stream.audio({ codec: 'g711a', data: Buffer.from([1, 2, 3]) });
    expect(children).toHaveLength(2);
    expect(spawnedArgs[0]).toEqual(expect.arrayContaining(['-f', 'aac', '-c:a', 'libfdk_aac', 'aac_eld']));
    expect(spawnedArgs[1]).toEqual(expect.arrayContaining(['-f', 'alaw', '-c:a', 'libfdk_aac', 'aac_eld']));

    children[0].emit('exit', 0, null);
    stream.audio({ codec: 'g711a', data: Buffer.from([4, 5, 6]) });

    expect(children).toHaveLength(2);
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('tells only a raw a-law input the sample rate assumption its format cannot carry', async () => {
    const session = await liveSession(undefined, { audio: AAC_ELD_16 });
    await session.start();

    session.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });
    expect(inputOptions(session.spawned[0]!)).not.toContain('-ar');
    expect(inputOptions(session.spawned[0]!)).not.toContain('-ac');

    session.stream.audio({ codec: 'g711a', data: Buffer.from([1, 2, 3]) });
    expect(inputOptions(session.spawned[1]!)).toEqual(expect.arrayContaining(['-ar', '16k', '-ac', '1']));
    session.prepared.stop();
  });

  it('requests the global header AAC-ELD needs to leave the encoder at all', async () => {
    const session = await liveSession(undefined, {
      audio: { ...AAC_ELD_16, sampleRate: 24, maxBitRate: 32 },
    });
    await session.start();
    session.stream.audio({ codec: 'aac-lc', data: Buffer.from([0xff, 0xf1, 1]) });

    expect(session.spawned[0]).toEqual(
      expect.arrayContaining([
        '-c:a',
        'libfdk_aac',
        '-profile:a',
        'aac_eld',
        '-flags',
        '+global_header',
        '-ar',
        '24k',
        '-ac',
        '1',
        '-b:a',
        '32k',
      ]),
    );
    session.prepared.stop();
  });

  it('bounds startup when a long GOP supplies no keyframe', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video({ ...KEYFRAME, keyframe: false, data: Buffer.from([0, 0, 0, 1, 0x41]) });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.children).toHaveLength(0);
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([{ outcome: 'failed', reason: 'no-video-within-backstop' }]);
    vi.useRealTimers();
  });

  it('bounds stalled source acquisition and no-RTCP sessions', async () => {
    vi.useFakeTimers();
    const stalled = await liveSession({ live: () => new Promise<LiveStreamHandle>(() => undefined) });
    const start = expect(stalled.start()).rejects.toThrow('source acquisition timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await start;

    expect(stalled.onVideoFailure).toHaveBeenCalledOnce();
    expect(stalled.outcomes).toEqual([{ outcome: 'failed', reason: 'source-acquisition-timeout' }]);

    const noRtcp = await liveSession();
    await noRtcp.start();
    noRtcp.stream.video(KEYFRAME);
    noRtcp.children[0]!.stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(noRtcp.onVideoFailure).toHaveBeenCalledOnce();
    expect(noRtcp.stream.stop).toHaveBeenCalledOnce();
    expect(noRtcp.outcomes).toEqual([{ outcome: 'streaming' }, { outcome: 'failed', reason: 'rtcp-timeout' }]);
    vi.useRealTimers();
  });

  it('restarts the keyframe deadline after an acknowledged reconfiguration', async () => {
    vi.useFakeTimers();
    const session = await liveSession();
    await session.start();
    session.stream.video(KEYFRAME);
    session.children[0]!.stderr.push('prog');
    session.children[0]!.stderr.push('ress=continue\n');
    await vi.advanceTimersByTimeAsync(0);

    session.prepared.reconfigure({ ...NEGOTIATED_VIDEO, width: 640, height: 360 });
    for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
      session.receiverReport();
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(session.onVideoFailure).toHaveBeenCalledOnce();
    expect(session.stream.stop).toHaveBeenCalledOnce();
    expect(session.outcomes).toEqual([
      { outcome: 'streaming' },
      { outcome: 'failed', reason: 'no-video-within-backstop' },
    ]);
    vi.useRealTimers();
  });
});
