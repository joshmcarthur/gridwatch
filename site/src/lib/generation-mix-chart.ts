import type { SiteDay } from "@gridwatch/publisher/site-contract";
import * as Plot from "@observablehq/plot";
import { type ChartLabels, renderPlot } from "./chart-svg.ts";
import {
  batteryPointTitle,
  type GenerationMix,
  generationMix,
  generationMixBatterySummary,
  generationMixSummary,
  type MixPoint,
  mixPointTitle,
  type StackFuel,
} from "./generation-mix.ts";
import { formatTradingDate } from "./site-data.ts";

/** Fuel colours come from the Landscape tokens in tokens.css (ADR-0015). */
export const FUEL_COLOUR: Record<StackFuel, string> = {
  hydro: "var(--color-fuel-hydro)",
  geothermal: "var(--color-fuel-geothermal)",
  wind: "var(--color-fuel-wind)",
  solar: "var(--color-fuel-solar)",
  gas: "var(--color-fuel-gas)",
  coal_gas: "var(--color-fuel-coal-gas)",
  other: "var(--color-fuel-other)",
  unmapped: "var(--color-fuel-unmapped)",
};

export const BATTERY_COLOUR = "var(--color-fuel-battery)";

export type MixComparePayload =
  | { date: string; missing: true }
  | {
      date: string;
      missing: false;
      title: string;
      stackSvg: string;
      batterySvg: string;
      summary: string;
    };

function timeAxis(data: GenerationMix) {
  const labelAt = new Map(
    data.ticks.map((tick) => [tick.at.getTime(), tick.label]),
  );
  return {
    label: "Hour (New Zealand time)",
    domain: [data.points[0]?.start, data.points.at(-1)?.start],
    nice: false as const,
    ticks: data.ticks.map((tick) => tick.at),
    tickFormat: (value: Date) => labelAt.get(value.getTime()) ?? "",
  };
}

function hoverRules(data: GenerationMix, titleOf: (point: MixPoint) => string) {
  return Plot.ruleX(
    data.points.map((point) => ({
      start: point.start,
      title: titleOf(point),
    })),
    { x: "start", stroke: "transparent", strokeWidth: 8, title: "title" },
  );
}

export function mixStackSvg(mix: GenerationMix, labels: ChartLabels): string {
  return renderPlot(
    {
      x: timeAxis(mix),
      y: { label: "Average megawatts (MW)", grid: true },
      color: {
        domain: mix.layers.map((layer) => layer.fuel),
        range: mix.layers.map((layer) => FUEL_COLOUR[layer.fuel]),
      },
      marks: [
        Plot.areaY(mix.areas, {
          x: "start",
          y1: "base",
          y2: "top",
          fill: "fuel",
          stroke: "var(--color-card)",
          strokeWidth: 1,
        }),
        hoverRules(mix, (point) => mixPointTitle(point, mix.layers)),
      ],
    },
    labels,
  );
}

export function mixBatterySvg(mix: GenerationMix, labels: ChartLabels): string {
  return renderPlot(
    {
      height: 120,
      x: timeAxis(mix),
      y: { label: "Battery (MW)", grid: true },
      marks: [
        Plot.areaY(mix.battery, {
          x: "start",
          y: "megawatts",
          fill: BATTERY_COLOUR,
          stroke: "var(--color-card)",
          strokeWidth: 1,
        }),
        hoverRules(mix, batteryPointTitle),
      ],
    },
    labels,
  );
}

export function mixComparePayload(day: SiteDay): MixComparePayload {
  const mix = generationMix(day);
  if (mix === null) {
    return { date: day.trading_date, missing: true };
  }
  const title = formatTradingDate(day.trading_date);
  return {
    date: day.trading_date,
    missing: false,
    title,
    stackSvg: mixStackSvg(mix, {
      id: "generation-mix-compare",
      title: `Generation mix by fuel, ${title}`,
      summary: generationMixSummary(mix),
    }),
    batterySvg: mixBatterySvg(mix, {
      id: "generation-battery-compare",
      title: `Battery (stored power), ${title}`,
      summary: generationMixBatterySummary(mix),
    }),
    summary: generationMixSummary(mix),
  };
}
