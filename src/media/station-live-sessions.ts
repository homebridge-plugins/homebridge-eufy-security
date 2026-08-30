import type { StationLiveSessionRegistry } from './contracts.js';

/**
 * Counts the live sessions held per station.
 *
 * A HomeBase fans several cameras over one session and serves them one at a time, so live work opened on one
 * of its cameras contends with a live view already running on another. A standalone camera is its own station
 * and contends with nobody, which is what makes the station the right key: it separates the cameras of a base
 * from a camera that answers alone, without either being penalised for the other.
 *
 * A count rather than a flag, because two cameras of one base can hold sessions at once — the base serves them
 * in turn rather than refusing the second — so the station is busy until the last of them has gone. A release
 * runs once, so a session reporting its end twice cannot free a peer's hold.
 */
export class StationLiveSessions implements StationLiveSessionRegistry {
  private readonly sessions = new Map<string, number>();

  /** How many stations are currently holding at least one session. */
  get held(): number {
    return this.sessions.size;
  }

  busy(stationSn: string): boolean {
    return this.sessions.has(stationSn);
  }

  /** Record one live session on `stationSn`, and answer the release that ends it. */
  hold(stationSn: string): () => void {
    this.sessions.set(stationSn, (this.sessions.get(stationSn) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.sessions.get(stationSn) ?? 1) - 1;
      if (remaining > 0) {
        this.sessions.set(stationSn, remaining);
      } else {
        this.sessions.delete(stationSn);
      }
    };
  }
}
