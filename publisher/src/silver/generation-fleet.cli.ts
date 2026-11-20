import { dataPaths } from "../data-root.ts";
import { eachDate, parseDateRange } from "../date-range.ts";
import { publishGenerationFleet } from "./generation-fleet.ts";

// npm run publish:generation-fleet -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// The collector labels each check with one snapshot date, so most dates in a long range have no
// bronze file. They are counted, not listed. Exit code 1 if any snapshot is invalid.
const { from, to } = parseDateRange();
const { bronze, silver } = dataPaths();
let invalid = 0;
let missing = 0;
for (const date of eachDate(from, to)) {
  const result = await publishGenerationFleet({
    bronzeDir: bronze,
    silverDir: silver,
    date,
  });
  if (result.status === "complete") console.log(`${date}: ${result.rows} rows`);
  else if (result.status === "missing") missing++;
  else if (result.status === "invalid") {
    invalid++;
    console.error(`${date}: INVALID ${result.errors.join("; ")}`);
  }
}
if (missing > 0) console.log(`${missing} dates with no snapshot`);
process.exitCode = invalid > 0 ? 1 : 0;
