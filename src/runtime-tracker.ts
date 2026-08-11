import { chmodSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const MAX_TRACKER_BYTES = 64 * 1024;
const ACTIVE_RUNTIME_STATES = new Set<RuntimeState>([
  'acquiring-ownership',
  'starting',
  'ready',
  'degraded',
  'stopping',
]);

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

export interface FreshRuntimeEvidence {
  state: RuntimeState;
  updatedAt: string;
}

/** Reads advisory runtime liveness without granting or overriding SDK ownership. */
export class RuntimeTracker {
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly path: string,
    private readonly freshThresholdMs = 90_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async fresh(): Promise<FreshRuntimeEvidence | null> {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.path, 'r');
      const buffer = Buffer.allocUnsafe(MAX_TRACKER_BYTES + 1);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_TRACKER_BYTES) {
        return null;
      }
      const value = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as Record<string, unknown>;
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
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
  }

  start(state: RuntimeState = 'starting'): boolean {
    if (!this.publishSafely(state)) {
      return false;
    }
    this.heartbeat ??= setInterval(() => this.publishSafely(state), 60_000);
    this.heartbeat.unref();
    return true;
  }

  stop(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.publishSafely('stopped');
  }

  private publishSafely(state: RuntimeState): boolean {
    try {
      this.publish(state);
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  private publish(state: RuntimeState): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 1, source: 'runtime', state, updatedAt: new Date(this.now()).toISOString() }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      renameSync(temporaryPath, this.path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
