import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildEvidencePackage, type EvidencePackage } from "./evidence.ts";
import { completenessView } from "./fixtures/completeness.ts";
import {
  DAY,
  EPISODE_ID,
  writeEvidenceGold,
} from "./fixtures/evidence-27-july.ts";
import { writeEvidenceSilver } from "./fixtures/evidence-27-july-silver.ts";

/**
 * The #21 write-up as a checklist (acceptance of #38). Each fact is a claim, a value in a context
 * series, or a named gap. The facts file is the only link to the write-up.
 */
interface Fact {
  fact_id: string;
  claim_id_expected: string | null;
  value: number | string | boolean;
  unit: string;
  write_up_query: string;
  status: "claim" | "series" | "gap";
  decimals?: number;
  tolerance?: number;
  series?: string;
  period?: number | null;
  gap_reason?: string;
}

const facts = (
  JSON.parse(
    readFileSync(
      new URL("./fixtures/evidence-27-july.facts.json", import.meta.url),
      "utf8",
    ),
  ) as { facts: Fact[] }
).facts;

let root: string;
let pkg: EvidencePackage;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-evidence-facts-"));
  const goldDir = join(root, "gold");
  const silverDir = join(root, "silver");
  await writeEvidenceGold({ goldDir });
  await writeEvidenceSilver({ silverDir });
  pkg = await buildEvidencePackage({
    goldDir,
    silverDir,
    completeness: completenessView(),
    episodeId: EPISODE_ID,
    date: DAY,
  });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const matches = (fact: Fact, actual: unknown): boolean => {
  if (typeof fact.value !== "number") return actual === fact.value;
  if (typeof actual !== "number") return false;
  const tolerance = fact.tolerance ?? 0.5 * 10 ** -(fact.decimals ?? 2);
  return Math.abs(actual - fact.value) <= tolerance + 1e-9;
};

const walk = (root: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node === null || typeof node !== "object"
          ? undefined
          : (node as Record<string, unknown>)[key],
      root,
    );

// Catches: a fact of the write-up that the package neither holds nor names as a gap.
test("every fact of the #21 write-up is a claim, a series value or a named gap", () => {
  expect(new Set(facts.map((fact) => fact.fact_id)).size).toBe(facts.length);
  const claims = new Map(pkg.claims.map((claim) => [claim.id, claim]));
  const problems: string[] = [];
  for (const fact of facts) {
    if (fact.write_up_query === "") problems.push(`${fact.fact_id}: no query`);
    if (fact.status === "claim") {
      const claim =
        fact.claim_id_expected === null
          ? undefined
          : claims.get(fact.claim_id_expected);
      if (!claim)
        problems.push(`${fact.fact_id}: no claim ${fact.claim_id_expected}`);
      else if (!matches(fact, claim.value))
        problems.push(`${fact.fact_id}: ${claim.value} is not ${fact.value}`);
    } else if (fact.status === "series") {
      const holder = walk(
        fact.series?.startsWith("observations") ? pkg : pkg.context,
        fact.series ?? "",
      );
      const actual = Array.isArray(holder)
        ? holder[
            fact.period === null || fact.period === undefined
              ? 0
              : pkg.window.periods.indexOf(fact.period)
          ]
        : holder;
      if (!matches(fact, actual))
        problems.push(
          `${fact.fact_id}: series ${fact.series} gives ${actual}, not ${fact.value}`,
        );
    } else {
      if (fact.claim_id_expected !== null || (fact.gap_reason ?? "") === "")
        problems.push(`${fact.fact_id}: a gap needs a reason and no claim id`);
    }
  }
  expect(problems).toEqual([]);
  expect(facts.filter((fact) => fact.status === "gap").length).toBeGreaterThan(
    10,
  );
});
