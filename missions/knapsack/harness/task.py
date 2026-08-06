"""Task definition — the part you replace.

PLACEHOLDER TASK — 0/1 knapsack.

This is not your problem. It is here so the harness runs end-to-end from the moment
it is generated, which lets `auto run` establish a real baseline before an agent
touches anything.

To make this your mission, replace exactly two things:

  1. load_instances()  — return your problem instances for a split
  2. score_answer()    — turn one (instance, answer) pair into a number

Everything else — the train/holdout split, the JSON contract, the feasibility
accounting — carries over unchanged.
"""

import json
import pathlib

HERE = pathlib.Path(__file__).parent


def load_instances(split: str) -> list[dict]:
    """Return the problem instances for a split ("train" or "holdout").

    REPLACE ME. Load from wherever your data lives — a file, a database, an API.
    The only contract is that "holdout" returns instances the solution has never
    been fitted to.
    """
    return json.loads((HERE / split / "instances.json").read_text())


def score_answer(instance: dict, answer) -> tuple[float, bool]:
    """Score one answer. Returns (score, feasible).

    REPLACE ME. `score` is the number being optimised for this instance;
    `feasible` says whether the answer respected the problem's hard constraints.

    Here: the answer is a list of selected item indices. Score is the fraction of
    the LP-relaxation bound achieved, so it lands in [0, 1] and is comparable
    across instances of different sizes. Infeasible answers score zero — an
    optimiser that ignores the capacity limit should not be rewarded for it.
    """
    items = instance["items"]
    capacity = instance["capacity"]

    try:
        selected = sorted({int(i) for i in answer})
    except (TypeError, ValueError):
        return 0.0, False

    if any(i < 0 or i >= len(items) for i in selected):
        return 0.0, False

    weight = sum(items[i]["weight"] for i in selected)
    value = sum(items[i]["value"] for i in selected)

    if weight > capacity:
        return 0.0, False

    bound = _lp_bound(items, capacity)
    return (value / bound if bound > 0 else 0.0), True


def _lp_bound(items: list[dict], capacity: int) -> float:
    """Fractional-knapsack upper bound. Used only to normalise scores into [0, 1]."""
    remaining = capacity
    total = 0.0
    for item in sorted(items, key=lambda it: it["value"] / it["weight"], reverse=True):
        if remaining <= 0:
            break
        take = min(item["weight"], remaining)
        total += item["value"] * (take / item["weight"])
        remaining -= take
    return total
