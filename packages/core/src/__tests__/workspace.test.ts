import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffTrees, hashMutableTree, restore, snapshot } from "../workspace.ts"

let dir: string
let snapshots: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "auto-workspace-"))
  snapshots = join(dir, ".snapshots")
  await mkdir(join(dir, "solution"), { recursive: true })
  await writeFile(join(dir, "solution", "solve.py"), "v1")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("snapshot and restore", () => {
  test("round-trips a modified file", async () => {
    await snapshot(dir, ["solution"], join(snapshots, "0"))
    await writeFile(join(dir, "solution", "solve.py"), "v2")

    await restore(dir, ["solution"], join(snapshots, "0"))
    expect(await readFile(join(dir, "solution", "solve.py"), "utf-8")).toBe("v1")
  })

  test("removes files the candidate added", async () => {
    // Without this, a discarded candidate leaves its new files behind and the next
    // iteration silently starts from a state nobody chose.
    await snapshot(dir, ["solution"], join(snapshots, "0"))
    await writeFile(join(dir, "solution", "helper.py"), "extra")

    await restore(dir, ["solution"], join(snapshots, "0"))
    expect(existsSync(join(dir, "solution", "helper.py"))).toBe(false)
    expect(existsSync(join(dir, "solution", "solve.py"))).toBe(true)
  })

  test("restores files the candidate deleted", async () => {
    await snapshot(dir, ["solution"], join(snapshots, "0"))
    await rm(join(dir, "solution", "solve.py"))

    await restore(dir, ["solution"], join(snapshots, "0"))
    expect(await readFile(join(dir, "solution", "solve.py"), "utf-8")).toBe("v1")
  })

  test("handles nested directories", async () => {
    await mkdir(join(dir, "solution", "lib"), { recursive: true })
    await writeFile(join(dir, "solution", "lib", "util.py"), "util-v1")
    await snapshot(dir, ["solution"], join(snapshots, "0"))

    await writeFile(join(dir, "solution", "lib", "util.py"), "util-v2")
    await restore(dir, ["solution"], join(snapshots, "0"))

    expect(await readFile(join(dir, "solution", "lib", "util.py"), "utf-8")).toBe("util-v1")
  })

  test("skips a declared path that does not exist", async () => {
    const captured = await snapshot(dir, ["solution", "missing"], join(snapshots, "0"))
    expect(captured).toEqual(["solution"])
  })
})

describe("hashMutableTree and diffTrees", () => {
  test("detects a modified file", async () => {
    const before = await hashMutableTree(dir, ["solution"])
    await writeFile(join(dir, "solution", "solve.py"), "v2")
    const after = await hashMutableTree(dir, ["solution"])

    expect(diffTrees(before, after)).toEqual(["solution/solve.py"])
  })

  test("detects an added file", async () => {
    const before = await hashMutableTree(dir, ["solution"])
    await writeFile(join(dir, "solution", "new.py"), "new")
    const after = await hashMutableTree(dir, ["solution"])

    expect(diffTrees(before, after)).toEqual(["solution/new.py"])
  })

  test("detects a removed file", async () => {
    const before = await hashMutableTree(dir, ["solution"])
    await rm(join(dir, "solution", "solve.py"))
    const after = await hashMutableTree(dir, ["solution"])

    expect(diffTrees(before, after)).toEqual(["solution/solve.py"])
  })

  test("reports nothing when a file is rewritten with identical content", async () => {
    // A no-op edit is not a change. The loop uses this to catch agent turns that
    // claimed to do something and didn't.
    const before = await hashMutableTree(dir, ["solution"])
    await writeFile(join(dir, "solution", "solve.py"), "v1")
    const after = await hashMutableTree(dir, ["solution"])

    expect(diffTrees(before, after)).toHaveLength(0)
  })
})
