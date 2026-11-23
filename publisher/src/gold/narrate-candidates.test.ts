import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goldPartitionPath } from "./common.ts";
import type { EvidencePackage } from "./evidence.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { writeParquet } from "./fixtures/parquet.ts";
import { narrateCandidates } from "./narrate-candidates.ts";
import type { CompleteNarrative } from "./narrative.ts";

const DATE = "2026-07-27";
const EPISODE_ID = "abc123";

const fakePackage = (episodeId: string): EvidencePackage =>
  ({
    episode: {
      episode_id: episodeId,
      trading_date: DATE,
      start_trading_period: 36,
      end_trading_period: 39,
      observation_types: ["price_high"],
      islands: ["NI"],
      severity: 1,
    },
    claims: [
      {
        id: "price.OTA2201.p36",
        label: "Otahuhu period price",
        value: 3296.04,
        unit: "$/MWh",
        confidence: "confirmed",
      },
    ],
    limits: [],
    links: { daily_page: "/2026/07/27/" },
    completeness: [{ table: "episodes", status: "complete" }],
  }) as unknown as EvidencePackage;

let root: string;
let goldDir: string;
let silverDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-narrate-"));
  goldDir = join(root, "gold");
  silverDir = join(root, "silver");
  await mkdir(goldDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function writeRanking(
  rows: Array<{ episode_id: string; is_candidate: boolean }>,
) {
  await writeParquet(
    goldPartitionPath(goldDir, "episode_ranking_days", DATE),
    {
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [{ analysis_version: 1, inputs_sha256: "x", inputs_complete: true }],
  );
  await writeParquet(
    goldPartitionPath(goldDir, "episode_scores", DATE),
    {
      episode_id: "VARCHAR",
      is_candidate: "BOOLEAN",
      day_rank: "INTEGER",
    },
    rows.map((row, i) => ({ ...row, day_rank: i + 1 })),
  );
}

const run = (
  complete: CompleteNarrative,
  extra: Partial<Parameters<typeof narrateCandidates>[0]> = {},
) =>
  narrateCandidates({
    goldDir,
    silverDir,
    completeness: completenessView(),
    force: false,
    complete,
    model: "test-model",
    now: new Date("2026-11-23T00:00:00Z"),
    buildPackage: async ({ episodeId }) => fakePackage(episodeId),
    ...extra,
  });

test("writes evidence and a narrative for each ranked candidate", async () => {
  await writeRanking([
    { episode_id: EPISODE_ID, is_candidate: true },
    { episode_id: "skip-me", is_candidate: false },
  ]);
  const result = await run(async () =>
    JSON.stringify({
      what_happened: "Prices rose.",
      why: "Thermal ramped.",
      what_it_means: "The islands split.",
    }),
  );
  expect(result).toEqual({ written: 1, skipped: 0, failed: [] });
  const narrative = JSON.parse(
    await readFile(
      join(goldDir, "narratives", DATE, `${EPISODE_ID}.json`),
      "utf8",
    ),
  ) as { episode_id: string; model: string };
  expect(narrative.episode_id).toBe(EPISODE_ID);
  expect(narrative.model).toBe("test-model");
  expect(existsSync(join(goldDir, "narratives", DATE, "skip-me.json"))).toBe(
    false,
  );
  expect(
    existsSync(join(goldDir, "evidence", DATE, `${EPISODE_ID}.json`)),
  ).toBe(true);
});

test("skips a narrative that already exists unless force is set", async () => {
  await writeRanking([{ episode_id: EPISODE_ID, is_candidate: true }]);
  const path = join(goldDir, "narratives", DATE, `${EPISODE_ID}.json`);
  await mkdir(join(goldDir, "narratives", DATE), { recursive: true });
  await writeFile(path, "held\n");
  const first = await run(async () => {
    throw new Error("must not call");
  });
  expect(first).toEqual({ written: 0, skipped: 1, failed: [] });
  expect(await readFile(path, "utf8")).toBe("held\n");
  const second = await run(
    async () =>
      JSON.stringify({
        what_happened: "Prices rose.",
        why: "Thermal ramped.",
        what_it_means: "The islands split.",
      }),
    { force: true },
  );
  expect(second).toEqual({ written: 1, skipped: 0, failed: [] });
  expect(await readFile(path, "utf8")).toContain("Prices rose.");
});

test("one failed episode does not stop the rest", async () => {
  await writeRanking([
    { episode_id: "bad", is_candidate: true },
    { episode_id: "good", is_candidate: true },
  ]);
  const result = await run(async ({ user }) => {
    if (user.includes("bad")) throw new Error("openrouter down");
    return JSON.stringify({
      what_happened: "Prices rose.",
      why: "Thermal ramped.",
      what_it_means: "The islands split.",
    });
  });
  expect(result.written).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.failed).toEqual([`${DATE} bad: openrouter down`]);
  expect(existsSync(join(goldDir, "narratives", DATE, "good.json"))).toBe(true);
});
