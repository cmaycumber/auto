/**
 * `auto init` — the interview.
 *
 * The flow is intentionally not skippable in its middle. You can `--yes` your way to a
 * demo mission, but the interactive path makes you type an answer to "what does no signal
 * score?" and "what could you edit to fake a win?", because a loop built without answers
 * to those will produce numbers that feel like progress for as long as you let it run.
 */

import { resolve } from "node:path"
import {
  auditAnswers,
  defaultAnswers,
  type InterviewAnswers,
  planMission,
  QUESTIONS,
  templateCommands,
  writeMission,
} from "@auto/core"
import {
  color,
  createPrompter,
  dim,
  heading,
  info,
  parseBoolean,
  parseList,
  warn,
  wrap,
} from "../ui.ts"

export interface InitOptions {
  dir: string
  yes: boolean
  force: boolean
}

export async function initCommand(options: InitOptions): Promise<number> {
  const targetDir = resolve(options.dir)

  const answers = options.yes ? demoAnswers() : await interview()
  if (!answers) return 1

  const audit = auditAnswers(answers)

  if (audit.errors.length > 0) {
    heading("This mission cannot be created as described")
    for (const issue of audit.errors) {
      console.log(`  ${color.red("✗")} ${color.bold(issue.field)}: ${issue.message}`)
    }
    info("")
    info("Fix these and run `auto init` again.")
    return 1
  }

  if (audit.warnings.length > 0) {
    heading("Before you start, know what this mission cannot tell you")
    for (const issue of audit.warnings) {
      console.log(`  ${color.yellow("!")} ${color.bold(issue.field)}`)
      console.log(wrap(issue.message, 76, "    "))
    }
    info("")

    if (!options.yes) {
      const prompter = createPrompter()
      const proceed = parseBoolean(
        await prompter.ask("Create the mission anyway? (y/N)", "n"),
        false,
      )
      prompter.close()
      if (!proceed) {
        info("Nothing written.")
        return 1
      }
    }
  }

  const plan = planMission(answers)
  const result = await writeMission({ targetDir, plan, force: options.force })

  heading(`Mission \`${plan.slug}\` created`)
  info(`  ${color.dim(result.dir)}`)
  info("")
  for (const path of result.written) console.log(`  ${color.green("+")} ${path}`)
  for (const path of result.skipped) {
    console.log(`  ${color.dim("·")} ${color.dim(`${path} (exists — kept)`)}`)
  }

  heading("Next")
  info(`  auto doctor ${options.dir}    ${color.dim("— check the harness before spending tokens")}`)
  info(`  auto run ${options.dir}       ${color.dim("— establish the baseline, then iterate")}`)
  info("")
  dim("  The generated harness solves a placeholder knapsack task so the loop runs")
  dim("  end-to-end today. Replace load_instances() and score_answer() in harness/")
  dim("  with your real problem — the split, gates, and null control carry over.")

  return 0
}

async function interview(): Promise<InterviewAnswers | null> {
  const prompter = createPrompter()
  const collected: Record<string, unknown> = {}

  heading("auto — new autoresearch mission")
  dim(
    wrap(
      "Six questions decide whether this loop produces a result or a very convincing " +
        "waste of a night. The ones about the holdout and the null control are the " +
        "ones worth slowing down for.",
      76,
      "",
    ),
  )

  try {
    for (const question of QUESTIONS) {
      info("")
      console.log(color.bold(question.prompt))
      console.log(color.dim(wrap(question.help)))

      if (question.kind === "choice" && question.choices) {
        for (const choice of question.choices) {
          console.log(`    ${color.cyan(choice.value)} — ${choice.label}`)
        }
      }

      const fallback = formatDefault(question.default, collected, question.id)
      const raw = await prompter.ask(color.dim("›"), fallback)

      if (question.validate) {
        const problem = question.validate(raw)
        if (problem) {
          warn(problem)
          prompter.close()
          return null
        }
      }

      collected[question.id] = coerce(question.kind, raw, question.default)
    }
  } finally {
    prompter.close()
  }

  return assemble(collected)
}

/** The template choice retroactively sets sensible evaluator defaults. */
function formatDefault(
  value: unknown,
  collected: Record<string, unknown>,
  id: string,
): string | undefined {
  const template = collected.template as string | undefined
  if (template && (id === "evaluatorCommand" || id === "nullControlCommand")) {
    const commands = templateCommands(template as "python" | "node" | "shell")
    return id === "evaluatorCommand" ? commands.evaluator : commands.nullControl
  }

  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.join(", ")
  return String(value)
}

function coerce(kind: string, raw: string, fallback: unknown): unknown {
  switch (kind) {
    case "boolean":
      return parseBoolean(raw, Boolean(fallback))
    case "number": {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : Number(fallback)
    }
    case "list":
      return parseList(raw)
    default:
      return raw
  }
}

function assemble(collected: Record<string, unknown>): InterviewAnswers {
  const template = (collected.template as string as "python" | "node" | "shell") ?? "python"
  const provider = (collected.driver as string) ?? "claude"

  const answers = defaultAnswers({
    title: String(collected.title),
    domain: String(collected.domain),
    metricName: String(collected.metricName),
    metricDescription: String(collected.metricDescription),
    higherIsBetter: Boolean(collected.higherIsBetter),
    evaluatorCommand: String(collected.evaluatorCommand),
    holdoutDescription: String(collected.holdoutDescription),
    holdoutEnforcement: collected.holdoutEnforcement as InterviewAnswers["holdoutEnforcement"],
    hiddenPaths: (collected.hiddenPaths as string[]) ?? [],
    protectedPaths: (collected.protectedPaths as string[]) ?? [],
    mutablePaths: (collected.mutablePaths as string[]) ?? [],
    template,
    driver: { provider: provider as "claude" | "codex" | "mock" },
    budget: {
      maxIterations: Number(collected.maxIterations) || 50,
      maxRuntimeSeconds: Number(collected.maxRuntimeSeconds) || 3600,
      iterationTimeoutSeconds: 900,
    },
  })

  const nullControl = String(collected.nullControlCommand ?? "").trim()
  if (nullControl) answers.nullControlCommand = nullControl
  else delete answers.nullControlCommand

  return answers
}

/**
 * The `--yes` mission: the placeholder knapsack task, fully wired.
 *
 * Includes a real hard gate (every answer must respect the capacity limit) because a demo
 * that omits the safety machinery teaches the wrong shape.
 */
function demoAnswers(): InterviewAnswers {
  return defaultAnswers({
    title: "Knapsack value ratio",
    domain: "combinatorial optimisation (starter mission)",
    metricName: "mean_score",
    metricDescription:
      "Mean fraction of the LP-relaxation bound achieved across 40 held-out knapsack " +
      "instances. Ranges 0–1; the naive baseline scores around 0.5.",
    higherIsBetter: true,
    holdoutDescription:
      "40 instances in harness/holdout/, generated from a different seed than the 40 " +
      "training instances. The solution may read harness/train/ and never harness/holdout/.",
    holdoutEnforcement: "path_isolation",
    hiddenPaths: ["harness/holdout"],
    gates: [
      {
        metric: "feasible_fraction",
        op: "gte",
        value: 1.0,
        reason:
          "Every answer must respect the capacity limit. A solver that overfills scores " +
          "well on value and is useless.",
      },
      {
        metric: "solver_errors",
        op: "lte",
        value: 0,
        reason: "A solution that throws on any instance is not a solution.",
      },
    ],
    budget: { maxIterations: 30, maxRuntimeSeconds: 3600, iterationTimeoutSeconds: 600 },
  })
}
