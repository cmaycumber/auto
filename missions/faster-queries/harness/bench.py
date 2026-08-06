"""Timing and correctness checking. PROTECTED.

Two decisions worth stating, because both change what the number means:

**min-of-repeats, not mean.** Wall-clock measurements are contaminated upward by
scheduling, GC and other processes; they are essentially never contaminated downward. The
minimum of several runs is therefore the best available estimate of the true cost, and it
is far more stable than the mean.

**Construction is timed along with the queries.** Otherwise a solution could do unbounded
preprocessing for free, and "make the queries fast" would be trivially won by an O(n²)
precompute that no real caller could afford.
"""

import pathlib
import sys
import time

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from workloads import ReferenceSolver, make_workload  # noqa: E402

REPEATS = 3


def time_solver(solver_cls, values, queries) -> tuple[float, list[int]]:
    """Return (best milliseconds over REPEATS, answers from the final run)."""
    best = float("inf")
    answers: list[int] = []
    for _ in range(REPEATS):
        start = time.perf_counter()
        solver = solver_cls(values)
        answers = [solver.range_sum(lo, hi) for lo, hi in queries]
        elapsed = (time.perf_counter() - start) * 1000.0
        best = min(best, elapsed)
    return best, answers


def evaluate(solver_cls, seeds: list[int]) -> dict:
    total_ms = 0.0
    correct = 0
    total_queries = 0
    errors = 0

    for seed in seeds:
        values, queries = make_workload(seed)
        expected = [ReferenceSolver(values).range_sum(lo, hi) for lo, hi in queries]

        try:
            ms, answers = time_solver(solver_cls, values, queries)
        except Exception:
            errors += 1
            total_queries += len(queries)
            continue

        total_ms += ms
        total_queries += len(queries)
        correct += sum(1 for got, want in zip(answers, expected) if got == want)

    return {
        "total_ms": total_ms,
        "correct_fraction": correct / total_queries if total_queries else 0.0,
        "solver_errors": float(errors),
        "n_workloads": float(len(seeds)),
    }
