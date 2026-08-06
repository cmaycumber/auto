/**
 * Steps: what each iteration actually changed, and which changes actually got you here.
 *
 * A one-line description is what an agent *says* it did. A patch is what it did. Keeping
 * both, per iteration, turns the archive from a list of scores into something you can
 * audit — "iteration 34 doubled the score" becomes a question you can answer by reading
 * fourteen lines of diff rather than by re-deriving it from a transcript.
 *
 * The second idea here matters more than the first. An archive of 200 attempts is mostly
 * noise; the interesting object is the **lineage** — the handful of steps that are actual
 * ancestors of the champion. Those are the ones that survived. Everything else is a
 * record of what didn't work, which is worth keeping and is not worth reading first.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ArchiveEntry } from "./archive.ts"
import { champion } from "./archive.ts"
import { addStat, type DiffStat, diffFile, emptyStat, type FileDiff } from "./diff.ts"
import { hashMutableTree } from "./workspace.ts"

export interface StepPatch {
  /** Concatenated unified diff across every changed file. Empty when nothing changed. */
  patch: string
  stat: DiffStat
  /** Mission-relative paths touched. */
  files: string[]
}

/** Null bytes in the first chunk is the usual heuristic, and it is good enough here. */
function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\u0000")
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

export interface CapturePatchOptions {
  missionDir: string
  mutablePaths: string[]
  /**
   * Directory holding the pre-change state — normally the parent's snapshot, which the
   * loop restores before proposing, so it is exactly what the agent started from.
   * Null compares against nothing, treating every file as added.
   */
  beforeDir: string | null
}

/**
 * Diff the mutable tree against its pre-change state.
 *
 * Reads content rather than trusting the agent's account, for the same reason the loop
 * hash-diffs rather than believing the self-report: the patch is evidence, and evidence
 * that came from the thing being audited is not evidence.
 */
export async function capturePatch(options: CapturePatchOptions): Promise<StepPatch> {
  const { missionDir, mutablePaths, beforeDir } = options

  const afterPaths = Object.keys(await hashMutableTree(missionDir, mutablePaths))
  const beforePaths = beforeDir ? Object.keys(await hashMutableTree(beforeDir, mutablePaths)) : []

  const allPaths = [...new Set([...beforePaths, ...afterPaths])].sort()

  const diffs: FileDiff[] = []
  let stat = emptyStat()

  for (const path of allPaths) {
    const before = beforeDir ? await readIfPresent(join(beforeDir, path)) : null
    const after = await readIfPresent(join(missionDir, path))

    if (before === null && after === null) continue

    if ((before !== null && looksBinary(before)) || (after !== null && looksBinary(after))) {
      const verb = before === null ? "added" : after === null ? "deleted" : "modified"
      diffs.push({
        path,
        patch: `--- a/${path}\n+++ b/${path}\n# binary file ${verb}`,
        stat: { filesChanged: 1, insertions: 0, deletions: 0 },
        degraded: true,
      })
      stat = addStat(stat, { filesChanged: 1, insertions: 0, deletions: 0 })
      continue
    }

    const fileDiff = diffFile(path, before, after)
    if (!fileDiff) continue

    diffs.push(fileDiff)
    stat = addStat(stat, fileDiff.stat)
  }

  return {
    patch: diffs.map((d) => d.patch).join("\n"),
    stat,
    files: diffs.map((d) => d.path),
  }
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface LineageStep {
  entry: ArchiveEntry
  /** Score change versus the previous step in the lineage. Null when either is missing. */
  delta: number | null
}

/**
 * The ancestry chain of the champion, oldest first.
 *
 * Walks `parent` pointers back from the best kept entry. This is the answer to "what
 * actually got us here", as distinct from "what did we try" — and the two are usually
 * very different sizes. A run with 4 kept steps out of 200 has a 4-step lineage, and
 * reading those 4 patches tells you the whole story.
 *
 * Defends against a cycle in the parent pointers. That should be impossible (parents are
 * always earlier iterations), but an infinite loop in the command that explains a run is
 * a bad failure mode for a corrupted archive to have.
 */
export function lineage(entries: ArchiveEntry[], higherIsBetter: boolean): LineageStep[] {
  const best = champion(entries, higherIsBetter)
  if (!best) return []

  const byIteration = new Map(entries.map((entry) => [entry.iteration, entry]))
  const chain: ArchiveEntry[] = []
  const seen = new Set<number>()

  let cursor: ArchiveEntry | undefined = best
  while (cursor && !seen.has(cursor.iteration)) {
    seen.add(cursor.iteration)
    chain.push(cursor)
    cursor = cursor.parent === null ? undefined : byIteration.get(cursor.parent)
  }

  chain.reverse()

  return chain.map((entry, index) => {
    const previous = index === 0 ? undefined : chain[index - 1]
    const delta =
      previous?.score != null && entry.score != null ? entry.score - previous.score : null
    return { entry, delta }
  })
}

export interface StepSummary {
  totalSteps: number
  lineageSteps: number
  /** Steps that were measured but are not ancestors of the champion. */
  exploredAndDropped: number
}

export function summariseSteps(entries: ArchiveEntry[], higherIsBetter: boolean): StepSummary {
  const chain = lineage(entries, higherIsBetter)
  return {
    totalSteps: entries.length,
    lineageSteps: chain.length,
    exploredAndDropped: entries.length - chain.length,
  }
}
