import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArchiveEntry } from "../archive.ts"
import { diffFile, formatStat } from "../diff.ts"
import { capturePatch, lineage, summariseSteps } from "../steps.ts"

describe("diffFile", () => {
  test("returns null for identical content", () => {
    expect(diffFile("a.txt", "same\n", "same\n")).toBeNull()
  })

  test("produces a unified diff for a modification", () => {
    const result = diffFile("a.py", "x = 1\ny = 2\n", "x = 1\ny = 3\n")
    expect(result).not.toBeNull()
    expect(result?.patch).toContain("--- a/a.py")
    expect(result?.patch).toContain("+++ b/a.py")
    expect(result?.patch).toContain("-y = 2")
    expect(result?.patch).toContain("+y = 3")
    expect(result?.stat).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 })
  })

  test("keeps unchanged context lines", () => {
    const result = diffFile("a.py", "x = 1\ny = 2\n", "x = 1\ny = 3\n")
    expect(result?.patch).toContain(" x = 1")
  })

  test("renders an added file against /dev/null", () => {
    const result = diffFile("new.py", null, "hello\n")
    expect(result?.patch).toContain("--- /dev/null")
    expect(result?.stat.insertions).toBe(1)
    expect(result?.stat.deletions).toBe(0)
  })

  test("renders a deleted file against /dev/null", () => {
    const result = diffFile("gone.py", "hello\n", null)
    expect(result?.patch).toContain("+++ /dev/null")
    expect(result?.stat.deletions).toBe(1)
  })

  test("emits correct hunk headers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")
    const after = ["a", "b", "c", "d", "CHANGED", "f", "g", "h", "i", "j"].join("\n")
    const result = diffFile("x.txt", before, after)
    // Change at line 5, 3 lines of context either side -> starts at line 2.
    expect(result?.patch).toMatch(/@@ -2,\d+ \+2,\d+ @@/)
  })

  test("separates distant changes into multiple hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n")
    const after = before.replace("line1\n", "CHANGED1\n").replace("line35", "CHANGED35")
    const result = diffFile("x.txt", before, after)
    const hunkHeaders = (result?.patch.split("\n") ?? []).filter((line) => line.startsWith("@@"))
    expect(hunkHeaders).toHaveLength(2)
  })

  test("degrades gracefully on very large files instead of allocating a huge table", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n")
    const result = diffFile("big.txt", huge, `${huge}\nextra`)
    expect(result?.degraded).toBe(true)
    expect(result?.patch).toContain("too large for a line diff")
  })

  test("handles a file with no trailing newline", () => {
    const result = diffFile("a.txt", "one", "two")
    expect(result?.stat).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 })
  })
})

describe("formatStat", () => {
  test("renders singular and plural files", () => {
    expect(formatStat({ filesChanged: 1, insertions: 2, deletions: 3 })).toBe("1 file, +2 −3")
    expect(formatStat({ filesChanged: 2, insertions: 0, deletions: 0 })).toBe("2 files, +0 −0")
  })
})

describe("capturePatch", () => {
  let dir: string
  let before: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-steps-"))
    before = join(dir, ".before")
    await mkdir(join(dir, "solution"), { recursive: true })
    await mkdir(join(before, "solution"), { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("captures a modification across the mutable tree", async () => {
    await writeFile(join(before, "solution", "solve.py"), "return 1\n")
    await writeFile(join(dir, "solution", "solve.py"), "return 2\n")

    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: ["solution"],
      beforeDir: before,
    })

    expect(step.files).toEqual(["solution/solve.py"])
    expect(step.stat.filesChanged).toBe(1)
    expect(step.patch).toContain("-return 1")
    expect(step.patch).toContain("+return 2")
  })

  test("captures added and deleted files", async () => {
    await writeFile(join(before, "solution", "old.py"), "old\n")
    await writeFile(join(dir, "solution", "new.py"), "new\n")

    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: ["solution"],
      beforeDir: before,
    })

    expect(step.files.sort()).toEqual(["solution/new.py", "solution/old.py"])
    expect(step.stat.filesChanged).toBe(2)
  })

  test("returns an empty patch when nothing changed", async () => {
    await writeFile(join(before, "solution", "solve.py"), "same\n")
    await writeFile(join(dir, "solution", "solve.py"), "same\n")

    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: ["solution"],
      beforeDir: before,
    })

    expect(step.patch).toBe("")
    expect(step.stat.filesChanged).toBe(0)
  })

  test("treats everything as added when there is no before state", async () => {
    await writeFile(join(dir, "solution", "solve.py"), "hello\n")

    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: ["solution"],
      beforeDir: null,
    })

    expect(step.stat.insertions).toBe(1)
    expect(step.patch).toContain("--- /dev/null")
  })

  test("notes binary files instead of trying to diff them", async () => {
    await writeFile(join(dir, "solution", "model.bin"), Buffer.from([0, 1, 2, 0, 3]))

    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: ["solution"],
      beforeDir: before,
    })

    expect(step.patch).toContain("binary file added")
    expect(step.stat.filesChanged).toBe(1)
  })
})

// ---------------------------------------------------------------------------

function entry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    iteration: 0,
    runId: "run-1",
    parent: null,
    verdict: "keep",
    score: 0,
    pass: true,
    metrics: {},
    description: "",
    rationale: "",
    snapshot: null,
    durationMs: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("lineage", () => {
  test("returns the ancestry chain of the champion, oldest first", () => {
    // 0 -> 1 -> 3 is the surviving chain; 2 and 4 are dead ends off it.
    const entries = [
      entry({ iteration: 0, parent: null, score: 1 }),
      entry({ iteration: 1, parent: 0, score: 2 }),
      entry({ iteration: 2, parent: 0, score: 0.5, verdict: "discard" }),
      entry({ iteration: 3, parent: 1, score: 5 }),
      entry({ iteration: 4, parent: 1, score: 0.1, verdict: "discard" }),
    ]

    const chain = lineage(entries, true)
    expect(chain.map((s) => s.entry.iteration)).toEqual([0, 1, 3])
  })

  test("reports the score delta at each step", () => {
    const entries = [
      entry({ iteration: 0, parent: null, score: 1 }),
      entry({ iteration: 1, parent: 0, score: 2.5 }),
    ]

    const chain = lineage(entries, true)
    expect(chain[0]?.delta).toBeNull() // baseline has no predecessor
    expect(chain[1]?.delta).toBe(1.5)
  })

  test("is empty when nothing was kept", () => {
    expect(lineage([entry({ verdict: "crash", score: null })], true)).toEqual([])
  })

  test("respects lower-is-better when choosing the champion", () => {
    const entries = [
      entry({ iteration: 0, parent: null, score: 10 }),
      entry({ iteration: 1, parent: 0, score: 2 }),
    ]
    expect(lineage(entries, false).map((s) => s.entry.iteration)).toEqual([0, 1])
  })

  test("terminates on a corrupted archive with a parent cycle", () => {
    // Should be impossible — parents are always earlier iterations — but an infinite
    // loop in the command that explains a run is a bad failure mode to have.
    const entries = [
      entry({ iteration: 1, parent: 2, score: 5 }),
      entry({ iteration: 2, parent: 1, score: 3 }),
    ]
    const chain = lineage(entries, true)
    expect(chain.length).toBeLessThanOrEqual(2)
  })
})

describe("summariseSteps", () => {
  test("separates what survived from what was merely explored", () => {
    const entries = [
      entry({ iteration: 0, parent: null, score: 1 }),
      entry({ iteration: 1, parent: 0, score: 2 }),
      entry({ iteration: 2, parent: 0, score: 0, verdict: "discard" }),
      entry({ iteration: 3, parent: 0, verdict: "crash", score: null }),
    ]

    const summary = summariseSteps(entries, true)
    expect(summary.totalSteps).toBe(4)
    expect(summary.lineageSteps).toBe(2) // 0 -> 1
    expect(summary.exploredAndDropped).toBe(2)
  })
})
