import { dataPaths } from "./data-root.ts";
import {
  hasFailures,
  parseRunArgs,
  printSummary,
  runPublish,
  USAGE,
} from "./runner.ts";

// docker compose run --rm publisher [--from YYYY-MM-DD --to YYYY-MM-DD] [--dataset ID]... [--force]
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
  const { bronze, silver } = dataPaths();
  const summaries = await runPublish({
    bronzeDir: bronze,
    silverDir: silver,
    range: args.range,
    force: args.force,
    only: args.only,
  });
  printSummary(summaries);
  process.exitCode = hasFailures(summaries) ? 1 : 0;
}
