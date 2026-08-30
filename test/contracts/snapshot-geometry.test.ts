import { describe, expect, it, vi } from 'vitest';

import { jpegGeometry, SnapshotAcquisition } from '../../src/media/snapshot.js';

/**
 * A camera's native geometry, read from the image the plugin already retains for it.
 *
 * HomeKit is offered a fixed matrix of resolutions and picks one, and every entry offered was 16:9. A 4:3
 * camera therefore had its picture fitted inside a 16:9 frame: measured on a 1600x1200 doorbell negotiated
 * at 1280x720, the active picture is 960x720 with 160 black columns each side, so a quarter of every encoded
 * frame is black and that quarter is paid for out of the negotiated bit rate.
 *
 * The SDK publishes no native geometry before a stream runs — there is no cloud field for it, and the video
 * quality member is a tier label rather than a shape — so the retained image is the only account of it that
 * exists at setup. It is a real frame from that camera, and it survives restarts.
 */

/** A baseline JPEG carrying nothing but the geometry its start-of-frame declares. */
function jpegOf(width: number, height: number, marker = 0xc0): Buffer {
  const sof = Buffer.concat([
    Buffer.from([0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]),
    Buffer.alloc(9),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

describe('jpegGeometry', () => {
  it('reads the geometry a baseline start-of-frame declares', () => {
    expect(jpegGeometry(jpegOf(1600, 1200))).toEqual({ width: 1600, height: 1200 });
  });

  it('reads a progressive start-of-frame too, which a camera is free to send', () => {
    expect(jpegGeometry(jpegOf(1920, 1080, 0xc2))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads through the fill bytes a marker is allowed to be padded with', () => {
    const padded = jpegOf(1280, 720);
    const withFill = Buffer.concat([padded.subarray(0, 2), Buffer.from([0xff, 0xff]), padded.subarray(2)]);
    expect(jpegGeometry(withFill)).toEqual({ width: 1280, height: 720 });
  });

  it('answers nothing for a payload that is not a JPEG at all', () => {
    expect(jpegGeometry(Buffer.alloc(64, 7))).toBeUndefined();
  });

  it('answers nothing for a JPEG carrying no start-of-frame', () => {
    const headerOnly = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    expect(jpegGeometry(headerOnly)).toBeUndefined();
  });

  /**
   * A segment length that walks past the end, or a zero length that would not advance, are the two ways a
   * truncated or hostile image turns a scan into a hang or an out-of-range read.
   */
  it('answers nothing rather than looping on a segment that does not advance', () => {
    const zeroLength = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
    expect(jpegGeometry(zeroLength)).toBeUndefined();
  });

  it('answers nothing for a start-of-frame truncated before its geometry', () => {
    expect(jpegGeometry(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]))).toBeUndefined();
  });

  it('refuses a geometry no camera frame can have', () => {
    expect(jpegGeometry(jpegOf(0, 0))).toBeUndefined();
  });
});

describe('retained geometry through the snapshot seam', () => {
  it('answers the geometry of the image retained for that camera', async () => {
    const images = {
      read: vi.fn(async (serial: string) => (serial === 'DOORBELL' ? jpegOf(1600, 1200) : jpegOf(1920, 1080))),
      write: vi.fn(async () => undefined),
    };
    const acquisition = new SnapshotAcquisition(images);

    expect(await acquisition.retainedGeometry('DOORBELL')).toEqual({ width: 1600, height: 1200 });
    expect(await acquisition.retainedGeometry('OTHER')).toEqual({ width: 1920, height: 1080 });
  });

  it('answers nothing when no image is retained, so nothing is inferred from an absence', async () => {
    const acquisition = new SnapshotAcquisition({
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    });
    expect(await acquisition.retainedGeometry('COLD')).toBeUndefined();
  });

  it('answers nothing when the retained bytes carry no readable geometry', async () => {
    const acquisition = new SnapshotAcquisition({
      read: vi.fn(async () => Buffer.alloc(32, 1)),
      write: vi.fn(async () => undefined),
    });
    expect(await acquisition.retainedGeometry('ODD')).toBeUndefined();
  });

  it('answers nothing when the plugin retains no images at all', async () => {
    expect(await new SnapshotAcquisition().retainedGeometry('ANY')).toBeUndefined();
  });
});
