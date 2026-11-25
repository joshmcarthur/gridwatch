import { chat } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import type { CompletenessView } from "../silver/completeness.ts";
import { narrateDays } from "../site/narrate-days.ts";
import { narrateCandidates } from "./narrate-candidates.ts";
import {
  type CompleteNarrative,
  llmModel,
  NARRATIVE_CACHE_THREAD_ID,
} from "./narrative.ts";

export function openRouterComplete(
  key: string,
  model: string,
): CompleteNarrative {
  const id = model as Parameters<typeof createOpenRouterText>[0];
  return async ({ system, user }) => {
    const result = await chat({
      adapter: createOpenRouterText(id, key),
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
  };
}

/** After gold, before the site export. No-op when the key is unset. */
export async function narrateIfKeyed(ctx: {
  goldDir: string;
  silverDir: string;
  completeness: CompletenessView;
  range?: { from: string; to: string };
  force: boolean;
}): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key === "") {
    console.log("narratives: skip (no OPENROUTER_API_KEY)");
    return;
  }
  const model = llmModel();
  const result = await narrateCandidates({
    ...ctx,
    complete: openRouterComplete(key, model),
    model,
  });
  console.log(
    `narratives: wrote ${result.written}, skipped ${result.skipped}${
      result.failed.length > 0 ? `, failed ${result.failed.length}` : ""
    }`,
  );
  for (const line of result.failed) console.warn(`narratives: ${line}`);
  // Day write-ups come after the events, so a day's package sees its events (ADR-0031).
  const days = await narrateDays({
    ...ctx,
    complete: openRouterComplete(key, model),
    model,
  });
  console.log(
    `day write-ups: wrote ${days.written}, skipped ${days.skipped}${
      days.failed.length > 0 ? `, failed ${days.failed.length}` : ""
    }`,
  );
  for (const line of days.failed) console.warn(`day write-ups: ${line}`);
}
