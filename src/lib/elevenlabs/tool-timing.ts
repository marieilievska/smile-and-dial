/**
 * Per-step timing for one in-call tool, so we can see where the caller's wait
 * actually went: our database, Calendly, or the network in between.
 *
 * ElevenLabs reports a single number per tool call (`tool_latency_secs`, in the
 * conversation API). That tells us a booking took 2.6 s but not that ~2 s of it
 * was Calendly. The spans recorded here ride along on the tool's own
 * system_events audit row, and `scripts/tool-latency-report.mjs` puts the two
 * side by side.
 *
 * Pure — the clock is injected and nothing is imported — so it unit-tests
 * exactly rather than approximately.
 */
export type ToolTimings = Record<string, number>;

export class ToolTimer {
  private readonly startedAt: number;
  private readonly spans = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /**
   * Run `work` and add its duration to `<name>_ms`. Repeated names accumulate,
   * so two Calendly calls in one booking read as one Calendly total. A step
   * that throws is still timed — a slow failure is the interesting kind — and
   * the error is re-thrown untouched.
   */
  async time<T>(name: string, work: () => PromiseLike<T>): Promise<T> {
    const from = this.now();
    try {
      return await work();
    } finally {
      this.spans.set(name, (this.spans.get(name) ?? 0) + (this.now() - from));
    }
  }

  /** Add a duration measured somewhere else (e.g. inside a helper). */
  add(name: string, ms: number): void {
    this.spans.set(name, (this.spans.get(name) ?? 0) + Math.max(0, ms));
  }

  /**
   * Every span plus `total_ms` since the timer was created, in whole
   * milliseconds. This is written to an audit row for a human (and the
   * report) to read, not used for further arithmetic.
   */
  snapshot(): ToolTimings {
    const out: ToolTimings = {};
    for (const [name, ms] of this.spans) out[`${name}_ms`] = Math.round(ms);
    out.total_ms = Math.round(this.now() - this.startedAt);
    return out;
  }
}
