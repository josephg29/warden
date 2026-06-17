# Contributing to warden

short version: open an issue, fork, send a PR. read on for the longer story.

## what kind of contribution makes sense?

this project came from one person running 5 LLM-driven Minecraft bots in
parallel for a long time and accumulating fixes for the failure modes that
appear at hour 12+. every "rough edge" is shaped like:

- a bug we reproduced once at 2am after weeks of running
- a guard we added to prevent that specific failure from cascading
- a runbook entry so future-you knows why the guard exists

warden is the **operational** layer — the watchdog, recycle, snapshot, and
fleet-hardening side. it sits next to your "brain" code (mindcraft, voyager,
or your own), not on top of it.

contributions that fit:

- **operational fixes** — surfacing a silent failure, breaking a retry loop,
  preventing a fleet-wide cascade, hardening a slot-recycle step
- **brain hardening** — guards in the LLM decision layer (hard-block,
  oscillation detector, completion blindness), inventory/memory diff, etc.
- **ports to other LLM providers** — the most-requested gap is multi-provider
  support. cerebras is hardcoded today; abstracting the OpenAI-compatible
  client to read `LLM_BASE_URL` is a small, valuable PR
- **better tests** — node's built-in `node:test` runner; see `test/` for
  examples. unit tests for the brain logic are gold; we don't have enough
- **runbook entries** — if you hit a failure mode and resolve it, a paragraph
  in `RUNBOOK.md` is welcome

contributions that don't fit (yet):

- **new skills** that aren't load-bearing for a published demo. the skill
  vocabulary is intentionally tight; net-new skills should come with a
  use-case in a brain config
- **framework migrations** — the dashboard is vanilla ESM by design. moving
  to react/svelte/etc is out of scope
- **breaking changes without a runbook entry** — if it changes how someone
  recovers from a failure mode, document the new path

## development loop

```bash
npm install
cp .env.example .env             # add your CEREBRAS_API_KEY
npm run dev                      # node --watch src/index.js
node --test test/                # all tests
node --test test/safe-error.test.mjs   # one file
```

## pull request expectations

- one logical change per PR
- if you're fixing a bug, please reference (or open) an issue and include the
  failure shape — not just the fix. the failure shape is what makes the test
  worth writing
- if you're adding a guard at the brain layer, write a unit test that fires
  the failure shape and confirms the guard catches it (see
  `test/safe-error.test.mjs` for the ring-counter pattern)
- update `RUNBOOK.md` if your change affects a recovery path
- keep diffs small. several small PRs > one large PR
- node 18+ only; no transpilers

## commit messages

conventional-commits-ish:

```
feat(brain): completion blindness detector for stale-goal-with-success loops
fix(diskwatch): handle ENOENT on first-boot data dir
docs(runbook): document the cloudflared rotation procedure
```

types we use: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`,
`ci`. no scope is also fine.

## filing a security issue

please don't open a public issue for security vulnerabilities. email the
maintainer (see github profile) or open a private security advisory on
github. include reproduction steps and impact.

## code of conduct

be kind. assume the other person is tired and running this on their personal
laptop. that's usually true.
