import { archiveFile, type ManifestRecord } from "../archive.ts";

export const DATASET = "dispatch_energy_prices";
export const BLOB = "https://emidatasets.blob.core.windows.net/publicdata";
const FOLDER = "Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices";
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
}

/** List the blob names under `prefix`. Follows `NextMarker` until the listing ends. */
async function listNames(
  baseUrl: string,
  prefix: string,
  doFetch: typeof fetch,
): Promise<string[]> {
  const names: string[] = [];
  let marker = "";
  do {
    const url = `${baseUrl}?restype=container&comp=list&prefix=${prefix}${marker && `&marker=${marker}`}`;
    const response = await doFetch(url);
    if (!response.ok)
      throw new Error(`Listing ${url}: HTTP ${response.status}`);
    const xml = await response.text();
    for (const [, name] of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) {
      names.push(name as string);
    }
    marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? "";
  } while (marker);
  return names;
}

/** Archive the daily files for the trading dates `from` to `to` (inclusive) into bronze. */
export async function collectDispatchEnergyPrices(
  options: CollectOptions,
): Promise<CollectResult> {
  const { bronzeDir, from, to } = options;
  const baseUrl = options.baseUrl ?? BLOB;
  const doFetch = options.fetch ?? fetch;
  const first = Temporal.PlainDate.from(from);
  const last = Temporal.PlainDate.from(to);

  const listed = new Set<string>();
  for (let year = first.year; year <= last.year; year++) {
    for (const name of await listNames(
      baseUrl,
      `${FOLDER}/${year}/`,
      doFetch,
    )) {
      listed.add(name);
    }
  }

  const records: ManifestRecord[] = [];
  const missing: string[] = [];
  for (
    let day = first;
    Temporal.PlainDate.compare(day, last) <= 0;
    day = day.add({ days: 1 })
  ) {
    const date = day.toString();
    const name = `${FOLDER}/${day.year}/${date.replaceAll("-", "")}_DispatchEnergyPrices.csv`;
    if (!listed.has(name)) {
      missing.push(date);
      continue;
    }
    records.push(
      await archiveFile({
        bronzeDir,
        dataset: DATASET,
        url: `${baseUrl}/${name}`,
        hubUrl: HUB_URL,
        tradingDates: [date],
        fetch: options.fetch,
      }),
    );
  }
  return { records, missing };
}
