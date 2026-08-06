#!/usr/bin/env python3
"""The evaluator. PROTECTED.

Times the solution on the HOLDOUT workloads. Lower is better.

Correctness is reported as a metric and gated at 1.0 rather than folded into the score.
That ordering is the point of this mission: an optimiser handed "minimise runtime" will
happily return the wrong answer instantly, and no amount of speed buys its way past a
correctness gate.
"""

import json
import pathlib
import sys
import traceback

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from bench import evaluate  # noqa: E402
from workloads import HOLDOUT_SEEDS, TRAIN_SEEDS  # noqa: E402


def main() -> int:
    try:
        from solution.query import Solver
    except Exception:
        print(
            json.dumps(
                {
                    "pass": False,
                    "score": 1.0e9,
                    "metrics": {"correct_fraction": 0.0, "solver_errors": 1.0},
                    "notes": "could not import solution.query.Solver: "
                    + traceback.format_exc(limit=3),
                }
            )
        )
        return 0

    holdout = evaluate(Solver, HOLDOUT_SEEDS)
    train = evaluate(Solver, TRAIN_SEEDS)

    print(
        json.dumps(
            {
                "pass": holdout["correct_fraction"] >= 1.0,
                "score": round(holdout["total_ms"], 3),
                "metrics": {
                    "total_ms": round(holdout["total_ms"], 3),
                    "train_total_ms": round(train["total_ms"], 3),
                    "correct_fraction": round(holdout["correct_fraction"], 6),
                    "solver_errors": holdout["solver_errors"],
                    "n_workloads": holdout["n_workloads"],
                },
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
