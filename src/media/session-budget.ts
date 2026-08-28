import type { MediaSessionBudget, MediaSessionClaim } from './contracts.js';

/**
 * Counts concurrent media work against the ceiling an operator declared, and refuses what would exceed it.
 *
 * The ceiling is a count rather than a measurement because neither input a plugin could measure it from is
 * sound. A core count is not a capacity — on a containerised eight-core host the readable quota was 2.5 cores
 * — and a container quota is not a substitute, because a host without one exposes no such file. Throughput
 * the running adaptations report is measurable but not attributable: a session coding below its negotiated
 * rate reads identically whether the host is saturated, the SDK source stalled, backpressure is holding it,
 * or the camera simply delivers below that rate, and refusing a session for a cause the signal cannot
 * establish presents as a broken camera.
 *
 * A ceiling of zero declares no ceiling, so an installation that never sets one is never counted and behaves
 * exactly as it did before this existed.
 */
export class DeclaredMediaSessionBudget implements MediaSessionBudget {
  private held = 0;

  constructor(private readonly ceiling: number) {}

  /** One share of the ceiling, or nothing when granting it would exceed what the operator declared. */
  claim(): MediaSessionClaim | undefined {
    if (this.ceiling > 0 && this.held >= this.ceiling) {
      return undefined;
    }
    this.held += 1;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.held -= 1;
      },
    };
  }
}
