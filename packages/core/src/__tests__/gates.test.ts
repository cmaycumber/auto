import { describe, expect, test } from "bun:test"
import type { AutoMission, EvaluatorResult, Gate } from "../contracts.ts"
import { checkGates, checkNullControl, decide, isImprovement } from "../gates.ts"

function mission(overrides: Partial<AutoMission> = {}): AutoMission {
  return {
    version: 1,
    slug: "demo",
    title: "Demo",
    domain: "testing",
    metric: { name: "score", description: "higher better" },
    evaluator: {
      command: "true",
      format: "json",
      timeoutSeconds: 60,
      keepPolicy: "score_improvement",
      higherIsBetter: true,
    },
    gates: [],
    holdout: { description: "x", enforcedBy: "path_isolation", hiddenPaths: [] },
    protectedPaths: ["harness"],
    mutablePaths: ["solution"],
    budget: { maxIterations: 10, maxRuntimeSeconds: 600, iterationTimeoutSeconds: 120 },
    driver: { provider: "mock" },
    ...overrides,
  }
}

const DRAWDOWN_GATE: Gate = {
  metric: "max_drawdown",
  op: "lte",
  value: 0.2,
  reason: "capital preservation",
}

describe("checkGates", () => {
  test("passes when the metric satisfies the gate", () => {
    const result: EvaluatorResult = { pass: true, metrics: { max_drawdown: 0.1 } }
    expect(checkGates([DRAWDOWN_GATE], result)).toHaveLength(0)
  })

  test("breaches when the metric violates the gate", () => {
    const result: EvaluatorResult = { pass: true, metrics: { max_drawdown: 0.35 } }
    expect(checkGates([DRAWDOWN_GATE], result)).toHaveLength(1)
  })

  test("treats a missing gate metric as a breach, not a pass", () => {
    // Silently ignoring an absent metric is how a safety constraint quietly stops
    // being enforced. If a gate names it, the evaluator owes us the number.
    const breaches = checkGates([DRAWDOWN_GATE], { pass: true, metrics: {} })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.actual).toBeUndefined()
  })

  test("handles every comparison operator", () => {
    const result: EvaluatorResult = { pass: true, metrics: { v: 5 } }
    const of = (op: Gate["op"], value: number) =>
      checkGates([{ metric: "v", op, value, reason: "r" }], result).length
    expect(of("lte", 5)).toBe(0)
    expect(of("lt", 5)).toBe(1)
    expect(of("gte", 5)).toBe(0)
    expect(of("gt", 5)).toBe(1)
  })
})

describe("decide", () => {
  test("gates outrank score — a great score cannot buy past a hard floor", () => {
    const decision = decide({
      mission: mission({ gates: [DRAWDOWN_GATE] }),
      result: { pass: true, score: 999, metrics: { max_drawdown: 0.9 } },
      parentScore: 1,
    })
    expect(decision.verdict).toBe("gated")
    expect(decision.rationale).toContain("capital preservation")
  })

  test("keeps a first result when there is no parent", () => {
    const decision = decide({
      mission: mission(),
      result: { pass: true, score: 0.4 },
      parentScore: undefined,
    })
    expect(decision.verdict).toBe("keep")
  })

  test("keeps an improvement and names both numbers", () => {
    const decision = decide({
      mission: mission(),
      result: { pass: true, score: 0.8 },
      parentScore: 0.5,
    })
    expect(decision.verdict).toBe("keep")
    expect(decision.rationale).toContain("0.8")
    expect(decision.rationale).toContain("0.5")
  })

  test("discards a non-improvement", () => {
    const decision = decide({
      mission: mission(),
      result: { pass: true, score: 0.3 },
      parentScore: 0.5,
    })
    expect(decision.verdict).toBe("discard")
  })

  test("respects lower-is-better missions", () => {
    const lower = mission({
      evaluator: { ...mission().evaluator, higherIsBetter: false },
    })
    expect(
      decide({ mission: lower, result: { pass: true, score: 0.3 }, parentScore: 0.5 }).verdict,
    ).toBe("keep")
    expect(
      decide({ mission: lower, result: { pass: true, score: 0.8 }, parentScore: 0.5 }).verdict,
    ).toBe("discard")
  })

  test("an equal score is not an improvement", () => {
    const decision = decide({
      mission: mission(),
      result: { pass: true, score: 0.5 },
      parentScore: 0.5,
    })
    expect(decision.verdict).toBe("discard")
  })

  test("pass_only ignores the score entirely", () => {
    const passOnly = mission({
      evaluator: { ...mission().evaluator, keepPolicy: "pass_only" },
    })
    expect(
      decide({ mission: passOnly, result: { pass: true, score: 0 }, parentScore: 99 }).verdict,
    ).toBe("keep")
    expect(
      decide({ mission: passOnly, result: { pass: false, score: 99 }, parentScore: 0 }).verdict,
    ).toBe("discard")
  })

  test("a scoreless result under score_improvement is a crash, not a silent keep", () => {
    const decision = decide({
      mission: mission(),
      result: { pass: true },
      parentScore: 0.5,
    })
    expect(decision.verdict).toBe("crash")
    expect(decision.rationale).toContain("pass_only")
  })
})

describe("isImprovement", () => {
  test("anything beats an absent parent", () => {
    expect(isImprovement(-100, undefined, true)).toBe(true)
  })

  test("respects direction", () => {
    expect(isImprovement(1, 2, true)).toBe(false)
    expect(isImprovement(1, 2, false)).toBe(true)
  })
})

describe("checkNullControl", () => {
  test("does not fire when the champion clearly beats noise", () => {
    const result = checkNullControl(1.0, 0.2, 0.1, true)
    expect(result.breached).toBe(false)
  })

  test("fires when noise scores nearly as well", () => {
    const result = checkNullControl(1.0, 0.95, 0.1, true)
    expect(result.breached).toBe(true)
    expect(result.message).toContain("not measuring skill")
  })

  test("fires when noise beats the champion outright", () => {
    expect(checkNullControl(1.0, 1.5, 0.1, true).breached).toBe(true)
  })

  test("respects lower-is-better direction", () => {
    // Champion 0.1, null 0.9: for lower-is-better that is a large, healthy gap.
    expect(checkNullControl(0.1, 0.9, 0.1, false).breached).toBe(false)
    expect(checkNullControl(0.1, 0.105, 0.1, false).breached).toBe(true)
  })

  test("skips the comparison when the champion score is ~0", () => {
    // A relative gap against zero is meaningless; reporting a breach would be noise.
    const result = checkNullControl(0, 0, 0.1, true)
    expect(result.breached).toBe(false)
    expect(result.message).toContain("uninformative")
  })

  test("reads a narrow gap at baseline as headroom, not a broken metric", () => {
    // The naive scaffold having no edge over random is normal and expected. Telling the
    // operator their evaluator is broken at that point would be wrong and would train
    // them to ignore the warning that matters later.
    const result = checkNullControl(0.652, 0.649, 0.1, true, "baseline")
    expect(result.breached).toBe(true)
    expect(result.message).toContain("expected at this stage")
    expect(result.message).not.toContain("not measuring skill")
  })

  test("reads the same gap after optimisation as an indictment of the metric", () => {
    const result = checkNullControl(0.652, 0.649, 0.1, true, "optimised")
    expect(result.breached).toBe(true)
    expect(result.message).toContain("not distinguishable from noise")
  })

  test("defaults to the stricter reading", () => {
    expect(checkNullControl(0.652, 0.649, 0.1, true).message).toContain(
      "not distinguishable from noise",
    )
  })
})
