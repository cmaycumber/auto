/**
 * `auto diff <n>` — read the patch a step actually applied.
 *
 * The description in the archive is the agent's account of its change. This is the change.
 * When those two disagree — and they do — this is the one that counts.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ContractError, formatStat, loadMission, readArchive } from "@auto/core"
import { color, dim, error, heading, info } from "../ui.ts"

export interface DiffOptions {
  dir: string
  iteration: number
}

export async function diffCommand(options: DiffOptions): Promise<number> {
  const dir = resolve(options.dir)

  let loaded: Awaited<ReturnType<typeof loadMission>>
  try {
    loaded = await loadMission(dir)
  } catch (err) {
    error(err instanceof ContractError ? err.message : String(err))
    return 1
  }

  const entries = await readArchive(loaded.paths.archive)
  const entry = entries.find((e) => e.iteration === options.iteration)

  if (!entry) {
    const available = entries.map((e) => e.iteration)
    error(
      `No step #${options.iteration}. ` +
        (available.length > 0
          ? `Available: ${available[0]}–${available[available.length - 1]}.`
          : "The archive is empty."),
    )
    return 1
  }

  heading(`Step #${entry.iteration} — ${entry.verdict}`)
  info(`  ${entry.description}`)
  dim(`  ${entry.rationale}`)
  if (entry.diffStat) dim(`  ${formatStat(entry.diffStat)}`)
  info("")

  if (!entry.patch) {
    // Distinguish the three reasons a patch can be absent — they mean different things
    // and only one of them is a problem.
    if (entry.iteration === 0) {
      info(
        color.dim("  The baseline has no patch — it is the state everything else diffs against."),
      )
    } else if (entry.diffStat && entry.diffStat.filesChanged === 0) {
      info(color.dim("  This step changed no files."))
    } else {
      info(
        color.dim(
          "  No patch recorded. This archive entry predates step capture, or the run was " +
            "interrupted before the diff was written.",
        ),
      )
    }
    return 0
  }

  try {
    const patch = await readFile(join(dir, entry.patch), "utf-8")
    info(colourisePatch(patch))
  } catch {
    error(`Patch file is missing: ${entry.patch}`)
    return 1
  }

  return 0
}

/** Standard diff colouring. Falls through untouched when colour is disabled. */
function colourisePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return color.bold(line)
      if (line.startsWith("@@")) return color.cyan(line)
      if (line.startsWith("+")) return color.green(line)
      if (line.startsWith("-")) return color.red(line)
      if (line.startsWith("#")) return color.dim(line)
      return line
    })
    .join("\n")
}
