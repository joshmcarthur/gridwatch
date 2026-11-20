import { dataPaths } from "../data-root.ts";
import { eachDate, parseDateRange } from "../date-range.ts";
import { publishNetworkSupplyPoints } from "./network-supply-points.ts";

// npm run publish:network-supply-points -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// The source does not publish a snapshot every day, so a date with no bronze file is counted,
// not listed. Exit code 1 if any snapshot is invalid.
const { from, to } = parseDateRange();
const { bronze, silver } = dataPaths();
let invalid = 0;
let missing = 0;
for (const date of eachDate(from, to)) {
  const result = await publishNetworkSupplyPoints({
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
