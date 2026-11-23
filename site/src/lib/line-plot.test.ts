import { expect, test } from "vitest";
import { type LinePlot, renderLinePlot } from "./line-plot.ts";

const periods = [
  { start: new Date("2026-09-26T12:00:00Z"), title: "00:00 · $10.00" },
  { start: new Date("2026-09-26T12:30:00Z"), title: "00:30 · $20.00" },
  { start: new Date("2026-09-26T13:00:00Z"), title: "01:00 · $30.00" },
];
const ticks = [{ at: periods[0]?.start ?? new Date(), label: "00" }];

function svgOf(plot: LinePlot, summary = "A line of prices."): string {
  return renderLinePlot(plot, { periods, ticks }, summary);
}

function plot(
  lines: LinePlot["lines"],
  extras: Partial<LinePlot> = {},
): LinePlot {
  return {
    id: "test-plot",
    title: "Test plot",
    yLabel: "$/MWh",
    domain: [0, 40],
    lines,
    ...extras,
  };
}

test("the SVG is labelled by its title and summary", () => {
  const svg = svgOf(
    plot([{ id: "OTA", values: [10, 20, 30], colour: "#111", dashed: false }]),
    "Period prices for this day are missing.",
  );
  expect(svg).toContain('id="test-plot-title"');
  expect(svg).toContain('id="test-plot-summary"');
  expect(svg).toContain("Test plot");
  expect(svg).toContain("Period prices for this day are missing.");
  expect(svg).toContain("Hour (New Zealand time)");
  expect(svg).toContain("$/MWh");
});

test("a single valid period between two gaps is drawn as a dot", () => {
  const svg = svgOf(
    plot([
      { id: "BEN", values: [null, 20, null], colour: "#abc", dashed: false },
    ]),
  );
  expect(svg.match(/<circle/g)?.length).toBe(1);
});

test("a connected line has no lone-point dots", () => {
  const svg = svgOf(
    plot([{ id: "OTA", values: [10, 20, 30], colour: "#111", dashed: false }]),
  );
  expect(svg).not.toMatch(/<circle/);
});

test("a proxy period is drawn as an open circle", () => {
  const svg = svgOf(
    plot([
      {
        id: "OTA",
        values: [10, 20, 30],
        colour: "#111",
        dashed: false,
        proxy: [false, true, false],
      },
    ]),
  );
  expect(svg).toContain("var(--color-card)");
  expect(svg.match(/<circle/g)?.length).toBe(1);
});

test("a band is drawn under the line", () => {
  const svg = svgOf(
    plot([{ id: "NI", values: [10, 20, 30], colour: "#111", dashed: false }], {
      bands: [
        {
          start: periods[0]?.start ?? new Date(),
          end: periods[2]?.start ?? new Date(),
          title: "High backup prices, 00:00–01:00",
        },
      ],
    }),
  );
  expect(svg).toContain("High backup prices, 00:00–01:00");
  expect(svg).toMatch(/<rect/i);
});

test("a zero line is drawn when asked", () => {
  const withZero = svgOf(
    plot(
      [{ id: "spread", values: [10, -5, 0], colour: "#111", dashed: false }],
      {
        zeroLine: true,
        domain: [-5, 10],
      },
    ),
  );
  const withoutZero = svgOf(
    plot(
      [{ id: "spread", values: [10, -5, 0], colour: "#111", dashed: false }],
      {
        domain: [-5, 10],
      },
    ),
  );
  expect(withZero.match(/<line/g)?.length).toBeGreaterThan(
    withoutZero.match(/<line/g)?.length ?? 0,
  );
});
