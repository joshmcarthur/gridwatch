import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { bindNodalMap, type NodalMapPayload } from "./nodal-map-client.ts";

const payload: NodalMapPayload = {
  defaultPeriod: 1,
  periods: [
    { period: 1, time: "12:00am" },
    { period: 2, time: "12:30am" },
  ],
  places: [{ point_of_connection: "OTA2201", prices: [690, 33] }],
  beats: [
    { at: 2, from: 2, to: 2 },
    { at: 1, from: 1, to: 2 },
  ],
  islands: [
    {
      key: "north",
      fuels: [
        { fuel: "hydro", label: "Hydro", colour: "red", megawatts: [300, 100] },
        { fuel: "gas", label: "Gas", colour: "grey", megawatts: [100, 0] },
      ],
    },
  ],
  p05: [40, 40],
  p95: [90, 90],
  min: [30, 30],
  max: [200, 80],
  pocs: [
    {
      point_of_connection: "ALB0331",
      island: "North Island",
      prices: [200, 50],
      proxy_periods: [],
    },
  ],
  unlocated: [
    {
      point_of_connection: "HAY2201",
      island: "North Island",
      prices: [50, 50],
      proxy_periods: [1],
    },
  ],
};

function page() {
  return parseHTML(`<!doctype html><html><body>
    <div data-nodal-map>
      <input id="nodal-period" type="range" min="1" max="2" value="1" />
      <p id="nodal-period-label"></p>
      <p id="nodal-map-live-summary"></p>
      <svg><circle data-poc="ALB0331"><title></title></circle>
        <g data-place="OTA2201"><text data-place-price></text></g></svg>
      <ol>
        <li data-beat="0"><button type="button">Peak</button><p>One</p></li>
        <li data-beat="1"><button type="button">Cable</button><p>Two</p></li>
      </ol>
      <section data-island="north">
        <span data-island-total></span>
        <div><span data-segment="hydro"></span><span data-segment="gas"></span></div>
        <ul><li data-fuel="hydro"><span data-fuel-mw></span></li><li data-fuel="gas"><span data-fuel-mw></span></li></ul>
      </section>
      <table id="nodal-map-table">
        <thead>
          <tr>
            <th><button type="button" data-sort="point_of_connection">Place</button></th>
            <th><button type="button" data-sort="price">Price</button></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <script type="application/json" id="nodal-map-payload">${JSON.stringify(payload)}</script>
    </div>
  </body></html>`);
}

test("the slider recolours the existing dots and does not fetch", () => {
  const { document, Event } = page();
  const fetches: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    throw new Error("the map must not fetch");
  }) as typeof fetch;
  try {
    bindNodalMap(document);
    const circle = document.querySelector("circle[data-poc]");
    expect(circle?.getAttribute("r")).toBe("5.5");
    const slider = document.querySelector<HTMLInputElement>("#nodal-period");
    if (!slider) throw new Error("missing slider");
    slider.value = "2";
    slider.dispatchEvent(new Event("input"));
    expect(circle?.getAttribute("r")).toBe("3.5");
    expect(document.querySelector("#nodal-period-label")?.textContent).toBe(
      "12:30am",
    );
    expect(slider.getAttribute("aria-valuetext")).toBe("12:30am");
    expect(fetches).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clicking a sort header reorders the table", () => {
  const { document } = page();
  bindNodalMap(document);
  const names = () =>
    [...document.querySelectorAll("#nodal-map-table tbody th")].map(
      (cell) => cell.textContent,
    );
  expect(names()).toEqual(["ALB0331", "HAY2201"]);
  const price = document.querySelector<HTMLButtonElement>(
    '[data-sort="price"]',
  );
  if (!price) throw new Error("missing price sort");
  price.click();
  expect(names()).toEqual(["ALB0331", "HAY2201"]);
  price.click();
  expect(names()).toEqual(["HAY2201", "ALB0331"]);
});

test("a beat button moves the map to its moment and marks it active", () => {
  const { document } = page();
  bindNodalMap(document);
  const price = () =>
    document.querySelector("[data-place-price]")?.textContent ?? "";
  expect(price()).toBe("69c");
  const first = document.querySelector<HTMLButtonElement>(
    '[data-beat="0"] button',
  );
  first?.click();
  expect(document.querySelector<HTMLInputElement>("#nodal-period")?.value).toBe(
    "2",
  );
  expect(price()).toBe("3.3c");
  expect(first?.getAttribute("aria-pressed")).toBe("true");
  expect(
    document.querySelector('[data-beat="0"]')?.classList.contains("active"),
  ).toBe(true);
});

test("the island bars follow the slider", () => {
  const { document, Event } = page();
  bindNodalMap(document);
  const total = () =>
    document.querySelector("[data-island-total]")?.textContent ?? "";
  const gas = document.querySelector<HTMLElement>('[data-fuel="gas"]');
  expect(total()).toBe("400 MW generating");
  expect(gas?.hidden).toBe(false);
  const slider = document.querySelector<HTMLInputElement>("#nodal-period");
  if (!slider) throw new Error("missing slider");
  slider.value = "2";
  slider.dispatchEvent(new Event("input"));
  expect(total()).toBe("100 MW generating");
  expect(gas?.hidden).toBe(true);
  expect(
    document.querySelector<HTMLElement>('[data-segment="hydro"]')?.style
      .flexBasis,
  ).toBe("100.00%");
});
