# Make range-sum queries fast without getting them wrong

**Domain:** performance optimisation — the shape KernelBench and most of Weco's GPU-kernel
work take, in miniature and with no GPU.

`solution/query.py` exposes:

```python
Solver(values)             # construct — TIMED
solver.range_sum(lo, hi)   # inclusive sum of values[lo..hi] — TIMED
```

It currently sums element by element: correct, and O(n) per query.

## What you are optimising

`total_ms` — **lower is better**. Milliseconds to construct the solver and answer 800
queries, summed over 3 held-out workloads, best of 3 repeats.

| | `total_ms` |
|---|---|
| the unoptimised reference (the null control) | ~104 |
| the baseline you start from (same algorithm) | ~104 |
| prefix sums | single digits |

Note the baseline and the null control are the same number, because the baseline *is* the
reference. `doctor` will tell you the baseline has no edge over the null, and it is right:
the headroom here starts at exactly zero, and every millisecond has to be earned.

## Correctness is a gate, not part of the score

`correct_fraction >= 1.0`. Every query must match the reference exactly.

This ordering is the whole point of the mission. An optimiser handed "minimise runtime"
and nothing else will return `0` instantly and report a spectacular score. Gates are
checked before scores in `auto` precisely so that a constraint like this cannot be
outbid — a wrong answer is discarded no matter how fast it is.

## Construction is timed

Preprocessing is not free. It is very much allowed — it is the whole idea — but it has to
pay for itself across the ~800 queries in a workload. An O(n²) precompute that makes
queries instant is not a win here, and would not be a win for any real caller either.

## Minimum effect: 2.0 ms

Wall-clock is noisy. Running the *unchanged* baseline six times on this machine produced:

```
min 104.02   max 105.81   spread 1.79 ms   stdev 0.70 ms
```

So a change smaller than about 2 ms is not measurable here, and `minimumEffect` is set to
2.0 to reject it. That number was measured, not guessed — which is what the README means
by "if you do not know your evaluator's noise floor, measure it".

This matters more than it sounds. The first real improvement on this mission is roughly
100× and clears the bar by two orders of magnitude. It is the *tail* that needs guarding:
once you are at 3 ms, every subsequent "optimisation" is inside the noise, and without a
minimum effect the loop would happily keep accepting them and reporting progress.

## No generalisation-gap metric here

Other missions in this repo declare `generalisationGapMetric`. This one deliberately does
not: train and holdout workloads are drawn from the same generator and cost about the same
to run, so train-minus-holdout milliseconds measures machine wobble rather than
overfitting. `train_total_ms` is still reported as a sanity check.

Not every mission has a meaningful gap metric, and declaring one that measures nothing is
worse than declaring none — it produces a number that looks like a safeguard.
