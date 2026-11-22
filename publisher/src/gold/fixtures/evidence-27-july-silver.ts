import { join } from "node:path";
import { periodToUtc } from "../../trading-time.ts";
import { DAY } from "./evidence-27-july.ts";
import { writeParquet } from "./parquet.ts";

/**
 * The silver side of the synthetic lake for the evidence tests: period 36 dispatch energy and SIR
 * publishes, units, fleet and network supply points. 246 nodes publish in period 36: 39 reach
 * $20,000 and 207 reach $10,000. Nothing is read from a real lake.
 */

export interface EvidenceSilverOptions {
  silverDir: string;
  date?: string;
  /** Silver tables to leave out. */
  omit?: readonly string[];
}

/** Publish times in UTC. NZST is UTC+12, so 17:50:26 NZST is 05:50:26Z. */
const PUBLISH_TIMES = [
  "05:29:43",
  "05:34:47",
  "05:39:40",
  "05:45:33",
  "05:50:26",
  "05:51:51",
  "05:54:44",
] as const;

const ENERGY_SERIES: Record<string, number[]> = {
  OTA2201: [143.61, 210.42, 283.36, 3315.89, 20459.18, 7809.2, 5279.74],
  HAY2201: [120, 160, 200, 3000, 19980.5, 7000, 5000],
  BEN2201: [41.5, 95.76, 107.25, 151.31, 9793.96, 151.31, 151.3],
  HEP0331: [146.94, 215.46, 290.15, 3395.32, 21000, 7996.51, 5406.57],
  WEL0331: [100, 100, 100, 150, 22070.66, 150, 150],
};

const FOREVER = {
  effective_start_date: "1900-01-01",
  effective_end_date: "2099-12-31",
};
const FROM_2000 = { start_date: "2000-01-01", end_date: null };

export async function writeEvidenceSilver(options: EvidenceSilverOptions) {
  const { silverDir, date = DAY } = options;
  const omit = new Set(options.omit ?? []);
  const { eventStartUtc, eventEndUtc } = periodToUtc(date, 36);
  const TS = "TIMESTAMPTZ";
  const publishes = (series: number[]) =>
    series.map((value, i) => ({ time: `${date}T${PUBLISH_TIMES[i]}Z`, value }));

  const nodes = Object.entries(ENERGY_SERIES).map(([node, series]) => ({
    node,
    list: publishes(series),
  }));
  // 241 more nodes: 36 at $20,100, 167 at $12,000 and 38 at $500. 246 nodes in all.
  for (let i = 0; i < 241; i++) {
    const spike = i < 36 ? 20100 : i < 203 ? 12000 : 500;
    nodes.push({
      node: `N${String(i + 1).padStart(4, "0")}`,
      list: publishes([100, 100, 100, 100, spike, 150, 150]).filter(
        (_, index) => [0, 4, 5].includes(index),
      ),
    });
  }
  const columns = {
    trading_date: "DATE",
    trading_period: "INTEGER",
    event_start_utc: TS,
    event_end_utc: TS,
    source_published_at: TS,
    point_of_connection: "VARCHAR",
    island: "VARCHAR",
    dollars_per_megawatt_hour: "DOUBLE",
  };
  const base = {
    trading_date: date,
    trading_period: 36,
    event_start_utc: eventStartUtc.toString(),
    event_end_utc: eventEndUtc.toString(),
  };
  const silver = (table: string) =>
    join(silverDir, table, `trading_date=${date}`, "data.parquet");

  if (!omit.has("dispatch_energy_prices"))
    await writeParquet(
      silver("dispatch_energy_prices"),
      columns,
      nodes.flatMap(({ node, list }) =>
        list.map(({ time, value }) => ({
          ...base,
          source_published_at: time,
          point_of_connection: node,
          island: "NI",
          dollars_per_megawatt_hour: value,
        })),
      ),
    );

  if (!omit.has("dispatch_reserve_prices")) {
    const rows = [
      ...publishes([69.82, 65.91, 99, 2609.91, 6500, 6500, 4310.15]).map(
        (p) => ({ cls: "SIR", island: "NI", ...p }),
      ),
      ...publishes([0, 0, 0, 0, 0, 0, 0]).map((p) => ({
        cls: "SIR",
        island: "SI",
        ...p,
      })),
      ...publishes([7, 7, 7, 7, 49.93, 49.93, 7]).map((p) => ({
        cls: "FIR",
        island: "NI",
        ...p,
      })),
    ];
    await writeParquet(
      silver("dispatch_reserve_prices"),
      { ...columns, reserve_class: "VARCHAR" },
      rows.map((row) => ({
        ...base,
        source_published_at: row.time,
        point_of_connection: `RESERVE_${row.island}`,
        island: row.island,
        reserve_class: row.cls,
        dollars_per_megawatt_hour: row.value,
      })),
    );
  }

  if (!omit.has("entity_units")) {
    const unit = (
      plant_id: string,
      poc: string,
      code: string,
      operator: string,
    ) => ({
      plant_id,
      point_of_connection: poc,
      unit_code: code,
      plant_name: code,
      plant_operator_code: operator,
    });
    await writeParquet(
      silver("entity_units"),
      {
        plant_id: "VARCHAR",
        point_of_connection: "VARCHAR",
        unit_code: "VARCHAR",
        plant_name: "VARCHAR",
        plant_operator_code: "VARCHAR",
      },
      [
        unit("HLY/huntly_1_4", "HLY2201", "HLY1", "GENE"),
        unit("HLY/huntly_1_4", "HLY2201", "HLY2", "GENE"),
        unit("HLY/huntly_p40", "HLY2201", "HLY6", "GENE"),
        unit("SFD/stratford", "SFD2201", "SFD21", "CTCT"),
        unit("MCK/mckee", "MCK0111", "MCK1", "TAEL"),
        unit("JRD/junction_road", "JRD0331", "JRD1", "TAEL"),
        // No fleet row has this operator code. Ohakuri has no unit row at all.
        unit("WTK/waitaki", "WTK0111", "WTK1", "ZZZ"),
      ],
    );
  }

  if (!omit.has("generation_fleet"))
    await writeParquet(
      join(
        silverDir,
        "generation_fleet",
        "snapshot_date=2026-11-20",
        "data.parquet",
      ),
      {
        plant_operator_code: "VARCHAR",
        plant_operator: "VARCHAR",
        effective_start_date: "DATE",
        effective_end_date: "DATE",
      },
      [
        {
          plant_operator_code: "GENE",
          plant_operator: "Genesis Energy Limited",
          ...FOREVER,
        },
        {
          plant_operator_code: "CTCT",
          plant_operator: "Contact Energy Limited",
          ...FOREVER,
        },
        {
          plant_operator_code: "TAEL",
          plant_operator: "Todd Generation Taranaki Limited",
          ...FOREVER,
        },
      ],
    );

  if (!omit.has("network_supply_points")) {
    const nsp = (
      poc: string,
      description: string,
      island: string,
      region: string,
      latitude: number,
      longitude: number,
    ) => ({
      nsp: poc,
      point_of_connection: poc,
      description,
      island,
      network_reporting_region: region,
      latitude,
      longitude,
      ...FROM_2000,
    });
    await writeParquet(
      join(
        silverDir,
        "network_supply_points",
        "snapshot_date=2026-07-25",
        "data.parquet",
      ),
      {
        nsp: "VARCHAR",
        point_of_connection: "VARCHAR",
        description: "VARCHAR",
        island: "VARCHAR",
        network_reporting_region: "VARCHAR",
        latitude: "DOUBLE",
        longitude: "DOUBLE",
        start_date: "DATE",
        end_date: "DATE",
      },
      [
        nsp("OTA2201", "Otahuhu 220kV", "NI", "Auckland", -36.9446, 174.8421),
        nsp("HAY2201", "Haywards 220kV", "NI", "Wellington", -41.1778, 175.0),
        nsp("BEN2201", "Benmore 220kV", "SI", "Waitaki", -44.5, 170.2),
        nsp("HLY2201", "Huntly 220kV", "NI", "Waikato", -37.54, 175.15),
      ],
    );
  }
}
