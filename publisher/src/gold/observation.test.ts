import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";
import { lit } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { createRunTables, type RunDetectorConfig } from "./observation.ts";

const BASE = "2026-11-10";
const DAY = "2026-11-11";
const SUBJECT = "OTA2201";

/** Same shape as the price-anomaly synthetic config: pooled 48 samples, ramp 1..48. */
const pooledConfig: RunDetectorConfig = {
  baselineWindowDays: 1,
  minBaselinePeriods: 48,
  highPercentile: 0.75,
  lowPercentile: 0.25,
  minDeviationFromMedian: 5,
  minPeriods: 2,
};

const periodConfig: RunDetectorConfig = {
  ...pooledConfig,
  minBaselinePeriods: 1,
  baselineByTradingPeriod: true,
};

async function withConnection<T>(
  use: (
    connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  ) => Promise<T>,
): Promise<T> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    return await use(connection);
  } finally {
    connection.closeSync();
  }
}

/** One subject, value = trading period, on BASE and DAY (a stable daily ramp). */
async function loadRamp(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
) {
  const rows: string[] = [];
  for (const date of [BASE, DAY]) {
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(SUBJECT)}, DATE ${lit(date)}, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ,
          ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${period}::DOUBLE, true)`,
      );
    }
  }
  await connection.run(
    `CREATE TEMP TABLE subjects AS SELECT ${lit(SUBJECT)} AS subject_id`,
  );
  await connection.run(
    `CREATE TEMP TABLE series AS SELECT * FROM (VALUES ${rows.join(",")})
       t(subject_id, trading_date, trading_period, event_start_utc, event_end_utc, value, inputs_complete)`,
  );
}

const runTypes = (connection: Awaited<ReturnType<DuckDBInstance["connect"]>>) =>
  connection
    .runAndReadAll(
      `SELECT observation_type, start_trading_period, end_trading_period, measured_value
       FROM runs ORDER BY observation_type, start_trading_period`,
    )
    .then(
      (reader) => reader.getRowObjectsJson() as Array<Record<string, unknown>>,
    );

test("the kit default pools all periods: a stable daily ramp looks high at the end of the day and low at the start", async () => {
  await withConnection(async (connection) => {
    await loadRamp(connection);
    await createRunTables(connection, {
      config: pooledConfig,
      date: DAY,
      highType: "price_high",
      lowType: "price_low",
    });
    const runs = await runTypes(connection);
    expect(runs).toEqual([
      {
        observation_type: "price_high",
        start_trading_period: 37,
        end_trading_period: 48,
        measured_value: 48,
      },
      {
        observation_type: "price_low",
        start_trading_period: 1,
        end_trading_period: 12,
        measured_value: 1,
      },
    ]);
  });
});

test("baselineByTradingPeriod matches the same period on prior days: the same ramp is not a run", async () => {
  await withConnection(async (connection) => {
    await loadRamp(connection);
    await createRunTables(connection, {
      config: periodConfig,
      date: DAY,
      highType: "generation_high",
      lowType: "generation_low",
    });
    expect(await runTypes(connection)).toEqual([]);
  });
});
