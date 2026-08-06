/**
 * `auto doctor` — check a mission before spending a night on it.
 *
 * Runs the evaluator and, if configured, the null control, then reports whether the
 * mission can actually distinguish a good solution from a signal-free one. This is the
 * cheapest possible version of the question that matters, and running it costs a few
 * seconds against a run that costs hours.
 *
 * The headline check is not "does the evaluator work". It is "does the baseline beat the
 * null control". A mission that fails that is not ready, however clean everything else is.
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  auditPathDeclarations,
  buildManifest,
  ContractError,
  checkNullControl,
  createDriver,
  loadMission,
  runEvaluator,
} from "@auto/core"
import { color, error, heading, info, success, table, warn, wrap } from "../ui.ts"

export interface DoctorOptions {
  dir: string
  /** Skip actually running the evaluator. Useful when it is expensive. */
  skipRun: boolean
}

export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const dir = resolve(options.dir)
  let problems = 0
  let warnings = 0

  let loaded: Awaited<ReturnType<typeof loadMission>>
  try {
    loaded = await loadMission(dir)
  } catch (err) {
    error(err instanceof ContractError ? err.message : String(err))
    return 1
  }

  const { mission } = loaded
  heading(mission.title)
  table([
    ["slug", mission.slug],
    ["domain", mission.domain],
    [
      "metric",
      `${mission.metric.name} (${mission.evaluator.higherIsBetter ? "higher" : "lower"} better)`,
    ],
    ["keep policy", mission.evaluator.keepPolicy],
  ])

  // ---- Paths ------------------------------------------------------------
  heading("Paths")

  for (const path of [...mission.protectedPaths, ...mission.mutablePaths]) {
    if (existsSync(join(dir, path))) {
      success(`${path}`)
    } else {
      warn(`${path} — declared but does not exist`)
      warnings += 1
    }
  }

  const pathProblems = auditPathDeclarations(mission)
  for (const problem of pathProblems) {
    error(problem)
    problems += 1
  }

  const manifest = await buildManifest(dir, mission.protectedPaths)
  const fileCount = Object.keys(manifest.files).length
  if (fileCount === 0) {
    error(
      "No files found under protectedPaths. Nothing is being guarded, so the agent " +
        "could rewrite the evaluator without the run noticing.",
    )
    problems += 1
  } else {
    success(`${fileCount} file${fileCount === 1 ? "" : "s"} under integrity protection`)
  }

  // ---- Safeguards -------------------------------------------------------
  heading("Safeguards")

  if (mission.gates.length === 0) {
    warn(
      "No hard gates. If any constraint must hold regardless of score — cost, latency, " +
        "safety, feasibility — an optimiser will trade it away the moment doing so helps.",
    )
    warnings += 1
  } else {
    for (const gate of mission.gates) {
      success(`${gate.metric} ${gate.op} ${gate.value} — ${gate.reason}`)
    }
  }

  if (mission.holdout.enforcedBy === "manual") {
    warn(
      "The holdout is enforced by convention only. Nothing stops the agent reading it, " +
        "and a score produced that way looks excellent and means nothing.",
    )
    warnings += 1
  } else {
    success(`Holdout enforced by ${mission.holdout.enforcedBy}`)
  }

  if (!mission.nullControl) {
    warn(
      "No null control configured. Nothing in this mission can distinguish a real " +
        "improvement from a metric that rewards noise.",
    )
    warnings += 1
  }

  if (
    mission.evaluator.keepPolicy === "score_improvement" &&
    mission.evaluator.minimumEffect === undefined
  ) {
    warn(
      "No `evaluator.minimumEffect`. Any improvement will be kept, however small — " +
        "including one smaller than the evaluator's own noise.",
    )
    info(
      color.dim(
        wrap(
          "Set it only if this evaluator's noise is irreducible (wall-clock timing, a " +
            "physical measurement). If your increments are simply smaller than the " +
            "evaluator can resolve, a bar rejects real work along with the noise — in " +
            "this repo's search-strategy mission a noise-floor bar would have discarded " +
            "all five keeps of a result real at p<1e-6. The better fixes there are more " +
            "samples (noise falls as 1/sqrt(n)) and re-scoring the final champion on a " +
            "split no iteration touched.",
          76,
          "    ",
        ),
      ),
    )
    warnings += 1
  } else if (mission.evaluator.minimumEffect !== undefined) {
    success(`Minimum effect ${mission.evaluator.minimumEffect} — smaller gains are not kept`)
  }

  // ---- Driver -----------------------------------------------------------
  heading("Driver")
  const driver = createDriver(mission.driver)
  if (await driver.isAvailable()) {
    success(`${driver.name} is available`)
  } else {
    error(
      `${driver.name} is not available. Install and authenticate the CLI, or change ` +
        "`driver.provider` in auto.json.",
    )
    problems += 1
  }

  // ---- Live checks ------------------------------------------------------
  if (!options.skipRun) {
    heading("Measurement")

    info(color.dim(`  running: ${mission.evaluator.command}`))
    const evaluation = await runEvaluator({
      command: mission.evaluator.command,
      cwd: dir,
      timeoutSeconds: mission.evaluator.timeoutSeconds,
    })

    if (evaluation.outcome !== "ok" || !evaluation.result) {
      error(`Evaluator failed (${evaluation.outcome}): ${evaluation.error}`)
      if (evaluation.stderr.trim()) {
        info(color.dim(wrap(evaluation.stderr.trim().split("\n").slice(-5).join(" "), 76, "    ")))
      }
      problems += 1
    } else {
      const result = evaluation.result
      success(
        `Evaluator ran in ${(evaluation.durationMs / 1000).toFixed(1)}s — ` +
          `${mission.metric.name}=${result.score ?? "n/a"}, pass=${result.pass}`,
      )

      // Gate metrics must actually be reported, or the gate silently never fires.
      for (const gate of mission.gates) {
        if (result.metrics?.[gate.metric] === undefined) {
          error(
            `Gate \`${gate.metric}\` is not reported by the evaluator. This gate will ` +
              "treat every candidate as a breach until the evaluator emits it.",
          )
          problems += 1
        }
      }

      if (result.score === undefined && mission.evaluator.keepPolicy === "score_improvement") {
        error(
          "Keep policy is `score_improvement` but the evaluator reports no `score`. " +
            "Every iteration would be recorded as a crash.",
        )
        problems += 1
      }

      // ---- The check that matters ---------------------------------------
      if (mission.nullControl && result.score !== undefined) {
        info(color.dim(`  running: ${mission.nullControl.command}`))
        const nullRun = await runEvaluator({
          command: mission.nullControl.command,
          cwd: dir,
          timeoutSeconds: mission.evaluator.timeoutSeconds,
        })

        if (nullRun.outcome !== "ok" || nullRun.result?.score === undefined) {
          error(
            `Null control did not produce a score (${nullRun.outcome}: ` +
              `${nullRun.error ?? "no score field"}). Your safety net has a hole in it.`,
          )
          problems += 1
        } else {
          const nullScore = nullRun.result.score

          // Use the same margin test the loop uses, not a bare sign comparison. A
          // baseline that beats noise by 0.5% has not demonstrated anything, and
          // reporting that as a pass would make doctor weaker than the thing it is
          // meant to pre-flight.
          // Doctor always measures the untouched scaffold, so a narrow gap here means
          // "the starting solution has no edge" rather than "the metric is broken".
          const check = checkNullControl(
            result.score,
            nullScore,
            mission.nullControl.alarmWithinFraction,
            mission.evaluator.higherIsBetter,
            "baseline",
          )

          if (!check.breached) {
            success(
              `Baseline (${result.score}) clears the null control (${nullScore}) by more ` +
                `than ${mission.nullControl.alarmWithinFraction * 100}%. The metric can ` +
                "tell signal from noise.",
            )
          } else {
            warn(
              `The baseline (${result.score}) does not clearly beat the null control ` +
                `(${nullScore}).`,
            )
            info(
              color.dim(
                wrap(
                  "This is the most important thing doctor can tell you. Either the metric " +
                    "is not measuring what you think, the task is easy enough that anything " +
                    "scores well, or the baseline is genuinely no better than guessing. The " +
                    "third case is fine and even expected — it just means the headroom you " +
                    "are about to climb starts at zero, so treat early gains with suspicion " +
                    "until they clear this margin too.",
                  76,
                  "    ",
                ),
              ),
            )
            warnings += 1
          }
        }
      }
    }
  }

  // ---- Verdict ----------------------------------------------------------
  heading("Verdict")
  if (problems > 0) {
    error(
      `${problems} problem${problems === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}. ` +
        "Fix the problems before running.",
    )
    return 1
  }
  if (warnings > 0) {
    warn(
      `${warnings} warning${warnings === 1 ? "" : "s"}. The mission will run, but read them — ` +
        "each one is a way the results could mislead you.",
    )
    return 0
  }
  success("Mission is ready.")
  return 0
}
