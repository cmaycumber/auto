/**
 * The experiment loop.
 *
 * propose → measure → gate → keep or revert, forever, until a budget runs out.
 *
 * The structure is not novel and is not meant to be — it is the Darwin Gödel Machine /
 * Karpathy autoresearch shape. What `auto` adds is that every safeguard around it is
 * mandatory rather than aspirational: the baseline is measured before the agent is
 * allowed to touch anything, the protected tree is re-hashed on every iteration, the
 * revert is real, and the null control runs on a schedule whether or not the results look
 * good. Especially when the results look good.
 *
 * Ordering invariants, all of which were load-bearing somewhere before they were code:
 *
 *   - Baseline first. If the harness cannot score the scaffold end-to-end, there is
 *     nothing to improve on and every later number is uninterpretable.
 *   - Integrity is checked AFTER the agent's turn and BEFORE the evaluator runs. Checking
 *     after would mean scoring a tampered harness and then discovering it.
 *   - Gates are checked before scores. A hard constraint that can be outbid is decoration.
 *   - Revert on anything that is not a keep. A discarded candidate that stays on disk
 *     silently becomes the base for the next iteration.
 */

import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import {
  type ArchiveEntry,
  appendEntry,
  champion,
  readArchive,
  selectParent,
  summarise,
} from "./archive.ts"
import type { AutoMission } from "./contracts.ts"
import { createDriver } from "./drivers/index.ts"
import type { AgentDriver } from "./drivers/types.ts"
import { runEvaluator } from "./evaluator.ts"
import { checkNullControl, type Decision, decide, type NullComparisonContext } from "./gates.ts"
import { analyseGapTrend, type GapTrend } from "./generalisation.ts"
import { buildManifest, verifyManifest } from "./integrity.ts"
import { appendIteration, appendNote, appendSummary, writeHeader } from "./log.ts"
import { type LoadedMission, newRunId, readMemory, runPaths } from "./mission.ts"
import { buildProposalPrompt } from "./prompt.ts"
import { capturePatch, type StepPatch } from "./steps.ts"
import { diffTrees, hashMutableTree, restore, snapshot } from "./workspace.ts"

export type StopReason =
  | "max_iterations"
  | "max_runtime"
  | "integrity_violation"
  | "baseline_failed"
  | "cancelled"
  | "driver_unavailable"

export type LoopEvent =
  | { type: "run_started"; runId: string; driver: string; missionTitle: string }
  | { type: "baseline_started" }
  | { type: "baseline_done"; score: number | null; pass: boolean }
  | { type: "iteration_started"; iteration: number; parent: number | null }
  | { type: "proposing"; iteration: number }
  | { type: "proposed"; iteration: number; description: string; touched: string[] }
  | { type: "evaluating"; iteration: number }
  | { type: "iteration_done"; iteration: number; entry: ArchiveEntry }
  | { type: "null_control"; iteration: number; breached: boolean; message: string }
  | { type: "warning"; message: string }
  | { type: "run_finished"; reason: StopReason; stats: ReturnType<typeof summarise> }

export interface RunLoopOptions {
  loaded: LoadedMission
  /** Overrides the mission's configured driver. Mainly for `--driver mock` in tests. */
  driver?: AgentDriver
  onEvent?: (event: LoopEvent) => void
  signal?: AbortSignal
  /** Overrides for a single invocation, without editing auto.json. */
  maxIterations?: number
  maxRuntimeSeconds?: number
  /** Chance of branching from a non-champion. */
  explorationRate?: number
  random?: () => number
}

export interface RunLoopResult {
  runId: string
  reason: StopReason
  stats: ReturnType<typeof summarise>
  entries: ArchiveEntry[]
  nullControlBreached: boolean
  decisionLogPath: string
  /** Present when the mission declares a generalisation-gap metric. */
  gapTrend?: GapTrend
}

export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const { loaded } = options
  const { mission, dir } = loaded
  const emit = options.onEvent ?? (() => {})

  const runId = newRunId()
  const paths = runPaths(dir, runId)
  const maxIterations = options.maxIterations ?? mission.budget.maxIterations
  const maxRuntimeSeconds = options.maxRuntimeSeconds ?? mission.budget.maxRuntimeSeconds
  const explorationRate = options.explorationRate ?? 0.25
  const random = options.random ?? Math.random

  await mkdir(paths.evaluations, { recursive: true })
  await mkdir(paths.snapshots, { recursive: true })
  await mkdir(paths.transcripts, { recursive: true })
  await mkdir(paths.steps, { recursive: true })

  const driver = options.driver ?? createDriver(mission.driver)
  const startedAt = new Date()
  const deadline = startedAt.getTime() + maxRuntimeSeconds * 1000

  await writeHeader(paths.decisionLog, {
    mission,
    runId,
    driverName: driver.name,
    startedAt,
  })

  emit({ type: "run_started", runId, driver: driver.name, missionTitle: mission.title })

  if (!(await driver.isAvailable())) {
    const message =
      `Driver \`${driver.name}\` is not available. Check the CLI is installed and ` +
      "authenticated, or pick another with `--driver`."
    await appendNote(paths.decisionLog, "Halted", message)
    emit({ type: "warning", message })
    const stats = summarise([], mission.evaluator.higherIsBetter)
    emit({ type: "run_finished", reason: "driver_unavailable", stats })
    return {
      runId,
      reason: "driver_unavailable",
      stats,
      entries: [],
      nullControlBreached: false,
      decisionLogPath: paths.decisionLog,
    }
  }

  // Hash the protected tree before anything runs. Everything after this compares to it.
  const manifest = await buildManifest(dir, mission.protectedPaths)
  await writeFile(join(paths.runDir, "integrity.json"), JSON.stringify(manifest, null, 2), "utf-8")

  let entries = await readArchive(loaded.paths.archive)
  let nullControlBreached = false
  let iteration = entries.reduce((max, e) => Math.max(max, e.iteration), 0)

  const finish = async (reason: StopReason): Promise<RunLoopResult> => {
    const stats = summarise(entries, mission.evaluator.higherIsBetter)
    const gapTrend = mission.generalisationGapMetric
      ? analyseGapTrend(entries, mission.generalisationGapMetric, mission.evaluator.higherIsBetter)
      : undefined

    await appendSummary(paths.decisionLog, {
      metricName: mission.metric.name,
      iterations: stats.total,
      kept: stats.kept,
      bestScore: stats.bestScore,
      stopReason: STOP_REASON_TEXT[reason],
      elapsedSeconds: (Date.now() - startedAt.getTime()) / 1000,
      nullControlBreached,
      gapTrend,
    })

    if (gapTrend?.suspicious) emit({ type: "warning", message: gapTrend.message })

    emit({ type: "run_finished", reason, stats })
    return {
      runId,
      reason,
      stats,
      entries,
      nullControlBreached,
      decisionLogPath: paths.decisionLog,
      ...(gapTrend ? { gapTrend } : {}),
    }
  }

  // ---- Baseline ---------------------------------------------------------
  // Measure the scaffold as-is. This proves the harness runs end-to-end before an agent
  // is allowed near it, and it is the score everything else is compared against.
  if (entries.length === 0) {
    emit({ type: "baseline_started" })
    const baselineStarted = performance.now()
    const run = await runEvaluator({
      command: mission.evaluator.command,
      cwd: dir,
      timeoutSeconds: mission.evaluator.timeoutSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await persistEvaluation(paths.evaluations, 0, run)

    if (run.outcome !== "ok" || !run.result) {
      const message =
        `The baseline evaluation failed (${run.outcome}): ${run.error ?? "unknown error"}. ` +
        "The harness has to score the scaffold before the loop can improve on it. " +
        "Fix the evaluator, then re-run."
      await appendNote(paths.decisionLog, "Baseline failed", message)
      emit({ type: "warning", message })
      return finish("baseline_failed")
    }

    const baselineBreaches = decide({ mission, result: run.result, parentScore: undefined })
    const snapshotDir = join(paths.snapshots, "0")
    await snapshot(dir, mission.mutablePaths, snapshotDir)

    const entry: ArchiveEntry = {
      iteration: 0,
      runId,
      parent: null,
      verdict: baselineBreaches.verdict === "gated" ? "gated" : "keep",
      score: run.result.score ?? null,
      pass: run.result.pass,
      metrics: run.result.metrics ?? {},
      description: "baseline — the scaffold as written, before any agent edits",
      rationale:
        baselineBreaches.verdict === "gated"
          ? baselineBreaches.rationale
          : "Baseline established. Every later iteration is measured against this.",
      snapshot: relative(dir, snapshotDir),
      durationMs: performance.now() - baselineStarted,
      createdAt: new Date().toISOString(),
    }

    await appendEntry(loaded.paths.archive, entry)
    await appendIteration(paths.decisionLog, entry, mission.metric.name)
    entries = [...entries, entry]
    emit({ type: "baseline_done", score: entry.score, pass: entry.pass ?? false })

    if (entry.verdict === "gated") {
      const message =
        "The baseline itself breaches a hard gate. Either the scaffold is genuinely " +
        "unusable, or the gate is set somewhere the mission can never reach. Fix one " +
        "of the two before running the loop."
      await appendNote(paths.decisionLog, "Baseline gated", message)
      emit({ type: "warning", message })
      return finish("baseline_failed")
    }

    // Run the null control once up front. Cheap, and it catches a broken or trivially
    // gameable evaluator before an overnight run is spent climbing a fake hill.
    if (mission.nullControl && entry.score !== null) {
      const result = await evaluateNullControl(
        mission,
        dir,
        entry.score,
        "baseline",
        options.signal,
      )
      if (result) {
        // A narrow gap at baseline is information, not an indictment — it says the
        // scaffold has no skill in it yet. Only a breach measured against something the
        // loop actually produced casts doubt on the run's results, so only that one
        // sets the flag the summary reacts to.
        await appendNote(
          paths.decisionLog,
          result.breached ? "Null control — baseline has no edge yet" : "Null control",
          result.message,
        )
        emit({ type: "null_control", iteration: 0, ...result })
      }
    }

    iteration = 0
  }

  // ---- Iterate ----------------------------------------------------------
  while (true) {
    if (options.signal?.aborted) return finish("cancelled")
    if (iteration >= maxIterations) return finish("max_iterations")
    if (Date.now() >= deadline) return finish("max_runtime")

    iteration += 1

    const violations = await verifyManifest(dir, mission.protectedPaths, manifest)
    if (violations.length > 0) {
      const message = describeViolations(violations)
      await appendNote(paths.decisionLog, "INTEGRITY VIOLATION — run halted", message)
      emit({ type: "warning", message })
      return finish("integrity_violation")
    }

    const parent = resolveParent(entries, dir, mission, explorationRate, random)
    emit({ type: "iteration_started", iteration, parent: parent?.iteration ?? null })

    // Put the tree back to the parent's state before proposing, so the agent is editing
    // what the archive says it is editing.
    if (parent?.snapshot) {
      await restore(dir, mission.mutablePaths, join(dir, parent.snapshot))
    }

    const before = await hashMutableTree(dir, mission.mutablePaths)
    const iterationStarted = performance.now()

    const prompt = buildProposalPrompt({
      mission,
      missionBrief: loaded.brief,
      archive: entries,
      parent,
      iteration,
      memory: await readMemory(dir),
    })

    emit({ type: "proposing", iteration })
    const proposal = await driver.propose({
      prompt,
      cwd: dir,
      timeoutSeconds: mission.budget.iterationTimeoutSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
    })

    await writeFile(
      join(paths.transcripts, `iteration-${String(iteration).padStart(4, "0")}.txt`),
      proposal.rawOutput,
      "utf-8",
    )

    // Integrity BEFORE evaluation: a tampered harness must never produce a score.
    const postViolations = await verifyManifest(dir, mission.protectedPaths, manifest)
    if (postViolations.length > 0) {
      const message =
        `The agent modified a protected path during iteration ${iteration}. ` +
        `${describeViolations(postViolations)} No score was taken. The run is halted ` +
        "because everything measured from here would be unfalsifiable."
      await appendNote(paths.decisionLog, "INTEGRITY VIOLATION — run halted", message)
      emit({ type: "warning", message })
      return finish("integrity_violation")
    }

    const after = await hashMutableTree(dir, mission.mutablePaths)
    const touched = diffTrees(before, after)

    if (!proposal.ok) {
      entries = await recordFailure({
        entries,
        iteration,
        runId,
        parent,
        description: proposal.description,
        rationale: `Agent turn failed: ${proposal.error ?? "unknown error"}`,
        durationMs: performance.now() - iterationStarted,
        mission,
        loaded,
        paths,
        emit,
      })
      await revertTo(dir, mission, parent)
      continue
    }

    if (touched.length === 0) {
      entries = await recordFailure({
        entries,
        iteration,
        runId,
        parent,
        description: proposal.description,
        rationale:
          "The agent's turn completed without changing any file in the mutable tree. " +
          "Nothing to measure.",
        durationMs: performance.now() - iterationStarted,
        mission,
        loaded,
        paths,
        emit,
      })
      continue
    }

    emit({ type: "proposed", iteration, description: proposal.description, touched })

    // Capture the patch now, while the candidate is still on disk. Every downstream
    // branch — keep, discard, gate breach, evaluator crash — reverts or moves on, and a
    // discarded step's diff is exactly the record of what did not work. Losing it would
    // leave the archive saying "we tried something and it was worse" with no way to find
    // out what the something was.
    const step = await capturePatch({
      missionDir: dir,
      mutablePaths: mission.mutablePaths,
      beforeDir: parent?.snapshot ? join(dir, parent.snapshot) : null,
    })
    const patchPath = await persistPatch(dir, paths.steps, iteration, step.patch)

    emit({ type: "evaluating", iteration })

    const run = await runEvaluator({
      command: mission.evaluator.command,
      cwd: dir,
      timeoutSeconds: mission.evaluator.timeoutSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    await persistEvaluation(paths.evaluations, iteration, run)

    if (run.outcome !== "ok" || !run.result) {
      // Keep the patch on a crash — this is the single most useful diff in the archive,
      // because it is the change that broke the harness.
      entries = await recordFailure({
        entries,
        iteration,
        runId,
        parent,
        description: proposal.description,
        rationale: `Evaluation failed (${run.outcome}): ${run.error ?? "unknown error"}`,
        durationMs: performance.now() - iterationStarted,
        mission,
        loaded,
        paths,
        emit,
        patch: patchPath,
        step,
      })
      await revertTo(dir, mission, parent)
      continue
    }

    const decision: Decision = decide({
      mission,
      result: run.result,
      parentScore: parent?.score ?? undefined,
    })

    let snapshotPath: string | null = null
    if (decision.verdict === "keep") {
      const snapshotDir = join(paths.snapshots, String(iteration))
      await snapshot(dir, mission.mutablePaths, snapshotDir)
      snapshotPath = relative(dir, snapshotDir)
    } else {
      await revertTo(dir, mission, parent)
    }

    const entry: ArchiveEntry = {
      iteration,
      runId,
      parent: parent?.iteration ?? null,
      verdict: decision.verdict,
      score: run.result.score ?? null,
      pass: run.result.pass,
      metrics: run.result.metrics ?? {},
      description: proposal.description,
      rationale: decision.rationale,
      snapshot: snapshotPath,
      durationMs: performance.now() - iterationStarted,
      createdAt: new Date().toISOString(),
      patch: patchPath,
      diffStat: step.stat,
      files: step.files,
    }

    await appendEntry(loaded.paths.archive, entry)
    await appendIteration(paths.decisionLog, entry, mission.metric.name)
    entries = [...entries, entry]
    emit({ type: "iteration_done", iteration, entry })

    // ---- Scheduled null control ----------------------------------------
    // On a fixed cadence, regardless of how well things are going. Running it only when
    // results look suspicious means never running it, because a climbing score never
    // looks suspicious from the inside.
    const nc = mission.nullControl
    if (nc && iteration % nc.everyNIterations === 0) {
      const best = champion(entries, mission.evaluator.higherIsBetter)
      if (best?.score != null) {
        // The champion is still the untouched scaffold until the loop keeps something
        // past iteration 0, and a narrow gap means different things either side of that.
        const context: NullComparisonContext = best.iteration === 0 ? "baseline" : "optimised"
        const result = await evaluateNullControl(mission, dir, best.score, context, options.signal)
        if (result) {
          if (context === "optimised") nullControlBreached ||= result.breached
          await appendNote(
            paths.decisionLog,
            result.breached
              ? context === "optimised"
                ? "NULL CONTROL BREACH"
                : "Null control — baseline has no edge yet"
              : "Null control",
            result.message,
          )
          emit({ type: "null_control", iteration, ...result })
        }
      }
    }
  }
}

const STOP_REASON_TEXT: Record<StopReason, string> = {
  max_iterations: "reached the configured iteration budget",
  max_runtime: "reached the configured runtime budget",
  integrity_violation: "a protected path was modified — results after that point cannot be trusted",
  baseline_failed: "the baseline evaluation did not produce a usable score",
  cancelled: "cancelled by the operator",
  driver_unavailable: "the configured agent driver could not be used",
}

/**
 * Run the null control and compare it to the champion.
 *
 * A null control that itself crashes is reported as a warning rather than swallowed —
 * a broken null control is the same as no null control, and the operator should know
 * their safety net has a hole in it.
 */
async function evaluateNullControl(
  mission: AutoMission,
  dir: string,
  championScore: number,
  context: NullComparisonContext,
  signal: AbortSignal | undefined,
): Promise<{ breached: boolean; message: string } | null> {
  const nc = mission.nullControl
  if (!nc) return null

  const run = await runEvaluator({
    command: nc.command,
    cwd: dir,
    timeoutSeconds: mission.evaluator.timeoutSeconds,
    ...(signal ? { signal } : {}),
  })

  if (run.outcome !== "ok" || !run.result || run.result.score === undefined) {
    return {
      breached: false,
      message:
        `The null control did not produce a score (${run.outcome}: ${run.error ?? "no score"}). ` +
        "The run continues, but improvements are currently unguarded against a " +
        "signal-free baseline.",
    }
  }

  return checkNullControl(
    championScore,
    run.result.score,
    nc.alarmWithinFraction,
    mission.evaluator.higherIsBetter,
    context,
  )
}

/**
 * Pick a parent whose snapshot still exists on disk.
 *
 * Snapshots are per-run and gitignored, so an archive carried across runs will reference
 * directories that are gone. Rather than fail, fall back to the best entry that can
 * actually be restored.
 */
function resolveParent(
  entries: ArchiveEntry[],
  dir: string,
  mission: AutoMission,
  explorationRate: number,
  random: () => number,
): ArchiveEntry | undefined {
  const restorable = entries.filter(
    (entry) => entry.snapshot !== null && existsSync(join(dir, entry.snapshot)),
  )
  if (restorable.length === 0) return champion(entries, mission.evaluator.higherIsBetter)

  return selectParent({
    entries: restorable,
    higherIsBetter: mission.evaluator.higherIsBetter,
    explorationRate,
    random,
  })
}

async function revertTo(
  dir: string,
  mission: AutoMission,
  parent: ArchiveEntry | undefined,
): Promise<void> {
  if (parent?.snapshot) {
    await restore(dir, mission.mutablePaths, join(dir, parent.snapshot))
  }
}

/**
 * Write a step's unified diff, returning its mission-relative path.
 *
 * An empty patch still gets a path recorded as null rather than an empty file, so
 * "this step changed nothing measurable" stays distinguishable from "the patch is
 * missing" when reading the archive back.
 */
async function persistPatch(
  missionDir: string,
  stepsDir: string,
  iteration: number,
  patch: string,
): Promise<string | null> {
  if (patch.trim() === "") return null
  const name = `iteration-${String(iteration).padStart(4, "0")}.patch`
  const full = join(stepsDir, name)
  await writeFile(full, `${patch}\n`, "utf-8")
  // Mission-relative, matching `snapshot`, so every path in an archive entry is
  // resolvable the same way.
  return relative(missionDir, full)
}

async function persistEvaluation(
  evaluationsDir: string,
  iteration: number,
  run: Awaited<ReturnType<typeof runEvaluator>>,
): Promise<void> {
  const path = join(evaluationsDir, `iteration-${String(iteration).padStart(4, "0")}.json`)
  const payload = {
    iteration,
    outcome: run.outcome,
    result: run.result ?? null,
    error: run.error ?? null,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    stderr: run.stderr.slice(-4000),
  }
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8")
}

interface RecordFailureOptions {
  entries: ArchiveEntry[]
  iteration: number
  runId: string
  parent: ArchiveEntry | undefined
  description: string
  rationale: string
  durationMs: number
  mission: AutoMission
  loaded: LoadedMission
  paths: ReturnType<typeof runPaths>
  emit: (event: LoopEvent) => void
  /** Present when the candidate got far enough to have produced a diff. */
  patch?: string | null
  step?: StepPatch
}

/** Record a crash. Crashes are archived, not skipped — a dead end is a finding. */
async function recordFailure(options: RecordFailureOptions): Promise<ArchiveEntry[]> {
  const entry: ArchiveEntry = {
    iteration: options.iteration,
    runId: options.runId,
    parent: options.parent?.iteration ?? null,
    verdict: "crash",
    score: null,
    pass: null,
    metrics: {},
    description: options.description,
    rationale: options.rationale,
    snapshot: null,
    durationMs: options.durationMs,
    createdAt: new Date().toISOString(),
    patch: options.patch ?? null,
    diffStat: options.step?.stat ?? null,
    files: options.step?.files ?? [],
  }

  await appendEntry(options.loaded.paths.archive, entry)
  await appendIteration(options.paths.decisionLog, entry, options.mission.metric.name)
  options.emit({ type: "iteration_done", iteration: options.iteration, entry })
  return [...options.entries, entry]
}

/**
 * Describe an integrity violation in a way the operator can act on.
 *
 * The halt is correct in every case, but the *cause* varies wildly and the response
 * differs with it. Three things produce violations in practice, and only one of them is
 * the agent doing something interesting:
 *
 *   - Agent tooling writing scratch state into a protected tree (dot-directories).
 *     Benign, and infuriating to diagnose without a hint.
 *   - A formatter or linter in the surrounding repo reflowing the mission's files.
 *     Also benign, also invisible — the content is semantically unchanged, so the
 *     operator stares at an identical-looking file wondering what moved.
 *   - The agent actually editing the evaluator, the gates, or the holdout.
 *
 * Integrity stays byte-exact regardless — softening it for "cosmetic" changes would
 * create exactly the bypass the check exists to close. Only the message adapts.
 */
function describeViolations(violations: Array<{ path: string; kind: string }>): string {
  const listed = violations.map((v) => `${v.path} (${v.kind})`).join(", ")

  const isToolingScratch = (path: string) =>
    path.split("/").some((segment) => segment.startsWith(".") && segment !== ".")

  const scratch = violations.filter((v) => isToolingScratch(v.path))
  const substantive = violations.filter((v) => !isToolingScratch(v.path))

  const hints: string[] = []

  if (scratch.length > 0) {
    hints.push(
      `${scratch.length} of these are dot-directory paths, which usually means agent ` +
        "tooling wrote session state inside a protected tree rather than the agent " +
        "editing anything. Point that tooling elsewhere, or move the protected path.",
    )
  }

  if (substantive.some((v) => v.kind === "modified")) {
    hints.push(
      "If a modified file looks unchanged, check whether a formatter or linter in the " +
        "surrounding repo rewrote it — integrity is byte-exact, so a reflowed JSON array " +
        "counts. Exclude the mission directory from those tools.",
    )
  }

  return hints.length > 0 ? `${listed} — ${hints.join(" ")}` : listed
}
