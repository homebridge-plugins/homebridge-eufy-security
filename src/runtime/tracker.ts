import { chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { parseCompleteDeviceSnapshot, type CompleteDeviceSnapshot } from '../device/snapshot.js';
import type { RuntimeState } from '../diagnostics.js';

const MAX_TRACKER_BYTES = 1024 * 1024;
const ACTIVE_RUNTIME_STATES = new Set<RuntimeState>([
  'acquiring-ownership',
  'starting',
  'ready',
  'degraded',
  'stopping',
]);
const RUNTIME_STATES = new Set<RuntimeState>([
  ...ACTIVE_RUNTIME_STATES,
  'stopped',
  'authentication-required',
  'owner-conflict',
  'failed',
]);
const RUNTIME_STATUSES = new Set<RuntimeStatus>([
  'starting',
  'connected',
  'incomplete-inventory',
  'transport-degraded',
  'authentication-required',
  'owner-conflict',
  'failed',
  'stopped',
]);

export interface FreshRuntimeEvidence {
  state: RuntimeState;
  updatedAt: string;
}

export type RuntimeStatus =
  | 'starting'
  | 'connected'
  | 'incomplete-inventory'
  | 'transport-degraded'
  | 'authentication-required'
  | 'owner-conflict'
  | 'failed'
  | 'stopped';

export interface RuntimeTrackerRecord {
  version: 1;
  source: 'runtime';
  state: RuntimeState;
  updatedAt: string;
  generation?: string;
  complete: boolean;
  snapshot?: CompleteDeviceSnapshot;
  status: RuntimeStatus;
}

export interface RuntimeTrackerUpdate {
  generation?: string;
  complete?: boolean;
  snapshot?: CompleteDeviceSnapshot;
  status?: RuntimeStatus;
}

function defaultStatus(state: RuntimeState): RuntimeStatus {
  switch (state) {
    case 'ready':
      return 'connected';
    case 'degraded':
      return 'incomplete-inventory';
    case 'authentication-required':
      return 'authentication-required';
    case 'owner-conflict':
      return 'owner-conflict';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'starting';
  }
}

/** Reads advisory runtime liveness without granting or overriding SDK ownership. */
export class RuntimeTracker {
  private heartbeat?: NodeJS.Timeout;
  private current?: RuntimeTrackerRecord;

  constructor(
    private readonly path: string,
    private readonly freshThresholdMs = 90_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async fresh(): Promise<FreshRuntimeEvidence | null> {
    try {
      const value = this.readValue();
      if (!value) {
        return null;
      }
      if (
        value.version !== 1 ||
        value.source !== 'runtime' ||
        typeof value.state !== 'string' ||
        !ACTIVE_RUNTIME_STATES.has(value.state as RuntimeState) ||
        typeof value.updatedAt !== 'string'
      ) {
        return null;
      }
      const updatedAt = Date.parse(value.updatedAt);
      const age = this.now() - updatedAt;
      if (!Number.isFinite(updatedAt) || age < -5_000 || age > this.freshThresholdMs) {
        return null;
      }
      return { state: value.state as RuntimeState, updatedAt: value.updatedAt };
    } catch {
      return null;
    }
  }

  /** Reads the complete allowlisted runtime record used by the dashboard. */
  async read(): Promise<RuntimeTrackerRecord | null> {
    try {
      const value = this.readValue();
      if (
        !value ||
        value.version !== 1 ||
        value.source !== 'runtime' ||
        typeof value.state !== 'string' ||
        !RUNTIME_STATES.has(value.state as RuntimeState) ||
        typeof value.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        typeof value.complete !== 'boolean' ||
        typeof value.status !== 'string' ||
        !RUNTIME_STATUSES.has(value.status as RuntimeStatus) ||
        (value.generation !== undefined && typeof value.generation !== 'string')
      ) {
        return null;
      }
      const snapshot = value.snapshot === undefined ? undefined : parseCompleteDeviceSnapshot(value.snapshot);
      if (value.complete && snapshot === undefined) {
        return null;
      }
      return {
        version: 1,
        source: 'runtime',
        state: value.state as RuntimeState,
        updatedAt: value.updatedAt,
        generation: typeof value.generation === 'string' ? value.generation : undefined,
        complete: value.complete,
        snapshot,
        status: value.status as RuntimeStatus,
      };
    } catch {
      return null;
    }
  }

  start(state: RuntimeState = 'starting', update: RuntimeTrackerUpdate = {}): boolean {
    if (!this.update(state, update)) {
      return false;
    }
    this.heartbeat ??= setInterval(() => this.current && this.publishSafely(this.current), 60_000);
    this.heartbeat.unref();
    return true;
  }

  /** Atomically changes runtime state while retaining the latest complete snapshot by default. */
  update(state: RuntimeState, update: RuntimeTrackerUpdate = {}): boolean {
    const snapshot = update.snapshot ?? this.current?.snapshot;
    const record: RuntimeTrackerRecord = {
      version: 1,
      source: 'runtime',
      state,
      updatedAt: new Date(this.now()).toISOString(),
      generation: update.generation ?? this.current?.generation,
      complete: update.complete ?? state === 'ready',
      snapshot,
      status: update.status ?? defaultStatus(state),
    };
    if (!ACTIVE_RUNTIME_STATES.has(state)) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (!this.publishSafely(record)) {
      return false;
    }
    this.current = record;
    return true;
  }

  stop(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.update('stopped');
  }

  private readValue(): Record<string, unknown> | null {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.path, 'r');
      const buffer = Buffer.allocUnsafe(MAX_TRACKER_BYTES + 1);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_TRACKER_BYTES) {
        return null;
      }
      return JSON.parse(buffer.toString('utf8', 0, bytesRead)) as Record<string, unknown>;
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }

  private publishSafely(record: RuntimeTrackerRecord): boolean {
    try {
      this.publish(record);
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  private publish(record: RuntimeTrackerRecord): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify({ ...record, updatedAt: new Date(this.now()).toISOString() });
      if (Buffer.byteLength(serialized) > MAX_TRACKER_BYTES) {
        throw new Error(`runtime tracker exceeds ${MAX_TRACKER_BYTES} bytes`);
      }
      writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
