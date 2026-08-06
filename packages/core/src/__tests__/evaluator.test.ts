import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { runEvaluator } from "../evaluator.ts"

const cwd = tmpdir()

describe("runEvaluator", () => {
  test("parses a well-behaved evaluator", async () => {
    const run = await runEvaluator({
      command: `echo '{"pass": true, "score": 0.75, "metrics": {"n": 40}}'`,
      cwd,
      timeoutSeconds: 10,
    })

    expect(run.outcome).toBe("ok")
    expect(run.result?.score).toBe(0.75)
    expect(run.result?.metrics?.n).toBe(40)
  })

  test("reports a non-zero exit as an error, not a zero score", async () => {
    // A measurement that did not run is not a score of zero. Conflating the two lets a
    // broken harness look like a uniformly bad solution.
    const run = await runEvaluator({ command: "exit 3", cwd, timeoutSeconds: 10 })

    expect(run.outcome).toBe("error")
    expect(run.exitCode).toBe(3)
    expect(run.result).toBeUndefined()
  })

  test("surfaces stderr in the error message", async () => {
    const run = await runEvaluator({
      command: "echo 'boom: missing dependency' >&2; exit 1",
      cwd,
      timeoutSeconds: 10,
    })

    expect(run.error).toContain("missing dependency")
  })

  test("reports unparseable output distinctly from a crash", async () => {
    const run = await runEvaluator({ command: "echo 'not json'", cwd, timeoutSeconds: 10 })

    expect(run.outcome).toBe("invalid_output")
    expect(run.error).toContain("no JSON object")
  })

  test("kills an evaluator that exceeds its budget", async () => {
    const run = await runEvaluator({ command: "sleep 5", cwd, timeoutSeconds: 0.3 })

    expect(run.outcome).toBe("timeout")
    expect(run.error).toContain("budget")
  })

  test("never throws for a misbehaving evaluator", async () => {
    // The loop must be able to record and move past any failure mode.
    const run = await runEvaluator({
      command: "this-command-does-not-exist-anywhere",
      cwd,
      timeoutSeconds: 10,
    })
    expect(run.outcome).toBe("error")
  })

  test("honours an abort signal", async () => {
    const controller = new AbortController()
    const promise = runEvaluator({
      command: "sleep 5",
      cwd,
      timeoutSeconds: 30,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)

    expect((await promise).outcome).toBe("timeout")
  })

  test("passes extra environment through", async () => {
    const run = await runEvaluator({
      command: `echo "{\\"pass\\": true, \\"score\\": $AUTO_TEST_VALUE}"`,
      cwd,
      timeoutSeconds: 10,
      env: { AUTO_TEST_VALUE: "42" },
    })

    expect(run.result?.score).toBe(42)
  })
})
