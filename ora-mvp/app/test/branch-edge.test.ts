// branch.ts preview/advice edges: non-finite buffers, zero amounts and a
// missing market price all render guarded copy instead of NaN.
import { describe, it, expect } from "vitest";
import { adjustmentPreviews, healthExplanation } from "../src/branch";

describe("healthExplanation", () => {
  it("renders a 0.0% distance when the buffer math is not finite", () => {
    // An infinite market price makes (p - liq)/p NaN even with both > 0.
    const copy = healthExplanation("caution", 150, 1.1, 1000, Infinity);
    expect(copy).toContain("0.0% collateral-price decline");
    const safe = healthExplanation("safe", 300, 1.1, 1000, Infinity);
    expect(safe).toContain("0.0% collateral-price decline");
  });
});

describe("adjustmentPreviews guards", () => {
  it("marks a zero/junk amount as not executable with guided copy", () => {
    const p = adjustmentPreviews(5, 2500, 0, 3000, 0.005, false, 1.1);
    for (const key of ["add", "withdraw", "borrow", "repay"] as const) {
      expect(p[key].executable).toBe(false);
      expect(p[key].reason).toBe("Enter an amount greater than zero.");
    }
    const junk = adjustmentPreviews(5, 2500, Number.NaN, 3000, 0.005, false, 1.1);
    expect(junk.add.reason).toBe("Enter an amount greater than zero.");
  });

  it("waits for a valid market price before projecting", () => {
    const p = adjustmentPreviews(5, 2500, 1, 0, 0.005, false, 1.1);
    expect(p.add.reason).toBe("Waiting for a valid market price.");
    expect(p.add.executable).toBe(false);
  });
});
