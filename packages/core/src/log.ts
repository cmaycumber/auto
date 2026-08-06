/**
 * The decision log: the human-readable companion to the archive.
 *
 * The archive is JSONL for machines. This is markdown for the person who comes back after
 * an overnight run and needs to know, in thirty seconds, whether anything real happened.
 * It is append-only for the same reason the archive is.
 *
 * Every entry answers: what was tried, what the number did, what the loop decided, and
 * why. If a log entry cannot answer "why", the loop has a bug.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { ArchiveEntry } from "./archive.ts"
import type { AutoMission } from "./contracts.ts"

export interface LogHeaderOptions {
  mission: AutoMission
  runId: string
  driverName: string
  startedAt: Date
}

export async function writeHeader(logPath: string, options: LogHeaderOptions): Promise<void> {
  const { mission, runId, driverName, startedAt } = options
  const direction = mission.evaluator.higherIsBetter ? "maximise" : "minimise"

  const lines = [
    `# ${mission.title}`,
    "",
    `**Run** \`${runId}\` · **Driver** \`${driverName}\` · **Started** ${startedAt.toISOString()}`,
    "",
    `**Goal** — ${direction} \`${mission.metric.name}\`: ${mission.metric.description}`,
    "",
    `**Evaluator** — \`${mission.evaluator.command}\``,
    "",
    mission.nullControl
      ? `**Null control** — \`${mission.nullControl.command}\` every ${mission.nullControl.everyNIterations} iterations`
      : "**Null control** — none configured. Improvements in this run are unverified against a signal-free baseline.",
    "",
    mission.gates.length > 0
      ? `**Hard gates** — ${mission.gates.map((g) => `\`${g.metric} ${g.op} ${g.value}\``).join(", ")}`
      : "**Hard gates** — none configured.",
    "",
    `**Budget** — ${mission.budget.maxIterations} iterations / ${mission.budget.maxRuntimeSeconds}s`,
    "",
    "---",
    "",
  ]

  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, lines.join("\n"), "utf-8")
}

const VERDICT_BADGE: Record<string, string> = {
  keep: "✅ KEEP",
  discard: "· discard",
  gated: "⛔ GATED",
  crash: "💥 CRASH",
}

export async function appendIteration(
  logPath: string,
  entry: ArchiveEntry,
  metricName: string,
): Promise<void> {
  const badge = VERDICT_BADGE[entry.verdict] ?? entry.verdict
  const score = entry.score === null ? "n/a" : String(entry.score)
  const parent = entry.parent === null ? "baseline" : `from #${entry.parent}`

  const lines = [
    `## Iteration ${entry.iteration} — ${badge}`,
    "",
    `*${parent} · ${metricName} = ${score} · ${(entry.durationMs / 1000).toFixed(1)}s*`,
    "",
    `**Change:** ${entry.description}`,
    "",
    `**Decision:** ${entry.rationale}`,
    "",
  ]

  // The diffstat goes next to the description so the log answers "did the change match
  // the claim?" without opening the patch. A step described as "small tuning" sitting
  // next to +200 −4 is the interesting case.
  if (entry.diffStat && entry.diffStat.filesChanged > 0) {
    const files = entry.files?.length ? ` (${entry.files.join(", ")})` : ""
    lines.push(
      `**Changed:** ${entry.diffStat.filesChanged} file` +
        `${entry.diffStat.filesChanged === 1 ? "" : "s"}, ` +
        `+${entry.diffStat.insertions} −${entry.diffStat.deletions}${files}`,
      "",
    )
  }

  if (entry.metrics && Object.keys(entry.metrics).length > 0) {
    const rendered = Object.entries(entry.metrics)
      .map(([key, value]) => `\`${key}=${value}\``)
      .join(" · ")
    lines.push(`**Metrics:** ${rendered}`, "")
  }

  // Trailing blank line, not just a newline: the next block appended may be a heading or
  // a blockquote, and without a blank line between them markdown treats the quote as a
  // lazy continuation of this paragraph and renders it inline.
  await appendFile(logPath, `${lines.join("\n")}\n`, "utf-8")
}

/** A standalone note — null-control results, integrity halts, budget exhaustion. */
export async function appendNote(logPath: string, title: string, body: string): Promise<void> {
  await appendFile(logPath, `> **${title}** — ${body}\n\n`, "utf-8")
}

export interface SummaryOptions {
  metricName: string
  iterations: number
  kept: number
  bestScore: number | null
  stopReason: string
  elapsedSeconds: number
  nullControlBreached: boolean
  /** Present when the mission declares a generalisation-gap metric. */
  gapTrend?: { suspicious: boolean; message: string } | undefined
}

/**
 * The closing summary.
 *
 * Deliberately refuses to congratulate. If the null control was breached, or nothing was
 * kept, or the run was too short to mean anything, the summary says so — the moment a
 * research log starts reading like a press release is the moment it stops being useful.
 */
export async function appendSummary(logPath: string, options: SummaryOptions): Promise<void> {
  const lines = [
    "---",
    "",
    "## Run summary",
    "",
    `- **Stopped because:** ${options.stopReason}`,
    `- **Iterations:** ${options.iterations} (${options.kept} kept)`,
    `- **Best ${options.metricName}:** ${options.bestScore ?? "none — nothing was kept"}`,
    `- **Elapsed:** ${options.elapsedSeconds.toFixed(0)}s`,
    "",
  ]

  if (options.gapTrend) {
    lines.push(`- **Generalisation gap:** ${options.gapTrend.message}`, "")
  }

  const caveats: string[] = []
  if (options.gapTrend?.suspicious) {
    // Listed first: a widening gap invalidates the headline number more directly than
    // anything else here, and it is the one an operator is least likely to look for.
    caveats.push(options.gapTrend.message)
  }
  if (options.nullControlBreached) {
    caveats.push(
      "The null control scored close to the champion. Until that is explained, treat " +
        "every improvement in this run as an artifact of the measurement, not a result.",
    )
  }
  if (options.kept === 0) {
    caveats.push("Nothing was kept. The loop found no improvement over the baseline.")
  }
  if (options.iterations < 10 && options.kept > 0) {
    caveats.push(
      `Only ${options.iterations} iterations ran. A handful of keeps over a handful of ` +
        "attempts is well within what noise produces; this is not yet evidence.",
    )
  }

  if (caveats.length > 0) {
    lines.push("### Read this before believing the number above", "")
    lines.push(...caveats.map((c) => `- ${c}`))
    lines.push("")
  }

  await appendFile(logPath, lines.join("\n"), "utf-8")
}
