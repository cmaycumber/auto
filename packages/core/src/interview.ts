/**
 * The evaluator interview.
 *
 * This is the part of `auto` that earns its keep. Wrapping a loop around a coding agent
 * is a weekend project; the reason most such loops produce nothing is that nobody made
 * the operator answer the hard questions before starting. So `auto init` asks them, in
 * order, and refuses to write a mission until they are answered:
 *
 *   1. What single number are you moving, and which direction is good?
 *   2. What command produces that number? (A command. Not a vibe, not an LLM's opinion.)
 *   3. What data does the agent NOT get to see, and what physically stops it?
 *   4. What does "no signal" score? (The null control. The most skipped, most important.)
 *   5. What could the agent edit to fake a win? (Those become protected.)
 *   6. What constraint must hold no matter how good the score is?
 *
 * Questions 3 and 4 are the ones people want to skip, and they are exactly the two that
 * separate a real result from a year of climbing a fake hill. The interview is structured
 * data rather than a script so the same flow can drive an interactive CLI, a Claude Code
 * skill, or a non-interactive config file.
 */

import type { Budget, DriverConfig, Gate, HoldoutEnforcement, KeepPolicy } from "./contracts.ts"

export type TemplateKind = "python" | "node" | "shell"

export interface InterviewAnswers {
  title: string
  domain: string
  metricName: string
  metricDescription: string
  higherIsBetter: boolean
  evaluatorCommand: string
  evaluatorTimeoutSeconds: number
  keepPolicy: KeepPolicy
  holdoutDescription: string
  holdoutEnforcement: HoldoutEnforcement
  hiddenPaths: string[]
  nullControlCommand?: string
  nullControlEveryNIterations: number
  nullControlAlarmWithinFraction: number
  gates: Gate[]
  protectedPaths: string[]
  mutablePaths: string[]
  budget: Budget
  driver: DriverConfig
  template: TemplateKind
}

export type QuestionKind = "text" | "number" | "boolean" | "choice" | "list"

export interface Question {
  id: keyof InterviewAnswers | string
  kind: QuestionKind
  /** The question as asked. */
  prompt: string
  /** Shown under the prompt. This is where the reasoning lives — read it, it's the point. */
  help: string
  choices?: Array<{ value: string; label: string }>
  default?: string | number | boolean | string[]
  /** Return an error string to reject an answer and re-ask. */
  validate?: (value: string) => string | null
}

/** Applied to every free-text answer that must not be blank. */
function required(label: string) {
  return (value: string): string | null => (value.trim() === "" ? `${label} is required.` : null)
}

/**
 * The interview script.
 *
 * Ordered deliberately: the metric and the command come first because they are concrete
 * and get the operator thinking in measurements. The holdout and null control come next,
 * while they are still willing to think hard. Budget and driver come last because they
 * are the questions people can answer on autopilot.
 */
export const QUESTIONS: Question[] = [
  {
    id: "title",
    kind: "text",
    prompt: "What is this mission trying to do?",
    help: "One line. 'Cut warehouse pick-path length', 'Raise lead-scoring precision at fixed recall'.",
    validate: required("A title"),
  },
  {
    id: "domain",
    kind: "text",
    prompt: "What domain is this?",
    help: "Free text — logistics, drug discovery, ad creative, prediction markets. Used to orient the agent.",
    validate: required("A domain"),
  },
  {
    id: "metricName",
    kind: "text",
    prompt: "What single number are you optimising?",
    help:
      "One number, not three. If you have several, decide now how they combine into one, " +
      "because the loop will need a total ordering and picking it later means every " +
      "result so far was ranked by something you hadn't chosen yet.",
    default: "score",
    validate: required("A metric name"),
  },
  {
    id: "metricDescription",
    kind: "text",
    prompt: "What does that number mean?",
    help: "A sentence. Units, range, and what a good value looks like.",
    validate: required("A description"),
  },
  {
    id: "higherIsBetter",
    kind: "boolean",
    prompt: "Is higher better?",
    help: "No for error rates, latency, cost, distance.",
    default: true,
  },
  {
    id: "evaluatorCommand",
    kind: "text",
    prompt: "What command measures it?",
    help:
      'Run from the mission directory. Must print JSON: {"pass": bool, "score": number, ' +
      '"metrics": {...}}. This command is the referee — it must not be something the ' +
      "agent can edit, and it must not be an LLM asked whether the work was good.",
    default: "python3 harness/evaluate.py",
    validate: required("An evaluator command"),
  },
  {
    id: "holdoutDescription",
    kind: "text",
    prompt: "What data is held out, and how do you know the agent can't see it?",
    help:
      "The most common way these loops produce a fake win is fitting to the test set. " +
      "Describe the split. If you don't have one yet, stop and build it — everything " +
      "downstream is uninterpretable without it.",
    validate: required("A holdout description"),
  },
  {
    id: "holdoutEnforcement",
    kind: "choice",
    prompt: "How is the holdout enforced?",
    help:
      "path_isolation is strongest: the data physically lives where the mutable code " +
      "can't read it. manual means you're trusting the agent not to peek, which is a " +
      "policy, not a mechanism.",
    choices: [
      { value: "path_isolation", label: "Held-out data lives outside the agent's reach" },
      { value: "time_split", label: "A time boundary the evaluator enforces" },
      { value: "manual", label: "Declared but not mechanically enforced" },
    ],
    default: "path_isolation",
  },
  {
    id: "hiddenPaths",
    kind: "list",
    prompt: "Which paths hold the held-out data?",
    help: "Comma-separated, relative to the mission dir. These get protected automatically.",
    default: ["harness/holdout"],
  },
  {
    id: "nullControlCommand",
    kind: "text",
    prompt: "What command scores a signal-free version of this?",
    help:
      "Shuffled labels, randomised decisions, a constant baseline — same evaluator, no " +
      "real signal. If the null scores as well as your solution, your metric isn't " +
      "measuring skill and every improvement is noise. Leave blank to skip, but skipping " +
      "means nothing in this run can be distinguished from luck.",
    default: "python3 harness/null_control.py",
  },
  {
    id: "protectedPaths",
    kind: "list",
    prompt: "What must the agent never edit?",
    help:
      "The evaluator, the holdout, the gates. Ask yourself: if the agent wanted to fake " +
      "a win without doing the work, what would it change? That list goes here. These " +
      "are hashed every iteration and the run halts if one moves.",
    default: ["harness", "auto.json", "mission.md"],
  },
  {
    id: "mutablePaths",
    kind: "list",
    prompt: "What may the agent edit?",
    help: "Usually just the solution directory. Anything outside this is rejected.",
    default: ["solution"],
  },
  {
    id: "template",
    kind: "choice",
    prompt: "What should the starter harness be written in?",
    help: "Generates a runnable evaluator and null control you then adapt to your real task.",
    choices: [
      { value: "python", label: "Python 3" },
      { value: "node", label: "Node / Bun (TypeScript)" },
      { value: "shell", label: "Shell — I'll wire my own" },
    ],
    default: "python",
  },
  {
    id: "driver",
    kind: "choice",
    prompt: "Which agent should drive the loop?",
    help: "Uses the CLI you already have authenticated. `mock` runs a script instead of a model.",
    choices: [
      { value: "claude", label: "Claude Code (`claude`)" },
      { value: "codex", label: "Codex (`codex exec`)" },
      { value: "mock", label: "Mock / scripted ($AUTO_MOCK_COMMAND)" },
    ],
    default: "claude",
  },
  {
    id: "maxIterations",
    kind: "number",
    prompt: "How many iterations at most?",
    help:
      "Under ~20 rarely says anything: a couple of keeps out of a handful of tries is " +
      "what noise looks like.",
    default: 50,
  },
  {
    id: "maxRuntimeSeconds",
    kind: "number",
    prompt: "Maximum total runtime, in seconds?",
    help: "Wall-clock ceiling for the whole run. 28800 is an overnight.",
    default: 3600,
  },
]

export interface AnswerIssue {
  field: string
  message: string
}

/**
 * Cross-field checks the per-question validators cannot see.
 *
 * These are the mistakes that pass field-level validation and still ruin a run: a holdout
 * that isn't protected, a mutable path that contains the evaluator, a null control that
 * was skipped. Warnings are returned separately from errors — `auto` will let you proceed
 * without a null control, but it will not let you do so unaware.
 */
export function auditAnswers(answers: InterviewAnswers): {
  errors: AnswerIssue[]
  warnings: AnswerIssue[]
} {
  const errors: AnswerIssue[] = []
  const warnings: AnswerIssue[] = []

  const segs = (p: string) => p.split("/").filter((s) => s !== "" && s !== ".")
  const inside = (child: string, parent: string) => {
    const c = segs(child)
    const p = segs(parent)
    return p.length > 0 && c.length >= p.length && p.every((s, i) => c[i] === s)
  }

  if (answers.protectedPaths.length === 0) {
    errors.push({
      field: "protectedPaths",
      message:
        "Nothing is protected. The agent could rewrite the evaluator and report a " +
        "perfect score without doing any work.",
    })
  }

  for (const hidden of answers.hiddenPaths) {
    if (!answers.protectedPaths.some((p) => inside(hidden, p) || hidden === p)) {
      errors.push({
        field: "hiddenPaths",
        message: `\`${hidden}\` holds held-out data but is not covered by protectedPaths.`,
      })
    }
  }

  for (const mutable of answers.mutablePaths) {
    for (const guarded of answers.protectedPaths) {
      if (inside(mutable, guarded) || inside(guarded, mutable) || mutable === guarded) {
        errors.push({
          field: "mutablePaths",
          message: `\`${mutable}\` overlaps protected path \`${guarded}\`.`,
        })
      }
    }
  }

  if (!answers.nullControlCommand?.trim()) {
    warnings.push({
      field: "nullControlCommand",
      message:
        "No null control. Nothing in this mission will be able to tell a real improvement " +
        "from a metric that rewards noise. Strongly consider adding one before a long run.",
    })
  }

  if (answers.holdoutEnforcement === "manual") {
    warnings.push({
      field: "holdoutEnforcement",
      message:
        "The holdout is enforced by convention only. An agent that reads it will not be " +
        "stopped, and the resulting score will look excellent and mean nothing.",
    })
  }

  if (answers.gates.length === 0) {
    warnings.push({
      field: "gates",
      message:
        "No hard gates. If there is any constraint the solution must respect — cost, " +
        "latency, safety, drawdown — an optimiser will happily trade it away for score.",
    })
  }

  if (answers.budget.maxIterations < 20) {
    warnings.push({
      field: "budget.maxIterations",
      message: `${answers.budget.maxIterations} iterations is a smoke test, not a result.`,
    })
  }

  return { errors, warnings }
}

/** Sensible starting point, so non-interactive callers only override what they care about. */
export function defaultAnswers(overrides: Partial<InterviewAnswers> = {}): InterviewAnswers {
  return {
    title: "Untitled mission",
    domain: "unspecified",
    metricName: "score",
    metricDescription: "Higher is better.",
    higherIsBetter: true,
    evaluatorCommand: "python3 harness/evaluate.py",
    evaluatorTimeoutSeconds: 300,
    keepPolicy: "score_improvement",
    holdoutDescription: "Held-out instances the solution never sees during development.",
    holdoutEnforcement: "path_isolation",
    hiddenPaths: ["harness/holdout"],
    nullControlCommand: "python3 harness/null_control.py",
    nullControlEveryNIterations: 10,
    nullControlAlarmWithinFraction: 0.1,
    gates: [],
    protectedPaths: ["harness", "auto.json", "mission.md"],
    mutablePaths: ["solution"],
    budget: {
      maxIterations: 50,
      maxRuntimeSeconds: 3600,
      iterationTimeoutSeconds: 900,
    },
    driver: { provider: "claude" },
    template: "python",
    ...overrides,
  }
}
