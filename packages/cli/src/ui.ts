/**
 * Terminal presentation and interactive prompting.
 *
 * Colour is disabled when stdout is not a TTY or NO_COLOR is set, so piping `auto status`
 * into a file or a log aggregator produces clean text rather than escape soup.
 */

import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR

function paint(code: string) {
  return (value: string): string => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value)
}

export const color = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
}

export function heading(text: string): void {
  console.log(`\n${color.bold(text)}`)
}

export function info(text: string): void {
  console.log(text)
}

export function dim(text: string): void {
  console.log(color.dim(text))
}

export function success(text: string): void {
  console.log(`${color.green("✓")} ${text}`)
}

export function warn(text: string): void {
  console.log(`${color.yellow("!")} ${text}`)
}

export function error(text: string): void {
  console.error(`${color.red("✗")} ${text}`)
}

/** Wrap prose to a width, for help text under prompts. */
export function wrap(text: string, width = 76, indent = "  "): string {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""

  for (const word of words) {
    if (current === "") current = word
    else if (`${current} ${word}`.length + indent.length <= width) current += ` ${word}`
    else {
      lines.push(indent + current)
      current = word
    }
  }
  if (current) lines.push(indent + current)
  return lines.join("\n")
}

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>
  close(): void
}

export function createPrompter(): Prompter {
  const rl = createInterface({ input: stdin, output: stdout })
  return {
    async ask(question: string, fallback?: string): Promise<string> {
      const suffix = fallback === undefined ? "" : color.dim(` [${fallback}]`)
      const answer = (await rl.question(`${question}${suffix} `)).trim()
      return answer === "" && fallback !== undefined ? fallback : answer
    },
    close() {
      rl.close()
    },
  }
}

export function parseBoolean(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === "") return fallback
  return ["y", "yes", "true", "1"].includes(normalized)
}

export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** Render a small key/value block with aligned keys. */
export function table(rows: Array<[string, string]>): void {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0)
  for (const [key, value] of rows) {
    console.log(`  ${color.dim(key.padEnd(width))}  ${value}`)
  }
}
