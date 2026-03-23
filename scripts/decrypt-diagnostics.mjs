#!/usr/bin/env node

/**
 * Decrypt and extract an encrypted diagnostics archive produced by the plugin.
 *
 * Usage:
 *   node decrypt-diagnostics.mjs <encrypted-file.tar.gz> [private-key.pem]
 *
 * If the private key is omitted, the script looks for it in the keys/
 * directory next to itself (keys/diagnostics_private.pem).
 *
 * The archive is decrypted and extracted into a folder next to the input file,
 * named after the archive (e.g. diagnostics-2026-03-02-11-25-31/).
 *
 * File format (the .tar.gz is actually encrypted, not a plain gzip):
 *   [4 bytes]  – magic: "DIAG"
 *   [1 byte]   – format version (currently 0x01)
 *   [8 bytes]  – creation timestamp (BigUInt64BE, ms since Unix epoch)
 *   [2 bytes]  – big-endian uint16: length of the encrypted AES key
 *   [N bytes]  – RSA-OAEP encrypted AES-256 key
 *   [12 bytes] – AES-GCM initialisation vector
 *   [16 bytes] – AES-GCM authentication tag
 *   [rest]     – AES-256-GCM ciphertext
 *
 * AAD (Additional Authenticated Data) covers bytes 0 through the end of the
 * encrypted AES key.  GCM verifies this automatically during decryption.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = path.join(__dirname, '..', 'keys', 'diagnostics_private.pem');

/** Maximum allowed .enc file size (140 MB). */
const MAX_ENC_SIZE = 140 * 1024 * 1024;

/** Maximum number of entries allowed in the archive. */
const MAX_ENTRIES = 100;

/** Only these file extensions are expected in a legitimate diagnostics archive. */
const ALLOWED_EXTENSIONS = new Set(['.log', '.gz', '.json']);

/** Archives older than this are flagged with a warning (90 days). */
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node decrypt-diagnostics.mjs <encrypted-file.tar.gz> [private-key.pem]');
    process.exit(1);
  }

  const encFile = path.resolve(args[0]);
  let keyFile = args[1] ? path.resolve(args[1]) : DEFAULT_KEY;

  if (!fs.existsSync(keyFile)) {
    console.error(`Private key not found: ${keyFile}`);
    process.exit(1);
  }

  // Read inputs
  const encBuffer = fs.readFileSync(encFile);

  // Reject oversized files
  if (encBuffer.length > MAX_ENC_SIZE) {
    console.error(`File too large (${(encBuffer.length / 1024 / 1024).toFixed(1)} MB) — max allowed is ${MAX_ENC_SIZE / 1024 / 1024} MB.`);
    process.exit(1);
  }

  const privateKey = fs.readFileSync(keyFile, 'utf-8');

  // Validate minimum size: 4 (magic) + 1 (version) + 8 (timestamp) + 2 (keyLen) + 512 (RSA-4096 encrypted key) + 12 (IV) + 16 (tag) + 1 (min ciphertext)
  const MIN_SIZE = 4 + 1 + 8 + 2 + 512 + 12 + 16 + 1;
  if (encBuffer.length < MIN_SIZE) {
    console.error(`File too small (${encBuffer.length} bytes) — not a valid encrypted diagnostics archive.`);
    process.exit(1);
  }

  // Verify magic header and version
  let offset = 0;

  const magic = encBuffer.subarray(offset, offset + 4).toString();
  offset += 4;
  if (magic !== 'DIAG') {
    console.error(`Invalid file — expected magic "DIAG", got "${magic}".`);
    process.exit(1);
  }

  const version = encBuffer[offset];
  offset += 1;
  if (version !== 0x01) {
    console.error(`Unsupported format version ${version} — this script supports version 1.`);
    process.exit(1);
  }

  // Parse the envelope
  const createdAtMs = Number(encBuffer.readBigUInt64BE(offset));
  offset += 8;
  const createdAt = new Date(createdAtMs);

  if (Number.isNaN(createdAt.getTime())) {
    console.error('Invalid timestamp in archive header — file may be corrupted or tampered.');
    process.exit(1);
  }

  console.log(`Archive created: ${createdAt.toISOString()}`);

  const ageMs = Date.now() - createdAtMs;
  if (ageMs > EXPIRY_MS) {
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
    console.warn(`⚠️  WARNING: This archive is ${ageDays} days old (created ${createdAt.toISOString()}).`);
  }
  if (createdAtMs > Date.now() + 24 * 60 * 60 * 1000) {
    console.warn('⚠️  WARNING: Archive timestamp is in the future — clock skew or tampering?');
  }

  const keyLen = encBuffer.readUInt16BE(offset);
  offset += 2;

  if (offset + keyLen + 12 + 16 > encBuffer.length) {
    console.error('Malformed archive — encrypted key length exceeds file size.');
    process.exit(1);
  }

  const encryptedKey = encBuffer.subarray(offset, offset + keyLen);
  offset += keyLen;

  // The AAD covers everything from byte 0 through the end of encryptedKey
  // (magic + version + timestamp + keyLen + encryptedKey)
  const aadEnd = 4 + 1 + 8 + 2 + keyLen;
  const aad = encBuffer.subarray(0, aadEnd);

  const iv = encBuffer.subarray(offset, offset + 12);
  offset += 12;

  const authTag = encBuffer.subarray(offset, offset + 16);
  offset += 16;

  const ciphertext = encBuffer.subarray(offset);

  // Unwrap the AES key with the private RSA key
  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedKey,
    );
  } catch (err) {
    console.error('Failed to decrypt AES key — wrong private key?', err.message);
    process.exit(2);
  }

  // Decrypt the payload
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  aesKey.fill(0); // scrub key from memory
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    console.error('Decryption failed — data may be corrupted.', err.message);
    process.exit(3);
  }

  // Determine output directory next to the .enc file
  const encDir = path.dirname(encFile);
  const baseName = path.basename(encFile)
    .replace(/\.tar\.gz(?:\.enc)?$/, '');
  const outDir = path.join(encDir, baseName);

  // --- Safety: inspect tar contents before extracting (piped via stdin, no temp file) ---
  const listResult = spawnSync('tar', ['tzf', '-'], { input: decrypted, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  if (listResult.status !== 0) {
    console.error('Failed to list archive contents:', listResult.stderr?.trim() || 'unknown error');
    process.exit(4);
  }

  const listing = listResult.stdout.trim().split('\n');

  // Reject archives with too many entries (tar bomb protection)
  if (listing.length > MAX_ENTRIES) {
    console.error(`BLOCKED: archive contains ${listing.length} entries (max ${MAX_ENTRIES}).`);
    console.error('This file may be a tar bomb. Aborting.');
    process.exit(5);
  }

  for (const entry of listing) {
    const normalised = path.normalize(entry);

    // Path traversal / absolute path check
    if (path.isAbsolute(normalised) || normalised.startsWith('..')) {
      console.error(`BLOCKED: archive contains path-traversal entry: "${entry}"`);
      console.error('This file may be maliciously crafted. Aborting.');
      process.exit(5);
    }

    // Extension allowlist (skip directory entries ending with /)
    if (!entry.endsWith('/')) {
      const ext = path.extname(entry).toLowerCase();
      // Handle compound extensions like .log.gz
      const doubleExt = path.extname(entry.slice(0, -ext.length)).toLowerCase() + ext;
      if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_EXTENSIONS.has(doubleExt)) {
        console.error(`BLOCKED: archive contains file with disallowed extension: "${entry}"`);
        console.error(`Only ${[...ALLOWED_EXTENSIONS].join(', ')} files are allowed.`);
        process.exit(5);
      }
    }
  }

  // Check for symlinks inside the archive
  const verboseResult = spawnSync('tar', ['tvzf', '-'], { input: decrypted, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  if (verboseResult.status === 0) {
    for (const line of verboseResult.stdout.trim().split('\n')) {
      if (line.startsWith('l') || line.includes(' -> ')) {
        console.error(`BLOCKED: archive contains a symlink: "${line.trim()}"`);
        console.error('This file may be maliciously crafted. Aborting.');
        process.exit(5);
      }
    }
  }

  // --- Safe to extract (piped via stdin, no temp file on disk) ---
  fs.mkdirSync(outDir, { recursive: true });
  const extractResult = spawnSync('tar', ['xzf', '-', '-C', outDir], { input: decrypted, stdio: ['pipe', 'inherit', 'inherit'] });
  if (extractResult.status !== 0) {
    console.error('Failed to extract archive.');
    process.exit(4);
  }

  // Strip execute permissions from all extracted files
  const files = fs.readdirSync(outDir);
  for (const f of files) {
    const filePath = path.join(outDir, f);
    try {
      fs.chmodSync(filePath, 0o644);
    } catch {
      // Ignore permission errors on platforms that don't support chmod
    }
  }

  console.log(`Decrypted and extracted to: ${outDir}/`);
  console.log(`${files.length} file(s):`);
  files.forEach(f => console.log(`  ${f}`));
}

main();
