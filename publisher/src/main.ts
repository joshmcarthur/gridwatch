import { dataPaths } from "./data-root.ts";
import { datasets } from "./datasets.ts";
import {
  hasFailures,
  parseRunArgs,
  printSummary,
  runPublish,
  USAGE,
} from "./runner.ts";
import { completenessStatusLines } from "./silver/completeness.ts";

// docker compose run --rm publisher [--from YYYY-MM-DD --to YYYY-MM-DD] [--dataset ID]... [--force]
// docker compose run --rm publisher status
// Exit code 1 if any dataset failed. Exit code 2 for bad arguments.
const argv = process.argv.slice(2);
if (argv[0] === "status") {
  if (argv.length > 1) {
    console.error(`status takes no arguments\n\n${USAGE}`);
    process.exit(2);
  }
  const lines = await completenessStatusLines(dataPaths().silver, datasets);
  for (const line of lines) console.log(line);
} else {
  let args: ReturnType<typeof parseRunArgs>;
  try {
    args = parseRunArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
  } else {
    const { bronze, silver, gold } = dataPaths();
    const summaries = await runPublish({
      bronzeDir: bronze,
      silverDir: silver,
      goldDir: gold,
      range: args.range,
      force: args.force,
      only: args.only,
    });
    printSummary(summaries);
    process.exitCode = hasFailures(summaries) ? 1 : 0;
  }
}
