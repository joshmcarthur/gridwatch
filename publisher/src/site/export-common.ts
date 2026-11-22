import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { GoldInput } from "../gold/common.ts";
import { lit } from "../silver/common.ts";
import {
  type CompletenessView,
  completenessKey,
} from "../silver/completeness.ts";
import type { SectionState, SiteDatasetStatus } from "./contract.ts";

export interface Section {
  name: "generation" | "prices" | "sankey" | "episodes" | "nodal_map";
  /** The first gold table. Its partition holds the section's `inputs_sha256`. */
  sentinel: string;
  inputs: readonly GoldInput[];
}

/** The `_completeness` datasets that a section reads. */
export const sectionDatasets = (section: Section) =>
  section.inputs.flatMap((input) =>
    input.completenessDataset === null ? [] : [input.completenessDataset],
  );

/** Round half away from zero. The sign is kept, and -0 becomes 0. */
export function round(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded =
    (Math.round(Math.abs(value) * factor) / factor) * Math.sign(value);
  return rounded === 0 ? 0 : rounded;
}

export const roundOrNull = (value: number | null, places: number) =>
  value === null ? null : round(value, places);

export const numberOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

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

/** The sentinel of a section on a date: its stamp, or null when gold has no partition. */
export interface Stamp {
  analysis_version: number;
  inputs_sha256: string;
  inputs_complete: boolean;
}

export async function readStamp(
  connection: DuckDBConnection,
  path: string,
): Promise<Stamp | null> {
  if (!existsSync(path)) return null;
  const reader = await connection.runAndReadAll(
    `SELECT any_value(analysis_version) AS analysis_version,
       any_value(inputs_sha256) AS inputs_sha256,
       bool_and(inputs_complete) AS inputs_complete
     FROM read_parquet(${lit(path)})`,
  );
  const [row] = reader.getRowObjectsJson() as Array<{
    analysis_version: unknown;
    inputs_sha256: unknown;
    inputs_complete: unknown;
  }>;
  if (!row || typeof row.inputs_sha256 !== "string") return null;
  return {
    analysis_version: Number(row.analysis_version),
    inputs_sha256: row.inputs_sha256,
    inputs_complete: row.inputs_complete === true,
  };
}

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
