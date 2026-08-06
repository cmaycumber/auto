"""The parent-selection strategy. MUTABLE — this is what the agent edits.

What `auto` does today (and what this replaces), from
`packages/core/src/archive.ts::selectParent`:

    champion by default, with `explorationRate` chance of branching from a
    non-champion instead, weighted toward recent entries.

That rule has two costs. It keeps drawing from a champion whose neighbourhood is already
exhausted, and when it does explore it spreads those draws over the *whole* archive by
recency, so most exploration lands on entries that were never plausible parents.

This replaces it with a one-step acquisition function: for each entry, the expected
improvement over the current best, multiplied by the probability that the draw is not a
duplicate of something that entry has already produced.

    value(i) = P(new genome | i) x E[ max(0, score_i + delta - best) ]

Both factors are grounded rather than tuned:

  - **Novelty.** `nk.mutate` flips exactly one of N_LOCI bits, so a genome has exactly
    N_LOCI distinct possible children, and repeat draws re-evaluate genomes already in the
    archive. Those evaluations cannot improve anything. Rather than *predict* that waste,
    this measures it: `Landscape.fitness` is deterministic, so two draws that flipped the
    same bit come back with the identical float, and equal scores mean the same genome.
    Every observed parent-child pair is therefore an edge of the hypercube, recorded in
    both directions against a *score*, and the untried fraction of a genome's
    neighbourhood is exactly (N_LOCI - |edges seen|) / N_LOCI.

    Keying that on the score rather than on the archive index is the point. A genome the
    champion threw off three times sits in the archive as three separate entries; counted
    per index each copy looks untouched, so working one copy's neighbourhood leaves the
    next copy looking pristine and the search re-explores the same point. Pooling by score
    also merges what two different lineages learned about the same genome for free.

  - **Improvement.** The archive view carries no lineage, but this strategy *chose* every
    parent, so it can reconstruct the tree and observe every (child - parent) delta it has
    caused. Those deltas are fitted online, per landscape, to a normal — nothing here is
    fitted to the training seeds, so the model adapts to a landscape's own ruggedness
    instead of encoding a constant learned from the train split.

The two together produce stagnation response and depth awareness as consequences rather
than as separate hand-written rules: while the champion keeps improving, its neighbourhood
is barely mapped and selection is greedy; once it stalls, each further draw fills that
neighbourhood in until the best unmapped runner-up outranks it — and, because the
neighbourhood is tracked per genome, the search then moves on to the next *distinct* point
instead of restarting on another copy of one it has already worked over.
"""

import math
import random

# Structural facts about the search this runs inside, not tuned knobs.
_LOCI = 20  # nk.N_LOCI — one flipped bit per child, so this many distinct children

_MIN_DELTAS = 6  # observations needed before the improvement model says anything
_DELTA_WINDOW = 48  # keep the model on the current regime, not the start of the climb
_CANDIDATES = 12  # entries far below the champion cannot plausibly produce a new best
_SIGMA_FLOOR = 1e-4  # a degenerate spread must not divide by zero

_ROOT_TWO = math.sqrt(2.0)
_ROOT_TWO_PI = math.sqrt(2.0 * math.pi)

# Per-landscape state. `run_one` always starts a fresh archive of length 1, which is the
# reset signal; anything else unexpected about the archive's length also resets.
# `neighbours` maps a genome (identified by its score) to the scores of its one-bit
# neighbours that have been evaluated — the mapped-out part of its neighbourhood.
_state: dict = {"size": 0, "last": None, "neighbours": {}, "deltas": []}


def _reset(size: int) -> None:
    _state["size"] = size
    _state["last"] = None
    _state["neighbours"] = {}
    _state["deltas"] = []


def _observe(archive: list[dict]) -> None:
    """Fold the entry that appeared since the last call into the tree being tracked."""
    size = len(archive)
    previous = _state["size"]

    if size <= 1 or size < previous or size > previous + 1:
        _reset(size)
        return
    if size == previous:
        return

    parent_index = _state["last"]
    if parent_index is not None:
        parent = None
        for entry in archive:
            if entry["index"] == parent_index:
                parent = entry
                break
        if parent is not None:
            # One hypercube edge, recorded both ways: the child is now a mapped neighbour
            # of the parent, and the parent a mapped neighbour of the child. A draw that
            # repeated an earlier bit flip re-adds a score already in the set and so
            # correctly reveals nothing.
            neighbours = _state["neighbours"]
            parent_score = parent["score"]
            child_score = archive[-1]["score"]
            neighbours.setdefault(parent_score, set()).add(child_score)
            neighbours.setdefault(child_score, set()).add(parent_score)
            _state["deltas"].append(child_score - parent_score)
            if len(_state["deltas"]) > _DELTA_WINDOW:
                del _state["deltas"][0]

    _state["size"] = size


def _champion(archive: list[dict]) -> int:
    return max(archive, key=lambda entry: entry["score"])["index"]


def _expected_improvement(margin: float, mu: float, sigma: float) -> float:
    """E[max(0, delta - margin)] for delta ~ N(mu, sigma^2). Strictly positive.

    Kept smooth on purpose: a purely empirical estimate collapses to exactly zero for
    every non-champion once the recent deltas stop containing a big enough positive, which
    would hand every remaining evaluation back to a champion that is already exhausted.
    """
    z = (mu - margin) / sigma
    pdf = math.exp(-0.5 * z * z) / _ROOT_TWO_PI
    cdf = 0.5 * (1.0 + math.erf(z / _ROOT_TWO))
    return sigma * (pdf + z * cdf)


def _choose(archive: list[dict]) -> int:
    deltas = _state["deltas"]
    if len(deltas) < _MIN_DELTAS:
        return _champion(archive)

    count = len(deltas)
    mu = sum(deltas) / count
    variance = sum((d - mu) * (d - mu) for d in deltas) / count
    sigma = max(math.sqrt(variance), _SIGMA_FLOOR)

    best_score = max(entry["score"] for entry in archive)
    neighbours = _state["neighbours"]

    # Collapse the archive to distinct genomes. Equal scores are the same point in the
    # space, so duplicate entries must compete for one candidate slot on one shared
    # neighbourhood rather than each presenting themselves as unexplored.
    genomes: dict[float, int] = {}
    for entry in archive:
        genomes.setdefault(entry["score"], entry["index"])
    ranked = sorted(genomes.items(), key=lambda pair: pair[0], reverse=True)

    chosen = None
    chosen_value = 0.0
    for score, index in ranked[:_CANDIDATES]:
        untried = _LOCI - len(neighbours.get(score, ()))
        if untried <= 0:  # fully mapped: every draw from here is a re-evaluation
            continue
        gain = _expected_improvement(best_score - score, mu, sigma)
        value = gain * untried / _LOCI
        if value > chosen_value:
            chosen, chosen_value = index, value

    if chosen is None:
        # Every plausible parent is mapped out. Drop the score window rather than spend
        # the draw on a genome with nothing left to give.
        for score, index in ranked:
            if len(neighbours.get(score, ())) < _LOCI:
                return index
        return _champion(archive)

    return chosen


def select_parent(archive: list[dict], rng: random.Random) -> int:
    """Choose which archive entry to branch from.

    Args:
        archive: list of {"index": int, "score": float, "step": int}, oldest first.
                 `index` is the value you must return.
        rng:     seeded RNG. Unused — this rule is deterministic given the archive, so
                 nothing is left to draw for.

    Returns:
        A valid index into the archive. Anything else is counted as an invalid
        selection, and the mission's hard gate discards a candidate that produces even
        one.
    """
    if not archive:
        return 0

    try:
        _observe(archive)
        choice = _choose(archive)
    except Exception:  # noqa: BLE001 — a selection rule must never take down the loop
        choice = _champion(archive)

    _state["last"] = choice
    return choice
