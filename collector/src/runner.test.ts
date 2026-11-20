import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readManifest } from "./archive.ts";
import { type CollectorDataset, datasets } from "./datasets.ts";
import {
  type DatasetSummary,
  hasFailures,
  parseRunArgs,
  runCollect,
} from "./runner.ts";

const BASE = "http://source.test";
const TODAY = "2026-11-20";
const EA = "Datasets/Wholesale";
const daily = (folder: string, suffix: string, date: string) =>
  `${EA}/${folder}/${date.slice(0, 4)}/${date.replaceAll("-", "")}${suffix}`;
const dispatch = (date: string) =>
  daily(
    "DispatchAndPricing/DispatchEnergyPrices",
    "_DispatchEnergyPrices.csv",
    date,
  );
const nodal = (date: string) =>
  daily(
    "DispatchAndPricing/NodalPricesAndVolumes",
    "_DispatchNodalPricesAndVolumes.csv",
    date,
  );

/** Blob name -> file body. A fake of the Azure container: listing, ETag and conditional GET. */
let files: Map<string, string>;
let requests: string[];
/** Listing prefixes that answer HTTP 503. */
let brokenPrefixes: string[];

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
  if (url.searchParams.get("comp") === "list") {
    const prefix = url.searchParams.get("prefix") ?? "";
    if (brokenPrefixes.some((p) => prefix.startsWith(p)))
      return new Response("", { status: 503 });
    const names = [...files.keys()].filter((n) => n.startsWith(prefix));
    return new Response(
      `<EnumerationResults><Blobs>${names.map((n) => `<Blob><Name>${n}</Name></Blob>`).join("")}</Blobs></EnumerationResults>`,
    );
  }
  const body = files.get(decodeURIComponent(url.pathname.slice(1)));
  if (body === undefined) return new Response("", { status: 404 });
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  const headers = new Headers(init?.headers);
  if (headers.get("If-None-Match") === etag)
    return new Response(null, { status: 304 });
  return new Response(body, { headers: { ETag: etag } });
};

let bronzeDir: string;
beforeEach(async () => {
  bronzeDir = await mkdtemp(join(tmpdir(), "gw-runner-"));
  requests = [];
  brokenPrefixes = [];
  files = new Map([
    [dispatch("2026-11-17"), "d17"],
    [dispatch("2026-11-18"), "d18"],
    [dispatch("2026-11-19"), "d19"],
    [nodal("2026-11-19"), "n19"],
    [`${EA}/Generation/Generation_MD/202610_Generation_MD.csv`, "md10"],
    [
      `${EA}/MappingsAndGeospatial/NetworkSupplyPointsTable/20261105_NetworkSupplyPointsTable.csv`,
      "nsp",
    ],
    [
      `${EA}/Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv`,
      "fleet",
    ],
  ]);
});
afterEach(() => rm(bronzeDir, { recursive: true, force: true }));

const run = (options: Partial<Parameters<typeof runCollect>[0]> = {}) =>
  runCollect({
    bronzeDir,
    today: TODAY,
    baseUrl: BASE,
    fetch: fakeFetch,
    ...options,
  });
const byId = (summaries: DatasetSummary[], id: string) => {
  const found = summaries.find((s) => s.id === id);
  if (!found) throw new Error(`no summary for ${id}`);
  return found;
};
const bronzeFiles = async () =>
  (await readdir(bronzeDir, { recursive: true }))
    .filter((p) => !p.endsWith("manifest.jsonl"))
    .sort();

test("the first run collects every dataset and a second run stores nothing new", async () => {
  const first = await run();
  expect(hasFailures(first)).toBe(false);
  expect(byId(first, "dispatch_energy_prices")).toMatchObject({
    from: "2025-11-20", // 12 months before the run date
    to: "2026-11-19",
    new: 3,
  });
  expect(byId(first, "nodal_prices_and_volumes").new).toBe(1);
  expect(byId(first, "generation_md").new).toBe(1);
  expect(byId(first, "network_supply_points").new).toBe(1);
  expect(byId(first, "generation_fleet").new).toBe(1);
  const filesAfterFirst = await bronzeFiles();

  const second = await run();
  expect(hasFailures(second)).toBe(false);
  for (const s of second) {
    expect([s.id, s.new, s.changed]).toEqual([s.id, 0, 0]);
  }
  // The trailing window fetched again, so the files were checked and found unchanged.
  expect(byId(second, "dispatch_energy_prices")).toMatchObject({
    from: "2026-11-15", // last run (19th) minus the trailing 5 days
    unchanged: 3,
  });
  expect(await bronzeFiles()).toEqual(filesAfterFirst);
  const records = await readManifest(bronzeDir);
  expect(records.filter((r) => r.status === "new")).toHaveLength(7);
});

test("a rewritten source file is stored as a changed version", async () => {
  await run();
  files.set(dispatch("2026-11-18"), "d18 revised");
  const summaries = await run();
  expect(byId(summaries, "dispatch_energy_prices")).toMatchObject({
    new: 0,
    changed: 1,
    unchanged: 2,
  });
});

test("one failing dataset is reported and the others still collect", async () => {
  brokenPrefixes = [`${EA}/DispatchAndPricing/NodalPricesAndVolumes`];
  const summaries = await run();
  expect(hasFailures(summaries)).toBe(true);
  expect(summaries.filter((s) => s.failed.length > 0).map((s) => s.id)).toEqual(
    ["nodal_prices_and_volumes"],
  );
  expect(byId(summaries, "nodal_prices_and_volumes").failed[0]).toContain(
    "HTTP 503",
  );
  expect(byId(summaries, "dispatch_energy_prices").new).toBe(3);
  expect(byId(summaries, "generation_fleet").new).toBe(1);
});

test("a failed file inside a dataset is reported and the dataset continues", async () => {
  const original = fakeFetch;
  const failing: typeof fetch = (input, init) =>
    String(input).includes("20261118_Dispatch")
      ? Promise.resolve(new Response("", { status: 403 }))
      : original(input, init);
  const summaries = await run({ fetch: failing });
  expect(byId(summaries, "dispatch_energy_prices")).toMatchObject({
    new: 2,
  });
  expect(byId(summaries, "dispatch_energy_prices").failed).toEqual([
    "2026-11-18: HTTP 403",
  ]);
});

test("--dataset limits the run and an explicit range replaces the default", async () => {
  const summaries = await run({
    only: ["dispatch_energy_prices"],
    range: { from: "2026-11-18", to: "2026-11-19" },
  });
  expect(summaries.map((s) => s.id)).toEqual(["dispatch_energy_prices"]);
  expect(summaries[0]).toMatchObject({
    from: "2026-11-18",
    to: "2026-11-19",
    new: 2,
  });
});

/** Fake registry entries that record the range they get, with the real range rules. */
function spies() {
  const seen: Record<string, { from: string; to: string }> = {};
  const registry: CollectorDataset[] = datasets.map((d) => ({
    ...d,
    collect: async ({ from, to }) => {
      seen[d.id] = { from, to };
      return { records: [], notListed: 0, failed: [] };
    },
  }));
  return { seen, registry };
}

test("default range, first run: 12 months before the injected run date", async () => {
  const { seen, registry } = spies();
  await runCollect({ bronzeDir, registry, today: "2028-02-29" });
  for (const id of [
    "dispatch_energy_prices",
    "nodal_prices_and_volumes",
    "generation_md",
    "network_supply_points",
  ]) {
    expect(seen[id], id).toEqual({ from: "2027-02-28", to: "2028-02-28" });
  }
});

test("default range, later runs, for each dataset kind", async () => {
  const rule = (id: string) => {
    const dataset = datasets.find((d) => d.id === id);
    if (!dataset) throw new Error(id);
    return dataset.defaultFrom;
  };
  // Daily files and snapshots. To is yesterday (19 Nov). The window is 15 to 19 Nov.
  expect(
    rule("dispatch_energy_prices")("2026-11-19", "2026-11-19", TODAY),
  ).toBe("2026-11-15");
  expect(
    rule("dispatch_energy_prices")("2026-11-18", "2026-11-19", TODAY),
  ).toBe("2026-11-15");
  // The collector was off for a while. Start at the last date held.
  expect(
    rule("nodal_prices_and_volumes")("2026-11-01", "2026-11-19", TODAY),
  ).toBe("2026-11-01");
  expect(rule("network_supply_points")("2026-11-05", "2026-11-19", TODAY)).toBe(
    "2026-11-05",
  );
  // Monthly files: the run month and the two before it, or older if the last month held is older.
  expect(rule("generation_md")("2026-11-30", "2026-11-19", TODAY)).toBe(
    "2026-09-01",
  );
  expect(rule("generation_md")("2026-10-31", "2026-11-19", TODAY)).toBe(
    "2026-09-01",
  );
  expect(rule("generation_md")("2026-06-30", "2026-11-19", TODAY)).toBe(
    "2026-06-01",
  );
});

test("parseRunArgs", () => {
  expect(parseRunArgs([], TODAY)).toEqual({
    help: false,
    range: undefined,
    only: undefined,
  });
  expect(
    parseRunArgs(["--from", "2026-11-01", "--dataset", "generation_md"], TODAY),
  ).toMatchObject({
    range: { from: "2026-11-01", to: "2026-11-19" },
    only: ["generation_md"],
  });
  expect(() => parseRunArgs(["--to", "2026-11-01"], TODAY)).toThrow("--from");
  expect(() => parseRunArgs(["--dataset", "nope"], TODAY)).toThrow("Unknown");
  expect(() =>
    parseRunArgs(["--from", "2026-11-05", "--to", "2026-11-01"], TODAY),
  ).toThrow("after");
  expect(() => parseRunArgs(["--from", "2026-13-01"], TODAY)).toThrow();
});
