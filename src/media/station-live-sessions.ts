import type { StationLiveClaim, StationLiveSessionRegistry } from './contracts.js';

/**
 * Which claim holds each station's one live channel, and who yields to whom.
 *
 * A HomeBase fans several cameras over one session and serves them ONE at a time, and the SDK refuses a second
 * camera rather than admitting it and degrading both. Deciding which camera deserves the station is this
 * plugin's, because it depends on what HomeKit shows at once and on what the operator is looking at, neither of
 * which the SDK can know. A standalone camera is its own station and contends with nobody.
 *
 * The order is `live`, then `recording`, then `snapshot`:
 *
 *  - A live view is on a screen now. Jitter there is the one degradation nobody can absorb, and an operator
 *    who opened a camera is telling us which one matters.
 *  - A recording writes to a file, so it survives being interrupted less well than being jittery, but it is
 *    not free to abandon the way a still is: a missed event cannot be re-taken.
 *  - A still fills a tile that is off screen exactly while a live view is on it, and re-running it costs
 *    nobody anything. Where it cannot run, the last good image stands in.
 *
 * A stronger claim ASKS the weaker holders to yield rather than seizing the station: each holder registered how
 * to abandon its own work, and abandoning is what frees the channel the SDK will otherwise refuse. A holder
 * that registered no way to yield is left alone, so nothing is dropped that cannot be stopped cleanly.
 *
 * None of it applies WITHIN one camera. Every egress on a camera shares one pull, so a recording and a live
 * view of the same camera are served together and neither yields to the other. That is what a motion
 * notification produces once the operator taps the tile, and it is the common shape rather than the exception.
 */
const CLAIM_RANK: Readonly<Record<StationLiveClaim, number>> = { live: 3, recording: 2, snapshot: 1 };

interface Session {
  readonly camera: string;
  readonly claim: StationLiveClaim;
  readonly abandon?: () => void;
  /** Whether this session has already been asked to yield, so a second stronger claim does not ask twice. */
  asked?: boolean;
}

export class StationLiveSessions implements StationLiveSessionRegistry {
  private readonly sessions = new Map<string, Set<Session>>();

  /** How many stations are currently holding at least one session. */
  get held(): number {
    return this.sessions.size;
  }

  heldFor(stationSn: string): StationLiveClaim | undefined {
    let strongest: StationLiveClaim | undefined;
    for (const session of this.sessions.get(stationSn) ?? []) {
      if (strongest === undefined || CLAIM_RANK[session.claim] > CLAIM_RANK[strongest]) {
        strongest = session.claim;
      }
    }
    return strongest;
  }

  /**
   * Whether `claim` may take this station now.
   *
   * Equal claims do not displace each other: a second live view does not evict the first, and the SDK refuses
   * it, which is the honest answer for a station that cannot serve both.
   */
  admits(stationSn: string, camera: string, claim: StationLiveClaim): boolean {
    let strongestElsewhere: StationLiveClaim | undefined;
    for (const session of this.sessions.get(stationSn) ?? []) {
      if (session.camera === camera) {
        return true;
      }
      if (strongestElsewhere === undefined || CLAIM_RANK[session.claim] > CLAIM_RANK[strongestElsewhere]) {
        strongestElsewhere = session.claim;
      }
    }
    return strongestElsewhere === undefined || CLAIM_RANK[claim] > CLAIM_RANK[strongestElsewhere];
  }

  /**
   * Record one session on `stationSn`, asking anything weaker to yield first, and answer the release that ends
   * it.
   *
   * `abandon` is how this session gives the station back before it would have finished. It is called at most
   * once, and never on the session that is taking the station.
   */
  hold(stationSn: string, camera: string, claim: StationLiveClaim, abandon?: () => void): () => void {
    const yielding = [...(this.sessions.get(stationSn) ?? [])].filter(
      (session) => session.camera !== camera && CLAIM_RANK[claim] > CLAIM_RANK[session.claim],
    );
    const session: Session = abandon ? { camera, claim, abandon } : { camera, claim };
    const held = this.sessions.get(stationSn) ?? new Set<Session>();
    held.add(session);
    this.sessions.set(stationSn, held);

    for (const weaker of yielding) {
      if (weaker.asked) {
        continue;
      }
      weaker.asked = true;
      weaker.abandon?.();
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = this.sessions.get(stationSn);
      remaining?.delete(session);
      if (remaining && remaining.size === 0) {
        this.sessions.delete(stationSn);
      }
    };
  }
}
