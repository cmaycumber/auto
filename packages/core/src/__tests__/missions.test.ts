/**
 * The shipped example missions are part of the product, and until this file existed
 * nothing checked them.
 *
 * A syntax error reached the published repo in `analysis/paired_test.py` because the
 * TypeScript test suite has no opinion about Python and a clean-clone check is manual.
 * These tests are the cheap, automatic version of that check.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { loadMission } from "../mission.ts"

const MISSIONS_DIR = join(import.meta.dir, "../../../..", "missions")

function missionDirs(): string[] {
  return readdirSync(MISSIONS_DIR).filter((name) => {
    try {
      return statSync(join(MISSIONS_DIR, name)).isDirectory()
    } catch {
      return false
    }
  })
}

function pythonFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "runs") continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) pythonFiles(full, out)
    else if (entry.name.endsWith(".py")) out.push(full)
  }
  return out
}

const dirs = missionDirs()

describe("shipped example missions", () => {
  test("there are missions to check", () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  for (const name of dirs) {
    const dir = join(MISSIONS_DIR, name)

    test(`${name}: auto.json parses and satisfies the contract`, async () => {
      const loaded = await loadMission(dir)
      expect(loaded.mission.slug).toBeTruthy()
      expect(loaded.brief.length).toBeGreaterThan(0)
    })

    test(`${name}: every shipped Python file compiles`, async () => {
      const files = pythonFiles(dir)
      expect(files.length).toBeGreaterThan(0)

      const proc = Bun.spawn(["python3", "-m", "py_compile", ...files], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      expect(stderr.trim()).toBe("")
      expect(code).toBe(0)
    })

    test(`${name}: declares a holdout that its protected paths cover`, async () => {
      // The mistake this catches is declaring held-out data and forgetting to protect it,
      // which leaves the thing you are scored on readable and rewritable.
      const { mission } = await loadMission(dir)
      for (const hidden of mission.holdout.hiddenPaths) {
        const covered = mission.protectedPaths.some((p) => {
          const segs = (x: string) => x.split("/").filter(Boolean)
          const h = segs(hidden)
          const q = segs(p)
          return q.length > 0 && h.length >= q.length && q.every((s, i) => h[i] === s)
        })
        expect(covered).toBe(true)
      }
    })
  }
})
