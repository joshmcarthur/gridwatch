import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import july27 from "../../../site/fixtures/days/2026-07-27.json" with {
  type: "json",
};
import september26 from "../../../site/fixtures/days/2026-09-26.json" with {
  type: "json",
};
import september27 from "../../../site/fixtures/days/2026-09-27.json" with {
  type: "json",
};
import { assertSiteDay, type SiteDay } from "../site/contract.ts";
import { readWeekNarrative } from "../site/export-day-narrative.ts";
import {
  buildWeekPackage,
  checkWeekText,
  WEEK_PROMPT_VERSION,
  weekSystemPrompt,
} from "./week-narrative.ts";

const days: SiteDay[] = [july27, september26, september27].map((json) => {
  const day: unknown = structuredClone(json);
  assertSiteDay(day);
  return day;
});
const pkg = buildWeekPackage(days);

test("the week package cuts each day to its headline, averages, highest moment and unusual stretches", () => {
  expect(pkg.from).toBe("2026-07-27");
  expect(pkg.to).toBe("2026-09-27");
  const monday = pkg.days[0];
  expect(monday?.weekday).toBe("Monday");
  expect(monday?.highest).toEqual({
    title: "Evening price peak",
    at: "5:30pm",
    cents: 330,
  });
  expect(monday?.fuel_shares).toHaveLength(3);
  expect(monday?.fuel_shares[0]).toEqual({ fuel: "Hydro", percent: 69 });
  expect(monday?.otahuhu_average_cents).toBeGreaterThan(0);
  expect(pkg.days[2]?.unusual).toContain("high reserve prices");
});

test("the week check accepts the package's figures and catches others", () => {
  const ok = `The week opened with Ōtāhuhu at 330c per kWh on Monday evening, while hydro made 69% of that day's electricity.`;
  expect(checkWeekText(ok, pkg).ok).toBe(true);
  expect(checkWeekText(ok.replace("69%", "70%"), pkg).ok).toBe(false);
});

test("the week prompt is pinned: a changed prompt without a WEEK_PROMPT_VERSION bump fails here", () => {
  expect(WEEK_PROMPT_VERSION).toBe(2);
  expect(weekSystemPrompt()).toContain("Use weekday names, not dates.");
  expect(createHash("sha256").update(weekSystemPrompt()).digest("hex")).toBe(
    "9d5c383a9fd09748de561db7ce0322e05cff50eeccea89d6b1ea66790eb05a91",
  );
});

async function goldWith(text: string, to = pkg.to): Promise<string> {
  const gold = await mkdtemp(join(tmpdir(), "gw-week-"));
  await mkdir(join(gold, "narratives", "week"), { recursive: true });
  await mkdir(join(gold, "evidence", "week"), { recursive: true });
  await writeFile(
    join(gold, "narratives", "week", `${to}.json`),
    JSON.stringify({ text, model: "m", generated_at: "2026-11-25T01:00:00Z" }),
  );
  await writeFile(
    join(gold, "evidence", "week", `${to}.json`),
    JSON.stringify({
      ...pkg,
      days: pkg.days.map((day, at) => ({ ...day, incomplete: at === 1 })),
    }),
  );
  return gold;
}

test("the index carries the week paragraph for the latest day only, and drops over-budget text", async () => {
  const text = "Ōtāhuhu reached 330c per kWh on Monday evening.";
  expect(readWeekNarrative(await goldWith(text), "2026-09-27")).toMatchObject({
    text,
    from: "2026-07-27",
    to: "2026-09-27",
    incomplete_days: ["2026-09-26"],
  });
  expect(readWeekNarrative(await goldWith(text), "2026-09-28")).toBeNull();
  const long = `${text} It was cold. It was windy.`;
  expect(readWeekNarrative(await goldWith(long), "2026-09-27")).toBeNull();
});
