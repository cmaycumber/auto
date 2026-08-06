#!/usr/bin/env python3
"""Null control. PROTECTED.

For an optimisation task, "no signal" is not randomness — it is **no optimisation effort**.
So this times the untouched reference implementation on the same holdout workloads.

If a candidate is not meaningfully faster than this, it has not optimised anything, and
the score it reports is measuring machine noise rather than work. That is the same
question the null control asks in every other mission, phrased for a task where "shuffle
the labels" would be meaningless.
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

from bench import evaluate  # noqa: E402
from workloads import HOLDOUT_SEEDS, ReferenceSolver  # noqa: E402


def main() -> int:
    result = evaluate(ReferenceSolver, HOLDOUT_SEEDS)
    print(
        json.dumps(
            {
                "pass": True,
                "score": round(result["total_ms"], 3),
                "metrics": {
                    "total_ms": round(result["total_ms"], 3),
                    "correct_fraction": round(result["correct_fraction"], 6),
                    "solver_errors": 0.0,
                },
                "notes": "null control — the unoptimised reference implementation",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
