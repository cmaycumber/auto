/**
 * Minimal argv parsing.
 *
 * A dependency-free parser rather than a framework: `auto` has five commands and a
 * handful of flags, and a CLI that ships zero runtime dependencies is meaningfully easier
 * to trust and to install.
 *
 * Supports `--flag`, `--flag value`, `--flag=value`, and short `-x`. Anything not
 * starting with `-` is positional.
 */

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Flags that never take a value, so `--yes run` doesn't swallow `run`. */
const BOOLEAN_FLAGS = new Set(["yes", "y", "force", "help", "h", "skip-run", "lineage"])

export function argsParser(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (!token.startsWith("-")) {
      positional.push(token)
      continue
    }

    const withoutDashes = token.replace(/^--?/, "")

    const equalsIndex = withoutDashes.indexOf("=")
    if (equalsIndex > 0) {
      flags[withoutDashes.slice(0, equalsIndex)] = withoutDashes.slice(equalsIndex + 1)
      continue
    }

    if (BOOLEAN_FLAGS.has(withoutDashes)) {
      flags[withoutDashes] = true
      continue
    }

    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("-")) {
      flags[withoutDashes] = next
      i += 1
    } else {
      flags[withoutDashes] = true
    }
  }

  return { positional, flags }
}
