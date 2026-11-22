import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { dataPaths } from "../data-root.ts";
import { loadCompleteness } from "../silver/completeness.ts";
import { buildEvidencePackage, serializeEvidencePackage } from "./evidence.ts";

// npm run build:evidence -- --date YYYY-MM-DD --episode <episode_id>
// Writes <gold>/evidence/<date>/<episode_id>.json. It is not published to the site (ADR-0025).
const {
  values: { date, episode: episodeId },
} = parseArgs({
  options: { date: { type: "string" }, episode: { type: "string" } },
});
if (date === undefined || episodeId === undefined) {
  console.error(
    "usage: npm run build:evidence -- --date YYYY-MM-DD --episode <episode_id>",
  );
  process.exit(2);
}

const { silver, gold } = dataPaths();
const pkg = await buildEvidencePackage({
  goldDir: gold,
  silverDir: silver,
  completeness: await loadCompleteness(silver),
  episodeId,
  date,
});
const path = join(gold, "evidence", date, `${episodeId}.json`);
await mkdir(dirname(path), { recursive: true });
try {
  await writeFile(`${path}.tmp`, serializeEvidencePackage(pkg));
  await rename(`${path}.tmp`, path);
} finally {
  await rm(`${path}.tmp`, { force: true });
}
console.log(`${path}: ${pkg.claims.length} claims`);
