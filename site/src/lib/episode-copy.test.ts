import { expect, test } from "vitest";
import { episodeHeadline } from "./episode-copy.ts";

test("a scarcity-shaped episode names prices, reserves and the North Island", () => {
  expect(
    episodeHeadline({
      observation_types: ["price_high", "reserve_price_high"],
      islands: ["NI"],
      member_count: 2,
    }),
  ).toBe(
    "High wholesale prices and high reserve prices overlapped on the North Island.",
  );
});

test("two islands are named; a singleton does not say overlapped; empty types still make a sentence", () => {
  expect(
    episodeHeadline({
      observation_types: ["separation_high"],
      islands: ["NI", "SI"],
      member_count: 2,
    }),
  ).toBe(
    "A large regional price gap overlapped on the North Island and the South Island.",
  );
  expect(
    episodeHeadline({
      observation_types: ["price_high"],
      islands: ["SI"],
      member_count: 1,
    }),
  ).toBe("High wholesale prices showed up on the South Island.");
  expect(
    episodeHeadline({ observation_types: [], islands: [], member_count: 0 }),
  ).toBe("An unusual stretch showed up.");
});
