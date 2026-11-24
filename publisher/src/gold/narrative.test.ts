import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  checkNarrative,
  DEFAULT_MODEL,
  generateNarrative,
  llmModel,
  NARRATIVE_CACHE_THREAD_ID,
  NARRATIVE_SCHEMA_VERSION,
  PROMPT_VERSION,
  type PromptPackage,
  parseNarrativeText,
  promptPayload,
  serializeNarrative,
  systemPrompt,
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
  expect(PROMPT_VERSION).toBe(2);
  expect(NARRATIVE_SCHEMA_VERSION).toBe(1);
  expect(DEFAULT_MODEL).toBe("openai/gpt-6-luna");
  expect(createHash("sha256").update(systemPrompt()).digest("hex")).toBe(
    "aa41e7b14388e87d802c0fba9d881f4ebc384ae0f0b1d92bdb8db16a7358ed65",
  );
});

test("the system prompt includes site copy and the glossary", () => {
  expect(systemPrompt()).toContain("Clock times in public sentences");
  expect(systemPrompt()).toContain("**Trading period.**");
  expect(systemPrompt()).toContain("Site copy wins for sentences");
  expect(systemPrompt()).toContain("Two or three sentences each");
  expect(systemPrompt()).toContain("Ōtāhuhu averaged $3,296.04/MWh");
  expect(systemPrompt()).toContain("The JSON informs the story");
  expect(systemPrompt()).not.toContain("Confirmed: North Island");
});

test("the cache thread id is stable across episodes", () => {
  expect(NARRATIVE_CACHE_THREAD_ID).toBe("gridwatch-narrative");
});

test("llmModel uses Luna when GRIDWATCH_LLM_MODEL is missing or blank", () => {
  expect(llmModel({})).toBe(DEFAULT_MODEL);
  expect(llmModel({ GRIDWATCH_LLM_MODEL: "" })).toBe(DEFAULT_MODEL);
  expect(llmModel({ GRIDWATCH_LLM_MODEL: "  " })).toBe(DEFAULT_MODEL);
  expect(llmModel({ GRIDWATCH_LLM_MODEL: "anthropic/claude-haiku-5.5" })).toBe(
    "anthropic/claude-haiku-5.5",
  );
});

test("the prompt carries claims, limits, links and NZ clock labels", () => {
  const payload = promptPayload(pkg);
  const json = JSON.stringify(payload);
  expect(json).toContain("3296.04");
  expect(json).toContain("No SPD case files.");
  expect(json).toContain("/2026/07/27/");
  expect(json).not.toContain("generation_by_fuel");
  expect(payload.claims).toHaveLength(2);
  expect(payload.claims[1]?.confidence).toBe("possible explanation");
  expect(payload.episode.clock).toBe("5:30pm–7:30pm");
  expect(payload.episode.clock_by_period["36"]).toBe("5:30pm–6:00pm");
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
  expect(record.prompt_version).toBe(2);
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

test("checkNarrative does not read 2201 out of OTA2201", () => {
  const result = checkNarrative(
    {
      what_happened: "Prices rose at OTA2201.",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(true);
});

test("checkNarrative accepts clock times from the payload", () => {
  const result = checkNarrative(
    {
      what_happened: "From 5:30pm to 7:30pm Otahuhu reached $3,296.04/MWh.",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    pkg,
  );
  expect(result.ok).toBe(true);
});

test("checkNarrative rejects a clock time that is not in the payload", () => {
  const result = checkNarrative(
    {
      what_happened: "Prices rose at 9:00pm.",
      why: "Possible explanation: a constraint.",
      what_it_means: "North Island scarcity.",
    },
    promptPayload(pkg),
  );
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([{ kind: "time", text: "9:00pm" }]);
});
