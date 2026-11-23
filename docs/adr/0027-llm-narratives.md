# ADR-0027: LLM narratives from evidence packages

- Status: Proposed
- Date: 2026-11-23

## Context

[#39](https://github.com/joshmcarthur/gridwatch/issues/39) asks the LLM to turn one evidence package into readable prose. The model communicates the analysis; it does not invent it ([brief §7, §17 principle 7](../brief.md)). The three sections are what happened, why it happened (facts apart from inference), and what it means ([brief §7.1](../brief.md)). Text may vary between runs; the facts must not ([brief §12](../brief.md)).

The package is already a JSON file ([ADR-0025](0025-evidence-packages.md)). This ADR is the provider, the default model, where the API key lives, the prompt, and where the generated text is stored.

Owner comment on #39, 2026-11-23: use a provider-neutral library (TanStack AI) so providers can be swapped by config. The owner still picks the default model from the comparison below. A light number-and-link check is required before text is stored or published; that checker is [#40](https://github.com/joshmcarthur/gridwatch/issues/40). The first narrative is the 27 July 2026 event ([#21](https://github.com/joshmcarthur/gridwatch/issues/21)).

[#3](https://github.com/joshmcarthur/gridwatch/issues/3) / [ADR-0002](0002-daily-run-data-and-site-hosting.md) already placed secrets in files on the home server, readable only by the user that runs the jobs, and named the LLM key as the later secret.

## Decision

### Library and provider

Narratives call the model through [TanStack AI](https://tanstack.com/ai). The installed adapter is `@tanstack/ai-openrouter`. One OpenRouter key reaches many upstream providers. The model id is a config string of the form `provider/model-name`. A later swap does not add a package.

The publisher runner and the updater do not call the model. Generation is on demand:

```bash
npm run build:narrative -- --date YYYY-MM-DD --episode <episode_id>
```

or `--package path/to/evidence.json`. The command reads an evidence file that `build:evidence` already wrote. It does not rebuild the package.

### Default model

Until the owner picks, the default is `anthropic/claude-haiku-4.5`. Override with `GRIDWATCH_LLM_MODEL`. Prices below are OpenRouter list prices on 2026-11-23. Cost per event assumes about 8,000 input tokens (claims plus prompt) and 1,000 output tokens. Monthly cost assumes one narrative a day, the ranking target on [#181](https://github.com/joshmcarthur/gridwatch/issues/181).

| Model | Input / output per 1M tokens | About one event | About 30 events |
| --- | ---: | ---: | ---: |
| `anthropic/claude-haiku-4.5` (default) | $1 / $5 | $0.013 | $0.39 |
| `anthropic/claude-haiku-5.5` | $0.10 / $0.50 | $0.0013 | $0.04 |
| `openai/gpt-4.1-mini` | $0.40 / $1.60 | $0.0048 | $0.14 |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | $0.0049 | $0.15 |
| `anthropic/claude-sonnet-5.5` | $3 / $15 | $0.039 | $1.17 |

Haiku 4.5 is the default because it follows "use only these facts" well enough for a first narrative, and the monthly cost is still cents. Haiku 5.5 is cheaper if the owner prefers it. Sonnet is the prose upgrade if Haiku invents or reads stiff.

### API key

The key is a file on the home server ([ADR-0002](0002-daily-run-data-and-site-hosting.md)). The process reads it as `OPENROUTER_API_KEY`. The image and this repository do not contain the key. Compose does not mount it in this change, because the daily run does not call the LLM. When someone runs the CLI on the server:

```bash
export OPENROUTER_API_KEY=$(cat /path/to/openrouter-key)
npm run build:narrative -- --date 2026-07-27 --episode <episode_id>
```

`collector` and `publisher` still know only `DATA_ROOT`. The key is an environment variable of the CLI process, not a branch in the apps.

### Prompt

The user message is a reduced package: episode fields, claims (id, label, value, unit, confidence, note), limits, the daily-page link, and completeness. It does not send `context` series. Claims are the facts. The model may only use those facts. Where a claim is not `confirmed`, the sentence must use the confidence label from brief §7.2.

The system prompt is `SYSTEM_PROMPT` in `publisher/src/gold/narrative.ts`. A change to that string bumps `PROMPT_VERSION`. A test pins the SHA-256 of the string.

The model replies with JSON: `what_happened`, `why`, `what_it_means`. The CLI rejects a reply that is not JSON or that omits a field.

### Storage

The CLI writes `<gold>/narratives/<date>/<episode_id>.json`. The site does not read it. The site contract ([ADR-0014](0014-site-json-contract.md)) is unchanged. Event pages stay on [#42](https://github.com/joshmcarthur/gridwatch/issues/42).

The file holds `schema_version`, `prompt_version`, `package_id`, `episode_id`, `trading_date`, `model`, `generated_at`, and the three section strings. `package_id` is the SHA-256 of the evidence JSON bytes, so a checker can tell which package produced the text. `generated_at` is the run time in UTC. The same package can yield different prose on a second run; the claims must still match.

`generateNarrative` returns the record. `checkNarrative` walks the evidence JSON for numbers, ISO dates, and links, then scans `what_happened`, `why`, and `what_it_means`. A number may use `$`, thousands separators, fewer decimal places, or integer rounding of a package value. If a figure, date, or URL is missing from the package, the process prints the mismatches and exits 1. It does not write the file. It does not check plant names, place names, or inference. The CLI writes only after the check passes. [#42](https://github.com/joshmcarthur/gridwatch/issues/42) must call the same function and must not publish a narrative that skipped it.

## Owner questions

Each has a default. The default is what the code does now.

1. Default model `anthropic/claude-haiku-4.5`? **[yes, until you pick]**
2. OpenRouter rather than a direct Anthropic or OpenAI key? **[yes]**
3. On-demand CLI, not the daily runner? **[yes]**
4. Store three JSON fields, not one markdown blob? **[yes]**

## Alternatives considered

- **Vercel AI SDK, or a raw `fetch` to OpenRouter.** Rejected. The owner named TanStack AI so the provider is a config string.
- **One TanStack adapter package per provider (`@tanstack/ai-openai`, `@tanstack/ai-anthropic`, ...).** Rejected. Extra packages and extra keys. OpenRouter is the swap.
- **Local Ollama on the home server.** Rejected for v1. No extra service, and the first narrative needs a model that follows the fact list. Ollama stays possible later through TanStack's Ollama adapter.
- **A gold Parquet table of narratives.** Rejected. Same reason as ADR-0025: the record is a small tree, and a row for every episode on every run would call the model when nobody asked.
- **Call the model from the publisher runner.** Rejected. That needs the key on every daily run. [#42](https://github.com/joshmcarthur/gridwatch/issues/42) decides when events emit.

## Consequences

- [#40](https://github.com/joshmcarthur/gridwatch/issues/40) is this checker. It walks the evidence JSON and rejects the write when a number, date, or link is missing.
- [#42](https://github.com/joshmcarthur/gridwatch/issues/42) still writes event pages. This CLI does not publish. Event pages must call `checkNarrative`.
- The Docker image gains `@tanstack/ai` and `@tanstack/ai-openrouter`. They are production dependencies because the CLI runs in the image. The key stays out of the image.
- The 27 July 2026 narrative for owner review needs a live key and the owner's model pick. If a PR ships the pipeline without that file, a follow-up issue holds the live run ([#206](https://github.com/joshmcarthur/gridwatch/issues/206)).
