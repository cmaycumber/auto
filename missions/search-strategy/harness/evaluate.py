#!/usr/bin/env python3
"""The evaluator. PROTECTED.

Scores the strategy on the HOLDOUT landscape seeds only. The solution may develop against
`harness/train_seeds.json` freely; the number that counts comes from landscapes it has
never been tuned on.

Also reports the generalisation gap — train score minus holdout score — following
SpecBench's Δ(c) = s_val − s_test. A strategy that is much better on train than holdout
has been fitted to the training landscapes rather than to the problem, and the gap makes
that visible in the archive instead of leaving it to be discovered later.
"""

import json
import pathlib
import sys
import traceback

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from nk import load_seeds  # noqa: E402
from simulate import evaluate_strategy  # noqa: E402


def main() -> int:
    try:
        from solution.strategy import select_parent
    except Exception:
        # An import failure is a crash, not a legitimate score of zero.
        print(
            json.dumps(
                {
                    "pass": False,
                    "score": 0.0,
                    "metrics": {
                        "invalid_selections": 0.0,
                        "strategy_errors": 1.0,
                        "import_error": 1.0,
                    },
                    "notes": "could not import solution.strategy: "
                    + traceback.format_exc(limit=3),
                }
            )
        )
        return 0

    holdout = evaluate_strategy(select_parent, load_seeds(str(HERE / "holdout_seeds.json")))
    train = evaluate_strategy(select_parent, load_seeds(str(HERE / "train_seeds.json")))
    gap = train["mean_best"] - holdout["mean_best"]

    print(
        json.dumps(
            {
                "pass": holdout["strategy_errors"] == 0 and holdout["invalid_selections"] == 0,
                "score": round(holdout["mean_best"], 6),
                "metrics": {
                    "mean_best": round(holdout["mean_best"], 6),
                    "min_best": round(holdout["min_best"], 6),
                    "train_mean_best": round(train["mean_best"], 6),
                    "generalisation_gap": round(gap, 6),
                    "invalid_selections": holdout["invalid_selections"],
                    "strategy_errors": holdout["strategy_errors"],
                    "n_landscapes": holdout["n_landscapes"],
                },
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
