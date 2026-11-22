import { createHash } from "node:crypto";
import {
  type Confidence,
  type EvidencePackage,
  serializeEvidencePackage,
} from "./evidence.ts";

export const NARRATIVE_SCHEMA_VERSION = 1;
export const PROMPT_VERSION = 1;
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export interface NarrativeSections {
  what_happened: string;
  why: string;
  what_it_means: string;
}

export interface NarrativeRecord extends NarrativeSections {
  schema_version: number;
  prompt_version: number;
  package_id: string;
  episode_id: string;
  trading_date: string;
  model: string;
  generated_at: string;
}

export type CompleteNarrative = (input: {
  system: string;
  user: string;
  model: string;
}) => Promise<string>;

export interface GenerateNarrativeOptions {
  complete: CompleteNarrative;
  model: string;
  now: Date;
}

const confidenceLabel = (level: Confidence): string => {
  switch (level) {
    case "confirmed":
      return "confirmed";
    case "strong_evidence":
      return "strong evidence";
    case "possible_explanation":
      return "possible explanation";
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
};

export const SYSTEM_PROMPT = `You write Gridwatch event narratives for a curious non-specialist.

You receive one evidence package as JSON. Use only facts in that JSON. Do not invent numbers, dates, places, plants, or links. If a fact is not in the package, omit it.

Write three sections:
- what_happened: observable facts.
- why: the likely mechanism. Separate established facts from inference. When a claim is not confirmed, say so in the sentence using the package confidence label (confirmed / strong evidence / possible explanation).
- what_it_means: why the evening matters, without new facts.

Plain language. No jargon unless the package uses it, then explain it once.

Reply with JSON only, no markdown, in this shape:
{"what_happened":"...","why":"...","what_it_means":"..."}`;

export const promptPayload = (pkg: EvidencePackage) => ({
  episode: {
    episode_id: pkg.episode.episode_id,
    trading_date: pkg.episode.trading_date,
    start_trading_period: pkg.episode.start_trading_period,
    end_trading_period: pkg.episode.end_trading_period,
    observation_types: pkg.episode.observation_types,
    islands: pkg.episode.islands,
    severity: pkg.episode.severity,
  },
  claims: pkg.claims.map((claim) => ({
    id: claim.id,
    label: claim.label,
    value: claim.value,
    unit: claim.unit,
    confidence: confidenceLabel(claim.confidence),
    note: claim.note,
  })),
  limits: pkg.limits,
  links: { daily_page: pkg.links.daily_page },
  completeness: pkg.completeness.map((entry) => ({
    table: entry.table,
    status: entry.status,
  })),
});

export const parseNarrativeText = (text: string): NarrativeSections => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("narrative is not JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("narrative JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const read = (key: keyof NarrativeSections): string => {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`narrative missing ${key}`);
    }
    return value;
  };
  return {
    what_happened: read("what_happened"),
    why: read("why"),
    what_it_means: read("what_it_means"),
  };
};

export const generateNarrative = async (
  pkg: EvidencePackage,
  options: GenerateNarrativeOptions,
): Promise<NarrativeRecord> => {
  const user = JSON.stringify(promptPayload(pkg));
  const text = await options.complete({
    system: SYSTEM_PROMPT,
    user,
    model: options.model,
  });
  const sections = parseNarrativeText(text);
  return {
    schema_version: NARRATIVE_SCHEMA_VERSION,
    prompt_version: PROMPT_VERSION,
    package_id: createHash("sha256")
      .update(serializeEvidencePackage(pkg))
      .digest("hex"),
    episode_id: pkg.episode.episode_id,
    trading_date: pkg.episode.trading_date,
    model: options.model,
    generated_at: options.now.toISOString().replace(/\.000Z$/, "Z"),
    ...sections,
  };
};

export const serializeNarrative = (record: NarrativeRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;
