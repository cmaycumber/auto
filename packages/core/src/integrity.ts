/**
 * Integrity: proving the measurement did not change underneath the results.
 *
 * `auto` hashes every protected path before the loop starts and re-checks between
 * iterations. If a hash moves, the run halts. Not warns — halts. Every number produced
 * after a tampered evaluator is unfalsifiable, and a loop that keeps going while
 * printing a warning nobody reads is worse than one that stops.
 *
 * The failure mode this exists for is not malice. It is an agent that hits a stubborn
 * bug, decides the evaluator is wrong, "fixes" it, and reports a breakthrough.
 */

import { readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { pathsOverlap } from "./contracts.ts"

export interface IntegrityManifest {
  /** Mission-relative path -> sha256 of file contents. Sorted for stable diffs. */
  files: Record<string, string>
  createdAt: string
}

export interface IntegrityViolation {
  path: string
  kind: "modified" | "deleted" | "added"
}

async function hashFile(absolutePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(absolutePath).arrayBuffer())
  return hasher.digest("hex")
}

/** Recursively collect file paths under a root, skipping noise directories. */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", ".pytest_cache"])

async function collectFiles(root: string, absolutePath: string, out: string[]): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolutePath)
  } catch {
    return // declared-but-absent paths are reported by verifyManifest, not here
  }

  if (info.isFile()) {
    out.push(relative(root, absolutePath).split(sep).join("/"))
    return
  }
  if (!info.isDirectory()) return

  const entries = await readdir(absolutePath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    await collectFiles(root, join(absolutePath, entry.name), out)
  }
}

/**
 * Build a manifest covering every protected path.
 *
 * Paths may be files or directories; directories are walked recursively. A protected
 * path that does not exist is not an error at build time — the mission may declare a
 * holdout file generated on first run — but it will be flagged as `added` if it appears
 * later, which is exactly the signal we want.
 */
export async function buildManifest(
  missionDir: string,
  protectedPaths: string[],
): Promise<IntegrityManifest> {
  const collected: string[] = []
  for (const path of protectedPaths) {
    await collectFiles(missionDir, join(missionDir, path), collected)
  }

  const files: Record<string, string> = {}
  for (const relPath of collected.sort()) {
    files[relPath] = await hashFile(join(missionDir, relPath))
  }

  return { files, createdAt: new Date().toISOString() }
}

/**
 * Re-hash the protected tree and diff it against the manifest.
 *
 * Reports additions as violations too. An agent that cannot edit `harness/evaluate.py`
 * may try to shadow it — dropping a `harness/evaluate.pyc`, a `conftest.py`, a
 * `sitecustomize.py` — so "a new file appeared inside the protected tree" is treated
 * as tampering rather than housekeeping.
 */
export async function verifyManifest(
  missionDir: string,
  protectedPaths: string[],
  manifest: IntegrityManifest,
): Promise<IntegrityViolation[]> {
  const current = await buildManifest(missionDir, protectedPaths)
  const violations: IntegrityViolation[] = []

  for (const [path, hash] of Object.entries(manifest.files)) {
    const now = current.files[path]
    if (now === undefined) violations.push({ path, kind: "deleted" })
    else if (now !== hash) violations.push({ path, kind: "modified" })
  }
  for (const path of Object.keys(current.files)) {
    if (manifest.files[path] === undefined) violations.push({ path, kind: "added" })
  }

  return violations.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Check whether a set of touched paths stayed inside the mutable region.
 *
 * Complements the hash check: integrity catches edits after the fact, this catches them
 * at proposal time, when a clear "you may not edit that" is still actionable feedback
 * for the agent rather than a dead run.
 */
export function findOutOfBoundsEdits(touchedPaths: string[], mutablePaths: string[]): string[] {
  return touchedPaths.filter(
    (touched) => !mutablePaths.some((allowed) => isInside(touched, allowed)),
  )
}

/** True when `child` is `parent` or sits beneath it. Segment-aware, so `a/bc` ⊄ `a/b`. */
function isInside(child: string, parent: string): boolean {
  const segs = (p: string) => p.split("/").filter((s) => s !== "" && s !== ".")
  const c = segs(child)
  const p = segs(parent)
  if (p.length === 0) return true
  if (c.length < p.length) return false
  return p.every((seg, i) => c[i] === seg)
}

/**
 * Sanity-check a mission's own path declarations before a run starts.
 *
 * Catches the case where a hidden holdout path is not actually protected — a mission can
 * declare `holdout.hiddenPaths` while forgetting to list them in `protectedPaths`, which
 * leaves the out-of-sample data readable and editable. Cheap to check, expensive to miss.
 */
export function auditPathDeclarations(mission: {
  protectedPaths: string[]
  mutablePaths: string[]
  holdout: { hiddenPaths: string[] }
}): string[] {
  const problems: string[] = []

  for (const hidden of mission.holdout.hiddenPaths) {
    const covered = mission.protectedPaths.some((p) => isInside(hidden, p))
    if (!covered) {
      problems.push(
        `holdout.hiddenPaths includes \`${hidden}\` but no protectedPaths entry covers it. ` +
          "Held-out data that isn't protected can be read or rewritten by the agent.",
      )
    }
    const editable = mission.mutablePaths.some((m) => pathsOverlap(hidden, m))
    if (editable) {
      problems.push(`holdout.hiddenPaths \`${hidden}\` overlaps a mutable path.`)
    }
  }

  return problems
}
