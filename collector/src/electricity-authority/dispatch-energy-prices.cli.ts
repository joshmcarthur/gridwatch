import { parseArgs } from "node:util";
import { dataPaths } from "../data-root.ts";
import { collectDispatchEnergyPrices } from "./dispatch-energy-prices.ts";

// npm run collect:dispatch-energy-prices -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Both default to yesterday in NZ. The backfill runner picks wider ranges.
const yesterday = Temporal.Now.plainDateISO("Pacific/Auckland")
  .subtract({ days: 1 })
  .toString();
const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string", default: yesterday },
  },
});

const { records, missing } = await collectDispatchEnergyPrices({
  bronzeDir: dataPaths().bronze,
  from: values.from ?? values.to ?? yesterday,
  to: values.to ?? yesterday,
});
const count = (status: string) =>
  records.filter((r) => r.status === status).length;
console.log(
  `new ${count("new")}, changed ${count("changed")}, unchanged ${count("unchanged")}`,
);
if (missing.length > 0)
  console.log(`not listed by source: ${missing.join(", ")}`);
