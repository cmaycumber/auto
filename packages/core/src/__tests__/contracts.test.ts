import { describe, expect, test } from "bun:test"
import {
  ContractError,
  parseEvaluatorResult,
  parseMission,
  pathsOverlap,
  slugify,
} from "../contracts.ts"

/** A contract that parses, so each test can mutate one field and assert on that field. */
function validMission(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    slug: "demo",
    title: "Demo",
    domain: "testing",
    metric: { name: "score", description: "higher better" },
    evaluator: {
      command: "echo '{}'",
      format: "json",
      timeoutSeconds: 60,
      keepPolicy: "score_improvement",
      higherIsBetter: true,
    },
    gates: [],
    holdout: { description: "held out", enforcedBy: "path_isolation", hiddenPaths: [] },
    protectedPaths: ["harness"],
    mutablePaths: ["solution"],
    budget: { maxIterations: 10, maxRuntimeSeconds: 600, iterationTimeoutSeconds: 120 },
    driver: { provider: "mock" },
    ...overrides,
  }
}

describe("parseMission", () => {
  test("accepts a well-formed contract", () => {
    const mission = parseMission(validMission())
    expect(mission.slug).toBe("demo")
    expect(mission.evaluator.keepPolicy).toBe("score_improvement")
  })

  test("rejects a mission with nothing protected", () => {
    // Without protected paths there is no cheat surface declared and nothing to hash,
    // which makes every downstream score unfalsifiable.
    expect(() => parseMission(validMission({ protectedPaths: [] }))).toThrow(ContractError)
  })

  test("rejects overlapping protected and mutable paths", () => {
    expect(() =>
      parseMission(
        validMission({ protectedPaths: ["harness"], mutablePaths: ["harness/solution"] }),
      ),
    ).toThrow(/overlaps mutablePaths/)
  })

  test("rejects a non-json evaluator format", () => {
    const mission = validMission()
    ;(mission.evaluator as Record<string, unknown>).format = "text"
    expect(() => parseMission(mission)).toThrow(/must be `json`/)
  })

  test("rejects an unknown version rather than guessing", () => {
    expect(() => parseMission(validMission({ version: 2 }))).toThrow(/must be 1/)
  })

  test("names the offending field in the error", () => {
    const mission = validMission()
    ;(mission.budget as Record<string, unknown>).maxIterations = -5
    expect(() => parseMission(mission)).toThrow(/budget.maxIterations/)
  })

  test("carries an optional null control through", () => {
    const mission = parseMission(
      validMission({
        nullControl: { command: "echo", everyNIterations: 5, alarmWithinFraction: 0.1 },
      }),
    )
    expect(mission.nullControl?.everyNIterations).toBe(5)
  })
})

describe("pathsOverlap", () => {
  test("treats identical paths as overlapping", () => {
    expect(pathsOverlap("a/b", "a/b")).toBe(true)
  })

  test("treats a parent directory as overlapping its child", () => {
    expect(pathsOverlap("a", "a/b/c")).toBe(true)
  })

  test("does not confuse sibling prefixes", () => {
    // The bug this guards: naive startsWith() would call `a/bc` a child of `a/b`.
    expect(pathsOverlap("a/b", "a/bc")).toBe(false)
  })

  test("normalises leading ./ and trailing slashes", () => {
    expect(pathsOverlap("./a/b/", "a/b")).toBe(true)
  })
})

describe("parseEvaluatorResult", () => {
  test("parses a clean result", () => {
    const result = parseEvaluatorResult('{"pass": true, "score": 0.5}')
    expect(result.pass).toBe(true)
    expect(result.score).toBe(0.5)
  })

  test("ignores log noise around the JSON", () => {
    // Evaluators shouldn't have to be silent to be valid.
    const raw = 'loading data...\nprogress: 50%\n{"pass": true, "score": 1.25}\n'
    expect(parseEvaluatorResult(raw).score).toBe(1.25)
  })

  test("takes the last object when several are printed", () => {
    const raw = '{"pass": false, "score": 0}\n{"pass": true, "score": 9}'
    expect(parseEvaluatorResult(raw).score).toBe(9)
  })

  test("is not fooled by braces inside strings", () => {
    const raw = '{"pass": true, "score": 3, "notes": "not a } real brace {"}'
    expect(parseEvaluatorResult(raw).score).toBe(3)
  })

  test("rejects a stringly-typed pass", () => {
    // "true" is what a broken evaluator prints; treating it as true would let a
    // crashing measurement masquerade as a passing one.
    expect(() => parseEvaluatorResult('{"pass": "true"}')).toThrow(/boolean `pass`/)
  })

  test("rejects a non-finite score", () => {
    expect(() => parseEvaluatorResult('{"pass": true, "score": null}')).toThrow(/finite number/)
  })

  test("rejects non-numeric metrics", () => {
    expect(() => parseEvaluatorResult('{"pass": true, "metrics": {"drawdown": "low"}}')).toThrow(
      /drawdown/,
    )
  })

  test("reports empty output clearly", () => {
    expect(() => parseEvaluatorResult("no json here")).toThrow(/no JSON object/)
  })
})

describe("slugify", () => {
  test("normalises a title", () => {
    expect(slugify("Cut Warehouse Pick-Path Length!")).toBe("cut-warehouse-pick-path-length")
  })

  test("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("mission")
  })
})
