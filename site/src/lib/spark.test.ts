import { expect, test } from "vitest";
import { rankTrackSvg, shareBarSvg, sparklineSvg } from "./spark.ts";

const labels = { id: "demo", title: "Demo", summary: "A small chart." };

test("sparkline is empty with no values and a dot with one", () => {
  expect(sparklineSvg([], labels)).toBe("");
  const one = sparklineSvg([1], labels);
  expect(one).toContain("<circle");
  expect(one).not.toContain("<polyline");
  expect(one).toContain('cx="157.0"');
});

test("sparkline marks the last value and labels the image", () => {
  const svg = sparklineSvg([10, 20, 15], labels);
  expect(svg).toContain('role="img"');
  expect(svg).toContain('id="demo-title"');
  expect(svg).toContain('id="demo-summary"');
  expect(svg).toContain("<polyline");
  expect(svg).toContain("<circle");
  expect(svg).not.toMatch(/color-caution|color-invalid/);
});

test("rank track places the mark by percentile, not by a traffic-light colour", () => {
  const low = rankTrackSvg(0, labels);
  const high = rankTrackSvg(1, labels);
  expect(low).toContain('cx="2.0"');
  expect(high).toContain('cx="98.0"');
  expect(low).not.toMatch(/color-caution|color-invalid/);
});

test("share bar splits gas and coal from the rest", () => {
  const svg = shareBarSvg(0.25, labels);
  expect(svg).toContain('width="25.0"');
  expect(svg).toContain("color-fuel-gas");
  expect(svg).toContain("color-rule");
});
