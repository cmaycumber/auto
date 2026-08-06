# Findings: pointing `auto` at its own parent selection

First real run of this mission, 2026-08-06, `claude` driver.

## What the loop did

| step | change | holdout `mean_best` | verdict |
|---|---|---|---|
| 0 | baseline — `auto`'s real rule (champion, 25% recency-weighted exploration) | 0.689950 | — |
| 1 | Gaussian expected-improvement acquisition over the archive | 0.702461 | keep (+1.8%) |
| 2 | exact per-genome novelty term replacing a geometric one | 0.708138 | keep (+0.8%) |

Null control (uniformly random selection): **0.630497**.

## What the loop got wrong

`auto` kept step 1 on a +1.8% improvement. A paired bootstrap over the same 40
landscapes it was scored on:

```
paired mean difference  +0.012511
bootstrap 95% CI        [-0.001286, +0.025975]    <- includes zero
sign test               24W-15L, p = 0.1996
```

**That keep was not justified by the data `auto` had at the time it made the decision.**
`score_improvement` accepts any improvement, so on an evaluator with sampling variance it
accepts noise. This is the multiplicity gap named in `docs/roadmap.md`, hit on the first
keep of the first run of the mission built to test it.

Fix shipped: `evaluator.minimumEffect`, plus a `doctor` warning when a `score_improvement`
mission does not set one.

## What the loop got right

The cumulative champion, re-scored on **400 fresh landscapes** (seeds 90000–90399 — a
third split, never used for training or for the loop's holdout):

```
baseline           0.690095
champion           0.701608
paired difference  +0.011512
bootstrap 95% CI   [+0.007387, +0.015595]
sign test          228W-145L, p = 0.000020
```

**The improvement is real.** Expected-improvement acquisition with a novelty term genuinely
beats champion-plus-ε on rugged NK landscapes. `auto` found something.

## The part worth internalising

The effect shrank from **+0.0182** on the holdout the loop optimised against to **+0.0115**
on fresh data — a **37% reduction**. Same strategy, same evaluator, same budget; the only
difference is that one number was selected on and the other was not.

That is the winner's curse, measured. It is also the strongest available argument for the
thing `auto` still does not have: **a second, never-touched split scored only on the final
champion.** The loop's own holdout stops being a holdout the moment the loop starts
selecting on it, and it overstated this result by more than a third.

So all three of these are true at once, and collapsing them into one headline would be
wrong in a different way each time:

1. The improvement is real (p = 0.00002 on fresh data).
2. `auto`'s decision to keep it was not statistically justified when it was made.
3. The effect size `auto` reported was inflated by ~58% relative to the truth.

## Caveat that was written before the run

From `mission.md`: a win here is evidence about *selection on rugged binary landscapes
under a small budget*, not about `auto` on a real mission, where a child is an LLM-written
code change rather than a bit flip. The next step is to port the strategy into
`packages/core/src/archive.ts` and measure it there — not to assume it transfers.

## Reproducing

```bash
python3 analysis/paired_test.py . \
  runs/<run-id>/snapshots/0/solution/strategy.py \
  runs/<run-id>/snapshots/2/solution/strategy.py
```
