// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { state } from "../src/state";
import { addActivity, hydrateActivity, updateActivity } from "../src/activity";

const STORAGE_KEY = "ora.transaction-activity.v1";

function mountActivityPanel(): void {
  document.body.innerHTML = `
    <details id="activityPanel">
      <summary><strong>Recent activity</strong><span id="activitySummary"></span></summary>
      <div id="activityList"></div>
    </details>`;
}

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  state.activity = [];
});

describe("transaction activity", () => {
  it("persists status changes and links public transactions to the right explorer", () => {
    mountActivityPanel();
    state.activity = [];
    const id = addActivity("Borrow orUSD", "baseSepolia");
    updateActivity(id, {
      status: "confirming",
      hash: "0xabc123",
      message: "Waiting for on-chain confirmation…",
    });

    expect(document.querySelector(".activity-item")?.getAttribute("data-status")).toBe("confirming");
    expect(document.querySelector(".activity-item")?.textContent).toContain("Borrow orUSD");
    expect(document.querySelector(".activity-item a")?.getAttribute("href")).toBe("https://sepolia.basescan.org/tx/0xabc123");
    expect(localStorage.getItem(STORAGE_KEY)).toContain("0xabc123");
    expect(document.getElementById("activitySummary")?.textContent).toContain("pending");
  });

  it("renders each interaction milestone and keeps recovery and technical detail separate", () => {
    mountActivityPanel();
    state.activity = [];
    const id = addActivity("Open Trove", "local");
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Preparing");
    expect((document.getElementById("activityPanel") as HTMLDetailsElement).open).toBe(true);

    updateActivity(id, {
      status: "awaiting-wallet",
      message: "Simulation passed. Confirm the transaction in your wallet.",
    });
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Confirm in wallet");
    expect(document.getElementById("activitySummary")?.textContent).toContain("pending");

    updateActivity(id, {
      status: "failed",
      message: "The protocol rejected this action.",
      errorCode: "PROTOCOL_REJECTED",
      recovery: "Review your collateral ratio before retrying.",
      technical: "CALL_EXCEPTION\\nreverted with reason string 'MCR'",
    });
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Failed");
    expect(document.querySelector(".activity-recovery")?.textContent).toContain("Review your collateral ratio");
    expect(document.querySelector(".activity-technical summary")?.textContent).toContain("PROTOCOL_REJECTED");
    expect(document.querySelector(".activity-technical pre")?.textContent).toContain("CALL_EXCEPTION");
  });

  it("marks a pre-hash request interrupted after reload instead of pretending it was submitted", () => {
    mountActivityPanel();
    state.activity = [];
    addActivity("Open Trove", "local");
    state.activity = [];
    hydrateActivity();

    expect(state.activity[0].status).toBe("interrupted");
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Interrupted");
    expect(document.querySelector(".activity-message")?.textContent).toMatch(/before a transaction hash was saved/);
  });

  it("renders user-controlled labels as text, not executable markup", () => {
    mountActivityPanel();
    state.activity = [];
    addActivity("<img src=x onerror=alert(1)>", "local");
    expect(document.querySelector("#activityList img")).toBeNull();
    expect(document.querySelector(".activity-copy strong")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("rehydrates recent activity and marks untrackable in-flight records", () => {
    mountActivityPanel();
    state.activity = [];
    const id = addActivity("Repay orUSD", "base");
    updateActivity(id, { status: "submitted", hash: "0xfeed" });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    stored[0].explorer = "javascript:alert(1)";
    stored[0].netLabel = "Untrusted network label";
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    state.activity = [];
    hydrateActivity();

    expect(state.activity).toHaveLength(1);
    expect(state.activity[0].status).toBe("submitted");
    expect(document.querySelector(".activity-item a")?.getAttribute("href")).toBe("https://basescan.org/tx/0xfeed");
    expect(document.querySelector(".activity-meta")?.textContent).toContain("Base");
    expect(document.querySelector(".activity-meta")?.textContent).not.toContain("Untrusted");
    expect(document.querySelector(".activity-message")?.textContent).toMatch(/after page reload/);
  });
});
