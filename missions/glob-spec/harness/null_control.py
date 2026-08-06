#!/usr/bin/env python3
"""Null control. PROTECTED.

The same scoring path, with a matcher that contains no understanding of globbing: it
always returns False.

On a balanced test set that lands near 0.5, which is what "no skill" should look like for
a binary task. If the set were imbalanced this constant matcher would score like the
majority class — 0.89 on an 11%-true set — and the metric would be worthless. The data
here is deliberately balanced so that accuracy measures skill rather than base rate, and
this file is what proves it.
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent


def always_false(_pattern, _path):
    return False


def main() -> int:
    holdout = json.loads((HERE / "holdout_tests.json").read_text())
    correct = sum(1 for case in holdout if always_false(None, None) is case["expected"])
    rate = correct / len(holdout) if holdout else 0.0

    print(
        json.dumps(
            {
                "pass": True,
                "score": round(rate, 6),
                "metrics": {
                    "holdout_rate": round(rate, 6),
                    "generalisation_gap": 0.0,
                    "matcher_errors": 0.0,
                },
                "notes": "null control — always returns False, no globbing logic at all",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
