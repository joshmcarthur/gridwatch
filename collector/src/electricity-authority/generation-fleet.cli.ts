import { dataPaths } from "../data-root.ts";
import { parseDateRange } from "../date-range.ts";
import { collectGenerationFleet } from "./generation-fleet.ts";

// npm run collect:generation-fleet -- [--to YYYY-MM-DD]
// The source holds one current file. The snapshot date is `--to` (default yesterday in NZ).
// Exit code 1 if the download failed.
const { to } = parseDateRange();
try {
  const record = await collectGenerationFleet({
    bronzeDir: dataPaths().bronze,
    date: to,
  });
  console.log(`${record.status} (snapshot ${to})`);
} catch (error) {
  console.error(`FAILED ${(error as Error).message}`);
  process.exitCode = 1;
}
