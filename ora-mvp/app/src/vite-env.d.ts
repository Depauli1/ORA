/// <reference types="vite/client" />

interface ImportMeta {
  readonly vitest?: unknown;
}

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ethereum?: any;
  __ora?: unknown;
}
