// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { state } from "../src/state";
import { addActivity } from "../src/activity";
import { guardSigner, tx } from "../src/wallet";
import type { AppSigner } from "../src/state";

function mount(): void {
  document.body.innerHTML = `
    <div id="toast" role="status" aria-live="polite"></div>
    <details id="activityPanel"><summary><span id="activitySummary"></span></summary><div id="activityList"></div></details>`;
  state.reset("localhost");
  state.wallet = { address: "0x0000000000000000000000000000000000000000" } as AppSigner;
}

afterEach(() => {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  state.wallet = null;
  state.activity = [];
});

describe("transaction lifecycle", () => {
  it("moves to wallet confirmation only after a successful pre-flight simulation", async () => {
    mount();
    const activityId = addActivity("Open Trove", "local");
    state.activeActivityId = activityId;
    let sent = false;
    const signer = {
      address: "0x0000000000000000000000000000000000000000",
      sendTransaction: async () => {
        sent = true;
        return { hash: "0xabc", wait: async () => ({ status: 1 }) };
      },
    } as unknown as AppSigner;
    guardSigner(signer, { call: async () => "0x" } as never);

    await signer.sendTransaction({});
    expect(sent).toBe(true);
    expect(state.activity[0].status).toBe("awaiting-wallet");
    expect(state.activity[0].message).toMatch(/simulation passed/i);
  });

  it("keeps the action pending until chain confirmation and account-state reconciliation", async () => {
    mount();
    let finish!: (receipt: { status: number }) => void;
    let reconcile!: (updated: boolean) => void;
    let refreshStarted = false;
    const pending = tx("Borrow orUSD", async () => ({
      hash: "0xabc",
      wait: () => new Promise<{ status: number }>((resolve) => { finish = resolve; }),
    }), () => {
      refreshStarted = true;
      return new Promise<boolean>((resolve) => { reconcile = resolve; });
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(state.activity[0].status).toBe("confirming");
    expect(state.activity[0].hash).toBe("0xabc");
    expect(document.querySelector(".activity-item")?.textContent).toContain("Waiting for on-chain confirmation");

    finish({ status: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshStarted).toBe(true);
    expect(state.activity[0].status).toBe("processing");
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Updating account");
    reconcile(true);

    await expect(pending).resolves.toBe(true);
    expect(state.activity[0].status).toBe("confirmed");
    expect(state.activity[0].message).toMatch(/position and balances have been refreshed/);
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Confirmed");
  });

  it("separates chain success from a failed state refresh", async () => {
    mount();
    await expect(tx("Open Trove", async () => ({
      hash: "0xdef",
      wait: async () => ({ status: 1 }),
    }), async () => false)).resolves.toBe(true);

    expect(state.activity[0].status).toBe("confirmed");
    expect(state.activity[0].message).toMatch(/confirmed on-chain, but the latest account data could not be refreshed/i);
    expect(document.getElementById("toast")?.textContent).toMatch(/account data is still refreshing/i);
  });

  it("records wallet rejection as cancellation", async () => {
    mount();
    const rejected = Object.assign(new Error("user rejected request"), { code: 4001 });
    await expect(tx("Open Trove", async () => { throw rejected; })).resolves.toBe(false);
    expect(state.activity[0].status).toBe("cancelled");
    expect(document.querySelector(".activity-badge")?.textContent).toBe("Cancelled");
  });

  it("records preflight/send failures durably rather than only in a transient toast", async () => {
    mount();
    await expect(tx("Withdraw collateral", async () => { throw new Error("unsafe ratio"); })).resolves.toBe(false);
    expect(state.activity[0].status).toBe("failed");
    expect(state.activity[0].message).toContain("unsafe ratio");
    expect(document.querySelector(".activity-item")?.textContent).toContain("Failed");
    expect(localStorage.getItem("ora.transaction-activity.v1")).toContain("unsafe ratio");
  });
});
