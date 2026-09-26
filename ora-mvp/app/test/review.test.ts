// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("titles the risk banner for critical and unknown tiers", async () => {
    mount();
    const critical = reviewTransaction({ ...sampleReview, risk: "critical" });
    expect(document.getElementById("reviewRiskTitle")?.textContent).toBe("Critical: below minimum");
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(critical).resolves.toBe(false);

    const unknown = reviewTransaction({ ...sampleReview, risk: "unknown" });
    expect(document.getElementById("reviewRiskTitle")?.textContent).toBe("Health unavailable");
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(unknown).resolves.toBe(false);
  });

  it("ignores non-Tab keys and wraps Tab focus inside the dialog", async () => {
    mount();
    const result = reviewTransaction(sampleReview);
    const dialog = document.getElementById("txReviewDialog")!;

    const focused = document.activeElement; // the dialog auto-focuses cancel
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(document.activeElement).toBe(focused); // untouched by non-Tab keys

    const overlay = dialog.querySelector<HTMLElement>("[role=dialog]")!;
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    const tabForward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tabForward);
    expect(tabForward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first); // wrapped forward

    first.focus();
    const tabBackward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(tabBackward);
    expect(tabBackward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last); // wrapped backward

    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);
  });

  it("falls back to the cancel button when nothing in the dialog is focusable", async () => {
    mount();
    const result = reviewTransaction(sampleReview);
    const confirm = document.getElementById("reviewConfirm") as HTMLButtonElement;
    const cancel = document.getElementById("reviewCancel") as HTMLButtonElement;
    const close = document.getElementById("reviewClose") as HTMLButtonElement;
    confirm.disabled = true;
    cancel.disabled = true;
    close.disabled = true;
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true); // focus is trapped even with nothing to focus
    confirm.disabled = false;
    cancel.disabled = false;
    close.disabled = false;
    cancel.click();
    await expect(result).resolves.toBe(false);
  });

  it("handles overlay-focused shift+Tab, plain Tab inside, and a non-element active focus", async () => {
    mount();
    const result = reviewTransaction(sampleReview);
    const dialog = document.getElementById("txReviewDialog")!;
    const overlay = dialog.querySelector<HTMLElement>("[role=dialog]")!;
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));

    // shift+Tab while the dialog container itself is reported as focused wraps to the last control
    const activeSpy = vi.spyOn(Document.prototype, "activeElement", "get").mockReturnValue(dialog);
    const shiftFromOverlay = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(shiftFromOverlay);
    activeSpy.mockRestore();
    expect(shiftFromOverlay.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    // Tab forward while focus is NOT on the last control is left to the browser
    focusable[0].focus();
    const plainTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(plainTab);
    expect(plainTab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focusable[0]);

    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);

    // a non-HTML active focus when the dialog opens is stored as nothing to restore
    const nonElementSpy = vi.spyOn(Document.prototype, "activeElement", "get").mockReturnValue({} as never);
    const second = reviewTransaction(sampleReview);
    nonElementSpy.mockRestore();
    (document.getElementById("reviewCancel") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(false);
  });

  it("tolerates a second dismissal and a disconnected previous focus", async () => {
    mount();
    const trigger = document.createElement("button");
    trigger.textContent = "gone after open";
    document.body.appendChild(trigger);
    trigger.focus();

    const result = reviewTransaction(sampleReview);
    const cancel = document.getElementById("reviewCancel") as HTMLButtonElement;
    cancel.click(); // first dismissal finishes the review…
    await expect(result).resolves.toBe(false);
    cancel.click(); // …a second one must be a harmless no-op
    expect(document.getElementById("txReviewDialog")!.hidden).toBe(true);

    const second = reviewTransaction(sampleReview);
    trigger.remove(); // previous focus left the DOM while the dialog was open
    (document.getElementById("reviewConfirm") as HTMLButtonElement).click();
    await expect(second).resolves.toBe(true);
  });
});
