import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lit } from "../silver/common.ts";
import { goldPartitionPath, shiftDate } from "./common.ts";
import {
  ANALYSIS_VERSION,
  EPISODE_RANKING_CONFIG,
  INPUTS,
  publishEpisodeRanking,
  type RankingEpisode,
  scoreEpisodes,
  shapeKey,
  TABLES,
} from "./episode-ranking.ts";
import { CORROBORATION_RULES, TABLES as EPISODE_TABLES } from "./episodes.ts";
import { completenessView } from "./fixtures/completeness.ts";

const DAY = "2026-11-11";
const config = EPISODE_RANKING_CONFIG;
/** The span of every episode written by `writeEpisodeDay`. */
const SPAN = ["2026-11-11 06:00:00+00", "2026-11-11 08:00:00+00"] as const;

const episode = (
  id: string,
  overrides: Partial<RankingEpisode> = {},
): RankingEpisode => ({
  episode_id: id,
  trading_date: DAY,
  severity: 1,
  period_count: 1,
  observation_types: ["price_high"],
  islands: ["NI"],
  corroboration_count: 0,
  inputs_complete: true,
  ...overrides,
});

const only = (episodes: RankingEpisode[], history: Array<Set<string>> = []) => {
  const [row] = scoreEpisodes(episodes, history);
  if (!row) throw new Error("no scored episode");
  return row;
};

const COLD: Array<Set<string>> = [];
const warm = (shapes: string[][]): Array<Set<string>> =>
  Array.from(
    { length: config.minPoolSize },
    (_, i) => new Set(shapes[i] ?? []),
  );

test("the weights add up to 1", () => {
  const { severity, duration, breadth, corroboration, rarity } = config.weights;
  expect(severity + duration + breadth + corroboration + rarity).toBeCloseTo(
    1,
    12,
  );
});

test("the default config is pinned: a changed value without an ANALYSIS_VERSION bump fails here", () => {
  expect(ANALYSIS_VERSION).toBe(3);
  expect(
    createHash("sha256").update(JSON.stringify(config)).digest("hex"),
  ).toBe("66693bf6acc022db069acd04ab9092dcc01ccf2e6a8b1cc24079781d92dd21af");
});

test("components are 0 at the threshold and 1 at the caps, and they clamp", () => {
  const floor = only([episode("a")], COLD);
  expect(floor).toMatchObject({
    severity_component: 0,
    breadth_component: 0,
    rarity_component: 0.5,
  });
  const top = only(
    [
      episode("a", {
        severity: 170,
        period_count: 12,
        observation_types: [
          "price_high",
          "reserve_price_high",
          "generation_low",
          "separation_high",
        ],
        islands: ["NI", "SI"],
      }),
    ],
    COLD,
  );
  expect(top.severity_component).toBeCloseTo(1, 6);
  expect(top.duration_component).toBe(1);
  expect(top.breadth_component).toBe(1);
  const over = only([episode("a", { severity: 1e6, period_count: 480 })], COLD);
  expect(over.severity_component).toBe(1);
  expect(over.duration_component).toBe(1);
  const under = only([episode("a", { severity: 0.5 })], COLD);
  expect(under.severity_component).toBe(0);
});

test("severity is normalised per observation type", () => {
  const reserve = only(
    [
      episode("a", {
        severity: 170,
        observation_types: ["reserve_price_high"],
      }),
    ],
    COLD,
  );
  expect(reserve.severity_component).toBeCloseTo(1, 6);
  const sameOnPrice = only([episode("a", { severity: 170 })], COLD);
  expect(sameOnPrice.severity_component).toBe(1);
  const reserveSmall = only(
    [episode("a", { severity: 30, observation_types: ["reserve_price_high"] })],
    COLD,
  );
  expect(reserveSmall.severity_component).toBeLessThan(0.7);
  const low = only(
    [episode("a", { severity: 1.49, observation_types: ["price_low"] })],
    COLD,
  );
  expect(low.severity_component).toBe(1);
});

test("a mixed episode takes the largest cap of its types", () => {
  const mixed = only(
    [
      episode("a", {
        severity: 30,
        observation_types: ["price_high", "reserve_price_high"],
      }),
    ],
    COLD,
  );
  expect(mixed.severity_component).toBeCloseTo(
    Math.log10(30) / Math.log10(170),
    5,
  );
});

test("breadth counts extra types and extra islands", () => {
  expect(
    only([episode("a", { observation_types: ["a", "b"] })], COLD)
      .breadth_component,
  ).toBe(0.25);
  expect(
    only([episode("a", { islands: ["NI", "SI"] })], COLD).breadth_component,
  ).toBe(0.25);
  expect(only([episode("a", { islands: [] })], COLD).breadth_component).toBe(0);
});

test("a common shape is less rare than an uncommon one", () => {
  const common = shapeKey(["price_high"], ["NI"]);
  const history = warm(Array.from({ length: 10 }, () => [common]));
  const [seen] = scoreEpisodes([episode("a")], history);
  const [novel] = scoreEpisodes(
    [episode("a", { observation_types: ["generation_low"] })],
    history,
  );
  expect(seen?.rarity_component).toBeCloseTo(1 - 10 / config.minPoolSize, 6);
  expect(novel?.rarity_component).toBe(1);
  expect(seen?.history_sample_size).toBe(config.minPoolSize);
});

test("rarity does not use severity: a larger episode of a common shape is not rarer", () => {
  const history = warm([[shapeKey(["price_high"], ["NI"])]]);
  const small = scoreEpisodes([episode("a", { severity: 2 })], history)[0];
  const large = scoreEpisodes([episode("a", { severity: 25 })], history)[0];
  expect(small?.rarity_component).toBe(large?.rarity_component);
});

test("fewer prior days than minPoolSize gives neutral rarity and records the sample size", () => {
  const history = Array.from(
    { length: config.minPoolSize - 1 },
    () => new Set<string>(),
  );
  const [row] = scoreEpisodes([episode("a")], history);
  expect(row?.rarity_component).toBe(0.5);
  expect(row?.history_sample_size).toBe(config.minPoolSize - 1);
});

test("score ties break by code-unit episode_id, including case and accent", () => {
  const rows = scoreEpisodes(
    [episode("é"), episode("Z"), episode("a"), episode("A")],
    COLD,
  );
  expect(rows.map((row) => row.episode_id)).toEqual(["A", "Z", "a", "é"]);
});

test("ranks by score with ties broken by episode_id, and gates candidates", () => {
  const rows = scoreEpisodes(
    [
      episode("c", { severity: 10, period_count: 12 }),
      episode("b"),
      episode("a"),
      episode("d"),
    ],
    COLD,
  );
  expect(rows.map((row) => [row.episode_id, row.day_rank])).toEqual([
    ["c", 1],
    ["a", 2],
    ["b", 3],
    ["d", 4],
  ]);
  expect(rows.map((row) => row.candidate_reason)).toEqual([
    "top_n",
    "beyond_top_n",
    "beyond_top_n",
    "beyond_top_n",
  ]);
  expect(rows.map((row) => row.is_candidate)).toEqual([
    true,
    false,
    false,
    false,
  ]);
});

test("a weak top-ranked episode is below_min_score", () => {
  const [row] = scoreEpisodes([episode("a")], COLD);
  expect(row?.day_rank).toBe(1);
  expect(row?.candidate_reason).toBe("below_min_score");
  expect(row?.is_candidate).toBe(false);
});

// DuckDB

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-episode-ranking-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function copySql(sql: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(`COPY (${sql}) TO ${lit(path)} (FORMAT parquet)`);
  } finally {
    connection.closeSync();
  }
}

const arraySql = (values: readonly string[]) =>
  values.length === 0
    ? "[]::VARCHAR[]"
    : `[${values.map(lit).join(", ")}]::VARCHAR[]`;

async function writeEpisodeDay(
  date: string,
  episodes: Array<Partial<RankingEpisode> & { episode_id: string }> = [],
  version = "v1",
  complete = true,
) {
  await copySql(
    `SELECT DATE ${lit(date)} AS trading_date, ${lit(version)} AS inputs_sha256,
       ${complete} AS inputs_complete`,
    goldPartitionPath(goldDir, EPISODE_TABLES[0], date),
  );
  // The corroboration detectors' sentinels, which the fingerprint reads.
  for (const input of INPUTS.slice(1))
    await copySql(
      `SELECT DATE ${lit(date)} AS trading_date, 'd1' AS inputs_sha256, true AS inputs_complete`,
      goldPartitionPath(goldDir, input.table, date),
    );
  const values =
    episodes.length === 0
      ? `SELECT NULL::VARCHAR AS episode_id, NULL::DATE AS trading_date,
           NULL::DOUBLE AS severity, NULL::INTEGER AS period_count,
           NULL::VARCHAR[] AS observation_types, NULL::VARCHAR[] AS islands,
           NULL::TIMESTAMPTZ AS event_start_utc, NULL::TIMESTAMPTZ AS event_end_utc,
           NULL::BOOLEAN AS inputs_complete WHERE false`
      : `SELECT * FROM (VALUES ${episodes
          .map((e) => {
            const full = episode(e.episode_id, e);
            return `(${lit(full.episode_id)}, DATE ${lit(date)}, ${full.severity}::DOUBLE,
              ${full.period_count}::INTEGER, ${arraySql(full.observation_types)},
              ${arraySql(full.islands)}, TIMESTAMPTZ '${SPAN[0]}', TIMESTAMPTZ '${SPAN[1]}',
              ${full.inputs_complete})`;
          })
          .join(", ")}) t(episode_id, trading_date, severity, period_count,
            observation_types, islands, event_start_utc, event_end_utc, inputs_complete)`;
  await copySql(values, goldPartitionPath(goldDir, EPISODE_TABLES[1], date));
}

const publish = (date: string) =>
  publishEpisodeRanking({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date,
  });

async function query<T>(table: string, date: string, columns: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    return (
      await connection.runAndReadAll(
        `SELECT ${columns} FROM read_parquet(${lit(goldPartitionPath(goldDir, table, date))})`,
      )
    ).getRowObjectsJson() as T[];
  } finally {
    connection.closeSync();
  }
}

test("a date with no episode_days partition is missing", async () => {
  expect(await publish(DAY)).toEqual({ date: DAY, status: "missing" });
});

test("INPUTS are episode_days with a 90 day window", () => {
  expect(INPUTS.map((input) => [input.table, input.windowDays])).toEqual([
    ["episode_days", 90],
    ["fuel_generation_change_baselines", undefined],
    ["demand_deviation_baselines", undefined],
  ]);
});

test("a quiet day writes a sentinel row and an empty scores partition", async () => {
  await writeEpisodeDay(DAY);
  expect(await publish(DAY)).toMatchObject({ status: "complete", rows: 1 });
  expect(
    await query(
      TABLES[0],
      DAY,
      "episode_count, candidate_count, history_days, inputs_complete",
    ),
  ).toEqual([
    {
      episode_count: 0,
      candidate_count: 0,
      history_days: 0,
      inputs_complete: true,
    },
  ]);
  expect(await query(TABLES[1], DAY, "count(*)::INTEGER AS n")).toEqual([
    { n: 0 },
  ]);
});

test("episodes are scored from the prior days only, and the day itself is excluded", async () => {
  for (let i = 1; i <= config.minPoolSize; i++)
    await writeEpisodeDay(
      shiftDate(DAY, -i),
      i <= 5 ? [{ episode_id: `p${i}` }] : [],
    );
  await writeEpisodeDay(DAY, [
    { episode_id: "x1" },
    { episode_id: "x2", observation_types: ["generation_low"] },
  ]);
  expect(await publish(DAY)).toMatchObject({ status: "complete" });
  const rows = await query<{
    episode_id: string;
    rarity_component: number;
    history_sample_size: number;
    day_rank: number;
  }>(
    TABLES[1],
    DAY,
    "episode_id, rarity_component, history_sample_size, day_rank",
  );
  expect(rows.map((r) => r.episode_id)).toEqual(["x1", "x2"]);
  expect(rows[0]?.rarity_component).toBeCloseTo(0.75, 6);
  expect(rows[1]?.rarity_component).toBe(1);
  expect(rows[0]?.history_sample_size).toBe(config.minPoolSize);
  expect(
    await query<{ history_days: number }>(TABLES[0], DAY, "history_days"),
  ).toEqual([{ history_days: config.minPoolSize }]);
});

test("an incomplete episode makes the day partial but still scores it", async () => {
  await writeEpisodeDay(DAY, [{ episode_id: "x1", inputs_complete: false }]);
  expect(await publish(DAY)).toMatchObject({ status: "partial" });
  expect(await query(TABLES[1], DAY, "episode_id, inputs_complete")).toEqual([
    { episode_id: "x1", inputs_complete: false },
  ]);
});

test("the same inputs give identical bytes on a second run", async () => {
  await writeEpisodeDay(shiftDate(DAY, -1), [{ episode_id: "p" }]);
  await writeEpisodeDay(DAY, [{ episode_id: "x1" }, { episode_id: "x2" }]);
  const bytes = async () =>
    Promise.all(
      TABLES.map((table) =>
        readFile(goldPartitionPath(goldDir, table, DAY)).then((buf) =>
          createHash("sha256").update(buf).digest("hex"),
        ),
      ),
    );
  await publish(DAY);
  const first = await bytes();
  await publish(DAY);
  expect(await bytes()).toEqual(first);
});

test("a rebuilt episode day inside the window changes the fingerprint", async () => {
  await writeEpisodeDay(shiftDate(DAY, -40), [{ episode_id: "p" }], "v1");
  await writeEpisodeDay(DAY);
  const sha = async () =>
    (await query<{ inputs_sha256: string }>(TABLES[0], DAY, "inputs_sha256"))[0]
      ?.inputs_sha256;
  await publish(DAY);
  const first = await sha();
  await writeEpisodeDay(shiftDate(DAY, -40), [{ episode_id: "p" }], "v2");
  await publish(DAY);
  expect(await sha()).not.toBe(first);
});

// Catches: corroboration that is not scored, or one that does not stop at the cap.
test("corroboration scores 0 with no observation, 0.5 with one type and 1 with both", () => {
  const score = (count: number) =>
    only([episode("a", { corroboration_count: count })]);
  expect(score(0).corroboration_component).toBe(0);
  expect(score(1).corroboration_component).toBe(0.5);
  expect(score(2).corroboration_component).toBe(1);
  expect(score(3).corroboration_component).toBe(1);
  expect(score(2).score - score(0).score).toBeCloseTo(
    config.weights.corroboration,
    6,
  );
});

async function writeObservations(
  table: string,
  date: string,
  rows: Array<{
    type: string;
    island: string | null;
    start: string;
    end: string;
  }>,
) {
  await copySql(
    `SELECT * FROM (VALUES ${rows
      .map(
        (r) =>
          `(${lit(r.type)}, ${r.island === null ? "NULL::VARCHAR" : lit(r.island)}, DATE ${lit(date)}, TIMESTAMPTZ ${lit(r.start)}, TIMESTAMPTZ ${lit(r.end)})`,
      )
      .join(
        ", ",
      )}) t(observation_type, island, trading_date, event_start_utc, event_end_utc)`,
    goldPartitionPath(goldDir, table, date),
  );
}

// Catches: a wrong-island, out-of-span, null-island or wrong-type observation counted as
// corroboration, or one rule counted twice for the same episode.
test("corroboration counts each matching rule once and ignores non-matches", async () => {
  await writeEpisodeDay(DAY, [
    { episode_id: "ni", islands: ["NI"] },
    { episode_id: "si", islands: ["SI"] },
  ]);
  const [fuel, demand] = CORROBORATION_RULES;
  const inside = {
    start: "2026-11-11 07:00:00+00",
    end: "2026-11-11 09:00:00+00",
  };
  await writeObservations(fuel.table, DAY, [
    { type: "generation_low", island: "NI", ...inside },
    { type: "generation_low", island: "NI", ...inside },
    { type: "generation_high", island: "SI", ...inside },
  ]);
  await writeObservations(demand.table, DAY, [
    { type: "demand_high", island: "NI", ...inside },
    {
      type: "demand_high",
      island: "NI",
      start: "2026-11-11 08:00:00+00",
      end: "2026-11-11 09:00:00+00",
    },
    { type: "demand_high", island: null, ...inside },
  ]);
  await publish(DAY);
  expect(
    await query(TABLES[1], DAY, "episode_id, corroboration_count"),
  ).toEqual(
    expect.arrayContaining([
      { episode_id: "ni", corroboration_count: 2 },
      { episode_id: "si", corroboration_count: 0 },
    ]),
  );
});
