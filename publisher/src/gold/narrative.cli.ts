import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { chat } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { dataPaths } from "../data-root.ts";
import {
  checkNarrative,
  DEFAULT_MODEL,
  generateNarrative,
  NARRATIVE_CACHE_THREAD_ID,
  type PromptPackage,
  promptPayload,
  serializeNarrative,
  warnNarrativeCheck,
} from "./narrative.ts";

// npm run build:narrative -- --date YYYY-MM-DD --episode <id>
// or --package path/to/evidence.json
// Writes <gold>/narratives/<date>/<episode_id>.json. It is not published (ADR-0027).
const {
  values: { date, episode: episodeId, package: packagePath },
} = parseArgs({
  options: {
    date: { type: "string" },
    episode: { type: "string" },
    package: { type: "string" },
  },
});

const { gold } = dataPaths();
const evidencePath =
  packagePath ??
  (date !== undefined && episodeId !== undefined
    ? join(gold, "evidence", date, `${episodeId}.json`)
    : undefined);
if (evidencePath === undefined) {
  console.error(
    "usage: npm run build:narrative -- --date YYYY-MM-DD --episode <episode_id>",
  );
  process.exit(2);
}

const key = process.env.OPENROUTER_API_KEY;
if (key === undefined || key === "") {
  console.error("set OPENROUTER_API_KEY");
  process.exit(2);
}

const model = (process.env.GRIDWATCH_LLM_MODEL ?? DEFAULT_MODEL) as Parameters<
  typeof createOpenRouterText
>[0];
const bytes = await readFile(evidencePath);
const pkg = JSON.parse(bytes.toString("utf8")) as PromptPackage;
const record = await generateNarrative(pkg, {
  complete: async ({ system, user }) => {
    const result = await chat({
      adapter: createOpenRouterText(model, key),
      messages: [{ role: "user", content: user }],
      systemPrompts: [
        {
          content: system,
          metadata: {
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        },
      ],
      threadId: NARRATIVE_CACHE_THREAD_ID,
      promptCache: "long",
      stream: false,
    });
    return result.text;
  },
  model,
  now: new Date(),
  packageId: createHash("sha256").update(bytes).digest("hex"),
});
warnNarrativeCheck(
  checkNarrative(record, promptPayload(pkg)),
  "narrative check",
);
const path = join(
  gold,
  "narratives",
  record.trading_date,
  `${record.episode_id}.json`,
);
await mkdir(dirname(path), { recursive: true });
try {
  await writeFile(`${path}.tmp`, serializeNarrative(record));
  await rename(`${path}.tmp`, path);
} finally {
  await rm(`${path}.tmp`, { force: true });
}
console.log(`${path}: ${record.model} prompt v${record.prompt_version}`);
