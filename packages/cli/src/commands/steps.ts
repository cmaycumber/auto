/**
 * `auto steps` — the step timeline, and the lineage inside it.
 *
 * Two views of the same archive, and the distinction is the point:
 *
 *   - **Timeline** (default): every step, in order, with its description and what it
 *     changed. This is the honest record — mostly failures, because that is what search
 *     mostly produces.
 *   - **Lineage** (`--lineage`): only the ancestors of the champion. A run with 200 steps
 *     and 4 keeps has a 4-step lineage, and those 4 patches are the entire story of how
 *     the score got where it is.
 *
 * Reading the timeline tells you how hard the problem was. Reading the lineage tells you
 * what the answer is. Tools that only show you the second one make the search look far
 * more purposeful than it was.
 */

import { resolve } from "node:path"
import {
  type ArchiveEntry,
  ContractError,
  formatStat,
  lineage,
  loadMission,
  readArchive,
  summariseSteps,
} from "@auto/core"
import { color, dim, error, heading, info } from "../ui.ts"

export interface StepsOptions {
  dir: string
  /** Show only the champion's ancestry. */
  lineageOnly: boolean
  limit: number
}

const VERDICT_MARK: Record<string, string> = {
  keep: color.green("✓ keep"),
  discard: color.dim("· worse"),
  gated: color.yellow("⛔ gated"),
  crash: color.red("✗ crash"),
}

export async function stepsCommand(options: StepsOptions): Promise<number> {
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

  if (entries.length === 0) {
    heading(mission.title)
    info(`  ${color.dim("No steps yet. Run `auto run` to establish a baseline.")}`)
    return 0
  }

  const higherIsBetter = mission.evaluator.higherIsBetter
  const summary = summariseSteps(entries, higherIsBetter)

  heading(mission.title)
  info(
    `  ${color.dim("metric")} ${mission.metric.name} · ` +
      `${summary.totalSteps} steps · ${color.green(`${summary.lineageSteps} in the champion's lineage`)} · ` +
      `${summary.exploredAndDropped} explored and dropped`,
  )

  if (options.lineageOnly) {
    const chain = lineage(entries, higherIsBetter)
    heading("Champion lineage")
    dim(`  The steps that actually produced the best score, oldest first.`)
    info("")

    for (const { entry, delta } of chain) {
      renderStep(entry, delta, mission.metric.name)
    }

    if (chain.length > 0) {
      info("")
      const path = chain.map((s) => `#${s.entry.iteration}`).join(" → ")
      info(`  ${color.dim("path")}  ${path}`)
    }
    return 0
  }

  heading(`Timeline (${Math.min(options.limit, entries.length)} of ${entries.length})`)
  dim("  Newest first. `--lineage` shows only what survived.")
  info("")

  const inLineage = new Set(lineage(entries, higherIsBetter).map((s) => s.entry.iteration))
  const recent = entries.slice(-options.limit).reverse()
  const byIteration = new Map(entries.map((e) => [e.iteration, e]))

  for (const entry of recent) {
    const parent = entry.parent === null ? undefined : byIteration.get(entry.parent)
    const delta = parent?.score != null && entry.score != null ? entry.score - parent.score : null
    renderStep(entry, delta, mission.metric.name, inLineage.has(entry.iteration))
  }

  info("")
  dim(`  auto diff <n>  — read the patch for a step`)

  return 0
}

/**
 * One step, in four lines at most.
 *
 * The description comes first because it is what you scan for; the score and the diffstat
 * are the evidence you check it against. A step whose description says "minor tuning"
 * next to `+180 −4` is worth opening.
 */
function renderStep(
  entry: ArchiveEntry,
  delta: number | null,
  metricName: string,
  showLineageMark = false,
): void {
  const mark = VERDICT_MARK[entry.verdict] ?? entry.verdict
  const score = entry.score === null ? "—" : String(entry.score)
  const deltaText =
    delta === null || delta === 0
      ? ""
      : color.dim(` (${delta > 0 ? "+" : ""}${Number(delta.toFixed(6))})`)
  const lineageMark = showLineageMark && entry.verdict === "keep" ? color.green(" ★") : ""

  info(
    `  ${color.bold(`#${String(entry.iteration).padStart(3)}`)} ${mark}  ` +
      `${metricName}=${score}${deltaText}${lineageMark}`,
  )
  info(`       ${entry.description}`)

  if (entry.diffStat && entry.diffStat.filesChanged > 0) {
    const files =
      entry.files && entry.files.length > 0
        ? entry.files.slice(0, 3).join(", ") +
          (entry.files.length > 3 ? ` +${entry.files.length - 3} more` : "")
        : ""
    dim(`       ${formatStat(entry.diffStat)}${files ? ` — ${files}` : ""}`)
  } else if (entry.verdict === "crash") {
    dim(`       ${entry.rationale}`)
  }

  info("")
}
