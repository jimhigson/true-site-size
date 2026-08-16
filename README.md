# true-site-size

A GitHub Action that measures **what your site truly costs to load**: the
network bytes a browser transfers, from a cold cache, until your app says it
is ready — then comments the change on every pull request.

File-size diffing (eg compressed-size actions) can tell you a chunk got
bigger, but not whether anyone downloads it eagerly. true-site-size loads your
built site in headless Chrome, drives a real user journey, and counts wire
bytes until your own `performance.mark(...)` fires and the network settles.
It catches:

- code that moved from a lazy chunk into the eager path (and vice versa)
- assets newly fetched at startup
- dependency upgrades that bloat the critical path
- the same asset downloaded twice (eg `crossorigin` mismatches defeating
  request coalescing — flagged with 🔁 on the comment)
- the real effect of compression and http/2 on the wire

## Quick start

1. Mark your app's readiness moments — one line each:

   ```js
   performance.mark("app-ready"); // eg when the main screen renders
   ```

2. Add the action to a pull-request workflow:

   ```yaml
   - uses: jimhigson/true-site-size@main
     with:
       install-command: npm ci
       build-command: npm run build
       serve-dir: dist
       scenarios: |
         [{ "name": "app", "url": "/", "mark": "app-ready" }]
   ```

It builds and measures both the PR head and the base ref, then posts (and
updates in place) a comment with the change.

## Comparing against several refs

`base-refs` is a JSON array — give it more than one ref and each becomes its
own column, so you can see a PR against, say, both `main` and your last
release at once:

```yaml
- uses: jimhigson/true-site-size@main
  with:
    install-command: pnpm install
    clean-command: pnpm clean
    base-refs: |
      ["main", "v1.4.0"]
    scenarios: |
      [{ "name": "app", "url": "/", "mark": "app-ready" }]
```

Each column header links to the exact commit measured and is annotated with
`git describe` — so `main` shows up as the release it descends from, eg
`v1.4.0-4-gabc1234`. To compare against the *latest* release tag without
hardcoding it, resolve it in a prior step:

```yaml
- id: lasttag
  run: echo "ref=$(git describe --tags --abbrev=0)" >> "$GITHUB_OUTPUT"
- uses: jimhigson/true-site-size@main
  with:
    base-refs: '["main", "${{ steps.lasttag.outputs.ref }}"]'
    scenarios: '[{ "name": "app", "url": "/", "mark": "app-ready" }]'
```

Omitting `base-refs` falls back to the PR's base branch (a single column), so
existing single-ref setups need nothing.

## Keeping a long-lived PR's report fresh (eg a release PR)

A `pull_request` run only re-measures when *that PR's own branch* is pushed — it
does **not** re-fire when `main` advances underneath it. So a long-lived PR
whose branch rarely moves goes stale: merge a size-cutting change to `main` and
the open PR keeps showing the old numbers. A
[release-please](https://github.com/googleapis/release-please) release PR is the
classic case — it can lag several merges behind `main`, so its size report
misrepresents what the release actually ships.

Fix it by *also* measuring on push to `main` and pointing the comment at the
open release PR with `pr-number`:

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main] # refresh the open release PR's report when main moves

jobs:
  size:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ...install + build setup...

      # on push to main, find the open release PR whose report to refresh
      - id: release-pr
        if: github.event_name == 'push'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          n=$(gh pr list --state open --json number,headRefName \
                --jq 'map(select(.headRefName | startswith("release-please--")))[0].number')
          echo "number=$n" >> "$GITHUB_OUTPUT"

      - uses: jimhigson/true-site-size@main
        with:
          # a PR shows vs main and the last release; a push to main *is* main,
          # so it only compares against the last release
          base-refs: >-
            ${{ github.event_name == 'push' && '["v1.4.0"]' || '["main", "v1.4.0"]' }}
          # empty on a PR (comment lands on the event's PR); the release PR
          # number on a push, so its report reflects the just-merged code
          pr-number: ${{ steps.release-pr.outputs.number }}
          scenarios: '[{ "name": "app", "url": "/", "mark": "app-ready" }]'
```

On push to `main`, `pr-number` targets the open release PR; on a normal PR it's
empty, so the comment lands on the triggering PR as usual. An empty `pr-number`
with no PR in the event simply skips commenting.

## Journeys: measuring interaction, not just navigation

The `journey` input is the full step language; `scenarios` above is sugar for
its simplest form. Steps run **in order, in one browser session with a shared
http cache**, so each `row` reports only its incremental bytes and the rows
sum to the real user journey:

```yaml
journey: |
  [
    { "goto": "/" },
    { "row": "main menu", "mark": "menu-ready" },
    { "click": "#play" },
    { "click": ".campaign-list li:first-child" },
    { "row": "start game", "mark": "first-gameplay" }
  ]
```

| step | does |
| --- | --- |
| `{ "goto": url }` | navigate (relative urls resolve against the local server) |
| `{ "click": selector }` | wait for the selector to exist and be visible (up to `step-timeout-ms`), scroll to it, send a *trusted* click to its centre (`display:contents` elements are clicked via their first descendant with a box) |
| `{ "waitFor": selector }` | wait (up to `step-timeout-ms`) until the selector is present in the dom |
| `{ "waitForGone": selector }` | wait until the selector is *no longer* present — eg a loading dialog has cleared before you click to dismiss it |
| `{ "keys": "ArrowDown Enter" }` | trusted key presses, space-separated (named keys or single characters); each is held briefly so per-frame input loops (eg a game) register it |
| `{ "script": "..." }` | evaluate in the page, awaited if it returns a promise — the escape hatch |
| `{ "row": name, "mark": markName }` | wait for the `performance.mark`, let the network settle, close the segment as a comment row |
| `{ "row": name, "marks": [m1, m2] }` | as `mark`, but waits for *all* the named marks - for apps whose readiness is several independently-loading parts |
| `{ "row": name, "mark": markName, "emoji": "🎮" }` | on any `row`, `emoji` badges it in the comment (everywhere the row is named) instead of the auto-assigned colour circle — the same field works on a `scenarios` entry |
| `{ "startAgain": name }` | relaunch the browser **cold** (empty cache, as if a new user arrived) — the rows that follow accumulate as a new *visit* with its own Σ rows and its own bolded total, so one journey (and one build) can measure several apps served from the same `serve-dir`. `name` (or `true` for nameless) labels the visit's total; as the journey's *first* step it just names the first visit |

Any step may also carry `"afterMark": markName` to wait for an app readiness
mark before acting. Deliberately *not* included: actionability heuristics,
retries, iframes — journeys are measurements, not e2e tests; use `script`
for anything exotic.

## What the comment shows

- a row per journey segment, each given a colour circle (🟣🟠🔵🟡🟢🔴…) — or the
  row's own `emoji`, when the journey defines one — shown
  wherever the segment is named so it's easy to follow across the table and
  breakdowns: wire bytes for the PR, then a column per base ref showing the
  delta (with a severity emoji graded by the % change, à la
  [compressed-size-action](https://github.com/preactjs/compressed-size-action)),
  the relative % (📈 up / 📉 down), and the base's own bytes — stacked on their
  own lines. Segments are incremental, so (when there's more than one) each is
  followed by a `Σ so far` cumulative row — the running total to reach that
  point, in the same shape; the last one is the visit's end total. A journey
  with `startAgain` steps shows a 🔄 *cold restart* divider at each visit
  boundary; cumulative rows never sum across it, and every multi-row visit
  ends with its own bolded total (labelled with the visit's name).
  Each base column header links to
  the exact commit measured and is
  annotated with `git describe` (eg a branch shown as the release it descends
  from). Deltas smaller than `minimum-change-threshold` bytes show as unchanged
- a **per-file breakdown** grouped under a heading per base ref, with one
  entry per row: files whose transfer changed, matched across builds with
  content hashes stripped (`strip-hash`), new (🆕) and no-longer-loaded (🗑️)
  files flagged, identical files counted — "where did the bytes come from?"
  without leaving the PR. Changed rows are an expandable `<details>` by default
  (`collapse-breakdown: false` shows them inline); rows with no changes are a
  plain line, since there's nothing to reveal
- a **💾 total built size on disk** section below the loaded one: the
  compressed (as served) size of *every* file in `serve-dir`, loaded or not,
  with the relative (%) change and its own per-ref changed-files breakdown.
  Where the loaded bytes catch eager over-loading, this catches dead weight
  that ships but never loads — so the two can move in opposite directions (a
  PR can shrink the loaded path while growing the bundle, or vice versa).
  Disable with `measure-disk: false`
- 🔁 callouts for any url downloaded in full more than once in a segment — a
  standing duplicate-fetch bug in the app
- rows that could not be measured say why, explicitly: `unable to measure -
  mark "menu-ready" not seen within 60000ms`
- a link to the run log, which holds the full per-request evidence

Use `comment-key` to keep several independent comments on one PR (eg an app
and an admin UI, or a matrix over build targets).

## Determinism is verified, not assumed

Each measurement runs `runs` times (default 2) in fresh browser profiles, and
the minimum is reported. Runs are expected to agree to within
`spread-tolerance-bytes` (default 512 — http/2 header compression varies by a
few bytes with request arrival order). Spread within tolerance is shown as a
quiet footnote; spread above it triggers a prominent **determinism check
failed** warning, because deltas cannot be trusted while something loads
non-deterministically.

Measures taken so the numbers are reproducible and honest:

- **service worker registration disabled** during measurement — otherwise its
  background precache races the page and randomly absorbs bytes (its traffic
  is invisible to page-level accounting)
- **dedicated workers captured**: worker targets are attached paused, their
  network enabled, then released — so worker scripts and worker-initiated
  fetches are counted (and cannot wedge the settle detection)
- **non-localhost hosts resolve to nothing** — third-party variability is
  excluded; failed external requests are reported
- requests matching `ignore-url-patterns` are excluded from counts but shown,
  tagged, in the log — for endpoints whose response size legitimately varies
  (live database reads, feeds)
- every wait is capped (`mark-timeout-ms`, `step-timeout-ms`,
  `settle-timeout-ms` — which names the in-flight urls when an app never
  stops requesting) and a whole-action watchdog (`timeout-ms`) guarantees a
  loud failure rather than a hung CI job

## Served like production

The built site is served over **http/2 with TLS** (a deliberately-public
self-signed localhost certificate ships with the action; headless Chrome
trusts it via spki pinning, which - unlike a blanket ignore-certificate-errors
- keeps the http cache enabled so caching behaves like production). h2's compressed headers and
multiplexing make both byte counts and request timing match what a production
host transfers — http/1.1 serving would overstate per-request overhead and
accidentally serialise parallel fetches. Response bodies are compressed per
the `compression` input: `gzip`, `br`, `zstd` or `none`. The level defaults to
a moderate setting per codec — gzip 8, brotli 4, zstd 6 — rather than each
codec's build-time maximum. Override with `compression-level`: a number
(ranges gzip 0–9, br 0–11, zstd 1–22) or `max` for the ceiling (gzip 9,
brotli 11, zstd 22).

`zstd` requires the runner's Node to be **≥ 22.15** (or ≥ 23.8) — earlier
versions lack zstd support in Node's `zlib`, and the action fails fast with a
clear message if asked for `zstd` on an older Node. Pin a new enough Node with
`actions/setup-node` (`node-version: 22`) before this step. `gzip`, `br` and
`none` work on any supported Node. The measuring browser also needs to
advertise `zstd` in `Accept-Encoding` (Chrome ≥ 123), which current runner
images satisfy.

## What lands in the action log

The PR comment stays terse; the run log holds the evidence. For every
measured ref and row, the log contains the per-request breakdown from the run
that produced the reported number, largest first:

```
[true-site-size] head / main menu: 1.23 MB over 118 requests, mark at 1.83s (per-request breakdown follows, largest first)
   697.8 kB  at    142ms  https://localhost:40123/assets/store-DJE4cVo5.js
    65.3 kB  at    187ms  https://localhost:40123/assets/sprites-BYouFVgw.webp
      267 B  at     98ms  https://localhost:40123/api/campaigns  [ignored - not counted]
      ...
```

Diffing two runs' breakdowns names the exact urls responsible for any delta.
Build output from `install-command`/`build-command` streams to the same log.

Base-ref measurements are cached by (base sha, measurement config) via
`actions/cache`, so repeat pushes to a pull request skip rebuilding and
re-measuring the unchanged base — the log says `base ... loaded from cache`.
Only fully-successful base measurements are cached.

## Inputs

| input | default | |
| --- | --- | --- |
| `journey` | — | JSON array of steps (see above); takes precedence over `scenarios` |
| `scenarios` | — | sugar: JSON array of `{name, url, mark}`, each a goto+row |
| `install-command` | `""` | run in each checkout before building (empty skips) |
| `build-command` | `npm run build` | produces the site (empty skips) |
| `clean-command` | `""` | run in the workspace between the head and base builds to isolate them, eg `pnpm clean` — the base builds in a workspace subdir and can otherwise inherit head's `node_modules` |
| `serve-dir` | `dist` | directory served after building |
| `compression` | `gzip` | simulate the host: `gzip`, `br`, `zstd` or `none` (`zstd` needs Node ≥ 22.15) |
| `compression-level` | per codec | level for the chosen encoding, or `max`; ranges gzip 0–9, br 0–11, zstd 1–22; empty uses gzip 8 / br 4 / zstd 6 |
| `runs` | `2` | repeats; agreement within tolerance is the determinism check |
| `spread-tolerance-bytes` | `512` | spread treated as h2 protocol noise |
| `minimum-change-threshold` | `1` | deltas below this many bytes show as unchanged (as compressed-size-action) |
| `ignore-url-patterns` | `[]` | JSON array of regexes excluded from counts |
| `settle-ms` | `1500` | network quiet required after each mark |
| `mark-timeout-ms` | `60000` | per-row wait for the mark |
| `step-timeout-ms` | `20000` | per-step cap, eg a click target appearing |
| `settle-timeout-ms` | `30000` | cap on settling; errors with in-flight urls named |
| `timeout-ms` | `900000` | whole-action watchdog |
| `base-refs` | PR base | JSON array of refs to compare against, each its own column (linked + `git describe`'d), eg `["main", "v1.4.0"]`; empty uses the PR base branch |
| `strip-hash` | vite-style | regex stripped from filenames for per-file matching; `""` disables |
| `comment` | `true` | post/update the PR comment |
| `pr-number` | event PR | PR number to comment on; set it to comment from a non-PR event (eg a push to main updating an open release PR) |
| `collapse-breakdown` | `true` | collapse each ref's changed-file breakdown into an expandable `<details>`; `false` shows it inline |
| `measure-disk` | `true` | also report total built size on disk (compressed as served, every file in serve-dir); `false` skips the cost on large sites |
| `comment-key` | `""` | maintain separate comments per key |
| `github-token` | `${{ github.token }}` | for the comment |

Requires a Chrome/Chromium on the runner (preinstalled on GitHub's Ubuntu
runners; override with `CHROME_PATH`). Needs `pull-requests: write` permission
for the comment.

## Environment variables

These are read from the environment rather than passed as `with:` inputs, so
they can be set for local/advanced runs (eg under [`act`](https://github.com/nektos/act)):

| env var | |
| --- | --- |
| `CHROME_PATH` | path to the Chrome/Chromium binary, if not in a standard location |
| `TRUE_SITE_SIZE_CACHE_DIR` | directory the base-ref measurement is cached in, keyed by `(base sha, config)` |
| `TRUE_SITE_SIZE_OUTPUT_FILE` | also write the comment markdown to this file. Useful for local runs (eg `act`, where `GITHUB_STEP_SUMMARY` lives inside the container and isn't readable on the host) that want to read the report back out |
| `TRUE_SITE_SIZE_ALLOW_DESTRUCTIVE` | measure base refs even under `act` (see below) — set it only on a checkout you are content to have cleaned and worktree'd into |

## Running locally under act

Measuring a base ref writes to the workspace: it runs `clean-command` there
(often `rm -rf dist node_modules`) and checks the base out into a git worktree
at `.true-site-size-base` inside it. On a runner that is a throwaway checkout;
under [`act --bind`](https://github.com/nektos/act) the workspace is your own
working directory, where neither is welcome. So whenever `$ACT` is set the base
comparison is skipped and the report covers head alone, saying so in place of
the comparison columns. `TRUE_SITE_SIZE_ALLOW_DESTRUCTIVE=1` compares anyway.

The comparison is skipped the same way, with the same head-only report, when
git cannot work in the workspace at all — as when the checkout is itself a git
worktree, whose `.git` is a file naming a gitdir that is not present inside the
container, so every git command answers `fatal: not a git repository: (null)`.

`install-command` and `build-command` run in the workspace either way: building
head is what there is to measure.

## Authorship

Built by Claude (an Anthropic AI agent), commissioned and directed by Jim
Higson. MIT licensed.
