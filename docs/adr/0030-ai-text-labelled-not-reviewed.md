# ADR-0030: AI-written text is labelled as AI, not by review status

- Status: Accepted
- Date: 2026-11-25

Amends [ADR-0022](0022-editorial-review-and-publish-flow.md) (the visible "Unreviewed" label) and [ADR-0027](0027-llm-narratives.md) (how narratives are shown).

## Context

[ADR-0022](0022-editorial-review-and-publish-flow.md) publishes events without an editorial gate, labelled **Unreviewed**, with a `review_status` stub for a later flow in which the owner would mark them reviewed. [ADR-0027](0027-llm-narratives.md) writes those events' narratives with a language model, and checks every number in them against the evidence package.

The owner, 2026-11-25: "I don't plan to review these, so it might be better to instead label it as AI generated and indicate what data was used to create the summary, along with possibly a 'How we use AI' on the 'How do we do this page' to link to".

"Unreviewed" implies a review that will never come. It also tells a reader nothing about where the text came from, which matters more.

## Decision

- **No human review of AI-written text.** No mark-as-reviewed flow is planned. The `review_status` field stays in the site contract as `unreviewed`, so the contract does not change, but no page shows it.
- **The visible label is "Written by AI".** It sits on every piece of model-written text: event write-ups today, and day and week write-ups if they come ([ADR-0029](0029-map-led-day-stories.md) prototype).
- **Each piece shows what it was written from.** A "What this was written from" disclosure lists the figures the model was given (for an event, its evidence claims with their confidence labels). It says a program checked every number in the text against those figures, and links to the How page.
- **The How page explains the AI's role** in a "How this site uses AI" section (`/how/#ai`): which text is written by AI and how it's labelled, what the model is given, the number check, that nobody reviews each piece, and that the maps, charts, moments and tables come from fixed rules, not AI.

## Rationale

A provenance label ("written by AI, from these figures") gives a reader what they need to weigh the text. A review label only says what hasn't happened. Listing the inputs and linking to one explanation also makes the number check visible, which is the real safeguard here.

## Consequences

- `REVIEW_LABEL` ("Unreviewed") leaves the site. Pages say "Written by AI".
- The number check remains the only automatic safeguard. A failed check still logs a warning and publishes ([ADR-0027](0027-llm-narratives.md)). Whether to withhold text that fails the check, now that no person reviews it, is an open owner question. The How page states only what happens today.
- If review is wanted later, `review_status` is still there to flip, and the label can be extended without a contract change.
