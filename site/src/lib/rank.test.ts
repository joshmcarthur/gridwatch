import { expect, test } from "vitest";
import { rankAgainstHistory } from "./rank.ts";

test("fewer than 30 earlier days is not a rank", () => {
  expect(
    rankAgainstHistory(
      10,
      Array.from({ length: 29 }, (_, i) => i),
    ),
  ).toEqual({ kind: "unknown", reason: "not_enough_days" });
});

test("a value below a quarter of earlier days is lower than most", () => {
  const seq = Array.from({ length: 30 }, (_, i) => i + 1);
  const ranked = rankAgainstHistory(7, seq);
  expect(ranked).toMatchObject({ kind: "ranked", band: "low" });
  if (ranked.kind === "ranked") expect(ranked.percentile).toBeCloseTo(7 / 30);
});

test("a mid-range value is about usual", () => {
  const seq = Array.from({ length: 100 }, (_, i) => i + 1);
  const ranked = rankAgainstHistory(50, seq);
  expect(ranked).toMatchObject({ kind: "ranked", band: "usual" });
});

test("a value at or above three quarters is higher than most", () => {
  const seq = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(rankAgainstHistory(75, seq)).toMatchObject({
    kind: "ranked",
    band: "high",
  });
});

test("a value at or above 95 percent is one of the highest", () => {
  const seq = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(rankAgainstHistory(95, seq)).toMatchObject({
    kind: "ranked",
    band: "highest",
  });
});

test("only the most recent 365 earlier days count", () => {
  const old = Array.from({ length: 365 }, () => 1);
  const recent = Array.from({ length: 365 }, () => 100);
  const ranked = rankAgainstHistory(100, [...old, ...recent]);
  expect(ranked).toMatchObject({ kind: "ranked", band: "highest" });
  if (ranked.kind === "ranked") expect(ranked.percentile).toBe(1);
});
