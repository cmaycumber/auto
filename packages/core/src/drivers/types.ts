/**
 * The agent driver interface.
 *
 * `auto` never talks to a model API directly. It shells out to whatever coding agent the
 * user already has authenticated — Claude Code, Codex, or a deterministic mock — through
 * this one interface. That keeps the loop honest about what it is: an orchestrator around
 * somebody else's agent, not a competing one.
 *
 * Two rules hold for every implementation:
 *
 *   1. The driver edits files on disk in `cwd`. It does not return patches for `auto` to
 *      apply. Coding agents are already good at editing; re-deriving a patch pipeline
 *      would be worse and would break the moment a tool wrote a binary.
 *   2. The driver's self-report is never trusted for *what changed*. The loop hashes the
 *      mutable tree before and after. An agent that says "I only touched solution/" while
 *      having touched the evaluator gets caught by the hash, not by the sentence.
 */

export interface ProposeRequest {
  /** Full instruction, already assembled by the loop from mission + archive context. */
  prompt: string
  /** Working directory. The driver's edits land here. */
  cwd: string
  timeoutSeconds: number
  signal?: AbortSignal
}

export interface ProposeResult {
  ok: boolean
  /** One-line summary of the attempted change, for the archive and the log. */
  description: string
  /** Full agent transcript, persisted for debugging a weird iteration later. */
  rawOutput: string
  error?: string
  durationMs: number
}

export interface AgentDriver {
  readonly name: string
  /** Whether this driver can actually run — binary on PATH, credentials present. */
  isAvailable(): Promise<boolean>
  propose(request: ProposeRequest): Promise<ProposeResult>
}

/**
 * The agent is asked to end its turn with this marker. Parsed out for the archive's
 * one-line description; a missing marker degrades to the last non-empty line rather than
 * failing the iteration, since a good edit with a sloppy sign-off is still a good edit.
 */
export const DESCRIPTION_MARKER = "DESCRIPTION:"

export function extractDescription(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    const index = line.indexOf(DESCRIPTION_MARKER)
    if (index >= 0) {
      const description = line.slice(index + DESCRIPTION_MARKER.length).trim()
      if (description) return truncate(description, 200)
    }
  }

  const fallback = lines[lines.length - 1]
  return fallback ? truncate(fallback, 200) : "(no description reported)"
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Whether a binary resolves on PATH. Used by every CLI-backed driver's availability check. */
export async function binaryExists(binary: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", `command -v ${binary}`], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export interface SpawnCaptureOptions {
  argv: string[]
  cwd: string
  timeoutSeconds: number
  signal?: AbortSignal
}

export interface SpawnCapture {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/**
 * Spawn a CLI, capture both streams, enforce a wall-clock budget.
 *
 * Shared by the CLI-backed drivers so timeout and capture semantics can't drift apart
 * between them — a subtle difference there would show up as one provider mysteriously
 * "crashing more", which is an awful thing to debug.
 */
export async function spawnCapture(options: SpawnCaptureOptions): Promise<SpawnCapture> {
  const started = performance.now()
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutSeconds * 1000)

  const onAbort = () => {
    timedOut = true
    proc.kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr, timedOut, durationMs: performance.now() - started }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
