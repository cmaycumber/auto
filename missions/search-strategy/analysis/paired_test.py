#!/usr/bin/env python3
"""Is the champion actually better than the baseline, or is this 40 landscapes of luck?

`auto` decides keep/discard on a single aggregate number. That is the documented gap:
nothing in the loop asks whether a +1.8% mean improvement over 40 paired samples is
distinguishable from noise. This script asks.

Evaluation is already paired — both strategies see the same landscapes, the same starting
genomes and the same mutation draws — so the per-landscape difference is the right unit
and a paired test is the right test.

Usage:
    python3 paired_test.py <mission-dir> <baseline-strategy.py> <champion-strategy.py>
"""

import importlib.util
import pathlib
import random
import statistics
import sys


def load_select(path: pathlib.Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.select_parent


def bootstrap_ci(diffs, iterations=20000, alpha=0.05, seed=12345):
    rng = random.Random(seed)
    n = len(diffs)
    means = []
    for _ in range(iterations):
        means.append(sum(rng.choice(diffs) for _ in range(n)) / n)
    means.sort()
    lo = means[int(alpha / 2 * iterations)]
    hi = means[int((1 - alpha / 2) * iterations)]
    return lo, hi


def sign_test_p(diffs):
    """Two-sided exact binomial p under H0: P(champion better) = 0.5. Ties dropped."""
    from math import comb

    wins = sum(1 for d in diffs if d > 0)
    losses = sum(1 for d in diffs if d < 0)
    n = wins + losses
    if n == 0:
        return 1.0, 0, 0
    k = min(wins, losses)
    tail = sum(comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2 * tail), wins, losses


def main() -> int:
    mission = pathlib.Path(sys.argv[1]).resolve()
    baseline_path = pathlib.Path(sys.argv[2]).resolve()
    champion_path = pathlib.Path(sys.argv[3]).resolve()

    harness = mission / "harness"
    sys.path.insert(0, str(harness))
    from nk import Landscape, load_seeds  # noqa: E402
    from simulate import run_one  # noqa: E402

    seeds = load_seeds(str(harness / "holdout_seeds.json"))
    baseline = load_select(baseline_path, "baseline_strategy")
    champion = load_select(champion_path, "champion_strategy")

    base_scores, champ_scores = [], []
    for seed in seeds:
        landscape = Landscape(seed)
        base_scores.append(run_one(baseline, landscape, seed)["best"])
        champ_scores.append(run_one(champion, landscape, seed)["best"])

    diffs = [c - b for c, b in zip(champ_scores, base_scores)]
    mean_diff = statistics.fmean(diffs)
    lo, hi = bootstrap_ci(diffs)
    p, wins, losses = sign_test_p(diffs)

    print(f"n landscapes            {len(seeds)}")
    print(f"baseline  mean_best     {statistics.fmean(base_scores):.6f}")
    print(f"champion  mean_best     {statistics.fmean(champ_scores):.6f}")
    print(f"paired mean difference  {mean_diff:+.6f}")
    print(f"bootstrap 95% CI        [{lo:+.6f}, {hi:+.6f}]")
    print(f"sign test               {wins}W-{losses}L, p = {p:.4f}")
    print()

    ci_excludes_zero = lo > 0
    if ci_excludes_zero and p < 0.05:
        print("VERDICT: the improvement survives a paired test. Real on this landscape family.")
    elif ci_excludes_zero or p < 0.05:
        print("VERDICT: MARGINAL — one test clears, the other does not. Underpowered; more")
        print("landscapes would settle it. Do not treat as established.")
    else:
        print("VERDICT: NOT DISTINGUISHABLE FROM NOISE. The loop's keep was within what")
        print("40 paired samples produce by chance. This is the multiplicity gap in action.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
