/**
 * Starter harness templates.
 *
 * The generated harness is a working, runnable one — not a stub with TODOs where the
 * measurement should be. That is deliberate: `auto run` establishes a baseline before it
 * lets an agent near anything, so a scaffold that cannot score itself fails immediately
 * and the operator's first experience of the tool is an error.
 *
 * The placeholder task is 0/1 knapsack. It is not anybody's real problem, and it is
 * clearly labelled as such — but it is a real optimisation task with the full shape:
 * a train/holdout split, a feasibility constraint that makes a natural hard gate, and a
 * null control whose score is obviously distinguishable from a real solution. Swapping in
 * your domain means replacing two functions, and the surrounding scaffolding tells you
 * exactly which two.
 */

import type { InterviewAnswers } from "./interview.ts"

export interface GeneratedFile {
  /** Mission-relative path. */
  path: string
  contents: string
}

/**
 * Deterministic PRNG (mulberry32) so a mission scaffolded twice gets identical data.
 * Reproducibility starts at the data — a harness whose instances differ per scaffold
 * makes two runs incomparable for reasons nobody will think to check.
 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Instance {
  id: string
  capacity: number
  items: Array<{ weight: number; value: number }>
}

function generateInstances(seed: number, count: number, prefix: string): Instance[] {
  const random = mulberry32(seed)
  const instances: Instance[] = []

  for (let i = 0; i < count; i++) {
    const n = 12 + Math.floor(random() * 13)
    const items = Array.from({ length: n }, () => ({
      weight: 1 + Math.floor(random() * 40),
      value: 1 + Math.floor(random() * 60),
    }))
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
    instances.push({
      id: `${prefix}-${String(i).padStart(3, "0")}`,
      capacity: Math.floor(totalWeight * (0.3 + random() * 0.2)),
      items,
    })
  }

  return instances
}

/** Train and holdout come from different seeds — same distribution, disjoint instances. */
export function instanceFiles(): { train: string; holdout: string } {
  return {
    train: JSON.stringify(generateInstances(1337, 40, "train"), null, 2),
    holdout: JSON.stringify(generateInstances(90210, 40, "holdout"), null, 2),
  }
}

const PLACEHOLDER_BANNER = `PLACEHOLDER TASK — 0/1 knapsack.

This is not your problem. It is here so the harness runs end-to-end from the moment
it is generated, which lets \`auto run\` establish a real baseline before an agent
touches anything.

To make this your mission, replace exactly two things:

  1. load_instances()  — return your problem instances for a split
  2. score_answer()    — turn one (instance, answer) pair into a number

Everything else — the train/holdout split, the JSON contract, the feasibility
accounting — carries over unchanged.`

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_TASK = `"""Task definition — the part you replace.

${PLACEHOLDER_BANNER}
"""

import json
import pathlib

HERE = pathlib.Path(__file__).parent


def load_instances(split: str) -> list[dict]:
    """Return the problem instances for a split ("train" or "holdout").

    REPLACE ME. Load from wherever your data lives — a file, a database, an API.
    The only contract is that "holdout" returns instances the solution has never
    been fitted to.
    """
    return json.loads((HERE / split / "instances.json").read_text())


def score_answer(instance: dict, answer) -> tuple[float, bool]:
    """Score one answer. Returns (score, feasible).

    REPLACE ME. \`score\` is the number being optimised for this instance;
    \`feasible\` says whether the answer respected the problem's hard constraints.

    Here: the answer is a list of selected item indices. Score is the fraction of
    the LP-relaxation bound achieved, so it lands in [0, 1] and is comparable
    across instances of different sizes. Infeasible answers score zero — an
    optimiser that ignores the capacity limit should not be rewarded for it.
    """
    items = instance["items"]
    capacity = instance["capacity"]

    try:
        selected = sorted({int(i) for i in answer})
    except (TypeError, ValueError):
        return 0.0, False

    if any(i < 0 or i >= len(items) for i in selected):
        return 0.0, False

    weight = sum(items[i]["weight"] for i in selected)
    value = sum(items[i]["value"] for i in selected)

    if weight > capacity:
        return 0.0, False

    bound = _lp_bound(items, capacity)
    return (value / bound if bound > 0 else 0.0), True


def _lp_bound(items: list[dict], capacity: int) -> float:
    """Fractional-knapsack upper bound. Used only to normalise scores into [0, 1]."""
    remaining = capacity
    total = 0.0
    for item in sorted(items, key=lambda it: it["value"] / it["weight"], reverse=True):
        if remaining <= 0:
            break
        take = min(item["weight"], remaining)
        total += item["value"] * (take / item["weight"])
        remaining -= take
    return total
`

const PYTHON_EVALUATE = `#!/usr/bin/env python3
"""The evaluator. PROTECTED — \`auto\` hashes this file and halts if it changes.

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
`

const PYTHON_NULL_CONTROL = `#!/usr/bin/env python3
"""Null control. PROTECTED.

Runs the SAME scoring path as the evaluator against a solver with no signal in it —
here, a random feasible selection. Its score is what "no skill" looks like on this
metric.

If your real solution does not clearly beat this, one of two things is true, and both
are worth more than another iteration:

  - the metric rewards something other than skill, or
  - the task is easy enough that anything scores well, so the score carries no
    information about whether your solution is good.
"""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import task  # noqa: E402

SEED = 20260101


def random_solve(instance: dict, rng: random.Random) -> list[int]:
    """Fill the knapsack with items in random order. Feasible, but not thinking."""
    order = list(range(len(instance["items"])))
    rng.shuffle(order)

    selected: list[int] = []
    remaining = instance["capacity"]
    for i in order:
        weight = instance["items"][i]["weight"]
        if weight <= remaining:
            selected.append(i)
            remaining -= weight
    return selected


def main() -> int:
    rng = random.Random(SEED)
    instances = task.load_instances("holdout")

    scores = []
    feasible = 0
    for instance in instances:
        score, ok = task.score_answer(instance, random_solve(instance, rng))
        scores.append(score)
        feasible += 1 if ok else 0

    mean_score = sum(scores) / len(scores) if scores else 0.0
    print(json.dumps({
        "pass": True,
        "score": round(mean_score, 6),
        "metrics": {
            "mean_score": round(mean_score, 6),
            "feasible_fraction": round(feasible / len(instances) if instances else 0.0, 6),
            "n_instances": float(len(instances)),
        },
        "notes": "null control — random feasible selection, no signal",
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`

const PYTHON_SOLUTION = `"""The solution. MUTABLE — this is what the agent edits.

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
`

// ---------------------------------------------------------------------------
// Node / TypeScript
// ---------------------------------------------------------------------------

const NODE_TASK = `/**
 * Task definition — the part you replace.
 *
 * ${PLACEHOLDER_BANNER.split("\n").join("\n * ")}
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

export interface Item {
  weight: number
  value: number
}

export interface Instance {
  id: string
  capacity: number
  items: Item[]
}

/** REPLACE ME. Return problem instances for a split ("train" or "holdout"). */
export function loadInstances(split: string): Instance[] {
  return JSON.parse(readFileSync(join(HERE, split, "instances.json"), "utf-8"))
}

/**
 * REPLACE ME. Score one answer.
 *
 * Infeasible answers score zero — an optimiser that ignores the capacity limit
 * should not be rewarded for it.
 */
export function scoreAnswer(
  instance: Instance,
  answer: unknown,
): { score: number; feasible: boolean } {
  if (!Array.isArray(answer)) return { score: 0, feasible: false }

  const selected = [...new Set(answer.map(Number))].sort((a, b) => a - b)
  if (selected.some((i) => !Number.isInteger(i) || i < 0 || i >= instance.items.length)) {
    return { score: 0, feasible: false }
  }

  let weight = 0
  let value = 0
  for (const i of selected) {
    const item = instance.items[i] as Item
    weight += item.weight
    value += item.value
  }
  if (weight > instance.capacity) return { score: 0, feasible: false }

  const bound = lpBound(instance)
  return { score: bound > 0 ? value / bound : 0, feasible: true }
}

/** Fractional-knapsack upper bound, used only to normalise scores into [0, 1]. */
function lpBound(instance: Instance): number {
  const byDensity = [...instance.items].sort((a, b) => b.value / b.weight - a.value / a.weight)
  let remaining = instance.capacity
  let total = 0
  for (const item of byDensity) {
    if (remaining <= 0) break
    const take = Math.min(item.weight, remaining)
    total += item.value * (take / item.weight)
    remaining -= take
  }
  return total
}
`

const NODE_EVALUATE = `/**
 * The evaluator. PROTECTED — \`auto\` hashes this file and halts if it changes.
 *
 * Prints one JSON object to stdout. Scores on the HOLDOUT split only.
 */

import { loadInstances, scoreAnswer } from "./task.ts"

async function main(): Promise<void> {
  let solve: (instance: unknown) => unknown
  try {
    ;({ solve } = await import("../solution/solve.ts"))
  } catch (error) {
    // An import failure is a crash, not a zero — reporting it as a legitimate low
    // score would let a broken solution look like a merely bad one.
    console.log(
      JSON.stringify({
        pass: false,
        score: 0,
        metrics: { feasible_fraction: 0, import_error: 1 },
        notes: \`Could not import solution/solve.ts: \${error}\`,
      }),
    )
    return
  }

  const instances = loadInstances("holdout")
  const scores: number[] = []
  let feasible = 0
  let errors = 0

  const started = performance.now()
  for (const instance of instances) {
    let answer: unknown
    try {
      answer = solve(instance)
    } catch {
      errors += 1
      scores.push(0)
      continue
    }
    const result = scoreAnswer(instance, answer)
    scores.push(result.score)
    if (result.feasible) feasible += 1
  }
  const seconds = (performance.now() - started) / 1000

  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  const feasibleFraction = instances.length ? feasible / instances.length : 0

  console.log(
    JSON.stringify({
      pass: feasibleFraction >= 1 && meanScore > 0,
      score: Number(meanScore.toFixed(6)),
      metrics: {
        mean_score: Number(meanScore.toFixed(6)),
        feasible_fraction: Number(feasibleFraction.toFixed(6)),
        solver_errors: errors,
        n_instances: instances.length,
        seconds: Number(seconds.toFixed(3)),
      },
    }),
  )
}

await main()
`

const NODE_NULL_CONTROL = `/**
 * Null control. PROTECTED.
 *
 * Same scoring path as the evaluator, against a solver with no signal in it. Its
 * score is what "no skill" looks like on this metric. If the real solution does not
 * clearly beat it, the metric is not measuring skill.
 */

import { type Instance, loadInstances, scoreAnswer } from "./task.ts"

/** Deterministic PRNG so the null control is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomSolve(instance: Instance, random: () => number): number[] {
  const order = instance.items.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j] as number, order[i] as number]
  }

  const selected: number[] = []
  let remaining = instance.capacity
  for (const i of order) {
    const weight = (instance.items[i] as { weight: number }).weight
    if (weight <= remaining) {
      selected.push(i)
      remaining -= weight
    }
  }
  return selected
}

const random = mulberry32(20260101)
const instances = loadInstances("holdout")

const scores: number[] = []
let feasible = 0
for (const instance of instances) {
  const result = scoreAnswer(instance, randomSolve(instance, random))
  scores.push(result.score)
  if (result.feasible) feasible += 1
}

const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

console.log(
  JSON.stringify({
    pass: true,
    score: Number(meanScore.toFixed(6)),
    metrics: {
      mean_score: Number(meanScore.toFixed(6)),
      feasible_fraction: Number((instances.length ? feasible / instances.length : 0).toFixed(6)),
      n_instances: instances.length,
    },
    notes: "null control — random feasible selection, no signal",
  }),
)
`

const NODE_SOLUTION = `/**
 * The solution. MUTABLE — this is what the agent edits.
 *
 * Deliberately naive: takes items in the order given until full. A real, valid, bad
 * strategy — which is what a baseline should be. A baseline that is already good
 * hides whether the loop is doing anything.
 *
 * You may read harness/train/instances.json. You may NOT read harness/holdout/.
 */

interface Item {
  weight: number
  value: number
}

interface Instance {
  capacity: number
  items: Item[]
}

export function solve(instance: Instance): number[] {
  const selected: number[] = []
  let remaining = instance.capacity

  for (let i = 0; i < instance.items.length; i++) {
    const item = instance.items[i] as Item
    if (item.weight <= remaining) {
      selected.push(i)
      remaining -= item.weight
    }
  }

  return selected
}
`

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const SHELL_EVALUATE = `#!/usr/bin/env sh
# The evaluator. PROTECTED — \`auto\` hashes this file and halts if it changes.
#
# Replace the body with whatever measures your mission. The ONLY contract is that
# this prints a single JSON object to stdout:
#
#   {"pass": true, "score": 0.0, "metrics": {"your_metric": 0.0}}
#
# Two rules that are not negotiable:
#   - score on held-out data, never on what the solution was fitted to
#   - every metric named by a hard gate in auto.json must appear in "metrics"
#
# It exits 0 on a successful measurement. A non-zero exit is recorded as a crash,
# which is correct — a measurement that did not run is not a score of zero.

echo '{"pass": true, "score": 0.0, "metrics": {"placeholder": 0.0}, "notes": "replace harness/evaluate.sh with your real measurement"}'
`

const SHELL_NULL_CONTROL = `#!/usr/bin/env sh
# Null control. PROTECTED.
#
# Run the SAME measurement as evaluate.sh against a deliberately signal-free variant:
# shuffled labels, randomised decisions, a constant baseline. Print the same JSON shape.
#
# If this scores close to your real solution, the metric is not measuring skill and
# every improvement the loop reports is noise. That is the single most valuable thing
# this file can tell you, and it can only tell you if you actually write it.

echo '{"pass": true, "score": 0.0, "metrics": {"placeholder": 0.0}, "notes": "replace with a real signal-free baseline"}'
`

const SHELL_SOLUTION = `#!/usr/bin/env sh
# The solution. MUTABLE — this is what the agent edits.
#
# Whatever shape your mission needs. The evaluator decides how this gets invoked.
echo "replace me"
`

/** Every file a scaffolded mission needs, minus auto.json and mission.md. */
export function harnessFiles(answers: InterviewAnswers): GeneratedFile[] {
  const { train, holdout } = instanceFiles()

  switch (answers.template) {
    case "python":
      return [
        { path: "harness/task.py", contents: PYTHON_TASK },
        { path: "harness/evaluate.py", contents: PYTHON_EVALUATE },
        { path: "harness/null_control.py", contents: PYTHON_NULL_CONTROL },
        { path: "harness/train/instances.json", contents: train },
        { path: "harness/holdout/instances.json", contents: holdout },
        { path: "solution/solve.py", contents: PYTHON_SOLUTION },
        { path: "solution/__init__.py", contents: "" },
      ]
    case "node":
      return [
        { path: "harness/task.ts", contents: NODE_TASK },
        { path: "harness/evaluate.ts", contents: NODE_EVALUATE },
        { path: "harness/null_control.ts", contents: NODE_NULL_CONTROL },
        { path: "harness/train/instances.json", contents: train },
        { path: "harness/holdout/instances.json", contents: holdout },
        { path: "solution/solve.ts", contents: NODE_SOLUTION },
      ]
    case "shell":
      return [
        { path: "harness/evaluate.sh", contents: SHELL_EVALUATE },
        { path: "harness/null_control.sh", contents: SHELL_NULL_CONTROL },
        { path: "solution/run.sh", contents: SHELL_SOLUTION },
      ]
  }
}

/** Commands matching a template, used as interview defaults. */
export function templateCommands(template: InterviewAnswers["template"]): {
  evaluator: string
  nullControl: string
} {
  switch (template) {
    case "python":
      return {
        evaluator: "python3 harness/evaluate.py",
        nullControl: "python3 harness/null_control.py",
      }
    case "node":
      return {
        evaluator: "bun run harness/evaluate.ts",
        nullControl: "bun run harness/null_control.ts",
      }
    case "shell":
      return { evaluator: "sh harness/evaluate.sh", nullControl: "sh harness/null_control.sh" }
  }
}

/** Files that must be executable when written. */
export const EXECUTABLE_PATHS = new Set([
  "harness/evaluate.sh",
  "harness/null_control.sh",
  "solution/run.sh",
])
