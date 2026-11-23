import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import { TABLES as RANKING_TABLES } from "../gold/episode-ranking.ts";
import {
  checkNarrative,
  type NarrativeRecord,
  type NarrativeSections,
} from "../gold/narrative.ts";
import { REFERENCE_NODES } from "../gold/prices.ts";
import { lit } from "../silver/common.ts";
import { periodToUtc } from "../trading-time.ts";
import type {
  ClaimConfidence,
  EventsSection,
  Island,
  ReserveClass,
  SiteEvent,
  SiteEventClaim,
  SiteEventWindow,
} from "./contract.ts";
import { readStamp } from "./gold-read.ts";

const NARRATIVE_DIR = "narratives";
const EVIDENCE_DIR = "evidence";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const islandList = (value: unknown): Island[] =>
  asStringList(value).flatMap((item) => {
    if (item === "NI" || item === "SI") return [item];
    return [];
  });

const seriesOf = (value: unknown): Array<number | null> => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item === null ? null : asNumber(item)));
};

const readJson = (path: string): unknown | null => {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
};

const readNarrative = (path: string): NarrativeRecord | null => {
  const parsed = asRecord(readJson(path));
  if (!parsed) return null;
  const what_happened = asString(parsed.what_happened);
  const why = asString(parsed.why);
  const what_it_means = asString(parsed.what_it_means);
  const package_id = asString(parsed.package_id);
  const episode_id = asString(parsed.episode_id);
  const trading_date = asString(parsed.trading_date);
  const model = asString(parsed.model) ?? "";
  const generated_at = asString(parsed.generated_at) ?? "";
  if (
    !what_happened ||
    !why ||
    !what_it_means ||
    !package_id ||
    !episode_id ||
    !trading_date
  ) {
    return null;
  }
  return {
    schema_version: asNumber(parsed.schema_version) ?? 1,
    prompt_version: asNumber(parsed.prompt_version) ?? 1,
    package_id,
    episode_id,
    trading_date,
    model,
    generated_at,
    what_happened,
    why,
    what_it_means,
  };
};

const claimConfidence = (value: unknown): ClaimConfidence | null => {
  if (
    value === "confirmed" ||
    value === "strong_evidence" ||
    value === "possible_explanation"
  ) {
    return value;
  }
  return null;
};

const mapClaims = (value: unknown): SiteEventClaim[] => {
  if (!Array.isArray(value)) return [];
  const claims: SiteEventClaim[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const id = asString(row.id);
    const label = asString(row.label);
    const unit = asString(row.unit) ?? "";
    const confidence = claimConfidence(row.confidence);
    const source = asRecord(row.source);
    const source_kind =
      source?.kind === "gold" || source?.kind === "silver" ? source.kind : null;
    const source_path = source ? asString(source.path) : null;
    const raw = row.value;
    const mappedValue =
      typeof raw === "boolean" || typeof raw === "string" ? raw : asNumber(raw);
    if (
      !id ||
      !label ||
      !confidence ||
      !source_kind ||
      !source_path ||
      mappedValue === null
    ) {
      continue;
    }
    claims.push({
      id,
      label,
      value: mappedValue,
      unit,
      confidence,
      source_kind,
      source_path,
    });
  }
  return claims;
};

const windowFromEvidence = (
  evidence: Record<string, unknown>,
  date: string,
): SiteEventWindow => {
  const window = asRecord(evidence.window);
  const periods = Array.isArray(window?.periods)
    ? window.periods.flatMap((item) => {
        const n = asNumber(item);
        return n === null ? [] : [n];
      })
    : [];
  const start_utc = periods.map((period) =>
    periodToUtc(date, period).eventStartUtc.toString(),
  );
  const context = asRecord(evidence.context);
  const pricesRecord = asRecord(context?.prices);
  const prices = REFERENCE_NODES.map((node) => {
    const series = asRecord(pricesRecord?.[node.pointOfConnection]);
    const price = seriesOf(series?.price);
    return {
      point_of_connection: node.pointOfConnection,
      price:
        price.length === periods.length
          ? price
          : periods.map((_, i) => price[i] ?? null),
    };
  });
  const reservesRecord = asRecord(context?.reserves);
  const sir = asRecord(reservesRecord?.SIR);
  const ni = asRecord(sir?.NI);
  const sirNi = seriesOf(ni?.price);
  const reserves =
    sirNi.length === 0 && periods.length === 0
      ? []
      : [
          {
            reserve_class: "SIR" as ReserveClass,
            island: "NI" as Island,
            price:
              sirNi.length === periods.length
                ? sirNi
                : periods.map((_, i) => sirNi[i] ?? null),
          },
        ];
  return { periods, start_utc, prices, reserves };
};

const sectionsOf = (record: NarrativeRecord): NarrativeSections => ({
  what_happened: record.what_happened,
  why: record.why,
  what_it_means: record.what_it_means,
});

/** Map a passing narrative onto a site event. Null when the check fails or evidence is unusable. */
export function eventFromCandidate(
  narrative: NarrativeRecord,
  evidence: unknown,
): SiteEvent | null {
  const check = checkNarrative(sectionsOf(narrative), evidence);
  if (!check.ok) return null;
  const pkg = asRecord(evidence);
  if (!pkg) return null;
  const episode = asRecord(pkg.episode);
  if (!episode) return null;
  const start_utc = asString(episode.event_start_utc);
  const end_utc = asString(episode.event_end_utc);
  const start_trading_period = asNumber(episode.start_trading_period);
  const end_trading_period = asNumber(episode.end_trading_period);
  const links = asRecord(pkg.links);
  const daily_page =
    asString(links?.daily_page) ??
    `/${narrative.trading_date.replaceAll("-", "/")}/`;
  if (
    !start_utc ||
    !end_utc ||
    start_trading_period === null ||
    end_trading_period === null
  ) {
    return null;
  }
  return {
    episode_id: narrative.episode_id,
    review_status: "unreviewed",
    observation_types: asStringList(episode.observation_types),
    islands: islandList(episode.islands),
    start_utc,
    end_utc,
    start_trading_period,
    end_trading_period,
    package_id: narrative.package_id,
    what_happened: narrative.what_happened,
    why: narrative.why,
    what_it_means: narrative.what_it_means,
    claims: mapClaims(pkg.claims),
    daily_page,
    window: windowFromEvidence(pkg, narrative.trading_date),
  };
}

/**
 * Ranking stamp plus the bytes of narrative JSON for the date. A new narrative or a ranking
 * rewrite changes this, so the day rebuilds.
 */
export function eventsFingerprint(goldDir: string, date: string): string {
  const hash = createHash("sha256");
  const scores = goldPartitionPath(goldDir, RANKING_TABLES[1], date);
  if (existsSync(scores)) hash.update(readFileSync(scores));
  else hash.update("none");
  const dir = join(goldDir, NARRATIVE_DIR, date);
  if (!existsSync(dir)) {
    hash.update("none");
    return hash.digest("hex");
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    hash.update(name);
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest("hex");
}

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

export async function buildEvents(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
): Promise<EventsSection> {
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, RANKING_TABLES[0], date),
  );
  if (!stamp) return missingEvents();
  const scoresPath = goldPartitionPath(goldDir, RANKING_TABLES[1], date);
  const ids = existsSync(scoresPath)
    ? (
        (
          await connection.runAndReadAll(
            `SELECT episode_id FROM read_parquet(${lit(scoresPath)})
           WHERE is_candidate
           ORDER BY day_rank, episode_id`,
          )
        ).getRowObjectsJson() as Array<{ episode_id: unknown }>
      )
        .map((row) => asString(row.episode_id))
        .filter((id): id is string => id !== null)
    : [];
  const items: SiteEvent[] = [];
  for (const episodeId of ids) {
    const narrative = readNarrative(
      join(goldDir, NARRATIVE_DIR, date, `${episodeId}.json`),
    );
    const evidence = readJson(
      join(goldDir, EVIDENCE_DIR, date, `${episodeId}.json`),
    );
    if (!narrative || evidence === null) continue;
    const event = eventFromCandidate(narrative, evidence);
    if (event) items.push(event);
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
