import type { MixComparePayload } from "./generation-mix-chart.ts";

function mixJsonUrl(date: string): string {
  const [year, month, day] = date.split("-");
  return `/${year}/${month}/${day}/mix.json`;
}

const LOAD_ERROR = "That day's mix could not be loaded.";

function paintOther(root: ParentNode, payload: MixComparePayload): void {
  const other = root.querySelector("[data-compare-other]");
  const heading = root.querySelector("#compare-heading");
  const summary = root.querySelector("#compare-summary");
  if (!other) return;
  if (payload.missing) {
    other.replaceChildren();
    other.textContent = LOAD_ERROR;
    if (heading) heading.textContent = "";
    if (summary) summary.textContent = "";
    return;
  }
  if (heading) heading.textContent = payload.title;
  if (summary) summary.textContent = payload.summary;
  other.innerHTML = `${payload.stackSvg}${payload.batterySvg}`;
}

export async function loadMix(root: ParentNode, date: string): Promise<void> {
  try {
    const response = await fetch(mixJsonUrl(date));
    if (!response.ok) throw new Error(String(response.status));
    const payload = (await response.json()) as MixComparePayload;
    if (payload.date !== date) throw new Error("date mismatch");
    paintOther(root, payload);
  } catch {
    paintOther(root, { date, missing: true });
  }
}

/**
 * Offer a comparison with another day. Nothing loads until the reader asks, so the page
 * shows one generation chart by default (ADR-0029).
 */
export async function bindDayCompare(
  root: ParentNode = document,
): Promise<void> {
  const compare = root.querySelector<HTMLElement>("[data-day-compare]");
  if (!compare) return;
  const select = compare.querySelector<HTMLSelectElement>("#compare-day");
  const form = compare.querySelector("form");
  const open = root.querySelector<HTMLButtonElement>("[data-compare-open]");
  if (!select) return;
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  select.addEventListener("change", () => {
    void loadMix(compare, select.value);
  });
  const show = async () => {
    compare.removeAttribute("hidden");
    compare.closest("[data-compare-root]")?.setAttribute("data-paired", "");
    if (open) open.hidden = true;
    await loadMix(compare, select.value);
    select.focus();
  };
  if (!open) {
    await show();
    return;
  }
  open.hidden = false;
  open.addEventListener("click", () => {
    void show();
  });
}
