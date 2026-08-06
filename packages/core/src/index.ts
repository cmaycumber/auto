/**
 * @auto/core — the mission contract, the loop, and everything that keeps it honest.
 *
 * The public surface is deliberately small: load a mission, run the loop, read the
 * archive. Everything else is an implementation detail of those three.
 */

export {
  type ArchiveEntry,
  type ArchiveStats,
  appendEntry,
  champion,
  readArchive,
  type SelectParentOptions,
  selectParent,
  summarise,
} from "./archive.ts"
export {
  type AutoMission,
  type Budget,
  ContractError,
  type DriverConfig,
  type DriverProvider,
  type EvaluatorContract,
  type EvaluatorResult,
  type Gate,
  type GateOp,
  type Holdout,
  type HoldoutEnforcement,
  type KeepPolicy,
  MISSION_VERSION,
  type MissionMetric,
  type NullControl,
  parseEvaluatorResult,
  parseMission,
  pathsOverlap,
  slugify,
} from "./contracts.ts"
export {
  addStat,
  type DiffStat,
  diffFile,
  emptyStat,
  type FileDiff,
  formatStat,
} from "./diff.ts"
export {
  type AgentDriver,
  createClaudeCliDriver,
  createCodexCliDriver,
  createDriver,
  createMockDriver,
  DESCRIPTION_MARKER,
  extractDescription,
  type ProposeRequest,
  type ProposeResult,
} from "./drivers/index.ts"
export {
  type EvaluationOutcome,
  type EvaluationRun,
  type RunEvaluatorOptions,
  runEvaluator,
} from "./evaluator.ts"
export {
  checkGates,
  checkNullControl,
  type Decision,
  decide,
  type GateBreach,
  isImprovement,
  type NullComparisonContext,
  type Verdict,
} from "./gates.ts"
export {
  auditPathDeclarations,
  buildManifest,
  findOutOfBoundsEdits,
  type IntegrityManifest,
  type IntegrityViolation,
  verifyManifest,
} from "./integrity.ts"
export {
  type AnswerIssue,
  auditAnswers,
  defaultAnswers,
  type InterviewAnswers,
  QUESTIONS,
  type Question,
  type QuestionKind,
  type TemplateKind,
} from "./interview.ts"
export {
  appendIteration,
  appendNote,
  appendSummary,
  type LogHeaderOptions,
  type SummaryOptions,
  writeHeader,
} from "./log.ts"
export {
  type LoopEvent,
  type RunLoopOptions,
  type RunLoopResult,
  runLoop,
  type StopReason,
} from "./loop.ts"
export {
  type LoadedMission,
  loadMission,
  type MissionPaths,
  missionPaths,
  newRunId,
  readMemory,
  runPaths,
} from "./mission.ts"
export { type BuildPromptOptions, buildProposalPrompt } from "./prompt.ts"
export {
  buildBrief,
  buildContract,
  type MissionPlan,
  planMission,
  type WriteMissionOptions,
  type WriteMissionResult,
  writeMission,
} from "./scaffold.ts"
export {
  type CapturePatchOptions,
  capturePatch,
  type LineageStep,
  lineage,
  type StepPatch,
  type StepSummary,
  summariseSteps,
} from "./steps.ts"

export {
  EXECUTABLE_PATHS,
  type GeneratedFile,
  harnessFiles,
  instanceFiles,
  templateCommands,
} from "./templates.ts"

export { diffTrees, hashMutableTree, restore, snapshot } from "./workspace.ts"
