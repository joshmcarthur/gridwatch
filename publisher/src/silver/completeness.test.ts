import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { PublisherDataset } from "../datasets.ts";
import { runPublish } from "../runner.ts";
import {
  completenessPath,
  completenessStatusLines,
  readCompleteness,
} from "./completeness.ts";

const DISPATCH = "dispatch_energy_prices";
const fixtures = join(
  import.meta.dirname,
  "fixtures",
  "dispatch-energy-prices",
);

let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-completeness-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Store `csv` in bronze the way the collector does, and add its manifest record. */
async function archive(dataset: string, dates: string[], csv: string) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const path = `${dataset}/${sha256}/${dates[0]?.replaceAll("-", "")}_file.csv`;
  await mkdir(join(bronzeDir, dataset, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({ dataset, status: "new", retrieved_at: "2026-11-20T00:00:01.000Z", sha256, path, trading_dates: dates })}\n`,
  );
  return sha256;
}

const fixture = (date: string) =>
  readFile(
    join(fixtures, `${date.replaceAll("-", "")}_DispatchEnergyPrices.csv`),
    "utf8",
  );
const partition = (date: string) =>
  join(silverDir, DISPATCH, `trading_date=${date}`, "data.parquet");
const run = (options: Partial<Parameters<typeof runPublish>[0]> = {}) =>
  runPublish({
    bronzeDir,
    silverDir,
    goldDir,
    only: [DISPATCH],
    ...options,
  });

test("records complete days, including a 46-period DST day, and a gap day stays missing", async () => {
  const sha27 = await archive(
    DISPATCH,
    ["2026-09-27"],
    await fixture("2026-09-27"),
  );
  const sha18 = await archive(
    DISPATCH,
    ["2026-11-18"],
    await fixture("2026-11-18"),
  );
  await run();

  const dst = await readCompleteness(silverDir, DISPATCH, "2026-09-27");
  expect(dst).toMatchObject({
    status: "complete",
    expectedPeriodCount: 46,
    actualPeriodCount: 46,
    missingPeriods: [],
    bronzeSha256s: [sha27],
    sourcePublishedAt: null,
    errors: [],
  });
  expect(dst.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  expect(
    await readCompleteness(silverDir, DISPATCH, "2026-11-18"),
  ).toMatchObject({
    status: "complete",
    expectedPeriodCount: 48,
    actualPeriodCount: 48,
    missingPeriods: [],
    bronzeSha256s: [sha18],
  });

  // 2025-09-11 to 2025-10-02 have no bronze. 28 Sep 2025 is the DST start inside that gap.
  expect(
    await readCompleteness(silverDir, DISPATCH, "2025-09-11"),
  ).toMatchObject({
    status: "missing",
    expectedPeriodCount: 48,
    actualPeriodCount: 0,
    bronzeSha256s: [],
    processedAt: null,
    errors: [],
  });
  expect(
    await readCompleteness(silverDir, DISPATCH, "2025-09-28"),
  ).toMatchObject({
    status: "missing",
    expectedPeriodCount: 46,
    actualPeriodCount: 0,
    processedAt: null,
  });

  const lines = await completenessStatusLines(silverDir);
  expect(lines[0]).toBe(`${DISPATCH}: latest complete 2026-11-18`);
  expect(lines).toContain("generation_md: latest complete none");
  expect(lines.some((line) => line.startsWith("gold_generation:"))).toBe(false);
  expect(lines.some((line) => line.startsWith("gold_prices:"))).toBe(false);
  expect(lines.some((line) => line.startsWith("gold_reserves:"))).toBe(false);

  const table = completenessPath(silverDir);
  const mtime = (await stat(table)).mtimeMs;
  const september = await readCompleteness(silverDir, DISPATCH, "2026-09-27");
  await run();
  expect((await stat(table)).mtimeMs).toBe(mtime);
  expect(await readCompleteness(silverDir, DISPATCH, "2026-09-27")).toEqual(
    september,
  );

  // A ranged republish rewrites November and keeps the September row.
  await run({ range: { from: "2026-11-01", to: "2026-11-30" }, force: true });
  expect(await readCompleteness(silverDir, DISPATCH, "2026-09-27")).toEqual(
    september,
  );
  expect(
    await readCompleteness(silverDir, DISPATCH, "2026-11-18"),
  ).toMatchObject({
    status: "complete",
    expectedPeriodCount: 48,
    actualPeriodCount: 48,
  });
});

test("a partial day records the missing periods, and a deleted table is rebuilt from silver", async () => {
  await archive(DISPATCH, ["2026-09-27"], await fixture("2026-09-27"));
  const lines = (await fixture("2026-11-18")).trimEnd().split("\n");
  const kept = lines.filter(
    (line) =>
      !line.startsWith("2026-11-18,24,") && !line.startsWith("2026-11-18,25,"),
  );
  await archive(DISPATCH, ["2026-11-18"], `${kept.join("\n")}\n`);
  await run();

  expect(
    await readCompleteness(silverDir, DISPATCH, "2026-11-18"),
  ).toMatchObject({
    status: "partial",
    expectedPeriodCount: 48,
    actualPeriodCount: 46,
    missingPeriods: [24, 25],
  });
  const linesOut = await completenessStatusLines(silverDir);
  expect(linesOut[0]).toBe(`${DISPATCH}: latest complete 2026-09-27`);

  const dstMtime = (await stat(partition("2026-09-27"))).mtimeMs;
  const partialMtime = (await stat(partition("2026-11-18"))).mtimeMs;
  await rm(completenessPath(silverDir));
  await run();
  expect((await stat(partition("2026-09-27"))).mtimeMs).toBe(dstMtime);
  expect((await stat(partition("2026-11-18"))).mtimeMs).toBe(partialMtime);
  expect(
    await readCompleteness(silverDir, DISPATCH, "2026-09-27"),
  ).toMatchObject({
    status: "complete",
    expectedPeriodCount: 46,
    actualPeriodCount: 46,
    missingPeriods: [],
  });
  expect(
    await readCompleteness(silverDir, DISPATCH, "2026-11-18"),
  ).toMatchObject({
    status: "partial",
    expectedPeriodCount: 48,
    actualPeriodCount: 46,
    missingPeriods: [24, 25],
  });
});

test("an invalid day is recorded as invalid and is not the latest complete date", async () => {
  await archive(
    DISPATCH,
    ["2026-11-17"],
    "TradingDate,TradingPeriod,PublishDateTime,PointOfConnection,Island,IsProxyPriceFlag,DollarsPerMegawattHour\n2026-01-01,1,2026-11-17T00:00:13.000+13:00,OHG1101,,N,33.28\n",
  );
  await run();
  const invalid = await readCompleteness(silverDir, DISPATCH, "2026-11-17");
  expect(invalid.status).toBe("invalid");
  expect(invalid.expectedPeriodCount).toBe(48);
  expect(invalid.actualPeriodCount).toBeNull();
  expect(invalid.errors.length).toBeGreaterThan(0);
  expect(invalid.processedAt).not.toBeNull();
  expect(existsSync(partition("2026-11-17"))).toBe(false);
  expect((await completenessStatusLines(silverDir))[0]).toBe(
    `${DISPATCH}: latest complete none`,
  );
});

test("period counts follow the trading date, including a 50-period DST day", async () => {
  await archive(
    "periods",
    ["2026-04-05", "2026-09-27", "2026-11-18", "2026-11-19"],
    "x",
  );
  const registry: PublisherDataset[] = [
    {
      id: "periods",
      partitionKey: "trading_date",
      countsTradingPeriods: true,
      publish: async ({ date }) => {
        if (date === "2026-04-05") return { date, status: "missing" };
        if (date === "2026-09-27")
          return {
            date,
            status: "partial",
            rows: 1,
            path: "p",
            missingPeriods: [1],
          };
        if (date === "2026-11-19")
          return {
            date,
            status: "partial",
            rows: 1,
            path: "p",
            missingPeriods: [24, 25],
          };
        return { date, status: "complete", rows: 1, path: "p" };
      },
    },
  ];
  await runPublish({ bronzeDir, silverDir, goldDir, registry });
  expect(existsSync(join(silverDir, "periods"))).toBe(false);

  expect(
    await readCompleteness(silverDir, "periods", "2026-04-05"),
  ).toMatchObject({
    status: "missing",
    expectedPeriodCount: 50,
    actualPeriodCount: 0,
    missingPeriods: [],
  });
  expect(
    await readCompleteness(silverDir, "periods", "2026-09-27"),
  ).toMatchObject({
    status: "partial",
    expectedPeriodCount: 46,
    actualPeriodCount: 45,
    missingPeriods: [1],
  });
  expect(
    await readCompleteness(silverDir, "periods", "2026-11-18"),
  ).toMatchObject({
    status: "complete",
    expectedPeriodCount: 48,
    actualPeriodCount: 48,
  });
  expect(
    await readCompleteness(silverDir, "periods", "2026-11-19"),
  ).toMatchObject({
    status: "partial",
    expectedPeriodCount: 48,
    actualPeriodCount: 46,
    missingPeriods: [24, 25],
  });
  const lines = await completenessStatusLines(silverDir, registry);
  expect(lines).toEqual(["periods: latest complete 2026-11-18"]);
});

test("a snapshot has no period count", async () => {
  await archive("network_supply_points", ["2026-11-18"], "x");
  const registry: PublisherDataset[] = [
    {
      id: "network_supply_points",
      partitionKey: "snapshot_date",
      publish: async ({ date }) => ({
        date,
        status: "complete",
        rows: 3,
        path: "p",
      }),
    },
  ];
  await runPublish({ bronzeDir, silverDir, goldDir, registry });
  expect(
    await readCompleteness(silverDir, "network_supply_points", "2026-11-18"),
  ).toMatchObject({
    status: "complete",
    expectedPeriodCount: null,
    actualPeriodCount: null,
    missingPeriods: [],
  });
  expect(await completenessStatusLines(silverDir, registry)).toEqual([
    "network_supply_points: latest complete 2026-11-18",
  ]);
});

test("Generation_MD before its month file is missing, not invalid", async () => {
  expect(
    await readCompleteness(silverDir, "generation_md", "2026-11-19"),
  ).toMatchObject({
    status: "missing",
    expectedPeriodCount: 48,
    actualPeriodCount: 0,
    processedAt: null,
    errors: [],
  });
  expect(
    await readCompleteness(silverDir, "generation_md", "2026-04-05"),
  ).toMatchObject({
    status: "missing",
    expectedPeriodCount: 50,
    actualPeriodCount: 0,
    processedAt: null,
  });
  expect(await completenessStatusLines(silverDir)).toContain(
    "generation_md: latest complete none",
  );
});
