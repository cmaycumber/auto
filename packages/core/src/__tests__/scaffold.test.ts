import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMission } from "../contracts.ts"
import { extractDescription } from "../drivers/types.ts"
import { auditAnswers, defaultAnswers } from "../interview.ts"
import { loadMission } from "../mission.ts"
import { buildBrief, buildContract, planMission, writeMission } from "../scaffold.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-scaffold-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("buildContract", () => {
  test("produces a contract that parseMission accepts", () => {
    // The scaffolder and the parser must agree, or `auto init` generates missions that
    // `auto run` refuses to load.
    const contract = buildContract(defaultAnswers())
    expect(() => parseMission(JSON.parse(JSON.stringify(contract)))).not.toThrow()
  })

  test("omits the null control when none was given", () => {
    const answers = defaultAnswers()
    delete answers.nullControlCommand
    expect(buildContract(answers).nullControl).toBeUndefined()
  })

  test("derives the slug from the title", () => {
    expect(buildContract(defaultAnswers({ title: "Cut Pick-Path Length" })).slug).toBe(
      "cut-pick-path-length",
    )
  })
})

describe("buildBrief", () => {
  test("tells the agent what it may not edit", () => {
    const brief = buildBrief(defaultAnswers())
    expect(brief).toContain("You may not edit")
    expect(brief).toContain("harness")
  })

  test("warns explicitly when there is no null control", () => {
    const answers = defaultAnswers()
    delete answers.nullControlCommand
    expect(buildBrief(answers)).toContain("No null control")
  })
})

describe("planMission / writeMission", () => {
  test("writes a mission that loadMission can read back", async () => {
    const plan = planMission(defaultAnswers({ title: "Round trip" }))
    await writeMission({ targetDir: dir, plan })

    const loaded = await loadMission(dir)
    expect(loaded.mission.title).toBe("Round trip")
    expect(loaded.brief).toContain("Round trip")
  })

  test("does not overwrite existing files by default", async () => {
    // Clobbering a customised harness would destroy the only copy of the thing that
    // makes someone's results meaningful.
    const plan = planMission(defaultAnswers())
    await writeMission({ targetDir: dir, plan })
    await writeFile(join(dir, "solution", "solve.py"), "# my careful work")

    const second = await writeMission({ targetDir: dir, plan })
    expect(second.skipped).toContain("solution/solve.py")
    expect(await readFile(join(dir, "solution", "solve.py"), "utf-8")).toBe("# my careful work")
  })

  test("overwrites when forced", async () => {
    const plan = planMission(defaultAnswers())
    await writeMission({ targetDir: dir, plan })
    await writeFile(join(dir, "solution", "solve.py"), "# my careful work")

    const second = await writeMission({ targetDir: dir, plan, force: true })
    expect(second.written).toContain("solution/solve.py")
  })

  test("generates disjoint train and holdout instances", async () => {
    const plan = planMission(defaultAnswers())
    await writeMission({ targetDir: dir, plan })

    const train = JSON.parse(await readFile(join(dir, "harness/train/instances.json"), "utf-8"))
    const holdout = JSON.parse(await readFile(join(dir, "harness/holdout/instances.json"), "utf-8"))

    expect(train).toHaveLength(40)
    expect(holdout).toHaveLength(40)
    expect(JSON.stringify(train)).not.toBe(JSON.stringify(holdout))
  })

  test("is deterministic across scaffolds", async () => {
    // Instances that differ per scaffold make two runs incomparable for reasons
    // nobody would think to check.
    const a = planMission(defaultAnswers())
    const b = planMission(defaultAnswers())
    const find = (plan: typeof a, path: string) =>
      plan.files.find((file) => file.path === path)?.contents

    expect(find(a, "harness/holdout/instances.json")).toBe(
      find(b, "harness/holdout/instances.json") as string,
    )
  })

  test("supports every template", async () => {
    for (const template of ["python", "node", "shell"] as const) {
      const target = join(dir, template)
      const plan = planMission(defaultAnswers({ template }))
      const result = await writeMission({ targetDir: target, plan })
      expect(result.written).toContain("auto.json")
      expect(result.written.some((p) => p.startsWith("harness/"))).toBe(true)
    }
  })
})

describe("auditAnswers", () => {
  test("accepts the defaults", () => {
    expect(auditAnswers(defaultAnswers()).errors).toHaveLength(0)
  })

  test("rejects held-out data that nothing protects", () => {
    const audit = auditAnswers(
      defaultAnswers({ hiddenPaths: ["data/secret"], protectedPaths: ["harness"] }),
    )
    expect(audit.errors.some((e) => e.field === "hiddenPaths")).toBe(true)
  })

  test("rejects overlapping mutable and protected paths", () => {
    const audit = auditAnswers(
      defaultAnswers({ mutablePaths: ["harness/solution"], protectedPaths: ["harness"] }),
    )
    expect(audit.errors.some((e) => e.field === "mutablePaths")).toBe(true)
  })

  test("warns loudly about a missing null control", () => {
    const answers = defaultAnswers()
    delete answers.nullControlCommand
    const audit = auditAnswers(answers)

    expect(audit.errors).toHaveLength(0) // allowed…
    expect(audit.warnings.some((w) => w.field === "nullControlCommand")).toBe(true) // …but not quietly
  })

  test("warns about a manually enforced holdout", () => {
    const audit = auditAnswers(defaultAnswers({ holdoutEnforcement: "manual" }))
    expect(audit.warnings.some((w) => w.field === "holdoutEnforcement")).toBe(true)
  })

  test("warns about a run too short to mean anything", () => {
    const audit = auditAnswers(
      defaultAnswers({
        budget: { maxIterations: 5, maxRuntimeSeconds: 600, iterationTimeoutSeconds: 60 },
      }),
    )
    expect(audit.warnings.some((w) => w.field === "budget.maxIterations")).toBe(true)
  })
})

describe("extractDescription", () => {
  test("pulls the marker line", () => {
    const output = "I changed things.\nDESCRIPTION: raised the threshold from 0.85 to 0.92"
    expect(extractDescription(output)).toBe("raised the threshold from 0.85 to 0.92")
  })

  test("takes the last marker when several appear", () => {
    const output = "DESCRIPTION: first draft\nthinking again\nDESCRIPTION: final answer"
    expect(extractDescription(output)).toBe("final answer")
  })

  test("degrades to the last line when the marker is missing", () => {
    // A good edit with a sloppy sign-off is still a good edit.
    expect(extractDescription("did some work\nswapped the sort order")).toBe(
      "swapped the sort order",
    )
  })

  test("handles empty output", () => {
    expect(extractDescription("")).toBe("(no description reported)")
  })
})
