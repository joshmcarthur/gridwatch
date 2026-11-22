import type { GoldInput } from "../gold/common.ts";
import {
  type CompletenessView,
  completenessKey,
} from "../silver/completeness.ts";
import type { SectionState, SiteDatasetStatus } from "./contract.ts";
import type { Stamp } from "./gold-read.ts";

export interface Section {
  name:
    | "generation"
    | "prices"
    | "sankey"
    | "episodes"
    | "reserves"
    | "nodal_map";
  /** The first gold table. Its partition holds the section's `inputs_sha256`. */
  sentinel: string;
  inputs: readonly GoldInput[];
}

/** The `_completeness` datasets that a section reads. */
export const sectionDatasets = (section: Section) =>
  section.inputs.flatMap((input) =>
    input.completenessDataset === null ? [] : [input.completenessDataset],
  );

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
