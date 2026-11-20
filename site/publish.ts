import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// docker compose run --rm site-build
// Builds the site into releases/<UTC timestamp>, then points current at it.
// Exit code 1 if the build fails. The live site stays on the old release.

export const KEEP_RELEASES = 3;

export type BuildFn = (outDir: string) => Promise<void>;

/** UTC timestamp without colons, for example 20261121T081500Z. */
export function releaseName(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function buildAndSwap({
  build,
  outRoot,
  now = new Date(),
}: {
  build: BuildFn;
  outRoot: string;
  now?: Date;
}): Promise<string> {
  const releasesDir = join(outRoot, "releases");
  const name = releaseName(now);
  const releaseDir = join(releasesDir, name);
  await mkdir(releasesDir, { recursive: true });
  // Non-recursive: a second run in the same second fails here, and does not merge.
  await mkdir(releaseDir);
  try {
    await build(releaseDir);
    if (!existsSync(join(releaseDir, "index.html"))) {
      throw new Error(`Build wrote no index.html to ${releaseDir}`);
    }
    await swap(outRoot, name);
  } catch (error) {
    await rm(releaseDir, { recursive: true, force: true });
    throw error;
  }
  await prune(releasesDir, name);
  return name;
}

async function swap(outRoot: string, name: string): Promise<void> {
  const tmp = join(outRoot, "current.tmp");
  await rm(tmp, { force: true });
  await symlink(join("releases", name), tmp);
  await rename(tmp, join(outRoot, "current"));
}

async function prune(releasesDir: string, live: string): Promise<void> {
  const names = (await readdir(releasesDir)).sort();
  const kept = names.slice(-KEEP_RELEASES);
  if (!kept.includes(live)) {
    throw new Error(`Refusing to prune: live release ${live} is not kept`);
  }
  for (const name of names.slice(0, -KEEP_RELEASES)) {
    await rm(join(releasesDir, name), { recursive: true, force: true });
  }
}

/** Runs the Astro build with SITE_REQUIRE_GOLD=1, so it never falls back to fixtures. */
export function astroBuild(outDir: string): Promise<void> {
  const siteDir = fileURLToPath(new URL(".", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build", "--", "--outDir", outDir], {
      cwd: siteDir,
      env: { ...process.env, SITE_REQUIRE_GOLD: "1" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`astro build exited with code ${code}`));
    });
  });
}

if (import.meta.main) {
  const outRoot = fileURLToPath(new URL("../site-out", import.meta.url));
  try {
    const name = await buildAndSwap({ build: astroBuild, outRoot });
    console.log(`Published releases/${name} to ${outRoot}/current`);
  } catch (error) {
    console.error(`Site publish failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
