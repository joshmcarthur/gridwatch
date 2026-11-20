import { dataPaths } from "../data-root.ts";
import { parseDateRange } from "../date-range.ts";
import { collectNetworkSupplyPoints } from "./network-supply-points.ts";

// npm run collect:network-supply-points -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Exit code 1 if any download failed.
const { from, to } = parseDateRange();
const { records, failed } = await collectNetworkSupplyPoints({
  bronzeDir: dataPaths().bronze,
  from,
  to,
});
const count = (status: string) =>
  records.filter((r) => r.status === status).length;
console.log(
  `new ${count("new")}, changed ${count("changed")}, unchanged ${count("unchanged")}`,
);
for (const f of failed) console.error(`${f.date}: FAILED ${f.error}`);
process.exitCode = failed.length > 0 ? 1 : 0;
