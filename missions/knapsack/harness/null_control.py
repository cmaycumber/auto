#!/usr/bin/env python3
"""Null control. PROTECTED.

Runs the SAME scoring path as the evaluator against a solver with no signal in it —
here, a random feasible selection. Its score is what "no skill" looks like on this
metric.

If your real solution does not clearly beat this, one of two things is true, and both
are worth more than another iteration:

  - the metric rewards something other than skill, or
  - the task is easy enough that anything scores well, so the score carries no
    information about whether your solution is good.
"""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import task  # noqa: E402

SEED = 20260101


def random_solve(instance: dict, rng: random.Random) -> list[int]:
    """Fill the knapsack with items in random order. Feasible, but not thinking."""
    order = list(range(len(instance["items"])))
    rng.shuffle(order)

    selected: list[int] = []
    remaining = instance["capacity"]
    for i in order:
        weight = instance["items"][i]["weight"]
        if weight <= remaining:
            selected.append(i)
            remaining -= weight
    return selected


def main() -> int:
    rng = random.Random(SEED)
    instances = task.load_instances("holdout")

    scores = []
    feasible = 0
    for instance in instances:
        score, ok = task.score_answer(instance, random_solve(instance, rng))
        scores.append(score)
        feasible += 1 if ok else 0

    mean_score = sum(scores) / len(scores) if scores else 0.0
    print(json.dumps({
        "pass": True,
        "score": round(mean_score, 6),
        "metrics": {
            "mean_score": round(mean_score, 6),
            "feasible_fraction": round(feasible / len(instances) if instances else 0.0, 6),
            "n_instances": float(len(instances)),
        },
        "notes": "null control — random feasible selection, no signal",
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
