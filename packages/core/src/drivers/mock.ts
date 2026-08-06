/**
 * Mock driver — a scripted stand-in for a coding agent.
 *
 * Exists for two reasons, and the second is the interesting one:
 *
 *   1. Tests. The loop has real branching (gate breach, crash, integrity halt, budget
 *      exhaustion) and none of it should require a live model or a network to exercise.
 *
 *   2. Scripted optimisers. Not every mission needs an LLM proposing changes. A parameter
 *      sweep, a genetic algorithm, or a hand-written heuristic tweaker can be dropped in
 *      as `AUTO_MOCK_COMMAND` and get the whole apparatus — gates, null control, archive,
 *      integrity — for free. Useful as a sanity floor: if your LLM loop cannot beat a
 *      random-search script through the same harness, the LLM is not what is helping.
 */

import {
  type AgentDriver,
  extractDescription,
  type ProposeRequest,
  type ProposeResult,
  spawnCapture,
} from "./types.ts"

export interface MockDriverOptions {
  /** Programmatic handler. Takes precedence over `command`. Used by tests. */
  handler?: (request: ProposeRequest) => ProposeResult | Promise<ProposeResult>
  /**
   * Shell command run in the mission directory to produce the next candidate.
   * Defaults to `$AUTO_MOCK_COMMAND`.
   */
  command?: string
}

export function createMockDriver(options: MockDriverOptions = {}): AgentDriver {
  const command = options.command ?? process.env.AUTO_MOCK_COMMAND

  return {
    name: "mock",

    async isAvailable() {
      return Boolean(options.handler || command)
    },

    async propose(request: ProposeRequest): Promise<ProposeResult> {
      if (options.handler) return options.handler(request)

      if (!command) {
        return {
          ok: false,
          description: "(mock driver has nothing to run)",
          rawOutput: "",
          error:
            "The mock driver needs either a programmatic handler or a command. " +
            "Set AUTO_MOCK_COMMAND, or pick a real driver with `--driver claude`.",
          durationMs: 0,
        }
      }

      // The proposal prompt is exported rather than passed as argv so scripts can ignore
      // it entirely (a parameter sweep does not care what the prompt says) without having
      // to accept and discard a giant positional argument.
      const capture = await spawnCapture({
        argv: ["/bin/sh", "-c", command],
        cwd: request.cwd,
        timeoutSeconds: request.timeoutSeconds,
        ...(request.signal ? { signal: request.signal } : {}),
      })

      if (capture.timedOut) {
        return {
          ok: false,
          description: "(timed out)",
          rawOutput: capture.stdout,
          error: `Mock command exceeded its ${request.timeoutSeconds}s budget.`,
          durationMs: capture.durationMs,
        }
      }

      if (capture.exitCode !== 0) {
        return {
          ok: false,
          description: "(mock command failed)",
          rawOutput: `${capture.stdout}\n${capture.stderr}`,
          error: `Mock command exited ${capture.exitCode}: ${capture.stderr.trim().slice(-500)}`,
          durationMs: capture.durationMs,
        }
      }

      return {
        ok: true,
        description: extractDescription(capture.stdout),
        rawOutput: capture.stdout,
        durationMs: capture.durationMs,
      }
    },
  }
}
