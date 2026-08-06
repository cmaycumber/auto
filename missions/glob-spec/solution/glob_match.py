"""The matcher. MUTABLE — this is what the agent edits.

Deliberately partial: it handles literals and a single `*`, and nothing else. No `?`, no
character classes, no `**`, and its `*` is applied without regard to `/`. That is a real,
honest, incomplete implementation — which is what a baseline should be.

Read `harness/spec.md` for the full contract, and `harness/visible_tests.json` for cases
you may develop against. You may NOT read `harness/holdout_tests.json`.

A warning specific to this mission: it is entirely possible to raise the visible pass rate
by special-casing patterns that appear in `visible_tests.json`. That will show up as a
widening `generalisation_gap`, which is a reported metric and a hard gate. Implement the
spec instead.
"""


def match(pattern: str, path: str) -> bool:
    """Return whether `path` matches `pattern` under the spec in harness/spec.md."""
    if "*" not in pattern:
        return pattern == path

    # Single-star split only; everything else in the spec is unimplemented.
    head, _, tail = pattern.partition("*")
    if "*" in tail:
        return False

    if not path.startswith(head):
        return False
    remainder = path[len(head) :]
    if not remainder.endswith(tail):
        return False
    return len(remainder) >= len(tail)
