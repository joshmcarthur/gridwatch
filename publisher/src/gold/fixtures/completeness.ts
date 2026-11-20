import {
  type CompletenessRow,
  type CompletenessView,
  completenessKey,
} from "../../silver/completeness.ts";

const row = (
  dataset: string,
  tradingDate: string,
  status: CompletenessRow["status"],
): CompletenessRow => ({
  dataset,
  tradingDate,
  status,
  expectedPeriodCount: null,
  actualPeriodCount: null,
  missingPeriods: [],
  bronzeSha256s: [],
  sourcePublishedAt: null,
  processedAt: "2026-11-20T00:00:00.000Z",
  errors: [],
});

/** A map that answers `complete` for a key that it does not hold. */
class CompleteByDefault extends Map<string, CompletenessRow> {
  override get(key: string) {
    const [dataset = "", date = ""] = key.split("\0");
    return super.get(key) ?? row(dataset, date, "complete");
  }
}

/**
 * A completeness view for a gold test: every dataset and date is `complete`, except the
 * `[dataset, date, status]` overrides.
 */
export function completenessView(
  overrides: ReadonlyArray<
    readonly [dataset: string, date: string, status: CompletenessRow["status"]]
  > = [],
): CompletenessView {
  return new CompleteByDefault(
    overrides.map(([dataset, date, status]) => [
      completenessKey(dataset, date),
      row(dataset, date, status),
    ]),
  );
}
