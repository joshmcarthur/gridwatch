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
import {
  type EvidenceSilverOptions,
  writeEvidenceSilver,
} from "./fixtures/evidence-27-july-silver.ts";

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

const silver = (options: Omit<EvidenceSilverOptions, "silverDir"> = {}) =>
  writeEvidenceSilver({ silverDir, ...options });

const build = (
  episodeId = EPISODE_ID,
  date = DAY,
  completeness = completenessView(),
) =>
  buildEvidencePackage({
    goldDir,
    silverDir,
    completeness,
    episodeId,
    date,
  });

const claimOf = (pkg: EvidencePackage, id: string) =>
  pkg.claims.find((claim) => claim.id === id);

// Catches: a claim without a source or level, a dangling depends_on, a path that links omit.
test("every claim has a source and a confirmed level, and its references resolve", async () => {
  await lake();
  await silver();
  const pkg = await build();
  expect(pkg.schema_version).toBe(EVIDENCE_SCHEMA_VERSION);
  expect(pkg.builder_version).toBe(BUILDER_VERSION);
  expect(pkg.claims.length).toBeGreaterThan(60);
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

// Catches: the dispatch rule storing the wrong publish, or counting nodes at one instant.
test("dispatch publishes of the peak period: highest publish and scarcity counts", async () => {
  await lake();
  await silver();
  const pkg = await build();
  const value = (id: string) => claimOf(pkg, id)?.value;
  expect(value("dispatch.energy.max_publish.p36")).toBe(22070.66);
  expect(value("dispatch.energy.max_publish_node.p36")).toBe("WEL0331");
  expect(value("dispatch.energy.max_publish_time.p36")).toBe(
    "2026-07-27T05:50:26Z",
  );
  expect(value("dispatch.energy.max_publish_seconds.p36")).toBe(85);
  expect(value("dispatch.energy.nodes_ge_20000.p36")).toBe(39);
  expect(value("dispatch.energy.nodes_ge_10000.p36")).toBe(207);
  expect(value("dispatch.sir.max_publish.p36")).toBe(6500);
  expect(value("dispatch.sir.max_publish_seconds.p36")).toBe(85);
  expect(value("dispatch.sir.nodes_ge_10000.p36")).toBe(0);
  expect(pkg.context.dispatch_peak.energy?.node).toBe("WEL0331");
  expect(claimOf(pkg, "dispatch.energy.max_publish.p36")?.source.kind).toBe(
    "silver",
  );
});

// Catches: a derived claim that is not tied to the values it came from.
test("the thermal ramp and the spread-with-HVDC join name their inputs", async () => {
  await lake();
  const pkg = await build();
  expect(pkg.window.start_trading_period).toBe(31);
  const ramp = claimOf(pkg, "generation.thermal_ramp.NI");
  expect(ramp?.value).toBe(484.4);
  expect(ramp?.depends_on).toEqual([
    "generation.thermal.NI.p32",
    "generation.thermal.NI.p36",
  ]);
  expect(claimOf(pkg, "generation.thermal.NI.p32")?.depends_on).toEqual([
    "generation.fuel.coal_gas.NI.p32",
    "generation.fuel.gas.NI.p32",
  ]);
  const join = claimOf(pkg, "separation.OTA2201-BEN2201.hvdc_north.p36");
  expect(join?.value).toBe(true);
  expect(join?.depends_on).toEqual([
    "spread.OTA2201-BEN2201.p36",
    "hvdc.direction.p36",
  ]);
});

// Catches: an operator or place invented for a plant or node that has no source row.
test("reference data is null where no row matches", async () => {
  await lake();
  await silver();
  const pkg = await build();
  const plant = (id: string) =>
    pkg.reference.plants.find((item) => item.plant_id === id);
  expect(plant("HLY/huntly_1_4")).toMatchObject({
    operator: "Genesis Energy Limited",
    points_of_connection: ["HLY2201"],
    latitude: -37.54,
    longitude: 175.15,
  });
  expect(plant("WTK/waitaki")).toMatchObject({
    operator: null,
    latitude: null,
  });
  expect(plant("OHK/ohakuri")).toMatchObject({
    operator: null,
    points_of_connection: [],
    longitude: null,
  });
  const node = (id: string) =>
    pkg.reference.points_of_connection.find(
      (item) => item.point_of_connection === id,
    );
  expect(node("OTA2201")).toMatchObject({ island: "NI", region: "Auckland" });
  expect(node("WEL0331")).toMatchObject({ description: null, latitude: null });
});

// Catches: silver status taken from the partition alone, not from _completeness.
test("a silver table takes its status from the completeness view", async () => {
  await lake();
  await silver({ omit: ["dispatch_energy_prices", "network_supply_points"] });
  const pkg = await build(
    EPISODE_ID,
    DAY,
    completenessView([["dispatch_reserve_prices", DAY, "partial"]]),
  );
  const status = (table: string) =>
    pkg.completeness.find((entry) => entry.table === table)?.status;
  expect(status("dispatch_energy_prices")).toBe("missing");
  expect(status("dispatch_reserve_prices")).toBe("partial");
  expect(status("entity_units")).toBe("complete");
  expect(status("network_supply_points")).toBe("missing");
  expect(pkg.context.dispatch_peak.energy).toBeNull();
  expect(pkg.claims.some((c) => c.id.startsWith("dispatch.energy."))).toBe(
    false,
  );
  expect(pkg.links.source_datasets).not.toContain("dispatch_energy_prices");
  expect(pkg.links.source_datasets).toContain("dispatch_reserve_prices");
  expect(claimOf(pkg, "dispatch.sir.max_publish.p36")?.note).toContain(
    "not complete",
  );
});

// Catches: claims written from an invalid silver table.
test("an invalid silver table gives no claim", async () => {
  await lake();
  await silver();
  const pkg = await build(
    EPISODE_ID,
    DAY,
    completenessView([["dispatch_energy_prices", DAY, "invalid"]]),
  );
  expect(
    pkg.completeness.find((entry) => entry.table === "dispatch_energy_prices")
      ?.status,
  ).toBe("invalid");
  expect(pkg.context.dispatch_peak.energy).toBeNull();
  expect(pkg.claims.some((c) => c.id.startsWith("dispatch.energy."))).toBe(
    false,
  );
});

// Catches: a derived claim that looks clean when its input carries the incomplete note.
test("derived claims carry the incomplete note of their inputs", async () => {
  await lake({ incomplete: ["generation_by_fuel_period"] });
  const pkg = await build();
  expect(claimOf(pkg, "generation.thermal_ramp.NI")?.note).toContain(
    "not complete",
  );
  expect(claimOf(pkg, "price.OTA2201.p36")?.note).toBeUndefined();
});

// Catches: the gas peakers dropped by a plain top-N cut.
test("North Island thermal plants are listed beyond the top ten", async () => {
  await lake();
  const pkg = await build();
  expect(Object.keys(pkg.context.generation_by_plant)).toContain(
    "SFD/stratford",
  );
});

// Catches: a corroborating observation leaking into the members, or a wrong-island, out-of-span,
// null-island or wrong-direction row being listed as related.
test("related observations overlap the episode on its island and are not members", async () => {
  await lake();
  const pkg = await build();
  expect(pkg.related_observations.map((o) => o.observation_id)).toEqual([
    "obs-demand-ni",
    "obs-fuel-wind-ni",
  ]);
  expect(pkg.observations.map((o) => o.observation_id)).toEqual([
    "obs-reserve-sir-ni-0727",
  ]);
});
