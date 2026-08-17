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
    expect(script).toMatch(
      /menuDiagnostics\.addEventListener\('click',[\s\S]*requestWithinDeadline\('\/diagnostics\/status'/,
    );
    expect(stylesheet).toContain('.dashboard-actions');
    expect(stylesheet).toMatch(/\.shell\[data-theme=['"]dark['"]\] \.dashboard-action img/);
    expect(stylesheet).toMatch(/\.shell\[data-theme=['"]dark['"]\] \.dashboard-page-icon/);
    expect(stylesheet).toMatch(/\.shell\[data-theme=['"]dark['"]\] \.diagnostics-background-action img/);
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

  it('progressively discloses diagnostics while retaining direct profile selection', () => {
    const document = readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

    expect(document).toContain('data-diagnostics-question');
    expect(document).toContain('data-diagnostics-answer="yes"');
    expect(document).toContain('data-diagnostics-answer="no"');
    expect(document).toContain('data-diagnostics-direct');
    expect(document).toMatch(/data-diagnostics-direct-panel hidden/);
    expect(document).toMatch(/data-diagnostics-frequency hidden/);
    expect(document).toContain('data-diagnostics-frequency-answer="intermittent"');
    expect(document).toContain('data-diagnostics-frequency-answer="now"');
    expect(document).toMatch(/data-diagnostics-match hidden/);
    expect(document).toMatch(/data-diagnostics-actions hidden/);
    expect(document).toMatch(/data-diagnostics-result hidden/);
    expect(document).toMatch(/data-diagnostics-guidance[^>]+hidden/);
    expect(document).toContain('data-diagnostics-start-another');
    expect(document).toContain('tabindex="-1" data-diagnostics-question-text');
    expect(document).toContain('tabindex="-1" data-diagnostics-guidance-title');
    expect(document).toContain('aria-labelledby="diagnostics-question-heading"');
    expect(document).toContain('aria-labelledby="diagnostics-match-heading"');
    expect(document).toContain('aria-labelledby="diagnostics-frequency-heading"');
    expect(document).not.toContain('diagnostics-steps');
    expect(document).not.toContain('data-diagnostics-case');
    expect(document.indexOf('data-diagnostics-frequency-answer="intermittent"')).toBeLessThan(
      document.indexOf('data-diagnostics-frequency-answer="now"'),
    );
    expect(document).toContain('src="js/profile-wizard.js"');
    expect(document).toMatch(/data-diagnostics-background-action[\s\S]*?hidden/);
    expect(document).toContain('data-i18n-aria-label="diagnosticsBackgroundIssueVisible"');
  });
});
