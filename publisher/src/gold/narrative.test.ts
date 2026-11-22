import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  checkNarrative,
  DEFAULT_MODEL,
  generateNarrative,
  NARRATIVE_SCHEMA_VERSION,
  PROMPT_VERSION,
  type PromptPackage,
  parseNarrativeText,
  promptPayload,
  SYSTEM_PROMPT,
  serializeNarrative,
} from "./narrative.ts";

const pkg: PromptPackage = {
  episode: {
    episode_id: "abc123",
    trading_date: "2026-07-27",
    start_trading_period: 36,
    end_trading_period: 39,
    observation_types: ["price_high", "reserve_price_high"],
    islands: ["NI"],
    severity: 10,
  },
  claims: [
    {
      id: "price.OTA2201.p36",
      label: "Otahuhu period price",
      value: 3296.04,
      unit: "$/MWh",
      confidence: "confirmed",
    },
    {
      id: "spread.guess",
      label: "a possible reading",
      value: "constraint",
      unit: "",
      confidence: "possible_explanation",
    },
  ],
  limits: [{ issue: 44, text: "No SPD case files." }],
  links: { daily_page: "/2026/07/27/" },
  completeness: [{ table: "price_periods", status: "complete" }],
};

const packageId = "file-bytes-sha256";

test("the system prompt is pinned: a changed prompt without a PROMPT_VERSION bump fails here", () => {
  expect(PROMPT_VERSION).toBe(1);
  expect(NARRATIVE_SCHEMA_VERSION).toBe(1);
  expect(DEFAULT_MODEL).toBe("anthropic/claude-haiku-4.5");
  expect(createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe(
    "474253bcc7dd3aad05861b7ff3994ceb502973285010ff51be4317f323b7455d",
  );
});

test("the prompt carries claims, limits and links, not context series", () => {
  const payload = promptPayload(pkg);
  const json = JSON.stringify(payload);
  expect(json).toContain("3296.04");
  expect(json).toContain("No SPD case files.");
  expect(json).toContain("/2026/07/27/");
  expect(json).not.toContain("generation_by_fuel");
  expect(payload.claims).toHaveLength(2);
  expect(payload.claims[1]?.confidence).toBe("possible explanation");
});

test("parseNarrativeText reads the three JSON fields and strips fences", () => {
  const text = `\`\`\`json
{"what_happened":"Prices rose.","why":"Thermal ramped.","what_it_means":"The islands split."}
\`\`\``;
  expect(parseNarrativeText(text)).toEqual({
    what_happened: "Prices rose.",
    why: "Thermal ramped.",
    what_it_means: "The islands split.",
  });
});

test("generateNarrative stores package id, model, prompt version and date", async () => {
  const complete = async () =>
    JSON.stringify({
      what_happened: "Otahuhu hit $3,296.04/MWh.",
      why: "Possible explanation: a constraint. Confirmed: the price.",
      what_it_means: "North Island scarcity.",
    });
  const record = await generateNarrative(pkg, {
    complete,
    model: "anthropic/claude-haiku-4.5",
    now: new Date("2026-11-23T00:00:00Z"),
    packageId,
  });
  expect(record.schema_version).toBe(1);
  expect(record.prompt_version).toBe(1);
  expect(record.episode_id).toBe("abc123");
  expect(record.trading_date).toBe("2026-07-27");
  expect(record.model).toBe("anthropic/claude-haiku-4.5");
  expect(record.generated_at).toBe("2026-11-23T00:00:00Z");
  expect(record.package_id).toBe(packageId);
  expect(record.what_happened).toContain("3,296.04");
  const roundTrip = JSON.parse(serializeNarrative(record));
  expect(roundTrip.package_id).toBe(record.package_id);
});

test("generateNarrative fails when the model omits a section", async () => {
  await expect(
    generateNarrative(pkg, {
      complete: async () => JSON.stringify({ what_happened: "only" }),
      model: "x",
      now: new Date("2026-11-23T00:00:00Z"),
      packageId,
    }),
  ).rejects.toThrow(/why|what_it_means/);
});

test("checkNarrative rejects an invented number", () => {
  const result = checkNarrative(
    {
      what_happened: "Otahuhu hit $9,999/MWh.",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([{ kind: "number", text: "$9,999" }]);
});

test("checkNarrative rejects a wrong date", () => {
  const result = checkNarrative(
    {
      what_happened: "On 28 July 2026 prices rose.",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([{ kind: "date", text: "28 July 2026" }]);
});

test("checkNarrative rejects an unknown link", () => {
  const result = checkNarrative(
    {
      what_happened: "See https://example.invalid/nope",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    { kind: "link", text: "https://example.invalid/nope" },
  ]);
});

test("checkNarrative accepts a 27 July fixture that only uses package facts", () => {
  const result = checkNarrative(
    {
      what_happened:
        "On 27 July 2026, Otahuhu period 36 reached $3,296.04/MWh. See /2026/07/27/.",
      why: "Possible explanation: a constraint. Confirmed: the price.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(true);
  expect(result.mismatches).toEqual([]);
});
