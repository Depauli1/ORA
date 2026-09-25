// Demo-key host gate. Loopback is the default; an explicit server opt-in may
// enable the isolated Arena preview. Pure so every allowed host is testable.
export function isLocalhost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h.endsWith(".localhost")
  );
}

// Arena preview access is opt-in from the server and accepted only on its
// port-prefixed preview host; ordinary public hostnames remain ineligible.
export function isArenaPreview(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/:\d+$/, "");
  return /^\d+-[a-z0-9][a-z0-9-]*\.e2b\.app$/.test(h);
}

export function canUseDemo(hostname: string, previewDemo = false): boolean {
  return isLocalhost(hostname) || (previewDemo && isArenaPreview(hostname));
}
