"""The parent-selection strategy. MUTABLE — this is what the agent edits.

This is a faithful port of what `auto` actually does today, in
`packages/core/src/archive.ts::selectParent`:

    champion by default, with `explorationRate` chance of branching from a
    non-champion instead, weighted toward recent entries.

So the baseline here is not a strawman — it is the real algorithm, and beating it is a
real finding about `auto` rather than about a toy.

Your job is to write a better `select_parent`. Ideas that are known to help on rugged
landscapes and that `auto` does not currently do:

  - **Quality-diversity / niching** (MAP-Elites style): keep a portfolio of good-but-
    different candidates rather than crowding around one peak.
  - **Tree search** over the archive — UCB / bandit-style selection that balances a
    node's score against how many children it has already produced. This is roughly what
    AIDE does, and it is the main thing `auto`'s selection is missing.
  - **Stagnation response**: branch further from the champion when recent children have
    stopped improving.
  - **Depth awareness**: an entry's position in the lineage is information; deep chains
    may be exhausted while shallow high scorers are unexplored.

You may read `harness/train_seeds.json` and run `python3 harness/simulate.py --split
train` as often as you like. You may NOT read `harness/holdout_seeds.json` — that is what
you are scored on.
"""

import random

EXPLORATION_RATE = 0.25


def select_parent(archive: list[dict], rng: random.Random) -> int:
    """Choose which archive entry to branch from.

    Args:
        archive: list of {"index": int, "score": float, "step": int}, oldest first.
                 `index` is the value you must return.
        rng:     seeded RNG. Use it for all randomness so runs stay reproducible.

    Returns:
        A valid index into the archive. Anything else is counted as an invalid
        selection, and the mission's hard gate discards a candidate that produces even
        one.
    """
    if not archive:
        return 0

    best = max(archive, key=lambda entry: entry["score"])
    alternatives = [entry for entry in archive if entry["index"] != best["index"]]

    if not alternatives or rng.random() >= EXPLORATION_RATE:
        return best["index"]

    # Recency-weighted: the i-th oldest alternative gets weight i+1.
    weights = [i + 1 for i in range(len(alternatives))]
    total = sum(weights)
    threshold = rng.random() * total
    for entry, weight in zip(alternatives, weights):
        threshold -= weight
        if threshold <= 0:
            return entry["index"]
    return alternatives[-1]["index"]
