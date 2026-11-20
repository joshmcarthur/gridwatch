import { archiveFile, type ManifestRecord } from "../archive.ts";
import { eachDate } from "../date-range.ts";
import { BLOB, listNames } from "./blob.ts";

export const DATASET = "generation_md";
const FOLDER = "Datasets/Wholesale/Generation/Generation_MD";
const FILE_PATTERN = /\/(\d{4})(\d{2})_Generation_MD\.csv$/; // one file per calendar month
const HUB_URL =
  "https://www.ea.govt.nz/data-and-insights/datasets/wholesale/generation/generation-output/";

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
  /** Months (`YYYY-MM`) in the range that the source does not list. The source lags by weeks. */
  missing: string[];
  /** Months where the download failed. The run continues with the next month. */
  failed: Array<{ month: string; error: string }>;
}

/** Every trading date of a month, `YYYY-MM`. */
function datesOfMonth(month: string): string[] {
  const first = Temporal.PlainDate.from(`${month}-01`);
  const last = first.add({ months: 1 }).subtract({ days: 1 });
  return eachDate(first.toString(), last.toString());
}

/**
 * Archive the monthly files that overlap the trading dates `from` to `to` (inclusive) into
 * bronze. The manifest `trading_dates` lists every date of the month, so `findBronze` works
 * for each day. The file may hold fewer days, because the source can publish a month part
 * way. The publisher reports those days as missing (ADR-0007).
 */
export async function collectGenerationMd(
  options: CollectOptions,
): Promise<CollectResult> {
  const { bronzeDir, from, to } = options;
  const baseUrl = options.baseUrl ?? BLOB;

  const listed = new Map<string, string>(); // month -> blob name
  for (const name of await listNames(baseUrl, `${FOLDER}/`, options.fetch)) {
    const match = FILE_PATTERN.exec(name);
    if (match) listed.set(`${match[1]}-${match[2]}`, name);
  }

  const result: CollectResult = { records: [], missing: [], failed: [] };
  const months = new Set(eachDate(from, to).map((d) => d.slice(0, 7)));
  for (const month of months) {
    const name = listed.get(month);
    if (!name) {
      result.missing.push(month);
      continue;
    }
    try {
      result.records.push(
        await archiveFile({
          bronzeDir,
          dataset: DATASET,
          url: `${baseUrl}/${name}`,
          hubUrl: HUB_URL,
          tradingDates: datesOfMonth(month),
          fetch: options.fetch,
        }),
      );
    } catch (error) {
      result.failed.push({ month, error: (error as Error).message });
    }
  }
  return result;
}
