import { archiveFile, type ManifestRecord } from "../archive.ts";
import { eachDate } from "../date-range.ts";
import { BLOB, listNames } from "./blob.ts";

export const DATASET = "dispatch_energy_prices";
const FOLDER = "Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices";
const FILE_SUFFIX = "_DispatchEnergyPrices.csv"; // yyyymmdd + suffix, one file per trading day
const HUB_URL =
  "https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/dispatch-energy-prices/";

export interface CollectOptions {
  bronzeDir: string;
  /** First trading date, `YYYY-MM-DD`. */
  from: string;
  /** Last trading date, `YYYY-MM-DD`. */
  to: string;
  /** Override for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CollectResult {
  records: ManifestRecord[];
  /** Dates in the range that the source does not list. */
  missing: string[];
  /** Dates where the download failed. The run continues with the next date. */
  failed: Array<{ date: string; error: string }>;
}

/** Archive the daily files for the trading dates `from` to `to` (inclusive) into bronze. */
export async function collectDispatchEnergyPrices(
  options: CollectOptions,
): Promise<CollectResult> {
  const { bronzeDir, from, to } = options;
  const baseUrl = options.baseUrl ?? BLOB;
  const dates = eachDate(from, to);

  const listed = new Set<string>();
  for (const year of new Set(dates.map((d) => d.slice(0, 4)))) {
    for (const name of await listNames(
      baseUrl,
      `${FOLDER}/${year}/`,
      options.fetch,
    )) {
      listed.add(name);
    }
  }

  const result: CollectResult = { records: [], missing: [], failed: [] };
  for (const date of dates) {
    const name = `${FOLDER}/${date.slice(0, 4)}/${date.replaceAll("-", "")}${FILE_SUFFIX}`;
    if (!listed.has(name)) {
      result.missing.push(date);
      continue;
    }
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
