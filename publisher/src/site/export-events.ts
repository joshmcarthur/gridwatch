import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import { TABLES as RANKING_TABLES } from "../gold/episode-ranking.ts";
import {
  buildEvidencePackage,
  type EvidencePackage,
} from "../gold/evidence.ts";
import { REFERENCE_NODES } from "../gold/prices.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import { periodToUtc } from "../trading-time.ts";
import type { EventsSection } from "./contract.ts";
import type {
  EventIsland,
  EventReserveClass,
  SiteEvent,
  SiteEventClaim,
  SiteEventWindow,
} from "./contract-events.ts";
import { readStamp, rowsOf } from "./gold-read.ts";

/** Ranking sentinel. Used in `wantedExportHash`; not a `Section.name`. */
export const EVENTS_RANKING_SENTINEL = RANKING_TABLES[0];

const RESERVE_CLASSES: readonly EventReserveClass[] = ["FIR", "SIR"];
const ISLANDS: readonly EventIsland[] = ["NI", "SI"];

const islandList = (value: readonly string[]): EventIsland[] =>
  value.flatMap((item) => {
    if (item === "NI" || item === "SI") return [item];
    return [];
  });

function missingEvents(): EventsSection {
  return {
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    silver_tables: [],
    gold_tables: [...RANKING_TABLES],
    datasets: [],
    items: [],
  };
}

function mapClaim(claim: EvidencePackage["claims"][number]): SiteEventClaim {
  const mapped: SiteEventClaim = {
    id: claim.id,
    label: claim.label,
    value: claim.value,
    unit: claim.unit,
    confidence: claim.confidence,
    source_kind: claim.source.kind,
    source_table: claim.source.table,
    source_path: claim.source.path,
  };
  if (claim.depends_on !== undefined) mapped.depends_on = claim.depends_on;
  if (claim.note !== undefined) mapped.note = claim.note;
  return mapped;
}

function mapWindow(pkg: EvidencePackage, date: string): SiteEventWindow {
  const periods = pkg.window.periods;
  return {
    periods,
    start_utc: periods.map((period) =>
      periodToUtc(date, period).eventStartUtc.toString(),
    ),
    prices: REFERENCE_NODES.flatMap((node) => {
      const series = pkg.context.prices[node.pointOfConnection];
      if (!series) return [];
      return [
        {
          point_of_connection: node.pointOfConnection,
          price: series.price,
        },
      ];
    }),
    reserves: RESERVE_CLASSES.flatMap((reserveClass) => {
      const byIsland = pkg.context.reserves[reserveClass];
      if (!byIsland) return [];
      return ISLANDS.flatMap((island) => {
        const series = byIsland[island];
        if (!series) return [];
        return [
          {
            reserve_class: reserveClass,
            island,
            price: series.price,
          },
        ];
      });
    }),
  };
}

function mapEvent(pkg: EvidencePackage): SiteEvent {
  const { episode } = pkg;
  return {
    episode_id: episode.episode_id,
    review_status: "unreviewed",
    observation_types: episode.observation_types,
    islands: islandList(episode.islands),
    member_count: episode.member_count,
    severity: episode.severity,
    start_utc: episode.event_start_utc,
    end_utc: episode.event_end_utc,
    start_trading_period: episode.start_trading_period,
    end_trading_period: episode.end_trading_period,
    claims: pkg.claims.map(mapClaim),
    window: mapWindow(pkg, episode.trading_date),
    limits: pkg.limits,
    daily_page: pkg.links.daily_page,
  };
}

/**
 * Site events for one trading date: one item per `is_candidate` row, from the evidence
 * builder (ADR-0014 #42). Missing ranking is `missing`. A ranking day with no candidates
 * is `complete` with an empty list.
 */
export async function buildEvents(options: {
  connection: DuckDBConnection;
  goldDir: string;
  silverDir: string;
  date: string;
  completeness: CompletenessView;
}): Promise<EventsSection> {
  const { connection, goldDir, silverDir, date, completeness } = options;
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, EVENTS_RANKING_SENTINEL, date),
  );
  if (!stamp) return missingEvents();
  const scoresPath = goldPartitionPath(goldDir, RANKING_TABLES[1], date);
  const rows = existsSync(scoresPath)
    ? await rowsOf(
        connection,
        goldDir,
        RANKING_TABLES[1],
        date,
        "episode_id, is_candidate",
        "day_rank, episode_id",
      )
    : [];
  const items: SiteEvent[] = [];
  for (const row of rows) {
    if (row.is_candidate !== true) continue;
    const pkg = await buildEvidencePackage({
      goldDir,
      silverDir,
      completeness,
      episodeId: String(row.episode_id),
      date,
    });
    items.push(mapEvent(pkg));
  }
  return {
    state: stamp.inputs_complete ? "complete" : "incomplete",
    missing_periods: [],
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    silver_tables: [],
    gold_tables: [...RANKING_TABLES],
    datasets: [],
    items,
  };
}
