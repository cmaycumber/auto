import { describe, expect, test } from "bun:test"
import { argsParser } from "../args.ts"

describe("argsParser", () => {
  test("separates command and mission dir", () => {
    const args = argsParser(["run", "missions/demo"])
    expect(args.positional).toEqual(["run", "missions/demo"])
  })

  test("reads --flag value", () => {
    expect(argsParser(["run", "--driver", "codex"]).flags.driver).toBe("codex")
  })

  test("reads --flag=value", () => {
    expect(argsParser(["run", "--driver=codex"]).flags.driver).toBe("codex")
  })

  test("treats boolean flags as boolean even when followed by a word", () => {
    // The bug this guards: `auto init --yes demo` must not consume `demo` as the
    // value of --yes and leave the mission dir empty.
    const args = argsParser(["init", "--yes", "demo"])
    expect(args.flags.yes).toBe(true)
    expect(args.positional).toEqual(["init", "demo"])
  })

  test("supports short flags", () => {
    expect(argsParser(["init", "-y"]).flags.y).toBe(true)
  })

  test("treats a trailing value flag as boolean", () => {
    expect(argsParser(["status", "--limit"]).flags.limit).toBe(true)
  })

  test("does not swallow a negative-looking next token", () => {
    const args = argsParser(["run", "--driver", "--max-iterations", "5"])
    expect(args.flags.driver).toBe(true)
    expect(args.flags["max-iterations"]).toBe("5")
  })

  test("handles an empty argv", () => {
    expect(argsParser([])).toEqual({ positional: [], flags: {} })
  })
})
