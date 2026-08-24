import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

import type { Logger } from '@mega-yfue/eufy-sdk';

export interface PlatformLogger {
  debug?(message: string): void;
  error(message: string): void;
  info(message: string): void;
  localize?(key: string, parameters?: Readonly<Record<string, string | number>>): string;
  flush?(): Promise<void>;
  warn(message: string): void;
}

export interface HomeKitCondition {
  code: string;
  capability?: string;
  member?: string;
  active: boolean;
  reason: string;
}

export interface HomeKitEventTrace {
  adapter: string;
  event: string;
  observation: string;
}

const MAX_SDK_DETAILS = 16;
const MAX_LOG_RECORD_BYTES = 64 * 1024;
const MAX_CURRENT_LOG_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_LOG_BYTES = 200 * 1024 * 1024;
const MAX_QUEUED_LOG_BYTES = 1024 * 1024;
const MAX_SUPPORT_ARCHIVE_LOG_BYTES = 16 * 1024 * 1024;
const MAX_SUPPORT_ARCHIVE_MARKER_BYTES = 1024 * 1024;
const MAX_UI_EVENTS_BYTES = 64 * 1024;
const MAX_PENDING_UI_EVENTS = 8;
const SUPPORT_ARCHIVE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const LOG_ROTATIONS = 3;
const LOG_DIRECTORY = 'logs';
const LOG_FILE = 'homebridge-eufy.jsonl';
const DIAGNOSTICS_DIRECTORY = 'diagnostics';
const GUIDED_SESSION_FILE = 'session.json';
const REPRODUCTION_MARKERS_FILE = 'reproduction-markers.jsonl';
const UI_EVENTS_FILE = 'ui-events.jsonl';
const DEBUG_AUTHORIZATION_MS = 72 * 60 * 60 * 1_000;
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const SDK_SUBSYSTEMS = new Set(['device', 'mega', 'mqtt', 'p2p', 'push', 'webrtc', 'sdk']);
const SDK_EVENT_KEYS = new Set([
  'client-warning',
  'connection-closed',
  'connection-opened',
  'connection-retrying',
  'media-error',
  'media-warning',
  'operation-failed',
  'observation-invalid',
  'protocol-command',
  'protocol-unhandled',
  'sdk-diagnostic',
  'session-connecting',
  'session-idle',
  'session-resumed',
  'session-restored',
  'session-retrying',
  'snapshot-cache-warning',
  'transport-error',
]);
const EN_MESSAGES = JSON.parse(readFileSync(new URL('../i18n/runtime/en.json', import.meta.url), 'utf8')) as Record<
  string,
  string
>;

export type DiagnosticsProfile =
  | 'startup-authentication'
  | 'device-representation'
  | 'control-state'
  | 'live-media'
  | 'hksv-recording'
  | 'dashboard-ui'
  | 'other';

export type DiagnosticsReproductionMode = 'now' | 'intermittent';

export type DiagnosticsUiEvent =
  'background-started' | 'dashboard-opened' | 'authentication-opened' | 'request-failed' | 'issue-observed';

export type DiagnosticEvidence = 'plugin-log' | 'sdk-log' | 'homekit-log' | 'ffmpeg-log' | 'ui-log';

export interface SupportArchiveManifest {
  version: 1;
  archiveFormat: 'homebridge-eufy-support-archive';
  keyId: string;
  supportCaseId: string;
  profile: DiagnosticsProfile;
  reproductionMode: DiagnosticsReproductionMode;
  createdAt: string;
  archiveExpiresAt: string;
  reproductionStartedAt: string;
  reproductionEndedAt: string;
  evidence: readonly {
    evidence: DiagnosticEvidence | 'environment' | 'reproduction-markers';
    privacyClass: 'diagnostic' | 'operational';
    status: 'included' | 'missing';
    contentType?: 'application/json' | 'application/x-ndjson';
    bytes?: number;
    truncated?: true;
    missingReason?: 'no-allowlisted-record-observed';
    fields?: readonly {
      field: string;
      privacyClass: 'diagnostic' | 'operational' | 'pseudonymous';
    }[];
  }[];
  excludedClasses: readonly string[];
}

export interface SupportArchiveReview {
  reviewId: string;
  manifest: SupportArchiveManifest;
}

export interface EncryptedSupportArchive {
  filename: string;
  mediaType: 'application/gzip';
  archive: Buffer;
}

interface SupportArchiveKey {
  keyId: string;
  publicKey: string;
  sha256: string;
}

interface SupportArchiveEvidence {
  evidence: DiagnosticEvidence | 'environment' | 'reproduction-markers';
  privacyClass: 'diagnostic' | 'operational';
  contentType: 'application/json' | 'application/x-ndjson';
  content: string;
  truncated?: true;
  fields: readonly {
    field: string;
    privacyClass: 'diagnostic' | 'operational' | 'pseudonymous';
  }[];
}

interface PendingSupportArchive {
  reviewId: string;
  manifest: SupportArchiveManifest;
  evidence: readonly SupportArchiveEvidence[];
}

const SUPPORT_ARCHIVE_KEY: SupportArchiveKey = {
  keyId: 'support-2026-08-01',
  sha256: 'e01d8a1c6c2b800772495b3f656b10899364ece0e82d846f7d33f61cdffbd451',
  publicKey: `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEArho8/7NwaYsZ3r27Lzek
mJXOdSOtjuxKLWHxS40Hf6MFskF/dSwY8om0NZ22Qa/cygStAiP4eAmL1fEuNqlS
JnoFgCtg6myFQVfeep9FWAJruR7EGp4WgiXopq8pvxSkJixZaYin2cch7CwUA5g9
b2AcErlfAmZM6F0Sd9v5Q7rHF68x3MINi3BTDKsz/3KqkoJoxyosKjMNDNATEn/T
y/yAF1/kELg7SJgnheWRoFK6130DEPzbym+TTxSZZOHeAtw27ALXoYGmnv09uq0K
Bks4wOrvW8gWQpbMOfpbc3XeWsP7bOuIXr/fs3kXgHIZoJSiLW7JlsivL9z5NDl6
UBxRyR0KOnK07Cx2xvl5pXfAOxQnc8F1JtjclzCHG6Q5sfq7isoMcpPuxDlEepgm
FNkJi71G4+lWgTotQr/fTVeZ46IxXrtnq89pb0fE20WYMaHnXkz0FMCIjMjuQWEP
R0zjeaRO8wZ3sqMgWSy2TldFsh709GqVUiS0YRUoVT1oExc27P47EFUNh57qI7bI
tcEIHVhBqyawK+WrIC+vgBgAPg6w5klxVhUaWGltubIFSm86BxNDTGx7C6rllcRU
pirqSQAW3PgOCg6d3lfkGLHVRsC+j6xsv1xC6clR6MKzklp7qz6uuOmf9GIdu+qE
9U0RwKqGYSp/N8TF5n3p3s0CAwEAAQ==
-----END PUBLIC KEY-----`,
};

const SUPPORT_ARCHIVE_EXCLUDED_CLASSES = [
  'credentials-and-authentication',
  'tokens-cookies-and-authorization',
  'session-and-push-stores',
  'private-and-symmetric-keys',
  'unconstrained-sdk-objects',
  'camera-images-talkback-and-raw-media',
] as const;

const DIAGNOSTICS_PROFILES: Readonly<Record<DiagnosticsProfile, readonly DiagnosticEvidence[]>> = {
  'startup-authentication': ['plugin-log', 'sdk-log'],
  'device-representation': ['plugin-log', 'sdk-log', 'homekit-log'],
  'control-state': ['plugin-log', 'sdk-log', 'homekit-log'],
  'live-media': ['plugin-log', 'sdk-log', 'ffmpeg-log'],
  'hksv-recording': ['plugin-log', 'sdk-log', 'ffmpeg-log'],
  'dashboard-ui': ['plugin-log', 'ui-log'],
  other: ['plugin-log', 'sdk-log', 'homekit-log'],
};

/** Narrows external profile input against the diagnostics-owned profile registry. */
export function isDiagnosticsProfile(value: unknown): value is DiagnosticsProfile {
  return typeof value === 'string' && Object.hasOwn(DIAGNOSTICS_PROFILES, value);
}

/** Narrows external reproduction-mode input to the diagnostics-owned modes. */
export function isDiagnosticsReproductionMode(value: unknown): value is DiagnosticsReproductionMode {
  return value === 'now' || value === 'intermittent';
}

const DIAGNOSTICS_UI_EVENTS: ReadonlySet<DiagnosticsUiEvent> = new Set([
  'background-started',
  'dashboard-opened',
  'authentication-opened',
  'request-failed',
  'issue-observed',
]);

/** Narrows external event input to the diagnostics-owned UI vocabulary. */
export function isDiagnosticsUiEvent(value: unknown): value is DiagnosticsUiEvent {
  return typeof value === 'string' && DIAGNOSTICS_UI_EVENTS.has(value as DiagnosticsUiEvent);
}

interface PersistedDiagnosticsSession {
  version: 1;
  supportCaseId: string;
  profile: DiagnosticsProfile;
  reproductionMode: DiagnosticsReproductionMode;
  authorizedAt: string;
  expiresAt: string;
  reproductionStartedAt?: string;
  reproductionEndedAt?: string;
}

export interface GuidedDiagnosticsStatus {
  status: 'inactive' | 'authorized' | 'reproducing' | 'complete' | 'expired';
  supportCaseId?: string;
  profile?: DiagnosticsProfile;
  reproductionMode?: DiagnosticsReproductionMode;
  selectedEvidence: readonly DiagnosticEvidence[];
  missingEvidence: readonly DiagnosticEvidence[];
  authorizedAt?: string;
  expiresAt?: string;
  reproductionStartedAt?: string;
  reproductionEndedAt?: string;
  partialExportAvailable: boolean;
  issueUrl?: string;
}

function diagnosticsSessionPath(storageRoot: string): string {
  return join(storageRoot, DIAGNOSTICS_DIRECTORY, GUIDED_SESSION_FILE);
}

function readDiagnosticsSession(storageRoot: string): PersistedDiagnosticsSession | undefined {
  try {
    const candidate = JSON.parse(
      readFileSync(diagnosticsSessionPath(storageRoot), 'utf8'),
    ) as Partial<PersistedDiagnosticsSession>;
    const reproductionMode = candidate.reproductionMode ?? 'now';
    if (
      candidate.version !== 1 ||
      typeof candidate.supportCaseId !== 'string' ||
      !/^support-[0-9a-f-]{36}$/.test(candidate.supportCaseId) ||
      typeof candidate.profile !== 'string' ||
      !isDiagnosticsProfile(candidate.profile) ||
      !isDiagnosticsReproductionMode(reproductionMode) ||
      typeof candidate.authorizedAt !== 'string' ||
      typeof candidate.expiresAt !== 'string'
    ) {
      return undefined;
    }
    return { ...candidate, reproductionMode } as PersistedDiagnosticsSession;
  } catch {
    return undefined;
  }
}

function activeDiagnosticsSession(storageRoot: string, now: number): PersistedDiagnosticsSession | undefined {
  const session = readDiagnosticsSession(storageRoot);
  return session && Date.parse(session.expiresAt) > now ? session : undefined;
}

function observedEvidencePath(storageRoot: string, supportCaseId: string, evidence: DiagnosticEvidence): string {
  return join(storageRoot, DIAGNOSTICS_DIRECTORY, 'evidence', supportCaseId, evidence);
}

function evidenceForEvent(event: Readonly<Record<string, unknown>>): DiagnosticEvidence[] {
  const evidence: DiagnosticEvidence[] = ['plugin-log'];
  if (event.scope === 'sdk') evidence.push('sdk-log');
  if (event.scope === 'homekit') evidence.push('homekit-log');
  return evidence;
}

/** Owns persisted, user-authorized diagnostic evidence windows and identity-free reproduction markers. */
export class GuidedDiagnostics {
  private pendingSupportArchive?: PendingSupportArchive;
  private uiEventWrites = Promise.resolve();
  private pendingUiEvents = 0;
  private uiEventsClosing = false;

  constructor(
    private readonly storageRoot: string,
    private readonly now: () => number = Date.now,
    private readonly supportArchiveKey: SupportArchiveKey = SUPPORT_ARCHIVE_KEY,
  ) {}

  async authorize(
    profile: DiagnosticsProfile,
    reproductionMode: DiagnosticsReproductionMode,
  ): Promise<GuidedDiagnosticsStatus> {
    if (!isDiagnosticsProfile(profile)) {
      throw new Error('Unknown diagnostics profile');
    }
    if (!isDiagnosticsReproductionMode(reproductionMode)) {
      throw new Error('Unknown diagnostics reproduction mode');
    }
    this.uiEventsClosing = true;
    try {
      await this.uiEventWrites;
      const authorizedAt = this.now();
      const session: PersistedDiagnosticsSession = {
        version: 1,
        supportCaseId: `support-${randomUUID()}`,
        profile,
        reproductionMode,
        authorizedAt: new Date(authorizedAt).toISOString(),
        expiresAt: new Date(authorizedAt + DEBUG_AUTHORIZATION_MS).toISOString(),
      };
      await this.writeSession(session);
      this.pendingSupportArchive = undefined;
      return this.project(session);
    } finally {
      this.uiEventsClosing = false;
    }
  }

  async status(): Promise<GuidedDiagnosticsStatus> {
    return this.project(readDiagnosticsSession(this.storageRoot));
  }

  async startReproduction(): Promise<GuidedDiagnosticsStatus> {
    const session = this.requireAuthorized();
    if (!session.reproductionStartedAt || session.reproductionEndedAt) {
      if (session.reproductionEndedAt) {
        session.supportCaseId = `support-${randomUUID()}`;
        this.pendingSupportArchive = undefined;
      }
      if (session.profile === 'dashboard-ui') {
        await this.uiEventWrites;
        this.uiEventsClosing = false;
      }
      session.reproductionStartedAt = new Date(this.now()).toISOString();
      delete session.reproductionEndedAt;
      await this.writeSession(session);
    }
    await this.ensureMarker(session, 'reproduction-started', session.reproductionStartedAt);
    return this.project(session);
  }

  async endReproduction(): Promise<GuidedDiagnosticsStatus> {
    let session = this.requireAuthorized();
    if (!session.reproductionStartedAt) {
      throw new Error('Reproduction has not started');
    }
    const closesUiEvents = session.profile === 'dashboard-ui';
    if (closesUiEvents) {
      this.uiEventsClosing = true;
    }
    try {
      if (closesUiEvents) {
        await this.uiEventWrites;
        session = this.requireAuthorized();
      }
      if (!session.reproductionEndedAt) {
        session.reproductionEndedAt = new Date(this.now()).toISOString();
        await this.writeSession(session);
      }
      await this.ensureMarker(session, 'reproduction-ended', session.reproductionEndedAt);
      return this.project(session);
    } catch (error) {
      if (closesUiEvents) this.uiEventsClosing = false;
      throw error;
    }
  }

  async recordUiEvent(event: DiagnosticsUiEvent): Promise<void> {
    if (!isDiagnosticsUiEvent(event)) {
      throw new Error('Unknown diagnostics UI event');
    }
    if (this.uiEventsClosing) {
      throw new Error('Diagnostics UI events are closing');
    }
    if (this.pendingUiEvents >= MAX_PENDING_UI_EVENTS) {
      throw new Error('Diagnostics UI event queue is full');
    }
    this.pendingUiEvents += 1;
    const write = this.uiEventWrites.then(async () => {
      const session = this.requireAuthorized();
      if (session.profile !== 'dashboard-ui' || !session.reproductionStartedAt || session.reproductionEndedAt) {
        throw new Error('An active dashboard reproduction is required');
      }
      const directory = join(this.storageRoot, DIAGNOSTICS_DIRECTORY);
      const path = join(directory, UI_EVENTS_FILE);
      await mkdir(directory, { mode: 0o700, recursive: true });
      await chmod(directory, 0o700);
      const record = `${JSON.stringify({
        version: 1,
        supportCaseId: session.supportCaseId,
        timestamp: new Date(this.now()).toISOString(),
        event,
      })}\n`;
      let currentBytes = 0;
      try {
        currentBytes = (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (currentBytes + Buffer.byteLength(record) > MAX_UI_EVENTS_BYTES) {
        const retained = await this.readFileTail(path, MAX_UI_EVENTS_BYTES - Buffer.byteLength(record));
        await writeFile(path, `${retained}${record}`, { encoding: 'utf8', mode: 0o600 });
      } else {
        await appendFile(path, record, { encoding: 'utf8', mode: 0o600 });
      }
      await chmod(path, 0o600);
      const observedPath = observedEvidencePath(this.storageRoot, session.supportCaseId, 'ui-log');
      await mkdir(dirname(observedPath), { mode: 0o700, recursive: true });
      await writeFile(
        observedPath,
        `${JSON.stringify({
          version: 1,
          supportCaseId: session.supportCaseId,
          evidence: 'ui-log',
          observedAt: new Date(this.now()).toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      await chmod(observedPath, 0o600);
    });
    this.uiEventWrites = write
      .catch(() => undefined)
      .finally(() => {
        this.pendingUiEvents -= 1;
      });
    return write;
  }

  /** Prepares the exact manifest and evidence snapshot that one subsequent export may encrypt. */
  async reviewSupportArchive(): Promise<SupportArchiveReview> {
    await this.uiEventWrites;
    const session = readDiagnosticsSession(this.storageRoot);
    if (!session?.reproductionStartedAt || !session.reproductionEndedAt) {
      throw new Error('A completed reproduction is required before archive review');
    }
    const collected = await this.collectSupportEvidence(session);
    const selected = DIAGNOSTICS_PROFILES[session.profile];
    const createdAt = this.now();
    const manifest: SupportArchiveManifest = {
      version: 1,
      archiveFormat: 'homebridge-eufy-support-archive',
      keyId: this.supportArchiveKey.keyId,
      supportCaseId: session.supportCaseId,
      profile: session.profile,
      reproductionMode: session.reproductionMode,
      createdAt: new Date(createdAt).toISOString(),
      archiveExpiresAt: new Date(createdAt + SUPPORT_ARCHIVE_RETENTION_MS).toISOString(),
      reproductionStartedAt: session.reproductionStartedAt,
      reproductionEndedAt: session.reproductionEndedAt,
      evidence: [
        ...collected.map(({ evidence, privacyClass, contentType, content, truncated, fields }) => ({
          evidence,
          privacyClass,
          status: 'included' as const,
          contentType,
          bytes: Buffer.byteLength(content),
          fields,
          ...(truncated ? { truncated: true as const } : {}),
        })),
        ...selected
          .filter((evidence) => !collected.some((candidate) => candidate.evidence === evidence))
          .map((evidence) => ({
            evidence,
            privacyClass: 'diagnostic' as const,
            status: 'missing' as const,
            missingReason: 'no-allowlisted-record-observed' as const,
          })),
      ],
      excludedClasses: SUPPORT_ARCHIVE_EXCLUDED_CLASSES,
    };
    const reviewId = randomUUID();
    this.pendingSupportArchive = { reviewId, manifest, evidence: collected };
    return { reviewId, manifest };
  }

  /** Consumes one reviewed snapshot and returns an encrypted envelope without writing plaintext or an archive to disk. */
  async exportSupportArchive(reviewId: string): Promise<EncryptedSupportArchive> {
    const pending = this.pendingSupportArchive;
    if (!pending || pending.reviewId !== reviewId) {
      throw new Error('Support archive manifest review is missing or stale');
    }
    this.pendingSupportArchive = undefined;
    if (Date.parse(pending.manifest.archiveExpiresAt) <= this.now()) {
      throw new Error('Support archive manifest review is missing or stale');
    }
    const keyFingerprint = createHash('sha256').update(this.supportArchiveKey.publicKey.trim()).digest('hex');
    if (keyFingerprint !== this.supportArchiveKey.sha256) {
      throw new Error('Support archive key integrity check failed');
    }
    const compressed = await gzip(
      Buffer.from(JSON.stringify({ manifest: pending.manifest, evidence: pending.evidence }), 'utf8'),
    );
    const contentKey = randomBytes(32);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
      const metadata = {
        format: 'homebridge-eufy-support-archive',
        version: 1,
        keyId: this.supportArchiveKey.keyId,
        keyWrapAlgorithm: 'RSA-OAEP-SHA256',
        contentAlgorithm: 'AES-256-GCM',
        contentEncoding: 'gzip+json',
      } as const;
      const authenticatedMetadata = Buffer.from(JSON.stringify(metadata), 'utf8');
      cipher.setAAD(authenticatedMetadata);
      const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
      const wrappedKey = publicEncrypt(
        {
          key: this.supportArchiveKey.publicKey,
          oaepHash: 'sha256',
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        contentKey,
      );
      const envelope = {
        ...metadata,
        wrappedKey: wrappedKey.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
      return {
        filename: `homebridge-eufy-${pending.manifest.supportCaseId}.eufysupport.gz`,
        mediaType: 'application/gzip',
        archive: await gzip(Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')),
      };
    } finally {
      contentKey.fill(0);
    }
  }

  private async collectSupportEvidence(session: PersistedDiagnosticsSession): Promise<SupportArchiveEvidence[]> {
    const evidence: SupportArchiveEvidence[] = [
      {
        evidence: 'environment',
        privacyClass: 'operational',
        contentType: 'application/json',
        content: `${JSON.stringify({ version: 1, node: process.version, platform: process.platform, arch: process.arch })}\n`,
        fields: ['version', 'node', 'platform', 'arch'].map((field) => ({ field, privacyClass: 'operational' })),
      },
    ];
    const markers = await this.readReproductionMarkers(session.supportCaseId);
    if (markers) {
      evidence.push({
        evidence: 'reproduction-markers',
        privacyClass: 'operational',
        contentType: 'application/x-ndjson',
        content: markers,
        fields: [
          { field: 'version', privacyClass: 'operational' },
          { field: 'supportCaseId', privacyClass: 'pseudonymous' },
          { field: 'event', privacyClass: 'operational' },
          { field: 'timestamp', privacyClass: 'operational' },
        ],
      });
    }
    const uiEvents = await this.readUiEvents(session);
    if (uiEvents) {
      evidence.push({
        evidence: 'ui-log',
        privacyClass: 'diagnostic',
        contentType: 'application/x-ndjson',
        content: uiEvents,
        fields: [
          { field: 'version', privacyClass: 'operational' },
          { field: 'supportCaseId', privacyClass: 'pseudonymous' },
          { field: 'timestamp', privacyClass: 'operational' },
          { field: 'event', privacyClass: 'diagnostic' },
        ],
      });
    }
    const log = await this.readReproductionLog(session.reproductionStartedAt!, session.reproductionEndedAt!);
    const scopes: Readonly<Record<Extract<DiagnosticEvidence, 'plugin-log' | 'sdk-log' | 'homekit-log'>, string>> = {
      'plugin-log': 'plugin',
      'sdk-log': 'sdk',
      'homekit-log': 'homekit',
    };
    for (const selected of DIAGNOSTICS_PROFILES[session.profile]) {
      if (!(selected in scopes)) continue;
      const scope = scopes[selected as keyof typeof scopes];
      const selectedRecords = log.records.filter((record) =>
        scope === 'plugin' ? record.scope !== 'sdk' && record.scope !== 'homekit' : record.scope === scope,
      );
      const content = selectedRecords.map((record) => JSON.stringify(record)).join('\n');
      if (content) {
        evidence.push({
          evidence: selected,
          privacyClass: 'diagnostic',
          contentType: 'application/x-ndjson',
          content: `${content}\n`,
          ...(log.truncated ? { truncated: true } : {}),
          fields: [...new Set(selectedRecords.flatMap((record) => Object.keys(record)))].sort().map((field) => ({
            field,
            privacyClass:
              field === 'accessoryAliases' ? 'pseudonymous' : field === 'timestamp' ? 'operational' : 'diagnostic',
          })),
        });
      }
    }
    return evidence;
  }

  private async readUiEvents(session: PersistedDiagnosticsSession): Promise<string> {
    try {
      const path = join(this.storageRoot, DIAGNOSTICS_DIRECTORY, UI_EVENTS_FILE);
      const startedAt = Date.parse(session.reproductionStartedAt!);
      const endedAt = Date.parse(session.reproductionEndedAt!);
      const records = (await this.readFileTail(path, MAX_UI_EVENTS_BYTES))
        .trim()
        .split('\n')
        .flatMap((line) => {
          try {
            const candidate = JSON.parse(line) as Record<string, unknown>;
            const timestamp = typeof candidate.timestamp === 'string' ? Date.parse(candidate.timestamp) : Number.NaN;
            if (
              Object.keys(candidate).sort().join(',') !== 'event,supportCaseId,timestamp,version' ||
              candidate.version !== 1 ||
              candidate.supportCaseId !== session.supportCaseId ||
              !isDiagnosticsUiEvent(candidate.event) ||
              !Number.isFinite(timestamp) ||
              timestamp < startedAt ||
              timestamp > endedAt
            ) {
              return [];
            }
            return [
              JSON.stringify({
                version: 1,
                supportCaseId: candidate.supportCaseId,
                timestamp: new Date(timestamp).toISOString(),
                event: candidate.event,
              }),
            ];
          } catch {
            return [];
          }
        });
      return records.length ? `${records.join('\n')}\n` : '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private async readReproductionMarkers(supportCaseId: string): Promise<string> {
    try {
      const path = join(this.storageRoot, DIAGNOSTICS_DIRECTORY, REPRODUCTION_MARKERS_FILE);
      const lines = (await this.readFileTail(path, MAX_SUPPORT_ARCHIVE_MARKER_BYTES))
        .trim()
        .split('\n')
        .filter((line) => {
          try {
            return (JSON.parse(line) as { supportCaseId?: unknown }).supportCaseId === supportCaseId;
          } catch {
            return false;
          }
        });
      return lines.length ? `${lines.join('\n')}\n` : '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private async readReproductionLog(
    startedAt: string,
    endedAt: string,
  ): Promise<{ records: Record<string, unknown>[]; truncated: boolean }> {
    const directory = join(this.storageRoot, LOG_DIRECTORY);
    const paths = [
      join(directory, LOG_FILE),
      ...Array.from({ length: LOG_ROTATIONS }, (_, index) => join(directory, `${LOG_FILE}.${index + 1}.gz`)),
    ];
    const started = Date.parse(startedAt);
    const ended = Date.parse(endedAt);
    const records: Record<string, unknown>[] = [];
    let retainedBytes = 0;
    let truncated = false;
    let budgetExhausted = false;
    for (const path of paths) {
      try {
        const file = await stat(path);
        if (file.size > MAX_CURRENT_LOG_BYTES) {
          truncated = true;
          continue;
        }
        const content = path.endsWith('.gz')
          ? (
              await gunzip(await readFile(path), {
                maxOutputLength: MAX_CURRENT_LOG_BYTES + MAX_LOG_RECORD_BYTES,
              })
            ).toString('utf8')
          : await readFile(path, 'utf8');
        const lines = content.trim().split('\n');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const line = lines[index]!;
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
            if (timestamp < started || timestamp > ended) continue;
            const bytes = Buffer.byteLength(line) + 1;
            if (retainedBytes + bytes > MAX_SUPPORT_ARCHIVE_LOG_BYTES) {
              truncated = true;
              budgetExhausted = true;
              break;
            }
            retainedBytes += bytes;
            records.push(record);
          } catch {
            continue;
          }
        }
        if (budgetExhausted || retainedBytes >= MAX_SUPPORT_ARCHIVE_LOG_BYTES) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { records: records.reverse(), truncated };
  }

  private async readFileTail(path: string, maximumBytes: number): Promise<string> {
    const file = await open(path, 'r');
    try {
      const size = (await file.stat()).size;
      const bytes = Math.min(size, maximumBytes);
      const buffer = Buffer.alloc(bytes);
      await file.read(buffer, 0, bytes, size - bytes);
      const content = buffer.toString('utf8');
      return size > maximumBytes ? content.slice(content.indexOf('\n') + 1) : content;
    } finally {
      await file.close();
    }
  }

  private requireAuthorized(): PersistedDiagnosticsSession {
    const session = activeDiagnosticsSession(this.storageRoot, this.now());
    if (!session) throw new Error('Diagnostics authorization is inactive or expired');
    return session;
  }

  private project(session: PersistedDiagnosticsSession | undefined): GuidedDiagnosticsStatus {
    if (!session) {
      return { status: 'inactive', selectedEvidence: [], missingEvidence: [], partialExportAvailable: false };
    }
    const selectedEvidence = DIAGNOSTICS_PROFILES[session.profile];
    const missingEvidence = session.reproductionEndedAt
      ? selectedEvidence.filter((evidence) => {
          try {
            readFileSync(observedEvidencePath(this.storageRoot, session.supportCaseId, evidence));
            return false;
          } catch {
            return true;
          }
        })
      : [];
    const expired = Date.parse(session.expiresAt) <= this.now();
    const status = expired
      ? 'expired'
      : session.reproductionEndedAt
        ? 'complete'
        : session.reproductionStartedAt
          ? 'reproducing'
          : 'authorized';
    const issueBody = [
      `Support case: ${session.supportCaseId}`,
      `Profile: ${session.profile}`,
      `Reproduction mode: ${session.reproductionMode}`,
      `Missing evidence: ${missingEvidence.length ? missingEvidence.join(', ') : 'none'}`,
    ].join('\n');
    return {
      status,
      supportCaseId: session.supportCaseId,
      profile: session.profile,
      reproductionMode: session.reproductionMode,
      selectedEvidence,
      missingEvidence,
      authorizedAt: session.authorizedAt,
      expiresAt: session.expiresAt,
      ...(session.reproductionStartedAt ? { reproductionStartedAt: session.reproductionStartedAt } : {}),
      ...(session.reproductionEndedAt ? { reproductionEndedAt: session.reproductionEndedAt } : {}),
      partialExportAvailable: Boolean(session.reproductionEndedAt),
      issueUrl: `https://github.com/homebridge-plugins/homebridge-eufy-security/issues/new?body=${encodeURIComponent(issueBody)}`,
    };
  }

  private async writeSession(session: PersistedDiagnosticsSession): Promise<void> {
    const directory = join(this.storageRoot, DIAGNOSTICS_DIRECTORY);
    const path = diagnosticsSessionPath(this.storageRoot);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  private async ensureMarker(
    session: PersistedDiagnosticsSession,
    event: 'reproduction-started' | 'reproduction-ended',
    timestamp: string,
  ): Promise<void> {
    const directory = join(this.storageRoot, DIAGNOSTICS_DIRECTORY);
    const path = join(directory, REPRODUCTION_MARKERS_FILE);
    await mkdir(directory, { mode: 0o700, recursive: true });
    try {
      const markers = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Partial<{ supportCaseId: string; event: string; timestamp: string }>);
      if (
        markers.some(
          (marker) =>
            marker.supportCaseId === session.supportCaseId && marker.event === event && marker.timestamp === timestamp,
        )
      ) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await appendFile(
      path,
      `${JSON.stringify({ version: 1, supportCaseId: session.supportCaseId, event, timestamp })}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await chmod(path, 0o600);
  }
}

function formatMessage(
  catalog: Readonly<Record<string, string>>,
  key: string,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const template = catalog[key] ?? EN_MESSAGES[key] ?? key;
  return template
    .replace(/\{([a-zA-Z0-9]+)\}/g, (placeholder, name: string) =>
      parameters[name] === undefined ? placeholder : String(parameters[name]),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function localize(target: unknown, key: string, parameters: Readonly<Record<string, string | number>> = {}): string {
  const translator = (target as Partial<Pick<PlatformLogger, 'localize'>>).localize;
  return translator?.(key, parameters) ?? formatMessage(EN_MESSAGES, key, parameters);
}

class JsonLineLog {
  private readonly directory: string;
  private readonly path: string;
  private pending = Promise.resolve();
  private queuedBytes = 0;
  private droppedRecords = 0;
  private droppedAt?: string;
  private totalBytes?: number;

  constructor(
    storageRoot: string,
    private readonly onError: () => void,
    private readonly now: () => number,
  ) {
    this.directory = join(storageRoot, LOG_DIRECTORY);
    this.path = join(this.directory, LOG_FILE);
  }

  write(message: string, written?: () => void): void {
    const payload = sanitizeStructuredEvent(message);
    if (!payload) {
      return;
    }
    const record = this.serialize(payload);
    const bytes = Buffer.byteLength(record);
    if (bytes > MAX_LOG_RECORD_BYTES || this.queuedBytes + bytes > MAX_QUEUED_LOG_BYTES) {
      this.droppedAt ??= new Date().toISOString();
      this.droppedRecords += 1;
      return;
    }
    const droppedRecords = this.droppedRecords;
    const droppedAt = this.droppedAt;
    this.droppedRecords = 0;
    this.droppedAt = undefined;
    this.queuedBytes += bytes;
    this.pending = this.pending
      .then(async () => {
        if (droppedRecords > 0) {
          await this.append(
            this.serialize(
              {
                scope: 'diagnostics',
                level: 'warn',
                event: 'records-dropped',
                droppedRecords,
              },
              droppedAt,
            ),
          );
        }
        await this.append(record);
        written?.();
      })
      .catch(() => this.onError())
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  flush(): Promise<void> {
    const droppedRecords = this.droppedRecords;
    const droppedAt = this.droppedAt;
    this.droppedRecords = 0;
    this.droppedAt = undefined;
    if (droppedRecords > 0) {
      this.pending = this.pending
        .then(() =>
          this.append(
            this.serialize(
              {
                scope: 'diagnostics',
                level: 'warn',
                event: 'records-dropped',
                droppedRecords,
              },
              droppedAt,
            ),
          ),
        )
        .catch(() => this.onError());
    }
    return this.pending;
  }

  private serialize(
    payload: Readonly<Record<string, unknown>>,
    timestamp = new Date(this.now()).toISOString(),
  ): string {
    return `${JSON.stringify({ ...payload, timestamp })}\n`;
  }

  private async append(record: string): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await chmod(this.directory, 0o700);
    const bytes = Buffer.byteLength(record);
    const rotated = await this.prepare(bytes);
    if (this.totalBytes === undefined || rotated) {
      this.totalBytes = await this.measureTotal();
    }
    try {
      await chmod(this.path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await appendFile(this.path, record, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    await chmod(this.path, 0o600);
    this.totalBytes += bytes;
    await this.enforceTotalLimit();
  }

  private async prepare(recordBytes: number): Promise<boolean> {
    try {
      const current = await stat(this.path);
      const today = new Date().toISOString().slice(0, 10);
      const currentDay = current.mtime.toISOString().slice(0, 10);
      if (currentDay !== today || current.size + recordBytes > MAX_CURRENT_LOG_BYTES) {
        await this.rotate();
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return false;
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${LOG_ROTATIONS}.gz`, { force: true });
    for (let index = LOG_ROTATIONS - 1; index >= 1; index -= 1) {
      try {
        const target = `${this.path}.${index + 1}.gz`;
        await rename(`${this.path}.${index}.gz`, target);
        await chmod(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    const compressed = await gzip(await readFile(this.path));
    await writeFile(`${this.path}.1.gz`, compressed, { flag: 'w', mode: 0o600 });
    await chmod(`${this.path}.1.gz`, 0o600);
    await rm(this.path, { force: true });
  }

  private async measureTotal(): Promise<number> {
    const files = [this.path, ...Array.from({ length: LOG_ROTATIONS }, (_, index) => `${this.path}.${index + 1}.gz`)];
    const sizes = await Promise.all(
      files.map(async (path) => {
        try {
          return (await stat(path)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
          }
          throw error;
        }
      }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private async enforceTotalLimit(): Promise<void> {
    for (let index = LOG_ROTATIONS; index >= 1 && this.totalBytes! > MAX_TOTAL_LOG_BYTES; index -= 1) {
      const path = `${this.path}.${index}.gz`;
      try {
        const size = (await stat(path)).size;
        await rm(path, { force: true });
        this.totalBytes! -= size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}

/**
 * Routes human messages to Homebridge and structured events to the plugin JSONL log.
 * File writes preserve accepted order; records beyond the bounded pending queue are counted and reported.
 */
export function createDiagnosticLogger(
  target: PlatformLogger,
  storageRoot?: string,
  catalog: Readonly<Record<string, string>> = EN_MESSAGES,
  now: () => number = Date.now,
): PlatformLogger {
  let fileFailureReported = false;
  const reportFileFailure = (): void => {
    if (!fileFailureReported) {
      fileFailureReported = true;
      target.warn(`[diagnostic-log-write-failed] ${formatMessage(catalog, 'log.diagnosticFileFailed')}`);
    }
  };
  const file = storageRoot ? new JsonLineLog(storageRoot, reportFileFailure, now) : undefined;
  const debug = file
    ? (message: string): void => {
        const event = sanitizeStructuredEvent(message);
        if (!event) return;
        const session = activeDiagnosticsSession(storageRoot!, now());
        const requiredEvidence = evidenceForEvent(event);
        const verbose = event.scope === 'sdk' || event.scope === 'homekit';
        if (
          verbose &&
          (!session || !requiredEvidence.every((evidence) => DIAGNOSTICS_PROFILES[session.profile].includes(evidence)))
        ) {
          return;
        }
        file.write(JSON.stringify(event), () => {
          if (session?.reproductionStartedAt && !session.reproductionEndedAt) {
            for (const evidence of requiredEvidence.filter((candidate) =>
              DIAGNOSTICS_PROFILES[session.profile].includes(candidate),
            )) {
              const path = observedEvidencePath(storageRoot!, session.supportCaseId, evidence);
              mkdirSync(dirname(path), { mode: 0o700, recursive: true });
              writeFileSync(
                path,
                `${JSON.stringify({ version: 1, supportCaseId: session.supportCaseId, evidence, observedAt: new Date(now()).toISOString() })}\n`,
                { mode: 0o600 },
              );
            }
          }
        });
      }
    : undefined;
  return {
    ...(debug ? { debug } : {}),
    error: (message) => target.error(message),
    flush: () => file?.flush() ?? Promise.resolve(),
    info: (message) => target.info(message),
    localize: (key, parameters) => formatMessage(catalog, key, parameters),
    warn: (message) => target.warn(message),
  };
}

function classifySdkEvent(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('restored persisted session')) return 'session-restored';
  if (normalized.includes('retrying') || normalized.includes('reconnecting')) return 'connection-retrying';
  if (normalized.includes('close') || normalized.includes('disconnect')) return 'connection-closed';
  if (normalized.includes('in use again') || normalized.includes('idle-detach cancelled')) return 'session-resumed';
  if (normalized.includes('connecting')) return 'session-connecting';
  if (normalized.includes('connected') || normalized.includes('logged in')) return 'connection-opened';
  if (normalized.includes('idle')) return 'session-idle';
  if (normalized.includes('candidate failed')) return 'snapshot-cache-warning';
  if (
    normalized.includes('wire value is not numeric') ||
    normalized.includes('unknown codec') ||
    normalized.includes('malformed')
  ) {
    return 'observation-invalid';
  }
  if (normalized.includes('unhandled payload')) return 'protocol-unhandled';
  if (
    normalized.includes('sendsetpayload') ||
    normalized.includes('requestimage') ||
    normalized.includes('querydatabase')
  ) {
    return 'protocol-command';
  }
  if (
    (normalized.includes('talkback') || normalized.includes('live media') || normalized.includes('live stream')) &&
    (normalized.includes('failed') || normalized.includes('error'))
  ) {
    return 'media-error';
  }
  if (
    normalized.includes('upstream error') ||
    normalized.includes('send err') ||
    normalized.includes('connection error')
  ) {
    return 'transport-error';
  }
  if (normalized.includes('failed') || normalized.includes('error')) return 'operation-failed';
  if (
    normalized.includes('talkback') ||
    normalized.includes('live media') ||
    normalized.includes('startlivemedia') ||
    normalized.includes('stoplivemedia')
  ) {
    return 'media-warning';
  }
  if (normalized.includes('[eufy]')) return 'client-warning';
  if (normalized.includes('retry')) return 'session-retrying';
  return 'sdk-diagnostic';
}

/** Adapts SDK protocol detail to bounded debug output without preserving supplied values. */
export function createSdkLogger(target: Partial<PlatformLogger> | undefined): Logger | undefined {
  if (!target?.debug) {
    return undefined;
  }
  const format = (message: string, args: unknown[]): Record<string, unknown> | undefined => {
    const requestedSubsystem = /^\[([a-z0-9-]+)(?:\s+[^\]]+)?\]/i.exec(message)?.[1]?.toLowerCase();
    if (requestedSubsystem === 'ffmpeg') {
      return undefined;
    }
    const subsystemAliases: Readonly<Record<string, string>> = {
      eufy: 'mega',
      fcm: 'push',
      live: 'p2p',
      session: 'p2p',
      smqtt: 'mqtt',
      'stored-snapshot-cache': 'device',
    };
    const aliasedSubsystem = requestedSubsystem ? subsystemAliases[requestedSubsystem] : undefined;
    const subsystem = SDK_SUBSYSTEMS.has(requestedSubsystem ?? '') ? requestedSubsystem : (aliasedSubsystem ?? 'sdk');
    const details = args.slice(0, MAX_SDK_DETAILS).map((value) => {
      if (value instanceof Error) {
        const errorType = ['Error', 'RangeError', 'SessionExpiredError', 'TypeError'].includes(value.name)
          ? value.name
          : 'Error';
        return { errorType };
      }
      if (typeof value === 'string') {
        return { type: 'string', length: value.length };
      }
      if (value && typeof value === 'object') {
        return { type: 'object' };
      }
      return { type: typeof value };
    });
    return {
      scope: 'sdk',
      subsystem,
      event: classifySdkEvent(message),
      ...(details.length ? { details } : {}),
      ...(args.length > MAX_SDK_DETAILS ? { detailsTruncated: true } : {}),
    };
  };
  const write = (level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]): void => {
    const event = format(message, args);
    if (event) {
      target.debug!(JSON.stringify({ ...event, level }));
    }
  };
  return {
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
  };
}

export type RuntimeState =
  | 'stopped'
  | 'acquiring-ownership'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'authentication-required'
  | 'owner-conflict'
  | 'failed'
  | 'stopping';

const CAPABILITIES = new Set(['arming', 'battery', 'camera', 'contact', 'siren', 'smart_light']);
const MEMBERS = new Set([
  'active',
  'batteryAlert',
  'brightness',
  'charging',
  'color',
  'level',
  'live',
  'mode',
  'open',
  'power',
  'snapshot',
  'stop',
  'talkback',
  'test',
]);
const REASONS = new Set([
  'adaptation-failed',
  'capability-not-supported',
  'disabled',
  'disabled-mid-session',
  'expired',
  'hot',
  'malformed',
  'missing',
  'no-acquisition',
  'no-primary-purpose-member',
  'no-video-within-backstop',
  'operation-failure',
  'primary-adapter-unavailable',
  'recovered',
  'rtcp-timeout',
  'sdk-fault',
  'source-acquisition-timeout',
  'source-error',
  'source-stopped',
  'source-unavailable',
  'timeout',
  'unsupported',
  'unsupported-selection',
  'device-audio-failed',
]);
const RUNTIME_CONDITION_REASONS = new Set([
  'stopped',
  'acquiring-ownership',
  'starting',
  'ready',
  'degraded',
  'authentication-required',
  'owner-conflict',
  'failed',
  'stopping',
  'recovered',
]);
const MAX_ACCESSORY_ALIASES = 32;
const HOMEKIT_EVENT_ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  'battery.status': new Set(['battery-alert', 'battery-level']),
  'contact.sensor': new Set(['contact-state']),
  'doorbell.press': new Set(['doorbell-press']),
  'motion.sensor': new Set(['motion-detection']),
  'arming.security-system': new Set(['arming-mode-changed', 'security-system-alarm']),
  'smart-light.lightbulb': new Set(['smart-light-state']),
};
const HOMEKIT_OBSERVATIONS = new Set(['malformed', 'missing', 'valid']);
const RUNTIME_NOTICES = {
  'status-publication-failed': {
    level: 'warn',
    messageKey: 'log.notice.statusPublicationFailed',
  },
  'ownership-release-not-finalized': {
    level: 'error',
    messageKey: 'log.notice.ownershipReleaseNotFinalized',
  },
  'ownership-release-failed': {
    level: 'error',
    messageKey: 'log.notice.ownershipReleaseFailed',
  },
  'shutdown-failed': {
    level: 'error',
    messageKey: 'log.notice.shutdownFailed',
  },
  'shutdown-timeout': {
    level: 'warn',
    messageKey: 'log.notice.shutdownTimeout',
    durationMessageKey: 'log.notice.shutdownTimeoutWithDuration',
  },
  'ownership-acquisition-failed': {
    level: 'error',
    messageKey: 'log.notice.ownershipAcquisitionFailed',
  },
  'ownership-release-incomplete': {
    level: 'warn',
    messageKey: 'log.notice.ownershipReleaseIncomplete',
  },
  'registry-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.registrySubscriberFailed',
  },
  'event-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.eventSubscriberFailed',
  },
  'state-subscriber-failed': {
    level: 'warn',
    messageKey: 'log.notice.stateSubscriberFailed',
  },
} as const;

export type RuntimeNoticeCode = keyof typeof RUNTIME_NOTICES;
const RUNTIME_CONDITIONS = {
  degraded: {
    code: 'runtime-transport-degraded',
    summaryKey: 'log.runtime.transportDegraded',
    actionKey: 'log.action.checkNetwork',
    level: 'warn',
  },
  'authentication-required': {
    code: 'runtime-authentication-required',
    summaryKey: 'log.runtime.authenticationRequired',
    actionKey: 'log.action.reauthenticate',
    level: 'warn',
  },
  'owner-conflict': {
    code: 'runtime-owner-conflict',
    summaryKey: 'log.runtime.ownerConflict',
    actionKey: 'log.action.stopOtherOwner',
    level: 'error',
  },
  failed: {
    code: 'runtime-failed',
    summaryKey: 'log.runtime.failed',
    actionKey: 'log.action.reviewRuntime',
    level: 'error',
  },
} as const;
const HOMEKIT_CONDITIONS = {
  'recognized-device-not-represented': {
    summaryKey: 'log.homekit.recognizedNotRepresented',
    actionKey: 'log.action.openDashboard',
  },
  'battery-capability-unavailable': {
    summaryKey: 'log.homekit.batteryCapabilityUnavailable',
    actionKey: 'log.action.waitBattery',
  },
  'invalid-battery-observation': {
    summaryKey: 'log.homekit.invalidBatteryObservation',
    actionKey: 'log.action.waitBatteryObservation',
  },
  'battery-temperature-alert': {
    summaryKey: 'log.homekit.batteryTemperatureAlert',
    actionKey: 'log.action.allowBatteryCooling',
  },
  'contact-capability-unavailable': {
    summaryKey: 'log.homekit.contactCapabilityUnavailable',
    actionKey: 'log.action.waitContact',
  },
  'invalid-contact-observation': {
    summaryKey: 'log.homekit.invalidContactObservation',
    actionKey: 'log.action.waitContactObservation',
  },
  'siren-capability-unavailable': {
    summaryKey: 'log.homekit.sirenCapabilityUnavailable',
    actionKey: 'log.action.waitSiren',
  },
  'invalid-siren-active-observation': {
    summaryKey: 'log.homekit.invalidSirenObservation',
    actionKey: 'log.action.waitSirenObservation',
  },
  'smart-light-capability-unavailable': {
    summaryKey: 'log.homekit.lightCapabilityUnavailable',
    actionKey: 'log.action.waitLight',
  },
  'invalid-smart-light-observation': {
    summaryKey: 'log.homekit.invalidLightObservation',
    actionKey: 'log.action.waitLightObservation',
  },
  'smart-light-operation-failed': {
    summaryKey: 'log.homekit.lightOperationFailed',
    actionKey: 'log.action.retryLight',
  },
  'smart-light-reconciliation-expired': {
    summaryKey: 'log.homekit.lightReconciliationExpired',
    actionKey: 'log.action.checkPhysicalLight',
  },
  'arming-capability-unavailable': {
    summaryKey: 'log.homekit.armingCapabilityUnavailable',
    actionKey: 'log.action.waitArming',
  },
  'unsupported-arming-mode': {
    summaryKey: 'log.homekit.unsupportedArmingMode',
    actionKey: 'log.action.selectSupportedArmingMode',
  },
  'arming-operation-failed': {
    summaryKey: 'log.homekit.armingOperationFailed',
    actionKey: 'log.action.retryArming',
  },
  'arming-reconciliation-expired': {
    summaryKey: 'log.homekit.armingReconciliationExpired',
    actionKey: 'log.action.checkPhysicalArmingMode',
  },
  'lock-capability-unavailable': {
    summaryKey: 'log.homekit.lockCapabilityUnavailable',
    actionKey: 'log.action.waitLock',
  },
  'lock-operation-failed': {
    summaryKey: 'log.homekit.lockOperationFailed',
    actionKey: 'log.action.retryLock',
  },
  'lock-reconciliation-expired': {
    summaryKey: 'log.homekit.lockReconciliationExpired',
    actionKey: 'log.action.checkPhysicalLock',
  },
  'camera-live-session-failed': {
    summaryKey: 'log.homekit.cameraLiveSessionFailed',
    actionKey: 'log.action.retryLiveView',
  },
  'camera-live-session-refused': {
    summaryKey: 'log.homekit.cameraLiveSessionRefused',
    actionKey: 'log.action.enableCamera',
  },
  'camera-snapshot-unavailable': {
    summaryKey: 'log.homekit.cameraSnapshotUnavailable',
    actionKey: 'log.action.checkCameraSnapshot',
  },
  'camera-talkback-failed': {
    summaryKey: 'log.homekit.cameraTalkbackFailed',
    actionKey: 'log.action.retryTalkback',
  },
  'camera-talkback-capability-unavailable': {
    summaryKey: 'log.homekit.cameraTalkbackUnavailable',
    actionKey: 'log.action.waitTalkback',
  },
} as const;

type HomeKitConditionCode = keyof typeof HOMEKIT_CONDITIONS;

function sanitizeStructuredEvent(message: string): Record<string, unknown> | undefined {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const level = ['debug', 'info', 'warn', 'error'].includes(String(value.level)) ? String(value.level) : undefined;
  if (!level || typeof value.scope !== 'string') return undefined;

  if (value.scope === 'sdk') {
    if (
      typeof value.subsystem !== 'string' ||
      !SDK_SUBSYSTEMS.has(value.subsystem) ||
      typeof value.event !== 'string' ||
      !SDK_EVENT_KEYS.has(value.event)
    ) {
      return undefined;
    }
    const details: Array<Record<string, unknown>> = [];
    for (const detail of Array.isArray(value.details) ? value.details.slice(0, MAX_SDK_DETAILS) : []) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
      const candidate = detail as Record<string, unknown>;
      if (['Error', 'RangeError', 'SessionExpiredError', 'TypeError'].includes(String(candidate.errorType))) {
        details.push({ errorType: String(candidate.errorType) });
        continue;
      }
      if (!['boolean', 'number', 'object', 'string', 'undefined'].includes(String(candidate.type))) continue;
      const length =
        Number.isSafeInteger(candidate.length) && Number(candidate.length) >= 0 ? Number(candidate.length) : undefined;
      details.push({ type: String(candidate.type), ...(length === undefined ? {} : { length }) });
    }
    return {
      scope: 'sdk',
      level,
      subsystem: value.subsystem,
      event: value.event,
      ...(details.length ? { details } : {}),
      ...(value.detailsTruncated === true ? { detailsTruncated: true } : {}),
    };
  }

  if (value.scope === 'runtime-notice') {
    if (typeof value.code !== 'string' || !Object.hasOwn(RUNTIME_NOTICES, value.code)) return undefined;
    const notice = RUNTIME_NOTICES[value.code as RuntimeNoticeCode];
    const durationMs =
      Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0 ? Number(value.durationMs) : undefined;
    const messageKey =
      durationMs !== undefined && 'durationMessageKey' in notice ? notice.durationMessageKey : notice.messageKey;
    return {
      scope: 'runtime-notice',
      level: notice.level,
      code: value.code,
      messageKey,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }

  if (value.scope === 'configuration-notice') {
    if (value.code !== 'discarded-v4-settings-unacknowledged') return undefined;
    return {
      scope: 'configuration-notice',
      level: 'warn',
      code: value.code,
      messageKey: 'log.discardedSettings',
    };
  }

  if (value.scope === 'homekit') {
    if (
      typeof value.adapter !== 'string' ||
      typeof value.event !== 'string' ||
      !HOMEKIT_EVENT_ROUTES[value.adapter]?.has(value.event) ||
      typeof value.observation !== 'string' ||
      !HOMEKIT_OBSERVATIONS.has(value.observation)
    ) {
      return undefined;
    }
    return {
      scope: 'homekit',
      level: 'debug',
      adapter: value.adapter,
      event: value.event,
      observation: value.observation,
    };
  }

  if (value.scope === 'runtime') {
    if (!['ready', 'stopped'].includes(String(value.event))) return undefined;
    return { scope: 'runtime', level: 'info', event: value.event, messageKey: 'log.runtime.state' };
  }

  if (value.scope === 'diagnostic-condition') {
    const homeKitDefinition =
      typeof value.code === 'string' && Object.hasOwn(HOMEKIT_CONDITIONS, value.code)
        ? HOMEKIT_CONDITIONS[value.code as HomeKitConditionCode]
        : undefined;
    const runtimeDefinition = Object.values(RUNTIME_CONDITIONS).find(({ code }) => code === value.code);
    if (typeof value.code !== 'string' || (!homeKitDefinition && !runtimeDefinition)) return undefined;
    if (typeof value.active !== 'boolean' || typeof value.reason !== 'string') return undefined;
    if (runtimeDefinition) {
      if (!RUNTIME_CONDITION_REASONS.has(value.reason)) return undefined;
      if (
        value.capability !== undefined ||
        value.member !== undefined ||
        value.affectedAccessoryCount !== undefined ||
        value.accessoryAliases !== undefined ||
        value.aliasesTruncated !== undefined
      ) {
        return undefined;
      }
      return {
        scope: 'diagnostic-condition',
        level: value.active ? runtimeDefinition.level : 'info',
        code: value.code,
        active: value.active,
        reason: value.reason,
        summaryKey: runtimeDefinition.summaryKey,
        actionKey: runtimeDefinition.actionKey,
      };
    }
    if (!REASONS.has(value.reason)) return undefined;
    const affectedAccessoryCount =
      Number.isSafeInteger(value.affectedAccessoryCount) && Number(value.affectedAccessoryCount) >= 0
        ? Number(value.affectedAccessoryCount)
        : undefined;
    const accessoryAliases = Array.isArray(value.accessoryAliases)
      ? value.accessoryAliases
          .filter((alias): alias is string => typeof alias === 'string' && /^accessory-[0-9a-f-]{36}$/.test(alias))
          .slice(0, MAX_ACCESSORY_ALIASES)
      : [];
    return {
      scope: 'diagnostic-condition',
      level: value.active ? 'warn' : 'info',
      code: value.code,
      active: value.active,
      reason: value.reason,
      summaryKey: homeKitDefinition!.summaryKey,
      actionKey: homeKitDefinition!.actionKey,
      ...(typeof value.capability === 'string' && CAPABILITIES.has(value.capability)
        ? { capability: value.capability }
        : {}),
      ...(typeof value.member === 'string' && MEMBERS.has(value.member) ? { member: value.member } : {}),
      ...(affectedAccessoryCount === undefined ? {} : { affectedAccessoryCount }),
      ...(accessoryAliases.length ? { accessoryAliases } : {}),
      ...(value.aliasesTruncated === true ? { aliasesTruncated: true } : {}),
    };
  }

  return undefined;
}

/** Emits one fixed-shape operational notice selected by its allowlisted runtime code. */
export function reportRuntimeNotice(
  target: Pick<PlatformLogger, 'error' | 'warn'> & Partial<Pick<PlatformLogger, 'debug'>>,
  code: RuntimeNoticeCode,
  fields: { durationMs?: number } = {},
): void {
  const notice = RUNTIME_NOTICES[code];
  const durationMs = fields.durationMs === undefined ? undefined : Math.max(0, Math.trunc(fields.durationMs));
  const messageKey =
    durationMs !== undefined && 'durationMessageKey' in notice ? notice.durationMessageKey : notice.messageKey;
  target[notice.level](`[${code}] ${localize(target, messageKey, { durationMs: durationMs ?? 0 })}`);
  target.debug?.(
    JSON.stringify({
      scope: 'runtime-notice',
      level: notice.level,
      code,
      messageKey,
      ...(durationMs === undefined ? {} : { durationMs }),
    }),
  );
}

/** Emits the startup notice for discarded settings awaiting acknowledgement. */
export function reportDiscardedV4Settings(
  target: Pick<PlatformLogger, 'warn'> & Partial<Pick<PlatformLogger, 'debug'>>,
): void {
  const code = 'discarded-v4-settings-unacknowledged';
  const messageKey = 'log.discardedSettings';
  target.warn(`[${code}] ${localize(target, messageKey)}`);
  target.debug?.(
    JSON.stringify({
      scope: 'configuration-notice',
      level: 'warn',
      code,
      messageKey,
    }),
  );
}

/** Emits one identity-free warning after an invalid retained camera image is discarded. */
export function reportInvalidSnapshotCache(
  target: Pick<PlatformLogger, 'warn'> & Partial<Pick<PlatformLogger, 'debug'>>,
): void {
  const code = 'camera-snapshot-cache-invalid';
  const messageKey = 'log.snapshotCacheInvalid';
  target.warn(`[${code}] ${localize(target, messageKey)}`);
  target.debug?.(JSON.stringify({ scope: 'media-notice', level: 'warn', code, messageKey }));
}

/** Emits one allowlisted HomeKit event trace only when host debug output is available. */
export function reportHomeKitEvent(target: Pick<PlatformLogger, 'debug'>, trace: HomeKitEventTrace): void {
  if (
    !target.debug ||
    !HOMEKIT_EVENT_ROUTES[trace.adapter]?.has(trace.event) ||
    !HOMEKIT_OBSERVATIONS.has(trace.observation)
  ) {
    return;
  }
  target.debug(
    JSON.stringify({
      scope: 'homekit',
      level: 'debug',
      adapter: trace.adapter,
      event: trace.event,
      observation: trace.observation,
    }),
  );
}

/** Emits bounded normal-output condition transitions without stable device or account identity. */
export class DiagnosticConditions {
  private readonly active = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private runtimeState?: RuntimeState;

  constructor(private readonly log: PlatformLogger) {}

  reportRuntimeState(state: RuntimeState): void {
    if (state === this.runtimeState) {
      return;
    }
    this.runtimeState = state;
    const current = RUNTIME_CONDITIONS[state as keyof typeof RUNTIME_CONDITIONS];
    for (const condition of Object.values(RUNTIME_CONDITIONS)) {
      if (condition !== current) {
        this.write(
          condition.code,
          false,
          state === 'ready' ? 'recovered' : state,
          condition.summaryKey,
          condition.actionKey,
          'info',
        );
      }
    }
    if (current) {
      this.write(current.code, true, state, current.summaryKey, current.actionKey, current.level);
    } else if (state === 'ready' || state === 'stopped') {
      const messageKey = 'log.runtime.state';
      this.log.info(`[runtime-${state}] ${localize(this.log, messageKey, { state })}`);
      this.log.debug?.(JSON.stringify({ scope: 'runtime', level: 'info', event: state, messageKey }));
    }
  }

  reportHomeKit(condition: HomeKitCondition, affectedDeviceIds: readonly string[]): void {
    const definition = Object.hasOwn(HOMEKIT_CONDITIONS, condition.code)
      ? HOMEKIT_CONDITIONS[condition.code as HomeKitConditionCode]
      : undefined;
    if (
      definition === undefined ||
      !REASONS.has(condition.reason) ||
      (condition.capability !== undefined && !CAPABILITIES.has(condition.capability)) ||
      (condition.member !== undefined && !MEMBERS.has(condition.member))
    ) {
      return;
    }
    const uniqueDeviceIds = condition.active ? [...new Set(affectedDeviceIds)].sort() : [];
    const accessoryAliases = uniqueDeviceIds
      .map((identity) => this.accessoryAlias(identity))
      .filter((alias): alias is string => alias !== undefined)
      .sort();
    this.write(
      condition.code,
      condition.active,
      condition.reason,
      definition.summaryKey,
      definition.actionKey,
      condition.active ? 'warn' : 'info',
      {
        ...(condition.capability === undefined ? {} : { capability: condition.capability }),
        ...(condition.member === undefined ? {} : { member: condition.member }),
        affectedAccessoryCount: uniqueDeviceIds.length,
        ...(accessoryAliases.length === 0 ? {} : { accessoryAliases }),
        ...(accessoryAliases.length === uniqueDeviceIds.length ? {} : { aliasesTruncated: true }),
      },
      `${condition.code}:${condition.capability ?? ''}:${condition.member ?? ''}`,
    );
  }

  private accessoryAlias(identity: string): string | undefined {
    let alias = this.aliases.get(identity);
    if (!alias && this.aliases.size < MAX_ACCESSORY_ALIASES) {
      alias = `accessory-${randomUUID()}`;
      this.aliases.set(identity, alias);
    }
    return alias;
  }

  private write(
    code: string,
    active: boolean,
    reason: string,
    summaryKey: string,
    actionKey: string,
    level: 'info' | 'warn' | 'error',
    fields: Readonly<Record<string, unknown>> = {},
    conditionKey = code,
  ): void {
    const fingerprint = JSON.stringify({ active, reason, ...fields });
    if (active) {
      if (this.active.get(conditionKey) === fingerprint) {
        return;
      }
      this.active.set(conditionKey, fingerprint);
    } else if (!this.active.delete(conditionKey)) {
      return;
    }
    const affectedAccessoryCount =
      typeof fields.affectedAccessoryCount === 'number' ? fields.affectedAccessoryCount : undefined;
    const summary = localize(this.log, summaryKey);
    const action = localize(this.log, actionKey);
    const affected = affectedAccessoryCount
      ? localize(this.log, affectedAccessoryCount === 1 ? 'log.condition.affectedOne' : 'log.condition.affectedMany', {
          count: affectedAccessoryCount,
        })
      : '';
    const message = localize(this.log, active ? 'log.condition.active' : 'log.condition.recovered', {
      action,
      affected,
      summary,
    });
    this.log[level](`[${code}] ${message}`);
    this.log.debug?.(
      JSON.stringify({
        scope: 'diagnostic-condition',
        level,
        code,
        active,
        reason,
        summaryKey,
        actionKey,
        ...fields,
      }),
    );
  }
}
