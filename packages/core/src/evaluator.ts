/**
 * Running the evaluator.
 *
 * The evaluator is a plain subprocess, never an LLM call. That boundary is the whole
 * integrity story: the thing being optimised and the thing doing the measuring must not
 * share a brain. An LLM judge can be *inside* the evaluator command if the domain needs
 * one, but `auto` itself only ever reads its exit code and its JSON.
 */

import { type EvaluatorResult, parseEvaluatorResult } from "./contracts.ts"

export type EvaluationOutcome =
  /** Command ran, exited 0, printed parseable JSON. */
  | "ok"
  /** Command ran to completion but its output was unusable. */
  | "invalid_output"
  /** Command exited non-zero. */
  | "error"
  /** Command exceeded its wall-clock budget and was killed. */
  | "timeout"

export interface EvaluationRun {
  outcome: EvaluationOutcome
  result?: EvaluatorResult
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** Populated for every non-`ok` outcome; safe to surface directly to the user. */
  error?: string
}

export interface RunEvaluatorOptions {
  command: string
  cwd: string
  timeoutSeconds: number
  env?: Record<string, string>
  /** Abort the evaluation early (e.g. the overall run budget expired). */
  signal?: AbortSignal
}

const MAX_CAPTURED_BYTES = 512 * 1024

/**
 * Execute an evaluator command and normalise every failure mode into a value.
 *
 * Never throws for a misbehaving evaluator — a crashed measurement is a legitimate,
 * loggable result that the loop must be able to record and move past. It only throws if
 * the runtime itself cannot spawn a shell.
 */
export async function runEvaluator(options: RunEvaluatorOptions): Promise<EvaluationRun> {
  const started = performance.now()
  const timeoutMs = options.timeoutSeconds * 1000

  const proc = Bun.spawn(["/bin/sh", "-c", options.command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const onAbort = () => {
    timedOut = true
    proc.kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })

  let stdout = ""
  let stderr = ""
  let exitCode: number | null = null

  try {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout),
      readCapped(proc.stderr),
      proc.exited,
    ])
    stdout = out
    stderr = err
    exitCode = code
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }

  const durationMs = performance.now() - started

  if (timedOut) {
    return {
      outcome: "timeout",
      exitCode,
      stdout,
      stderr,
      durationMs,
      error: `Evaluator exceeded its ${options.timeoutSeconds}s budget and was killed.`,
    }
  }

  if (exitCode !== 0) {
    return {
      outcome: "error",
      exitCode,
      stdout,
      stderr,
      durationMs,
      error: `Evaluator exited ${exitCode}. stderr: ${lastLines(stderr, 5) || "(empty)"}`,
    }
  }

  try {
    return {
      outcome: "ok",
      result: parseEvaluatorResult(stdout),
      exitCode,
      stdout,
      stderr,
      durationMs,
    }
  } catch (error) {
    return {
      outcome: "invalid_output",
      exitCode,
      stdout,
      stderr,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Drain a stream, stopping after MAX_CAPTURED_BYTES.
 *
 * A runaway evaluator that prints megabytes of progress output should not be able to
 * exhaust memory. The JSON result is expected at the end, so the cap keeps a tail-biased
 * window rather than the head.
 */
async function readCapped(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return ""
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    chunks.push(text)
    total += text.length
    while (total > MAX_CAPTURED_BYTES && chunks.length > 1) {
      const dropped = chunks.shift()
      total -= dropped?.length ?? 0
    }
  }
  chunks.push(decoder.decode())
  return chunks.join("")
}

function lastLines(value: string, count: number): string {
  return value.trim().split("\n").slice(-count).join("\n").trim()
}
