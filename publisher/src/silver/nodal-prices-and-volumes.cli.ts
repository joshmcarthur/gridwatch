import { dataPaths } from "../data-root.ts";
import { eachDate, parseDateRange } from "../date-range.ts";
import { publishNodalPricesAndVolumes } from "./nodal-prices-and-volumes.ts";

// npm run publish:nodal-prices-and-volumes -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Exit code 1 if any day is invalid.
const { from, to } = parseDateRange();
const { bronze, silver } = dataPaths();
let invalid = 0;
for (const date of eachDate(from, to)) {
  const result = await publishNodalPricesAndVolumes({
    bronzeDir: bronze,
    silverDir: silver,
    date,
  });
  if (result.status === "complete") console.log(`${date}: ${result.rows} rows`);
  else if (result.status === "partial")
    console.log(
      `${date}: PARTIAL ${result.rows} rows, missing periods ${result.missingPeriods.join(",")}`,
    );
  else if (result.status === "missing") console.log(`${date}: no bronze file`);
  else {
    invalid++;
    console.error(`${date}: INVALID ${result.errors.join("; ")}`);
  }
}
process.exitCode = invalid > 0 ? 1 : 0;
