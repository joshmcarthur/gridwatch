import type { ClaimValue, Confidence, InputStatus } from "./evidence.ts";

export const NARRATIVE_SCHEMA_VERSION = 1;
export const PROMPT_VERSION = 1;
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export interface PromptClaim {
  id: string;
  label: string;
  value: ClaimValue;
  unit: string;
  confidence: Confidence;
  note?: string;
}

/** The fields the prompt reads. Not the full evidence package. */
export interface PromptPackage {
  episode: {
    episode_id: string;
    trading_date: string;
    start_trading_period: number;
    end_trading_period: number;
    observation_types: string[];
    islands: string[];
    severity: number;
  };
  claims: PromptClaim[];
  limits: Array<{ issue: number; text: string }>;
  links: { daily_page: string };
  completeness: Array<{ table: string; status: InputStatus }>;
}

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
  /** SHA-256 of the evidence file bytes, not a re-serialised object. */
  packageId: string;
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

export const promptPayload = (pkg: PromptPackage) => ({
  episode: pkg.episode,
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
  completeness: pkg.completeness,
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
  pkg: PromptPackage,
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
    package_id: options.packageId,
    episode_id: pkg.episode.episode_id,
    trading_date: pkg.episode.trading_date,
    model: options.model,
    generated_at: options.now.toISOString().replace(/\.000Z$/, "Z"),
    ...sections,
  };
};

export const serializeNarrative = (record: NarrativeRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

export type MismatchKind = "number" | "date" | "link";

export interface NarrativeMismatch {
  kind: MismatchKind;
  text: string;
}

export interface NarrativeCheck {
  ok: boolean;
  mismatches: NarrativeMismatch[];
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const ISO_DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const NAMED_DATE = String.raw`\b(\d{1,2})\s+(${MONTH})\s+(\d{4})\b`;
const MONTH_FIRST_DATE = String.raw`\b(${MONTH})\s+(\d{1,2}),?\s+(\d{4})\b`;
const WEB_LINK = String.raw`\bhttps?://[^\s)>\]]+`;
const DAILY_PATH = String.raw`/\d{4}/\d{2}/\d{2}/?`;
const NUMBER_TOKEN = String.raw`\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d+(?:\.\d+)?`;

const globalRe = (source: string, flags = "g"): RegExp =>
  new RegExp(source, flags);

interface AllowedFacts {
  numbers: Set<number>;
  dates: Set<string>;
  links: Set<string>;
}

type NamedDateOrder = "day-month" | "month-day";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const toIsoDate = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;

const monthNumber = (name: string | undefined): number | undefined =>
  name === undefined ? undefined : MONTHS[name.toLowerCase()];

const namedIso = (
  match: RegExpMatchArray,
  order: NamedDateOrder,
): string | undefined => {
  switch (order) {
    case "day-month": {
      const month = monthNumber(match[2]);
      if (month === undefined) return undefined;
      return toIsoDate(Number(match[3]), month, Number(match[1]));
    }
    case "month-day": {
      const month = monthNumber(match[1]);
      if (month === undefined) return undefined;
      return toIsoDate(Number(match[3]), month, Number(match[2]));
    }
    default: {
      const unreachable: never = order;
      return unreachable;
    }
  }
};

const addDate = (allowed: AllowedFacts, iso: string): void => {
  allowed.dates.add(iso);
  const [year, month, day] = iso.split("-").map(Number);
  if (year !== undefined) allowed.numbers.add(year);
  if (month !== undefined) allowed.numbers.add(month);
  if (day !== undefined) allowed.numbers.add(day);
};

const normalizeLink = (link: string): string =>
  link.length > 1 && link.endsWith("/") ? link.slice(0, -1) : link;

const eachMatch = (
  text: string,
  source: string,
  flags: string,
  visit: (raw: string, match: RegExpMatchArray) => void,
): void => {
  for (const match of text.matchAll(globalRe(source, flags))) {
    const raw = match[0];
    if (raw !== undefined) visit(raw, match);
  }
};

const collectAllowed = (value: unknown, allowed: AllowedFacts): void => {
  if (typeof value === "number" && Number.isFinite(value)) {
    allowed.numbers.add(value);
    return;
  }
  if (typeof value === "string") {
    eachMatch(value, ISO_DATE, "g", (iso) => addDate(allowed, iso));
    eachMatch(value, WEB_LINK, "g", (link) =>
      allowed.links.add(normalizeLink(link)),
    );
    eachMatch(value, DAILY_PATH, "g", (link) =>
      allowed.links.add(normalizeLink(link)),
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAllowed(item, allowed);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectAllowed(item, allowed);
  }
};

const numberAllowed = (
  value: number,
  decimals: number,
  allowed: Set<number>,
): boolean => {
  for (const fact of allowed) {
    if (value === fact) return true;
    if (Number(fact.toFixed(decimals)) === value) return true;
    if (
      Number.isInteger(value) &&
      (Math.round(fact) === value || Math.trunc(fact) === value)
    ) {
      return true;
    }
  }
  return false;
};

const pushUnique = (
  mismatches: NarrativeMismatch[],
  kind: MismatchKind,
  text: string,
): void => {
  if (mismatches.some((item) => item.kind === kind && item.text === text)) {
    return;
  }
  mismatches.push({ kind, text });
};

const mask = (text: string, source: string, flags = "g"): string =>
  text.replace(globalRe(source, flags), (span) => " ".repeat(span.length));

export const checkNarrative = (
  sections: NarrativeSections,
  evidence: unknown,
): NarrativeCheck => {
  const allowed: AllowedFacts = {
    numbers: new Set(),
    dates: new Set(),
    links: new Set(),
  };
  collectAllowed(evidence, allowed);
  const text = `${sections.what_happened}\n${sections.why}\n${sections.what_it_means}`;
  const mismatches: NarrativeMismatch[] = [];

  const rejectUnless = (
    source: string,
    flags: string,
    kind: MismatchKind,
    ok: (raw: string) => boolean,
  ): void => {
    eachMatch(text, source, flags, (raw) => {
      if (!ok(raw)) pushUnique(mismatches, kind, raw);
    });
  };

  rejectUnless(ISO_DATE, "g", "date", (raw) => allowed.dates.has(raw));
  const namedPatterns: Array<{ source: string; order: NamedDateOrder }> = [
    { source: NAMED_DATE, order: "day-month" },
    { source: MONTH_FIRST_DATE, order: "month-day" },
  ];
  for (const { source, order } of namedPatterns) {
    eachMatch(text, source, "gi", (raw, match) => {
      const iso = namedIso(match, order);
      if (iso === undefined || !allowed.dates.has(iso)) {
        pushUnique(mismatches, "date", raw);
      }
    });
  }
  rejectUnless(WEB_LINK, "g", "link", (raw) =>
    allowed.links.has(normalizeLink(raw)),
  );
  rejectUnless(DAILY_PATH, "g", "link", (raw) =>
    allowed.links.has(normalizeLink(raw)),
  );

  let remainder = text;
  remainder = mask(remainder, ISO_DATE);
  remainder = mask(remainder, NAMED_DATE, "gi");
  remainder = mask(remainder, MONTH_FIRST_DATE, "gi");
  remainder = mask(remainder, WEB_LINK);
  remainder = mask(remainder, DAILY_PATH);
  eachMatch(remainder, NUMBER_TOKEN, "g", (raw) => {
    const stripped = raw.replace(/[$,]/g, "");
    const dot = stripped.indexOf(".");
    const decimals = dot === -1 ? 0 : stripped.length - dot - 1;
    const value = Number(stripped);
    if (!Number.isFinite(value)) return;
    if (!numberAllowed(value, decimals, allowed.numbers)) {
      pushUnique(mismatches, "number", raw);
    }
  });

  return { ok: mismatches.length === 0, mismatches };
};
