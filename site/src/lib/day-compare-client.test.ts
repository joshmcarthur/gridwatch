import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { bindDayCompare, loadMix } from "./day-compare-client.ts";

function page() {
  return parseHTML(`<!doctype html><html><body>
    <div data-compare-root>
    <div data-day-compare hidden>
      <form>
        <label for="compare-day">Compare with</label>
        <select id="compare-day">
          <option value="2026-09-26" selected>Saturday 26 September 2026</option>
          <option value="2026-10-29">Thursday 29 October 2026</option>
        </select>
      </form>
      <h3 id="compare-heading"></h3>
      <p id="compare-summary" aria-live="polite"></p>
      <div data-compare-other></div>
    </div>
    </div>
  </body></html>`);
}

const mix26 = {
  date: "2026-09-26",
  missing: false as const,
  title: "Saturday 26 September 2026",
  stackSvg: '<svg id="generation-mix-compare"></svg>',
  batterySvg: '<svg id="generation-battery-compare"></svg>',
  summary: "Hydro made the most.",
};

test("bindDayCompare fetches mix.json and inserts both SVGs", async () => {
  const { document } = page();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(mix26));
  }) as typeof fetch;
  try {
    await bindDayCompare(document);
    expect(urls).toEqual(["/2026/09/26/mix.json"]);
    expect(document.querySelector("#generation-mix-compare")).not.toBeNull();
    expect(
      document.querySelector("#generation-battery-compare"),
    ).not.toBeNull();
    expect(document.querySelector("#compare-heading")?.textContent).toBe(
      "Saturday 26 September 2026",
    );
    expect(document.querySelector("#compare-summary")?.textContent).toBe(
      "Hydro made the most.",
    );
    expect(
      document.querySelector("[data-day-compare]")?.hasAttribute("hidden"),
    ).toBe(false);
    expect(
      document
        .querySelector("[data-compare-root]")
        ?.hasAttribute("data-paired"),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadMix fetches the requested day's mix.json", async () => {
  const { document } = page();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        date: "2026-10-29",
        missing: false,
        title: "Thursday 29 October 2026",
        stackSvg: '<svg id="generation-mix-compare"></svg>',
        batterySvg: '<svg id="generation-battery-compare"></svg>',
        summary: "Wind made the most.",
      }),
    );
  }) as typeof fetch;
  try {
    const compare = document.querySelector("[data-day-compare]");
    if (!compare) throw new Error("missing compare");
    await loadMix(compare, "2026-10-29");
    expect(urls).toEqual(["/2026/10/29/mix.json"]);
    expect(document.querySelector("#compare-heading")?.textContent).toBe(
      "Thursday 29 October 2026",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed fetch leaves the fallback sentence", async () => {
  const { document } = page();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    await bindDayCompare(document);
    expect(document.querySelector("[data-compare-other]")?.textContent).toBe(
      "That day's mix could not be loaded.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with an open button, nothing loads until the reader asks", async () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div data-compare-root>
      <button type="button" data-compare-open hidden>Compare with another day</button>
      <div data-day-compare hidden>
        <form><select id="compare-day">
          <option value="2026-09-26" selected>Saturday 26 September 2026</option>
        </select></form>
        <h3 id="compare-heading"></h3>
        <p id="compare-summary"></p>
        <div data-compare-other></div>
      </div>
    </div>
  </body></html>`);
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(mix26));
  }) as typeof fetch;
  try {
    await bindDayCompare(document);
    const open = document.querySelector<HTMLButtonElement>(
      "[data-compare-open]",
    );
    expect(open?.hidden).toBe(false);
    expect(urls).toEqual([]);
    expect(
      document.querySelector("[data-day-compare]")?.hasAttribute("hidden"),
    ).toBe(true);
    open?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls).toEqual(["/2026/09/26/mix.json"]);
    expect(open?.hidden).toBe(true);
    expect(
      document.querySelector("[data-day-compare]")?.hasAttribute("hidden"),
    ).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
