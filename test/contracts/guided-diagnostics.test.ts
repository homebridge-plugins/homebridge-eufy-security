import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  createDiagnosticLogger,
  GuidedDiagnostics,
  recordFfmpegEnvironment,
  reportAdaptationNotice,
  reportRuntimeNotice,
} from '../../src/diagnostics.js';

const HOUR_MS = 60 * 60 * 1_000;

interface TestSupportArchiveEnvelope {
  format: 'homebridge-eufy-support-archive';
  version: 1;
  keyId: string;
  wrappedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  keyWrapAlgorithm: 'RSA-OAEP-SHA256';
  contentAlgorithm: 'AES-256-GCM';
  contentEncoding: 'gzip+json';
}

function decryptSupportArchive(value: Buffer, privateKey: string): Record<string, unknown> {
  const envelope = JSON.parse(gunzipSync(value).toString('utf8')) as TestSupportArchiveEnvelope;
  const key = privateDecrypt(
    {
      key: privateKey,
      oaepHash: 'sha256',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(envelope.wrappedKey, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(
    Buffer.from(
      JSON.stringify({
        format: envelope.format,
        version: envelope.version,
        keyId: envelope.keyId,
        keyWrapAlgorithm: envelope.keyWrapAlgorithm,
        contentAlgorithm: envelope.contentAlgorithm,
        contentEncoding: envelope.contentEncoding,
      }),
      'utf8',
    ),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const compressed = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString('utf8')) as Record<string, unknown>;
}

function encryptSupportPayload(payload: Record<string, unknown>, publicKey: string, keyId: string): Buffer {
  const metadata = {
    format: 'homebridge-eufy-support-archive',
    version: 1,
    keyId,
    keyWrapAlgorithm: 'RSA-OAEP-SHA256',
    contentAlgorithm: 'AES-256-GCM',
    contentEncoding: 'gzip+json',
  } as const;
  const contentKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
    const ciphertext = Buffer.concat([
      cipher.update(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))),
      cipher.final(),
    ]);
    return gzipSync(
      Buffer.from(
        JSON.stringify({
          ...metadata,
          wrappedKey: publicEncrypt(
            {
              key: publicKey,
              oaepHash: 'sha256',
              padding: constants.RSA_PKCS1_OAEP_PADDING,
            },
            contentKey,
          ).toString('base64'),
          iv: iv.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        }),
      ),
    );
  } finally {
    contentKey.fill(0);
  }
}

describe('guided diagnostics session', () => {
  it('accepts UI events only while a dashboard reproduction is active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root);

    try {
      await expect(diagnostics.recordUiEvent('dashboard-opened')).rejects.toThrow();
      await diagnostics.authorize('control-state', 'now');
      await diagnostics.startReproduction();
      await expect(diagnostics.recordUiEvent('dashboard-opened')).rejects.toThrow('active dashboard');

      await diagnostics.authorize('dashboard-ui', 'now');
      await expect(diagnostics.recordUiEvent('dashboard-opened')).rejects.toThrow('active dashboard');
      await diagnostics.startReproduction();
      await expect(diagnostics.recordUiEvent('dashboard-opened')).resolves.toBeUndefined();
      await expect(diagnostics.recordUiEvent('free-text' as never)).rejects.toThrow('Unknown diagnostics UI event');

      await diagnostics.endReproduction();
      await expect(diagnostics.recordUiEvent('issue-observed')).rejects.toThrow('closing');

      await diagnostics.authorize('dashboard-ui', 'intermittent');
      await diagnostics.startReproduction();
      await expect(diagnostics.recordUiEvent('dashboard-opened')).resolves.toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('starts another dashboard reproduction after completion and accepts UI events again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      await diagnostics.authorize('dashboard-ui', 'now');
      const first = await diagnostics.startReproduction();
      await diagnostics.recordUiEvent('background-started');
      now += 1_000;
      await diagnostics.endReproduction();

      now += 1_000;
      const second = await diagnostics.startReproduction();
      expect(second).toMatchObject({ status: 'reproducing' });
      expect(second.supportCaseId).not.toBe(first.supportCaseId);
      await expect(diagnostics.recordUiEvent('dashboard-opened')).resolves.toBeUndefined();

      const events = readFileSync(join(root, 'diagnostics', 'ui-events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { event: string }).event);
      expect(events).toEqual(['background-started', 'dashboard-opened']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('persists fixed-shape UI events without caller-supplied fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root, () => Date.parse('2026-08-16T08:00:00.000Z'));

    try {
      const authorized = await diagnostics.authorize('dashboard-ui', 'intermittent');
      await diagnostics.startReproduction();
      await diagnostics.recordUiEvent('dashboard-opened');
      await diagnostics.recordUiEvent('issue-observed');

      const path = join(root, 'diagnostics', 'ui-events.jsonl');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, 'diagnostics')).mode & 0o777).toBe(0o700);
      const records = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(Object.keys(records[0]!).sort()).toEqual(['event', 'supportCaseId', 'timestamp', 'version']);
      expect(records.at(-1)).toEqual({
        version: 1,
        supportCaseId: authorized.supportCaseId,
        timestamp: '2026-08-16T08:00:00.000Z',
        event: 'issue-observed',
      });
      expect(JSON.stringify(records)).not.toMatch(/serial|device|account|credential|answer|configuration|url/i);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * The cap is what stops a support session filling the disk, and it is stated in bytes — so what has to be
   * proven is that crossing it drops the oldest record, not that a thousand appends eventually do.
   *
   * The file is seeded to just under the cap in one write and then one event is recorded. That exercises the
   * same branch as any volume would, and it can assert the thing volume never did: that the oldest record is
   * the one that went.
   */
  it('drops the oldest UI event rather than growing past its byte cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root, () => Date.parse('2026-08-16T08:00:00.000Z'));

    try {
      const authorized = await diagnostics.authorize('dashboard-ui', 'intermittent');
      await diagnostics.startReproduction();
      await diagnostics.recordUiEvent('dashboard-opened');

      const path = join(root, 'diagnostics', 'ui-events.jsonl');
      const shape = (event: string): string =>
        `${JSON.stringify({
          version: 1,
          supportCaseId: authorized.supportCaseId,
          timestamp: '2026-08-16T08:00:00.000Z',
          event,
        })}\n`;
      const filler = shape('dashboard-opened');
      const oldest = shape('request-failed');
      const seeded = oldest + filler.repeat(Math.floor((64 * 1_024 - oldest.length - 1) / filler.length));
      writeFileSync(path, seeded, { encoding: 'utf8', mode: 0o600 });
      expect(seeded.length, 'seeded just under the cap, so one more record has to cross it').toBeLessThan(64 * 1_024);

      await diagnostics.recordUiEvent('issue-observed');

      const records = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string });
      expect(statSync(path).size, 'the cap is the point').toBeLessThanOrEqual(64 * 1_024);
      expect(records.at(-1)?.event, 'the newest record is kept').toBe('issue-observed');
      expect(
        records.map(({ event }) => event),
        'and the oldest is the one dropped',
      ).not.toContain('request-failed');
      expect(
        records.every(({ event }) => typeof event === 'string'),
        'every retained line stays valid JSONL',
      ).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('bounds pending UI events and keeps every accepted record as valid JSONL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root);

    try {
      await diagnostics.authorize('dashboard-ui', 'now');
      await diagnostics.startReproduction();
      const results = await Promise.allSettled(
        Array.from({ length: 9 }, () => diagnostics.recordUiEvent('dashboard-opened')),
      );

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(8);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: expect.objectContaining({ message: 'Diagnostics UI event queue is full' }),
      });
      const lines = readFileSync(join(root, 'diagnostics', 'ui-events.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(8);
      expect(lines.map((line) => JSON.parse(line))).toHaveLength(8);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('authorizes only an allowlisted profile with a random support case identifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const first = await diagnostics.authorize('device-representation', 'now');
      now += 1;
      const second = await diagnostics.authorize('device-representation', 'intermittent');

      expect(first).toMatchObject({
        status: 'authorized',
        profile: 'device-representation',
        reproductionMode: 'now',
        expiresAt: '2026-08-19T08:00:00.000Z',
      });
      expect(first.supportCaseId).toMatch(/^support-[0-9a-f-]{36}$/);
      expect(second.supportCaseId).not.toBe(first.supportCaseId);
      expect(second.reproductionMode).toBe('intermittent');
      expect(JSON.parse(readFileSync(join(root, 'diagnostics', 'session.json'), 'utf8')).reproductionMode).toBe(
        'intermittent',
      );
      await expect(diagnostics.authorize('everything' as never, 'now')).rejects.toThrow('Unknown diagnostics profile');
      await expect(diagnostics.authorize('device-representation', 'later' as never)).rejects.toThrow(
        'Unknown diagnostics reproduction mode',
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves the original 72-hour expiry across restart and suppresses debug evidence after expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const authorized = await diagnostics.authorize('startup-authentication', 'intermittent');
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-opened' }));
      await logger.flush?.();

      now += 71 * HOUR_MS;
      const restarted = new GuidedDiagnostics(root, () => now);
      expect((await restarted.status()).expiresAt).toBe(authorized.expiresAt);
      expect((await restarted.status()).reproductionMode).toBe('intermittent');

      now += 2 * HOUR_MS;
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-closed' }));
      await logger.flush?.();

      const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map(({ event }) => event)).toEqual(['connection-opened']);
      expect(await restarted.status()).toMatchObject({ status: 'expired', expiresAt: authorized.expiresAt });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('defaults a live version-1 session without a reproduction mode to now', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const now = Date.parse('2026-08-16T08:00:00.000Z');
    mkdirSync(join(root, 'diagnostics'), { recursive: true });
    writeFileSync(
      join(root, 'diagnostics', 'session.json'),
      `${JSON.stringify({
        version: 1,
        supportCaseId: 'support-00000000-0000-4000-8000-000000000000',
        profile: 'startup-authentication',
        authorizedAt: '2026-08-16T07:00:00.000Z',
        expiresAt: '2026-08-19T07:00:00.000Z',
      })}\n`,
    );

    try {
      expect(await new GuidedDiagnostics(root, () => now).status()).toMatchObject({
        status: 'authorized',
        reproductionMode: 'now',
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('reviews, exports, and decrypts a completed legacy version-1 session as now', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const fingerprint = createHash('sha256').update(publicKey.trim()).digest('hex');
    mkdirSync(join(root, 'diagnostics'), { recursive: true });
    writeFileSync(
      join(root, 'diagnostics', 'session.json'),
      `${JSON.stringify({
        version: 1,
        supportCaseId: 'support-00000000-0000-4000-8000-000000000010',
        profile: 'startup-authentication',
        authorizedAt: '2026-08-16T07:00:00.000Z',
        expiresAt: '2026-08-19T07:00:00.000Z',
        reproductionStartedAt: '2026-08-17T07:59:00.000Z',
        reproductionEndedAt: '2026-08-17T08:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );
    const diagnostics = new GuidedDiagnostics(root, () => Date.parse('2026-08-17T08:00:05.000Z'), {
      keyId: 'test-support-key',
      publicKey,
      sha256: fingerprint,
    });

    try {
      const review = await diagnostics.reviewSupportArchive();
      expect(review.manifest).toMatchObject({
        version: 1,
        profile: 'startup-authentication',
        reproductionMode: 'now',
      });
      const exported = await diagnostics.exportSupportArchive(review.reviewId);
      expect(
        (decryptSupportArchive(exported.archive, privateKey).manifest as Record<string, unknown>).reproductionMode,
      ).toBe('now');

      const archivePath = join(root, exported.filename);
      const privateKeyPath = join(root, 'test-private.pem');
      writeFileSync(archivePath, exported.archive, { mode: 0o600 });
      writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../scripts/decrypt-diagnostics.mjs', import.meta.url)), archivePath, privateKeyPath],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...process.env, HOMEBRIDGE_EUFY_SUPPORT_KEY_SHA256: fingerprint },
        },
      );
      expect(
        JSON.parse(readFileSync(join(archivePath.replace(/\.eufysupport\.gz$/, ''), 'manifest.json'), 'utf8')),
      ).toMatchObject({ version: 1, reproductionMode: 'now' });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('admits verbose evidence only when the selected profile includes its scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root);

    try {
      await diagnostics.authorize('dashboard-ui', 'now');
      const logger = createDiagnosticLogger({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, root);
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-opened' }));
      reportRuntimeNotice(logger, 'status-publication-failed');
      await logger.flush?.();

      const records = readFileSync(join(root, 'logs', 'homebridge-eufy.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map(({ scope }) => scope)).toEqual(['runtime-notice']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('marks a bounded reproduction and reports exact missing evidence with issue context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const authorized = await diagnostics.authorize('control-state', 'now');
      await diagnostics.startReproduction();
      rmSync(join(root, 'diagnostics', 'reproduction-markers.jsonl'));
      await diagnostics.startReproduction();
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      logger.debug?.(
        JSON.stringify({
          scope: 'homekit',
          level: 'debug',
          adapter: 'contact.sensor',
          event: 'contact-state',
          observation: 'valid',
        }),
      );
      await logger.flush?.();
      now += 5_000;
      const prepared = await diagnostics.endReproduction();

      expect(prepared).toMatchObject({
        status: 'complete',
        supportCaseId: authorized.supportCaseId,
        profile: 'control-state',
        missingEvidence: ['sdk-log'],
        partialExportAvailable: true,
      });
      expect(prepared.issueUrl).toContain(encodeURIComponent(authorized.supportCaseId));
      expect(prepared.issueUrl).toContain(encodeURIComponent('Reproduction mode: now'));
      expect((await diagnostics.reviewSupportArchive()).manifest.evidence).toContainEqual({
        evidence: 'sdk-log',
        privacyClass: 'diagnostic',
        status: 'missing',
        missingReason: 'no-allowlisted-record-observed',
      });
      const markers = readFileSync(join(root, 'diagnostics', 'reproduction-markers.jsonl'), 'utf8');
      expect(markers).toContain('"event":"reproduction-started"');
      expect(markers).toContain('"event":"reproduction-ended"');
      expect(markers).not.toMatch(/serial|device|camera/i);

      now += 73 * HOUR_MS;
      expect(await diagnostics.status()).toMatchObject({
        status: 'expired',
        partialExportAvailable: true,
        issueUrl: prepared.issueUrl,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('collects generated UI events as field-classified ui-log archive evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const diagnostics = new GuidedDiagnostics(root, () => Date.parse('2026-08-17T08:00:00.000Z'), {
      keyId: 'test-support-key',
      publicKey,
      sha256: createHash('sha256').update(publicKey.trim()).digest('hex'),
    });

    try {
      await diagnostics.authorize('dashboard-ui', 'intermittent');
      await diagnostics.startReproduction();
      await diagnostics.recordUiEvent('background-started');
      await diagnostics.recordUiEvent('authentication-opened');
      const finalEvent = diagnostics.recordUiEvent('issue-observed');
      const ending = diagnostics.endReproduction();
      await expect(diagnostics.recordUiEvent('dashboard-opened')).rejects.toThrow('closing');
      const completed = await ending;
      await expect(finalEvent).resolves.toBeUndefined();

      expect(completed.missingEvidence).not.toContain('ui-log');
      const review = await diagnostics.reviewSupportArchive();
      expect(review.manifest.evidence).toContainEqual(
        expect.objectContaining({
          evidence: 'ui-log',
          privacyClass: 'diagnostic',
          status: 'included',
          fields: [
            { field: 'version', privacyClass: 'operational' },
            { field: 'supportCaseId', privacyClass: 'pseudonymous' },
            { field: 'timestamp', privacyClass: 'operational' },
            { field: 'event', privacyClass: 'diagnostic' },
          ],
        }),
      );

      const exported = await diagnostics.exportSupportArchive(review.reviewId);
      const payload = decryptSupportArchive(exported.archive, privateKey);
      const uiLog = (payload.evidence as Array<{ content?: string; evidence?: string }>).find(
        ({ evidence }) => evidence === 'ui-log',
      )?.content;
      expect(uiLog).toContain('"event":"background-started"');
      expect(uiLog).toContain('"event":"authentication-opened"');
      expect(uiLog).toContain('"event":"issue-observed"');
      expect(uiLog).not.toMatch(/serial|device|account|credential|answer|configuration|url/i);

      const archivePath = join(root, exported.filename);
      const privateKeyPath = join(root, 'test-private.pem');
      writeFileSync(archivePath, exported.archive, { mode: 0o600 });
      writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../../scripts/decrypt-diagnostics.mjs', import.meta.url)), archivePath, privateKeyPath],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            ...process.env,
            HOMEBRIDGE_EUFY_SUPPORT_KEY_SHA256: createHash('sha256').update(publicKey.trim()).digest('hex'),
          },
        },
      );
      const extractedUiLog = join(archivePath.replace(/\.eufysupport\.gz$/, ''), 'ui-log.jsonl');
      expect(statSync(extractedUiLog).mode & 0o777).toBe(0o600);
      const extractedRecords = readFileSync(extractedUiLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(extractedRecords.map(({ event }) => event)).toEqual([
        'background-started',
        'authentication-opened',
        'issue-observed',
      ]);
      expect(
        extractedRecords.every(
          (record) => Object.keys(record).sort().join(',') === 'event,supportCaseId,timestamp,version',
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('exports generated allowlisted evidence only after manifest review and only as an encrypted archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const testKeyFingerprint = createHash('sha256').update(publicKey.trim()).digest('hex');
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now, {
      keyId: 'test-support-key',
      publicKey,
      sha256: testKeyFingerprint,
    });

    try {
      await diagnostics.authorize('control-state', 'intermittent');
      await diagnostics.startReproduction();
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      reportRuntimeNotice(logger, 'status-publication-failed');
      logger.debug?.(
        JSON.stringify({
          scope: 'diagnostic-condition',
          level: 'warn',
          code: 'invalid-contact-observation',
          active: true,
          reason: 'malformed',
          capability: 'contact',
          member: 'open',
          affectedAccessoryCount: 1,
          accessoryAliases: ['accessory-00000000-0000-4000-8000-000000000000'],
        }),
      );
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'debug', subsystem: 'mqtt', event: 'connection-opened' }));
      logger.debug?.(
        JSON.stringify({
          scope: 'homekit',
          level: 'debug',
          adapter: 'contact.sensor',
          event: 'contact-state',
          observation: 'valid',
        }),
      );
      await logger.flush?.();
      now += 5_000;
      await diagnostics.endReproduction();

      const forbidden = 'must-never-enter-support-archive';
      for (const path of [
        join(root, 'accounts', 'session.json'),
        join(root, 'keys', 'private.pem'),
        join(root, 'snapshots', 'camera.jpg'),
        join(root, 'captures', 'talkback.aac'),
        join(root, 'captures', 'raw-video.h264'),
      ]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, forbidden);
      }

      const review = await diagnostics.reviewSupportArchive();
      expect(review.manifest).toMatchObject({
        version: 1,
        archiveFormat: 'homebridge-eufy-support-archive',
        keyId: 'test-support-key',
        profile: 'control-state',
        reproductionMode: 'intermittent',
        evidence: [
          { evidence: 'environment', privacyClass: 'operational', status: 'included' },
          { evidence: 'reproduction-markers', privacyClass: 'operational', status: 'included' },
          { evidence: 'plugin-log', privacyClass: 'diagnostic', status: 'included' },
          { evidence: 'sdk-log', privacyClass: 'diagnostic', status: 'included' },
          { evidence: 'homekit-log', privacyClass: 'diagnostic', status: 'included' },
        ],
      });
      expect(review.manifest.excludedClasses).toContain('credentials-and-authentication');
      expect(review.manifest.archiveExpiresAt).toBe('2026-08-18T08:00:05.000Z');
      expect(review.manifest.evidence[0]).toMatchObject({
        fields: [
          { field: 'version', privacyClass: 'operational' },
          { field: 'node', privacyClass: 'operational' },
          { field: 'platform', privacyClass: 'operational' },
          { field: 'arch', privacyClass: 'operational' },
        ],
      });
      expect(review.manifest.evidence.find(({ evidence }) => evidence === 'plugin-log')?.fields).toEqual(
        expect.arrayContaining([
          { field: 'accessoryAliases', privacyClass: 'pseudonymous' },
          { field: 'timestamp', privacyClass: 'operational' },
        ]),
      );
      await expect(diagnostics.exportSupportArchive('unreviewed')).rejects.toThrow('review');

      const exported = await diagnostics.exportSupportArchive(review.reviewId);
      expect(exported.filename).toMatch(/^homebridge-eufy-support-[0-9a-f-]{36}\.eufysupport\.gz$/);
      expect(exported.mediaType).toBe('application/gzip');
      expect(exported.archive.toString('utf8')).not.toContain(forbidden);
      expect(exported.archive.toString('utf8')).not.toContain('contact-state');
      await expect(diagnostics.exportSupportArchive(review.reviewId)).rejects.toThrow('review');

      const payload = decryptSupportArchive(exported.archive, privateKey);
      expect(payload.manifest).toEqual(review.manifest);
      expect(payload).toMatchObject({
        evidence: [
          { evidence: 'environment', privacyClass: 'operational', contentType: 'application/json' },
          { evidence: 'reproduction-markers', privacyClass: 'operational', contentType: 'application/x-ndjson' },
          { evidence: 'plugin-log', privacyClass: 'diagnostic', contentType: 'application/x-ndjson' },
          { evidence: 'sdk-log', privacyClass: 'diagnostic', contentType: 'application/x-ndjson' },
          { evidence: 'homekit-log', privacyClass: 'diagnostic', contentType: 'application/x-ndjson' },
        ],
      });
      expect(JSON.stringify(payload)).toContain('contact-state');
      expect(JSON.stringify(payload)).not.toContain(forbidden);

      const archivePath = join(root, exported.filename);
      const privateKeyPath = join(root, 'test-private.pem');
      writeFileSync(archivePath, exported.archive, { mode: 0o600 });
      writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
      const decryptor = fileURLToPath(new URL('../../scripts/decrypt-diagnostics.mjs', import.meta.url));
      const decryptorSource = readFileSync(decryptor, 'utf8');
      expect(decryptorSource).not.toMatch(/node:(?:http|https|net|tls|dgram|child_process)/);
      expect(decryptorSource).not.toMatch(/\b(?:fetch|eval)\s*\(/);
      expect(() =>
        execFileSync(process.execPath, [decryptor, archivePath, privateKeyPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
        }),
      ).toThrow();
      const decryptOutput = execFileSync(process.execPath, [decryptor, archivePath, privateKeyPath], {
        encoding: 'utf8',
        env: { ...process.env, HOMEBRIDGE_EUFY_SUPPORT_KEY_SHA256: testKeyFingerprint },
      });
      const extracted = archivePath.replace(/\.eufysupport\.gz$/, '');
      expect(decryptOutput).toContain('Authenticated V5 support archive');
      expect(JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'))).toEqual(review.manifest);
      expect(readFileSync(join(extracted, 'homekit-log.jsonl'), 'utf8')).toContain('contact-state');
      expect(() => readFileSync(join(extracted, 'raw-media.json'), 'utf8')).toThrow();

      const legacyDirectory = join(root, 'legacy');
      mkdirSync(legacyDirectory, { mode: 0o700 });
      const legacyPayload = JSON.parse(JSON.stringify(payload)) as {
        manifest: Record<string, unknown>;
      } & Record<string, unknown>;
      delete legacyPayload.manifest.reproductionMode;
      const legacyArchivePath = join(legacyDirectory, exported.filename);
      const legacyKeyPath = join(legacyDirectory, 'test-private.pem');
      writeFileSync(legacyArchivePath, encryptSupportPayload(legacyPayload, publicKey, 'test-support-key'), {
        mode: 0o600,
      });
      writeFileSync(legacyKeyPath, privateKey, { mode: 0o600 });
      execFileSync(process.execPath, [decryptor, legacyArchivePath, legacyKeyPath], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, HOMEBRIDGE_EUFY_SUPPORT_KEY_SHA256: testKeyFingerprint },
      });
      expect(
        JSON.parse(readFileSync(join(legacyArchivePath.replace(/\.eufysupport\.gz$/, ''), 'manifest.json'), 'utf8')),
      ).toMatchObject({ version: 1, reproductionMode: 'now' });

      const tampered = JSON.parse(gunzipSync(exported.archive).toString('utf8')) as TestSupportArchiveEnvelope;
      tampered.keyId = 'substituted-key';
      expect(() => decryptSupportArchive(gzipSync(JSON.stringify(tampered)), privateKey)).toThrow();

      const expiredReview = await diagnostics.reviewSupportArchive();
      now += 24 * HOUR_MS;
      await expect(diagnostics.exportSupportArchive(expiredReview.reviewId)).rejects.toThrow('stale');

      const invalidKeyDiagnostics = new GuidedDiagnostics(root, () => now - 24 * HOUR_MS, {
        keyId: 'test-support-key',
        publicKey,
        sha256: '0'.repeat(64),
      });
      const invalidKeyReview = await invalidKeyDiagnostics.reviewSupportArchive();
      await expect(invalidKeyDiagnostics.exportSupportArchive(invalidKeyReview.reviewId)).rejects.toThrow(
        'key integrity',
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * The whole point of a profile is that a maintainer receives what it declares. `live-media` declared FFmpeg
   * output and had no producer for it, so a live-media archive arrived a third short of itself and the one
   * line naming the missing encoder was never in it.
   */
  it('collects every evidence class the live-media profile declares, including FFmpeg output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      await diagnostics.authorize('live-media', 'now');
      await diagnostics.startReproduction();
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      reportRuntimeNotice(logger, 'status-publication-failed');
      logger.debug?.(JSON.stringify({ scope: 'sdk', level: 'warn', subsystem: 'p2p', event: 'media-error' }));
      logger.debug?.(
        JSON.stringify({
          scope: 'homekit',
          level: 'debug',
          adapter: 'camera.streaming',
          event: 'live-session-failed',
          outcome: 'failed',
          reason: 'adaptation-exited-before-output',
          stage: 'first-adapted-output',
        }),
      );
      reportAdaptationNotice(logger, {
        role: 'live-video',
        event: 'exited-before-output',
        code: 234,
        stderr: ["Unknown encoder 'libx264'"],
      });
      await logger.flush?.();
      now += 5_000;
      const complete = await diagnostics.endReproduction();

      expect(complete).toMatchObject({ status: 'complete', missingEvidence: [] });
      const review = await diagnostics.reviewSupportArchive();
      expect(review.manifest.evidence.map(({ evidence }) => evidence)).toEqual([
        'environment',
        'reproduction-markers',
        'plugin-log',
        'sdk-log',
        'homekit-log',
        'ffmpeg-log',
      ]);
      expect(review.manifest.evidence.every(({ status }) => status === 'included')).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * The class has to be present for a session that worked as well as for one that failed, because a report of
   * unwatchable live video is a working session. A process reported for what it wrote rather than for how it
   * ended supplies it, so an archive is complete without anything having gone wrong.
   */
  it('collects FFmpeg output for a live session that streamed rather than failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      await diagnostics.authorize('live-media', 'now');
      await diagnostics.startReproduction();
      const logger = createDiagnosticLogger(
        { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        root,
        undefined,
        () => now,
      );
      reportAdaptationNotice(logger, {
        role: 'live-video',
        event: 'output',
        code: 0,
        signal: 'SIGTERM',
        stderr: ['Past duration 0.799995 too large'],
      });
      await logger.flush?.();
      now += 5_000;
      await diagnostics.endReproduction();

      expect(
        (await diagnostics.reviewSupportArchive()).manifest.evidence,
        'nothing failed, and the profile still received the class it declares',
      ).toContainEqual(
        expect.objectContaining({ evidence: 'ffmpeg-log', status: 'included', privacyClass: 'diagnostic' }),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  /**
   * A bundled static build and a distribution build on the same host have entirely different encoder sets, so
   * without the resolved binary in the record an adaptation failure can be attributed to FFmpeg in general
   * and to nothing more precise. A path that names nothing runnable answers with no version at all, which is
   * what tells a missing or wrong `ffmpegPath` apart from an encoder the build does not have.
   */
  it('reports the resolved FFmpeg identity as environment evidence and declares its privacy class', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-17T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      recordFfmpegEnvironment(root, {
        path: '/synthetic/bin/ffmpeg',
        source: 'configured',
        version: 'ffmpeg version 8.0 Copyright (c) 2000-2026 the FFmpeg developers',
      });
      await diagnostics.authorize('live-media', 'now');
      await diagnostics.startReproduction();
      now += 5_000;
      await diagnostics.endReproduction();
      const environment = (await diagnostics.reviewSupportArchive()).manifest.evidence[0]!;

      expect(environment).toMatchObject({
        evidence: 'environment',
        privacyClass: 'operational',
        status: 'included',
        fields: [
          { field: 'version', privacyClass: 'operational' },
          { field: 'node', privacyClass: 'operational' },
          { field: 'platform', privacyClass: 'operational' },
          { field: 'arch', privacyClass: 'operational' },
          { field: 'ffmpeg', privacyClass: 'diagnostic' },
        ],
      });
      expect(statSync(join(root, 'diagnostics', 'ffmpeg.json')).mode & 0o777).toBe(0o600);

      recordFfmpegEnvironment(root, { path: '/synthetic/bin/ffmpeg', source: 'bundled' });
      const rerecorded = (await diagnostics.reviewSupportArchive()).manifest.evidence[0]!;
      expect(
        rerecorded.fields,
        'a binary that answered no version banner is reported without one rather than with a guess',
      ).toHaveLength(5);

      writeFileSync(join(root, 'diagnostics', 'ffmpeg.json'), '{"version":1,"ffmpeg":{"source":"invented"}}\n');
      expect(
        (await diagnostics.reviewSupportArchive()).manifest.evidence[0]!.fields,
        'a record whose own fields do not narrow is dropped rather than partly reported',
      ).toHaveLength(4);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
