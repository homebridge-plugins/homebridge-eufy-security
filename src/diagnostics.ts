import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

import { LIVE_TRACE_MESSAGE, type Logger, type LiveTrace } from '@mega-yfue/eufy-sdk';

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

/** One write the device acknowledged and never applied, as the SDK reports it. */
export interface UnconfirmedWrite {
  serial: string;
  /** The SDK property the write targeted, which is its vocabulary and not this plugin's. */
  property: string;
}

/**
 * The SDK properties whose unconfirmed write this plugin can name, and what it calls them.
 *
 * A write is acknowledged when the transport carried it, and the SDK reports separately where the device
 * never applied it. Only a member this plugin actually writes is translated: anything else is a property
 * some other consumer of the same account asked for, and claiming it would report a condition against an
 * accessory this plugin never touched.
 */
const UNCONFIRMED_WRITE_MEMBERS: Readonly<Record<string, { capability: string; member: string }>> = {
  enabled: { capability: 'camera', member: 'enabled' },
  statusLed: { capability: 'camera', member: 'statusLed' },
  nightVision: { capability: 'camera', member: 'nightVision' },
};

/**
 * The condition an unconfirmed write is reported under, or nothing where this plugin did not write it.
 *
 * It shares the code a failed control operation already uses, because the user's situation is the same one —
 * a control that did not take — and differs only in how it was learnt: no error was raised, the device simply
 * never reported the value. The reason names that distinction so a support case can tell the two apart.
 */
export function unconfirmedWriteCondition(property: string): HomeKitCondition | undefined {
  const named = Object.hasOwn(UNCONFIRMED_WRITE_MEMBERS, property) ? UNCONFIRMED_WRITE_MEMBERS[property] : undefined;
  return named === undefined
    ? undefined
    : { code: 'camera-control-operation-failed', ...named, active: true, reason: 'not-confirmed' };
}

export type HomeKitEventTrace =
  | { adapter: string; event: string; observation: string; announcedBy?: string }
  | {
      adapter: string;
      event: 'live-video-selected';
      operation: 'start' | 'reconfigure';
      profile: 'baseline' | 'main' | 'high';
      level: '3.1' | '3.2' | '4.0';
      width: number;
      height: number;
      fps: number;
    }
  | {
      adapter: string;
      event: 'live-session-failed';
      outcome: 'failed';
      reason: string;
      stage: 'sdk-source-acquisition' | 'first-source-keyframe' | 'first-adapted-output' | 'controller-rtcp';
    }
  | { adapter: string; event: 'live-session-released' }
  /**
   * The first adapted output reached the negotiated destination.
   *
   * The moment a controller can show a picture, and the only thing that separates an adaptation that produced
   * nothing from one whose output a controller did not display. Carries the fact alone: a session identity,
   * a port and a key all travel in the same neighbourhood.
   */
  | { adapter: string; event: 'live-session-streaming' };

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
const FFMPEG_ENVIRONMENT_FILE = 'ffmpeg.json';
/** How much of an FFmpeg path or version banner is kept, which is more than either needs. */
const MAX_FFMPEG_IDENTITY_LENGTH = 256;
const DEBUG_AUTHORIZATION_MS = 72 * 60 * 60 * 1_000;
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const SDK_SUBSYSTEMS = new Set(['device', 'mega', 'mqtt', 'p2p', 'push', 'webrtc', 'sdk']);
const SDK_EVENT_KEYS = new Set([
  'client-warning',
  'connection-closed',
  'connection-opened',
  'connection-retrying',
  'live-session-streaming',
  'live-start-trace',
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
  'live-media': ['plugin-log', 'sdk-log', 'homekit-log', 'ffmpeg-log'],
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

/**
 * Collapses one supplied string to bounded printable text, or nothing where none of it survives.
 *
 * Every value this module accepts from outside itself passes through here first, so that a field arriving as
 * a novel, with control characters in it, or with a terminal escape sequence cannot become a record whatever
 * the allowlist beyond it decides.
 */
function boundedText(value: string, maximumLength: number): string | undefined {
  const printable = value
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength)
    .trim();
  return printable === '' ? undefined : printable;
}

/** One resolved adaptation binary, as this module keeps and republishes it. */
interface PersistedFfmpegEnvironment {
  path: string;
  source: 'bundled' | 'configured';
  version?: string;
}

function ffmpegEnvironmentPath(storageRoot: string): string {
  return join(storageRoot, DIAGNOSTICS_DIRECTORY, FFMPEG_ENVIRONMENT_FILE);
}

/**
 * Records which FFmpeg this run resolved, so a support archive states the build a failure came from.
 *
 * It is persisted rather than held in memory because the process that resolves it is not the one that
 * assembles an archive, and it is rewritten on every start so a path or binary that changed between runs
 * cannot be reported as the one in use. A write that fails is dropped: the archive then declares the
 * environment without an FFmpeg identity, which is honest, whereas failing startup over a diagnostic file
 * would cost the user their cameras.
 */
export function recordFfmpegEnvironment(storageRoot: string, ffmpeg: PersistedFfmpegEnvironment): void {
  try {
    const path = ffmpegEnvironmentPath(storageRoot);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, ffmpeg })}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Reads the recorded adaptation binary, refusing a record whose own fields do not narrow.
 *
 * The path and the banner are kept as written rather than pattern-replaced, because naming the binary is the
 * entire purpose of the record and a redacted one answers nothing. Neither is device or account material: the
 * path is this plugin's own setting or the binary it ships, and the banner is that build's public identity.
 */
function readFfmpegEnvironment(storageRoot: string): PersistedFfmpegEnvironment | undefined {
  try {
    const candidate = JSON.parse(readFileSync(ffmpegEnvironmentPath(storageRoot), 'utf8')) as Record<string, unknown>;
    const ffmpeg = candidate.ffmpeg;
    if (candidate.version !== 1 || !ffmpeg || typeof ffmpeg !== 'object' || Array.isArray(ffmpeg)) {
      return undefined;
    }
    const recorded = ffmpeg as Record<string, unknown>;
    if (typeof recorded.path !== 'string' || (recorded.source !== 'bundled' && recorded.source !== 'configured')) {
      return undefined;
    }
    const path = boundedText(recorded.path, MAX_FFMPEG_IDENTITY_LENGTH);
    const version =
      typeof recorded.version === 'string' ? boundedText(recorded.version, MAX_FFMPEG_IDENTITY_LENGTH) : undefined;
    return path === undefined
      ? undefined
      : { path, source: recorded.source, ...(version === undefined ? {} : { version }) };
  } catch {
    return undefined;
  }
}

function evidenceForEvent(event: Readonly<Record<string, unknown>>): DiagnosticEvidence[] {
  const evidence: DiagnosticEvidence[] = ['plugin-log'];
  if (event.scope === 'sdk') evidence.push('sdk-log');
  if (event.scope === 'homekit') evidence.push('homekit-log');
  if (event.scope === 'ffmpeg') evidence.push('ffmpeg-log');
  return evidence;
}

/** The scopes whose records are only kept while a support profile that declares them is authorized. */
const VERBOSE_SCOPES = new Set(['sdk', 'homekit', 'ffmpeg']);

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
    const ffmpeg = readFfmpegEnvironment(this.storageRoot);
    const evidence: SupportArchiveEvidence[] = [
      {
        evidence: 'environment',
        privacyClass: 'operational',
        contentType: 'application/json',
        content: `${JSON.stringify({ version: 1, node: process.version, platform: process.platform, arch: process.arch, ...(ffmpeg ? { ffmpeg } : {}) })}\n`,
        /**
         * The record is operational and one field is classified above it: a resolved FFmpeg path is an
         * environment fact, but it can carry the home directory of the account Homebridge runs as, so it is
         * declared as diagnostic rather than presented alongside the host's own architecture.
         */
        fields: [
          ...['version', 'node', 'platform', 'arch'].map((field) => ({ field, privacyClass: 'operational' as const })),
          ...(ffmpeg ? [{ field: 'ffmpeg', privacyClass: 'diagnostic' as const }] : []),
        ],
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
    const scopes: Readonly<
      Record<Extract<DiagnosticEvidence, 'plugin-log' | 'sdk-log' | 'homekit-log' | 'ffmpeg-log'>, string>
    > = {
      'plugin-log': 'plugin',
      'sdk-log': 'sdk',
      'homekit-log': 'homekit',
      'ffmpeg-log': 'ffmpeg',
    };
    for (const selected of DIAGNOSTICS_PROFILES[session.profile]) {
      if (!(selected in scopes)) continue;
      const scope = scopes[selected as keyof typeof scopes];
      const selectedRecords = log.records.filter((record) =>
        scope === 'plugin' ? !VERBOSE_SCOPES.has(String(record.scope)) : record.scope === scope,
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
        const verbose = VERBOSE_SCOPES.has(String(event.scope));
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
  return 'sdk-diagnostic';
}

/** A non-negative integer, or nothing — a byte count, a duration, a tally of accessories. */
function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** A non-negative integer no larger than `max`, or nothing — a data-type id, a sign code, an exit status. */
function boundedInteger(value: unknown, max: number): number | undefined {
  const integer = nonNegativeInteger(value);
  return integer !== undefined && integer <= max ? integer : undefined;
}

/**
 * One of a fixed set of labels, or nothing.
 *
 * The only string form any value crossing this boundary is retained in: a label that is not on the list is
 * dropped rather than truncated or escaped, so no supplied text is ever carried through.
 */
function allowlistedLabel(value: unknown, allowed: readonly string[]): string | undefined {
  return allowed.includes(String(value)) ? String(value) : undefined;
}

/**
 * The widest startup window a retained duration may state.
 *
 * A minute bounds every window the SDK actually uses — a level-2 grace, a warm-up deadline, a retry interval —
 * and a duration beyond it is a value this plugin did not expect rather than a measurement, so it is dropped
 * like any other field that fails its shape.
 */
const MAX_STARTUP_WINDOW_MS = 60_000;

/** The three phases whose only field is the action they report, which the union fixes at `start`. */
const retainedStart = (candidate: Record<string, unknown>): Record<string, unknown> | undefined =>
  candidate.action === 'start' ? { action: 'start' } : undefined;

/**
 * What each phase of the SDK's live trace vocabulary retains, keyed by the phase itself.
 *
 * Typed against the published `LiveTrace` union, so a phase this table does not name fails to compile rather
 * than being dropped to a content-free record at runtime.
 *
 * Each entry validates the fields its own phase declares, by name, and returns nothing when they are not the
 * shape claimed, because this reads a value that crossed a process boundary. A field is retained only as a
 * fixed label, a boolean, or a bounded integer; the SDK states that its traces carry no serial, address or
 * key material, and validating rather than copying is what keeps that true here whatever it sends.
 *
 * The field NAMES are not checked against the union, only the phases are — so a field the SDK renames within
 * an existing phase is dropped silently, and that phase keeps only what it still recognises.
 */
const LIVE_TRACE_PHASES = {
  'media-command': (c) => {
    const topology = allowlistedLabel(c.topology, ['attached', 'own']);
    const action = allowlistedLabel(c.action, ['keepalive', 'start']);
    return topology && action && typeof c.level2 === 'boolean' ? { topology, action, level2: c.level2 } : undefined;
  },
  'media-command-ack': retainedStart,
  'media-command-retry': retainedStart,
  'media-command-unacknowledged': retainedStart,
  'first-video-command': (c) => {
    const signCode = boundedInteger(c.signCode, 255);
    return signCode !== undefined && typeof c.accepted === 'boolean' ? { signCode, accepted: c.accepted } : undefined;
  },
  'first-video-unit': (c) => (typeof c.keyframe === 'boolean' ? { keyframe: c.keyframe } : undefined),
  'first-keyframe': () => ({}),
  'first-foreign-media-command': (c) => {
    const media = allowlistedLabel(c.media, ['audio', 'video']);
    return media ? { media } : undefined;
  },
  'video-decode-empty': (c) => {
    const signCode = boundedInteger(c.signCode, 255);
    return signCode === undefined ? undefined : { signCode };
  },
  'datagram-gap': (c) => {
    const dataType = boundedInteger(c.dataType, 3);
    return dataType === undefined ? undefined : { dataType };
  },
  'sequence-restart': (c) => {
    const dataType = boundedInteger(c.dataType, 3);
    return dataType === undefined ? undefined : { dataType };
  },
  'level2-wait': (c) => {
    const waitMs = boundedInteger(c.waitMs, MAX_STARTUP_WINDOW_MS);
    return waitMs === undefined ? undefined : { waitMs };
  },
  'level2-ready': (c) => {
    const cipherId = boundedInteger(c.cipherId, 65535);
    return cipherId === undefined ? undefined : { cipherId };
  },
  'level2-absent': (c) => {
    const waitedMs = boundedInteger(c.waitedMs, MAX_STARTUP_WINDOW_MS);
    return waitedMs === undefined ? undefined : { waitedMs };
  },
  'media-command-unsent': (c) => {
    const reason = allowlistedLabel(c.reason, ['level2-key', 'address']);
    return reason ? { reason } : undefined;
  },
  warming: (c) => {
    const retryMs = boundedInteger(c.retryMs, MAX_STARTUP_WINDOW_MS);
    const deadlineMs = boundedInteger(c.deadlineMs, MAX_STARTUP_WINDOW_MS);
    return retryMs === undefined || deadlineMs === undefined ? undefined : { retryMs, deadlineMs };
  },
} satisfies Record<LiveTrace['phase'], (candidate: Record<string, unknown>) => Record<string, unknown> | undefined>;

function sanitizeSdkLiveStartTrace(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const phase = String(candidate.phase);
  if (!Object.hasOwn(LIVE_TRACE_PHASES, phase)) return undefined;
  const fields = LIVE_TRACE_PHASES[phase as LiveTrace['phase']](candidate);
  return fields ? { phase, ...fields } : undefined;
}

/**
 * Adapts SDK protocol detail to bounded debug output without preserving supplied values.
 *
 * The SDK runs FFmpeg of its own for snapshot decoding and WebRTC containers and forwards that process's
 * stderr under an `[ffmpeg]` prefix. That is the same class of evidence as this plugin's own adaptation
 * output, so it is recorded as such, redacted line by line, rather than dropped as SDK chatter: a snapshot
 * that never decodes has no other account anywhere of why.
 */
export function createSdkLogger(target: Partial<PlatformLogger> | undefined): Logger | undefined {
  if (!target?.debug) {
    return undefined;
  }
  const format = (message: string, args: unknown[]): Record<string, unknown> | undefined => {
    if (message === LIVE_TRACE_MESSAGE) {
      const trace = sanitizeSdkLiveStartTrace(args[0]);
      if (trace) return { scope: 'sdk', subsystem: 'p2p', event: 'live-start-trace', ...trace };
    }
    const requestedSubsystem = /^\[([a-z0-9-]+)(?:\s+[^\]]+)?\]/i.exec(message)?.[1]?.toLowerCase();
    if (requestedSubsystem === 'ffmpeg') {
      const stderr = message.slice(message.indexOf(']') + 1).split(/\r?\n/);
      return sanitizeAdaptationNotice({ role: 'sdk', event: 'output', stderr }, 'debug');
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

const CAPABILITIES = new Set([
  'arming',
  'audio',
  'battery',
  'camera',
  'contact',
  'light',
  'lock',
  'siren',
  'smart_light',
]);
const MEMBERS = new Set([
  'active',
  'alarm',
  'batteryAlert',
  'brightness',
  'charging',
  'color',
  'enabled',
  'level',
  'isOn',
  'live',
  'microphone',
  'mode',
  'nightVision',
  'open',
  'power',
  'recordFragments',
  'snapshot',
  'snapshotLive',
  'snapshotStored',
  'speaker',
  'state',
  'statusLed',
  'stop',
  'talkback',
  'target',
  'test',
  'volume',
]);
const REASONS = new Set([
  'adaptation-exited-before-output',
  'adaptation-exited-while-streaming',
  'adaptation-failed',
  'adaptation-spawn-failed',
  'adapter-missing',
  'at-capacity',
  'capability-not-supported',
  'disabled',
  'disabled-mid-session',
  'disabled-no-video',
  'expired',
  'hot',
  'live-at-capacity',
  'live-decoder-unavailable',
  'live-failed',
  'live-no-keyframe',
  'live-source-failed',
  'live-unavailable',
  'live-undecodable-burst',
  'malformed',
  'missing',
  'missing-evidence',
  'missing-trigger',
  'no-acquisition',
  'no-output-within-backstop',
  'no-primary-purpose-member',
  'no-retained-image',
  'not-confirmed',
  'no-video-within-backstop',
  'operation-failure',
  'primary-adapter-unavailable',
  'recovered',
  'rtcp-timeout',
  'sdk-fault',
  'source-acquisition-timeout',
  'source-audio-only',
  'source-error',
  'source-stopped',
  'source-unavailable',
  'stored-download-failed',
  'stored-failed',
  'stored-invalid-image',
  'stored-not-observed',
  'stored-pending',
  'stored-unavailable',
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
  'lock.mechanism': new Set(['lock-state']),
  'motion.sensor': new Set(['motion-detection']),
  'arming.security-system': new Set(['arming-mode-changed', 'security-system-alarm']),
  'smart-light.lightbulb': new Set(['smart-light-state']),
  'camera.streaming': new Set(['camera-enabled-changed']),
  'camera.controls': new Set(['camera-enabled-changed']),
};
const HOMEKIT_OBSERVATIONS = new Set(['malformed', 'missing', 'valid']);
/**
 * What announced a change, for an adapter that follows more than one announcement for the same state.
 *
 * Consulted by both halves of the write path, and it has to be: the reporter builds the record, and the file
 * sink then rebuilds a homekit record from its own allowlist rather than forwarding what it was given. A field
 * only one half names is produced and then discarded, silently, and only in the artifact a support case reads.
 */
const HOMEKIT_ANNOUNCEMENTS = new Set(['write', 'poll']);
const HOMEKIT_LIVE_VIDEO_OPERATIONS = new Set(['start', 'reconfigure']);
const HOMEKIT_LIVE_VIDEO_PROFILES = new Set(['baseline', 'main', 'high']);
const HOMEKIT_LIVE_VIDEO_LEVELS = new Set(['3.1', '3.2', '4.0']);
const HOMEKIT_LIVE_VIDEO_GEOMETRIES = new Set(['320x180', '640x360', '1280x720', '1920x1080']);
const HOMEKIT_LIVE_VIDEO_FRAME_RATES = new Set([15, 30]);
const HOMEKIT_LIVE_SESSION_STAGES = new Set([
  'sdk-source-acquisition',
  'first-source-keyframe',
  'first-adapted-output',
  'controller-rtcp',
]);
/**
 * Which adaptation process an FFmpeg record came from.
 *
 * A superset of what the media domain can report, because the SDK runs FFmpeg of its own for snapshot
 * decoding and WebRTC containers and forwards its output here under the same evidence class.
 */
const ADAPTATION_ROLES = new Set(['live-video', 'live-audio', 'return-audio', 'recording', 'sdk']);
/** What that process did. `output` is a process reported for what it wrote rather than for how it ended. */
const ADAPTATION_EVENTS = new Set([
  'started',
  'spawn-failed',
  'exited-before-output',
  'exited-while-streaming',
  'output',
]);
/**
 * Which of those events is a failure, and so the ones a record is levelled `warn` for.
 *
 * The others are a stream working: `started` is a process beginning, and `output` is a process reported for
 * what it wrote on the way to a stop it was asked to make — the exit code of a killed FFmpeg among it. Neither
 * is something a reader must act on, and levelling the class rather than the record put four warnings in the
 * log for every session that succeeded.
 */
const ADAPTATION_FAILURE_EVENTS = new Set<string>(['spawn-failed', 'exited-before-output', 'exited-while-streaming']);
/**
 * The signals a terminated adaptation is reported under.
 *
 * A signal this build cannot name is dropped rather than passed through, because the field is written from
 * an operating-system string and an allowlist is the only thing that keeps it one.
 */
const ADAPTATION_SIGNALS = new Set([
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGILL',
  'SIGINT',
  'SIGKILL',
  'SIGPIPE',
  'SIGSEGV',
  'SIGTERM',
]);
/**
 * How many stderr lines one record keeps.
 *
 * A producer bounds its own retention too, and this bound is applied again rather than trusted, because a
 * record's size is this module's to answer for however many lines it was offered.
 */
const MAX_ADAPTATION_STDERR_LINES = 8;
const MAX_ADAPTATION_STDERR_LINE_LENGTH = 200;
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
  'unusable-lock-announcement': {
    summaryKey: 'log.homekit.unusableLockAnnouncement',
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
  'camera-media-at-capacity': {
    summaryKey: 'log.homekit.cameraMediaAtCapacity',
    actionKey: 'log.action.reduceConcurrentMedia',
  },
  'camera-recording-unavailable': {
    summaryKey: 'log.homekit.cameraRecordingUnavailable',
    actionKey: 'log.action.checkCameraRecording',
  },
  'camera-recording-failed': {
    summaryKey: 'log.homekit.cameraRecordingFailed',
    actionKey: 'log.action.retryRecording',
  },
  'camera-recording-refused': {
    summaryKey: 'log.homekit.cameraRecordingRefused',
    actionKey: 'log.action.enableCamera',
  },
  'camera-controls-capability-unavailable': {
    summaryKey: 'log.homekit.cameraControlsCapabilityUnavailable',
    actionKey: 'log.action.waitCameraControl',
  },
  'camera-control-operation-failed': {
    summaryKey: 'log.homekit.cameraControlOperationFailed',
    actionKey: 'log.action.retryCameraControl',
  },
  'invalid-camera-control-observation': {
    summaryKey: 'log.homekit.invalidCameraControlObservation',
    actionKey: 'log.action.checkCameraControl',
  },
  'camera-snapshot-unavailable': {
    summaryKey: 'log.homekit.cameraSnapshotUnavailable',
    actionKey: 'log.action.checkCameraSnapshot',
  },
  'camera-snapshot-capability-unavailable': {
    summaryKey: 'log.homekit.cameraSnapshotCapabilityUnavailable',
    actionKey: 'log.action.waitCameraSnapshot',
  },
  'camera-streaming-capability-unavailable': {
    summaryKey: 'log.homekit.cameraStreamingCapabilityUnavailable',
    actionKey: 'log.action.waitCameraLive',
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
  const level = allowlistedLabel(value.level, ['debug', 'info', 'warn', 'error']);
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
    if (value.event === 'live-start-trace') {
      if (level !== 'debug') return undefined;
      const trace = sanitizeSdkLiveStartTrace(value);
      return trace ? { scope: 'sdk', level, subsystem: 'p2p', event: 'live-start-trace', ...trace } : undefined;
    }
    const details: Array<Record<string, unknown>> = [];
    for (const detail of Array.isArray(value.details) ? value.details.slice(0, MAX_SDK_DETAILS) : []) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
      const candidate = detail as Record<string, unknown>;
      const errorType = allowlistedLabel(candidate.errorType, [
        'Error',
        'RangeError',
        'SessionExpiredError',
        'TypeError',
      ]);
      if (errorType) {
        details.push({ errorType });
        continue;
      }
      const type = allowlistedLabel(candidate.type, ['boolean', 'number', 'object', 'string', 'undefined']);
      if (!type) continue;
      const length = nonNegativeInteger(candidate.length);
      details.push({ type, ...(length === undefined ? {} : { length }) });
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
    const durationMs = nonNegativeInteger(value.durationMs);
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
    if (value.adapter === 'camera.streaming' && value.event === 'live-video-selected') {
      const selection = sanitizeLiveVideoSelection(value);
      return selection ? { scope: 'homekit', level: 'debug', ...selection } : undefined;
    }
    if (value.adapter === 'camera.streaming' && String(value.event).startsWith('live-session-')) {
      const lifecycle = sanitizeLiveSessionTrace(value);
      return lifecycle ? { scope: 'homekit', level: 'debug', ...lifecycle } : undefined;
    }
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
      ...(typeof value.announcedBy === 'string' && HOMEKIT_ANNOUNCEMENTS.has(value.announcedBy)
        ? { announcedBy: value.announcedBy }
        : {}),
    };
  }

  if (value.scope === 'runtime') {
    const event = allowlistedLabel(value.event, ['ready', 'stopped']);
    if (!event) return undefined;
    return { scope: 'runtime', level: 'info', event, messageKey: 'log.runtime.state' };
  }

  if (value.scope === 'ffmpeg') {
    return sanitizeAdaptationNotice(value, level);
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
    const affectedAccessoryCount = nonNegativeInteger(value.affectedAccessoryCount);
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
  if (trace.event === 'live-video-selected') {
    const selection = sanitizeLiveVideoSelection(trace as unknown as Record<string, unknown>);
    if (target.debug && selection) {
      target.debug(JSON.stringify({ scope: 'homekit', level: 'debug', ...selection }));
    }
    return;
  }
  if (
    trace.event === 'live-session-released' ||
    trace.event === 'live-session-failed' ||
    trace.event === 'live-session-streaming'
  ) {
    const lifecycle = sanitizeLiveSessionTrace(trace as unknown as Record<string, unknown>);
    if (target.debug && lifecycle) {
      target.debug(JSON.stringify({ scope: 'homekit', level: 'debug', ...lifecycle }));
    }
    return;
  }
  if (
    !target.debug ||
    !('observation' in trace) ||
    !HOMEKIT_EVENT_ROUTES[trace.adapter]?.has(trace.event) ||
    typeof trace.observation !== 'string' ||
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
      // Omitted rather than guessed where the adapter states none, and refused where it states one this
      // build does not know: a value invented here would read as fact in a support case.
      ...(typeof trace.announcedBy === 'string' && HOMEKIT_ANNOUNCEMENTS.has(trace.announcedBy)
        ? { announcedBy: trace.announcedBy }
        : {}),
    }),
  );
}

/**
 * One FFmpeg fact a caller offers for the record, in the loose terms it arrives in.
 *
 * Nothing here is trusted: `role`, `event` and `signal` are checked against this module's own allowlists and
 * `stderr` is redacted line by line, because a value that reached a support archive unexamined would be one
 * this module claimed to have gated and did not.
 */
export interface AdaptationTrace {
  role: string;
  event: string;
  code?: number;
  signal?: string;
  stderr?: readonly string[];
}

/**
 * Records one FFmpeg adaptation fact as the `ffmpeg-log` evidence the media support profiles declare.
 *
 * Nothing is written to the human console: an adaptation failure already reaches the user as the bounded
 * HomeKit condition its camera reports, and repeating each process's own exit there would say the same thing
 * a second time in a vocabulary only a maintainer can read.
 */
export function reportAdaptationNotice(target: Pick<PlatformLogger, 'debug'>, trace: AdaptationTrace): void {
  if (!target.debug) {
    return;
  }
  const level = ADAPTATION_FAILURE_EVENTS.has(trace.event) ? 'warn' : 'debug';
  const notice = sanitizeAdaptationNotice({ ...trace, level }, level);
  if (notice) {
    target.debug(JSON.stringify(notice));
  }
}

/**
 * Reduces one FFmpeg stderr line to what a support case may keep, or nothing where nothing is left of it.
 *
 * The line is the only place an encoder-level cause is stated outright, and it is also the only place this
 * plugin's own argument list can be echoed back: the output URL carries base64 SRTP key material, the
 * controller address sits beside it, and an SDK snapshot filename carries a device serial. Each of those is
 * replaced by what it is rather than searched for afterwards, because a redaction that depends on
 * recognising a secret fails on the first message shape nobody predicted.
 *
 * The key material is replaced before the path rules run, and not after. Base64 includes `/`, so a path rule
 * applied first splits a key into sub-runs too short for any length threshold to catch — measured on random
 * 30-byte keys, roughly one line in twenty then kept an eight-character fragment verbatim. The cost of this
 * order is that a long path made only of letters and separators is labelled as redacted rather than as a
 * path, which loses a label and never a secret.
 */
function redactAdaptationStderr(line: string): string | undefined {
  const printable = boundedText(line, MAX_ADAPTATION_STDERR_LINE_LENGTH);
  if (printable === undefined || printable.startsWith('progress=')) {
    return undefined;
  }
  return redactSensitiveText(printable);
}

/**
 * Removes from one line everything a support case may not keep, leaving the sentence and its numbers.
 *
 * One rule set for every line this plugin retains, whether it came from an adaptation's stderr or from the
 * SDK's own diagnostics, because what counts as a secret does not depend on which process said it — and two
 * lists would drift until one of them missed a shape.
 *
 * Each kind is replaced by what it is rather than searched for afterwards, since a redaction that depends on
 * recognising a secret fails on the first message shape nobody predicted.
 *
 * Key material is replaced BEFORE the path rules, not after. Base64 includes `/`, so a path rule applied
 * first splits a key into sub-runs too short for any length threshold to catch — measured on random 30-byte
 * keys, roughly one line in twenty then kept an eight-character fragment verbatim. The cost of this order is
 * that a long path made only of letters and separators is labelled as redacted rather than as a path, which
 * loses a label and never a secret.
 *
 * The P2P device id is grouped with key material rather than with identifiers: it is an input to the station's
 * encryption, so it is a credential.
 */
function redactSensitiveText(line: string): string | undefined {
  const redacted = line
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<url>')
    .replace(/\[[0-9a-f:]{2,}\]/gi, '<address>')
    .replace(/\b[A-Z0-9]{7}-[0-9]{6}-[A-Z0-9]{5}\b/g, '<redacted>')
    .replace(/[A-Za-z0-9+/]{20,}={0,2}/g, '<redacted>')
    .replace(/[A-Za-z]:\\[^\s]*/g, '<path>')
    .replace(/(?:\/[\w.@-]+){2,}\/?/g, '<path>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>')
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,}\b/gi, '<address>')
    .replace(/\bT\d[0-9A-Z]{9,}\b/g, '<serial>')
    .trim();
  return redacted === '' ? undefined : redacted;
}

/** Narrows one offered FFmpeg record against the adaptation allowlists, dropping it whole where it fails. */
function sanitizeAdaptationNotice(value: Record<string, unknown>, level: string): Record<string, unknown> | undefined {
  if (typeof value.role !== 'string' || !ADAPTATION_ROLES.has(value.role)) {
    return undefined;
  }
  if (typeof value.event !== 'string' || !ADAPTATION_EVENTS.has(value.event)) {
    return undefined;
  }
  const code = boundedInteger(value.code, 255);
  const signal = typeof value.signal === 'string' && ADAPTATION_SIGNALS.has(value.signal) ? value.signal : undefined;
  const stderr = (Array.isArray(value.stderr) ? value.stderr : [])
    .filter((line): line is string => typeof line === 'string')
    .map(redactAdaptationStderr)
    .filter((line): line is string => line !== undefined)
    .slice(-MAX_ADAPTATION_STDERR_LINES);
  return {
    scope: 'ffmpeg',
    level,
    role: value.role,
    event: value.event,
    ...(code === undefined ? {} : { code }),
    ...(signal === undefined ? {} : { signal }),
    ...(stderr.length ? { stderr } : {}),
  };
}

function sanitizeLiveSessionTrace(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (value.adapter !== 'camera.streaming') {
    return undefined;
  }
  if (value.event === 'live-session-released' || value.event === 'live-session-streaming') {
    return { adapter: value.adapter, event: value.event };
  }
  if (
    value.event !== 'live-session-failed' ||
    value.outcome !== 'failed' ||
    typeof value.reason !== 'string' ||
    !REASONS.has(value.reason) ||
    typeof value.stage !== 'string' ||
    !HOMEKIT_LIVE_SESSION_STAGES.has(value.stage)
  ) {
    return undefined;
  }
  return {
    adapter: value.adapter,
    event: value.event,
    outcome: value.outcome,
    reason: value.reason,
    stage: value.stage,
  };
}

function sanitizeLiveVideoSelection(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const operation = typeof value.operation === 'string' ? value.operation : undefined;
  const profile = typeof value.profile === 'string' ? value.profile : undefined;
  const codecLevel =
    typeof value.levelName === 'string' ? value.levelName : typeof value.level === 'string' ? value.level : undefined;
  const width = typeof value.width === 'number' ? value.width : undefined;
  const height = typeof value.height === 'number' ? value.height : undefined;
  const fps = typeof value.fps === 'number' ? value.fps : undefined;
  if (
    !operation ||
    !HOMEKIT_LIVE_VIDEO_OPERATIONS.has(operation) ||
    !profile ||
    !HOMEKIT_LIVE_VIDEO_PROFILES.has(profile) ||
    !codecLevel ||
    !HOMEKIT_LIVE_VIDEO_LEVELS.has(codecLevel) ||
    width === undefined ||
    height === undefined ||
    !HOMEKIT_LIVE_VIDEO_GEOMETRIES.has(`${width}x${height}`) ||
    fps === undefined ||
    !HOMEKIT_LIVE_VIDEO_FRAME_RATES.has(fps)
  ) {
    return undefined;
  }
  return {
    adapter: 'camera.streaming',
    event: 'live-video-selected',
    operation,
    profile,
    levelName: codecLevel,
    width,
    height,
    fps,
  };
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
