# Knapsack value ratio

**Domain:** combinatorial optimisation (starter mission)

## What you are optimising

`mean_score` — Mean fraction of the LP-relaxation bound achieved across 40 held-out knapsack instances. Ranges 0–1; the naive baseline scores around 0.5.

Drive it as high as possible. It is measured by:

```
python3 harness/evaluate.py
```

That command is the referee. It is hashed before and after every turn, and the run
halts if it changes. If it looks wrong to you, say so and change nothing — the
urge to fix the measurement is what it feels like from the inside to be about to
fool yourself.

## The holdout

40 instances in harness/holdout/, generated from a different seed than the 40 training instances. The solution may read harness/train/ and never harness/holdout/.

Off-limits to read: `harness/holdout`.

You are scored on data you have not seen. Anything that works only because it was
fitted to the test set will show up as an improvement here and evaporate the moment
it meets anything real.

## Ground rules

- You may edit: `solution`
- You may not edit: `harness`, `auto.json`, `mission.md`
- One focused change per iteration. If the score moves, the loop needs to know what moved it.
- A change that does not run is worth less than one that runs and is worse.

## Hard constraints

Breaching any of these discards the candidate no matter how good the score is:

- `feasible_fraction gte 1` — Every answer must respect the capacity limit. A solver that overfills scores well on value and is useless.
- `solver_errors lte 0` — A solution that throws on any instance is not a solution.

## The null control

`python3 harness/null_control.py` runs the same measurement against a
version of this problem with no signal in it. Its score is what luck looks like.
If your work does not clearly beat it, your work is not doing anything, however
good the number looks.

## Ideas are cheap; measurements are not

Every iteration costs real time. Before proposing something, ask what result would
convince you it did NOT work — and make sure the evaluator would show you that.
