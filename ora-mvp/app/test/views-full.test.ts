// @vitest-environment jsdom
// Views-layer coverage: refresh() across branch flavors, previews, troves +
// markets tables, health banners, data-freshness gating.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bootApp, makeFakeC, installC, E, OTHER, settle, toastText, logs,
} from "./full-harness";
import { state, hasFreshMarketData, MAX_MARKET_DATA_AGE_MS } from "../src/state";
import {
  refresh, setView, setBranch, updateOpenPreview, updateAdjustmentPreview,
  updateDataFreshness, updateHealthBanner, riskIncreaseBlockMessage, refreshLever,
} from "../src/views";
import { NETWORKS } from "../src/config";

let restore: () => void = () => {};

beforeEach(async () => {
  const app = await bootApp();
  restore = app.restore;
});
afterEach(() => restore());

const txt = (id: string) => document.getElementById(id)!.textContent;

describe("refresh() success paths", () => {
  it("renders the full ETH (native) dashboard with an active trove", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    expect(await refresh()).toBe(true);
    expect(txt("stEthPrice")).toBe("$3,000");
    expect(txt("borrowMarketPrice")).toBe("$3,000");
    expect(txt("openCollBalance")).toContain("ETH");
    expect(txt("stTcr")).toBe("200%");
    expect(txt("stMode")).toBe("Normal");
    expect(txt("stSupply")).toContain("orUSD");
    expect(txt("stTroves")).toBe("5");
    expect(txt("stSp")).toContain("orUSD");
    expect(txt("stFee")).toBe("0.5%");
    expect(txt("balEth")).toContain("ETH");
    expect(txt("balOrusd")).toContain("orUSD");
    expect(txt("balOra")).toContain("ORA");
    expect((document.getElementById("troveNone") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("troveActive") as HTMLElement).hidden).toBe(false);
    expect(txt("troveTitle")).toBe("Your Trove");
    expect(txt("tvColl")).toContain("ETH");
    expect(txt("tvIcr")).toBe("600%");
    expect(txt("tvCloseHint")).toContain("Closing repays");
    expect((document.getElementById("btnClose") as HTMLButtonElement).disabled).toBe(false);
    expect(txt("spDeposit")).toContain("orUSD");
    expect(txt("spShare")).toContain("%");
    expect(txt("stkAmount")).toContain("ORA");
    expect(state.lastRefreshError).toBeNull();
    expect(hasFreshMarketData()).toBe(true);
    // troves table rendered with the owner marked
    expect(document.querySelectorAll("#trovesTable tbody tr").length).toBe(3);
    expect(txt("trovesTable")).toContain("(you)");
  });

  it("renders an inactive trove, hidden wst row and close-shortfall hint", async () => {
    // wallet holds 0 orUSD with debt open → close hint shows the shortfall
    installC(makeFakeC({ native: true }), "ETH");
    const C = state.C as unknown as ReturnType<typeof makeFakeC>;
    (C.orUSD as { balanceOf: (w: string) => Promise<bigint> }).balanceOf = async () => 0n;
    expect(await refresh()).toBe(true);
    expect((document.getElementById("troveActive") as HTMLElement).hidden).toBe(false);
    expect(txt("tvCloseHint")).toContain("short");
    expect((document.getElementById("btnClose") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("balWst") as HTMLElement).hidden).toBe(true); // native
    // and the no-trove state
    installC(makeFakeC({ native: true, troveStatus: 2n, position: null }), "ETH");
    expect(await refresh()).toBe(true);
    expect((document.getElementById("troveNone") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("troveActive") as HTMLElement).hidden).toBe(true);
    expect(txt("troveTitle")).toBe("Open a Trove");
    expect(txt("troveEyebrow")).toBe("BORROW ORUSD");
  });

  it("renders ERC20 (wstETH) flavor: collateral balance row + soft-liq band", async () => {
    installC(makeFakeC({
      native: false,
      troves: [[OTHER, E("2850"), E("1")], [OTHER, E("1000"), E("0.2")]],
    }), "wstETH");
    expect(await refresh()).toBe(true);
    expect((document.getElementById("balWst") as HTMLElement).hidden).toBe(false);
    expect(txt("balWst")).toContain("wstETH");
    expect(txt("adjCollBalance")).toContain("wstETH");
    // 2850 debt / 1 coll @3000 → 105.3% → in the [soft floor, MCR) band
    expect(document.querySelectorAll("#trovesTable button[data-softliq]").length).toBe(1);
    expect(document.querySelectorAll("#trovesTable button[data-liq]:not([disabled])").length).toBe(2);
  });

  it("renders the RWA (tBILL) flavor: NAV-linked price, cap note, nav row", async () => {
    installC(makeFakeC({ native: false, rwa: true }), "tBILL");
    expect(await refresh()).toBe(true);
    expect(txt("borrowMarketPrice")).toContain("NAV-linked");
    expect((document.getElementById("navRow") as HTMLElement).hidden).toBe(false);
    expect(txt("simNav")).toBe("$1.05");
    expect(txt("openFeeNote")).toContain("debt cap"); // tBILL has a 2M cap
    expect(txt("openFeeNote")).toContain("2,000,000");
  });

  it("renders the rates (ETHv2) flavor: vault, router, rate column, leverage", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    expect(await refresh()).toBe(true);
    expect(txt("tvRate")).toContain("/yr");
    expect(txt("svPrice")).toContain("orUSD");
    expect(txt("svTvl")).toContain("orUSD");
    expect(txt("svBal")).toContain("orUSD");
    expect(txt("svApy")).toContain("%");
    expect(txt("svPending")).toContain("12");
    expect(txt("stFee")).toBe("36%"); // weighted debt / system debt
    expect(txt("lvPos")).toContain("ETH @");
    expect(txt("lvDebt")).toContain("orUSD");
    expect(txt("lvPool")).toContain("/ETH");
    expect(txt("lvIcr")).toContain("%");
    expect(document.querySelectorAll("#trovesTable .trove-rate").length).toBe(3);
    expect((document.getElementById("sorusdCard") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("leverCard") as HTMLElement).hidden).toBe(false);
  });

  it("rates flavor with a closed zap position and no pending swap pool", async () => {
    installC(makeFakeC({
      native: true, rates: true, swapSpot: null,
      zapOf: "0x" + "99".repeat(20),
    }), "ETHv2");
    // the zap reads run through a real Contract → steer the provider answers
    const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
    const p = state.provider as unknown as { call: (t: { data?: string }) => Promise<string> };
    const sel = (await import("ethers")).ethers.id("position()").slice(0, 10);
    p.call = async (t) => String(t?.data || "").startsWith(sel)
      ? pad(E("2000")) + pad(E("1.5")).slice(2) + pad(3n * 10n ** 16n).slice(2) + pad(0n).slice(2) // closed
      : "0x";
    expect(await refresh()).toBe(true);
    expect(txt("lvPos")).toBe("none");
    expect(txt("lvDebt")).toBe("—");
    expect(txt("lvIcr")).toBe("—");
    expect(txt("lvPool")).toBe("—"); // no swap pool → untouched (markup default)
  });

  it("rates flavor with no zap at all renders none without throwing", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    (state.C as unknown as { zapFactory: { zapOf: () => Promise<string> } }).zapFactory.zapOf =
      async () => "0x" + "00".repeat(20);
    expect(await refresh()).toBe(true);
    expect(txt("lvPos")).toBe("none");
  });

  it("sequencer status: halted round, then a failing feed", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    const C = state.C as unknown as ReturnType<typeof makeFakeC>;
    (C.aggSeq as { latestRoundData: () => Promise<bigint[]> }).latestRoundData =
      async () => [1n, 1n, 0n, 0n, 1n]; // answer 1 = halted
    (C.priceFeed as { sequencerUp: () => Promise<boolean> }).sequencerUp = async () => false;
    expect(await refresh()).toBe(true);
    expect(txt("simSeq")).toBe("DOWN");
    expect((document.getElementById("simSeq") as HTMLElement).className).toBe("bad");
    // feed throws → status unavailable
    (C.priceFeed as { sequencerUp: () => Promise<boolean> }).sequencerUp = async () => {
      throw new Error("feed down");
    };
    expect(await refresh()).toBe(true);
    expect(txt("simSeq")).toBe("Status unavailable");
    expect((document.getElementById("simSeq") as HTMLElement).className).toBe("warn");
  });

  it("grace window shows while the sequencer is down but not halted", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    const C = state.C as unknown as ReturnType<typeof makeFakeC>;
    (C.aggSeq as { latestRoundData: () => Promise<bigint[]> }).latestRoundData =
      async () => [1n, 0n, 0n, 0n, 1n];
    (C.priceFeed as { sequencerUp: () => Promise<boolean> }).sequencerUp = async () => false;
    expect(await refresh()).toBe(true);
    expect(txt("simSeq")).toBe("GRACE (1h)");
  });

  it("live (unsettable) ETH feed falls back to the oracle price display", async () => {
    installC(makeFakeC({ native: false, aggEth: null }), "wstETH");
    expect(await refresh()).toBe(true);
    expect(txt("simPrice")).toBe("$3,000 (wstETH)");
  });

  it("aggregates errors into a failed refresh and keeps stale warnings", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    (state.C as unknown as { priceFeed: { getPrice: () => Promise<bigint> } }).priceFeed.getPrice =
      async () => { throw new Error("boom: no oracle"); };
    expect(await refresh()).toBe(false);
    expect(state.lastRefreshError).toContain("boom");
    expect(txt("dataFreshness")).toContain("Could not refresh");
    expect((document.getElementById("dataFreshness") as HTMLElement).dataset.stale).toBe("true");
    // risk-increasing actions paused while stale
    expect(riskIncreaseBlockMessage()).toContain("refresh failed");
    expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(true);
  });

  it("returns false immediately before a network is ready", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.networkReady = false;
    expect(await refresh()).toBe(false);
    state.networkReady = true;
    state.dep = null;
    expect(await refresh()).toBe(false);
    state.dep = JSON.parse(JSON.stringify((await import("./full-harness")).deployment));
    state.provider = null;
    expect(await refresh()).toBe(false);
  });
});

describe("troves table pagination and empty market", () => {
  it("shows the empty message, then paginates 50 at a time", async () => {
    installC(makeFakeC({ native: true, troves: [] }), "ETH");
    expect(await refresh()).toBe(true);
    expect(txt("trovesTable")).toContain("No open Troves");
    expect((document.getElementById("btnMoreTroves") as HTMLElement).hidden).toBe(true);
    // a full page of rows exposes the more button
    const many: Array<[string, bigint, bigint]> = [];
    for (let i = 0; i < 3; i++) many.push([OTHER, E("1000"), E("0.5")]);
    (state.C as unknown as { multiGetter: { getMultipleSortedTroves: (a: number, b: number) => Promise<unknown[]> } })
      .multiGetter.getMultipleSortedTroves = async (_a, n) => {
        const page: unknown[] = [];
        for (let i = 0; i < Math.min(n, 60); i++) page.push(many[i % many.length]);
        return page;
      };
    state.troveRows = 50;
    expect(await refresh()).toBe(true);
    expect((document.getElementById("btnMoreTroves") as HTMLElement).hidden).toBe(false);
    (document.getElementById("btnMoreTroves") as HTMLElement).click();
    expect(state.troveRows).toBe(100);
    expect(document.querySelectorAll("#trovesTable tbody tr").length).toBeGreaterThanOrEqual(50);
  });
});

describe("markets directory", () => {
  it("renders every deployment branch with live oracle + price via the provider", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    setView("markets");
    await settle(400);
    const rows = document.querySelectorAll("#marketTable tbody tr");
    expect(rows.length).toBe(4);
    expect(document.querySelector("#marketTable tbody tr.is-current")).not.toBeNull();
    expect(document.querySelector("#marketTable tbody tr.is-current .market-name")!.textContent).toBe("ETH");
    expect(txt("marketDirectoryStatus")).toBe("4 markets · on-chain data");
    expect(txt("marketTable")).toContain("Live");
    expect(txt("marketTable")).toContain("$3,000");
  });

  it("shows the unavailable state before a network is connected", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.dep = null;
    state.provider = null;
    state.networkReady = false;
    setView("markets");
    await settle(10);
    expect(txt("marketTable")).toContain("unavailable until a network is connected");
    expect(txt("marketDirectoryStatus")).toBe("No network data");
  });

  it("counts branches whose data source fails", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    state.provider = { getBalance: async () => 0n } as unknown as typeof state.provider;
    setView("markets");
    await settle(50);
    await settle(400);
    expect(txt("marketDirectoryStatus")).toContain("data source");
    expect(txt("marketTable")).toContain("Unavailable");
  });
});

describe("view + branch switching", () => {
  it("setView toggles panels and nav, invalid falls back to borrow", () => {
    installC(makeFakeC({ native: true }), "ETH");
    setView("earn");
    expect((document.getElementById("viewEarn") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("viewBorrow") as HTMLElement).hidden).toBe(true);
    setView("nonsense");
    expect((document.getElementById("viewBorrow") as HTMLElement).hidden).toBe(false);
    const nav = document.querySelector("button[data-view='markets']") as HTMLButtonElement;
    expect(nav.getAttribute("aria-pressed")).toBe("false");
  });

  it("setBranch clamps unknown names to the first branch and updates marks", () => {
    installC(makeFakeC({ native: true }), "ETH");
    setBranch("wstETH");
    expect([...document.querySelectorAll(".collsym")].every((el) => el.textContent === "wstETH")).toBe(true);
    expect(txt("openCollSymbol")).toBe("wstETH");
    expect(document.getElementById("openCollMark")!.dataset.asset).toBe("wsteth");
    setBranch("tBILL");
    expect(document.getElementById("openCollMark")!.dataset.asset).toBe("tbill");
    setBranch("ETH");
    expect(document.getElementById("openCollMark")!.dataset.asset).toBe("eth");
    setBranch("does-not-exist");
    expect(state.branch).toBe("ETH");
  });
});

describe("data freshness + risk gating", () => {
  it("walks every freshness and oracle-badge state", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    await refresh();
    // fresh + live
    expect((document.getElementById("oracleBadge") as HTMLElement).dataset.state).toBe("live");
    expect(txt("dataFreshness")).toContain("updated");
    // stale by age
    state.lastRefreshAt = Date.now() - (MAX_MARKET_DATA_AGE_MS + 5000);
    updateDataFreshness();
    expect(txt("dataFreshness")).toContain("old");
    expect(riskIncreaseBlockMessage()).toContain("older than");
    expect((document.getElementById("oracleBadge") as HTMLElement).dataset.state).toBe("unknown");
    // never refreshed
    state.lastRefreshAt = null;
    updateDataFreshness();
    expect(txt("dataFreshness")).toContain("first successful");
    expect(riskIncreaseBlockMessage()).toContain("first successful");
    // refresh failed
    state.lastRefreshAt = Date.now();
    state.lastRefreshError = "rpc down";
    updateDataFreshness();
    expect(riskIncreaseBlockMessage()).toContain("failed");
    // oracle not live
    state.lastRefreshError = null;
    state.oracleLive = false;
    updateDataFreshness();
    expect(riskIncreaseBlockMessage()).toContain("not live");
    expect((document.getElementById("oracleBadge") as HTMLElement).dataset.state).toBe("warning");
    // nav shock
    state.oracleLive = true;
    state.navShock = true;
    updateDataFreshness();
    expect(riskIncreaseBlockMessage()).toContain("NAV shock");
    expect((document.getElementById("oracleBadge") as HTMLElement).dataset.state).toBe("shock");
    // pending
    state.navShock = false;
    state.oracleLive = null;
    updateDataFreshness();
    expect((document.getElementById("oracleBadge") as HTMLElement).dataset.state).toBe("pending");
    expect(riskIncreaseBlockMessage()).toContain("not live");
  });

  it("pauses leveraged opening and shows the reason while blocked", async () => {
    installC(makeFakeC({ native: true }), "ETHv2");
    state.oracleLive = false;
    updateDataFreshness();
    expect((document.getElementById("btnLvOpen") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("lvRiskStatus") as HTMLElement).hidden).toBe(false);
    expect(txt("lvRiskStatus")).toContain("paused");
  });

  it("health banner severity escalates for oracle/nav but not recovery-only", () => {
    updateHealthBanner(true, false, true);
    expect((document.getElementById("healthBanner") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("healthBanner") as HTMLElement).dataset.severity).toBe("warning");
    expect(txt("healthTitle")).toBe("System notice");
    updateHealthBanner(false, false, false);
    expect((document.getElementById("healthBanner") as HTMLElement).dataset.severity).toBe("critical");
    expect(txt("healthTitle")).toBe("Risk warning");
    updateHealthBanner(true, true, false);
    expect(txt("healthMessage")).toContain("NAV shock");
    expect((document.getElementById("healthBanner") as HTMLElement).hidden).toBe(false);
    updateHealthBanner(true, false, false);
    expect((document.getElementById("healthBanner") as HTMLElement).hidden).toBe(true);
  });
});

describe("open + adjustment previews", () => {
  it("open preview: healthy, under-minimum, no-rate, over-balance and paused states", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    await refresh();
    (document.getElementById("openColl") as HTMLInputElement).value = "5";
    (document.getElementById("openDebt") as HTMLInputElement).value = "4000";
    updateOpenPreview();
    expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(false);
    expect(txt("openIcr")).toContain("%");
    expect(txt("openLiq")).toContain("$");
    expect(txt("openFee")).toContain("orUSD");
    expect((document.getElementById("openPreview") as HTMLElement).dataset.severity).not.toBe("warning");
    // under the 1800 minimum
    (document.getElementById("openDebt") as HTMLInputElement).value = "900";
    updateOpenPreview();
    expect(txt("openRiskCopy")).toContain("Minimum borrow is 1,800");
    expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(true);
    // over wallet balance
    (document.getElementById("openDebt") as HTMLInputElement).value = "4000";
    (document.getElementById("openColl") as HTMLInputElement).value = "9999";
    updateOpenPreview();
    expect(txt("openRiskCopy")).toContain("exceeds the available wallet balance");
    // empty inputs
    (document.getElementById("openColl") as HTMLInputElement).value = "";
    (document.getElementById("openDebt") as HTMLInputElement).value = "";
    updateOpenPreview();
    expect(txt("openRiskCopy")).toContain("Enter collateral");
    expect(txt("openIcr")).toBe("—");
    // paused while data is stale
    state.lastRefreshError = "x";
    updateOpenPreview();
    expect(txt("openRiskBadge")).toBe("Paused");
    state.lastRefreshError = null;
    // no market price yet
    state.price = 0;
    updateOpenPreview();
    expect(txt("openRiskCopy")).toContain("Waiting for a valid market price");
  });

  it("rates open preview: invalid rate and the no-upfront-fee copy", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    await refresh();
    (document.getElementById("openColl") as HTMLInputElement).value = "5";
    (document.getElementById("openDebt") as HTMLInputElement).value = "4000";
    (document.getElementById("openRate") as HTMLInputElement).value = "3";
    updateOpenPreview();
    expect(txt("openFee")).toBe("No upfront fee");
    expect(txt("openRiskCopy")).toContain("Selected interest rate: 3%");
    (document.getElementById("openRate") as HTMLInputElement).value = "400";
    updateOpenPreview();
    expect(txt("openRiskCopy")).toContain("between 0.5% and 100%");
    expect((document.getElementById("btnOpen") as HTMLButtonElement).disabled).toBe(true);
  });

  it("adjustment preview: waits for a trove, then renders four projections", async () => {
    installC(makeFakeC({ native: true, position: null, troveStatus: 2n }), "ETH");
    await refresh();
    expect(txt("adjustmentResults")).toContain("Waiting for a Trove");
    expect((document.getElementById("btnAddColl") as HTMLButtonElement).disabled).toBe(true);
    // active position
    installC(makeFakeC({ native: true }), "ETH");
    await refresh();
    expect(document.querySelectorAll("#adjustmentResults .adjustment-result").length).toBe(4);
    expect(txt("adjustmentResults")).toContain("Add ETH");
    expect(txt("adjustmentResults")).toContain("Withdraw ETH");
    // an executable amount enables the buttons
    (document.getElementById("adjCollAmount") as HTMLInputElement).value = "1";
    (document.getElementById("adjDebtAmount") as HTMLInputElement).value = "100";
    updateAdjustmentPreview();
    expect((document.getElementById("btnAddColl") as HTMLButtonElement).disabled).toBe(false);
    // risk-increasing actions paused while stale
    state.oracleLive = false;
    updateAdjustmentPreview();
    expect(txt("adjustmentResults")).toContain("paused");
    expect((document.getElementById("btnWithdrawColl") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("btnBorrowMore") as HTMLButtonElement).disabled).toBe(true);
  });

  it("position health panel shows the blocked state while data is stale", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    await refresh();
    state.oracleLive = false;
    updateDataFreshness();
    expect(txt("positionHealthBadge")).toBe("Check data");
    expect(txt("positionRiskMessage")).toContain("paused");
    state.oracleLive = true;
    updateDataFreshness();
    expect(txt("positionRiskMessage")).not.toContain("paused");
  });
});

describe("leverage panel", () => {
  it("is a no-op without a zap factory (non-rates branches)", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    await refreshLever();
    expect(txt("lvPos")).toBe("—"); // markup default, never touched
  });

  it("surfaces feed errors without breaking the page", async () => {
    installC(makeFakeC({ native: true, rates: true }), "ETHv2");
    const p = state.provider as unknown as { call: (t: { data?: string }) => Promise<string> };
    p.call = async () => { throw new Error("zap read failed"); };
    await refreshLever();
    expect(txt("lvPos")).toBe("—"); // markup default, never touched
  });
});

describe("liquidate buttons in the troves table", () => {
  it("wire liquidate and soft-liquidate through tx()", async () => {
    installC(makeFakeC({
      native: false,
      troves: [[OTHER, E("2850"), E("1")]], // 105.3% → soft band
    }), "wstETH");
    await refresh();
    const liq = document.querySelector("#trovesTable button[data-liq]:not([disabled])") as HTMLButtonElement;
    liq.click();
    await settle(30);
    expect(logs(state.C.troveManager as never, "liquidate").length).toBe(1);
    const soft = document.querySelector("#trovesTable button[data-softliq]") as HTMLButtonElement;
    soft.click();
    await settle(30);
    expect(logs(state.C.troveManager as never, "liquidatePartial").length).toBe(1);
  });
});

describe("risk block message details", () => {
  it("reports the exact staleness age window", async () => {
    installC(makeFakeC({ native: true }), "ETH");
    await refresh();
    state.lastRefreshAt = Date.now() - 31_000;
    expect(riskIncreaseBlockMessage()).toContain("older than 30 seconds");
  });
});

void NETWORKS;
void toastText;
