/**
 * Claude Code driver — drives the `claude` CLI in headless mode.
 *
 * Uses `--permission-mode acceptEdits` rather than `bypassPermissions`. The agent needs
 * to edit files without prompting, but it should not get a blanket pass on everything
 * else; the mission's protected paths are enforced by hashing regardless, and defaulting
 * to the weaker permission keeps the blast radius of a confused iteration smaller.
 */

import {
  type AgentDriver,
  binaryExists,
  extractDescription,
  type ProposeRequest,
  type ProposeResult,
  spawnCapture,
} from "./types.ts"

export interface ClaudeCliDriverOptions {
  model?: string
  extraArgs?: string[]
  binary?: string
}

/** Shape of `claude -p --output-format json`. Only the fields we rely on. */
interface ClaudeJsonResult {
  result?: string
  is_error?: boolean
  subtype?: string
  total_cost_usd?: number
  num_turns?: number
}

export function createClaudeCliDriver(options: ClaudeCliDriverOptions = {}): AgentDriver {
  const binary = options.binary ?? "claude"

  return {
    name: "claude",

    async isAvailable() {
      return binaryExists(binary)
    },

    async propose(request: ProposeRequest): Promise<ProposeResult> {
      const argv = [
        binary,
        "-p",
        request.prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
      ]
      if (options.model) argv.push("--model", options.model)
      if (options.extraArgs?.length) argv.push(...options.extraArgs)

      const capture = await spawnCapture({
        argv,
        cwd: request.cwd,
        timeoutSeconds: request.timeoutSeconds,
        ...(request.signal ? { signal: request.signal } : {}),
      })

      if (capture.timedOut) {
        return {
          ok: false,
          description: "(timed out)",
          rawOutput: capture.stdout,
          error: `claude exceeded its ${request.timeoutSeconds}s budget.`,
          durationMs: capture.durationMs,
        }
      }

      if (capture.exitCode !== 0) {
        return {
          ok: false,
          description: "(agent error)",
          rawOutput: `${capture.stdout}\n${capture.stderr}`,
          error: `claude exited ${capture.exitCode}: ${capture.stderr.trim().slice(-500)}`,
          durationMs: capture.durationMs,
        }
      }

      // A zero exit with unparseable stdout means the CLI contract changed under us.
      // Surface it loudly rather than silently treating an empty edit as a valid no-op.
      let parsed: ClaudeJsonResult
      try {
        parsed = JSON.parse(capture.stdout) as ClaudeJsonResult
      } catch {
        return {
          ok: false,
          description: "(unparseable agent output)",
          rawOutput: capture.stdout,
          error: "claude --output-format json did not return JSON.",
          durationMs: capture.durationMs,
        }
      }

      const text = parsed.result ?? ""
      if (parsed.is_error) {
        return {
          ok: false,
          description: "(agent reported error)",
          rawOutput: text || capture.stdout,
          error: `claude reported an error (subtype: ${parsed.subtype ?? "unknown"}).`,
          durationMs: capture.durationMs,
        }
      }

      return {
        ok: true,
        description: extractDescription(text),
        rawOutput: text,
        durationMs: capture.durationMs,
      }
    },
  }
}
