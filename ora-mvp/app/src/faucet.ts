// ORA drip client. The signing key lives server-side (FAUCET_KEY) — the
// browser only POSTs the recipient. Server enforces rate limits; the 503
// path (key unset) hides the faucet row entirely (see network.ts).
import { toast } from "./dom";
import { short, reason } from "./format";

export async function requestFaucet(
  to: string,
  notify: (msg: string, ms?: number) => void = toast,
): Promise<string | null> {
  try {
    const r = await fetch("/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    const j = (await r.json().catch(() => ({}))) as { txHash?: string; error?: string };
    if (!r.ok || !j.txHash) {
      notify("Faucet: " + (j.error || `server ${r.status}`), 7000);
      return null;
    }
    notify(`✓ 100 test ORA on the way (${short(j.txHash)})`);
    return j.txHash;
  } catch (e) {
    notify("Faucet failed: " + reason(e), 7000);
    return null;
  }
}
