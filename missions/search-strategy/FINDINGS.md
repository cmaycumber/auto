# Findings: pointing `auto` at its own parent selection

First full run, 2026-08-06, `claude` driver, 7 iterations before the runtime budget.

## What the loop did

| step | from | change | holdout `mean_best` | verdict |
|---|---|---|---|---|
| 0 | — | baseline: `auto`'s real rule (champion, 25% recency-weighted exploration) | 0.689950 | — |
| 1 | 0 | Gaussian expected-improvement acquisition over the archive | 0.702461 | keep |
| 2 | 1 | exact per-genome novelty term replacing a geometric one | 0.708138 | keep |
| 3 | 2 | conditional mean derived from the NK generator | 0.707149 | discard |
| 4 | 2 | Beta-Binomial survival factor on the novelty term | 0.699140 | discard |
| 5 | 1 | variance-matched Student-t tail in place of the Gaussian | 0.711980 | keep |
| 6 | 2 | budget-aware count of reachable unmapped neighbours | 0.713798 | **champion** |

Null control (uniformly random selection): **0.630497**. The relative gap to the champion
opened from **0.086 at baseline to 0.114 by step 5** — which is exactly what the baseline
warning said to watch for, and the sign that the keeps were carrying real signal.

## Is the champion real?

Yes, and by a wide margin — but not by as much as the run reported.

```
OPTIMISED-AGAINST holdout (n=40, the one the loop selected on)
  baseline 0.689950   champion 0.713798
  paired diff +0.023848   CI [+0.009977, +0.037323]   30W-9L  p = 0.001065

FRESH holdout (n=400, never touched by any iteration)
  baseline 0.690095   champion 0.702132
  paired diff +0.012036   CI [+0.008191, +0.015906]   237W-139L  p < 0.000001
```

Expected-improvement acquisition with a novelty term genuinely beats champion-plus-ε on
rugged NK landscapes. `auto` found something.

**But half the reported gain was selection.** +0.0238 on the holdout the loop optimised
against, +0.0120 on fresh data. The run's headline was +3.5%; the truth is +1.7%.

That is the winner's curse, measured, and it is the argument for the thing `auto` still
does not have: a second never-touched split scored only on the final champion. The loop's
own holdout stops being a holdout the moment the loop starts selecting on it.

## The uncomfortable part

Earlier in this session, `auto` keeping step 1 on a +1.8% improvement looked like a clean
failure — a paired test on the 40 landscapes it had put the CI at [-0.001, +0.026],
p = 0.20. That motivated adding `evaluator.minimumEffect`, set from the measured noise
floor of this evaluator (bootstrap CI half-width ≈ 0.0137, so ≈ 0.014).

Then the run finished, and:

| step | delta | under `minimumEffect = 0.014` |
|---|---|---|
| 1 | +0.012511 | discarded |
| 2 | +0.005677 | discarded |
| 5 | +0.009519 | discarded |
| 6 | +0.005660 | discarded |

**Every keep would have been rejected. The loop would have found nothing** — and the thing
it found is real at p < 0.000001.

So the naive reading of the earlier result was wrong. `auto` was not simply "accepting
noise". It was accepting a sequence of increments that were each individually smaller than
its evaluator could resolve, and which compounded into a real effect.

## What that actually implies

A per-step minimum effect is the wrong instrument for incremental progress. Set it large
enough to reject this evaluator's noise and it rejects real work; set it small enough to
pass real work and it rejects nothing. There is no value that does both, because the
problem is not the threshold — **the evaluator is underpowered for the size of step the
loop takes.**

Three fixes, in order of how well they work here:

1. **Raise evaluator precision.** Noise scales as 1/√n. At 40 landscapes the CI half-width
   is ≈0.0137 while the loop's increments are ≈0.006, so the evaluator cannot see its own
   progress. Reaching a half-width of 0.003 needs roughly 800 landscapes. This mission is
   genuinely underpowered and that is the honest fix.
2. **Validate the champion on a never-touched split.** Catches the 50% inflation without
   blocking anything. This is what was done by hand here and it is the highest-value
   missing feature in `auto`.
3. **`minimumEffect`** — right for an evaluator whose noise is irreducible (wall-clock
   timing, as in `missions/faster-queries`), wrong as a general answer to multiplicity.

`minimumEffect` is deliberately **not set** on this mission. Any value that would reject
its noise would also reject its results, and pretending otherwise would be worse than
leaving it off. `doctor` warns about that, and the warning is correct in general and wrong
here — which is itself worth seeing.

## Three statements, all true

1. The improvement is real: p < 0.000001 on 400 fresh landscapes.
2. `auto`'s per-step keeps were not individually justified by the data it had.
3. The effect size it reported was inflated ~2× by selection on its own holdout.

Collapsing these into one headline gets it wrong in a different way each time.

## Caveat written before the run

From `mission.md`: this is evidence about *selection on rugged binary landscapes under a
small budget*, not about `auto` on a real mission, where a child is an LLM-written code
change rather than a bit flip and the archive is tens of entries rather than 80. Porting
the strategy into `packages/core/src/archive.ts` and measuring it there is the next step,
not an assumption.

## Reproducing

```bash
python3 analysis/paired_test.py . \
  analysis/baseline_step0.py \
  analysis/champion_step6.py
```

`analysis/` holds the baseline and the final champion because run snapshots are gitignored.
