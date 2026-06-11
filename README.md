# true-site-size

A GitHub Action that measures **what your site really costs to load**: the
network bytes a browser transfers, from a cold cache, until your app says it
is ready — then comments the change on every pull request.

File-size diffing (eg compressed-size actions) can tell you a chunk got
bigger, but not whether anyone downloads it eagerly. true-site-size loads your
built site in headless Chrome and counts wire bytes until your own
`performance.mark(...)` fires and the network settles, so it captures:

- code that moved from a lazy chunk into the eager path (and vice versa)
- assets newly fetched at startup
- dependency upgrades that bloat the critical path
- the real effect of compression on the wire

## How it works

1. Your app marks its own readiness moments - one line each:

   ```js
   performance.mark("menu-ready"); // eg when the main menu renders
   performance.mark("first-gameplay"); // eg on the first game frame
   ```

2. The action builds your site (head and base refs), serves it locally with
   production-like compression, and drives scenarios **in order, in one
   browser session with a shared cache** - so each scenario reports only its
   incremental bytes, and the rows sum to the real user journey:

   ```yaml
   - uses: jimhigson/true-site-size@main
     with:
       install-command: pnpm install --frozen-lockfile
       build-command: pnpm build
       serve-dir: dist
       scenarios: |
         [
           { "name": "main menu", "url": "/", "mark": "menu-ready" },
           { "name": "gameplay", "url": "/?autostart=1", "mark": "first-gameplay" }
         ]
   ```

3. Counting stops only when the network has been quiet for `settle-ms` after
   the mark, so requests *triggered by* becoming ready are included and the
   numbers are deterministic.

4. **Determinism is verified, not assumed**: each measurement runs `runs`
   times (default 2) in fresh browser profiles. Byte-identical results prove
   the number is a reproducible fact and the comment reports it plainly; any
   disagreement means something loads non-deterministically, and the comment
   carries a prominent warning instead of a quietly-wrong delta. The
   per-request breakdown (every url, size and timing) is printed to the run
   log and linked from the comment for diagnosis.

5. On PRs it posts (and updates in place) a comment comparing against the base
   branch - or against `base-ref` if set, eg comparing release PRs against the
   previous release.

## What lands in the action log

The PR comment stays terse; the **run log holds the evidence** (the comment
links to it). For every measured ref and row, the log contains the full
per-request breakdown from the run that produced the reported number, largest
first:

```
[true-site-size] head / main menu: 1291886 bytes over 118 requests, mark at 239ms (per-request breakdown follows, largest first)
     714539 B  at    142ms  http://localhost:40123/assets/store-DJE4cVo5.js
      67001 B  at    187ms  http://localhost:40123/assets/sprites-BYouFVgw.webp
        267 B  at     98ms  http://localhost:40123/api/campaigns  [ignored - not counted]
      ...
```

This is the diagnosis trail: when a delta appears (or the determinism check
fails), diffing two runs' breakdowns names the exact urls responsible. Build
output from `install-command`/`build-command` streams to the same log ahead
of the measurements.

Base-ref measurements are cached by (base sha, measurement config) via
`actions/cache`, so repeat pushes to a pull request skip rebuilding and
re-measuring the unchanged base - the log says `base ... loaded from cache`
when this happens. The first run after a base or config change measures it
fresh.

## Determinism measures

- service worker bypassed (no precache contamination)
- non-localhost hosts resolve to nothing (third-party variability excluded;
  failed external requests are counted and reported)
- http cache shared between scenarios, cold per run
- minimum of N runs reported

## Inputs

| input | default | |
| --- | --- | --- |
| `scenarios` | (required) | JSON array of `{name, url, mark}` |
| `install-command` | `""` | run in each checkout before building |
| `build-command` | `npm run build` | produces the site |
| `serve-dir` | `dist` | directory served after building |
| `compression` | `gzip` | simulate the host: `gzip`, `br` or `none` |
| `runs` | `2` | repeats; byte-equality across runs is the determinism check |
| `settle-ms` | `1500` | network quiet required after the mark |
| `mark-timeout-ms` | `60000` | per-scenario wait for the mark |
| `base-ref` | PR base | override comparison ref |
| `comment` | `true` | post/update the PR comment |
| `github-token` | `${{ github.token }}` | for the comment |

Requires a Chrome/Chromium on the runner (preinstalled on GitHub's Ubuntu
runners; override with `CHROME_PATH`).

## Authorship

Built by Claude (an Anthropic AI agent), commissioned and directed by Jim
Higson. MIT licensed.
