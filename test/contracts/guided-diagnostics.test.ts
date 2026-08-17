import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { createDiagnosticLogger, GuidedDiagnostics, reportRuntimeNotice } from '../../src/diagnostics.js';

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

describe('guided diagnostics session', () => {
  it('authorizes only an allowlisted profile with a random support case identifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const first = await diagnostics.authorize('device-representation');
      now += 1;
      const second = await diagnostics.authorize('device-representation');

      expect(first).toMatchObject({
        status: 'authorized',
        profile: 'device-representation',
        expiresAt: '2026-08-19T08:00:00.000Z',
      });
      expect(first.supportCaseId).toMatch(/^support-[0-9a-f-]{36}$/);
      expect(second.supportCaseId).not.toBe(first.supportCaseId);
      await expect(diagnostics.authorize('everything' as never)).rejects.toThrow('Unknown diagnostics profile');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves the original 72-hour expiry across restart and suppresses debug evidence after expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now);

    try {
      const authorized = await diagnostics.authorize('startup-authentication');
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

  it('admits verbose evidence only when the selected profile includes its scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const diagnostics = new GuidedDiagnostics(root);

    try {
      await diagnostics.authorize('dashboard-ui');
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
      const authorized = await diagnostics.authorize('control-state');
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

  it('exports generated allowlisted evidence only after manifest review and only as an encrypted archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'homebridge-eufy-guided-'));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let now = Date.parse('2026-08-16T08:00:00.000Z');
    const diagnostics = new GuidedDiagnostics(root, () => now, {
      keyId: 'test-support-key',
      publicKey,
    });

    try {
      await diagnostics.authorize('control-state');
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
        evidence: [
          { evidence: 'environment', privacyClass: 'operational', status: 'included' },
          { evidence: 'reproduction-markers', privacyClass: 'operational', status: 'included' },
          { evidence: 'plugin-log', privacyClass: 'diagnostic', status: 'included' },
          { evidence: 'sdk-log', privacyClass: 'diagnostic', status: 'included' },
          { evidence: 'homekit-log', privacyClass: 'diagnostic', status: 'included' },
        ],
      });
      expect(review.manifest.excludedClasses).toContain('credentials-and-authentication');
      expect(review.manifest.archiveExpiresAt).toBe('2026-08-17T08:00:05.000Z');
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

      const tampered = JSON.parse(gunzipSync(exported.archive).toString('utf8')) as TestSupportArchiveEnvelope;
      tampered.keyId = 'substituted-key';
      expect(() => decryptSupportArchive(gzipSync(JSON.stringify(tampered)), privateKey)).toThrow();

      const expiredReview = await diagnostics.reviewSupportArchive();
      now += 24 * HOUR_MS;
      await expect(diagnostics.exportSupportArchive(expiredReview.reviewId)).rejects.toThrow('stale');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
