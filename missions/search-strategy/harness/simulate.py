"""The simulated search loop. PROTECTED.

Runs a parent-selection strategy through a miniature version of `auto`'s own loop:
maintain an archive of scored candidates, repeatedly pick a parent, mutate it, score the
child, append. Everything except the selection step is held fixed.

Paired evaluation: every strategy sees the same landscapes, the same initial genomes, and
the same mutation RNG stream. Two strategies therefore differ only where they made
different *choices*, not because one got luckier draws. Unpaired comparison on 40
landscapes would be swamped by seed variance and would report improvements that are noise
— the exact failure this whole tool exists to prevent.

Usage (development, on the TRAIN split):
    python3 harness/simulate.py --split train
"""

import argparse
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from nk import N_LOCI, Landscape, load_seeds, mutate  # noqa: E402

BUDGET = 80  # fitness evaluations per landscape, including the seed candidate


class SelectionError(Exception):
    """The strategy returned something that is not a usable archive index."""


def run_one(select, landscape: Landscape, seed: int, budget: int = BUDGET) -> dict:
    """Run one search. Returns best fitness found and bookkeeping."""
    rng = random.Random(seed * 7919 + 13)

    start = rng.randrange(2**N_LOCI)
    archive = [{"index": 0, "score": landscape.fitness(start), "step": 0}]
    genomes = [start]

    invalid = 0

    for step in range(1, budget):
        # The archive handed to the strategy is a read-only view of what `auto`'s real
        # archive exposes: an index, a score, and when it was added.
        view = [dict(entry) for entry in archive]
        try:
            choice = select(view, rng)
        except Exception as exc:  # noqa: BLE001
            raise SelectionError(f"strategy raised: {exc!r}") from exc

        if not isinstance(choice, int) or isinstance(choice, bool):
            invalid += 1
            choice = len(archive) - 1
        elif not (0 <= choice < len(archive)):
            invalid += 1
            choice = len(archive) - 1

        child = mutate(genomes[choice], rng)
        genomes.append(child)
        archive.append({"index": step, "score": landscape.fitness(child), "step": step})

    return {
        "best": max(entry["score"] for entry in archive),
        "final_archive": len(archive),
        "invalid_selections": invalid,
    }


def evaluate_strategy(select, seeds: list[int], budget: int = BUDGET) -> dict:
    """Run a strategy across a set of landscapes and aggregate."""
    bests = []
    invalid = 0
    errors = 0

    for seed in seeds:
        landscape = Landscape(seed)
        try:
            result = run_one(select, landscape, seed, budget)
        except SelectionError:
            errors += 1
            bests.append(0.0)
            continue
        bests.append(result["best"])
        invalid += result["invalid_selections"]

    return {
        "mean_best": sum(bests) / len(bests) if bests else 0.0,
        "min_best": min(bests) if bests else 0.0,
        "invalid_selections": float(invalid),
        "strategy_errors": float(errors),
        "n_landscapes": float(len(seeds)),
    }


def load_strategy():
    """Import the mutable strategy. Import failure is a crash, not a zero."""
    from solution.strategy import select_parent

    return select_parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="train", choices=["train", "holdout"])
    args = parser.parse_args()

    seeds = load_seeds(str(HERE / f"{args.split}_seeds.json"))
    result = evaluate_strategy(load_strategy(), seeds)

    print(f"split={args.split}")
    for key, value in result.items():
        print(f"  {key}: {value:.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
