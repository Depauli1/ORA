import type { HealthTier } from "./branch";

export interface ReviewDetail {
  label: string;
  value: string;
}

export interface TransactionReview {
  title: string;
  description: string;
  network: string;
  details: ReviewDetail[];
  risk: HealthTier;
  riskMessage: string;
}

interface PendingReview {
  resolve: (accepted: boolean) => void;
  previousFocus: HTMLElement | null;
  inertStates: Array<{ element: HTMLElement; inert: boolean }>;
  keydown: (event: KeyboardEvent) => void;
}

let pending: PendingReview | null = null;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`ORA: missing transaction review element #${id}`);
  return element as T;
};

function finishReview(accepted: boolean): void {
  if (!pending) return;
  const current = pending;
  pending = null;
  document.removeEventListener("keydown", current.keydown);
  byId("txReviewDialog").hidden = true;
  document.body.classList.remove("review-open");
  current.inertStates.forEach(({ element, inert }) => { element.inert = inert; });
  if (current.previousFocus?.isConnected) current.previousFocus.focus();
  current.resolve(accepted);
}

function installDismissHandlers(): void {
  const overlay = byId<HTMLElement>("txReviewDialog");
  if (overlay.dataset.reviewWired === "true") return;
  overlay.dataset.reviewWired = "true";
  byId<HTMLButtonElement>("reviewConfirm").addEventListener("click", () => finishReview(true));
  byId<HTMLButtonElement>("reviewCancel").addEventListener("click", () => finishReview(false));
  byId<HTMLButtonElement>("reviewClose").addEventListener("click", () => finishReview(false));
  overlay.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).dataset.reviewDismiss === "true") finishReview(false);
  });
}

function updateReviewContent(review: TransactionReview): void {
  byId("reviewTitle").textContent = review.title;
  byId("reviewDescription").textContent = review.description;
  byId("reviewNetwork").textContent = review.network;
  const risk = byId("reviewRisk");
  risk.dataset.risk = review.risk;
  byId("reviewRiskTitle").textContent = review.risk === "safe"
    ? "Safe projection"
    : review.risk === "caution" ? "Caution: limited buffer"
      : review.risk === "critical" ? "Critical: below minimum" : "Health unavailable";
  byId("reviewRiskMessage").textContent = review.riskMessage;

  const rows = byId("reviewRows");
  rows.replaceChildren();
  for (const detail of review.details) {
    const row = document.createElement("div");
    row.className = "review-row";
    const label = document.createElement("span");
    label.textContent = detail.label;
    const value = document.createElement("strong");
    value.textContent = detail.value;
    row.append(label, value);
    rows.appendChild(row);
  }
}

/** Resolves true only after the user explicitly chooses to continue to their wallet. */
export function reviewTransaction(review: TransactionReview): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  installDismissHandlers();
  updateReviewContent(review);

  const overlay = byId<HTMLElement>("txReviewDialog");
  const inertStates: PendingReview["inertStates"] = [];
  for (const child of Array.from(document.body.children)) {
    if (child === overlay || !(child instanceof HTMLElement)) continue;
    inertStates.push({ element: child, inert: Boolean(child.inert) });
    child.inert = true;
  }

  return new Promise((resolve) => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finishReview(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        event.preventDefault();
        byId("reviewCancel").focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    pending = {
      resolve,
      previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      inertStates,
      keydown,
    };
    overlay.hidden = false;
    document.body.classList.add("review-open");
    document.addEventListener("keydown", keydown);
    byId("reviewCancel").focus();
  });
}
