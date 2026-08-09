import { describe, expect, it, vi } from 'vitest';

import registerPlugin from '../../src/index.js';
import { EufySecurityPlatform } from '../../src/platform.js';

describe('plugin registration', () => {
  it('registers the historical EufySecurity platform alias', () => {
    const registerPlatform = vi.fn();

    registerPlugin({ registerPlatform });

    expect(registerPlatform).toHaveBeenCalledExactlyOnceWith(
      '@homebridge-plugins/homebridge-eufy-security',
      'EufySecurity',
      EufySecurityPlatform,
    );
  });
});
