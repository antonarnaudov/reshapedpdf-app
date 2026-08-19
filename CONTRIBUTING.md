# Contributing

Thanks for looking. This is a small project with strong opinions, and the
opinions are mostly about correctness, so here is what will make a change land
quickly.

## Getting it running

```bash
npm install
npm run dev        # the web app at http://localhost:5173 — the full editor
npm run desktop    # the Electron shell against that dev server
npm test           # everything: unit harnesses plus real-app suites
```

`npm test` drives an actual Electron window through the Chrome DevTools
Protocol, so it needs a display. It takes about twelve minutes. Run the suite
that covers your change while you work (`npm run test:erase`,
`npm run test:redactstream`, …) and the whole thing before you open a PR.

## The one rule that matters

**A test is not finished when it passes. It is finished when it fails with the
fix reverted.**

Every regression test in this repo has been checked that way: neuter the fix,
confirm the test goes red, confirm the neutered build still compiles (a test that
"passes" against a build that never compiled has told you nothing), then restore.
If you add a test, do that, and say so in the PR.

The reason is in the history. Several suites here were green for weeks against
code that was broken, because they never entered the branch they claimed to
cover.

## What this project is careful about

**Never destroy content the user can still see.** The editor removes drawing
operators from people's documents. Leaving something hidden behind a patch is
the tolerable failure; deleting something visible is not. When a change touches
`src/pdf/` — the content-stream walker, the exporter, redaction — expect review
to be slow and specific, and expect to be asked what happens on a rotated page,
a page with a non-zero crop box, a form XObject drawn twice, and an inline image.

**No document ever leaves the machine.** There is no telemetry, no analytics, no
crash reporting and no phone-home, and a PR that adds any of them will not be
merged. The only outbound request the app makes is to an AI endpoint the user
typed in themselves.

**Fixtures must be ours.** Test documents must be generated
(`tests/fixtures/make-fixtures.mjs`), owned by this project, or taken from a
public corpus with provenance recorded. Never a document out of someone's life —
this repository is public and permanent.

## Style

Match the file you are in. Comments explain *why*, and are worth writing when the
reason is not obvious from the code — most comments here exist because something
went wrong once and the next person deserves to know what.

TypeScript is strict; `npm run typecheck` is part of `npm test`.

## Pull requests

Small and focused beats large and comprehensive. Say what breaks without the
change, and how you checked. If it is a bug fix, the ideal PR body is one
sentence describing the wrong behaviour, one describing the cause, and the
revert-check result.

## Reporting a security issue

Please do not open a public issue — see [SECURITY.md](./SECURITY.md).
