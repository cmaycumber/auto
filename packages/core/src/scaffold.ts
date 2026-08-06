/**
 * Turning interview answers into a mission on disk.
 *
 * Split into `planMission` (pure — answers in, files out) and `writeMission` (does IO) so
 * the generated contract can be tested without a filesystem, and so a caller that wants
 * to preview or diff a scaffold can do so without creating anything.
 */

import { existsSync } from "node:fs"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { type AutoMission, MISSION_VERSION, slugify } from "./contracts.ts"
import type { InterviewAnswers } from "./interview.ts"
import { EXECUTABLE_PATHS, type GeneratedFile, harnessFiles } from "./templates.ts"

export interface MissionPlan {
  slug: string
  mission: AutoMission
  files: GeneratedFile[]
}

export function buildContract(answers: InterviewAnswers): AutoMission {
  const slug = slugify(answers.title)

  const mission: AutoMission = {
    version: MISSION_VERSION,
    slug,
    title: answers.title,
    domain: answers.domain,
    metric: { name: answers.metricName, description: answers.metricDescription },
    evaluator: {
      command: answers.evaluatorCommand,
      format: "json",
      timeoutSeconds: answers.evaluatorTimeoutSeconds,
      keepPolicy: answers.keepPolicy,
      higherIsBetter: answers.higherIsBetter,
    },
    gates: answers.gates,
    holdout: {
      description: answers.holdoutDescription,
      enforcedBy: answers.holdoutEnforcement,
      hiddenPaths: answers.hiddenPaths,
    },
    protectedPaths: answers.protectedPaths,
    mutablePaths: answers.mutablePaths,
    budget: answers.budget,
    driver: answers.driver,
  }

  if (answers.nullControlCommand?.trim()) {
    mission.nullControl = {
      command: answers.nullControlCommand.trim(),
      everyNIterations: answers.nullControlEveryNIterations,
      alarmWithinFraction: answers.nullControlAlarmWithinFraction,
    }
  }

  return mission
}

/**
 * The mission brief handed to the agent verbatim on every iteration.
 *
 * Written as prose rather than a config dump because it is read by a model, and a model
 * given "here is what you are doing and here is what would make you wrong" behaves
 * measurably better than one given a key-value list. The warnings are phrased as things
 * that would fool *the agent*, not rules imposed on it — an agent that understands why
 * the holdout matters will avoid it more reliably than one that has merely been forbidden.
 */
export function buildBrief(answers: InterviewAnswers): string {
  const direction = answers.higherIsBetter ? "as high as possible" : "as low as possible"

  const lines = [
    `# ${answers.title}`,
    "",
    `**Domain:** ${answers.domain}`,
    "",
    "## What you are optimising",
    "",
    `\`${answers.metricName}\` — ${answers.metricDescription}`,
    "",
    `Drive it ${direction}. It is measured by:`,
    "",
    "```",
    answers.evaluatorCommand,
    "```",
    "",
    "That command is the referee. It is hashed before and after every turn, and the run",
    "halts if it changes. If it looks wrong to you, say so and change nothing — the",
    "urge to fix the measurement is what it feels like from the inside to be about to",
    "fool yourself.",
    "",
    "## The holdout",
    "",
    answers.holdoutDescription,
    "",
    answers.hiddenPaths.length > 0
      ? `Off-limits to read: ${answers.hiddenPaths.map((p) => `\`${p}\``).join(", ")}.`
      : "No paths are marked hidden.",
    "",
    "You are scored on data you have not seen. Anything that works only because it was",
    "fitted to the test set will show up as an improvement here and evaporate the moment",
    "it meets anything real.",
    "",
    "## Ground rules",
    "",
    `- You may edit: ${answers.mutablePaths.map((p) => `\`${p}\``).join(", ")}`,
    `- You may not edit: ${answers.protectedPaths.map((p) => `\`${p}\``).join(", ")}`,
    "- One focused change per iteration. If the score moves, the loop needs to know what moved it.",
    "- A change that does not run is worth less than one that runs and is worse.",
    "",
  ]

  if (answers.gates.length > 0) {
    lines.push(
      "## Hard constraints",
      "",
      "Breaching any of these discards the candidate no matter how good the score is:",
      "",
      ...answers.gates.map((g) => `- \`${g.metric} ${g.op} ${g.value}\` — ${g.reason}`),
      "",
    )
  }

  if (answers.nullControlCommand?.trim()) {
    lines.push(
      "## The null control",
      "",
      `\`${answers.nullControlCommand.trim()}\` runs the same measurement against a`,
      "version of this problem with no signal in it. Its score is what luck looks like.",
      "If your work does not clearly beat it, your work is not doing anything, however",
      "good the number looks.",
      "",
    )
  } else {
    lines.push(
      "## No null control",
      "",
      "This mission has no signal-free baseline configured, which means nothing here can",
      "distinguish a real improvement from a metric that rewards noise. Treat every gain",
      "as provisional, and consider proposing a null control as your first change.",
      "",
    )
  }

  lines.push(
    "## Ideas are cheap; measurements are not",
    "",
    "Every iteration costs real time. Before proposing something, ask what result would",
    "convince you it did NOT work — and make sure the evaluator would show you that.",
    "",
  )

  return lines.join("\n")
}

const MEMORY_SEED = `# Memory

Lessons that outlive a single iteration. Append only — rewriting this to match the
current theory is how a loop convinces itself it was right all along.

Worth recording:
- ideas that failed, and what the failure ruled out
- a metric that moved for a reason unrelated to the change
- anything that made you distrust the evaluator

`

export function planMission(answers: InterviewAnswers): MissionPlan {
  const mission = buildContract(answers)

  const files: GeneratedFile[] = [
    { path: "auto.json", contents: `${JSON.stringify(mission, null, 2)}\n` },
    { path: "mission.md", contents: buildBrief(answers) },
    { path: "memory.md", contents: MEMORY_SEED },
    {
      path: ".gitignore",
      contents: [
        "runs/",
        "__pycache__/",
        "node_modules/",
        ".DS_Store",
        "",
        "# Agent tooling writes session state into the directory it runs in.",
        ".omc/",
        "",
      ].join("\n"),
    },
    ...harnessFiles(answers),
  ]

  return { slug: mission.slug, mission, files }
}

export interface WriteMissionOptions {
  targetDir: string
  plan: MissionPlan
  /** Overwrite files that already exist. Off by default. */
  force?: boolean
}

export interface WriteMissionResult {
  dir: string
  written: string[]
  skipped: string[]
}

/**
 * Write a planned mission.
 *
 * Refuses to overwrite by default and reports what it skipped. Silently clobbering a
 * harness someone has customised would destroy the only copy of the thing that makes
 * their results meaningful.
 */
export async function writeMission(options: WriteMissionOptions): Promise<WriteMissionResult> {
  const dir = resolve(options.targetDir)
  await mkdir(dir, { recursive: true })

  const written: string[] = []
  const skipped: string[] = []

  for (const file of options.plan.files) {
    const target = join(dir, file.path)
    if (existsSync(target) && !options.force) {
      skipped.push(file.path)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.contents, "utf-8")
    if (EXECUTABLE_PATHS.has(file.path)) await chmod(target, 0o755)
    written.push(file.path)
  }

  await mkdir(join(dir, "archive"), { recursive: true })
  await mkdir(join(dir, "runs"), { recursive: true })

  return { dir, written, skipped }
}
