#!/usr/bin/env python3
"""Null control. PROTECTED.

The same simulated search, with selection carrying no information: pick a uniformly random
archive entry. Mutation, budget, landscapes and seeds are identical, so this isolates
exactly what selection is worth.

This is the number that decides whether the mission means anything. Random selection over
an archive is still a real search — it mutates good candidates sometimes — so it will
score well above zero. If a "smarter" strategy cannot clearly beat it, selection is not
where the leverage is on this landscape and any improvement the loop reports is noise.
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

from nk import load_seeds  # noqa: E402
from simulate import evaluate_strategy  # noqa: E402


def random_select(archive, rng):
    return rng.randrange(len(archive))


def main() -> int:
    result = evaluate_strategy(random_select, load_seeds(str(HERE / "holdout_seeds.json")))
    print(
        json.dumps(
            {
                "pass": True,
                "score": round(result["mean_best"], 6),
                "metrics": {
                    "mean_best": round(result["mean_best"], 6),
                    "invalid_selections": 0.0,
                    "strategy_errors": 0.0,
                },
                "notes": "null control — uniformly random parent selection, no signal",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
