# ADR-0022: Editorial review and publish flow for events

- Status: Proposed
- Date: 2026-11-21

Do not build this flow until the owner accepts this ADR. [#41](https://github.com/joshmcarthur/gridwatch/issues/41) stays open until that agreement, and until one event has gone candidate → approved → site JSON.

## Context

An **observation** is a deterministic fact a detector found ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). An **episode** groups related observations ([brief §6.2](../brief.md), [#36](https://github.com/joshmcarthur/gridwatch/issues/36)). An **event** is an episode judged worth explaining publicly. Detection must not decide what is newsworthy ([brief §6.3](../brief.md)). A separate editorial layer does that ([brief §13 Phase 4](../brief.md)).

[Brief §15](../brief.md) leaves open "how much editorial review is necessary?". That is the owner's call. This ADR proposes a default.

[#41](https://github.com/joshmcarthur/gridwatch/issues/41) asks for a static-friendly flow with no new services ([brief §11](../brief.md), [ADR-0002](0002-daily-run-data-and-site-hosting.md)): candidates and narratives as files, the owner approves by editing a committed file or merging a PR, and only approved events are written to `data/gold/site/events/`.

The site already reads prepared JSON and does not query the lake ([ADR-0014](0014-site-json-contract.md)). `data/` is gitignored ([ADR-0001](0001-typescript-monorepo-and-data-layers.md)). GitHub Actions is CI only; the daily job on the home server runs collector, publisher, then site-build ([ADR-0002](0002-daily-run-data-and-site-hosting.md)).

The episode gold table exists ([ADR-0021](0021-episodes.md)). Every episode in it is already a candidate, so this flow adds no candidate store. A hand-written event from [#21](https://github.com/joshmcarthur/gridwatch/issues/21) is a valid first candidate and does not need an episode row.

## Decision (proposed)

Use the smallest git-native gate. Ranking may propose. Only a merged allow-list entry publishes.

### Paths

| Role | Path | In git? | Who writes it |
| --- | --- | --- | --- |
| Candidate (machine) | The `episodes` gold table ([ADR-0021](0021-episodes.md)). No new path. | No | The publisher, already. |
| Candidate or narrative (hand-written) | `docs/events/<id>.md` | Yes | A person or an agent, as [#21](https://github.com/joshmcarthur/gridwatch/issues/21) already plans. |
| Allow-list | `site/events/approved.json` | Yes | A PR that adds or removes an event id. |
| Published events | `data/gold/site/events/` | No | The site exporter, and only for ids on the allow-list. |

`data/gold/site/events/_approved.json` is not the allow-list. `data/` is gitignored, so that file could not be the committed editorial record.

### Allow-list

`site/events/approved.json` is a JSON object with a list of event ids, for example:

```json
{ "approved": ["2026-07-27-ni-scarcity"] }
```

An event id is a stable string. A hand-written event uses a slug. An `episode_id` from [ADR-0021](0021-episodes.md) can be the same string. The file is the publish gate, not the narrative store.

### Approval

1. Episodes are written to gold, outside `gold/site/`. A hand-written candidate is a file in `docs/events/`.
2. Someone opens a PR that adds the event id to `site/events/approved.json`. The same PR may add or edit the narrative.
3. The owner merges the PR. That merge is approval. There is no CMS, no webhook, and no GitHub API on the daily path.
4. The next publisher run reads the committed allow-list and writes site JSON only for those ids, under `data/gold/site/events/`.
5. The site build reads that directory. Unpublished drafts never appear in site JSON, not as a feed item, not on a daily page, not as an unlinked file the build enumerates.

Removing an id in a follow-up PR un-publishes the event on the next publisher and site-build run. A leftover file on disk is not linked. The public index is built from the allow-list.

### How much review

The minimum review is one question: is this id worth showing on the public site? The owner answers it by merging or not merging the allow-list PR.

[#37](https://github.com/joshmcarthur/gridwatch/issues/37) may rank episodes and list candidates. Ranking does not publish. Auto-publish above a score is a later change to this ADR, not the default.

Narrative editing can happen in the same PR. Claim checking ([#40](https://github.com/joshmcarthur/gridwatch/issues/40)) and the event JSON contract ([#42](https://github.com/joshmcarthur/gridwatch/issues/42), an amendment to [ADR-0014](0014-site-json-contract.md)) are separate. This ADR is only the gate.

### First event

The first id through the flow can be the [#21](https://github.com/joshmcarthur/gridwatch/issues/21) reconstruction, once that write-up exists. It does not need an episode table.

## Alternatives considered

- **GitHub issue checkbox.** Rejected. Approval would live on the issue, not in git. The home-server publisher would need a GitHub token and an API read, or a webhook. That is a new service, which [brief §11](../brief.md) and [ADR-0002](0002-daily-run-data-and-site-hosting.md) avoid. A checkbox is not a reviewable diff.
- **Local flag file under `DATA_ROOT`.** Rejected. `data/` is gitignored. A flag on disk is not in a PR, is not visible in CI, and disappears if the disk is wiped. The editorial record would not travel with the repository.
- **Always publish everything.** Rejected. [Brief §6.3](../brief.md) says not every anomaly becomes a published event. One year of the price-anomaly detector already produced hundreds of observations ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). Publishing all of them would turn the site into an anomaly dump. Detection finds interesting things; it does not decide what is newsworthy.
- **CMS, Postgres, or an approval API.** Rejected. The brief lists those as later, if the project needs editable event records or workflows ([brief §11](../brief.md)). One owner and a static site do not need them yet.
- **Allow-list at `data/gold/site/events/_approved.json`.** Rejected. Same gitignore problem as a local flag file. `site/events/approved.json` is the committed path.

## Consequences

- No new service. Approval is an ordinary PR. The daily job already runs the publisher after a git pull on the home server, so a merge is enough.
- Unpublished episodes stay in the `episodes` gold table without affecting the site.
- The owner is on the path of every public event. That is the point of this default. If that becomes too slow, a later amendment can auto-publish above a rank, still using the same allow-list as an override.
- The event JSON shape, event pages, and the homepage feed stay on [#42](https://github.com/joshmcarthur/gridwatch/issues/42). This ADR does not change [ADR-0014](0014-site-json-contract.md).
- Agents must not add ids to the allow-list, and must not implement the exporter gate, until the owner accepts this ADR.

## Owner questions

Defaults are in brackets. Reply on this pull request. Do not treat silence on the issue as agreement; this ADR is Proposed until you say so.

1. How much editorial review is necessary? [Gate every public event on a merged allow-list PR. Do not auto-publish ranked candidates.]
2. Allow-list path? [`site/events/approved.json`]
3. What counts as approval? [Merge of a PR that adds the event id.]
4. May a ranked-but-unapproved candidate appear anywhere on the public site? [No]
5. How do we un-publish? [Remove the id from the allow-list in a follow-up PR.]
6. Who may merge the allow-list PR? [The owner]
7. Build the exporter gate and an empty allow-list now? [No. Wait until you accept this ADR.]
