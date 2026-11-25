import { centsPerKwh } from "@gridwatch/publisher/story/price-regions.ts";
import {
  type Lane,
  laneCentreShare,
  laneIndexAt,
  tooltipRows,
} from "./day-lanes.ts";
import {
  cableLabels,
  cableWidth,
  DOT_RADIUS,
  formatPrice,
  isOutlier,
  type NodalMapIsland,
  type NodalMapPayload,
  type NodalMapRow,
  OUTLIER_RADIUS,
  periodSummary,
  priceBandFill,
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

const megawatts = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });

/** Steps per second when Play animates the day. */
const PLAY_INTERVAL_MS = 250;

function paintMap(
  root: ParentNode,
  payload: NodalMapPayload,
  period: number,
): void {
  const i = period - 1;
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
    circle.setAttribute("fill", priceBandFill(price));
    circle.setAttribute("r", String(outlier ? OUTLIER_RADIUS : DOT_RADIUS));
    const title = circle.querySelector("title");
    if (title) {
      title.textContent = `${poc?.point_of_connection ?? ""}, ${formatPrice(price)} dollars per megawatt-hour`;
    }
  }
  for (const place of payload.places ?? []) {
    const label = root.querySelector(
      `[data-place="${place.point_of_connection}"] [data-place-price]`,
    );
    const price = place.prices[i] ?? null;
    if (label)
      label.textContent = price === null ? "No data" : centsPerKwh(price);
  }
}

/** Turn and resize the cable arrow for the half-hour, when the day has half-hourly flow. */
function paintCable(
  root: ParentNode,
  flow: Array<number | null> | null | undefined,
  period: number,
): void {
  const path = root.querySelector<SVGPathElement>("[data-cable-path]");
  if (!flow || !path) return;
  const group = path.closest("g");
  const megawatts = flow[period - 1] ?? null;
  if (group) group.toggleAttribute("hidden", megawatts === null);
  if (megawatts === null) return;
  const d = megawatts >= 0 ? path.dataset.north : path.dataset.south;
  if (d) path.setAttribute("d", d);
  path.setAttribute("stroke-width", cableWidth(megawatts).toFixed(1));
  const labels = cableLabels(megawatts);
  const label = root.querySelector('[data-cable-line="0"]');
  const amount = root.querySelector('[data-cable-line="1"]');
  if (label) label.textContent = labels.label;
  if (amount) amount.textContent = labels.amount;
}

function paintIslands(
  root: ParentNode,
  islands: NodalMapIsland[],
  period: number,
): void {
  const i = period - 1;
  for (const island of islands) {
    const box = root.querySelector(`[data-island="${island.key}"]`);
    if (!box) continue;
    const values = island.fuels.map((fuel) => fuel.megawatts[i] ?? null);
    const known = values.filter((value): value is number => value !== null);
    const total = known.reduce((sum, value) => sum + value, 0);
    const totalNode = box.querySelector("[data-island-total]");
    if (totalNode) {
      totalNode.textContent =
        known.length === 0
          ? "No numbers for this half-hour"
          : `${megawatts.format(total)} MW generating`;
    }
    island.fuels.forEach((fuel, index) => {
      const value = values[index] ?? null;
      const share = value !== null && total > 0 ? (value / total) * 100 : 0;
      const segment = box.querySelector<HTMLElement>(
        `[data-segment="${fuel.fuel}"]`,
      );
      if (segment) segment.style.flexBasis = `${share.toFixed(2)}%`;
      const item = box.querySelector<HTMLElement>(`[data-fuel="${fuel.fuel}"]`);
      if (item) {
        item.hidden = value === null || value < 1;
        const amount = item.querySelector("[data-fuel-mw]");
        if (amount) {
          amount.textContent =
            value === null ? "" : `${megawatts.format(value)} MW`;
        }
      }
    });
  }
}

/** Dim every fuel the active beat does not name, in the lane, its key and the island bars. */
function paintFuels(root: ParentNode, lit: string[] | null): void {
  for (const node of root.querySelectorAll<Element>(
    "[data-lane-fuel], [data-legend-fuel], [data-segment], [data-fuel]",
  )) {
    const fuel =
      node.getAttribute("data-lane-fuel") ??
      node.getAttribute("data-legend-fuel") ??
      node.getAttribute("data-segment") ??
      node.getAttribute("data-fuel") ??
      "";
    node.classList.toggle("dim", lit !== null && !lit.includes(fuel));
  }
}

function moveLine(line: SVGLineElement, share: number, svg: SVGSVGElement) {
  const width = Number(svg.getAttribute("viewBox")?.split(" ")[2] ?? 0);
  const x = (share * width).toFixed(1);
  line.setAttribute("x1", x);
  line.setAttribute("x2", x);
}

function fillTip(
  doc: Document,
  tip: HTMLElement,
  lane: Lane,
  index: number,
  time: string,
): void {
  const heading = doc.createElement("p");
  heading.className = "lane-tip-time";
  heading.textContent = time;
  const list = doc.createElement("ul");
  for (const row of tooltipRows(lane, index)) {
    const item = doc.createElement("li");
    if (row.colour) {
      const swatch = doc.createElement("span");
      swatch.className = "swatch";
      swatch.setAttribute("style", `background:${row.colour}`);
      item.append(swatch);
    }
    const label = doc.createElement("span");
    label.textContent = `${row.label} `;
    const value = doc.createElement("strong");
    value.textContent = row.value;
    item.append(label, value);
    if (row.note) {
      const note = doc.createElement("span");
      note.className = "lane-tip-note";
      note.textContent = ` ${row.note}`;
      item.append(note);
    }
    list.append(item);
  }
  tip.replaceChildren(heading, list);
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
        row.proxy ? "Copied from a nearby place" : "",
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

/**
 * Slider, recolour, beats, island bars, play and table sort for the story map. No network
 * calls. The page works without this script: it shows the opening half-hour and every beat.
 */
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
  const container = root.querySelector<HTMLElement>("[data-nodal-map]");
  container?.setAttribute("data-js", "");
  const beats = payload.beats ?? [];
  const beatItems = [...root.querySelectorAll<HTMLElement>("[data-beat]")];
  const play = root.querySelector<HTMLButtonElement>("#nodal-play");
  const count = payload.periods.length;
  const reduceMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  let period = payload.defaultPeriod;
  let chosen: number | null = null;
  let column: SortColumn = "point_of_connection";
  let dir: "asc" | "desc" = "asc";
  let timer: ReturnType<typeof setInterval> | null = null;

  const activeBeat = (): number => {
    if (chosen !== null) {
      const beat = beats[chosen];
      if (beat && period >= beat.from && period <= beat.to) return chosen;
    }
    return beats.findIndex(
      (beat) =>
        !(beat.from === 1 && beat.to === count) &&
        period >= beat.from &&
        period <= beat.to,
    );
  };

  const paint = () => {
    paintMap(root, payload, period);
    paintIslands(root, payload.islands ?? [], period);
    paintCable(root, payload.cable, period);
    const clock =
      payload.periods.find((item) => item.period === period)?.time ?? "";
    if (output) output.textContent = clock;
    slider.setAttribute("aria-valuetext", clock);
    if (summary) summary.textContent = periodSummary(payload, period);
    const svgSummary = root.querySelector("#nodal-map-chart-summary");
    if (svgSummary) svgSummary.textContent = periodSummary(payload, period);
    for (const svg of root.querySelectorAll<SVGSVGElement>("[data-lane-svg]")) {
      const line = svg.querySelector<SVGLineElement>("[data-lane-cursor]");
      const plotWidth = Number(svg.dataset.plotWidth) || undefined;
      if (line)
        moveLine(line, laneCentreShare(period - 1, count, plotWidth), svg);
    }
    const active = activeBeat();
    const fuels = beats[active]?.fuels;
    paintFuels(root, active >= 0 && fuels && fuels.length > 0 ? fuels : null);
    beatItems.forEach((item, index) => {
      const on = index === active;
      item.classList.toggle("active", on);
      item
        .querySelector("button")
        ?.setAttribute("aria-pressed", on ? "true" : "false");
    });
    renderTable(
      doc,
      tbody,
      sortRows(rowsForPeriod(payload, period), column, dir),
    );
    setSortButtons(root, column, dir);
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (play) {
      play.textContent = "Play the day";
      play.setAttribute("aria-pressed", "false");
    }
  };

  const goTo = (next: number) => {
    period = Math.min(count, Math.max(1, next));
    slider.value = String(period);
    paint();
  };

  slider.addEventListener("input", () => {
    stop();
    chosen = null;
    goTo(Number(slider.value));
  });

  beatItems.forEach((item, index) => {
    item.querySelector("button")?.addEventListener("click", () => {
      stop();
      chosen = index;
      goTo(beats[index]?.at ?? period);
    });
  });

  play?.addEventListener("click", () => {
    if (timer !== null) {
      stop();
      return;
    }
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    chosen = null;
    if (reduceMotion) {
      // Step from beat to beat instead of animating every half-hour.
      const stops = beats
        .map((beat, index) => ({ at: beat.at, index }))
        .filter(({ index }) => {
          const beat = beats[index];
          return beat && !(beat.from === 1 && beat.to === count);
        })
        .sort((a, b) => a.at - b.at);
      let k = stops.findIndex((item) => item.at > period);
      if (k === -1) k = 0;
      const step = () => {
        const next = stops[k];
        if (!next) return stop();
        chosen = next.index;
        goTo(next.at);
        k += 1;
      };
      step();
      timer = setInterval(step, 2500);
      return;
    }
    if (period >= count) goTo(1);
    timer = setInterval(() => {
      if (period >= count) return stop();
      goTo(period + 1);
    }, PLAY_INTERVAL_MS);
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
  const lanes = payload.lanes ?? [];
  const timeOf = (index: number) => payload.periods[index]?.time ?? "";
  for (const plot of root.querySelectorAll<HTMLElement>("[data-lane]")) {
    const lane = lanes.find((item) => item.id === plot.dataset.lane);
    const svg = plot.querySelector<SVGSVGElement>("[data-lane-svg]");
    const tip = plot.querySelector<HTMLElement>("[data-lane-tip]");
    const hover = svg?.querySelector<SVGLineElement>("[data-lane-hover]");
    if (!lane || !svg || !tip) continue;
    const plotWidth = Number(svg.dataset.plotWidth) || undefined;
    const show = (index: number) => {
      fillTip(doc, tip, lane, index, timeOf(index));
      const share = laneCentreShare(index, count, plotWidth);
      tip.hidden = false;
      tip.style.left = `${(share * 100).toFixed(1)}%`;
      tip.classList.toggle("flip", share > 0.55);
      if (hover) {
        moveLine(hover, share, svg);
        hover.setAttribute("visibility", "visible");
      }
    };
    const hide = () => {
      tip.hidden = true;
      hover?.setAttribute("visibility", "hidden");
    };
    const indexAt = (clientX: number) => {
      const box = svg.getBoundingClientRect();
      return laneIndexAt(
        box.width > 0 ? (clientX - box.left) / box.width : 0,
        count,
        plotWidth,
      );
    };
    svg.addEventListener("pointermove", (event) =>
      show(indexAt(event.clientX)),
    );
    svg.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") hide();
    });
    svg.addEventListener("click", (event) => {
      const index = indexAt(event.clientX);
      stop();
      chosen = null;
      goTo(index + 1);
      show(index);
    });
    plot.addEventListener("focus", () => show(period - 1));
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (event.key === "Escape") {
        hide();
        return;
      }
      if (step === 0) return;
      event.preventDefault();
      stop();
      chosen = null;
      goTo(period + step);
      show(period - 1);
    });
  }
  paint();
}
