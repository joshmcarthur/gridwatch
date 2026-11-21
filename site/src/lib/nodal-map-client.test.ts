import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
import { bindNodalMap, type NodalMapPayload } from "./nodal-map-client.ts";

const payload: NodalMapPayload = {
  defaultPeriod: 1,
  periods: [
    { period: 1, time: "00:00" },
    { period: 2, time: "00:30" },
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
      <svg><circle data-poc="ALB0331"><title></title></circle></svg>
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
    expect(
      document.querySelector("#nodal-period-label")?.textContent,
    ).toContain("Trading period 2 of 2");
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
