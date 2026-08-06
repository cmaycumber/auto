"""The solver. MUTABLE — this is what the agent edits.

Starts as the reference algorithm: correct, and O(n) per query. Correct-and-slow is the
right baseline for an optimisation mission — it means every point of score comes from
work you did, not from a starting position that was already tuned.

The contract:

    Solver(values)          construct — TIMED
    solver.range_sum(lo, hi)  inclusive sum of values[lo..hi] — TIMED

Construction is timed along with the queries, so preprocessing is not free. It is very
much allowed — it is the whole idea — but it has to pay for itself across the ~800 queries
in a workload.

You may read `harness/workloads.py` and develop against the train seeds. There is no
hidden data here; the holdout is a different set of generated workloads, and the honest
constraint is that you must not special-case seeds.
"""


class Solver:
    def __init__(self, values: list[int]):
        self.values = values

    def range_sum(self, lo: int, hi: int) -> int:
        total = 0
        for i in range(lo, hi + 1):
            total += self.values[i]
        return total
