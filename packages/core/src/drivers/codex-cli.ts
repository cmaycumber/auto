/**
 * Codex driver — drives `codex exec` non-interactively.
 *
 * Uses `-o/--output-last-message` to get the agent's final message as a clean file rather
 * than parsing it out of the JSONL event stream. The stream is still captured into
 * `rawOutput` for debugging, but the description is read from the file, which is stable
 * across Codex versions in a way that event-shape parsing is not.
 *
 * Sandbox is `workspace-write`: the agent may edit the mission tree and nothing above it.
 */

import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentDriver,
  binaryExists,
  extractDescription,
  type ProposeRequest,
  type ProposeResult,
  spawnCapture,
} from "./types.ts"

export interface CodexCliDriverOptions {
  model?: string
  extraArgs?: string[]
  binary?: string
  /**
   * Missions are frequently plain directories rather than git repos, and Codex refuses to
   * run outside one unless told otherwise.
   */
  skipGitRepoCheck?: boolean
}

let counter = 0

export function createCodexCliDriver(options: CodexCliDriverOptions = {}): AgentDriver {
  const binary = options.binary ?? "codex"

  return {
    name: "codex",

    async isAvailable() {
      return binaryExists(binary)
    },

    async propose(request: ProposeRequest): Promise<ProposeResult> {
      counter += 1
      const lastMessagePath = join(tmpdir(), `auto-codex-${process.pid}-${counter}.txt`)

      const argv = [
        binary,
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        request.cwd,
        "--output-last-message",
        lastMessagePath,
      ]
      if (options.skipGitRepoCheck !== false) argv.push("--skip-git-repo-check")
      if (options.model) argv.push("--model", options.model)
      if (options.extraArgs?.length) argv.push(...options.extraArgs)
      argv.push(request.prompt)

      const capture = await spawnCapture({
        argv,
        cwd: request.cwd,
        timeoutSeconds: request.timeoutSeconds,
        ...(request.signal ? { signal: request.signal } : {}),
      })

      const finalMessage = await readAndRemove(lastMessagePath)

      if (capture.timedOut) {
        return {
          ok: false,
          description: "(timed out)",
          rawOutput: capture.stdout,
          error: `codex exceeded its ${request.timeoutSeconds}s budget.`,
          durationMs: capture.durationMs,
        }
      }

      if (capture.exitCode !== 0) {
        return {
          ok: false,
          description: "(agent error)",
          rawOutput: `${capture.stdout}\n${capture.stderr}`,
          error: `codex exited ${capture.exitCode}: ${capture.stderr.trim().slice(-500)}`,
          durationMs: capture.durationMs,
        }
      }

      const text = finalMessage ?? capture.stdout
      return {
        ok: true,
        description: extractDescription(text),
        rawOutput: capture.stdout,
        durationMs: capture.durationMs,
      }
    },
  }
}

/** Read the last-message file if Codex wrote one, then clean it up either way. */
async function readAndRemove(path: string): Promise<string | null> {
  let contents: string | null = null
  try {
    contents = await Bun.file(path).text()
  } catch {
    contents = null
  }
  try {
    await unlink(path)
  } catch {
    // never existed, or already gone
  }
  return contents
}
