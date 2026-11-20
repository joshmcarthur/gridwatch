import { dataPaths } from "../data-root.ts";
import { parseDateRange } from "../date-range.ts";
import { collectGenerationMd } from "./generation-md.ts";

// npm run collect:generation-md -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Without --from, the run starts 12 months before --to (owner decision on #8).
// Exit code 1 if any download failed.
const range = parseDateRange();
const from = process.argv.includes("--from")
  ? range.from
  : Temporal.PlainDate.from(range.to).subtract({ months: 12 }).toString();
const { records, missing, failed } = await collectGenerationMd({
  bronzeDir: dataPaths().bronze,
  from,
  to: range.to,
});
const count = (status: string) =>
  records.filter((r) => r.status === status).length;
console.log(
  `new ${count("new")}, changed ${count("changed")}, unchanged ${count("unchanged")}`,
);
if (missing.length > 0)
  console.log(`not listed by source: ${missing.join(", ")}`);
for (const f of failed) console.error(`${f.month}: FAILED ${f.error}`);
process.exitCode = failed.length > 0 ? 1 : 0;
