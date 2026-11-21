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
import type { PublisherDataset } from "./datasets.ts";
import { datasets } from "./datasets.ts";
import {
  type DatasetSummary,
  hasFailures,
  parseRunArgs,
  runPublish,
} from "./runner.ts";
import { partitionVersions } from "./silver/common.ts";
import { loadCompleteness } from "./silver/completeness.ts";

const DISPATCH = "dispatch_energy_prices";
const fixtures = join(
  import.meta.dirname,
  "silver",
  "fixtures",
  "dispatch-energy-prices",
);

let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-publish-run-"));
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
}
const fixture = (date: string) =>
  readFile(
    join(fixtures, `${date.replaceAll("-", "")}_DispatchEnergyPrices.csv`),
    "utf8",
  );
const partition = (date: string) =>
  join(silverDir, DISPATCH, `trading_date=${date}`, "data.parquet");
const only = (id: string) => ({ only: [id] });
const run = (options: Partial<Parameters<typeof runPublish>[0]> = {}) =>
  runPublish({ bronzeDir, silverDir, goldDir, ...options });
const summaryOf = (summaries: DatasetSummary[], id: string) => {
  const found = summaries.find((s) => s.id === id);
  if (!found) throw new Error(id);
  return found;
};

test("publishes new days, then a second run writes nothing", async () => {
  await archive(DISPATCH, ["2026-09-27"], await fixture("2026-09-27"));
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));

  const first = summaryOf(await run(only(DISPATCH)), DISPATCH);
  expect(first).toMatchObject({ published: 2, upToDate: 0, failed: [] });
  const mtimes = await Promise.all(
    ["2026-09-27", "2026-11-18"].map(
      async (d) => (await stat(partition(d))).mtimeMs,
    ),
  );

  const second = await run();
  expect(hasFailures(second)).toBe(false);
  expect(summaryOf(second, DISPATCH)).toMatchObject({
    published: 0,
    upToDate: 2,
  });
  // Datasets with no bronze files have nothing to do.
  expect(summaryOf(second, "generation_md")).toMatchObject({
    published: 0,
    upToDate: 0,
  });
  expect(
    await Promise.all(
      ["2026-09-27", "2026-11-18"].map(
        async (d) => (await stat(partition(d))).mtimeMs,
      ),
    ),
  ).toEqual(mtimes);
});

test("a changed bronze file publishes again exactly its trading days", async () => {
  await archive(DISPATCH, ["2026-09-27"], await fixture("2026-09-27"));
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  await run(only(DISPATCH));
  const untouched = (await stat(partition("2026-09-27"))).mtimeMs;
  const before = await readFile(partition("2026-11-18"));

  // The source rewrote the 18 Nov file: the same rows with one price changed.
  const csv = await fixture("2026-11-18");
  const revised = csv.replace(
    /(\d+\.\d+)(\r?\n)/,
    (_m, price, eol) => `${Number(price) + 1}${eol}`,
  );
  expect(revised).not.toBe(csv);
  await archive(DISPATCH, ["2026-11-18"], revised);

  const summary = summaryOf(await run(only(DISPATCH)), DISPATCH);
  expect(summary).toMatchObject({ published: 1, upToDate: 1, failed: [] });
  expect((await stat(partition("2026-09-27"))).mtimeMs).toBe(untouched);
  expect(await readFile(partition("2026-11-18"))).not.toEqual(before);

  // And it settles again.
  expect(summaryOf(await run(only(DISPATCH)), DISPATCH)).toMatchObject({
    published: 0,
    upToDate: 2,
  });
});

test("a monthly file that lists many dates changes all of them", {
  timeout: 30_000,
}, async () => {
  // Fake publish: a partition for each date holding the bronze sha, as the real ones do.
  const published: string[] = [];
  const registry: PublisherDataset[] = [
    {
      id: "monthly",
      partitionKey: "trading_date",
      publish: async ({ bronzeDir: b, silverDir: s, date }) => {
        published.push(date);
        const { DuckDBInstance } = await import("@duckdb/node-api");
        const manifest = (await readFile(join(b, "manifest.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const sha = manifest.findLast((r) =>
          r.trading_dates.includes(date),
        ).sha256;
        const file = join(s, "monthly", `trading_date=${date}`, "data.parquet");
        await mkdir(join(s, "monthly", `trading_date=${date}`), {
          recursive: true,
        });
        const connection = await (
          await DuckDBInstance.create(":memory:")
        ).connect();
        await connection.run(
          `COPY (SELECT '${sha}' AS bronze_sha256) TO '${file}' (FORMAT parquet)`,
        );
        return { date, status: "complete", rows: 1, path: file };
      },
    },
  ];
  const days = (month: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
    );
  await archive("monthly", days("2026-09", 30), "september");
  await archive("monthly", days("2026-10", 31), "october");
  expect(summaryOf(await run({ registry }), "monthly").published).toBe(61);
  published.length = 0;

  await archive("monthly", days("2026-09", 30), "september rewritten");
  const summary = summaryOf(await run({ registry }), "monthly");
  expect(summary).toMatchObject({ published: 30, upToDate: 31 });
  expect(published).toEqual(days("2026-09", 30));
});

test("one failing dataset is reported while the others publish", async () => {
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  await archive("boom", ["2026-11-18"], "x");
  await archive(
    DISPATCH,
    ["2026-11-17"],
    "TradingDate,TradingPeriod,PublishDateTime,PointOfConnection,Island,IsProxyPriceFlag,DollarsPerMegawattHour\n2026-01-01,1,2026-11-17T00:00:13.000+13:00,OHG1101,,N,33.28\n",
  );
  const registry: PublisherDataset[] = [
    ...datasets.filter((d) => d.id === DISPATCH),
    {
      id: "boom",
      partitionKey: "trading_date",
      publish: async () => {
        throw new Error("disk on fire");
      },
    },
  ];
  const summaries = await run({ registry });
  expect(hasFailures(summaries)).toBe(true);
  const dispatch = summaryOf(summaries, DISPATCH);
  expect(dispatch.published).toBe(1); // 18 Nov is published
  expect(dispatch.failed).toHaveLength(1);
  expect(dispatch.failed[0]).toContain("2026-11-17: INVALID");
  expect(summaryOf(summaries, "boom").failed).toEqual([
    "2026-11-18: disk on fire",
  ]);
  expect(existsSync(partition("2026-11-18"))).toBe(true);
});

test("a range limits the dates, and force publishes them again", async () => {
  await archive(DISPATCH, ["2026-09-27"], await fixture("2026-09-27"));
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  const range = { from: "2026-11-01", to: "2026-11-30" };
  expect(summaryOf(await run({ range }), DISPATCH).published).toBe(1);
  expect(existsSync(partition("2026-09-27"))).toBe(false);
  expect(summaryOf(await run({ range }), DISPATCH)).toMatchObject({
    published: 0,
    upToDate: 1,
  });
  expect(summaryOf(await run({ range, force: true }), DISPATCH).published).toBe(
    1,
  );
});

test("an empty partition folder from a failed first write does not block the dataset", async () => {
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  await mkdir(join(silverDir, DISPATCH, "trading_date=2026-11-18"), {
    recursive: true,
  });
  const summary = summaryOf(await run(only(DISPATCH)), DISPATCH);
  expect(summary).toMatchObject({ published: 1, failed: [] });
  expect(existsSync(partition("2026-11-18"))).toBe(true);
});

test("a partial day is reported with the CLI line", async () => {
  await archive("part", ["2026-11-18"], "x");
  const registry: PublisherDataset[] = [
    {
      id: "part",
      partitionKey: "trading_date",
      publish: async ({ date }) => ({
        date,
        status: "partial",
        rows: 10,
        path: "p",
        missingPeriods: [24, 25],
      }),
    },
  ];
  const [summary] = await run({ registry });
  expect(summary?.published).toBe(1);
  expect(summary?.partial).toEqual([
    "2026-11-18: PARTIAL 10 rows, missing periods 24,25",
  ]);
});

test("parseRunArgs", () => {
  const today = "2026-11-20";
  expect(parseRunArgs([], today)).toEqual({
    help: false,
    force: false,
    range: undefined,
    only: undefined,
  });
  expect(
    parseRunArgs(
      ["--from", "2026-11-01", "--force", "--dataset", DISPATCH],
      today,
    ),
  ).toMatchObject({
    force: true,
    range: { from: "2026-11-01", to: "2026-11-20" },
    only: [DISPATCH],
  });
  expect(() => parseRunArgs(["--to", "2026-11-01"], today)).toThrow("--from");
  expect(() => parseRunArgs(["--from", ""], today)).toThrow();
  expect(() => parseRunArgs(["--dataset", "nope"], today)).toThrow("Unknown");
  expect(parseRunArgs(["--dataset", "site_days"], today).only).toEqual([
    "site_days",
  ]);
});

test("entity mappings build last, settle, and rebuild when an input partition changes", {
  timeout: 30_000,
}, async () => {
  const nsp = await readFile(
    join(
      import.meta.dirname,
      "silver",
      "fixtures",
      "network-supply-points",
      "20260106_NetworkSupplyPointsTable.csv",
    ),
    "utf8",
  );
  await archive("network_supply_points", ["2026-01-06"], nsp);
  await archive(DISPATCH, ["2026-09-27"], await fixture("2026-09-27"));
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  const entity = (summaries: DatasetSummary[]) =>
    summaryOf(summaries, "entity_mappings");
  const table = (date: string) =>
    join(
      silverDir,
      "entity_points_of_connection",
      `trading_date=${date}`,
      "data.parquet",
    );

  const first = await run();
  expect(first.map((x) => x.id).slice(-10)).toEqual([
    "gold_generation",
    "gold_prices",
    "gold_reserves",
    "gold_hvdc",
    "gold_grid_load",
    "gold_energy_balance",
    "gold_price_anomaly",
    "gold_price_separation",
    "gold_reserve_price_anomaly",
    "site_days",
  ]);
  expect(entity(first)).toMatchObject({
    published: 2,
    upToDate: 0,
    failed: [],
  });

  // Nothing changed: nothing is written, and unmapped identifiers are not a failure.
  const mtime = (await stat(table("2026-11-18"))).mtimeMs;
  const second = await run();
  expect(hasFailures(second)).toBe(false);
  expect(entity(second)).toMatchObject({ published: 0, upToDate: 2 });
  expect((await stat(table("2026-11-18"))).mtimeMs).toBe(mtime);

  // The source rewrote the 18 Nov dispatch file. 27 Sep reads no later dispatch day, so only
  // 18 Nov rebuilds.
  const csv = await fixture("2026-11-18");
  await archive(
    DISPATCH,
    ["2026-11-18"],
    csv.replace(/(\d+\.\d+)(\r?\n)/, (_m, p, eol) => `${Number(p) + 1}${eol}`),
  );
  const third = await run();
  expect(summaryOf(third, DISPATCH)).toMatchObject({ published: 1 });
  expect(entity(third)).toMatchObject({
    published: 1,
    upToDate: 1,
    failed: [],
  });
  expect(entity(await run())).toMatchObject({ published: 0, upToDate: 2 });
});

test("completeness is saved after each dataset, so a crashed run keeps it", async () => {
  await archive(DISPATCH, ["2026-11-18"], await fixture("2026-11-18"));
  let onDisk: string[] = [];
  const registry: PublisherDataset[] = [
    ...datasets.filter((d) => d.id === DISPATCH),
    {
      id: "crash",
      partitionKey: "trading_date",
      wantedVersions: async () => {
        // The second dataset starts. The file must already hold the first one's rows.
        onDisk = [...(await loadCompleteness(silverDir)).values()].map(
          (row) => row.dataset,
        );
        throw new Error("process died");
      },
      publish: async ({ date }) => ({ date, status: "missing" }),
    },
  ];
  await run({ registry });
  expect(onDisk).toEqual([DISPATCH]);
});

test("partitionVersions throws when a partition holds more than one version", async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const dir = join(silverDir, "mixed", "trading_date=2026-11-18");
  await mkdir(dir, { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT 'a' AS bronze_sha256 UNION ALL SELECT 'b') TO '${join(dir, "data.parquet")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  await expect(
    partitionVersions(silverDir, "mixed", "trading_date", "bronze_sha256"),
  ).rejects.toThrow("holds more than one bronze_sha256");
});
