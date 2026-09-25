// Localhost gate for demo keys. Pure (hostname injected) so the rule is
// unit-testable: demo accounts work ONLY on loopback, whatever the UI shows.
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
