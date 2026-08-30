import { describe, expect, it } from 'vitest';

import {
  advertisedResolutions,
  DEFAULT_ADVERTISED_RESOLUTIONS,
  largestSourceGeometry,
} from '../../src/homekit/adapters/camera-streaming.js';

/**
 * What resolutions one camera advertises to HomeKit.
 *
 * A controller picks one entry from this matrix and the plugin must then deliver exactly that geometry, so a
 * matrix of one shape forces every camera into that shape. Every entry used to be 16:9, which fitted a 4:3
 * camera's picture inside a 16:9 frame: measured on a 1600x1200 doorbell negotiated at 1280x720, the picture
 * occupies 960x720 with 160 black columns each side, so a quarter of every encoded frame is black and that
 * quarter is charged against the negotiated bit rate.
 *
 * So the matrix is built from the camera's own geometry. A camera whose shape is not known yet keeps the
 * previous matrix, because a guessed shape is worse than a fitted one — it would tell HomeKit a shape the
 * camera does not have and the fitting would still happen, at the wrong ratio.
 *
 * This decides what is ADVERTISED. Whether a controller acts on it is separate and outside this unit: a
 * controller paired before the shape was known keeps the matrix it already read, because HAP's configuration
 * number is computed with characteristic values omitted.
 */

/** The aspect of one advertised entry, to the nearest thousandth. */
const aspect = ([width, height]: readonly number[]) => Math.round((width! / height!) * 1000) / 1000;

describe('advertisedResolutions', () => {
  it('keeps the standard matrix when the camera shape is unknown', () => {
    expect(advertisedResolutions(undefined)).toEqual(DEFAULT_ADVERTISED_RESOLUTIONS);
  });

  it('advertises the camera native shape for a 4:3 camera, and nothing of another shape', () => {
    const advertised = advertisedResolutions({ width: 1600, height: 1200 });
    expect(advertised.every((entry) => aspect(entry) === aspect([4, 3]))).toBe(true);
    expect(advertised).toContainEqual([1600, 1200, 30]);
  });

  it('advertises the standard shape unchanged for a 16:9 camera', () => {
    const advertised = advertisedResolutions({ width: 1920, height: 1080 });
    expect(advertised.every((entry) => aspect(entry) === aspect([16, 9]))).toBe(true);
    expect(advertised).toContainEqual([1920, 1080, 30]);
  });

  /**
   * A controller may pick any advertised entry, and asking for more pixels than the camera codes cannot make
   * the picture better — it costs bit rate upscaling. So the camera's own size is the ceiling.
   */
  it('never advertises more pixels than the camera produces', () => {
    const advertised = advertisedResolutions({ width: 1280, height: 960 });
    expect(advertised.every(([width, height]) => width! <= 1280 && height! <= 960)).toBe(true);
    expect(advertised).toContainEqual([1280, 960, 30]);
  });

  it('offers several sizes so a controller on a small tile is not forced to the largest', () => {
    expect(advertisedResolutions({ width: 1600, height: 1200 }).length).toBeGreaterThan(2);
  });

  /**
   * H.264 codes in macroblocks, so an odd dimension cannot be encoded and a controller that selected one
   * would be promised a geometry the encoder rounds away from.
   */
  it('advertises only even dimensions, which is all H.264 can code', () => {
    for (const shape of [
      { width: 1600, height: 1200 },
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 },
      { width: 1200, height: 1600 },
    ]) {
      const advertised = advertisedResolutions(shape);
      expect(advertised.every(([width, height]) => width! % 2 === 0 && height! % 2 === 0)).toBe(true);
    }
  });

  it('handles a portrait camera, whose shape no fixed matrix would have carried', () => {
    const advertised = advertisedResolutions({ width: 1200, height: 1600 });
    expect(advertised.every(([width, height]) => width! < height!)).toBe(true);
    expect(advertised).toContainEqual([1200, 1600, 30]);
  });

  it('declines a shape no camera frame can have rather than deriving a matrix from it', () => {
    expect(advertisedResolutions({ width: 0, height: 0 })).toEqual(DEFAULT_ADVERTISED_RESOLUTIONS);
    expect(advertisedResolutions({ width: 40, height: 30 })).toEqual(DEFAULT_ADVERTISED_RESOLUTIONS);
  });

  it('advertises every entry at the frame rate a live run may select', () => {
    const rates = new Set(advertisedResolutions({ width: 1600, height: 1200 }).map(([, , fps]) => fps));
    expect([...rates]).toEqual([30]);
  });
});

/**
 * Which geometry to keep as a camera's shape.
 *
 * The source is the SDK's own announcement, read from the parameter sets in force and delivered whenever the
 * source reconfigures. A camera runs an adaptive ladder, so a session is served a succession of rungs and the
 * newest announcement is not the shape — keeping it capped three of eight cameras on a real fleet at
 * 1280x720, below what they produce. A retained snapshot was tried first and was worse: one frame of the same
 * ladder, and corruptible by any cross-camera leak upstream, which wrote another camera's picture into four of
 * eight retained images.
 */
describe('largestSourceGeometry', () => {
  it('takes the first announcement when nothing is recorded', () => {
    expect(largestSourceGeometry(undefined, { width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
  });

  it('grows to a larger rung', () => {
    expect(largestSourceGeometry({ width: 640, height: 360 }, { width: 1920, height: 1080 })).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('keeps the recorded shape when the ladder drops back', () => {
    const recorded = { width: 1920, height: 1080 };
    expect(largestSourceGeometry(recorded, { width: 960, height: 540 })).toBe(recorded);
  });

  it('converges on the largest across a whole ladder, in any order', () => {
    let kept: { readonly width: number; readonly height: number } | undefined;
    for (const rung of [
      { width: 1280, height: 720 },
      { width: 640, height: 360 },
      { width: 2304, height: 1296 },
      { width: 960, height: 540 },
    ]) {
      kept = largestSourceGeometry(kept, rung);
    }
    expect(kept).toEqual({ width: 2304, height: 1296 });
  });

  it('prefers a taller shape of the same width, comparing area rather than width', () => {
    expect(largestSourceGeometry({ width: 1600, height: 900 }, { width: 1600, height: 1200 })).toEqual({
      width: 1600,
      height: 1200,
    });
  });

  it('refuses a malformed report rather than letting it displace a recorded shape', () => {
    const recorded = { width: 1600, height: 1200 };
    expect(largestSourceGeometry(recorded, { width: 0, height: 0 })).toBe(recorded);
    expect(largestSourceGeometry(undefined, { width: -1, height: 720 })).toBeUndefined();
  });
});
