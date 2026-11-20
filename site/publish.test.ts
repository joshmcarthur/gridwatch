import {
  lstat,
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
import { type BuildFn, buildAndSwap } from "./publish.ts";

let outRoot: string;

beforeEach(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "gw-site-publish-"));
});

afterEach(async () => {
  await rm(outRoot, { recursive: true, force: true });
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 8, minute, 0));

const goodBuild: BuildFn = async (outDir) => {
  await writeFile(join(outDir, "index.html"), "<h1>site</h1>");
};

const releasesOf = async () =>
  (await readdir(join(outRoot, "releases"))).sort();

test("a successful build swaps current to a relative release symlink", async () => {
  const name = await buildAndSwap({ build: goodBuild, outRoot, now: at(0) });
  expect(name).toBe("20261121T080000Z");
  const link = join(outRoot, "current");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readlink(link)).toBe("releases/20261121T080000Z");
  expect(await readFile(join(link, "index.html"), "utf8")).toBe(
    "<h1>site</h1>",
  );
});

test("a second run repoints current to the new release", async () => {
  await buildAndSwap({ build: goodBuild, outRoot, now: at(0) });
  await buildAndSwap({ build: goodBuild, outRoot, now: at(1) });
  expect(await readlink(join(outRoot, "current"))).toBe(
    "releases/20261121T080100Z",
  );
});

test("a build that throws leaves no release and keeps current", async () => {
  await buildAndSwap({ build: goodBuild, outRoot, now: at(0) });
  const failing: BuildFn = async () => {
    throw new Error("astro failed");
  };
  await expect(
    buildAndSwap({ build: failing, outRoot, now: at(1) }),
  ).rejects.toThrow("astro failed");
  expect(await releasesOf()).toEqual(["20261121T080000Z"]);
  expect(await readlink(join(outRoot, "current"))).toBe(
    "releases/20261121T080000Z",
  );
});

test("a build with no index.html leaves no release and keeps current", async () => {
  await buildAndSwap({ build: goodBuild, outRoot, now: at(0) });
  const empty: BuildFn = async () => {};
  await expect(
    buildAndSwap({ build: empty, outRoot, now: at(1) }),
  ).rejects.toThrow(/no index.html/);
  expect(await releasesOf()).toEqual(["20261121T080000Z"]);
  expect(await readlink(join(outRoot, "current"))).toBe(
    "releases/20261121T080000Z",
  );
});

test("a second run in the same second fails and does not merge", async () => {
  await buildAndSwap({ build: goodBuild, outRoot, now: at(0) });
  await expect(
    buildAndSwap({ build: goodBuild, outRoot, now: at(0) }),
  ).rejects.toThrow(/EEXIST/);
  expect(await releasesOf()).toEqual(["20261121T080000Z"]);
});

test("five builds keep three releases and current points at the newest", async () => {
  for (let minute = 0; minute < 5; minute++) {
    await buildAndSwap({ build: goodBuild, outRoot, now: at(minute) });
  }
  expect(await releasesOf()).toEqual([
    "20261121T080200Z",
    "20261121T080300Z",
    "20261121T080400Z",
  ]);
  expect(await readlink(join(outRoot, "current"))).toBe(
    "releases/20261121T080400Z",
  );
});
