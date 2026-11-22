import type { GoldInput } from "../gold/common.ts";
import {
  INPUTS as ENERGY_BALANCE_INPUTS,
  TABLES as ENERGY_BALANCE_TABLES,
} from "../gold/energy-balance.ts";
import {
  INPUTS as EPISODE_INPUTS,
  TABLES as EPISODE_TABLES,
} from "../gold/episodes.ts";
import {
  INPUTS as GENERATION_INPUTS,
  TABLES as GENERATION_TABLES,
} from "../gold/generation.ts";
import {
  INPUTS as PRICE_INPUTS,
  TABLES as PRICE_TABLES,
} from "../gold/prices.ts";
import {
  INPUTS as RESERVE_INPUTS,
  TABLES as RESERVE_TABLES,
} from "../gold/reserves.ts";
import {
  type CompletenessView,
  completenessKey,
} from "../silver/completeness.ts";
import type { SectionState, SiteDatasetStatus } from "./contract.ts";
import type { Stamp } from "./gold-read.ts";

export interface Section {
  name: "generation" | "prices" | "reserves" | "sankey" | "episodes";
  /** The first gold table. Its partition holds the section's `inputs_sha256`. */
  sentinel: string;
  inputs: readonly GoldInput[];
}

export const GENERATION_SECTION: Section = {
  name: "generation",
  sentinel: GENERATION_TABLES[0],
  inputs: GENERATION_INPUTS,
};
export const PRICES_SECTION: Section = {
  name: "prices",
  sentinel: PRICE_TABLES[0],
  inputs: PRICE_INPUTS,
};
export const RESERVES_SECTION: Section = {
  name: "reserves",
  sentinel: RESERVE_TABLES[0],
  inputs: RESERVE_INPUTS,
};
export const SANKEY_SECTION: Section = {
  name: "sankey",
  sentinel: ENERGY_BALANCE_TABLES[0],
  inputs: ENERGY_BALANCE_INPUTS,
};
export const EPISODES_SECTION: Section = {
  name: "episodes",
  sentinel: EPISODE_TABLES[0],
  inputs: EPISODE_INPUTS,
};
export const SECTIONS: readonly Section[] = [
  GENERATION_SECTION,
  PRICES_SECTION,
  RESERVES_SECTION,
  SANKEY_SECTION,
  EPISODES_SECTION,
];

/** The `_completeness` datasets that a section reads. */
export const sectionDatasets = (section: Section) =>
  section.inputs.flatMap((input) =>
    input.completenessDataset === null ? [] : [input.completenessDataset],
  );

/** Every silver dataset that a section reads, sorted. */
export const DATASET_IDS = [
  ...new Set(SECTIONS.flatMap(sectionDatasets)),
].sort();

export const datasetStatus = (
  completeness: CompletenessView,
  dataset: string,
  date: string,
): SiteDatasetStatus => {
  const row = completeness.get(completenessKey(dataset, date));
  if (!row)
    return {
      status: "missing",
      expected_period_count: null,
      actual_period_count: null,
      missing_periods: [],
      bronze_sha256s: [],
      errors: [],
    };
  return {
    status: row.status,
    expected_period_count: row.expectedPeriodCount,
    actual_period_count: row.actualPeriodCount,
    missing_periods: row.missingPeriods,
    bronze_sha256s: row.bronzeSha256s,
    errors: row.errors,
  };
};

/** The state of a section, from its stamp and its input statuses (ADR-0014). */
export function sectionState(
  stamp: Stamp | null,
  section: Section,
  completeness: CompletenessView,
  date: string,
): SectionState {
  if (!stamp) return "missing";
  const inputs = section.inputs.every(
    (input) =>
      input.completenessDataset === null ||
      datasetStatus(completeness, input.completenessDataset, date).status ===
        "complete",
  );
  return stamp.inputs_complete && inputs ? "complete" : "incomplete";
}
