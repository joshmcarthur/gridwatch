import { spawn } from "node:child_process";
import { access, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// docker compose run --rm site-build
// Builds the site into the inactive slot (releases/a or releases/b), then points current at it.
// Exit code 1 if the build fails. The live site stays on the old slot.

export type Slot = "a" | "b";

export type BuildFn = (outDir: string) => Promise<void>;

function nextSlot(live: Slot | null): Slot {
  switch (live) {
    case "a":
      return "b";
    case "b":
      return "a";
    case null:
      return "a";
    default: {
      const _exhaustive: never = live;
      return _exhaustive;
    }
  }
}

async function liveSlot(outRoot: string): Promise<Slot | null> {
  const target = await readlink(join(outRoot, "current")).then(
    (value) => value,
    () => null,
  );
  switch (target) {
    case "releases/a":
      return "a";
    case "releases/b":
      return "b";
    default:
      return null;
  }
}

export async function buildAndSwap({
  build,
  outRoot,
}: {
  build: BuildFn;
  outRoot: string;
}): Promise<Slot> {
  const releasesDir = join(outRoot, "releases");
  await mkdir(releasesDir, { recursive: true });
  const slot = nextSlot(await liveSlot(outRoot));
  const lockDir = join(releasesDir, `.${slot}.lock`);
  // Exclusive: a second run on this slot fails here and does not touch the live slot.
  await mkdir(lockDir);
  const releaseDir = join(releasesDir, slot);
  try {
    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(releaseDir);
    await build(releaseDir);
    const hasIndex = await access(join(releaseDir, "index.html")).then(
      () => true,
      () => false,
    );
    if (!hasIndex) {
      throw new Error(`Build wrote no index.html to ${releaseDir}`);
    }
    await swap(outRoot, slot);
  } catch (error) {
    if ((await liveSlot(outRoot)) !== slot) {
      await rm(releaseDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
  return slot;
}

async function swap(outRoot: string, slot: Slot): Promise<void> {
  const tmp = join(outRoot, "current.tmp");
  await rm(tmp, { force: true });
  await symlink(join("releases", slot), tmp);
  try {
    await rename(tmp, join(outRoot, "current"));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function assertGoldIndex(
  dataRoot = process.env.DATA_ROOT ?? "/data",
): Promise<void> {
  const goldIndex = join(dataRoot, "gold/site/index.json");
  const present = await access(goldIndex).then(
    () => true,
    () => false,
  );
  if (!present) {
    throw new Error(
      `gold/site/index.json is missing at ${goldIndex}. Run the publisher first.`,
    );
  }
}

/** Fails if gold/site/index.json is missing, then runs Astro with SITE_REQUIRE_GOLD=1. */
export async function astroBuild(
  outDir: string,
  run: typeof spawn = spawn,
): Promise<void> {
  await assertGoldIndex();
  const siteDir = fileURLToPath(new URL(".", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = run("npm", ["run", "build", "--", "--outDir", outDir], {
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
    const slot = await buildAndSwap({ build: astroBuild, outRoot });
    console.log(
      `Published releases/${slot} at ${new Date().toISOString()} to ${outRoot}/current`,
    );
  } catch (error) {
    console.error(`Site publish failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
