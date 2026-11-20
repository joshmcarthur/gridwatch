import { archiveFile, type ManifestRecord } from "../archive.ts";
import { BLOB } from "./blob.ts";

export const DATASET = "generation_fleet";
const FILE =
  "Datasets/Wholesale/Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv";
const HUB_URL =
  "https://www.ea.govt.nz/data-and-insights/datasets/wholesale/generation/generation-fleet/";

export interface CollectOptions {
  bronzeDir: string;
  /**
   * Snapshot date, `YYYY-MM-DD`. The source file has no date and the source overwrites it in
   * place. The caller names the date that this check stands for (ADR-0006).
   */
  date: string;
  /** Override for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Archive the existing generation fleet file into bronze. A failed download throws. */
export function collectGenerationFleet(
  options: CollectOptions,
): Promise<ManifestRecord> {
  const baseUrl = options.baseUrl ?? BLOB;
  return archiveFile({
    bronzeDir: options.bronzeDir,
    dataset: DATASET,
    url: `${baseUrl}/${FILE}`,
    hubUrl: HUB_URL,
    tradingDates: [options.date],
    fetch: options.fetch,
  });
}
