import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  auditPathDeclarations,
  buildManifest,
  findOutOfBoundsEdits,
  verifyManifest,
} from "../integrity.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-integrity-"))
  await mkdir(join(dir, "harness"), { recursive: true })
  await mkdir(join(dir, "solution"), { recursive: true })
  await writeFile(join(dir, "harness", "evaluate.py"), "print('score')")
  await writeFile(join(dir, "harness", "task.py"), "TASK = 1")
  await writeFile(join(dir, "solution", "solve.py"), "def solve(): pass")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("buildManifest", () => {
  test("hashes every file under a protected directory", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    expect(Object.keys(manifest.files).sort()).toEqual(["harness/evaluate.py", "harness/task.py"])
  })

  test("does not reach outside the protected paths", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    expect(manifest.files["solution/solve.py"]).toBeUndefined()
  })

  test("tolerates a declared path that does not exist yet", async () => {
    const manifest = await buildManifest(dir, ["harness", "not-created-yet"])
    expect(Object.keys(manifest.files)).toHaveLength(2)
  })
})

describe("verifyManifest", () => {
  test("reports nothing when the tree is untouched", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    expect(await verifyManifest(dir, ["harness"], manifest)).toHaveLength(0)
  })

  test("detects a modified evaluator", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    await writeFile(join(dir, "harness", "evaluate.py"), "print('always 1.0')")

    const violations = await verifyManifest(dir, ["harness"], manifest)
    expect(violations).toEqual([{ path: "harness/evaluate.py", kind: "modified" }])
  })

  test("detects a deleted file", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    await rm(join(dir, "harness", "task.py"))

    const violations = await verifyManifest(dir, ["harness"], manifest)
    expect(violations).toEqual([{ path: "harness/task.py", kind: "deleted" }])
  })

  test("detects a file added inside the protected tree", async () => {
    // The shadowing attack: leave evaluate.py alone, drop a sitecustomize.py next to it.
    const manifest = await buildManifest(dir, ["harness"])
    await writeFile(join(dir, "harness", "sitecustomize.py"), "# hijack")

    const violations = await verifyManifest(dir, ["harness"], manifest)
    expect(violations).toEqual([{ path: "harness/sitecustomize.py", kind: "added" }])
  })

  test("ignores changes in the mutable tree", async () => {
    const manifest = await buildManifest(dir, ["harness"])
    await writeFile(join(dir, "solution", "solve.py"), "def solve(): return 42")
    expect(await verifyManifest(dir, ["harness"], manifest)).toHaveLength(0)
  })
})

describe("findOutOfBoundsEdits", () => {
  test("allows edits inside a mutable path", () => {
    expect(findOutOfBoundsEdits(["solution/solve.py"], ["solution"])).toHaveLength(0)
  })

  test("flags edits outside every mutable path", () => {
    expect(findOutOfBoundsEdits(["harness/evaluate.py"], ["solution"])).toEqual([
      "harness/evaluate.py",
    ])
  })

  test("does not treat a sibling prefix as inside", () => {
    expect(findOutOfBoundsEdits(["solutions-backup/x.py"], ["solution"])).toEqual([
      "solutions-backup/x.py",
    ])
  })
})

describe("auditPathDeclarations", () => {
  test("passes when the holdout is properly covered", () => {
    const problems = auditPathDeclarations({
      protectedPaths: ["harness"],
      mutablePaths: ["solution"],
      holdout: { hiddenPaths: ["harness/holdout"] },
    })
    expect(problems).toHaveLength(0)
  })

  test("catches held-out data that nothing protects", () => {
    // The exact mistake: declare a holdout, forget to protect it, and the agent can
    // read and rewrite the thing it is being scored on.
    const problems = auditPathDeclarations({
      protectedPaths: ["harness"],
      mutablePaths: ["solution"],
      holdout: { hiddenPaths: ["data/holdout"] },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("data/holdout")
  })

  test("catches held-out data inside the mutable tree", () => {
    const problems = auditPathDeclarations({
      protectedPaths: ["solution/holdout"],
      mutablePaths: ["solution"],
      holdout: { hiddenPaths: ["solution/holdout"] },
    })
    expect(problems.some((p) => p.includes("overlaps a mutable path"))).toBe(true)
  })
})
