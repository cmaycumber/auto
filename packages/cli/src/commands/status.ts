/**
 * `auto status` — what has this mission actually found?
 *
 * Shows the archive summary, the champion, and recent attempts. The summary deliberately
 * reports crashes and gated candidates alongside keeps: "best score 0.94" reads very
 * differently next to "3 kept out of 200, 140 crashed", and only one of those two numbers
 * is usually shown by tools like this.
 */

import { resolve } from "node:path"
import { ContractError, champion, loadMission, readArchive, summarise } from "@auto/core"
import { color, dim, error, heading, info, table } from "../ui.ts"

export interface StatusOptions {
  dir: string
  limit: number
}

export async function statusCommand(options: StatusOptions): Promise<number> {
  const dir = resolve(options.dir)

  let loaded: Awaited<ReturnType<typeof loadMission>>
  try {
    loaded = await loadMission(dir)
  } catch (err) {
    error(err instanceof ContractError ? err.message : String(err))
    return 1
  }

  const { mission } = loaded
  const entries = await readArchive(loaded.paths.archive)

  heading(mission.title)

  if (entries.length === 0) {
    info(`  ${color.dim("No iterations yet. Run `auto run` to establish a baseline.")}`)
    return 0
  }

  const stats = summarise(entries, mission.evaluator.higherIsBetter)
  const best = champion(entries, mission.evaluator.higherIsBetter)
  const baseline = entries.find((entry) => entry.iteration === 0)

  table([
    ["iterations", String(stats.total)],
    ["kept", String(stats.kept)],
    ["discarded", String(stats.discarded)],
    ["gated", String(stats.gated)],
    ["crashed", stats.crashed > 0 ? color.yellow(String(stats.crashed)) : "0"],
    ["best", stats.bestScore === null ? "nothing kept" : String(stats.bestScore)],
  ])

  if (best && baseline?.score != null && best.score != null && best.iteration !== 0) {
    const delta = best.score - baseline.score
    const pct = baseline.score !== 0 ? (delta / Math.abs(baseline.score)) * 100 : 0
    info("")
    info(
      `  ${color.dim("vs baseline")}  ${baseline.score} → ${best.score} ` +
        `(${delta >= 0 ? "+" : ""}${delta.toFixed(6)}, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`,
    )
  }

  if (best && best.iteration !== 0) {
    heading("Champion")
    info(`  ${color.bold(`#${best.iteration}`)} ${best.description}`)
    dim(`  ${best.rationale}`)
  }

  heading(`Recent (${Math.min(options.limit, entries.length)} of ${entries.length})`)
  const recent = entries.slice(-options.limit).reverse()
  for (const entry of recent) {
    const mark =
      {
        keep: color.green("keep "),
        discard: color.dim("worse"),
        gated: color.yellow("gated"),
        crash: color.red("crash"),
      }[entry.verdict] ?? entry.verdict
    const score = entry.score === null ? "—" : String(entry.score)
    info(
      `  ${color.dim(`#${String(entry.iteration).padStart(3)}`)} ${mark} ${score.padEnd(10)} ${entry.description}`,
    )
  }

  // A run whose crashes dominate is usually a broken harness, not a hard problem — and
  // it is easy to miss when the champion line looks healthy.
  if (stats.crashed > stats.total / 2) {
    info("")
    info(
      color.yellow(
        `  ${stats.crashed} of ${stats.total} iterations crashed. That is usually a broken ` +
          "harness rather than a hard problem — check runs/*/evaluations/.",
      ),
    )
  }

  if (stats.kept > 0 && stats.total < 20) {
    info("")
    dim(
      `  Only ${stats.total} iterations so far. A couple of keeps out of a handful of ` +
        "tries is what noise looks like — not yet evidence of anything.",
    )
  }

  return 0
}
