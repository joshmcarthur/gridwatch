# ADR-0027: LLM narratives from evidence packages

- Status: Accepted
- Date: 2026-11-23

## Context

[#39](https://github.com/joshmcarthur/gridwatch/issues/39) asks the LLM to turn one evidence package into readable prose. The model communicates the analysis; it does not invent it ([brief §7, §17 principle 7](../brief.md)). The three sections are what happened, why it happened (facts apart from inference), and what it means ([brief §7.1](../brief.md)). Text may vary between runs; the facts must not ([brief §12](../brief.md)).

The package is already a JSON file ([ADR-0025](0025-evidence-packages.md)). This ADR is the provider, the default model, where the API key lives, the prompt, and where the generated text is stored.

Owner comment on #39, 2026-11-23: use a provider-neutral library (TanStack AI) so providers can be swapped by config. The owner picked `openai/gpt-6-luna` after live 27 July drafts. A light number-and-link check is required before text is stored or published; that checker is [#40](https://github.com/joshmcarthur/gridwatch/issues/40). The first narrative is the 27 July 2026 event ([#21](https://github.com/joshmcarthur/gridwatch/issues/21)).

[#3](https://github.com/joshmcarthur/gridwatch/issues/3) / [ADR-0002](0002-daily-run-data-and-site-hosting.md) already placed secrets in files on the home server, readable only by the user that runs the jobs, and named the LLM key as the later secret.

## Decision

### Library and provider

Narratives call the model through [TanStack AI](https://tanstack.com/ai). The installed adapter is `@tanstack/ai-openrouter`. One OpenRouter key reaches many upstream providers. The model id is a config string of the form `provider/model-name`. A later swap does not add a package.

The publisher runner and the updater generate narratives after gold tables and before the site export, when `OPENROUTER_API_KEY` is set. They skip that step when the key is empty, and they do not fail the run. One failed episode is a warning. The rest continue. A narrative file that already exists is left alone unless `--force` is set.

The on-demand CLI still works for one episode:

```bash
npm run build:narrative -- --date YYYY-MM-DD --episode <episode_id>
```

or `--package path/to/evidence.json`. The command reads an evidence file that `build:evidence` already wrote. It does not rebuild the package. The daily path rebuilds the evidence package, then writes the narrative.

### Default model

The default is `openai/gpt-6-luna`. Override with `GRIDWATCH_LLM_MODEL`. Prices below are OpenRouter list prices on 2026-11-23. Cost per event assumes about 8,000 input tokens (claims plus prompt) and 1,000 output tokens. Monthly cost assumes one narrative a day, the ranking target on [#181](https://github.com/joshmcarthur/gridwatch/issues/181).

| Model | Input / output per 1M tokens | About one event | About 30 events |
| --- | ---: | ---: | ---: |
| `openai/gpt-6-luna` (default) | $0.10 / $0.50 | $0.0013 | $0.04 |
| `anthropic/claude-haiku-5.5` | $0.10 / $0.50 | $0.0013 | $0.04 |
| `anthropic/claude-haiku-4.5` | $1 / $5 | $0.013 | $0.39 |
| `openai/gpt-4.1-mini` | $0.40 / $1.60 | $0.0048 | $0.14 |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | $0.0049 | $0.15 |
| `anthropic/claude-sonnet-5.5` | $3 / $15 | $0.039 | $1.17 |

Luna is the default because live 27 July drafts used clocks and place names, did not print confidence labels, and cost the same as Haiku 5.5. Haiku 4.5 is the earlier first-narrative pick. Sonnet is the prose upgrade if Luna invents or reads stiff.

### API key

The key is a file on the home server ([ADR-0002](0002-daily-run-data-and-site-hosting.md)). The process reads it as `OPENROUTER_API_KEY`. The image and this repository do not contain the key. Compose passes `OPENROUTER_API_KEY` and `GRIDWATCH_LLM_MODEL` from the host into `updater` and `publisher`. Empty values skip generation. On the server:

```bash
export OPENROUTER_API_KEY=$(cat /path/to/openrouter-key)
```

`collector` still knows only `DATA_ROOT`. The publisher runner does not import the LLM adapter. `publisher/src/main.ts` and `updater/main.ts` pass `afterGold: narrateIfKeyed`, so tests that import the runner do not load TanStack.

### Prompt

The user message is a reduced package: episode fields, NZ clock labels (`clock`, `clock_by_period`) from `periodToUtc`, claims (id, label, value, unit, confidence, note), limits, the daily-page link, and completeness. It does not send `context` series. Claims are the source material. The model may only use that JSON. Published prose must not mention facts, evidence, claims, files, confirmation, or the brief §7.2 labels. Where a claim is not `confirmed`, hedge in ordinary English (`may`, `likely`).

The system prompt is `systemPrompt()` in `publisher/src/gold/narrative.ts`. It is the narrative instructions (two or three sentences per section, plus a 27 July style sample), then the full text of [`site-copy.md`](../site-copy.md) and [`glossary.md`](../glossary.md). Site copy wins for published sentences (clock times, place names). The glossary is meaning, not voice. The files load when generating, not when the site imports the number checker. A test pins the SHA-256 of the composed string. `PROMPT_VERSION` is the stored record field. It does not bump when the voice files change.

The OpenRouter adapter sends that system prompt with OpenRouter `cache_control` (`ephemeral`, 1 hour TTL) and a stable `threadId` (`gridwatch-narrative`) plus `promptCache: "long"`. The marker is on the system prompt only, so the per-episode user JSON is not cached. Routes that ignore `cache_control` still get a sticky session for implicit prefix cache.

The model replies with JSON: `what_happened`, `why`, `what_it_means`. The CLI rejects a reply that is not JSON or that omits a field.

### Storage

The CLI and the daily run write `<gold>/narratives/<date>/<episode_id>.json`. The site export reads those files for ranked candidates ([ADR-0014](0014-site-json-contract.md)).

The file holds `schema_version`, `prompt_version`, `package_id`, `episode_id`, `trading_date`, `model`, `generated_at`, and the three section strings. `package_id` is the SHA-256 of the evidence JSON bytes, so a checker can tell which package produced the text. `generated_at` is the run time in UTC. The same package can yield different prose on a second run; the claims must still match.

`generateNarrative` returns the record. `checkNarrative` walks the prompt payload for numbers, ISO dates, clock times, and links, then scans `what_happened`, `why`, and `what_it_means`. A number may use `$`, thousands separators, fewer decimal places, or integer rounding of a package value. Number tokens do not match inside codes (`OTA2201` is not `2201`). Clock times in the payload (`5:30pm`) are allowed. If a figure, date, clock, or URL is missing from the payload, the process prints the mismatches as a warning. It still writes the file. It does not check plant names, place names, or inference. [#42](https://github.com/joshmcarthur/gridwatch/issues/42) calls the same function and still publishes. Editorial review ([ADR-0022](0022-editorial-review-and-publish-flow.md)) is the remaining gate.

## Owner questions

Each has a default. The default is what the code does now.

1. Default model `openai/gpt-6-luna`? **[yes]**
2. OpenRouter rather than a direct Anthropic or OpenAI key? **[yes]**
3. On-demand CLI, not the daily runner? **[no]** — the daily run generates when `OPENROUTER_API_KEY` is set.
4. Store three JSON fields, not one markdown blob? **[yes]**

## Alternatives considered

- **Vercel AI SDK, or a raw `fetch` to OpenRouter.** Rejected. The owner named TanStack AI so the provider is a config string.
- **One TanStack adapter package per provider (`@tanstack/ai-openai`, `@tanstack/ai-anthropic`, ...).** Rejected. Extra packages and extra keys. OpenRouter is the swap.
- **Local Ollama on the home server.** Rejected for v1. No extra service, and the first narrative needs a model that follows the fact list. Ollama stays possible later through TanStack's Ollama adapter.
- **A gold Parquet table of narratives.** Rejected. Same reason as ADR-0025: the record is a small tree.
- **Always call the model, even with no key.** Rejected. A host without a key still publishes gold and the site. The skip is the empty env var, not a separate flag.

## Consequences

- [#40](https://github.com/joshmcarthur/gridwatch/issues/40) is this checker. It walks the prompt payload and warns when a number, date, clock, or link is missing. It does not block the write or the publish.
- [#42](https://github.com/joshmcarthur/gridwatch/issues/42) still writes event pages. Event pages call `checkNarrative` and warn. They do not fail the build.
- The Docker image gains `@tanstack/ai` and `@tanstack/ai-openrouter`. They are production dependencies because the CLI and the daily run call the model in the image. The key stays out of the image.
- The 27 July 2026 narrative for owner review needs a live key. If a PR ships the pipeline without that file, a follow-up issue holds the live run ([#206](https://github.com/joshmcarthur/gridwatch/issues/206)).
