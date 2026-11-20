import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { astroBuild, type BuildFn, buildAndSwap } from "./publish.ts";

let outRoot: string;
const previousDataRoot = process.env.DATA_ROOT;

beforeEach(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "gw-site-publish-"));
  delete process.env.DATA_ROOT;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previousDataRoot;
  await rm(outRoot, { recursive: true, force: true });
});

const buildWith = (body: string): BuildFn => {
  return async (outDir) => {
    await writeFile(join(outDir, "index.html"), body);
  };
};

const goodBuild = buildWith("<h1>site</h1>");

const releasesOf = async () =>
  (await readdir(join(outRoot, "releases"))).sort();

test("the first publish writes slot a and points current at it", async () => {
  const slot = await buildAndSwap({ build: goodBuild, outRoot });
  expect(slot).toBe("a");
  const link = join(outRoot, "current");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readlink(link)).toBe("releases/a");
  expect(await readFile(join(link, "index.html"), "utf8")).toBe(
    "<h1>site</h1>",
  );
  expect(await releasesOf()).toEqual(["a"]);
});

test("a second publish writes the other slot and leaves the previous slot", async () => {
  await buildAndSwap({ build: buildWith("first"), outRoot });
  const slot = await buildAndSwap({ build: buildWith("second"), outRoot });
  expect(slot).toBe("b");
  expect(await readlink(join(outRoot, "current"))).toBe("releases/b");
  expect(await readFile(join(outRoot, "current", "index.html"), "utf8")).toBe(
    "second",
  );
  expect(
    await readFile(join(outRoot, "releases/a", "index.html"), "utf8"),
  ).toBe("first");
  expect(await releasesOf()).toEqual(["a", "b"]);
});

test("a third publish overwrites the older slot", async () => {
  await buildAndSwap({ build: buildWith("first"), outRoot });
  await buildAndSwap({ build: buildWith("second"), outRoot });
  const slot = await buildAndSwap({ build: buildWith("third"), outRoot });
  expect(slot).toBe("a");
  expect(await readlink(join(outRoot, "current"))).toBe("releases/a");
  expect(await readFile(join(outRoot, "current", "index.html"), "utf8")).toBe(
    "third",
  );
  expect(
    await readFile(join(outRoot, "releases/b", "index.html"), "utf8"),
  ).toBe("second");
});

test("a failed build leaves current on the old slot and does not destroy it", async () => {
  await buildAndSwap({ build: goodBuild, outRoot });
  const failing: BuildFn = async (outDir) => {
    await writeFile(join(outDir, "index.html"), "partial");
    throw new Error("astro failed");
  };
  await expect(buildAndSwap({ build: failing, outRoot })).rejects.toThrow(
    "astro failed",
  );
  expect(await releasesOf()).toEqual(["a"]);
  expect(await readlink(join(outRoot, "current"))).toBe("releases/a");
  expect(await readFile(join(outRoot, "current", "index.html"), "utf8")).toBe(
    "<h1>site</h1>",
  );
});

test("a build with no index.html does not swap", async () => {
  await buildAndSwap({ build: goodBuild, outRoot });
  const empty: BuildFn = async () => {};
  await expect(buildAndSwap({ build: empty, outRoot })).rejects.toThrow(
    /no index.html/,
  );
  expect(await releasesOf()).toEqual(["a"]);
  expect(await readlink(join(outRoot, "current"))).toBe("releases/a");
});

test("two runs on the same inactive slot fail closed without deleting the live slot", async () => {
  await buildAndSwap({ build: goodBuild, outRoot });
  await mkdir(join(outRoot, "releases/.b.lock"));
  await expect(buildAndSwap({ build: goodBuild, outRoot })).rejects.toThrow(
    /EEXIST/,
  );
  expect(await readlink(join(outRoot, "current"))).toBe("releases/a");
  expect(await readFile(join(outRoot, "current", "index.html"), "utf8")).toBe(
    "<h1>site</h1>",
  );
});

test("a swap that fails leaves no slot and no temporary link", async () => {
  // A real directory at current: rename(2) cannot replace it with a symlink.
  await mkdir(join(outRoot, "current"));
  await expect(buildAndSwap({ build: goodBuild, outRoot })).rejects.toThrow();
  expect(await releasesOf()).toEqual([]);
  expect(
    await lstat(join(outRoot, "current.tmp")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("astroBuild fails closed before spawn when gold/site/index.json is missing", async () => {
  process.env.DATA_ROOT = join(outRoot, "data");
  const calls: string[] = [];
  const fakeSpawn = ((command: string) => {
    calls.push(command);
    const child = new EventEmitter();
    process.nextTick(() => child.emit("exit", 0));
    return child;
  }) as unknown as typeof spawn;
  await expect(astroBuild(join(outRoot, "release"), fakeSpawn)).rejects.toThrow(
    /gold\/site\/index\.json is missing/,
  );
  expect(calls).toHaveLength(0);
});

test("the astro build runs with SITE_REQUIRE_GOLD=1 in the child environment", async () => {
  process.env.DATA_ROOT = join(outRoot, "data");
  await mkdir(join(outRoot, "data/gold/site"), { recursive: true });
  await writeFile(join(outRoot, "data/gold/site/index.json"), "{}");
  const calls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  const fakeSpawn = ((
    command: string,
    _args: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, env: options.env });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("exit", 0));
    return child;
  }) as unknown as typeof spawn;
  await astroBuild(join(outRoot, "release"), fakeSpawn);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.env?.SITE_REQUIRE_GOLD).toBe("1");
});
