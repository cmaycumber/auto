# auto

**Spin up a Karpathy-style autoresearch agent for any domain, in about two minutes.**

`auto` interviews you into a real evaluator, scaffolds a runnable harness, then loops:
propose → measure → gate → keep or revert. Locally, against whatever coding agent you
already have authenticated.

```bash
auto init demo --yes    # scaffold a starter mission
auto doctor demo        # can this mission tell signal from noise?
auto run demo           # baseline, then iterate
auto status demo        # what it actually found
```

---

## The thesis

Wrapping a loop around a coding agent is a weekend project. The reason most such loops
produce nothing is not the loop — it is that nobody made the operator build a verifier
first, so the agent spends the night climbing a number that was never measuring anything.

So `auto` inverts the usual order. **The evaluator interview is the product.** `auto init`
will not write a mission until you have answered:

| Question | Why it is asked |
|---|---|
| What single number are you moving? | A loop needs a total ordering. Deciding it later means everything measured so far was ranked by something you hadn't chosen. |
| What command produces it? | A command, not a vibe, and not an LLM asked whether the work was good. |
| What data does the agent not see? | Fitting to the test set is the most common way these loops produce a fake win. |
| **What does *no signal* score?** | The null control. The most skipped question and the most important one. |
| What could the agent edit to fake a win? | That list becomes the protected tree, hashed every iteration. |
| What must hold regardless of score? | Hard gates. A constraint that can be outbid is decoration. |

The loop itself is ~350 lines. The apparatus that keeps it honest is the rest of the repo.

---

## What it enforces at runtime

Not documentation — behaviour, with tests asserting each one:

- **Baseline before anything else.** The harness must score the scaffold end-to-end
  before an agent touches it. A harness that cannot produce a number halts the run
  instead of producing uninterpretable ones.
- **The protected tree is hashed** before the run and re-checked after every agent turn —
  *before* the evaluator runs, so a tampered harness never produces a score. Additions
  count as violations too, because shadowing a protected file (`sitecustomize.py`,
  `conftest.py`) is tampering by another name.
- **Gates outrank scores.** A candidate breaching a hard floor is discarded no matter how
  good its number is. A gate whose metric the evaluator does not report counts as a
  breach, not a pass.
- **Discards are actually reverted** — including files the candidate *added*, which
  otherwise silently become the base for the next iteration.
- **The null control runs on a schedule**, whether or not results look good. Especially
  when they look good; a climbing score never looks suspicious from the inside.
- **Crashes are archived, not skipped.** "We tried 40 things and one worked" is a very
  different claim from "the thing we tried worked", and only the archive can tell them
  apart.
- **The summary refuses to celebrate.** Short runs, zero keeps, and null-control breaches
  are called out in the log next to the headline number.

---

## Install

```bash
cd auto
bun install
bun run auto --help          # or: alias auto="bun run $PWD/packages/cli/src/index.ts"
```

Requires [Bun](https://bun.sh) ≥ 1.3 and at least one of `claude` or `codex` on PATH.
Zero runtime dependencies.

---

## Anatomy of a mission

```
missions/my-mission/
  auto.json                 the machine contract — metric, gates, paths, budget
  mission.md                the brief, handed to the agent verbatim each turn
  memory.md                 append-only lessons across iterations
  harness/                  PROTECTED — hashed; the run halts if it changes
    evaluate.py             prints {"pass": bool, "score": number, "metrics": {...}}
    null_control.py         same measurement, signal-free input
    train/                  readable by the solution
    holdout/                HIDDEN — what you are actually scored on
  solution/                 MUTABLE — the only thing the agent may edit
  archive/entries.jsonl     every candidate ever measured, append-only
  runs/<run-id>/
    decision-log.md         human-readable narrative of the run
    evaluations/            per-iteration evaluator output
    snapshots/              what made keep/discard reversible
    transcripts/            full agent output per iteration
```

Two distinct protections, easy to conflate:

- **`protectedPaths`** — cannot be **written**. Enforced by hashing.
- **`holdout.hiddenPaths`** — must not be **read**. Enforced by where you put the data.

`auto doctor` fails a mission whose hidden paths are not also protected, because held-out
data the agent can rewrite is not held out.

---

## Steps: what changed, and what actually got you here

Every iteration records a **unified diff** alongside its description, so the archive can
answer "what did step 34 actually do?" without re-deriving it from a transcript. The
description is what the agent *says* it did; the patch is what it did, captured by
diffing the tree rather than by asking.

```
$ auto steps missions/knapsack

  metric mean_score · 3 steps · 2 in the champion's lineage · 1 explored and dropped

  #  2 · worse  mean_score=0.079233 (-0.892478)
       take only the heaviest affordable item
       1 file, +5 −9 — solution/solve.py

  #  1 ✓ keep  mean_score=0.971711 (+0.319513) ★
       order items by value density instead of input order
       1 file, +9 −28 — solution/solve.py
```

`★` marks steps in the **lineage** — the ancestors of the champion. This is the
distinction that matters at scale:

```
$ auto steps missions/knapsack --lineage
  path  #0 → #1
```

A run with 200 steps and 4 keeps has a 4-step lineage, and reading those 4 patches is
the whole story of how the score got where it is. The other 196 are the record of what
did not work — worth keeping, not worth reading first.

Patches are captured **before** any revert, so a discarded step's diff survives. A crash
keeps its patch too, and that is usually the most useful diff in the archive: it is the
change that broke the harness.

`auto diff <n>` prints the patch for any step.

### Keep formatters away from missions

Integrity is byte-exact. A linter or formatter in the surrounding repo that reflows a
mission's `auto.json` or data files will halt a running loop — the content is
semantically identical, the bytes are not.

This is not hypothetical; it happened during development and cost a live run. Exclude
mission directories from your formatter (this repo's `biome.json` has `!missions`).
Byte-exactness is not softened for "cosmetic" changes, because a diff `auto` is willing
to ignore is a diff an agent can hide in.

## The evaluator contract

Any language. One rule: print a JSON object to stdout, exit 0.

```json
{
  "pass": true,
  "score": 0.87,
  "metrics": { "feasible_fraction": 1.0, "solver_errors": 0, "seconds": 4.2 },
  "notes": "optional free text"
}
```

- `pass` — required boolean.
- `score` — required when `keepPolicy` is `score_improvement`.
- `metrics` — every metric named by a gate must appear here, or the gate reads as breached.

Log noise around the JSON is fine; `auto` takes the last balanced top-level object.
A non-zero exit is a **crash**, not a score of zero — a measurement that did not run
carries no information about the candidate.

---

## Drivers

`auto` never calls a model API directly. It shells out to a coding agent you already have:

| Provider | Invocation |
|---|---|
| `claude` | `claude -p … --output-format json --permission-mode acceptEdits` |
| `codex` | `codex exec --json --sandbox workspace-write …` |
| `mock` | runs `$AUTO_MOCK_COMMAND` instead of a model |

The `mock` driver is not only for tests. Point it at a parameter sweep or a genetic
algorithm and that script gets the whole apparatus — gates, null control, archive,
integrity — for free. It also makes a useful floor: **if your LLM loop cannot beat random
search through the same harness, the LLM is not what is helping.**

The driver's report of what it changed is never trusted. `auto` hashes the mutable tree
before and after and diffs it.

---

## Commands

```
auto init   [dir] [--yes] [--force]
auto doctor [dir] [--skip-run]
auto run    [dir] [--driver claude|codex|mock] [--max-iterations N]
                  [--max-runtime SECONDS] [--exploration 0..1]
auto status [dir] [--limit N]
auto steps  [dir] [--lineage] [--limit N]
auto diff   <n> [dir]
auto log    [dir] [--run ID]
```

`auto doctor` is the one to run before spending a night. It executes the evaluator and the
null control and reports whether the baseline clears noise **by a margin** — not merely
whether it edges ahead.

---

## Status

Working local loop, verified end-to-end. Plugin surfaces (`plugin/`) and the cloud
monitoring service (`cloud/`) are scoped with their seams defined but not built — see
`docs/roadmap.md`.

## Prior art

- **[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)** — archive of agents,
  open-ended search, empirical gating of modifications. `auto`'s loop is this shape.
- **[Hyperagents](https://arxiv.org/abs/2603.19461)** (Meta, DGM-H) — extends DGM so the
  *meta* agent is editable too, and shows meta-level improvements transferring across
  domains and accumulating across runs. `auto` has no meta layer yet; see
  `docs/roadmap.md`.
- **[The Red Queen Gödel Machine](https://arxiv.org/abs/2606.26294)** — co-evolves agents
  *and their evaluators*. Reads like a contradiction of `auto`'s immutable evaluator, and
  isn't: RQGM organises search into epochs with a **fixed within-epoch evaluation
  criterion**, updating the utility only at epoch boundaries. That is exactly what the
  integrity hash enforces — within an epoch. See below.
- Karpathy-style autoresearch loops, and a good deal of prior internal work where most of
  these safeguards were paid for the first time.

### On evolving the evaluator

`auto` refuses to let the agent touch the evaluator, and the RQGM result says a static
evaluator is itself a ceiling. Both are right, at different timescales.

The distinction that matters is **who** changes the evaluator and **against what**. An
agent editing its own scorer mid-run to make its idea pass is the failure this whole tool
exists to prevent. An operator revising the metric at an epoch boundary, with the new
evaluator validated against ground truth or an adversarial objective, is how a research
programme is supposed to work.

`auto` supports the second today by being explicit rather than clever: change the
evaluator, and the next run hashes the new one and starts a fresh baseline. The scores
either side of that boundary are not comparable, and the tool makes that visible instead
of letting you quietly compare them. What `auto` does not yet have is RQGM's automated
co-evolution *within* a programme — that is a real gap, and it is on the roadmap.
