/**
 * Snapshot and restore of the mutable tree.
 *
 * The loop needs to be able to say "that didn't work, put it back" without depending on
 * the mission being a git repo. Missions live in all sorts of places — a scratch dir, a
 * subfolder of a monorepo, a mounted volume — and requiring `git init` to run an
 * experiment is friction for no benefit at this size.
 *
 * Only `mutablePaths` are snapshotted. Protected paths are covered by integrity hashing
 * and must not move; copying them around would create a second copy to keep honest.
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", ".pytest_cache"])

/**
 * Copy every mutable path into `snapshotDir`, preserving relative layout.
 * Returns the mission-relative paths captured.
 */
export async function snapshot(
  missionDir: string,
  mutablePaths: string[],
  snapshotDir: string,
): Promise<string[]> {
  await mkdir(snapshotDir, { recursive: true })
  const captured: string[] = []

  for (const path of mutablePaths) {
    const source = join(missionDir, path)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(source)
    } catch {
      continue // declared but not yet created — nothing to capture
    }

    const destination = join(snapshotDir, path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: info.isDirectory(),
      filter: (src) => !SKIP_DIRS.has(src.split(sep).pop() ?? ""),
    })
    captured.push(path)
  }

  return captured
}

/**
 * Replace the mutable tree with a snapshot's contents.
 *
 * Deletes each mutable path before copying back. Without the delete, a candidate that
 * *added* a file would leave it behind after a discard, so the "reverted" state would
 * quietly differ from the parent — and the next iteration would be measuring something
 * nobody chose.
 */
export async function restore(
  missionDir: string,
  mutablePaths: string[],
  snapshotDir: string,
): Promise<void> {
  for (const path of mutablePaths) {
    const target = join(missionDir, path)
    const source = join(snapshotDir, path)

    let hasSnapshot = true
    try {
      await stat(source)
    } catch {
      hasSnapshot = false
    }

    await rm(target, { recursive: true, force: true })
    if (!hasSnapshot) continue

    await mkdir(dirname(target), { recursive: true })
    const info = await stat(source)
    await cp(source, target, { recursive: info.isDirectory() })
  }
}

/**
 * Hash every file under the mutable paths.
 *
 * Used to detect what an agent actually touched, by diffing before against after. The
 * agent's own account of its edits is a claim; this is the measurement.
 */
export async function hashMutableTree(
  missionDir: string,
  mutablePaths: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}

  for (const path of mutablePaths) {
    await walk(missionDir, join(missionDir, path), result)
  }

  return result
}

async function walk(
  root: string,
  absolutePath: string,
  out: Record<string, string>,
): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolutePath)
  } catch {
    return
  }

  if (info.isFile()) {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(await Bun.file(absolutePath).arrayBuffer())
    out[relative(root, absolutePath).split(sep).join("/")] = hasher.digest("hex")
    return
  }
  if (!info.isDirectory()) return

  for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    await walk(root, join(absolutePath, entry.name), out)
  }
}

/** Mission-relative paths that differ between two tree hashes (added, removed, changed). */
export function diffTrees(before: Record<string, string>, after: Record<string, string>): string[] {
  const touched = new Set<string>()
  for (const [path, hash] of Object.entries(after)) {
    if (before[path] !== hash) touched.add(path)
  }
  for (const path of Object.keys(before)) {
    if (after[path] === undefined) touched.add(path)
  }
  return [...touched].sort()
}
