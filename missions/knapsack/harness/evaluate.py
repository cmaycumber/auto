#!/usr/bin/env python3
"""The evaluator. PROTECTED — `auto` hashes this file and halts if it changes.

Prints one JSON object to stdout:

    {"pass": bool, "score": float, "metrics": {...}}

Scores on the HOLDOUT split only. The solution is free to fit the training split
however it likes; the number that counts comes from data it has never seen.
"""

import json
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

import task  # noqa: E402


def main() -> int:
    try:
        from solution.solve import solve
    except Exception:
        # An import failure is a crash, not a zero. Reporting it as a legitimate
        # low score would let a broken solution look like a merely bad one.
        print(json.dumps({
            "pass": False,
            "score": 0.0,
            "metrics": {"feasible_fraction": 0.0, "import_error": 1.0},
            "notes": "Could not import solution.solve: " + traceback.format_exc(limit=3),
        }))
        return 0

    instances = task.load_instances("holdout")
    scores: list[float] = []
    feasible = 0
    errors = 0

    started = time.perf_counter()
    for instance in instances:
        try:
            answer = solve(instance)
        except Exception:
            errors += 1
            scores.append(0.0)
            continue

        score, ok = task.score_answer(instance, answer)
        scores.append(score)
        feasible += 1 if ok else 0
    elapsed = time.perf_counter() - started

    mean_score = sum(scores) / len(scores) if scores else 0.0
    feasible_fraction = feasible / len(instances) if instances else 0.0

    print(json.dumps({
        "pass": feasible_fraction >= 1.0 and mean_score > 0,
        "score": round(mean_score, 6),
        "metrics": {
            "mean_score": round(mean_score, 6),
            "feasible_fraction": round(feasible_fraction, 6),
            "solver_errors": float(errors),
            "n_instances": float(len(instances)),
            "seconds": round(elapsed, 3),
        },
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
