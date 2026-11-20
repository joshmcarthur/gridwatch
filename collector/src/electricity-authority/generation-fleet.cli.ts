import { parseArgs } from "node:util";
import { dataPaths } from "../data-root.ts";
import { collectGenerationFleet } from "./generation-fleet.ts";

// npm run collect:generation-fleet
// The source holds one current file. The snapshot date is today in NZ.
// Exit code 1 if the download failed.
parseArgs({ args: process.argv.slice(2), strict: true, options: {} });
const date = Temporal.Now.plainDateISO("Pacific/Auckland").toString();
try {
  const record = await collectGenerationFleet({
    bronzeDir: dataPaths().bronze,
    date,
  });
  console.log(`${record.status} (snapshot ${date})`);
} catch (error) {
  console.error(`FAILED ${(error as Error).message}`);
  process.exitCode = 1;
}
