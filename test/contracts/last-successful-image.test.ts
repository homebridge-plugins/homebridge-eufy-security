import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersistedLastSuccessfulImages } from '../../src/media/last-successful-image.js';

const SERIAL = 'SYNTHETIC0000000001';
const MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;

function jpeg(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker, 'utf8'), Buffer.from([0xff, 0xd9])]);
}

function opaqueName(serial: string): string {
  return `${createHash('sha256').update(serial).digest('hex')}.jpg`;
}

describe('last successful image', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-snapshot-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('stores a validated image atomically under an owner-only opaque name', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    const image = jpeg('synthetic live image');

    await images.write(SERIAL, image, 'live');

    const directory = join(root, 'snapshots');
    expect(readdirSync(directory)).toEqual([opaqueName(SERIAL)]);
    expect(readdirSync(directory).join(':')).not.toContain(SERIAL);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, opaqueName(SERIAL))).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, opaqueName(SERIAL))).equals(image)).toBe(true);
    expect((await images.read(SERIAL))?.equals(image)).toBe(true);
  });

  it('serves a replacement image before its file has been written', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    const file = join(root, 'snapshots', opaqueName(SERIAL));
    const previous = jpeg('synthetic live image');
    const replacement = jpeg('synthetic newer live image');

    await images.write(SERIAL, previous, 'live');
    const written = images.write(SERIAL, replacement, 'live');

    expect(readFileSync(file).equals(previous)).toBe(true);
    expect((await images.read(SERIAL))?.equals(replacement)).toBe(true);

    await written;
    expect(readFileSync(file).equals(replacement)).toBe(true);
  });

  it('replaces one image at a time in the order the images were accepted', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    const last = jpeg('third image');

    await Promise.all([
      images.write(SERIAL, jpeg('first image'), 'live'),
      images.write(SERIAL, jpeg('second image'), 'live'),
      images.write(SERIAL, last, 'live'),
    ]);

    expect(readdirSync(join(root, 'snapshots'))).toEqual([opaqueName(SERIAL)]);
    expect(readFileSync(join(root, 'snapshots', opaqueName(SERIAL))).equals(last)).toBe(true);
    expect((await images.read(SERIAL))?.equals(last)).toBe(true);
  });

  it('survives restart and full Homebridge backup restoration', async () => {
    await new PersistedLastSuccessfulImages(root).write(SERIAL, jpeg('synthetic retained image'), 'live');

    expect((await new PersistedLastSuccessfulImages(root).read(SERIAL))?.equals(jpeg('synthetic retained image'))).toBe(
      true,
    );

    const restored = mkdtempSync(join(tmpdir(), 'homebridge-eufy-restore-'));
    try {
      cpSync(root, restored, { recursive: true });
      expect(
        (await new PersistedLastSuccessfulImages(restored).read(SERIAL))?.equals(jpeg('synthetic retained image')),
      ).toBe(true);
    } finally {
      rmSync(restored, { recursive: true, force: true });
    }
  });

  it('refuses images that are not bounded structural JPEGs', async () => {
    const images = new PersistedLastSuccessfulImages(root);

    await images.write(SERIAL, Buffer.from('synthetic non-image payload', 'utf8'), 'live');
    await images.write(SERIAL, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 0x21)]), 'live');
    await images.write(SERIAL, Buffer.alloc(0), 'stored-only');
    await images.write(
      SERIAL,
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(MAXIMUM_IMAGE_BYTES, 0x21),
        Buffer.from([0xff, 0xd9]),
      ]),
      'live',
    );

    expect(await images.read(SERIAL)).toBeUndefined();
    expect(existsSync(join(root, 'snapshots', opaqueName(SERIAL)))).toBe(false);
  });

  it('keeps a live image ahead of stored-only replacement for two minutes', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    vi.useFakeTimers();

    await images.write(SERIAL, jpeg('synthetic live image'), 'live');
    await images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    expect((await images.read(SERIAL))?.equals(jpeg('synthetic live image'))).toBe(true);

    vi.advanceTimersByTime(120_000);
    await images.write(SERIAL, jpeg('synthetic later stored image'), 'stored-only');
    expect((await images.read(SERIAL))?.equals(jpeg('synthetic later stored image'))).toBe(true);

    await images.write(SERIAL, jpeg('synthetic newer live image'), 'live');
    expect((await images.read(SERIAL))?.equals(jpeg('synthetic newer live image'))).toBe(true);
  });

  it('replaces a retained file only for a different stored-only image', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    const file = join(root, 'snapshots', opaqueName(SERIAL));

    await images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    const retained = statSync(file).ino;

    await images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    expect(statSync(file).ino).toBe(retained);

    await images.write(SERIAL, jpeg('synthetic different stored image'), 'stored-only');
    expect(statSync(file).ino).not.toBe(retained);
    expect((await images.read(SERIAL))?.equals(jpeg('synthetic different stored image'))).toBe(true);
  });

  it('resets retained image provenance across restart', async () => {
    await new PersistedLastSuccessfulImages(root).write(SERIAL, jpeg('synthetic live image'), 'live');

    const restarted = new PersistedLastSuccessfulImages(root);
    await restarted.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');

    expect((await restarted.read(SERIAL))?.equals(jpeg('synthetic stored image'))).toBe(true);
  });

  it('deletes malformed and oversized restored files', async () => {
    const directory = join(root, 'snapshots');
    mkdirSync(directory);

    const reportInvalid = vi.fn();
    const images = new PersistedLastSuccessfulImages(root, reportInvalid);
    for (const [serial, invalid] of [
      [SERIAL, Buffer.from('not a jpeg')],
      ['SYNTHETIC0000000002', Buffer.alloc(MAXIMUM_IMAGE_BYTES + 1)],
    ] as const) {
      const file = join(directory, opaqueName(serial));
      writeFileSync(file, invalid);
      expect(await images.read(serial)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    }
    expect(reportInvalid).toHaveBeenCalledOnce();
  });

  it('deletes one entity without disturbing another retained image', async () => {
    const other = 'SYNTHETIC0000000002';
    const images = new PersistedLastSuccessfulImages(root);
    await images.write(SERIAL, jpeg('first image'), 'live');
    await images.write(other, jpeg('second image'), 'live');

    await images.discard(SERIAL);

    expect(await images.read(SERIAL)).toBeUndefined();
    expect((await images.read(other))?.equals(jpeg('second image'))).toBe(true);
  });

  it('removes only images absent from a complete authoritative inventory', async () => {
    const retained = 'SYNTHETIC0000000002';
    const removed = 'SYNTHETIC0000000003';
    const images = new PersistedLastSuccessfulImages(root);
    await images.write(retained, jpeg('retained image'), 'live');
    await images.write(removed, jpeg('removed image'), 'live');

    await images.reconcile([retained]);

    expect((await images.read(retained))?.equals(jpeg('retained image'))).toBe(true);
    expect(await images.read(removed)).toBeUndefined();
  });

  it('deletes every retained image only on an explicit all-image cleanup', async () => {
    const images = new PersistedLastSuccessfulImages(root);
    await images.write(SERIAL, jpeg('first image'), 'live');
    await images.write('SYNTHETIC0000000002', jpeg('second image'), 'live');

    await images.discardAll();

    expect(existsSync(join(root, 'snapshots'))).toBe(false);
    expect(await images.read(SERIAL)).toBeUndefined();
  });
});
