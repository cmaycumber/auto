# auto's own parent-selection strategy

**Domain:** combinatorial search — specifically, the search `auto` itself runs.

This mission points `auto` at its own weakest component. `auto` picks which archive entry
to branch from using a simple rule (champion, with a 25% chance of a recency-weighted
non-champion), and that rule is the main thing better systems — AIDE's tree search,
MAP-Elites-style niching — beat it on. Your job is to replace it with something better.

## What you are optimising

`mean_best` — the mean best NK-landscape fitness found within a fixed budget of 80
evaluations, averaged over 40 held-out landscapes. Range 0–1.

Two reference points, both measured:

| strategy | holdout `mean_best` |
|---|---|
| uniformly random selection (the null control) | 0.6305 |
| `auto`'s current strategy (your starting point) | 0.6900 |

Note how close those are. Selection is worth about 8.6% relative on this landscape, which
is real but modest — that gap is the entire headroom, and it is why this mission exists.
If your change does not clearly open it, your change is not doing anything.

## The setup

`solution/strategy.py` exposes one function:

```python
def select_parent(archive: list[dict], rng: random.Random) -> int
```

`archive` is a list of `{"index": int, "score": float, "step": int}`, oldest first. Return
the `index` you want to branch from. Everything else in the search — the mutation
operator, the budget, the landscapes, the RNG stream — is fixed and lives in the protected
tree, so a change in score can only have come from your selection choices.

Evaluation is **paired**: every strategy sees the same landscapes, the same starting
genomes, and the same mutation draws. You are not competing against luck.

## Developing

Run this as often as you like:

```bash
python3 harness/simulate.py --split train
```

You may read `harness/train_seeds.json`. You may **not** read
`harness/holdout_seeds.json`. The landscape generator in `harness/nk.py` is readable, so
you could generate your own practice landscapes — that is fine and is what the train split
is for. Fitting to the specific holdout draw is not.

## Hard constraints

Breaching any of these discards the candidate regardless of score:

- `invalid_selections <= 0` — always return a valid index.
- `strategy_errors <= 0` — never raise.
- `generalisation_gap <= 0.05` — train score minus holdout score. Pre-registered before
  this run started. A strategy that is much better on the landscapes it was developed
  against has been fitted to those landscapes, and the number that matters is the one it
  gets on a fresh draw.

## Ideas worth trying

Not a menu to work through in order — pick the one you think is most likely to move the
number, and make one focused change:

- **Bandit / UCB selection over the archive.** Score a candidate by its fitness plus an
  exploration bonus that decays with how many children it has already produced. This is
  roughly what AIDE does and is the single most obvious gap.
- **Quality-diversity (MAP-Elites style).** Keep a portfolio of good-but-different
  candidates instead of crowding one peak. NK landscapes with K=4 have many local optima,
  which is exactly the regime where this pays.
- **Stagnation response.** When recent children stop improving, branch further away.
- **Lineage depth.** A deeply-explored chain may be exhausted while a shallow high scorer
  is untouched. Depth is information the current rule ignores.

## What a win here does and does not mean

An improvement is evidence about **selection on rugged binary landscapes under a small
budget**. It is not automatically evidence about `auto` on a real mission, where a "child"
is an LLM-written code change rather than a bit flip, and where the archive is 30 entries
rather than 80. Treat a win as a reason to try the strategy in the real loop and measure
it there — not as a finished result.

That caveat is not boilerplate. It is the single most likely way this mission produces a
number that looks like progress and is not.
