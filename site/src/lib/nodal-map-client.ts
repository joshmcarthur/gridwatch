import {
  DOT_RADIUS,
  formatPrice,
  isOutlier,
  type NodalMapPayload,
  type NodalMapRow,
  OUTLIER_RADIUS,
  periodSummary,
  priceFill,
  rowsForPeriod,
  sortRows,
} from "./nodal-map-scale.ts";

export type { NodalMapPayload };

type SortColumn =
  | "point_of_connection"
  | "location"
  | "island"
  | "price"
  | "outlier";

function paintMap(
  root: ParentNode,
  payload: NodalMapPayload,
  period: number,
): void {
  const i = period - 1;
  const min = payload.min[i] ?? null;
  const max = payload.max[i] ?? null;
  const p05 = payload.p05[i] ?? null;
  const p95 = payload.p95[i] ?? null;
  const byPoc = new Map(
    payload.pocs.map((poc) => [poc.point_of_connection, poc]),
  );
  for (const circle of root.querySelectorAll<SVGCircleElement>(
    "circle[data-poc]",
  )) {
    const poc = byPoc.get(circle.dataset.poc ?? "");
    const price = poc?.prices[i] ?? null;
    const outlier = isOutlier(price, p05, p95);
    circle.setAttribute("fill", priceFill(price, min, max));
    circle.setAttribute("r", String(outlier ? OUTLIER_RADIUS : DOT_RADIUS));
    const title = circle.querySelector("title");
    if (title) {
      title.textContent = `${poc?.point_of_connection ?? ""}, ${formatPrice(price)} dollars per megawatt-hour`;
    }
  }
}

function documentOf(root: ParentNode): Document {
  if ("createElement" in root) return root as Document;
  return (root as Element).ownerDocument;
}

function renderTable(
  doc: Document,
  tbody: HTMLTableSectionElement,
  rows: NodalMapRow[],
): void {
  tbody.replaceChildren(
    ...rows.map((row) => {
      const tr = doc.createElement("tr");
      const name = doc.createElement("th");
      name.scope = "row";
      name.textContent = row.point_of_connection;
      const location = doc.createElement("td");
      location.textContent = row.location;
      const island = doc.createElement("td");
      island.textContent = row.island;
      const price = doc.createElement("td");
      price.textContent = formatPrice(row.price);
      const note = doc.createElement("td");
      note.textContent = [
        row.outlier ? "Large difference" : "",
        row.proxy ? "Proxy price" : "",
      ]
        .filter(Boolean)
        .join(". ");
      tr.append(name, location, island, price, note);
      return tr;
    }),
  );
}

function setSortButtons(
  root: ParentNode,
  column: SortColumn,
  dir: "asc" | "desc",
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-sort]",
  )) {
    const key = button.dataset.sort as SortColumn;
    const header = button.closest("th");
    if (!header) continue;
    if (key === column) {
      header.setAttribute(
        "aria-sort",
        dir === "asc" ? "ascending" : "descending",
      );
    } else {
      header.removeAttribute("aria-sort");
    }
  }
}

/** Slider, recolour, and table sort for the nodal map page. No network calls. */
export function bindNodalMap(root: ParentNode = document): void {
  const payloadNode = root.querySelector("#nodal-map-payload");
  if (!payloadNode?.textContent) return;
  const payload = JSON.parse(payloadNode.textContent) as NodalMapPayload;
  const slider = root.querySelector<HTMLInputElement>("#nodal-period");
  const output = root.querySelector("#nodal-period-label");
  const summary = root.querySelector("#nodal-map-live-summary");
  const tbody = root.querySelector<HTMLTableSectionElement>(
    "#nodal-map-table tbody",
  );
  if (!slider || !tbody) return;
  const doc = documentOf(root);

  let period = payload.defaultPeriod;
  let column: SortColumn = "point_of_connection";
  let dir: "asc" | "desc" = "asc";

  const paint = () => {
    paintMap(root, payload, period);
    const clock =
      payload.periods.find((item) => item.period === period)?.time ?? "";
    if (output) {
      output.textContent = `Trading period ${period} of ${payload.periods.length}, starting ${clock}`;
    }
    if (summary) summary.textContent = periodSummary(payload, period);
    const svgSummary = root.querySelector("#nodal-map-chart-summary");
    if (svgSummary) svgSummary.textContent = periodSummary(payload, period);
    renderTable(
      doc,
      tbody,
      sortRows(rowsForPeriod(payload, period), column, dir),
    );
    setSortButtons(root, column, dir);
  };

  slider.addEventListener("input", () => {
    period = Number(slider.value);
    paint();
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-sort]",
  )) {
    button.addEventListener("click", () => {
      const next = button.dataset.sort as SortColumn;
      if (column === next) dir = dir === "asc" ? "desc" : "asc";
      else {
        column = next;
        dir = next === "price" || next === "outlier" ? "desc" : "asc";
      }
      paint();
    });
  }
  paint();
}
