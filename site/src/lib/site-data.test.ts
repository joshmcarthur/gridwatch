import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { formatTradingDate, loadSiteIndex } from "./site-data.ts";

const validIndex = {
  contract_version: 1,
  days: [
    {
      date: "2026-09-26",
      path: "days/2026-09-26.json",
      complete: true,
      sections: { generation: "complete", prices: "complete" },
      export_sha256: "a",
    },
  ],
  latest_complete: { generation_md: "2026-09-26" },
  latest_complete_sections: { generation: "2026-09-26", prices: null },
};

let dataRoot: string;
const previousDataRoot = process.env.DATA_ROOT;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gw-site-data-"));
  delete process.env.DATA_ROOT;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previousDataRoot;
  await rm(dataRoot, { recursive: true, force: true });
});

test("formatTradingDate throws when the date is not a calendar date", () => {
  expect(() => formatTradingDate("not-a-date")).toThrow();
  expect(() => formatTradingDate("2026-13-40")).toThrow();
});

test("formatTradingDate formats a trading date in en-NZ", () => {
  expect(formatTradingDate("2026-09-27")).toBe("Sunday, 27 September 2026");
});

test("loadSiteIndex uses the fixture when gold is absent", () => {
  process.env.DATA_ROOT = dataRoot;
  const index = loadSiteIndex();
  expect(index.days[0]?.date).toBe("2026-09-27");
});

test("loadSiteIndex returns gold when DATA_ROOT points at a valid index", async () => {
  await mkdir(join(dataRoot, "gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "gold/site/index.json"),
    JSON.stringify(validIndex),
  );
  process.env.DATA_ROOT = dataRoot;
  expect(loadSiteIndex()).toEqual(validIndex);
});

test("loadSiteIndex throws when gold is not a SiteIndex", async () => {
  await mkdir(join(dataRoot, "gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "gold/site/index.json"),
    JSON.stringify({ contract_version: 1 }),
  );
  process.env.DATA_ROOT = dataRoot;
  expect(() => loadSiteIndex()).toThrow();
});

test("loadSiteIndex does not load gold from a cwd-relative data path", async () => {
  await mkdir(join(dataRoot, "data/gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "data/gold/site/index.json"),
    JSON.stringify(validIndex),
  );
  const nested = join(dataRoot, "nested");
  await mkdir(nested);
  const previousCwd = process.cwd();
  process.chdir(nested);
  try {
    expect(loadSiteIndex()).not.toEqual(validIndex);
  } finally {
    process.chdir(previousCwd);
  }
});
