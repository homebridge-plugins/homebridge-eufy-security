#!/usr/bin/env node

/**
 * Authenticates, decrypts, and extracts a V5 Homebridge Eufy support archive.
 *
 * Usage:
 *   node scripts/decrypt-diagnostics.mjs <archive.eufysupport.gz> [private-key.pem]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const DEFAULT_KEY = path.join(
  os.homedir(),
  '.local',
  'share',
  'homebridge-eufy-support',
  'keys',
  'support-2026-08-01-private.pem',
);
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const ENVELOPE_FIELDS = new Set([
  'format',
  'version',
  'keyId',
  'keyWrapAlgorithm',
  'contentAlgorithm',
  'contentEncoding',
  'wrappedKey',
  'iv',
  'authTag',
  'ciphertext',
]);
const EVIDENCE_FILES = new Map([
  ['environment', ['environment.json', 'application/json', 'operational']],
  ['reproduction-markers', ['reproduction-markers.jsonl', 'application/x-ndjson', 'operational']],
  ['plugin-log', ['plugin-log.jsonl', 'application/x-ndjson', 'diagnostic']],
  ['sdk-log', ['sdk-log.jsonl', 'application/x-ndjson', 'diagnostic']],
  ['homekit-log', ['homekit-log.jsonl', 'application/x-ndjson', 'diagnostic']],
  ['ffmpeg-log', ['ffmpeg-log.jsonl', 'application/x-ndjson', 'diagnostic']],
  ['ui-log', ['ui-log.jsonl', 'application/x-ndjson', 'diagnostic']],
]);
const KEY_FINGERPRINTS = new Map([
  ['support-2026-08-01', 'e01d8a1c6c2b800772495b3f656b10899364ece0e82d846f7d33f61cdffbd451'],
]);
const PROFILES = new Set([
  'startup-authentication',
  'device-representation',
  'control-state',
  'live-media',
  'hksv-recording',
  'dashboard-ui',
  'other',
]);
const PRIVACY_CLASSES = new Set(['diagnostic', 'operational', 'pseudonymous']);
const EXCLUDED_CLASSES = new Set([
  'credentials-and-authentication',
  'tokens-cookies-and-authorization',
  'session-and-push-stores',
  'private-and-symmetric-keys',
  'unconstrained-sdk-objects',
  'camera-images-talkback-and-raw-media',
]);

function canonicalBase64(value, field) {
  if (typeof value !== 'string') throw new Error(`Invalid envelope field: ${field}`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`Invalid base64 field: ${field}`);
  return decoded;
}

function outputDirectory(archivePath) {
  const filename = path.basename(archivePath).replace(/\.eufysupport\.gz$/, '');
  if (filename === path.basename(archivePath)) throw new Error('Archive filename must end in .eufysupport.gz');
  return path.join(path.dirname(archivePath), filename);
}

function readBoundedRegularFile(filePath, maximumBytes, label, checkPrivatePermissions = false) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size === 0 || stats.size > maximumBytes) {
      throw new Error(`${label} must be a regular file within the size limit`);
    }
    if (checkPrivatePermissions && (stats.mode & 0o077) !== 0) {
      throw new Error('Private key permissions must be 600 or stricter');
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, maximumBytes + 1 - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error(`${label} exceeds the size limit`);
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readEnvelope(archivePath) {
  const archive = readBoundedRegularFile(archivePath, MAX_ARCHIVE_BYTES, 'Archive');
  const envelope = JSON.parse(gunzipSync(archive, { maxOutputLength: MAX_ENVELOPE_BYTES }).toString('utf8'));
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Invalid support archive envelope');
  }
  const fields = Object.keys(envelope);
  if (fields.length !== ENVELOPE_FIELDS.size || fields.some((field) => !ENVELOPE_FIELDS.has(field))) {
    throw new Error('Unexpected support archive envelope fields');
  }
  if (
    envelope.format !== 'homebridge-eufy-support-archive' ||
    envelope.version !== 1 ||
    typeof envelope.keyId !== 'string' ||
    envelope.keyWrapAlgorithm !== 'RSA-OAEP-SHA256' ||
    envelope.contentAlgorithm !== 'AES-256-GCM' ||
    envelope.contentEncoding !== 'gzip+json'
  ) {
    throw new Error('Unsupported support archive format');
  }
  return envelope;
}

function readPrivateKey(keyPath, keyId) {
  const privateKeyBytes = readBoundedRegularFile(keyPath, MAX_PRIVATE_KEY_BYTES, 'Private key', true);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyBytes);
  } finally {
    privateKeyBytes.fill(0);
  }
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Support private key must be RSA');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim();
  const expectedFingerprint = KEY_FINGERPRINTS.get(keyId) ?? process.env.HOMEBRIDGE_EUFY_SUPPORT_KEY_SHA256;
  if (!expectedFingerprint) throw new Error(`Unknown support key identifier: ${keyId}`);
  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint) || fingerprint !== expectedFingerprint) {
    throw new Error(`Private key does not match support key ${keyId}`);
  }
  return privateKey;
}

function decryptPayload(envelope, privateKey) {
  const wrappedKey = canonicalBase64(envelope.wrappedKey, 'wrappedKey');
  const iv = canonicalBase64(envelope.iv, 'iv');
  const authTag = canonicalBase64(envelope.authTag, 'authTag');
  const ciphertext = canonicalBase64(envelope.ciphertext, 'ciphertext');
  const wrappedKeyBytes = privateKey.asymmetricKeyDetails?.modulusLength / 8;
  if (wrappedKey.length !== wrappedKeyBytes || iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid support archive cryptographic field length');
  }

  let contentKey;
  try {
    contentKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      wrappedKey,
    );
  } catch {
    throw new Error('Archive authentication failed');
  }
  try {
    if (contentKey.length !== 32) throw new Error('Invalid decrypted content key length');
    const metadata = {
      format: envelope.format,
      version: envelope.version,
      keyId: envelope.keyId,
      keyWrapAlgorithm: envelope.keyWrapAlgorithm,
      contentAlgorithm: envelope.contentAlgorithm,
      contentEncoding: envelope.contentEncoding,
    };
    const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(metadata)));
    decipher.setAuthTag(authTag);
    let compressed;
    try {
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Archive authentication failed');
    }
    return JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8'));
  } finally {
    contentKey.fill(0);
  }
}

function validatePayload(payload, envelope, archivePath) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !== 'evidence,manifest' ||
    !payload.manifest ||
    !Array.isArray(payload.evidence)
  ) {
    throw new Error('Invalid support archive payload');
  }
  const manifest = payload.manifest;
  const supportCasePattern = /^support-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const createdAt = Date.parse(manifest.createdAt);
  const expiresAt = Date.parse(manifest.archiveExpiresAt);
  const reproductionStartedAt = Date.parse(manifest.reproductionStartedAt);
  const reproductionEndedAt = Date.parse(manifest.reproductionEndedAt);
  const manifestFields = Object.keys(manifest).sort().join(',');
  // Version 2 states whether the retained evidence still reaches the start of the reproduction, so it carries
  // `coversReproduction` always and `retainedFrom` only where truncation dropped the oldest end. Version 1 is
  // still read: an archive already exported cannot be re-made.
  const coverageManifestFields =
    'archiveExpiresAt,archiveFormat,coversReproduction,createdAt,evidence,excludedClasses,keyId,profile,reproductionEndedAt,reproductionMode,reproductionStartedAt,supportCaseId,version';
  const truncatedCoverageManifestFields =
    'archiveExpiresAt,archiveFormat,coversReproduction,createdAt,evidence,excludedClasses,keyId,profile,reproductionEndedAt,reproductionMode,reproductionStartedAt,retainedFrom,supportCaseId,version';
  const currentManifestFields =
    'archiveExpiresAt,archiveFormat,createdAt,evidence,excludedClasses,keyId,profile,reproductionEndedAt,reproductionMode,reproductionStartedAt,supportCaseId,version';
  const legacyManifestFields =
    'archiveExpiresAt,archiveFormat,createdAt,evidence,excludedClasses,keyId,profile,reproductionEndedAt,reproductionStartedAt,supportCaseId,version';
  const expectedFields = {
    2: [coverageManifestFields, truncatedCoverageManifestFields],
    1: [currentManifestFields, legacyManifestFields],
  }[manifest.version];
  const retainedFrom = manifest.retainedFrom === undefined ? undefined : Date.parse(manifest.retainedFrom);
  const reproductionMode = manifestFields === legacyManifestFields ? 'now' : manifest.reproductionMode;
  if (
    expectedFields === undefined ||
    !expectedFields.includes(manifestFields) ||
    (manifest.version === 2 && typeof manifest.coversReproduction !== 'boolean') ||
    (manifest.retainedFrom !== undefined &&
      (!Number.isFinite(retainedFrom) || new Date(retainedFrom).toISOString() !== manifest.retainedFrom)) ||
    (manifest.version === 2 &&
      manifest.coversReproduction !== (retainedFrom === undefined || retainedFrom <= reproductionStartedAt)) ||
    manifest.archiveFormat !== envelope.format ||
    manifest.keyId !== envelope.keyId ||
    !supportCasePattern.test(manifest.supportCaseId) ||
    path.basename(archivePath) !== `homebridge-eufy-${manifest.supportCaseId}.eufysupport.gz` ||
    !PROFILES.has(manifest.profile) ||
    !['now', 'intermittent'].includes(reproductionMode) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(reproductionStartedAt) ||
    !Number.isFinite(reproductionEndedAt) ||
    new Date(createdAt).toISOString() !== manifest.createdAt ||
    new Date(expiresAt).toISOString() !== manifest.archiveExpiresAt ||
    new Date(reproductionStartedAt).toISOString() !== manifest.reproductionStartedAt ||
    new Date(reproductionEndedAt).toISOString() !== manifest.reproductionEndedAt ||
    reproductionStartedAt > reproductionEndedAt ||
    reproductionEndedAt > createdAt ||
    expiresAt - createdAt !== 24 * 60 * 60 * 1_000 ||
    !Array.isArray(manifest.evidence) ||
    !Array.isArray(manifest.excludedClasses) ||
    manifest.excludedClasses.length !== EXCLUDED_CLASSES.size ||
    new Set(manifest.excludedClasses).size !== EXCLUDED_CLASSES.size ||
    manifest.excludedClasses.some((entry) => !EXCLUDED_CLASSES.has(entry))
  ) {
    throw new Error('Support archive manifest does not match its envelope or filename');
  }

  const manifestEvidence = new Map();
  for (const item of manifest.evidence) {
    const includedFields = new Set([
      'evidence',
      'privacyClass',
      'status',
      'contentType',
      'bytes',
      'fields',
      'truncated',
    ]);
    const missingFields = new Set(['evidence', 'privacyClass', 'status', 'missingReason']);
    const allowedFields = item?.status === 'included' ? includedFields : missingFields;
    if (
      !item ||
      Object.keys(item).some((field) => !allowedFields.has(field)) ||
      !EVIDENCE_FILES.has(item.evidence) ||
      manifestEvidence.has(item.evidence) ||
      item.privacyClass !== EVIDENCE_FILES.get(item.evidence)[2] ||
      !['included', 'missing'].includes(item.status) ||
      (item.truncated !== undefined && item.truncated !== true) ||
      (item.status === 'included' &&
        (typeof item.bytes !== 'number' ||
          item.bytes < 0 ||
          item.contentType !== EVIDENCE_FILES.get(item.evidence)[1] ||
          !Array.isArray(item.fields) ||
          item.fields.some(
            (field) =>
              !field ||
              Object.keys(field).sort().join(',') !== 'field,privacyClass' ||
              typeof field.field !== 'string' ||
              !PRIVACY_CLASSES.has(field.privacyClass),
          ))) ||
      (item.status === 'missing' &&
        (item.privacyClass !== 'diagnostic' || item.missingReason !== 'no-allowlisted-record-observed'))
    ) {
      throw new Error('Invalid or duplicate manifest evidence');
    }
    manifestEvidence.set(item.evidence, item);
  }
  const extracted = [];
  const seen = new Set();
  for (const item of payload.evidence) {
    const definition = EVIDENCE_FILES.get(item?.evidence);
    const allowedFields = new Set(['evidence', 'privacyClass', 'contentType', 'content', 'truncated', 'fields']);
    if (
      !definition ||
      Object.keys(item).some((field) => !allowedFields.has(field)) ||
      seen.has(item.evidence) ||
      typeof item.content !== 'string' ||
      item.privacyClass !== definition[2] ||
      (item.truncated !== undefined && item.truncated !== true) ||
      !Array.isArray(item.fields)
    ) {
      throw new Error('Invalid or duplicate support archive evidence');
    }
    const [filename, contentType] = definition;
    const manifestItem = manifestEvidence.get(item.evidence);
    if (
      item.contentType !== contentType ||
      manifestItem?.status !== 'included' ||
      manifestItem.privacyClass !== item.privacyClass ||
      manifestItem.bytes !== Buffer.byteLength(item.content) ||
      manifestItem.contentType !== item.contentType ||
      manifestItem.truncated !== item.truncated ||
      JSON.stringify(manifestItem.fields) !== JSON.stringify(item.fields)
    ) {
      throw new Error(`Evidence does not match manifest: ${item.evidence}`);
    }
    seen.add(item.evidence);
    extracted.push([filename, item.content]);
  }
  if ([...manifestEvidence.values()].some((item) => item.status === 'included' && !seen.has(item.evidence))) {
    throw new Error('Manifest declares evidence that is absent from the payload');
  }
  if (expiresAt <= Date.now()) console.warn(`WARNING: support archive expired at ${manifest.archiveExpiresAt}`);
  // The reproduction interval is unbounded and the evidence budget is not, and the budget is filled
  // newest-first — so an interval left open longer than the budget can hold loses its OLDEST end, which is
  // where the reported fault is. Every evidence class still reads `included`, so without this the archive
  // looks complete and the fault looks like it left no trace.
  if (manifest.coversReproduction === false) {
    console.warn(
      `WARNING: evidence older than ${manifest.retainedFrom} was dropped, so nothing here covers the reproduction from ${manifest.reproductionStartedAt}. Ask for a shorter reproduction.`,
    );
  }
  return { manifest: { ...manifest, reproductionMode }, extracted };
}

function extract(archivePath, manifest, evidence) {
  const directory = outputDirectory(archivePath);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  for (const [filename, content] of evidence) {
    fs.writeFileSync(path.join(directory, filename), content, { flag: 'wx', mode: 0o600 });
  }
  return directory;
}

function main() {
  const [archiveArgument, keyArgument] = process.argv.slice(2);
  if (!archiveArgument) {
    console.error('Usage: node scripts/decrypt-diagnostics.mjs <archive.eufysupport.gz> [private-key.pem]');
    process.exitCode = 1;
    return;
  }
  try {
    const archivePath = path.resolve(archiveArgument);
    const keyPath = path.resolve(keyArgument ?? DEFAULT_KEY);
    const envelope = readEnvelope(archivePath);
    const privateKey = readPrivateKey(keyPath, envelope.keyId);
    const payload = decryptPayload(envelope, privateKey);
    const { manifest, extracted } = validatePayload(payload, envelope, archivePath);
    const directory = extract(archivePath, manifest, extracted);
    console.log(`Authenticated V5 support archive encrypted to ${envelope.keyId}.`);
    console.log(`Decrypted and extracted to: ${directory}/`);
    console.log(`${extracted.length + 1} file(s): manifest.json, ${extracted.map(([name]) => name).join(', ')}`);
  } catch (error) {
    console.error(`Failed to decrypt V5 support archive: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
