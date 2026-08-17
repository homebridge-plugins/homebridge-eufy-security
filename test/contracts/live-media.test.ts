import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { LiveAudioFrame, LiveStreamHandle, LiveVideoFrame } from '@mega-yfue/eufy-sdk';
import { describe, expect, it, vi } from 'vitest';

import { FfmpegLiveMedia, type LiveMediaProcess } from '../../src/media/live-stream.js';

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

function process(): LiveMediaProcess & { emit(event: string, ...args: unknown[]): boolean } {
  const events = new EventEmitter();
  return {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    kill: vi.fn(() => true),
  };
}

describe('live media adaptation', () => {
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

  it('starts and retains video when source audio is absent or its separate process fails', async () => {
    const stream = new SyntheticLiveStream();
    const children: Array<LiveMediaProcess & { emit(event: string, ...args: unknown[]): boolean }> = [];
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
    const children: Array<LiveMediaProcess & { emit(event: string, ...args: unknown[]): boolean }> = [];
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
    expect(spawnedArgs[0]).toEqual(
      expect.arrayContaining(['-f', 'aac', '-ar', '16k', '-ac', '1', '-c:a', 'libfdk_aac', 'aac_eld']),
    );
    expect(spawnedArgs[1]).toEqual(
      expect.arrayContaining(['-f', 'alaw', '-ar', '16k', '-ac', '1', '-c:a', 'libfdk_aac', 'aac_eld']),
    );

    children[0].emit('exit', 0, null);
    stream.audio({ codec: 'g711a', data: Buffer.from([4, 5, 6]) });

    expect(children).toHaveLength(2);
    expect(children[1].kill).not.toHaveBeenCalled();
  });

  it('bounds startup when a long GOP supplies no keyframe', async () => {
    vi.useFakeTimers();
    const stream = new SyntheticLiveStream();
    const onVideoFailure = vi.fn();
    const spawn = vi.fn(() => process());
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
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      onVideoFailure,
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
      keyframe: false,
      data: Buffer.from([0, 0, 0, 1, 0x41]),
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawn).not.toHaveBeenCalled();
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(onVideoFailure).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('bounds stalled source acquisition and no-RTCP sessions', async () => {
    vi.useFakeTimers();
    const unresolved = new Promise<LiveStreamHandle>(() => undefined);
    const acquisitionFailure = vi.fn();
    const children: Array<LiveMediaProcess & { emit(event: string, ...args: unknown[]): boolean }> = [];
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      vi.fn(() => {
        const child = process();
        children.push(child);
        return child;
      }),
      async () => ({
        port: 41000,
        onMessage: vi.fn(),
        close: vi.fn(),
      }),
    );
    const stalled = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      onVideoFailure: acquisitionFailure,
    });
    const start = expect(
      stalled.start(
        { live: () => unresolved },
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
      ),
    ).rejects.toThrow('source acquisition timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await start;
    expect(acquisitionFailure).toHaveBeenCalledOnce();

    const stream = new SyntheticLiveStream();
    const rtcpFailure = vi.fn();
    const noRtcp = await media.prepare({
      addressVersion: 'ipv4',
      targetAddress: '192.0.2.10',
      video: {
        port: 50100,
        srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        srtpKey: Buffer.alloc(16),
        srtpSalt: Buffer.alloc(14),
      },
      onVideoFailure: rtcpFailure,
    });
    await noRtcp.start(
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
    children[0].stderr.push('progress=continue\n');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(rtcpFailure).toHaveBeenCalledOnce();
    expect(stream.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('restarts the keyframe deadline after an acknowledged reconfiguration', async () => {
    vi.useFakeTimers();
    const stream = new SyntheticLiveStream();
    const onVideoFailure = vi.fn();
    const child = process();
    const media = new FfmpegLiveMedia(
      '/synthetic/ffmpeg',
      vi.fn(() => child),
      async () => ({
        port: 41000,
        onMessage: vi.fn(),
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
      onVideoFailure,
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
    stream.video({
      codec: 'h264',
      width: 1280,
      height: 720,
      keyframe: true,
      data: Buffer.from([0, 0, 0, 1, 0x65]),
    });
    child.stderr.push('prog');
    child.stderr.push('ress=continue\n');

    prepared.reconfigure({ ...video, width: 640, height: 360 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onVideoFailure).toHaveBeenCalledOnce();
    expect(stream.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
