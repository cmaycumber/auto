# Example missions

Four worked missions, chosen to cover genuinely different shapes rather than to be
impressive. Each one runs end-to-end from a clean clone with no API keys, no network and
no dependencies beyond Python 3.

```bash
auto doctor missions/<name>     # check it before spending tokens
auto run    missions/<name>     # baseline, then iterate
auto steps  missions/<name>     # what each step changed
```

| Mission | Shape it demonstrates | Baseline → null control |
|---|---|---|
| [`knapsack`](knapsack/) | The starter scaffold `auto init --yes` generates. Combinatorial optimisation with a feasibility gate. | 0.652 → 0.649 |
| [`glob-spec`](glob-spec/) | **Spec conformance with visible vs held-out tests** — a miniature SpecBench. Declares `generalisationGapMetric`. | 0.613 → 0.465 |
| [`faster-queries`](faster-queries/) | **Lower-is-better**, with correctness as a hard gate that speed cannot outbid. `minimumEffect` derived from measured timing noise. | 104ms → 104ms |
| [`search-strategy`](search-strategy/) | **`auto` pointed at its own parent-selection rule.** Paired evaluation, and a real finding — see its `FINDINGS.md`. | 0.690 → 0.630 |

## What each is really for

**`knapsack`** is the one you get for free. It exists so `auto run` works the moment you
clone the repo, and so the loop has something to prove itself on before you have written
your own harness. It is a placeholder task and says so.

**`glob-spec`** is the closest thing here to `auto`'s actual thesis. You implement a
path-glob spec; 155 test cases are visible and 155 are hidden, and the evaluator reports
`generalisation_gap` = visible rate − holdout rate. That is SpecBench's Δ, and it is also
a hard gate. The failure it guards against is concrete: special-case a pattern you can see
in `visible_tests.json`, watch the visible number rise, ship something that does not
implement character classes.

Worth noting how the data was built. The reference matcher that produced the labels is
**not in the repository at all** — the labels were baked into JSON once, offline. Protected
paths are unwritable, not unreadable, so shipping the answer next to the question would
have made the mission a copying exercise. If you build your own conformance mission, do
the same.

**`faster-queries`** inverts the direction: `higherIsBetter: false`, minimise milliseconds.
Two things make it worth reading. First, correctness is a **gate**, not a term in the
score — an optimiser told only to minimise runtime will return the wrong answer instantly,
and gates are checked before scores so that it cannot. Second, its `minimumEffect` of
2.0 ms was **measured**: running the unchanged baseline six times gave a spread of 1.79 ms,
so anything smaller is not detectable on this machine.

It also deliberately declares **no** `generalisationGapMetric`, because train and holdout
workloads cost about the same and the difference would measure machine wobble. A safeguard
that measures nothing is worse than no safeguard, because it looks like one.

**`search-strategy`** points `auto` at itself. The solution is `auto`'s real parent-selection
rule ported to Python; the harness scores it on held-out NK landscapes with everything
except selection held fixed, and evaluation is paired so strategies cannot win on luck.

Its `FINDINGS.md` is the most useful document in this directory, because the first run
produced a result that is three things at once: the loop found a genuine improvement
(p = 0.00002 on 400 fresh landscapes), its decision to keep that improvement was **not**
statistically justified at the time it made it (the CI on the 40 it had included zero), and
the effect size it reported was **inflated 58%** by selection on its own holdout. That last
number is the winner's curse, measured, and it is the clearest argument in this repo for a
second never-touched split.

## Reading the null-control column

Two of the four baselines do not clearly beat their null control, and that is correct
rather than a defect:

- `knapsack` — "take items in the order given" is very nearly "take items in random order".
- `faster-queries` — the baseline *is* the unoptimised reference, by construction.

In both cases `doctor` says so plainly. A baseline with no edge is a normal starting
position; it means the headroom starts at zero. The number to watch is whether the gap
**opens** as the loop keeps candidates. If it never does, the keeps were noise.

## Building your own

`auto init <dir>` walks the interview and scaffolds a runnable harness you then adapt.
The parts worth copying from these examples:

- Generate held-out labels from a reference you do **not** ship.
- Balance a classification-style test set, or the null control scores like the majority
  class and the metric stops measuring skill. `glob-spec` was regenerated for exactly this
  reason after a first pass came out 11% true, which would have let "always return False"
  score 0.89.
- Write the null control before the solution. It is the question "what does no skill look
  like?", and answering it late means answering it after you already believe something.
- Measure your noise floor and put it in `minimumEffect`. Do not guess it.
