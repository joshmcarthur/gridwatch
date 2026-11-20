import { dataPaths } from "../data-root.ts";
import { eachDate, parseDateRange } from "../date-range.ts";
import { publishGenerationMd } from "./generation-md.ts";

// npm run publish:generation-md -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Without --from, the run starts 12 months before --to (owner decision on #8).
// Exit code 1 if any day is invalid.
const range = parseDateRange();
const from = process.argv.includes("--from")
  ? range.from
  : Temporal.PlainDate.from(range.to).subtract({ months: 12 }).toString();
const { bronze, silver } = dataPaths();
let invalid = 0;
let missing = 0;
for (const date of eachDate(from, range.to)) {
  const result = await publishGenerationMd({
    bronzeDir: bronze,
    silverDir: silver,
    date,
  });
  if (result.status === "complete") console.log(`${date}: ${result.rows} rows`);
  else if (result.status === "partial")
    console.log(
      `${date}: PARTIAL ${result.rows} rows, missing periods ${result.missingPeriods.join(",")}`,
    );
  else if (result.status === "missing") missing++;
  else {
    invalid++;
    console.error(`${date}: INVALID ${result.errors.join("; ")}`);
  }
}
// The source lags by weeks, so a range often ends with days that have no data.
if (missing > 0) console.log(`${missing} days with no source data`);
process.exitCode = invalid > 0 ? 1 : 0;
