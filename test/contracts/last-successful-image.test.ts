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

  it('stores a validated image atomically under an owner-only opaque name', () => {
    const images = new PersistedLastSuccessfulImages(root);
    const image = jpeg('synthetic live image');

    images.write(SERIAL, image, 'live');

    const directory = join(root, 'snapshots');
    expect(readdirSync(directory)).toEqual([opaqueName(SERIAL)]);
    expect(readdirSync(directory).join(':')).not.toContain(SERIAL);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, opaqueName(SERIAL))).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, opaqueName(SERIAL))).equals(image)).toBe(true);
    expect(images.read(SERIAL)?.equals(image)).toBe(true);
  });

  it('survives restart and full Homebridge backup restoration', () => {
    new PersistedLastSuccessfulImages(root).write(SERIAL, jpeg('synthetic retained image'), 'live');

    expect(new PersistedLastSuccessfulImages(root).read(SERIAL)?.equals(jpeg('synthetic retained image'))).toBe(true);

    const restored = mkdtempSync(join(tmpdir(), 'homebridge-eufy-restore-'));
    try {
      cpSync(root, restored, { recursive: true });
      expect(new PersistedLastSuccessfulImages(restored).read(SERIAL)?.equals(jpeg('synthetic retained image'))).toBe(
        true,
      );
    } finally {
      rmSync(restored, { recursive: true, force: true });
    }
  });

  it('refuses images that are not bounded structural JPEGs', () => {
    const images = new PersistedLastSuccessfulImages(root);

    images.write(SERIAL, Buffer.from('synthetic non-image payload', 'utf8'), 'live');
    images.write(SERIAL, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 0x21)]), 'live');
    images.write(SERIAL, Buffer.alloc(0), 'stored-only');
    images.write(
      SERIAL,
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(MAXIMUM_IMAGE_BYTES, 0x21),
        Buffer.from([0xff, 0xd9]),
      ]),
      'live',
    );

    expect(images.read(SERIAL)).toBeUndefined();
    expect(existsSync(join(root, 'snapshots', opaqueName(SERIAL)))).toBe(false);
  });

  it('keeps a live image ahead of stored-only replacement for two minutes', () => {
    const images = new PersistedLastSuccessfulImages(root);
    vi.useFakeTimers();

    images.write(SERIAL, jpeg('synthetic live image'), 'live');
    images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    expect(images.read(SERIAL)?.equals(jpeg('synthetic live image'))).toBe(true);

    vi.advanceTimersByTime(120_000);
    images.write(SERIAL, jpeg('synthetic later stored image'), 'stored-only');
    expect(images.read(SERIAL)?.equals(jpeg('synthetic later stored image'))).toBe(true);

    images.write(SERIAL, jpeg('synthetic newer live image'), 'live');
    expect(images.read(SERIAL)?.equals(jpeg('synthetic newer live image'))).toBe(true);
  });

  it('replaces a retained file only for a different stored-only image', () => {
    const images = new PersistedLastSuccessfulImages(root);
    const file = join(root, 'snapshots', opaqueName(SERIAL));

    images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    const retained = statSync(file).ino;

    images.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');
    expect(statSync(file).ino).toBe(retained);

    images.write(SERIAL, jpeg('synthetic different stored image'), 'stored-only');
    expect(statSync(file).ino).not.toBe(retained);
    expect(images.read(SERIAL)?.equals(jpeg('synthetic different stored image'))).toBe(true);
  });

  it('resets retained image provenance across restart', () => {
    new PersistedLastSuccessfulImages(root).write(SERIAL, jpeg('synthetic live image'), 'live');

    const restarted = new PersistedLastSuccessfulImages(root);
    restarted.write(SERIAL, jpeg('synthetic stored image'), 'stored-only');

    expect(restarted.read(SERIAL)?.equals(jpeg('synthetic stored image'))).toBe(true);
  });

  it('deletes malformed and oversized restored files', () => {
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
      expect(images.read(serial)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    }
    expect(reportInvalid).toHaveBeenCalledOnce();
  });

  it('deletes one entity without disturbing another retained image', () => {
    const other = 'SYNTHETIC0000000002';
    const images = new PersistedLastSuccessfulImages(root);
    images.write(SERIAL, jpeg('first image'), 'live');
    images.write(other, jpeg('second image'), 'live');

    images.discard(SERIAL);

    expect(images.read(SERIAL)).toBeUndefined();
    expect(images.read(other)?.equals(jpeg('second image'))).toBe(true);
  });

  it('removes only images absent from a complete authoritative inventory', () => {
    const retained = 'SYNTHETIC0000000002';
    const removed = 'SYNTHETIC0000000003';
    const images = new PersistedLastSuccessfulImages(root);
    images.write(retained, jpeg('retained image'), 'live');
    images.write(removed, jpeg('removed image'), 'live');

    images.reconcile([retained]);

    expect(images.read(retained)?.equals(jpeg('retained image'))).toBe(true);
    expect(images.read(removed)).toBeUndefined();
  });

  it('deletes every retained image only on an explicit all-image cleanup', () => {
    const images = new PersistedLastSuccessfulImages(root);
    images.write(SERIAL, jpeg('first image'), 'live');
    images.write('SYNTHETIC0000000002', jpeg('second image'), 'live');

    images.discardAll();

    expect(existsSync(join(root, 'snapshots'))).toBe(false);
    expect(images.read(SERIAL)).toBeUndefined();
  });
});
