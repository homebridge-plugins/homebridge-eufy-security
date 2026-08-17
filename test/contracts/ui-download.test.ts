import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('custom UI downloads', () => {
  it('exposes the three dashboard actions directly without a popover menu', () => {
    const document = readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../../homebridge-ui/public/js/app.js', import.meta.url), 'utf8');
    const stylesheet = readFileSync(new URL('../../homebridge-ui/public/app.css', import.meta.url), 'utf8');

    expect(document).toContain('class="dashboard-actions"');
    expect(document.match(/class="dashboard-action"/g)).toHaveLength(3);
    expect(document).not.toContain('data-dashboard-menu-trigger');
    expect(document).not.toContain('dashboard-menu-popover');
    expect(script).not.toContain('dashboardMenuTrigger');
    expect(script).not.toContain('dashboardMenu');
    expect(stylesheet).toContain('.dashboard-actions');
    expect(stylesheet).toContain('.shell[data-theme="dark"] .dashboard-action img');
  });

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
