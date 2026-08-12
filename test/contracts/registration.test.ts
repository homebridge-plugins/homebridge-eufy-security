import { describe, expect, it, vi } from 'vitest';

import registerPlugin from '../../src/index.js';
import { EufyPlatform } from '../../src/platform.js';

describe('plugin registration', () => {
  it('registers the V5-only HomebridgeEufy platform alias', () => {
    const registerPlatform = vi.fn();

    registerPlugin({ registerPlatform });

    expect(registerPlatform).toHaveBeenCalledExactlyOnceWith(
      '@homebridge-plugins/homebridge-eufy-security',
      'HomebridgeEufy',
      EufyPlatform,
    );
  });
});
