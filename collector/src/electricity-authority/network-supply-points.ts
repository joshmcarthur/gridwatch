import { archiveFile, type ManifestRecord } from "../archive.ts";
import { BLOB, listNames } from "./blob.ts";

export const DATASET = "network_supply_points";
const FOLDER =
  "Datasets/Wholesale/MappingsAndGeospatial/NetworkSupplyPointsTable";
const FILE_PATTERN = /\/(\d{4})(\d{2})(\d{2})_NetworkSupplyPointsTable\.csv$/;
const HUB_URL =
  "https://www.ea.govt.nz/data-and-insights/datasets/wholesale/mapping-and-geospatial/";

export interface CollectOptions {
  bronzeDir: string;
  /** First snapshot date, `YYYY-MM-DD`. */
  from: string;
  /** Last snapshot date, `YYYY-MM-DD`. */
  to: string;
  /** Override for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CollectResult {
  records: ManifestRecord[];
  /** Snapshots where the download failed. The run continues with the next snapshot. */
  failed: Array<{ date: string; error: string }>;
}

/**
 * Archive the dated snapshots from `from` to `to` (inclusive) into bronze. The source does not
 * publish a snapshot every day, so there is no list of missing dates. The snapshot date from the
 * file name is the manifest `trading_dates` value (ADR-0006).
 */
export async function collectNetworkSupplyPoints(
  options: CollectOptions,
): Promise<CollectResult> {
  const { bronzeDir, from, to } = options;
  const baseUrl = options.baseUrl ?? BLOB;

  const snapshots: Array<{ date: string; name: string }> = [];
  for (const name of await listNames(baseUrl, `${FOLDER}/`, options.fetch)) {
    const match = FILE_PATTERN.exec(name);
    if (!match) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (date >= from && date <= to) snapshots.push({ date, name });
  }
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  const result: CollectResult = { records: [], failed: [] };
  for (const { date, name } of snapshots) {
    try {
      result.records.push(
        await archiveFile({
          bronzeDir,
          dataset: DATASET,
          url: `${baseUrl}/${name}`,
          hubUrl: HUB_URL,
          tradingDates: [date],
          fetch: options.fetch,
        }),
      );
    } catch (error) {
      result.failed.push({ date, error: (error as Error).message });
    }
  }
  return result;
}
