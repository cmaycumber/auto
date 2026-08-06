/**
 * Loading a mission from disk and knowing where its artifacts live.
 *
 * On-disk layout:
 *
 *   <mission>/
 *     auto.json              the machine contract (parsed by contracts.ts)
 *     mission.md             the human brief, handed to the agent verbatim
 *     harness/               PROTECTED — the evaluator and anything it needs
 *     solution/              MUTABLE — what the agent edits
 *     memory.md              append-only lessons, carried across iterations
 *     archive/entries.jsonl  every candidate ever measured
 *     runs/<run-id>/         per-run logs, evaluations, snapshots, transcripts
 *
 * Only `auto.json` and `mission.md` are structurally required. The rest is what
 * `auto init` generates, and a mission is free to lay itself out differently as long as
 * the contract's paths point somewhere real.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type AutoMission, ContractError, parseMission } from "./contracts.ts"

export interface LoadedMission {
  mission: AutoMission
  /** Absolute, symlink-resolved mission root. */
  dir: string
  /** Contents of mission.md. */
  brief: string
  paths: MissionPaths
}

export interface MissionPaths {
  contract: string
  brief: string
  memory: string
  archive: string
  runsDir: string
}

export function missionPaths(dir: string): MissionPaths {
  return {
    contract: join(dir, "auto.json"),
    brief: join(dir, "mission.md"),
    memory: join(dir, "memory.md"),
    archive: join(dir, "archive", "entries.jsonl"),
    runsDir: join(dir, "runs"),
  }
}

export function runPaths(dir: string, runId: string) {
  const runDir = join(dir, "runs", runId)
  return {
    runDir,
    decisionLog: join(runDir, "decision-log.md"),
    state: join(runDir, "state.json"),
    evaluations: join(runDir, "evaluations"),
    snapshots: join(runDir, "snapshots"),
    transcripts: join(runDir, "transcripts"),
    /** Unified diffs, one per iteration — the record of what each step actually changed. */
    steps: join(runDir, "steps"),
  }
}

export async function loadMission(missionDirArg: string): Promise<LoadedMission> {
  const dir = resolve(missionDirArg)
  const paths = missionPaths(dir)

  if (!existsSync(dir)) {
    throw new ContractError(`Mission directory does not exist: ${dir}`)
  }
  if (!existsSync(paths.contract)) {
    throw new ContractError(
      `No auto.json in ${dir}. Run \`auto init\` there to create a mission, ` +
        "or point at a directory that already has one.",
    )
  }
  if (!existsSync(paths.brief)) {
    throw new ContractError(`No mission.md in ${dir}. The agent needs a brief to work from.`)
  }

  const rawContract = await readFile(paths.contract, "utf-8")
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawContract)
  } catch (error) {
    throw new ContractError(
      `auto.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    mission: parseMission(parsedJson),
    dir,
    brief: await readFile(paths.brief, "utf-8"),
    paths,
  }
}

export async function readMemory(dir: string): Promise<string> {
  try {
    return await readFile(missionPaths(dir).memory, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Generate a run id.
 *
 * Sortable timestamp plus a short random suffix, so two runs started in the same second
 * (easy to do when scripting) do not collide and clobber each other's logs.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${suffix}`
}
