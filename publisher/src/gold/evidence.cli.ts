import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataPaths } from "../data-root.ts";
import { loadCompleteness } from "../silver/completeness.ts";
import { buildEvidencePackage, serializeEvidencePackage } from "./evidence.ts";

// npm run build:evidence -- --date YYYY-MM-DD --episode <episode_id>
// Writes <gold>/evidence/<date>/<episode_id>.json. It is not published to the site (ADR-0025).
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const date = option("date");
const episodeId = option("episode");
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
await writeFile(`${path}.tmp`, serializeEvidencePackage(pkg));
await rename(`${path}.tmp`, path);
console.log(`${path}: ${pkg.claims.length} claims`);
