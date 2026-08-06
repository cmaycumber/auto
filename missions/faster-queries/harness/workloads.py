"""Workload generation and the reference implementation. PROTECTED.

The reference is readable on purpose. It is the *correct* answer, not the *fast* one —
copying it gets you a perfect correctness score and the baseline's runtime, which is
exactly zero progress. The mission is speed, and the reference is the thing to beat.

That is also why the null control times the reference: for an optimisation task, "no
signal" is not randomness, it is *no optimisation effort*. If a candidate is not faster
than the untouched reference, it has done nothing, however good the number looks.
"""

import random

TRAIN_SEEDS = [11, 12, 13]
HOLDOUT_SEEDS = [8001, 8002, 8003]

N_VALUES = 8000
N_QUERIES = 800


def make_workload(seed: int) -> tuple[list[int], list[tuple[int, int]]]:
    """Deterministic (values, queries). Same seed always yields the same workload."""
    rng = random.Random(seed)
    values = [rng.randint(-1000, 1000) for _ in range(N_VALUES)]
    queries = []
    for _ in range(N_QUERIES):
        lo = rng.randrange(N_VALUES)
        hi = rng.randrange(lo, N_VALUES)
        queries.append((lo, hi))
    return values, queries


class ReferenceSolver:
    """Correct and slow: sums the range element by element on every query.

    O(1) to construct, O(n) per query. This is the baseline's algorithm and the null
    control's, and it is what `solution/query.py` starts as.
    """

    def __init__(self, values: list[int]):
        self.values = values

    def range_sum(self, lo: int, hi: int) -> int:
        total = 0
        for i in range(lo, hi + 1):
            total += self.values[i]
        return total
