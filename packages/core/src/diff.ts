/**
 * A minimal unified-diff implementation.
 *
 * Hand-rolled rather than shelling out to `diff` or `git diff --no-index`, for two
 * reasons: the zero-runtime-dependency rule, and the fact that a mission is frequently
 * not a git repo and may run somewhere `diff(1)` is not on PATH. Patches are the primary
 * record of what each step actually changed, so their capture must not depend on the
 * host's tooling.
 *
 * Line-level LCS. Not Myers — the input is a handful of source files per step, where the
 * quadratic table is irrelevant and the simpler algorithm is easier to trust. Files past
 * a size threshold degrade to a whole-file replacement rather than allocating a huge
 * table, because a patch nobody will read is not worth an OOM.
 */

/** Above this many lines on either side, emit a wholesale replacement instead of an LCS. */
const LCS_LINE_LIMIT = 4000

export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
}

export function emptyStat(): DiffStat {
  return { filesChanged: 0, insertions: 0, deletions: 0 }
}

export function addStat(a: DiffStat, b: DiffStat): DiffStat {
  return {
    filesChanged: a.filesChanged + b.filesChanged,
    insertions: a.insertions + b.insertions,
    deletions: a.deletions + b.deletions,
  }
}

type Op = { kind: "equal" | "insert" | "delete"; line: string }

/**
 * Longest-common-subsequence table over lines, walked back into an edit script.
 *
 * Returns null when either side is too large, signalling the caller to fall back.
 */
function lcsOps(before: string[], after: string[]): Op[] | null {
  if (before.length > LCS_LINE_LIMIT || after.length > LCS_LINE_LIMIT) return null

  const n = before.length
  const m = after.length

  // table[i][j] = LCS length of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i] as number[]
      const next = table[i + 1] as number[]
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", line: before[i] as string })
      i++
      j++
      continue
    }
    const down = (table[i + 1] as number[])[j] as number
    const right = (table[i] as number[])[j + 1] as number
    if (down >= right) {
      ops.push({ kind: "delete", line: before[i] as string })
      i++
    } else {
      ops.push({ kind: "insert", line: after[j] as string })
      j++
    }
  }
  while (i < n) ops.push({ kind: "delete", line: before[i++] as string })
  while (j < m) ops.push({ kind: "insert", line: after[j++] as string })

  return ops
}

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  // A trailing newline produces a final empty element that is not a real line.
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

interface Hunk {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  lines: string[]
}

/**
 * Group an edit script into hunks with `context` unchanged lines around each change.
 *
 * Standard unified-diff shape, so the output pastes into `patch`, renders in any diff
 * viewer, and reads the way a reviewer expects.
 */
function toHunks(ops: Op[], context: number): Hunk[] {
  const changedAt = ops
    .map((op, index) => (op.kind === "equal" ? -1 : index))
    .filter((index) => index >= 0)
  if (changedAt.length === 0) return []

  // Merge change indices whose context windows touch.
  const ranges: Array<[number, number]> = []
  for (const index of changedAt) {
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }

  const hunks: Hunk[] = []
  let beforeLine = 1
  let afterLine = 1
  let cursor = 0

  for (const [start, end] of ranges) {
    // Advance counters over the ops we're skipping.
    for (; cursor < start; cursor++) {
      const op = ops[cursor] as Op
      if (op.kind !== "insert") beforeLine++
      if (op.kind !== "delete") afterLine++
    }

    const hunk: Hunk = {
      beforeStart: beforeLine,
      beforeCount: 0,
      afterStart: afterLine,
      afterCount: 0,
      lines: [],
    }

    for (; cursor <= end; cursor++) {
      const op = ops[cursor] as Op
      if (op.kind === "equal") {
        hunk.lines.push(` ${op.line}`)
        hunk.beforeCount++
        hunk.afterCount++
        beforeLine++
        afterLine++
      } else if (op.kind === "delete") {
        hunk.lines.push(`-${op.line}`)
        hunk.beforeCount++
        beforeLine++
      } else {
        hunk.lines.push(`+${op.line}`)
        hunk.afterCount++
        afterLine++
      }
    }

    hunks.push(hunk)
  }

  return hunks
}

export interface FileDiff {
  path: string
  patch: string
  stat: DiffStat
  /** True when content could not be compared line-by-line (binary, or too large). */
  degraded: boolean
}

/**
 * Produce a unified diff for one file.
 *
 * `before` or `after` being null means the file was added or deleted respectively; both
 * are rendered against `/dev/null` in the usual way.
 */
export function diffFile(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): FileDiff | null {
  if (before === after) return null

  const beforeLines = before === null ? [] : splitLines(before)
  const afterLines = after === null ? [] : splitLines(after)

  const header = [
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
  ]

  const ops = lcsOps(beforeLines, afterLines)

  if (ops === null) {
    // Too large to diff meaningfully — record the shape of the change and move on.
    const patch = [
      ...header,
      `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
      `# file too large for a line diff (${beforeLines.length} → ${afterLines.length} lines)`,
    ].join("\n")
    return {
      path,
      patch,
      stat: { filesChanged: 1, insertions: afterLines.length, deletions: beforeLines.length },
      degraded: true,
    }
  }

  const hunks = toHunks(ops, context)
  if (hunks.length === 0) return null

  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
    ...hunk.lines,
  ])

  return {
    path,
    patch: [...header, ...body].join("\n"),
    stat: {
      filesChanged: 1,
      insertions: ops.filter((op) => op.kind === "insert").length,
      deletions: ops.filter((op) => op.kind === "delete").length,
    },
    degraded: false,
  }
}

/** Render `+12 −3` style shorthand. */
export function formatStat(stat: DiffStat): string {
  const files = `${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"}`
  return `${files}, +${stat.insertions} −${stat.deletions}`
}
