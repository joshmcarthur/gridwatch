import { checkNarrative } from "@gridwatch/publisher/narrative";
import type {
  SiteDay,
  SiteEvent,
  SiteIndex,
} from "@gridwatch/publisher/site-contract";
import { dailyPath } from "./daily-page.ts";
import { episodeHeadline } from "./episode-copy.ts";
import { type LinePlot, type PlotLine, renderLinePlot } from "./line-plot.ts";
import {
  clockLabeller12,
  clockText12,
  timeTicks,
  zonedAt,
} from "./period-clock.ts";
import { NODE_STYLE, type PriceIsland } from "./price-chart.ts";
import { placeName } from "./price-regions.ts";

export const REVIEW_LABEL = "Unreviewed";

export const CONFIDENCE_LEVELS: Array<{
  id: "confirmed" | "strong_evidence" | "possible_explanation";
  label: string;
  meaning: string;
}> = [
  {
    id: "confirmed",
    label: "Confirmed",
    meaning:
      "This figure is in the published market files, or in a public notice.",
  },
  {
    id: "strong_evidence",
    label: "Strong evidence",
    meaning: "More than one observation points the same way.",
  },
  {
    id: "possible_explanation",
    label: "Possible explanation",
    meaning: "Fits the data. Nothing else confirms it on its own.",
  },
];

const money = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function islandColour(island: PriceIsland): string {
  switch (island) {
    case "NI":
      return "var(--color-island-north)";
    case "SI":
      return "var(--color-island-south)";
    default: {
      const unreachable: never = island;
      return unreachable;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function eventPath(date: string, episodeId: string): string {
  return `${dailyPath(date)}events/${episodeId}/`;
}

export function eventsOnDay(day: SiteDay): SiteEvent[] {
  return day.events?.items ?? [];
}

export function findEvent(day: SiteDay, episodeId: string): SiteEvent {
  const event = eventsOnDay(day).find((item) => item.episode_id === episodeId);
  if (!event) {
    throw new Error(`No event ${episodeId} on ${day.trading_date}`);
  }
  return event;
}

export function eventHeadline(
  event: SiteEvent,
  day: Pick<SiteDay, "periods">,
): string {
  return episodeHeadline(
    {
      observation_types: event.observation_types,
      islands: event.islands,
      member_count: event.observation_types.length,
      start_utc: event.start_utc,
      end_utc: event.end_utc,
    },
    day,
  );
}

/** Fail the build when published prose does not match its claims. */
export function requireCheckedEvent(event: SiteEvent): void {
  const result = checkNarrative(
    {
      what_happened: event.what_happened,
      why: event.why,
      what_it_means: event.what_it_means,
    },
    event,
  );
  if (!result.ok) {
    const list = result.mismatches.map((item) => item.text).join(", ");
    throw new Error(`Event ${event.episode_id} failed checkNarrative: ${list}`);
  }
}

export function claimAnchor(id: string): string {
  const safe = id
    .replaceAll("SIR", "sixty-second")
    .replaceAll("FIR", "six-second")
    .replaceAll(".NI.", ".north.")
    .replaceAll(".SI.", ".south.");
  return `claim-${safe}`;
}

export function confidenceLabel(
  level: (typeof CONFIDENCE_LEVELS)[number]["id"],
): string {
  switch (level) {
    case "confirmed":
      return "Confirmed";
    case "strong_evidence":
      return "Strong evidence";
    case "possible_explanation":
      return "Possible explanation";
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

export function claimFigure(claim: SiteEvent["claims"][number]): string {
  if (typeof claim.value === "number" && claim.unit === "$/MWh") {
    return `$${money.format(claim.value)} per megawatt-hour`;
  }
  return `${String(claim.value)} ${claim.unit}`.trim();
}

export function linkClaims(text: string, event: SiteEvent): string {
  let html = escapeHtml(text);
  const replacements = event.claims
    .flatMap((claim) => {
      if (typeof claim.value !== "number") return [];
      const formatted = money.format(claim.value);
      const needles =
        claim.unit === "$/MWh"
          ? claim.value === 0
            ? ["$0"]
            : [`$${formatted}`]
          : [formatted];
      return needles.map((needle) => ({
        needle,
        href: claimAnchor(claim.id),
      }));
    })
    .sort((a, b) => b.needle.length - a.needle.length);
  const used = new Set<string>();
  for (const { needle, href } of replacements) {
    if (used.has(needle)) continue;
    const at = html.indexOf(needle);
    if (at === -1) continue;
    used.add(needle);
    html = `${html.slice(0, at)}<a href="#${escapeHtml(href)}">${needle}</a>${html.slice(at + needle.length)}`;
  }
  const daily = event.daily_page;
  if (daily.length > 0) {
    const at = html.indexOf(daily);
    if (at !== -1) {
      html = `${html.slice(0, at)}<a href="${escapeHtml(daily)}">${daily}</a>${html.slice(at + daily.length)}`;
    }
  }
  return html;
}

export function recentEvents(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
  limit = 8,
): Array<{ date: string; event: SiteEvent }> {
  const found: Array<{ date: string; event: SiteEvent }> = [];
  for (const entry of [...index.days].reverse()) {
    const day = loadDay(entry.date);
    for (const event of eventsOnDay(day)) {
      found.push({ date: entry.date, event });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

export function eventWindowChart(event: SiteEvent): {
  priceSvg: string;
  reserveSvg: string | null;
  headers: string[];
  rows: string[][];
} | null {
  if (event.window.periods.length === 0) return null;
  const stubDay = {
    periods: event.window.periods.map((period, index) => ({
      period,
      start_utc: event.window.start_utc[index] ?? "",
    })),
  };
  const label = clockLabeller12(stubDay);
  const periods = stubDay.periods.map((period, index) => {
    const start = new Date(period.start_utc);
    const time = label(zonedAt(period.start_utc));
    const bits = event.window.prices.map((node) => {
      const value = node.price[index];
      return value === null
        ? `${placeName(node.point_of_connection)}: no data`
        : `${placeName(node.point_of_connection)}: $${money.format(value)}`;
    });
    return { start, title: `${time} · ${bits.join("; ")}` };
  });
  const ticks = timeTicks(stubDay);
  const priceLines: PlotLine[] = event.window.prices.map((node) => {
    const style = NODE_STYLE[node.point_of_connection];
    if (!style) {
      throw new Error(`No chart style for ${node.point_of_connection}`);
    }
    return {
      id: node.point_of_connection,
      values: node.price,
      colour: islandColour(style.island),
      dashed: style.dashed,
    };
  });
  const priceValues = priceLines.flatMap((line) =>
    line.values.filter((value): value is number => value !== null),
  );
  const pricePlot: LinePlot = {
    id: "event-price-chart",
    title: "Wholesale price at three places, this evening",
    yLabel: "Wholesale price ($ per megawatt-hour, $/MWh)",
    domain: [Math.min(0, ...priceValues), Math.max(0, ...priceValues, 1)],
    lines: priceLines,
  };
  const priceSvg = renderLinePlot(
    pricePlot,
    { periods, ticks },
    "Wholesale prices at Ōtāhuhu, Haywards, and Benmore during the evening.",
  );
  const sir = event.window.reserves.find(
    (row) => row.reserve_class === "SIR" && row.island === "NI",
  );
  const reserveValues =
    sir?.price.filter((value): value is number => value !== null) ?? [];
  const reserveSvg =
    sir === undefined || reserveValues.length === 0
      ? null
      : renderLinePlot(
          {
            id: "event-reserve-chart",
            title: "North Island reserve price, this evening",
            yLabel: "Reserve price ($/MWh)",
            domain: [
              Math.min(0, ...reserveValues),
              Math.max(0, ...reserveValues, 1),
            ],
            lines: [
              {
                id: "north-island-reserve",
                values: sir.price,
                colour: "var(--color-island-north)",
                dashed: false,
              },
            ],
          },
          { periods, ticks },
          "North Island 60-second reserve prices during the evening.",
        );
  const headers = [
    "Time",
    ...event.window.prices.map(
      (node) => `${placeName(node.point_of_connection)} $/MWh`,
    ),
  ];
  const rows = stubDay.periods.map((period, index) => [
    clockText12(zonedAt(period.start_utc)),
    ...event.window.prices.map((node) => {
      const value = node.price[index];
      return value === null ? "No data" : money.format(value);
    }),
  ]);
  return { priceSvg, reserveSvg, headers, rows };
}

export function eventPathsForIndex(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
): Array<{
  params: { year: string; month: string; day: string; id: string };
}> {
  const paths: Array<{
    params: { year: string; month: string; day: string; id: string };
  }> = [];
  for (const entry of index.days) {
    const [year, month, day] = entry.date.split("-");
    if (!year || !month || !day) {
      throw new Error(`Index day ${entry.date} is not YYYY-MM-DD`);
    }
    for (const event of eventsOnDay(loadDay(entry.date))) {
      paths.push({ params: { year, month, day, id: event.episode_id } });
    }
  }
  return paths;
}
