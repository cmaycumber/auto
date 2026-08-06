/**
 * Gating: deciding what happens to a candidate after it has been measured.
 *
 * Order matters and is not negotiable. Gates are checked before score comparison so that
 * a candidate cannot buy its way past a hard floor with a good headline number. This is
 * the generalisation of "max drawdown > 20% is a discard no matter the Sharpe" — every
 * domain has some constraint that a naive optimiser will happily trade away.
 */

import type { AutoMission, EvaluatorResult, Gate } from "./contracts.ts"

export type Verdict =
  /** Better than the parent (or first to pass). Becomes the new champion. */
  | "keep"
  /** Measured fine, just not an improvement. Recorded, then reverted. */
  | "discard"
  /** Breached a hard gate. Recorded with the breach, then reverted. */
  | "gated"
  /** The measurement itself failed. Carries no information about the candidate. */
  | "crash"

export interface GateBreach {
  gate: Gate
  actual: number | undefined
}

export interface Decision {
  verdict: Verdict
  /** One line, suitable for the decision log and the terminal. */
  rationale: string
  breaches: GateBreach[]
}

function satisfies(gate: Gate, actual: number): boolean {
  switch (gate.op) {
    case "lte":
      return actual <= gate.value
    case "gte":
      return actual >= gate.value
    case "lt":
      return actual < gate.value
    case "gt":
      return actual > gate.value
  }
}

function describe(gate: Gate): string {
  const symbol = { lte: "<=", gte: ">=", lt: "<", gt: ">" }[gate.op]
  return `${gate.metric} ${symbol} ${gate.value}`
}

/**
 * Check every gate against a result.
 *
 * A gate whose metric is missing from the evaluator output counts as a breach, not a
 * pass. Silently ignoring an absent metric is how a safety constraint quietly stops
 * being enforced — if a gate mentions `max_drawdown`, the evaluator is obliged to
 * report `max_drawdown`.
 */
export function checkGates(gates: Gate[], result: EvaluatorResult): GateBreach[] {
  const breaches: GateBreach[] = []
  for (const gate of gates) {
    const actual = result.metrics?.[gate.metric]
    if (actual === undefined || !satisfies(gate, actual)) {
      breaches.push({ gate, actual })
    }
  }
  return breaches
}

/** True when `candidate` is strictly better than `parent` under the mission's direction. */
export function isImprovement(
  candidate: number,
  parent: number | undefined,
  higherIsBetter: boolean,
): boolean {
  if (parent === undefined) return true
  return higherIsBetter ? candidate > parent : candidate < parent
}

export interface DecideOptions {
  mission: AutoMission
  result: EvaluatorResult
  /** The champion's score, or undefined on the very first iteration. */
  parentScore: number | undefined
}

/**
 * Apply gates, then the keep policy, and produce the verdict plus the sentence that
 * explains it. The rationale is written for a human reading the log a week later, so it
 * always names the number that decided things.
 */
export function decide(options: DecideOptions): Decision {
  const { mission, result, parentScore } = options
  const breaches = checkGates(mission.gates, result)

  if (breaches.length > 0) {
    const detail = breaches
      .map((b) => {
        const actual = b.actual === undefined ? "not reported" : format(b.actual)
        return `${describe(b.gate)} (actual: ${actual}) — ${b.gate.reason}`
      })
      .join("; ")
    return { verdict: "gated", rationale: `Hard gate breached: ${detail}`, breaches }
  }

  if (mission.evaluator.keepPolicy === "pass_only") {
    return result.pass
      ? { verdict: "keep", rationale: "Evaluator reported pass=true.", breaches: [] }
      : { verdict: "discard", rationale: "Evaluator reported pass=false.", breaches: [] }
  }

  if (result.score === undefined) {
    return {
      verdict: "crash",
      rationale:
        "Keep policy is `score_improvement` but the evaluator reported no score. " +
        "Either emit a numeric `score` or switch the policy to `pass_only`.",
      breaches: [],
    }
  }

  const direction = mission.evaluator.higherIsBetter ? "higher" : "lower"
  if (isImprovement(result.score, parentScore, mission.evaluator.higherIsBetter)) {
    const versus =
      parentScore === undefined
        ? "no parent — this is the baseline"
        : `beats ${format(parentScore)}`
    return {
      verdict: "keep",
      rationale: `${mission.metric.name} = ${format(result.score)} (${versus}; ${direction} is better).`,
      breaches: [],
    }
  }

  return {
    verdict: "discard",
    rationale: `${mission.metric.name} = ${format(result.score)} does not beat champion ${format(
      parentScore as number,
    )} (${direction} is better).`,
    breaches: [],
  }
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "")
}

/**
 * What the champion score represents when compared against the null control.
 *
 * The distinction changes what a narrow gap *means*, and therefore what the operator
 * should do about it — so it changes the message, not just its wording.
 */
export type NullComparisonContext =
  /** The champion is still the untouched scaffold — nothing has been optimised yet. */
  | "baseline"
  /** The champion is something the loop produced. */
  | "optimised"

/**
 * Compare a null-control score against the champion.
 *
 * Returns a warning when signal-free input scores suspiciously close to the real thing.
 * The comparison is on the *magnitude* of the champion score so it works for metrics
 * centred anywhere; a champion score of ~0 makes the check meaningless, so it is skipped
 * rather than reported as a spurious breach.
 *
 * A narrow gap at baseline and a narrow gap after fifty iterations are different
 * findings. At baseline it usually means the starting solution has no skill in it, which
 * is normal and is exactly the headroom the loop exists to climb. After the loop has been
 * keeping candidates, it means those keeps cannot be distinguished from noise — which
 * points at the evaluator, and is the more alarming of the two.
 */
export function checkNullControl(
  championScore: number,
  nullScore: number,
  alarmWithinFraction: number,
  higherIsBetter: boolean,
  context: NullComparisonContext = "optimised",
): { breached: boolean; message: string } {
  const magnitude = Math.abs(championScore)
  if (magnitude < 1e-9) {
    return {
      breached: false,
      message: "Champion score is ~0; null-control comparison is uninformative here.",
    }
  }

  const gap = higherIsBetter ? championScore - nullScore : nullScore - championScore
  const relativeGap = gap / magnitude

  if (relativeGap < alarmWithinFraction) {
    const preamble =
      `Signal-free baseline scored ${format(nullScore)} against a champion of ` +
      `${format(championScore)} (relative gap ${relativeGap.toFixed(3)} < ${alarmWithinFraction}). `

    return {
      breached: true,
      message:
        context === "baseline"
          ? `${preamble}That is expected at this stage — it means the starting solution has ` +
            "no skill in it yet, which is the headroom the loop is here to climb. Watch " +
            "this number: once candidates are being kept, the gap should open. If it " +
            "does not, the keeps are noise."
          : `${preamble}The kept candidates are not distinguishable from noise. Either the ` +
            "metric is not measuring skill or the task does not discriminate. Treat every " +
            "improvement in this run as unproven until that is explained.",
    }
  }

  return {
    breached: false,
    message:
      `Null control ${format(nullScore)} vs champion ${format(championScore)} ` +
      `(relative gap ${relativeGap.toFixed(3)}).`,
  }
}
