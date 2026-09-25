// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reviewTransaction } from "../src/review";

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function mount(): void {
  document.documentElement.innerHTML = html;
}

const sampleReview = {
  title: "Review borrowing",
  description: "Borrow orUSD against collateral.",
  network: "Local demo chain",
  details: [
    { label: "Borrow fee", value: "20 orUSD" },
    { label: "Projected ratio", value: "182.4%" },
  ],
  risk: "caution" as const,
  riskMessage: "Limited buffer to liquidation.",
};

afterEach(() => {
  document.body.classList.remove("review-open");
});

describe("transaction review", () => {
  it("shows action details and makes the background inert until canceled", async () => {
    mount();
    const trigger = document.createElement("button");
    trigger.textContent = "Open review";
    document.body.appendChild(trigger);
    trigger.focus();

    const result = reviewTransaction(sampleReview);
    const dialog = document.getElementById("txReviewDialog")!;
    expect(dialog.hidden).toBe(false);
    expect(dialog.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById("reviewTitle")?.textContent).toBe("Review borrowing");
    expect(document.getElementById("reviewNetwork")?.textContent).toBe("Local demo chain");
    expect(document.getElementById("reviewRows")?.textContent).toContain("20 orUSD");
    expect(document.getElementById("reviewRisk")?.getAttribute("data-risk")).toBe("caution");
    expect(document.getElementById("appContent")?.inert).toBe(true);

    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);
    expect(dialog.hidden).toBe(true);
    expect(document.getElementById("appContent")?.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns true only after Continue to wallet and supports Escape cancellation", async () => {
    mount();
    const accepted = reviewTransaction(sampleReview);
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await expect(accepted).resolves.toBe(true);

    const canceled = reviewTransaction(sampleReview);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(canceled).resolves.toBe(false);
    expect(document.getElementById("txReviewDialog")?.hidden).toBe(true);
  });

  it("renders all user-supplied review content as text", async () => {
    mount();
    const result = reviewTransaction({
      ...sampleReview,
      details: [{ label: "Label", value: '<img src=x onerror="alert(1)">' }],
    });
    const rows = document.getElementById("reviewRows")!;
    expect(rows.querySelector("img")).toBeNull();
    expect(rows.textContent).toContain("<img src=x");
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);
  });
});
