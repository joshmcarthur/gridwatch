import { dataPaths } from "../data-root.ts";
import { eachDate, parseDateRange } from "../date-range.ts";
import { publishEntityMappings } from "./entity-mappings.ts";

// npm run publish:entity-mappings -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Run it after the silver datasets it reads. A date with no NSP snapshot on or before it is
// counted, not listed. Unmapped identifiers are in the `entity_unmapped` table. Exit code 1 if
// any day is invalid.
const { from, to } = parseDateRange();
const { silver } = dataPaths();
let invalid = 0;
let missing = 0;
for (const date of eachDate(from, to)) {
  const result = await publishEntityMappings({ silverDir: silver, date });
  if (result.status === "complete") {
    const r = result.rows;
    console.log(
      `${date}: ${r.entity_points_of_connection} POCs, ${r.entity_plants} plants, ${r.entity_units} units, ${r.entity_unmapped} unmapped`,
    );
  } else if (result.status === "missing") missing++;
  else {
    invalid++;
    console.error(`${date}: INVALID ${result.errors.join("; ")}`);
  }
}
if (missing > 0) console.log(`${missing} dates with no NSP snapshot`);
process.exitCode = invalid > 0 ? 1 : 0;
