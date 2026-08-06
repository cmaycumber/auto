/**
 * The archive: append-only record of every candidate the loop has measured.
 *
 * Append-only is load-bearing. The archive is what makes a result checkable later, and a
 * loop that can rewrite its own history can quietly delete the runs that contradict its
 * conclusion. Discards and crashes are kept for the same reason: "we tried 40 things and
 * one worked" is a very different claim from "the thing we tried worked", and only the
 * archive can tell them apart.
 *
 * It also underwrites parent selection. Branching only from the current best collapses
 * the search into a greedy walk; keeping every entry lets the selector go sideways.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Verdict } from "./gates.ts"

export interface ArchiveEntry {
  /** Monotonic within a run; the loop's iteration counter. */
  iteration: number
  runId: string
  /** Iteration this candidate was branched from; null for the baseline. */
  parent: number | null
  verdict: Verdict
  score: number | null
  pass: boolean | null
  metrics: Record<string, number>
  /** One-line summary of the change, written by the agent that proposed it. */
  description: string
  /** Why the loop reached this verdict. */
  rationale: string
  /** Relative path of the snapshot dir holding this candidate's mutable files. */
  snapshot: string | null
  durationMs: number
  createdAt: string

  // --- Step record -------------------------------------------------------
  // Optional so archives written before step capture existed still parse. The patch is
  // what the iteration actually changed, as opposed to what the agent said it changed.

  /** Relative path to the unified diff for this step. */
  patch?: string | null
  /** Files touched, and the size of the change. */
  diffStat?: { filesChanged: number; insertions: number; deletions: number } | null
  files?: string[]
}

export async function appendEntry(archivePath: string, entry: ArchiveEntry): Promise<void> {
  await mkdir(dirname(archivePath), { recursive: true })
  await appendFile(archivePath, `${JSON.stringify(entry)}\n`, "utf-8")
}

/**
 * Read the archive.
 *
 * Skips unparseable lines rather than throwing. A JSONL file being appended to by a
 * process that was killed mid-write can end in a partial line, and refusing to read the
 * other 200 good entries because of it would be the wrong trade.
 */
export async function readArchive(archivePath: string): Promise<ArchiveEntry[]> {
  let raw: string
  try {
    raw = await readFile(archivePath, "utf-8")
  } catch {
    return []
  }

  const entries: ArchiveEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ArchiveEntry)
    } catch {
      // partial trailing write — ignore
    }
  }
  return entries
}

/** The best kept entry under the mission's direction, or undefined if none kept yet. */
export function champion(
  entries: ArchiveEntry[],
  higherIsBetter: boolean,
): ArchiveEntry | undefined {
  const kept = entries.filter((e) => e.verdict === "keep" && e.score !== null)
  if (kept.length === 0) return undefined

  return kept.reduce((best, entry) => {
    const a = entry.score as number
    const b = best.score as number
    return (higherIsBetter ? a > b : a < b) ? entry : best
  })
}

export interface SelectParentOptions {
  entries: ArchiveEntry[]
  higherIsBetter: boolean
  /**
   * Probability of branching from a non-champion kept entry instead of the champion.
   * Pure exploitation converges on a local optimum and stops finding anything; this is
   * the cheapest available antidote.
   */
  explorationRate: number
  /** Injected for deterministic tests. */
  random?: () => number
}

/**
 * Choose which archive entry the next candidate branches from.
 *
 * Champion by default, with `explorationRate` chance of a weighted-random pick among the
 * other kept entries. Weighting favours recency, on the theory that a recent near-miss is
 * a more promising base than one from 200 iterations ago whose context is gone.
 */
export function selectParent(options: SelectParentOptions): ArchiveEntry | undefined {
  const { entries, higherIsBetter, explorationRate } = options
  const random = options.random ?? Math.random

  const kept = entries.filter((e) => e.verdict === "keep")
  if (kept.length === 0) return undefined

  const best = champion(entries, higherIsBetter)
  const alternatives = kept.filter((e) => e.iteration !== best?.iteration)

  if (alternatives.length === 0 || random() >= explorationRate) return best

  // Recency-weighted: weight i+1 for the i-th oldest alternative.
  const weights = alternatives.map((_, i) => i + 1)
  const total = weights.reduce((sum, w) => sum + w, 0)
  let threshold = random() * total
  for (let i = 0; i < alternatives.length; i++) {
    threshold -= weights[i] as number
    if (threshold <= 0) return alternatives[i]
  }
  return alternatives[alternatives.length - 1]
}

export interface ArchiveStats {
  total: number
  kept: number
  discarded: number
  gated: number
  crashed: number
  bestScore: number | null
}

export function summarise(entries: ArchiveEntry[], higherIsBetter: boolean): ArchiveStats {
  const best = champion(entries, higherIsBetter)
  return {
    total: entries.length,
    kept: entries.filter((e) => e.verdict === "keep").length,
    discarded: entries.filter((e) => e.verdict === "discard").length,
    gated: entries.filter((e) => e.verdict === "gated").length,
    crashed: entries.filter((e) => e.verdict === "crash").length,
    bestScore: best?.score ?? null,
  }
}
