import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('custom UI downloads', () => {
  it('uses a CSP-compatible data link for encrypted support archives', () => {
    const script = readFileSync(new URL('../../homebridge-ui/public/js/app.js', import.meta.url), 'utf8');

    expect(script).not.toContain('URL.createObjectURL');
    expect(script).not.toContain('blob:');
    expect(script).toContain('data:${exported.mediaType};base64,${exported.archive}');
    expect(script).toContain('document.body.appendChild(download)');
    expect(script).toContain('document.body.removeChild(download)');
  });

  it('renders the archive review confirmation as a bounded checkbox', () => {
    const stylesheet = readFileSync(new URL('../../homebridge-ui/public/app.css', import.meta.url), 'utf8');

    expect(stylesheet).toContain('.first-setup-confirmation input,\n.diagnostics-review-confirm input');
    expect(stylesheet).toContain('width: 18px;\n  min-height: 18px;\n  height: 18px;\n  flex: 0 0 auto;');
  });
});
