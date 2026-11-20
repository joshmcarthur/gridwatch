import { dataPaths } from "./data-root.ts";
import {
  hasFailures,
  parseRunArgs,
  printSummary,
  runCollect,
  USAGE,
} from "./runner.ts";

// docker compose run --rm collector [--from YYYY-MM-DD --to YYYY-MM-DD] [--dataset ID]...
// Exit code 1 if any dataset failed. Exit code 2 for bad arguments.
let args: ReturnType<typeof parseRunArgs>;
try {
  args = parseRunArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
} else {
  const summaries = await runCollect({
    bronzeDir: dataPaths().bronze,
    range: args.range,
    only: args.only,
  });
  printSummary(summaries);
  process.exitCode = hasFailures(summaries) ? 1 : 0;
}
