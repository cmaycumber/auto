"""The solution. MUTABLE — this is what the agent edits.

Deliberately naive: it takes items in the order given until the knapsack is full.
That is a real, valid, and bad strategy, which is what a baseline should be. A
baseline that is already good hides whether the loop is doing anything.

The obvious first improvement is ordering by value density. After that it gets more
interesting.

You may read harness/train/instances.json. You may NOT read harness/holdout/ —
that is what you are being scored on, and fitting to it produces a number that
means nothing.
"""


def solve(instance: dict) -> list[int]:
    """Return the indices of the items to put in the knapsack.

    Must respect instance["capacity"]. Infeasible answers score zero, and the
    mission's hard gate discards any candidate that produces even one.
    """
    selected: list[int] = []
    remaining = instance["capacity"]

    for i, item in enumerate(instance["items"]):
        if item["weight"] <= remaining:
            selected.append(i)
            remaining -= item["weight"]

    return selected
