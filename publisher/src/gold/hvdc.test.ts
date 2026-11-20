import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { publishHvdcFlows } from "../silver/hvdc-flows.ts";
import { goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { ANALYSIS_VERSION, hvdc, publishHvdc, TABLES } from "./hvdc.ts";

const FIXTURES = join(import.meta.dirname, "..", "silver", "fixtures");
const DATES = [
  "2026-04-05",
  "2026-04-12",
  "2026-04-26",
  "2026-09-27",
  "2026-10-24",
  "2026-10-31",
];
let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-hvdc-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function query(sql: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return (
      await connection.runAndReadAll(
        sql.replaceAll("$S", silverDir).replaceAll("$G", goldDir),
      )
    ).getRowObjectsJson() as Array<Record<string, string | null>>;
  } finally {
    connection.closeSync();
  }
}

const gold = (table: string, date: string) =>
  `'$G/${table}/trading_date=${date}/data.parquet'`;
const silverFile = (date: string) =>
  join(silverDir, "hvdc_flows", `trading_date=${date}`, "data.parquet");

/** Store one fixture month in bronze the way the collector does. */
async function archive(month: string, csv?: string) {
  const body =
    csv ??
    (await readFile(
      join(FIXTURES, "hvdc-flows", `${month}_HVDC_flows.csv`),
      "utf8",
    ));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const fileName = `${month}_HVDC_flows.csv`;
  const path = `hvdc_flows/${sha256}/${fileName}`;
  await mkdir(join(bronzeDir, "hvdc_flows", sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), body);
  const first = Temporal.PlainDate.from(
    `${month.slice(0, 4)}-${month.slice(4)}-01`,
  );
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({
      dataset: "hvdc_flows",
      status: "new",
      retrieved_at: "2026-11-21T00:00:01.000Z",
      sha256,
      path,
      trading_dates: Array.from({ length: first.daysInMonth }, (_, i) =>
        first.add({ days: i }).toString(),
      ),
    })}\n`,
  );
}

/** Real silver from the fixtures, for every fixture day. */
async function buildSilver() {
  await archive("202604");
  await archive("202609");
  await archive("202610");
  for (const date of DATES)
    expect(
      await publishHvdcFlows({ bronzeDir, silverDir, date }),
    ).toMatchObject({ status: expect.stringMatching(/complete|partial/) });
}

const publish = (date: string, view = completenessView()) =>
  publishHvdc({ silverDir, goldDir, completeness: view, date });

/** Replace a silver partition with rows made by `select`, keeping the same file name. */
async function rewriteSilver(date: string, select: (file: string) => string) {
  const file = silverFile(date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (${select(file)}) TO '${file}.new' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  await rename(`${file}.new`, file);
}

const PERIOD_ROW = (date: string, tp: number) =>
  `SELECT * FROM ${gold("hvdc_transfer_period", date)} WHERE trading_period = ${tp}`;

test("the 31 October 2026 period 1 is northward, with hand-calculated MWh", async () => {
  await buildSilver();
  expect(await publish("2026-10-31")).toMatchObject({
    status: "complete",
    rows: 48,
  });
  const [row] = await query(PERIOD_ROW("2026-10-31", 1));
  expect(Number(row?.benmore_offtake_mwh)).toBeCloseTo(204.554, 9);
  expect(Number(row?.benmore_injection_mwh)).toBe(0);
  expect(Number(row?.haywards_injection_mwh)).toBeCloseTo(198.323, 9);
  expect(Number(row?.south_island_sent_mwh)).toBeCloseTo(204.554, 9);
  expect(Number(row?.north_island_received_mwh)).toBeCloseTo(198.323, 9);
  expect(Number(row?.losses_mwh)).toBeCloseTo(6.231, 9);
  expect(Number(row?.average_megawatts)).toBeCloseTo(396.646, 9);
  expect(row?.direction).toBe("north");
  expect(row?.inputs_complete).toBe(true);
});

test("the 31 October 2026 day sums the periods and states the average over 24 hours", async () => {
  await buildSilver();
  await publish("2026-10-31");
  const [day] = await query(
    `SELECT * FROM ${gold("hvdc_transfer_day", "2026-10-31")}`,
  );
  expect(Number(day?.south_island_sent_mwh)).toBeCloseTo(18732.894, 6);
  expect(Number(day?.north_island_received_mwh)).toBeCloseTo(17887.647, 6);
  expect(Number(day?.losses_mwh)).toBeCloseTo(845.247, 6);
  expect(Number(day?.average_megawatts)).toBeCloseTo(17887.647 / 24, 6);
  expect(day?.direction).toBe("north");
  expect(day?.inputs_complete).toBe(true);
});

test("the 5 April 2026 DST-end period 1 is southward, and the day uses 25 hours", async () => {
  await buildSilver();
  expect(await publish("2026-04-05")).toMatchObject({ rows: 50 });
  const [row] = await query(PERIOD_ROW("2026-04-05", 1));
  expect(Number(row?.south_island_sent_mwh)).toBeCloseTo(-21.944, 9);
  expect(Number(row?.north_island_received_mwh)).toBeCloseTo(-23.646, 9);
  expect(Number(row?.losses_mwh)).toBeCloseTo(1.702, 9);
  expect(Number(row?.average_megawatts)).toBeCloseTo(-47.292, 9);
  expect(row?.direction).toBe("south");

  const [day] = await query(
    `SELECT * FROM ${gold("hvdc_transfer_day", "2026-04-05")}`,
  );
  expect(Number(day?.south_island_sent_mwh)).toBeCloseTo(-185.041, 6);
  expect(Number(day?.north_island_received_mwh)).toBeCloseTo(-269.78, 6);
  expect(Number(day?.losses_mwh)).toBeCloseTo(84.739, 6);
  expect(Number(day?.average_megawatts)).toBeCloseTo(-269.78 / 25, 6);
  expect(day?.direction).toBe("south");
});

test("the 27 September 2026 day has 46 periods and uses 23 hours", async () => {
  await buildSilver();
  expect(await publish("2026-09-27")).toMatchObject({ rows: 46 });
  const [day] = await query(
    `SELECT * FROM ${gold("hvdc_transfer_day", "2026-09-27")}`,
  );
  expect(Number(day?.south_island_sent_mwh)).toBeCloseTo(12327.785, 6);
  expect(Number(day?.north_island_received_mwh)).toBeCloseTo(11764.744, 6);
  expect(Number(day?.losses_mwh)).toBeCloseTo(563.041, 6);
  expect(Number(day?.average_megawatts)).toBeCloseTo(11764.744 / 23, 6);
  expect(day?.direction).toBe("north");
});

test("idle periods and periods where the two ends disagree have direction none", async () => {
  await buildSilver();
  await publish("2026-04-26");
  await publish("2026-04-12");
  const idle = await query(
    `SELECT DISTINCT direction FROM ${gold("hvdc_transfer_period", "2026-04-26")}
     WHERE trading_period BETWEEN 21 AND 35`,
  );
  expect(idle).toEqual([{ direction: "none" }]);

  const [disagree] = await query(PERIOD_ROW("2026-04-12", 38));
  expect(Number(disagree?.south_island_sent_mwh)).toBeCloseTo(1.115, 9);
  expect(Number(disagree?.north_island_received_mwh)).toBeCloseTo(-0.486, 9);
  expect(disagree?.direction).toBe("none");
});

test("a period with flow in both directions takes the direction of its net flow", async () => {
  await buildSilver();
  await publish("2026-10-24");
  // TP27 has Benmore X and I. Both ends net north. TP29 has both and nets south.
  const [north] = await query(PERIOD_ROW("2026-10-24", 27));
  expect(north?.direction).toBe("north");
  const [south] = await query(PERIOD_ROW("2026-10-24", 29));
  expect(south?.direction).toBe("south");
});

test("the day row equals the sum of the period rows", async () => {
  await buildSilver();
  await publish("2026-04-05");
  const [check] = await query(
    `SELECT abs(
         (SELECT sum(south_island_sent_mwh) FROM ${gold("hvdc_transfer_period", "2026-04-05")})
         - (SELECT south_island_sent_mwh FROM ${gold("hvdc_transfer_day", "2026-04-05")})
       ) AS diff`,
  );
  expect(Number(check?.diff)).toBeLessThan(1e-6);
});

test("the same inputs give identical bytes on a second run", async () => {
  await buildSilver();
  const bytes = async () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(goldPartitionPath(goldDir, t, "2026-10-31")).then((b) =>
          createHash("sha256").update(b).digest("hex"),
        ),
      ),
    );
  await publish("2026-10-31");
  const first = await bytes();
  await publish("2026-10-31");
  expect(await bytes()).toEqual(first);
});

test("a day with a missing period writes every period, flags the day and lists the period", async () => {
  await buildSilver();
  await rewriteSilver(
    "2026-10-31",
    (file) =>
      `SELECT * FROM read_parquet('${file}')
     WHERE NOT (trading_period = 3 AND point_of_connection = 'BEN2201' AND flow_direction = 'X')`,
  );
  const result = await publish("2026-10-31");
  expect(result).toMatchObject({
    status: "partial",
    missingPeriods: [3],
    rows: 48,
  });
  const [row] = await query(PERIOD_ROW("2026-10-31", 3));
  expect(row?.benmore_offtake_mwh).toBeNull();
  expect(row?.inputs_complete).toBe(false);
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("hvdc_transfer_day", "2026-10-31")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("a point of connection other than the two terminals flags the day", async () => {
  await buildSilver();
  await rewriteSilver(
    "2026-10-31",
    (file) =>
      `SELECT * FROM read_parquet('${file}')
     UNION ALL SELECT * REPLACE ('ZZZ2201' AS point_of_connection)
     FROM read_parquet('${file}') WHERE trading_period = 1 AND point_of_connection = 'BEN2201' AND flow_direction = 'X'`,
  );
  expect(await publish("2026-10-31")).toMatchObject({ status: "partial" });
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("hvdc_transfer_period", "2026-10-31")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("an input that is not complete in silver flags the day", async () => {
  await buildSilver();
  const result = await publish(
    "2026-10-31",
    completenessView([["hvdc_flows", "2026-10-31", "invalid"]]),
  );
  expect(result).toMatchObject({ status: "partial", missingPeriods: [] });
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("hvdc_transfer_day", "2026-10-31")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("a date with no silver is missing and writes nothing", async () => {
  expect(await publish("2026-11-18")).toEqual({
    date: "2026-11-18",
    status: "missing",
  });
  expect(existsSync(join(goldDir, "hvdc_transfer_period"))).toBe(false);
});

test("the rows carry the analysis version and the fingerprint of the input", async () => {
  await buildSilver();
  await publish("2026-10-31");
  const wanted = (
    await hvdc.wantedVersions?.(silverDir, completenessView())
  )?.get("2026-10-31");
  for (const table of TABLES) {
    const rows = await query(
      `SELECT DISTINCT analysis_version, inputs_sha256 FROM ${gold(table, "2026-10-31")}`,
    );
    expect(rows).toEqual([
      { analysis_version: ANALYSIS_VERSION, inputs_sha256: wanted },
    ]);
  }
});

test("the runner builds gold, skips it when silver is unchanged and rebuilds it when silver changes", async () => {
  await buildSilver();
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_hvdc"],
    }).then((s) => s[0]);
  const built = await run();
  expect(built).toMatchObject({
    published: DATES.length,
    upToDate: 0,
    failed: [],
  });
  expect(await run()).toMatchObject({ published: 0, upToDate: DATES.length });
  // A new bronze version for one day: silver is rewritten with a new sha.
  await rewriteSilver(
    "2026-10-31",
    (file) =>
      `SELECT * REPLACE ('new-sha' AS bronze_sha256) FROM read_parquet('${file}')`,
  );
  expect(await run()).toMatchObject({
    published: 1,
    upToDate: DATES.length - 1,
  });
});

test("the day average is null when a period is missing, and the energy sums still count the periods that exist", async () => {
  await buildSilver();
  await rewriteSilver(
    "2026-10-31",
    (file) =>
      `SELECT * FROM read_parquet('${file}')
     WHERE NOT (trading_period = 3 AND point_of_connection = 'BEN2201' AND flow_direction = 'X')`,
  );
  await publish("2026-10-31");
  const [day] = await query(
    `SELECT * FROM ${gold("hvdc_transfer_day", "2026-10-31")}`,
  );
  expect(day?.average_megawatts).toBeNull();
  // Haywards has all 48 periods, so its sum is unchanged.
  expect(Number(day?.north_island_received_mwh)).toBeCloseTo(17887.647, 6);
  expect(day?.inputs_complete).toBe(false);
});
