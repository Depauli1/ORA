// Typed DOM access. Missing elements throw immediately with the id —
// under strict TS this also replaces a dozen implicit-any casts.
export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`ORA: missing element #${id}`);
  return el;
}

export function input(id: string): HTMLInputElement {
  const el = $(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`ORA: #${id} is not an input`);
  return el;
}

export function select(id: string): HTMLSelectElement {
  const el = $(id);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`ORA: #${id} is not a select`);
  return el;
}

export function button(id: string): HTMLButtonElement {
  const el = $(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`ORA: #${id} is not a button`);
  return el;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(msg: string, ms = 4200): void {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), ms);
}
