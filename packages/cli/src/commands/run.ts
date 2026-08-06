/**
 * `auto run` — start the loop.
 *
 * Renders loop events as they arrive. The output is deliberately quiet per iteration:
 * one line for the change, one for the verdict. An operator watching an overnight run
 * wants to see the shape of progress, and a wall of agent transcript hides it. The full
 * transcripts are on disk under `runs/<id>/transcripts/` when a specific iteration
 * turns out to be worth reading.
 */

import { resolve } from "node:path"
import {
  ContractError,
  createDriver,
  createMockDriver,
  type LoopEvent,
  loadMission,
  runLoop,
  type StopReason,
} from "@auto/core"
import { color, dim, error, heading, info, success, table, warn } from "../ui.ts"

export interface RunOptions {
  dir: string
  driver?: string
  maxIterations?: number
  maxRuntimeSeconds?: number
  explorationRate?: number
}

export async function runCommand(options: RunOptions): Promise<number> {
  const dir = resolve(options.dir)

  let loaded: Awaited<ReturnType<typeof loadMission>>
  try {
    loaded = await loadMission(dir)
  } catch (err) {
    error(err instanceof ContractError ? err.message : String(err))
    return 1
  }

  const { mission } = loaded
  const controller = new AbortController()

  // Ctrl-C stops the loop cleanly at the next checkpoint rather than killing the process
  // mid-iteration, so the archive and decision log land in a consistent state. A second
  // Ctrl-C is treated as "I mean it" and exits immediately.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    controller.abort()
    info("")
    warn("Stopping after the current iteration. Press Ctrl-C again to force-quit.")
  }
  process.on("SIGINT", onSigint)

  const driver = options.driver
    ? options.driver === "mock"
      ? createMockDriver()
      : createDriver({ ...mission.driver, provider: options.driver as "claude" | "codex" })
    : createDriver(mission.driver)

  heading(mission.title)
  table([
    [
      "metric",
      `${mission.metric.name} (${mission.evaluator.higherIsBetter ? "higher" : "lower"} is better)`,
    ],
    ["driver", driver.name],
    ["evaluator", mission.evaluator.command],
    [
      "null control",
      mission.nullControl?.command ?? color.yellow("none — improvements are unguarded"),
    ],
    [
      "gates",
      mission.gates.length
        ? mission.gates.map((g) => `${g.metric} ${g.op} ${g.value}`).join(", ")
        : color.yellow("none"),
    ],
    [
      "budget",
      `${options.maxIterations ?? mission.budget.maxIterations} iterations / ${options.maxRuntimeSeconds ?? mission.budget.maxRuntimeSeconds}s`,
    ],
  ])
  info("")

  try {
    const result = await runLoop({
      loaded,
      driver,
      signal: controller.signal,
      onEvent: render(mission.metric.name),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.maxRuntimeSeconds !== undefined
        ? { maxRuntimeSeconds: options.maxRuntimeSeconds }
        : {}),
      ...(options.explorationRate !== undefined
        ? { explorationRate: options.explorationRate }
        : {}),
    })

    heading("Run finished")
    table([
      ["stopped", STOP_TEXT[result.reason]],
      [
        "iterations",
        `${result.stats.total} (${result.stats.kept} kept, ${result.stats.discarded} discarded, ${result.stats.gated} gated, ${result.stats.crashed} crashed)`,
      ],
      ["best", result.stats.bestScore === null ? "nothing kept" : String(result.stats.bestScore)],
      ["log", result.decisionLogPath],
    ])

    if (result.nullControlBreached) {
      info("")
      warn(
        "The null control scored close to the champion during this run. Whatever the " +
          "score says, this mission has not yet shown it can tell skill from noise — " +
          "fix the evaluator before trusting any of it.",
      )
    }

    return result.reason === "integrity_violation" || result.reason === "baseline_failed" ? 1 : 0
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    return 1
  } finally {
    process.off("SIGINT", onSigint)
  }
}

const STOP_TEXT: Record<StopReason, string> = {
  max_iterations: "iteration budget reached",
  max_runtime: "runtime budget reached",
  integrity_violation: color.red("INTEGRITY VIOLATION — a protected path changed"),
  baseline_failed: color.red("baseline evaluation failed"),
  cancelled: "cancelled",
  driver_unavailable: color.red("agent driver unavailable"),
}

const VERDICT_MARK: Record<string, string> = {
  keep: color.green("keep "),
  discard: color.dim("worse"),
  gated: color.yellow("gated"),
  crash: color.red("crash"),
}

function render(metricName: string): (event: LoopEvent) => void {
  return (event) => {
    switch (event.type) {
      case "run_started":
        dim(`run ${event.runId}`)
        break

      case "baseline_started":
        info(`${color.dim("baseline")}  measuring the scaffold as written…`)
        break

      case "baseline_done":
        success(
          `baseline ${metricName} = ${event.score ?? "n/a"}${event.pass ? "" : color.yellow(" (pass=false)")}`,
        )
        break

      case "iteration_started":
        info("")
        info(
          `${color.bold(`#${event.iteration}`)} ${color.dim(
            event.parent === null ? "from baseline" : `from #${event.parent}`,
          )}`,
        )
        break

      case "proposed":
        info(`  ${color.dim("→")} ${event.description}`)
        dim(`    touched: ${event.touched.join(", ")}`)
        break

      case "evaluating":
        break

      case "iteration_done": {
        const mark = VERDICT_MARK[event.entry.verdict] ?? event.entry.verdict
        const score = event.entry.score === null ? "—" : String(event.entry.score)
        info(`  ${mark} ${metricName}=${score}  ${color.dim(event.entry.rationale)}`)
        break
      }

      case "null_control":
        if (event.breached) {
          info("")
          warn(event.message)
        } else {
          dim(`  null control: ${event.message}`)
        }
        break

      case "warning":
        info("")
        warn(event.message)
        break

      case "run_finished":
        break
    }
  }
}
