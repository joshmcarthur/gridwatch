import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import july27 from "../../../site/fixtures/days/2026-07-27.json" with {
  type: "json",
};
import { assertSiteDay, type SiteDay } from "../site/contract.ts";
import { readDayNarrative } from "../site/export-day-narrative.ts";
import {
  buildDayPackage,
  checkDayBudget,
  checkDayText,
  DAY_PROMPT_VERSION,
  daySystemPrompt,
  generateDayNarrative,
  parseDayText,
} from "./day-narrative.ts";

const day: unknown = structuredClone(july27);
assertSiteDay(day);
const july: SiteDay = day;
const pkg = buildDayPackage(july);

const SAMPLE =
  "Ōtāhuhu spiked twice, reaching 330c per kWh at 5:30pm while Benmore stayed far lower. Most of the day's electricity came from hydro, at 69%.";

test("the day package carries each moment with its half-hour prices, not a dispatch maximum", () => {
  expect(pkg.headline).toBe("Ōtāhuhu hit 330c per kWh at 5:30pm");
  const evening = pkg.moments.find((m) => m.title === "Evening price peak");
  expect(evening?.at).toBe("5:30pm");
  expect(evening?.prices).toContainEqual({
    place: "Ōtāhuhu",
    cents: 330,
    dollars_per_mwh: 3296.04,
  });
  expect(evening?.figures).toEqual([330, 57, 820, 340, 140]);
  expect(pkg.totals.cable).toEqual({
    sender: "South Island",
    direction: "north",
    sent_megawatt_hours: 22718,
    arrived_megawatt_hours: 21493,
  });
  expect(pkg.fuel_shares[0]).toEqual({ fuel: "Hydro", percent: 69 });
  // The 27 July fixture's dispatch maximum at Ōtāhuhu is far above any half-hour.
  const max = july.prices.nodes.find(
    (node) => node.point_of_connection === "OTA2201",
  )?.daily.max_price;
  expect(JSON.stringify(pkg)).not.toContain(String(max));
});

test("the number check accepts the package's figures and catches a wrong cents figure", () => {
  expect(checkDayText(SAMPLE, pkg).ok).toBe(true);
  const wrong = checkDayText(SAMPLE.replace("330c", "331c"), pkg);
  expect(wrong.ok).toBe(false);
  expect(wrong.mismatches).toContainEqual({ kind: "number", text: "331c" });
  expect(checkDayText("Ōtāhuhu peaked at 6:30pm.", pkg).ok).toBe(false);
});

test("the budget allows two sentences and three numbers, counting clock times", () => {
  expect(checkDayBudget(SAMPLE)).toMatchObject({
    ok: true,
    sentences: 2,
    numbers: 3,
  });
  expect(checkDayBudget(`${SAMPLE} It was cold.`).ok).toBe(false);
  expect(
    checkDayBudget("Ōtāhuhu hit 330c at 5:30pm and 123c at 7:30am.").ok,
  ).toBe(false);
  expect(checkDayBudget(Array(51).fill("word").join(" ")).ok).toBe(false);
});

test("the day prompt is pinned: a changed prompt without a DAY_PROMPT_VERSION bump fails here", () => {
  expect(DAY_PROMPT_VERSION).toBe(1);
  expect(daySystemPrompt()).toContain(
    "At most 2 sentences and about 40 words.",
  );
  expect(daySystemPrompt()).toContain("# Site copy");
  expect(createHash("sha256").update(daySystemPrompt()).digest("hex")).toBe(
    "c25225e64c43c323898367351dee28273c84e9101adeeb15588730d11ad3fa8f",
  );
});

test("generateDayNarrative sends the package and keeps the model's text", async () => {
  const seen: string[] = [];
  const record = await generateDayNarrative(pkg, {
    complete: async ({ user }) => {
      seen.push(user);
      return `\`\`\`json\n${JSON.stringify({ text: SAMPLE })}\n\`\`\``;
    },
    model: "test/model",
    now: new Date("2026-11-25T01:00:00.000Z"),
    packageId: "abc",
  });
  expect(JSON.parse(seen[0] ?? "{}").trading_date).toBe("2026-07-27");
  expect(record).toMatchObject({
    text: SAMPLE,
    trading_date: "2026-07-27",
    model: "test/model",
    generated_at: "2026-11-25T01:00:00Z",
    prompt_version: 1,
  });
  expect(() => parseDayText("{}")).toThrow("missing text");
});

async function goldWith(text: string): Promise<string> {
  const gold = await mkdtemp(join(tmpdir(), "gw-day-narrative-"));
  await mkdir(join(gold, "narratives", "2026-07-27"), { recursive: true });
  await mkdir(join(gold, "evidence", "2026-07-27"), { recursive: true });
  await writeFile(
    join(gold, "narratives", "2026-07-27", "day.json"),
    JSON.stringify({ text, model: "m", generated_at: "2026-11-25T01:00:00Z" }),
  );
  await writeFile(
    join(gold, "evidence", "2026-07-27", "day.json"),
    JSON.stringify(pkg),
  );
  return gold;
}

test("the export publishes a write-up in budget with what it was written from", async () => {
  const narrative = readDayNarrative(await goldWith(SAMPLE), "2026-07-27");
  expect(narrative).toMatchObject({
    text: SAMPLE,
    cable: true,
    reserve: false,
    incomplete: false,
  });
  expect(narrative?.moments[0]).toEqual({
    title: "Morning price peak",
    when: "7:30am to 8:00am",
  });
});

test("the export leaves over-budget text off the page, and publishes a failed number check", async () => {
  const long = `${SAMPLE} Benmore was cheaper all day.`;
  expect(readDayNarrative(await goldWith(long), "2026-07-27")).toBeNull();
  const wrong = SAMPLE.replace("330c", "331c");
  expect(readDayNarrative(await goldWith(wrong), "2026-07-27")?.text).toBe(
    wrong,
  );
});
