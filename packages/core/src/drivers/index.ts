import type { DriverConfig } from "../contracts.ts"
import { createClaudeCliDriver } from "./claude-cli.ts"
import { createCodexCliDriver } from "./codex-cli.ts"
import { createMockDriver } from "./mock.ts"
import type { AgentDriver } from "./types.ts"

export { createClaudeCliDriver } from "./claude-cli.ts"
export { createCodexCliDriver } from "./codex-cli.ts"
export { createMockDriver } from "./mock.ts"
export {
  type AgentDriver,
  DESCRIPTION_MARKER,
  extractDescription,
  type ProposeRequest,
  type ProposeResult,
} from "./types.ts"

/** Build the driver a mission asks for. */
export function createDriver(config: DriverConfig): AgentDriver {
  const shared = {
    ...(config.model ? { model: config.model } : {}),
    ...(config.extraArgs ? { extraArgs: config.extraArgs } : {}),
  }

  switch (config.provider) {
    case "claude":
      return createClaudeCliDriver(shared)
    case "codex":
      return createCodexCliDriver(shared)
    case "mock":
      return createMockDriver()
  }
}
