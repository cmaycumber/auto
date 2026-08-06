"""NK fitness landscapes. PROTECTED — hashed; the run halts if this changes.

Kauffman's NK model: N loci, each contributing a fitness value that depends on its own
state and K neighbours. K tunes ruggedness — K=0 is a smooth single-peaked landscape that
any hill-climber solves, and higher K produces exponentially many local optima.

Chosen over a continuous test function for one reason: it is the standard abstraction for
*search over a combinatorial space with epistasis*, which is what searching over programs
actually is. A change that helps in one context hurts in another, greedy hill-climbing
gets stuck, and escaping requires the search to sometimes branch from something that is
not currently the best. That last sentence is the entire thing this mission is testing.

Fitness is the mean of N contributions each drawn uniformly from [0, 1], so it lands in
[0, 1] with no normalisation needed and is comparable across landscapes.
"""

import random

N_LOCI = 20
K_NEIGHBOURS = 4
GENOME_SPACE = 2**N_LOCI


class Landscape:
    """A deterministic NK landscape. Same seed always yields the same landscape."""

    def __init__(self, seed: int, n: int = N_LOCI, k: int = K_NEIGHBOURS):
        self.n = n
        self.k = k
        self.seed = seed
        rng = random.Random(seed)
        # contributions[i][pattern] where pattern packs locus i plus its k neighbours
        self.contributions = [[rng.random() for _ in range(2 ** (k + 1))] for _ in range(n)]

    def fitness(self, genome: int) -> float:
        """Fitness of a genome encoded as an n-bit integer."""
        total = 0.0
        for i in range(self.n):
            pattern = 0
            for offset in range(self.k + 1):
                locus = (i + offset) % self.n
                pattern = (pattern << 1) | ((genome >> locus) & 1)
            total += self.contributions[i][pattern]
        return total / self.n


def mutate(genome: int, rng: random.Random, n: int = N_LOCI) -> int:
    """Flip exactly one bit.

    The mutation operator is FIXED and lives here, in the protected tree, on purpose.
    This mission isolates parent *selection*; if the solution could also change how
    children are generated, a win would not tell us which half caused it.
    """
    return genome ^ (1 << rng.randrange(n))


def load_seeds(path: str) -> list[int]:
    import json
    import pathlib

    return json.loads(pathlib.Path(path).read_text())
