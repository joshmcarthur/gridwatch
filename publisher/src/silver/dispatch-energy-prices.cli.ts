import { parseArgs } from "node:util";
import { dataPaths } from "../data-root.ts";
import { publishDispatchEnergyPrices } from "./dispatch-energy-prices.ts";

// npm run publish:dispatch-energy-prices -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Both default to yesterday in NZ. Exit code 1 if any day is invalid.
const yesterday = Temporal.Now.plainDateISO("Pacific/Auckland")
  .subtract({ days: 1 })
  .toString();
const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string", default: yesterday },
  },
});
const to = Temporal.PlainDate.from(values.to ?? yesterday);
const from = Temporal.PlainDate.from(values.from ?? to.toString());

const { bronze, silver } = dataPaths();
let invalid = 0;
for (
  let day = from;
  Temporal.PlainDate.compare(day, to) <= 0;
  day = day.add({ days: 1 })
) {
  const result = await publishDispatchEnergyPrices({
    bronzeDir: bronze,
    silverDir: silver,
    date: day.toString(),
  });
  if (result.status === "ok")
    console.log(`${result.date}: ${result.rows} rows`);
  else if (result.status === "missing")
    console.log(`${result.date}: no bronze file`);
  else {
    invalid++;
    console.error(`${result.date}: INVALID ${result.errors.join("; ")}`);
  }
}
process.exitCode = invalid > 0 ? 1 : 0;
