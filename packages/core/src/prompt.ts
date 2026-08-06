/**
 * Assembling the proposal prompt.
 *
 * The agent gets three things: what it is optimising, what has already been tried, and
 * what it is forbidden to touch. The third matters most. An agent that does not know the
 * evaluator is off-limits will eventually "fix" it — not out of malice, but because a
 * stubborn measurement genuinely does look like a bug from the inside.
 *
 * The tried-already section carries discards as well as keeps. Without them the loop
 * re-proposes the same failed idea every few iterations, which is the single most common
 * way these things waste an overnight run.
 */

import type { ArchiveEntry } from "./archive.ts"
import type { AutoMission } from "./contracts.ts"
import { DESCRIPTION_MARKER } from "./drivers/types.ts"

export interface BuildPromptOptions {
  mission: AutoMission
  /** Full mission brief (mission.md), included verbatim. */
  missionBrief: string
  archive: ArchiveEntry[]
  parent: ArchiveEntry | undefined
  iteration: number
  /** Accumulated lessons, if the mission keeps a memory file. */
  memory?: string
  /** Cap on how many prior attempts to include. */
  historyLimit?: number
}

export function buildProposalPrompt(options: BuildPromptOptions): string {
  const { mission, missionBrief, archive, parent, iteration } = options
  const historyLimit = options.historyLimit ?? 25
  const direction = mission.evaluator.higherIsBetter ? "MAXIMISE" : "MINIMISE"

  const sections: string[] = []

  sections.push(
    `You are iteration ${iteration} of an autoresearch loop on the mission "${mission.title}".`,
    "",
    `Your goal: ${direction} \`${mission.metric.name}\` — ${mission.metric.description}`,
    "",
    "Make ONE focused change that you believe will improve that number, then stop.",
    "Do not make several unrelated changes at once: if the score moves, the loop needs to",
    "know which change moved it.",
  )

  sections.push("", "## Mission brief", "", missionBrief.trim())

  sections.push(
    "",
    "## What you may edit",
    "",
    ...mission.mutablePaths.map((p) => `- \`${p}\``),
    "",
    "## What you may NOT touch, under any circumstances",
    "",
    ...mission.protectedPaths.map((p) => `- \`${p}\``),
    "",
    "These paths are hashed before and after your turn. If you modify one, the run halts",
    "and your change is thrown away. This includes the evaluator, the gates, and any",
    "held-out data.",
    "",
    "If the evaluator looks wrong to you, say so in your final message and change nothing.",
    "Do not work around it, do not add a file that shadows it, and do not adjust the",
    "measurement so your idea passes. Wanting to edit the evaluator is the strongest",
    "available signal that you are about to fool yourself.",
  )

  if (mission.holdout.hiddenPaths.length > 0) {
    sections.push(
      "",
      "## Held out from you",
      "",
      mission.holdout.description,
      "",
      ...mission.holdout.hiddenPaths.map((p) => `- \`${p}\` — do not read this`),
      "",
      "Fitting to data you were not supposed to see produces a number that will not",
      "survive contact with anything real.",
    )
  }

  if (mission.gates.length > 0) {
    sections.push(
      "",
      "## Hard constraints",
      "",
      "A candidate breaching any of these is discarded regardless of its score:",
      "",
      ...mission.gates.map((g) => `- \`${g.metric}\` ${symbolFor(g.op)} ${g.value} — ${g.reason}`),
    )
  }

  if (parent) {
    sections.push(
      "",
      "## Your starting point",
      "",
      `You are branching from iteration ${parent.iteration}, currently the best available:`,
      `- ${mission.metric.name}: ${formatScore(parent.score)}`,
      `- What it did: ${parent.description}`,
    )
  } else {
    sections.push(
      "",
      "## Your starting point",
      "",
      "Nothing has been kept yet — you are establishing the baseline. Prefer the simplest",
      "thing that runs end-to-end over the cleverest thing that might not.",
    )
  }

  const history = formatHistory(archive, historyLimit, mission.metric.name)
  if (history) sections.push("", "## Already tried", "", history)

  if (options.memory?.trim()) {
    sections.push("", "## Lessons from earlier iterations", "", options.memory.trim())
  }

  sections.push(
    "",
    "## When you are done",
    "",
    "End your final message with a single line:",
    "",
    `${DESCRIPTION_MARKER} <one sentence describing exactly what you changed>`,
    "",
    "Be specific. `tuned parameters` is useless three hundred iterations from now;",
    "`raised first-fit bin threshold from 0.85 to 0.92` is what makes the archive readable.",
  )

  return sections.join("\n")
}

function symbolFor(op: string): string {
  return { lte: "<=", gte: ">=", lt: "<", gt: ">" }[op] ?? op
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : String(score)
}

/**
 * Render prior attempts most-recent-first, keeps and failures alike.
 *
 * Failures are annotated with why they failed, because "tried X, gated on drawdown" and
 * "tried X, scored worse" should lead the agent to different next moves.
 */
function formatHistory(archive: ArchiveEntry[], limit: number, metricName: string): string {
  if (archive.length === 0) return ""

  const recent = archive.slice(-limit).reverse()
  const lines = recent.map((entry) => {
    const marker = {
      keep: "KEPT",
      discard: "worse",
      gated: "GATED",
      crash: "crashed",
    }[entry.verdict]
    const score = entry.score === null ? "—" : `${metricName}=${entry.score}`
    return `- [${entry.iteration}] ${marker} (${score}): ${entry.description}\n  → ${entry.rationale}`
  })

  const omitted = archive.length - recent.length
  if (omitted > 0) {
    lines.push(`- (${omitted} earlier attempt${omitted === 1 ? "" : "s"} omitted)`)
  }

  return lines.join("\n")
}
