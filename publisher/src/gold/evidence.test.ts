import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  BUILDER_VERSION,
  buildEvidencePackage,
  EVIDENCE_SCHEMA_VERSION,
  type EvidencePackage,
} from "./evidence.ts";
import { completenessView } from "./fixtures/completeness.ts";
import {
  DAY,
  EPISODE_ID,
  type EvidenceLakeOptions,
  writeEvidenceGold,
} from "./fixtures/evidence-27-july.ts";

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-evidence-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const lake = (options: Omit<EvidenceLakeOptions, "goldDir"> = {}) =>
  writeEvidenceGold({ goldDir, ...options });

const build = (episodeId = EPISODE_ID, date = DAY) =>
  buildEvidencePackage({
    goldDir,
    silverDir,
    completeness: completenessView(),
    episodeId,
    date,
  });

const claimOf = (pkg: EvidencePackage, id: string) =>
  pkg.claims.find((claim) => claim.id === id);

// Catches: a claim without a source or level, a dangling depends_on, a path that links omit.
test("every claim has a source and a confirmed level, and its references resolve", async () => {
  await lake();
  const pkg = await build();
  expect(pkg.schema_version).toBe(EVIDENCE_SCHEMA_VERSION);
  expect(pkg.builder_version).toBe(BUILDER_VERSION);
  expect(pkg.claims.length).toBeGreaterThan(40);
  const ids = new Set(pkg.claims.map((claim) => claim.id));
  expect(ids.size).toBe(pkg.claims.length);
  const paths = new Set([
    ...pkg.links.gold_partitions,
    ...pkg.links.silver_partitions,
  ]);
  for (const claim of pkg.claims) {
    expect(claim.source.table, claim.id).not.toBe("");
    expect(claim.source.query_id, claim.id).not.toBe("");
    expect(claim.source.path, claim.id).not.toBe("");
    expect(claim.confidence, claim.id).toBe("confirmed");
    expect(paths.has(claim.source.path), `${claim.id} path in links`).toBe(
      true,
    );
    for (const dependency of claim.depends_on ?? [])
      expect(ids.has(dependency), `${claim.id} -> ${dependency}`).toBe(true);
  }
});

// Catches: the $20,459 publish washed out by the $3,296 period mean.
test("the highest publish sits beside the period mean", async () => {
  await lake();
  const pkg = await build();
  expect(pkg.window.peak_trading_period).toBe(36);
  expect(claimOf(pkg, "price.OTA2201.p36")?.value).toBe(3296.04);
  expect(claimOf(pkg, "price_max.OTA2201.p36")?.value).toBe(20459.18);
  expect(claimOf(pkg, "price_max.BEN2201.p36")?.value).toBe(9793.96);
});

// Catches: a package that describes a price event and misses the reserve event.
test("SIR is present for both islands", async () => {
  await lake();
  const pkg = await build();
  expect(claimOf(pkg, "reserve.SIR.NI.p36")?.value).toBe(2154.45);
  expect(claimOf(pkg, "reserve_max.SIR.NI.p36")?.value).toBe(6500);
  expect(claimOf(pkg, "reserve.SIR.SI.p36")?.value).toBe(0);
  expect(pkg.context.reserves.SIR?.NI?.price).toHaveLength(
    pkg.window.periods.length,
  );
});

// Catches: a skipped table, or a claim that survives from a table that is not there.
test("a missing or incomplete table is named in completeness and writes no claim", async () => {
  await lake({ omit: ["hvdc_transfer_period"], incomplete: ["price_spreads"] });
  const pkg = await build();
  const status = (table: string) =>
    pkg.completeness.find((entry) => entry.table === table)?.status;
  expect(status("hvdc_transfer_period")).toBe("missing");
  expect(status("price_spreads")).toBe("partial");
  expect(status("price_periods")).toBe("complete");
  expect(
    pkg.claims.some((claim) => claim.source.table === "hvdc_transfer_period"),
  ).toBe(false);
  expect(claimOf(pkg, "spread.OTA2201-BEN2201.p36")?.note).toContain(
    "inputs_complete = false",
  );
  expect(
    pkg.links.gold_partitions.some((path) =>
      path.includes("hvdc_transfer_period"),
    ),
  ).toBe(false);
  expect(
    pkg.context.hvdc.average_megawatts.every((value) => value === null),
  ).toBe(true);
});

// Catches: a clock reading or an unordered read in the package.
test("two builds give the same bytes", async () => {
  await lake();
  expect(JSON.stringify(await build())).toBe(JSON.stringify(await build()));
});

// Catches: a silent empty package for an id that is not an episode.
test("an unknown episode, a quiet day and a missing partition throw", async () => {
  await lake();
  await expect(build("nope")).rejects.toThrow(
    /episode nope is not in the episodes/,
  );
  await rm(goldDir, { recursive: true, force: true });
  await lake({ noEpisode: true });
  await expect(build()).rejects.toThrow(/is not in the episodes/);
  await rm(goldDir, { recursive: true, force: true });
  await lake({ omit: ["episodes"] });
  await expect(build()).rejects.toThrow(/no episodes partition/);
});

// Catches: a window that runs past the 46 periods of the day DST starts.
test("the window clamps on a 46-period day", async () => {
  const date = "2026-09-27";
  expect(periodsInTradingDate(date)).toBe(46);
  await lake({ date, episode: { start: 44, end: 46 } });
  const pkg = await build(EPISODE_ID, date);
  expect(pkg.window.end_trading_period).toBe(46);
  expect(pkg.window.start_trading_period).toBe(40);
  expect(pkg.window.periods).toEqual([40, 41, 42, 43, 44, 45, 46]);
  expect(pkg.context.prices.OTA2201?.price).toHaveLength(7);
});
