# ADR-0022: Editorial review and publish flow for events

- Status: Accepted
- Date: 2026-11-22

Owner decided in chat, 2026-11-22, Pacific/Auckland. This ADR replaces the allow-list proposed in [#125](https://github.com/joshmcarthur/gridwatch/pull/125), which was never accepted.

## Context

An **observation** is a deterministic fact a detector found ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). An **episode** groups related observations ([ADR-0021](0021-episodes.md), [brief §6.2](../brief.md)). An **event** is an episode judged worth explaining publicly ([brief §6.3](../brief.md)).

Detection must not decide what is newsworthy. Ranking ([#37](https://github.com/joshmcarthur/gridwatch/issues/37)) may still choose which episodes become events. This ADR is only what happens once the pipeline has emitted an event.

[#41](https://github.com/joshmcarthur/gridwatch/issues/41) asked for a static-friendly flow with no new services ([brief §11](../brief.md), [ADR-0002](0002-daily-run-data-and-site-hosting.md)): candidates as files, the owner approves by editing a committed file or merging a PR, and only approved events reach `data/gold/site/events/`. [Brief §15](../brief.md) leaves open "how much editorial review is necessary?".

[#125](https://github.com/joshmcarthur/gridwatch/pull/125) proposed that default: a committed allow-list at `site/events/approved.json`, approval by merge, and unpublished drafts never appearing in site JSON.

The owner rejected that gate.

## Owner decision

Exact owner words: **Publish immediately as “Unreviewed”. I can design a flow later for me to mark events as moderated/reviewed.**

That answers brief §15: none before first publish. Review is a later moderation flag, not a gate.

## Decision

Every published event carries `review_status`: `unreviewed` | `reviewed`. The visible label on the site for `unreviewed` is **Unreviewed**. Default at publish time is `unreviewed`.

There is no editorial gate in v1. Ranked or generated events that the pipeline emits are public, labelled Unreviewed, until a later flow lets the owner mark them reviewed or moderated.

Unpublished drafts are not a thing in v1. If the pipeline wrote the event, the site may show it, marked Unreviewed. Do not keep a second, hidden copy that the build enumerates only after approval.

Do not add `site/events/approved.json`. Do not require a PR to publish an event.

### The stub field

`review_status` is a stub the future mark-as-reviewed flow can flip. This ADR does not invent that flow: no git file of reviewed ids, no checkbox, no CMS, no owner UI. A later issue designs how the owner sets `reviewed`. Until then every emitted event stays `unreviewed`.

The events JSON shape, event pages, and the homepage feed stay on [#42](https://github.com/joshmcarthur/gridwatch/issues/42). Ranking stays on [#37](https://github.com/joshmcarthur/gridwatch/issues/37). Evidence packages stay on [#38](https://github.com/joshmcarthur/gridwatch/issues/38). LLM narratives stay on [#39](https://github.com/joshmcarthur/gridwatch/issues/39). This ADR does not build them.

When those issues add an `events` section to the site JSON, they amend [ADR-0014](0014-site-json-contract.md) and put `review_status` on each item, default `unreviewed`. There is no events exporter on main yet, so this ADR adds no contract type and no gold table.

Episodes already listed on daily pages as grouped readings are not events. They do not gain `review_status` or an Unreviewed label.

### What still chooses what becomes an event

This is not "publish every observation" and not "publish every episode". Brief §6.3 still holds: not every anomaly becomes a published event. Ranking and generation decide what the pipeline emits. Once it has emitted an event, v1 does not wait for a second human approval before the site may show it.

## Alternatives considered

- **Allow-list at `site/events/approved.json`, approval by merge ([#125](https://github.com/joshmcarthur/gridwatch/pull/125)).** Rejected by the owner. Too much editorial review before first publish. The owner will mark events reviewed later.
- **Unpublished drafts that never appear in site JSON.** Rejected. The owner wants pipeline output public as Unreviewed. A hidden candidate directory is a gate by another name.
- **Always publish every episode or observation.** Rejected. Ranking ([#37](https://github.com/joshmcarthur/gridwatch/issues/37)) still proposes which episodes become events. This ADR only removes the gate after emit.
- **GitHub issue checkbox as the v1 gate.** Rejected, both as a gate (the owner wants no gate) and as a mechanism. Approval would live on the issue, not in git. The home-server publisher would need a GitHub token or a webhook, which [brief §11](../brief.md) and [ADR-0002](0002-daily-run-data-and-site-hosting.md) avoid.
- **CMS, Postgres, or an approval API.** Rejected for v1. The brief lists those as later, if the project needs editable event records or workflows ([brief §11](../brief.md)).
- **Build the mark-as-reviewed UI in this ADR.** Rejected. The owner will design that flow later. Only the stub field is in scope.

## Consequences

- [#41](https://github.com/joshmcarthur/gridwatch/issues/41) has an agreed flow: Unreviewed on publish; review later. The later mark-as-reviewed UI, and one event through a live exporter, are follow-up work. They do not block accepting this ADR.
- The first public events can ship as soon as ranking, narratives, and event pages write them. They will say Unreviewed. That is the point.
- The owner is not on the path of every public event. Wrong or noisy events can appear until the later flag exists. The Unreviewed label is the v1 mitigation.
- Agents must not implement `site/events/approved.json` or any other publish allow-list.
