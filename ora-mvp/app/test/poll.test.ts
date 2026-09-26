// Adaptive polling policy (state.ts) — pure, no timers, no DOM.
import { describe, expect, it } from "vitest";
import { BASE_POLL_MS, MAX_POLL_MS, nextPollDelayMs } from "../src/state";

describe("poll backoff policy", () => {
  it("healthy refreshes hold the base cadence", () => {
    expect(nextPollDelayMs(BASE_POLL_MS, true)).toBe(BASE_POLL_MS);
    expect(nextPollDelayMs(MAX_POLL_MS, true)).toBe(BASE_POLL_MS); // recovers from backoff
  });

  it("failures double the delay up to the cap", () => {
    let d = BASE_POLL_MS;
    d = nextPollDelayMs(d, false); expect(d).toBe(16_000);
    d = nextPollDelayMs(d, false); expect(d).toBe(32_000);
    d = nextPollDelayMs(d, false); expect(d).toBe(60_000);
    d = nextPollDelayMs(d, false); expect(d).toBe(MAX_POLL_MS); // capped
  });

  it("a success after backoff resets to base immediately", () => {
    let d = nextPollDelayMs(BASE_POLL_MS, false);
    d = nextPollDelayMs(d, false);
    expect(nextPollDelayMs(d, true)).toBe(BASE_POLL_MS);
  });

  it("never polls faster than base, even from a bogus small value", () => {
    // clamped up to base first, then doubled: max(1, base) * 2
    expect(nextPollDelayMs(1, false)).toBe(BASE_POLL_MS * 2);
    expect(nextPollDelayMs(BASE_POLL_MS, true)).toBeGreaterThanOrEqual(BASE_POLL_MS);
    expect(nextPollDelayMs(0, true)).toBe(BASE_POLL_MS);
  });
});
