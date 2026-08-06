#!/usr/bin/env bun
/**
 * `auto` — spin up an autoresearch agent for any domain.
 *
 * Five commands, one idea: the loop is easy, the verifier is the work. `init` interviews
 * you into a real evaluator, `doctor` checks it can tell signal from noise, `run` iterates
 * against it, `status` and `log` tell you what actually happened.
 */

import { argsParser } from "./args.ts"
import { diffCommand } from "./commands/diff.ts"
import { doctorCommand } from "./commands/doctor.ts"
import { initCommand } from "./commands/init.ts"
import { logCommand } from "./commands/log.ts"
import { runCommand } from "./commands/run.ts"
import { statusCommand } from "./commands/status.ts"
import { stepsCommand } from "./commands/steps.ts"
import { color, error, info } from "./ui.ts"

const HELP = `${color.bold("auto")} — autoresearch loops for any domain

${color.bold("USAGE")}
  auto <command> [mission-dir] [options]

${color.bold("COMMANDS")}
  init [dir]      Interview you into a mission: metric, evaluator, holdout,
                  null control, cheat surface. Scaffolds a runnable harness.
  doctor [dir]    Check a mission before spending a night on it. Runs the
                  evaluator and the null control and tells you whether the
                  baseline can actually beat noise.
  run [dir]       Establish a baseline, then loop: propose, measure, gate,
                  keep or revert.
  status [dir]    What the archive says: kept, discarded, gated, crashed.
  steps [dir]     Every step with its description and what it changed.
                  --lineage shows only the champion's ancestry — the steps
                  that actually produced the score.
  diff <n> [dir]  The patch a step applied. What it did, not what it said.
  log [dir]       The decision log for a run.

${color.bold("OPTIONS")}
  --yes, -y             init: skip the interview, scaffold the starter mission
  --force               init: overwrite existing files
  --driver <name>       run: claude | codex | mock (overrides auto.json)
  --max-iterations <n>  run: override the iteration budget
  --max-runtime <s>     run: override the runtime budget, in seconds
  --exploration <r>     run: 0–1 chance of branching from a non-champion
  --skip-run            doctor: don't execute the evaluator
  --limit <n>           status: how many recent iterations to show
  --run <id>            log: which run to show (default: latest)
  --help, -h            Show this

${color.bold("GETTING STARTED")}
  auto init demo --yes      ${color.dim("# scaffold the starter mission")}
  auto doctor demo          ${color.dim("# confirm it can tell signal from noise")}
  auto run demo             ${color.dim("# baseline, then iterate")}
  auto status demo          ${color.dim("# what it found")}

${color.dim("Mission dir defaults to the current directory.")}
`

async function main(argv: string[]): Promise<number> {
  const args = argsParser(argv)

  if (args.flags.help || args.flags.h || args.positional.length === 0) {
    info(HELP)
    return args.positional.length === 0 && !args.flags.help && !args.flags.h ? 1 : 0
  }

  const command = args.positional[0] as string
  const dir = args.positional[1] ?? "."

  switch (command) {
    case "init":
      return initCommand({
        dir,
        yes: Boolean(args.flags.yes || args.flags.y),
        force: Boolean(args.flags.force),
      })

    case "doctor":
      return doctorCommand({ dir, skipRun: Boolean(args.flags["skip-run"]) })

    case "run":
      return runCommand({
        dir,
        ...(typeof args.flags.driver === "string" ? { driver: args.flags.driver } : {}),
        ...(args.flags["max-iterations"] !== undefined
          ? { maxIterations: Number(args.flags["max-iterations"]) }
          : {}),
        ...(args.flags["max-runtime"] !== undefined
          ? { maxRuntimeSeconds: Number(args.flags["max-runtime"]) }
          : {}),
        ...(args.flags.exploration !== undefined
          ? { explorationRate: Number(args.flags.exploration) }
          : {}),
      })

    case "status":
      return statusCommand({
        dir,
        limit: args.flags.limit !== undefined ? Number(args.flags.limit) : 15,
      })

    case "steps":
      return stepsCommand({
        dir,
        lineageOnly: Boolean(args.flags.lineage),
        limit: args.flags.limit !== undefined ? Number(args.flags.limit) : 20,
      })

    case "diff": {
      // `auto diff 7 [dir]` — the iteration is the first positional after the command.
      const iteration = Number(args.positional[1])
      if (!Number.isInteger(iteration)) {
        error("`auto diff` needs a step number, e.g. `auto diff 7`.")
        return 1
      }
      return diffCommand({ dir: args.positional[2] ?? ".", iteration })
    }

    case "log":
      return logCommand({
        dir,
        ...(typeof args.flags.run === "string" ? { runId: args.flags.run } : {}),
      })

    default:
      error(`Unknown command \`${command}\`. Try \`auto --help\`.`)
      return 1
  }
}

process.exit(await main(process.argv.slice(2)))
