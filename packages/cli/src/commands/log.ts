/**
 * `auto log` — print a run's decision log.
 *
 * The log is plain markdown on disk; this exists so you don't have to remember the run id
 * or the directory layout to read the most recent one.
 */

import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ContractError, loadMission, runPaths } from "@auto/core"
import { color, dim, error, info } from "../ui.ts"

export interface LogOptions {
  dir: string
  runId?: string
}

export async function logCommand(options: LogOptions): Promise<number> {
  const dir = resolve(options.dir)

  try {
    await loadMission(dir)
  } catch (err) {
    error(err instanceof ContractError ? err.message : String(err))
    return 1
  }

  const runsDir = join(dir, "runs")
  let runIds: string[]
  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    // Run ids lead with an ISO timestamp, so lexical sort is chronological.
    runIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    runIds = []
  }

  if (runIds.length === 0) {
    info(`  ${color.dim("No runs yet. Run `auto run` first.")}`)
    return 0
  }

  const runId = options.runId ?? (runIds[runIds.length - 1] as string)
  if (!runIds.includes(runId)) {
    error(`No run \`${runId}\`. Available: ${runIds.join(", ")}`)
    return 1
  }

  const logPath = runPaths(dir, runId).decisionLog
  try {
    info(await readFile(logPath, "utf-8"))
  } catch {
    error(`No decision log at ${logPath}`)
    return 1
  }

  if (runIds.length > 1 && !options.runId) {
    dim(`(showing the latest of ${runIds.length} runs — use --run <id> for another)`)
  }

  return 0
}
