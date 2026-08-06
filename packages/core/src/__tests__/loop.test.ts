/**
 * End-to-end loop tests.
 *
 * Every branch the loop can take is exercised against a real filesystem with a real
 * subprocess evaluator — only the agent is mocked. The point is that the safeguards are
 * verified as *behaviour* (a discarded candidate is actually gone from disk, a tampered
 * evaluator actually halts the run) rather than as unit-tested helpers that the loop
 * might or might not call in the right order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readArchive } from "../archive.ts"
import type { AutoMission } from "../contracts.ts"
import { createMockDriver } from "../drivers/mock.ts"
import { runLoop } from "../loop.ts"
import { type LoadedMission, loadMission } from "../mission.ts"

let dir: string

/**
 * A minimal but complete mission.
 *
 * The evaluator is a shell script that reads `solution/value.txt` and reports it as the
 * score, so a mock agent "improves" the solution by writing a bigger number. Trivial, and
 * it makes the loop's decisions unambiguous to assert on.
 */
async function createMission(overrides: Partial<AutoMission> = {}): Promise<void> {
  await mkdir(join(dir, "harness"), { recursive: true })
  await mkdir(join(dir, "solution"), { recursive: true })

  const evaluator = `#!/bin/sh
value=$(cat solution/value.txt 2>/dev/null || echo 0)
risk=$(cat solution/risk.txt 2>/dev/null || echo 0)
echo "{\\"pass\\": true, \\"score\\": $value, \\"metrics\\": {\\"risk\\": $risk}}"
`
  await writeFile(join(dir, "harness", "evaluate.sh"), evaluator)
  await chmod(join(dir, "harness", "evaluate.sh"), 0o755)

  await writeFile(join(dir, "solution", "value.txt"), "10")
  await writeFile(join(dir, "solution", "risk.txt"), "0")

  const mission: AutoMission = {
    version: 1,
    slug: "loop-test",
    title: "Loop test",
    domain: "testing",
    metric: { name: "value", description: "bigger is better" },
    evaluator: {
      command: "sh harness/evaluate.sh",
      format: "json",
      timeoutSeconds: 30,
      keepPolicy: "score_improvement",
      higherIsBetter: true,
    },
    gates: [],
    holdout: { description: "none", enforcedBy: "manual", hiddenPaths: [] },
    protectedPaths: ["harness"],
    mutablePaths: ["solution"],
    budget: { maxIterations: 5, maxRuntimeSeconds: 120, iterationTimeoutSeconds: 30 },
    driver: { provider: "mock" },
    ...overrides,
  }

  await writeFile(join(dir, "auto.json"), JSON.stringify(mission, null, 2))
  await writeFile(join(dir, "mission.md"), "# Loop test\n\nMake the number bigger.\n")
}

/** A mock agent that writes a fixed sequence of values, one per iteration. */
function scriptedAgent(values: Array<{ value?: number; risk?: number; noop?: boolean }>) {
  let index = 0
  return createMockDriver({
    handler: async () => {
      const step = values[Math.min(index, values.length - 1)]
      index += 1

      if (!step || step.noop) {
        return { ok: true, description: "did nothing", rawOutput: "", durationMs: 1 }
      }
      if (step.value !== undefined) {
        await writeFile(join(dir, "solution", "value.txt"), String(step.value))
      }
      if (step.risk !== undefined) {
        await writeFile(join(dir, "solution", "risk.txt"), String(step.risk))
      }
      return {
        ok: true,
        description: `set value=${step.value ?? "-"} risk=${step.risk ?? "-"}`,
        rawOutput: "",
        durationMs: 1,
      }
    },
  })
}

async function load(): Promise<LoadedMission> {
  return loadMission(dir)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-loop-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("baseline", () => {
  test("is measured before the agent touches anything", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
      maxIterations: 1,
    })

    const baseline = result.entries.find((entry) => entry.iteration === 0)
    expect(baseline?.score).toBe(10)
    expect(baseline?.description).toContain("baseline")
  })

  test("a harness that cannot score halts the run", async () => {
    // If the scaffold cannot produce a number, there is nothing to improve on and
    // every later number would be uninterpretable.
    await createMission()
    await writeFile(join(dir, "harness", "evaluate.sh"), "#!/bin/sh\nexit 1\n")
    await chmod(join(dir, "harness", "evaluate.sh"), 0o755)

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
    })

    expect(result.reason).toBe("baseline_failed")
    expect(result.stats.total).toBe(0)
  })

  test("a baseline that breaches a gate halts the run", async () => {
    await createMission({
      gates: [{ metric: "risk", op: "lte", value: -1, reason: "unreachable by design" }],
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
    })

    expect(result.reason).toBe("baseline_failed")
  })
})

describe("keep and discard", () => {
  test("keeps an improvement", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 25 }]),
      maxIterations: 1,
    })

    const entry = result.entries.find((e) => e.iteration === 1)
    expect(entry?.verdict).toBe("keep")
    expect(entry?.score).toBe(25)
    expect(result.stats.bestScore).toBe(25)
  })

  test("discards a regression AND reverts it on disk", async () => {
    // The assertion that matters is the file content: a discard that leaves the bad
    // version in place silently makes it the base for the next iteration.
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 3 }]),
      maxIterations: 1,
    })

    expect(result.entries.find((e) => e.iteration === 1)?.verdict).toBe("discard")
    expect((await readFile(join(dir, "solution", "value.txt"), "utf-8")).trim()).toBe("10")
  })

  test("climbs across several iterations", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 12 }, { value: 8 }, { value: 30 }]),
      maxIterations: 3,
      explorationRate: 0, // always branch from the champion, so the walk is deterministic
    })

    expect(result.stats.bestScore).toBe(30)
    expect(result.stats.kept).toBe(3) // baseline + 12 + 30
    expect(result.stats.discarded).toBe(1) // the 8
  })
})

describe("gates", () => {
  test("a gate breach outranks a better score", async () => {
    await createMission({
      gates: [{ metric: "risk", op: "lte", value: 5, reason: "risk ceiling" }],
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 1000, risk: 99 }]),
      maxIterations: 1,
    })

    const entry = result.entries.find((e) => e.iteration === 1)
    expect(entry?.verdict).toBe("gated")
    expect(entry?.rationale).toContain("risk ceiling")
    expect(result.stats.bestScore).toBe(10) // champion unchanged
  })

  test("a gated candidate is reverted on disk", async () => {
    await createMission({
      gates: [{ metric: "risk", op: "lte", value: 5, reason: "risk ceiling" }],
    })

    await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 1000, risk: 99 }]),
      maxIterations: 1,
    })

    expect((await readFile(join(dir, "solution", "value.txt"), "utf-8")).trim()).toBe("10")
  })
})

describe("integrity", () => {
  test("halts the run when the agent modifies the evaluator", async () => {
    await createMission()

    const tamperer = createMockDriver({
      handler: async () => {
        await writeFile(
          join(dir, "harness", "evaluate.sh"),
          '#!/bin/sh\necho \'{"pass": true, "score": 999999}\'\n',
        )
        return { ok: true, description: "fixed the evaluator", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: tamperer, maxIterations: 3 })

    expect(result.reason).toBe("integrity_violation")
    // The tampered evaluator must never have produced a score.
    expect(result.entries.some((e) => e.score === 999999)).toBe(false)
    expect(result.stats.bestScore).toBe(10)
  })

  test("a formatter reflowing a protected file halts the run, and says so", async () => {
    // This is not hypothetical: a `biome check --write` over the surrounding repo
    // reflowed a mission's JSON mid-run during development. Integrity stays byte-exact
    // (softening it would be a bypass), but the message has to point at the real cause,
    // or the operator stares at a semantically identical file wondering what moved.
    await createMission()

    const reformatter = createMockDriver({
      handler: async () => {
        const path = join(dir, "harness", "evaluate.sh")
        await writeFile(path, `${await readFile(path, "utf-8")}\n`) // whitespace only
        return { ok: true, description: "no functional change", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: reformatter, maxIterations: 2 })

    expect(result.reason).toBe("integrity_violation")
    const log = await readFile(result.decisionLogPath, "utf-8")
    expect(log).toContain("formatter or linter")
  })

  test("flags agent-tooling scratch as such rather than as tampering", async () => {
    await createMission()

    const scratchWriter = createMockDriver({
      handler: async () => {
        await mkdir(join(dir, "harness", ".omc", "state"), { recursive: true })
        await writeFile(join(dir, "harness", ".omc", "state", "session.json"), "{}")
        return { ok: true, description: "ran a tool", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: scratchWriter, maxIterations: 2 })

    expect(result.reason).toBe("integrity_violation")
    const log = await readFile(result.decisionLogPath, "utf-8")
    expect(log).toContain("agent tooling wrote session state")
  })

  test("halts when the agent adds a file inside the protected tree", async () => {
    await createMission()

    const shadower = createMockDriver({
      handler: async () => {
        await writeFile(join(dir, "harness", "shim.sh"), "# shadow")
        return { ok: true, description: "added a helper", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: shadower, maxIterations: 3 })
    expect(result.reason).toBe("integrity_violation")
  })
})

describe("failure handling", () => {
  test("records an agent error as a crash and keeps going", async () => {
    await createMission()
    let call = 0
    const flaky = createMockDriver({
      handler: async () => {
        call += 1
        if (call === 1) {
          return {
            ok: false,
            description: "(agent error)",
            rawOutput: "",
            error: "model unavailable",
            durationMs: 1,
          }
        }
        await writeFile(join(dir, "solution", "value.txt"), "40")
        return { ok: true, description: "set value=40", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: flaky, maxIterations: 2 })

    expect(result.stats.crashed).toBe(1)
    expect(result.stats.bestScore).toBe(40) // the loop recovered
  })

  test("records a turn that changed nothing as a crash", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ noop: true }]),
      maxIterations: 1,
    })

    const entry = result.entries.find((e) => e.iteration === 1)
    expect(entry?.verdict).toBe("crash")
    expect(entry?.rationale).toContain("without changing any file")
  })

  test("records an evaluator crash without blaming the candidate", async () => {
    await createMission()

    // The agent writes something the evaluator chokes on.
    const breaker = createMockDriver({
      handler: async () => {
        await writeFile(join(dir, "solution", "value.txt"), "not-a-number")
        return { ok: true, description: "wrote garbage", rawOutput: "", durationMs: 1 }
      },
    })

    const result = await runLoop({ loaded: await load(), driver: breaker, maxIterations: 1 })
    const entry = result.entries.find((e) => e.iteration === 1)
    expect(entry?.verdict).toBe("crash")
    expect(entry?.score).toBeNull()
  })
})

describe("budgets and cancellation", () => {
  test("stops at the iteration budget", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 11 }, { value: 12 }, { value: 13 }, { value: 14 }]),
      maxIterations: 2,
    })

    expect(result.reason).toBe("max_iterations")
    expect(result.entries.filter((e) => e.iteration > 0)).toHaveLength(2)
  })

  test("stops when cancelled", async () => {
    await createMission()
    const controller = new AbortController()
    controller.abort()

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 99 }]),
      signal: controller.signal,
    })

    expect(result.reason).toBe("cancelled")
  })

  test("stops when an unavailable driver is configured", async () => {
    await createMission()
    // A mock driver with neither a handler nor a command reports itself unavailable.
    const result = await runLoop({ loaded: await load(), driver: createMockDriver() })
    expect(result.reason).toBe("driver_unavailable")
  })
})

describe("null control", () => {
  test("flags a breach when noise scores as well as the champion", async () => {
    await createMission({
      nullControl: {
        // Scores 9 against a baseline of 10 — a 10% gap, right at the alarm threshold.
        command: `echo '{"pass": true, "score": 9}'`,
        everyNIterations: 1,
        alarmWithinFraction: 0.2,
      },
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 11 }]),
      maxIterations: 1,
    })

    expect(result.nullControlBreached).toBe(true)
  })

  test("a baseline with no edge does not condemn the run", async () => {
    // The scaffold being no better than random is the normal starting condition. Only a
    // breach measured against something the loop produced invalidates its results.
    await createMission({
      nullControl: {
        command: `echo '{"pass": true, "score": 9.9}'`,
        everyNIterations: 10, // no scheduled check inside this short run
        alarmWithinFraction: 0.2,
      },
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 11 }]),
      maxIterations: 1,
    })

    expect(result.nullControlBreached).toBe(false)
    const log = await readFile(result.decisionLogPath, "utf-8")
    expect(log).toContain("baseline has no edge yet")
  })

  test("stays quiet when the champion clearly beats noise", async () => {
    await createMission({
      nullControl: {
        command: `echo '{"pass": true, "score": 1}'`,
        everyNIterations: 1,
        alarmWithinFraction: 0.2,
      },
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 11 }]),
      maxIterations: 1,
    })

    expect(result.nullControlBreached).toBe(false)
  })
})

describe("artifacts", () => {
  test("writes an archive, a decision log, and per-iteration evaluations", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
      maxIterations: 1,
    })

    const archived = await readArchive(join(dir, "archive", "entries.jsonl"))
    expect(archived).toHaveLength(2) // baseline + one iteration

    const log = await readFile(result.decisionLogPath, "utf-8")
    expect(log).toContain("Loop test")
    expect(log).toContain("Iteration 1")
    expect(log).toContain("Run summary")

    const evaluation = await readFile(
      join(dir, "runs", result.runId, "evaluations", "iteration-0001.json"),
      "utf-8",
    )
    expect(JSON.parse(evaluation).result.score).toBe(20)
  })

  test("separates log blocks so notes render as quotes, not as run-on paragraphs", async () => {
    await createMission({
      nullControl: {
        command: `echo '{"pass": true, "score": 1}'`,
        everyNIterations: 1,
        alarmWithinFraction: 0.2,
      },
    })

    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
      maxIterations: 1,
    })

    const log = await readFile(result.decisionLogPath, "utf-8")
    // Every blockquote note must be preceded by a blank line, or markdown folds it into
    // the paragraph above it.
    const lines = log.split("\n")
    for (const [index, line] of lines.entries()) {
      if (line.startsWith(">") && index > 0) {
        expect(lines[index - 1]).toBe("")
      }
    }
  })

  test("the summary refuses to celebrate a short run", async () => {
    await createMission()
    const result = await runLoop({
      loaded: await load(),
      driver: scriptedAgent([{ value: 20 }]),
      maxIterations: 1,
    })

    const log = await readFile(result.decisionLogPath, "utf-8")
    expect(log).toContain("Read this before believing the number above")
    expect(log).toContain("within what noise produces")
  })
})
