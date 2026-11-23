# 27 July fixture-merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the PR 213 stack, replace the hollow 27 July fixture with PR 220's complete day and keep the Unreviewed event.

**Architecture:** Fixture splice only. Copy `origin/issue-214-july-sample:site/fixtures/days/2026-07-27.json`, attach `events` from the current 213 file, rewrite `index.json` and the copy that still calls the day hollow. The site already knows how to load a complete day and an events list.

**Tech Stack:** Node 26, vitest, committed `site/fixtures/` JSON, Python 3 for the one-off splice (stdlib `json` + `hashlib`).

## Global Constraints

- Stack: `origin/issue-42-event-pages` (PR 213). Do not stack on closed PR 211.
- Do not invent site JSON. Do not re-export the lake.
- Do not change event id `394f75a3bfa948a3`, claims, window, or narrative strings.
- Do not dirty `/tmp/gridwatch-issue-221` or `/tmp/gridwatch-issue-214`.
- Do not add Co-authored-by. Do not pass `--no-verify`.
- Node via `mise exec node@26.13.1 --` when the shell node is not 26.
- Published copy follows `docs/site-copy.md` (clock times, place names, no unexplained jargon).

---

### Task 1: Failing complete-day-plus-event test

**Files:**
- Modify: `site/src/lib/site-data.test.ts` (after the `loadSiteDayIfPresent` tests, before `loadSiteDay reads a gold day`)
- Test: `site/src/lib/site-data.test.ts`

**Interfaces:**
- Consumes: `loadSiteDay(date: string): SiteDay` from `site/src/lib/site-data.ts`
- Produces: one vitest that the 27 July fixture is a complete 48-period day with Unreviewed event `394f75a3bfa948a3`

- [ ] **Step 1: Write the failing test**

In `site/src/lib/site-data.test.ts`, insert this test after `loadSiteDayIfPresent does not invent a day that is not in the sample` and before `loadSiteDay reads a gold day when DATA_ROOT has a matching file`:

```typescript
test("fixture 2026-07-27 is a complete day with the Unreviewed event", () => {
  process.env.DATA_ROOT = dataRoot;
  const day = loadSiteDay("2026-07-27");
  expect(day.complete).toBe(true);
  expect(day.generation.state).toBe("complete");
  expect(day.prices.state).toBe("complete");
  expect(day.periods).toHaveLength(48);
  const otahuhu = day.prices.nodes.find(
    (node) => node.point_of_connection === "OTA2201",
  );
  expect(otahuhu?.price[35]).toBe(3296.04);
  expect(day.events?.items).toHaveLength(1);
  expect(day.events?.items[0]?.episode_id).toBe("394f75a3bfa948a3");
});
```

Do not change the index-date list test; 213 already lists `2026-07-27`.

- [ ] **Step 2: Run the test and confirm it fails on completeness**

Run:

```bash
mise exec node@26.13.1 -- npm test -- site/src/lib/site-data.test.ts
```

Expected: FAIL. `day.complete` is `false` and/or `day.generation.state` is `"missing"`. The event id assertion must not be the first failure (the hollow 213 file already has that event).

- [ ] **Step 3: Commit the failing test**

```bash
git add site/src/lib/site-data.test.ts
git commit -m "$(cat <<'EOF'
#221: Expect the 27 July fixture to be a complete day with the event.

The hollow evening-window file still loads the Unreviewed event. The
sample must also keep generation and prices from the complete gold copy.
EOF
)"
```

---

### Task 2: Splice the complete day and rewrite the index

**Files:**
- Modify: `site/fixtures/days/2026-07-27.json`
- Modify: `site/fixtures/index.json`

**Interfaces:**
- Consumes: `origin/issue-214-july-sample:site/fixtures/days/2026-07-27.json`; `HEAD:site/fixtures/days/2026-07-27.json` `events` object; `HEAD:site/fixtures/index.json`
- Produces: compact day JSON with 220 body + 213 `events`; 27 July index row `complete: true`, every section `complete`, `export_sha256` = SHA-256 of the new day bytes; `latest_complete_sections.events` = `"2026-07-27"`

- [ ] **Step 1: Write the spliced day file and index**

From the worktree root, run this Python (stdlib only). Do not pretty-print. Do not re-export gold.

```python
import hashlib, json, subprocess
from pathlib import Path

def git_show(ref: str, path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{ref}:{path}"])

day = json.loads(git_show("origin/issue-214-july-sample", "site/fixtures/days/2026-07-27.json"))
hollow = json.loads(git_show("HEAD", "site/fixtures/days/2026-07-27.json"))
assert "events" not in day
assert hollow["events"]["items"][0]["episode_id"] == "394f75a3bfa948a3"
day["events"] = hollow["events"]
day["complete"] = True
body = json.dumps(day, separators=(",", ":"), ensure_ascii=False) + "\n"
path = Path("site/fixtures/days/2026-07-27.json")
path.write_text(body, encoding="utf-8")
digest = hashlib.sha256(path.read_bytes()).hexdigest()

index = json.loads(Path("site/fixtures/index.json").read_text(encoding="utf-8"))
july = next(row for row in index["days"] if row["date"] == "2026-07-27")
july["complete"] = True
july["sections"] = {
    "generation": "complete",
    "prices": "complete",
    "sankey": "complete",
    "episodes": "complete",
    "reserves": "complete",
    "nodal_map": "complete",
    "events": "complete",
}
july["export_sha256"] = digest
index["latest_complete_sections"]["events"] = "2026-07-27"
Path("site/fixtures/index.json").write_text(
    json.dumps(index, separators=(",", ":"), ensure_ascii=False) + "\n",
    encoding="utf-8",
)
print(digest)
```

Expected stdout: a 64-character hex digest. Confirm `git diff --stat` shows a large `2026-07-27.json` and a small `index.json`.

- [ ] **Step 2: Re-run the test and confirm it passes**

```bash
mise exec node@26.13.1 -- npm test -- site/src/lib/site-data.test.ts site/src/lib/event-page.test.ts
```

Expected: PASS. `event-page.test.ts` still finds `/2026/07/27/events/394f75a3bfa948a3/`.

- [ ] **Step 3: Commit the splice**

```bash
git add site/fixtures/days/2026-07-27.json site/fixtures/index.json
git commit -m "$(cat <<'EOF'
#221: Keep the complete 27 July sample and add the Unreviewed event.

Copy the gold day from #214 and attach the #42 events object. Do not
restore the hollow evening-window fixture.
EOF
)"
```

---

### Task 3: Stop calling 27 July hollow

**Files:**
- Modify: `site/fixtures/README.md`
- Modify: `site/README.md`
- Modify: `docs/explainers.md`
- Modify: `site/src/content/explainers/nodal-pricing.md`

**Interfaces:**
- Consumes: fixture table and data-contract paragraphs that still say 27 July is hollow / missing
- Produces: copy that names a complete 27 July sample with the Unreviewed event, without inventing JSON or a lake

- [ ] **Step 1: Update fixture README**

Replace the 27 July row and the paragraph under the table in `site/fixtures/README.md`:

```markdown
| Day | Why it is here |
| --- | --- |
| 2026-07-27 | Monday 27 July: complete day, evening spike, Unreviewed event |
| 2026-09-26 | Ordinary Saturday, 48 periods |
| 2026-09-27 | DST start, 46 periods |
| 2026-10-29 | Ordinary Thursday, 48 periods |

Each day has a full fuel mix, real Otahuhu / Haywards / Benmore prices, and a complete energy-balance Sankey. 27 July keeps that day's gold episodes and the Unreviewed event. The other three days may have an empty episode list: the 28-day detector window is not in this sample.

To refresh, collect and publish those dates into a local `DATA_ROOT`, then copy only the complete day files and rewrite `index.json` to list those days. Keep the Unreviewed event on 27 July from this sample; do not invent a new event object. Do not run `UPDATE_SITE_FIXTURES=1`; that updates the exporter lock, not this directory.
```

- [ ] **Step 2: Update site README data-contract paragraph**

In `site/README.md`, replace the sentence that starts `The publisher writes one JSON file` so the fixture list reads:

`site/fixtures/` holds four complete sample days so a checkout without gold still shows a real mix, real reference-node prices, and the energy-balance Sankey: 2026-07-27 (the 27 July evening, including the Unreviewed event), 2026-09-26 (ordinary Saturday), 2026-09-27 (DST start, 46 periods), and 2026-10-29 (ordinary Thursday).

Keep the rest of that paragraph (types from `@gridwatch/publisher/site-contract`, exporter lock, `UPDATE_SITE_FIXTURES=1`).

- [ ] **Step 3: Update explainers spec and nodal-pricing prose**

In `docs/explainers.md`:

- Rename `## Fixture-day gap` to `## Fixture-day sample`.
- Replace the opening paragraph and bullets with:

```markdown
[`site/fixtures/`](../site/fixtures/) includes Monday 27 July 2026 as a copy of a real publish, plus the Unreviewed event from #42. The nodal-pricing explainer injects `PriceChart` for that date. Do not substitute 2026-09-27 (DST start, synthetic reference-node prices) for this example.

- Do **not** commit a 12-month lake so the explainer can chart.
- Do **not** invent a 27 July day file. Refresh the charts by copying a gold export, then keep the event object from this sample.
- Do **not** fail the fixture build when some other `example_date` is absent from the index.
- Quote the evening figures in the Markdown so the page still reads if that day's file is missing.
```

- Replace `When #42 later publishes an event that covers the same day, add that URL in section 5 of the same Markdown file.` with: `The event page for this evening is `/2026/07/27/events/394f75a3bfa948a3/`, linked from section 5 of the nodal-pricing page.`
- In Out of scope, replace `No reconstruction of #21, and no invented 2026-07-27 site JSON.` with `No reconstruction of #21, and no invented 2026-07-27 site JSON (the visual sample is a copy of a real publish).`

In `site/src/content/explainers/nodal-pricing.md`, change the historical-example closing sentence from:

`The daily page for [Monday 27 July 2026](/2026/07/27/) has that day's generation, prices, and charts when the day's files are on this site.`

to:

`The daily page for [Monday 27 July 2026](/2026/07/27/) has that day's generation, prices, and charts.`

Leave the existing event link in section 5.

- [ ] **Step 4: Commit copy**

```bash
git add site/fixtures/README.md site/README.md docs/explainers.md site/src/content/explainers/nodal-pricing.md
git commit -m "$(cat <<'EOF'
#221: Record that the 27 July sample is a complete day with the event.

The fixture README and explainer spec still described a hollow evening
window. Name the gold copy and the Unreviewed event instead.
EOF
)"
```

---

### Task 4: Tighten built-page a11y checks

**Files:**
- Modify: `site/src/lib/explainer.a11y.test.ts`
- Modify: `site/src/lib/daily-page.a11y.test.ts`

**Interfaces:**
- Consumes: `site/dist/explainers/nodal-pricing/index.html` and `site/dist/2026/07/27/index.html` when a fixture build exists
- Produces: tests that fail a build which still shows the prices-missing gap on those pages

- [ ] **Step 1: Require PriceChart on the nodal-pricing explainer**

In `site/src/lib/explainer.a11y.test.ts`, replace the test named `built nodal-pricing visual reuses PriceChart when the day exists, else quotes the gap` with:

```typescript
test.skipIf(!existsSync(explainerPage))(
  "built nodal-pricing visual reuses PriceChart for 27 July",
  () => {
    const html = readFileSync(explainerPage, "utf8");
    expect(html).toContain('id="price-chart-title"');
    expect(html).toContain(
      'aria-labelledby="price-chart-title price-chart-summary"',
    );
    expect(html).toContain(
      'aria-labelledby="price-spread-chart-title price-spread-chart-summary"',
    );
    expect(html).toContain("OTA2201");
    expect(html).not.toMatch(/when that day is published here/);
  },
);
```

- [ ] **Step 2: Require charts on the built 27 July daily page**

At the top of `site/src/lib/daily-page.a11y.test.ts`, next to `builtPage`, add:

```typescript
const julyPage = fileURLToPath(
  new URL("../../dist/2026/07/27/index.html", import.meta.url),
);
```

At the end of the file, add:

```typescript
test.skipIf(!existsSync(julyPage))(
  "built 27 July daily page shows generation and wholesale-price charts",
  () => {
    const html = readFileSync(julyPage, "utf8");
    expect(html).toContain('aria-labelledby="generation-mix"');
    expect(html).toContain('id="price-chart-title"');
    expect(html).toContain('id="price-spread-chart-title"');
    expect(html).not.toMatch(/Wholesale prices for this day are missing/);
  },
);
```

- [ ] **Step 3: Run unit tests (a11y tests skip without dist)**

```bash
mise exec node@26.13.1 -- npm test -- site/src/lib/explainer.a11y.test.ts site/src/lib/daily-page.a11y.test.ts site/src/lib/site-data.test.ts site/src/lib/event-page.test.ts
```

Expected: PASS. skipIf tests skip if `site/dist` is absent.

- [ ] **Step 4: Commit a11y expectations**

```bash
git add site/src/lib/explainer.a11y.test.ts site/src/lib/daily-page.a11y.test.ts
git commit -m "$(cat <<'EOF'
#221: Expect fixture builds to chart 27 July on the explainer and daily page.

A complete sample must not take the prices-missing gap path.
EOF
)"
```

---

### Task 5: Typecheck, fixture build, and a11y against dist

**Files:**
- None expected unless a test or copy failure forces a one-line fix

**Interfaces:**
- Consumes: spliced fixtures from Tasks 2–4
- Produces: typecheck 0 errors; site build includes `/2026/07/27/` and `/2026/07/27/events/394f75a3bfa948a3/`; a11y tests pass against `site/dist`

- [ ] **Step 1: Typecheck**

```bash
mise exec node@26.13.1 -- npm run typecheck -w site
```

Expected: 0 errors.

- [ ] **Step 2: Build the site from fixtures**

```bash
mise exec node@26.13.1 -- npm run build -w site
```

Expected: success. Output lists `/2026/07/27/` and `/2026/07/27/events/394f75a3bfa948a3/`.

- [ ] **Step 3: Re-run a11y tests against dist**

```bash
mise exec node@26.13.1 -- npm test -- site/src/lib/explainer.a11y.test.ts site/src/lib/daily-page.a11y.test.ts site/src/lib/event-page.test.ts
```

Expected: PASS, including the new 27 July daily-page and explainer chart checks.

- [ ] **Step 4: If the build or a11y run forced a fix, commit it. If not, do not create an empty commit.**
