import { dataPaths } from "../data-root.ts";
import { parseDateRange } from "../date-range.ts";
import { collectDispatchReservePrices } from "./dispatch-reserve-prices.ts";

// npm run collect:dispatch-reserve-prices -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Exit code 1 if any download failed.
const { from, to } = parseDateRange();
const { records, missing, failed } = await collectDispatchReservePrices({
  bronzeDir: dataPaths().bronze,
  from,
  to,
});
const count = (status: string) =>
  records.filter((r) => r.status === status).length;
console.log(
  `new ${count("new")}, changed ${count("changed")}, unchanged ${count("unchanged")}`,
);
if (missing.length > 0)
  console.log(`not listed by source: ${missing.join(", ")}`);
for (const f of failed) console.error(`${f.date}: FAILED ${f.error}`);
process.exitCode = failed.length > 0 ? 1 : 0;
