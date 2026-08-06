/**
 * The mission contract.
 *
 * A mission is the unit `auto` operates on: one measurable goal, one evaluator that
 * scores it, and an explicit statement of everything that could make a good score a lie.
 *
 * The shape is deliberately opinionated. `auto init` refuses to write a mission that
 * has no holdout, no null control, and no protected paths, because those three are the
 * only things standing between "the loop improved the score" and "the loop learned to
 * cheat the scorer". Every field below that looks like paranoia was paid for by a real
 * dead strategy.
 */

export const MISSION_VERSION = 1 as const

/** Comparison operators available to hard gates. */
export type GateOp = "lte" | "gte" | "lt" | "gt"

/**
 * A hard floor. Gates are checked BEFORE score comparison and are absolute: a candidate
 * that breaches one is discarded no matter how good its score is. This is the
 * "max drawdown <= 20%" rule generalised — the thing that stops the loop from finding a
 * degenerate optimum that technically maximises the metric.
 */
export interface Gate {
  /** Key to look up in the evaluator's `metrics` object. */
  metric: string
  op: GateOp
  value: number
  /** Human-readable why. Shown on discard so the log explains itself. */
  reason: string
}

/** What the loop does with a candidate that clears every gate. */
export type KeepPolicy =
  /** Keep only if the score beats the parent's. The default; drives a hill-climb. */
  | "score_improvement"
  /** Keep any candidate where `pass === true`. For missions with a binary target. */
  | "pass_only"

export interface EvaluatorContract {
  /** Shell command run from the mission directory. Must print a JSON object to stdout. */
  command: string
  /** Only `json` in v1 — the wire format is `{ pass, score?, metrics?, notes? }`. */
  format: "json"
  timeoutSeconds: number
  keepPolicy: KeepPolicy
  /** False for metrics like error rate or latency where lower wins. */
  higherIsBetter: boolean
  /**
   * The smallest score improvement worth keeping. A candidate must beat its parent by
   * more than this, not merely beat it.
   *
   * **Use this only when the evaluator's noise is irreducible** — wall-clock timing, a
   * physical measurement, a sampled benchmark you cannot cheaply enlarge. It is the right
   * tool there and the wrong tool everywhere else.
   *
   * It is NOT a general answer to multiplicity, and this repo has the receipt. In
   * `missions/search-strategy`, the loop made five keeps of +0.006 to +0.013 each, none
   * individually resolvable by a 40-sample evaluator whose CI half-width was 0.0137. They
   * compounded into an effect that is real at p < 0.000001 on 400 fresh landscapes.
   * Setting `minimumEffect` to that measured noise floor would have rejected every one of
   * them and the run would have found nothing.
   *
   * When increments are smaller than your evaluator can resolve, the fix is a better
   * evaluator (noise falls as 1/sqrt(n)) or a final champion re-scored on a never-touched
   * split — not a bar that rejects real work along with the noise.
   */
  minimumEffect?: number
}

/**
 * The null control: the same evaluator run against a deliberately signal-free variant
 * (shuffled labels, randomised decisions, a constant baseline).
 *
 * This is the single highest-value field in the contract. If the null scores as well as
 * the real solution, the metric is measuring something other than skill and every
 * improvement the loop reports is noise. `auto` runs it on a schedule and screams rather
 * than quietly letting you climb a fake hill.
 */
export interface NullControl {
  command: string
  /**
   * Iterations between null re-runs. The null is usually as expensive as a real
   * evaluation, so re-running it every iteration doubles cost for little extra signal.
   */
  everyNIterations: number
  /**
   * If the null's score gets within this fraction of the champion's, the run is flagged
   * `null_control_breach`. Expressed as a fraction of the champion score's magnitude.
   */
  alarmWithinFraction: number
}

/** How the out-of-sample data is kept away from the thing being optimised. */
export type HoldoutEnforcement =
  /** Held-out data lives at a path the mutable solution cannot read. Strongest. */
  | "path_isolation"
  /** A time boundary the evaluator enforces. Standard for anything with a timestamp. */
  | "time_split"
  /** Declared but not mechanically enforced. Allowed, but `auto doctor` warns. */
  | "manual"

export interface Holdout {
  description: string
  enforcedBy: HoldoutEnforcement
  /** Paths the solution must never read. Enforced by the sandbox, not by good intentions. */
  hiddenPaths: string[]
}

export interface Budget {
  maxIterations: number
  /**
   * Total wall-clock ceiling — a SOFT one. It is checked at the top of each iteration, so
   * an iteration already in flight when the deadline passes runs to completion. Worst
   * case is therefore `maxRuntimeSeconds + iterationTimeoutSeconds +
   * evaluator.timeoutSeconds`.
   *
   * Deliberate: killing an agent turn mid-edit would leave the mutable tree in a state
   * neither the archive nor the snapshots describe. Size the two timeouts accordingly if
   * you need a hard stop — or send SIGINT, which aborts the in-flight work directly.
   */
  maxRuntimeSeconds: number
  /** Wall-clock ceiling for a single propose+evaluate cycle. Overrun counts as a crash. */
  iterationTimeoutSeconds: number
}

export type DriverProvider = "claude" | "codex" | "mock"

export interface DriverConfig {
  provider: DriverProvider
  model?: string
  /** Extra argv appended to the underlying CLI invocation. */
  extraArgs?: string[]
}

export interface MissionMetric {
  name: string
  description: string
}

export interface AutoMission {
  version: typeof MISSION_VERSION
  slug: string
  title: string
  /** Free text: "prediction markets", "logistics", "ad creative", "protein binders". */
  domain: string
  metric: MissionMetric
  evaluator: EvaluatorContract
  nullControl?: NullControl
  gates: Gate[]
  holdout: Holdout
  /**
   * The cheat surface, inverted. Everything the agent must not touch: the evaluator,
   * the held-out data, the gates themselves. Hashed at run start; a mismatch halts
   * the loop rather than silently accepting a tampered measurement.
   */
  protectedPaths: string[]
  /** Everything the agent may edit. Anything outside this set is rejected. */
  mutablePaths: string[]
  /**
   * Name of a metric the evaluator reports representing the **generalisation gap** —
   * the score on data the loop optimised against, minus the score on data it did not.
   *
   * SpecBench (arXiv:2605.21384) formalises this as Δ = s_val − s_test and finds it is
   * the most effective available signal for reward hacking: frontier agents saturate the
   * visible tests at ~95% while held-out performance diverges, with the gap widening
   * ~27 points per 10× increase in code size.
   *
   * Declaring it here lets `auto` track the gap's *trend* across a run, which is the part
   * a single gate cannot catch. A gap that is small at baseline and large at the champion
   * means the loop overfitted — the failure mode that no per-iteration check detects,
   * because each individual iteration looked fine.
   */
  generalisationGapMetric?: string
  budget: Budget
  driver: DriverConfig
}

/** The wire format every evaluator must print to stdout. */
export interface EvaluatorResult {
  pass: boolean
  score?: number
  metrics?: Record<string, number>
  notes?: string
}

// ---------------------------------------------------------------------------
// Validation
//
// Hand-rolled rather than schema-library-driven: the error messages are the UX here.
// A mission that fails validation should tell you which field and what a good value
// looks like, because it is usually a human editing auto.json by hand at 2am.
// ---------------------------------------------------------------------------

export class ContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContractError"
  }
}

function fail(field: string, expected: string): never {
  throw new ContractError(`auto.json: \`${field}\` ${expected}`)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(field, "must be an object.")
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(field, "must be a non-empty string.")
  }
  return value.trim()
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, "must be a finite number.")
  }
  return value
}

function asPositiveNumber(value: unknown, field: string): number {
  const n = asNumber(value, field)
  if (n <= 0) fail(field, "must be greater than zero.")
  return n
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "must be a boolean.")
  return value
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field, "must be an array of strings.")
  return value.map((entry, i) => asString(entry, `${field}[${i}]`))
}

function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const raw = asString(value, field)
  if (!(allowed as readonly string[]).includes(raw)) {
    fail(field, `must be one of: ${allowed.join(", ")}.`)
  }
  return raw as T
}

const GATE_OPS = ["lte", "gte", "lt", "gt"] as const
const KEEP_POLICIES = ["score_improvement", "pass_only"] as const
const HOLDOUT_ENFORCEMENTS = ["path_isolation", "time_split", "manual"] as const
const DRIVER_PROVIDERS = ["claude", "codex", "mock"] as const

function parseGate(raw: unknown, field: string): Gate {
  const obj = asRecord(raw, field)
  return {
    metric: asString(obj.metric, `${field}.metric`),
    op: asEnum(obj.op, `${field}.op`, GATE_OPS),
    value: asNumber(obj.value, `${field}.value`),
    reason: asString(obj.reason, `${field}.reason`),
  }
}

function parseEvaluator(raw: unknown): EvaluatorContract {
  const obj = asRecord(raw, "evaluator")
  const format = asString(obj.format, "evaluator.format").toLowerCase()
  if (format !== "json") {
    fail("evaluator.format", "must be `json` in v1.")
  }
  const contract: EvaluatorContract = {
    command: asString(obj.command, "evaluator.command"),
    format: "json",
    timeoutSeconds: asPositiveNumber(obj.timeoutSeconds, "evaluator.timeoutSeconds"),
    keepPolicy: asEnum(obj.keepPolicy, "evaluator.keepPolicy", KEEP_POLICIES),
    higherIsBetter: asBoolean(obj.higherIsBetter, "evaluator.higherIsBetter"),
  }

  if (obj.minimumEffect !== undefined) {
    const minimumEffect = asNumber(obj.minimumEffect, "evaluator.minimumEffect")
    if (minimumEffect < 0) fail("evaluator.minimumEffect", "must be zero or greater.")
    contract.minimumEffect = minimumEffect
  }

  return contract
}

function parseNullControl(raw: unknown): NullControl | undefined {
  if (raw === undefined || raw === null) return undefined
  const obj = asRecord(raw, "nullControl")
  return {
    command: asString(obj.command, "nullControl.command"),
    everyNIterations: asPositiveNumber(obj.everyNIterations, "nullControl.everyNIterations"),
    alarmWithinFraction: asPositiveNumber(
      obj.alarmWithinFraction,
      "nullControl.alarmWithinFraction",
    ),
  }
}

function parseHoldout(raw: unknown): Holdout {
  const obj = asRecord(raw, "holdout")
  return {
    description: asString(obj.description, "holdout.description"),
    enforcedBy: asEnum(obj.enforcedBy, "holdout.enforcedBy", HOLDOUT_ENFORCEMENTS),
    hiddenPaths: asStringArray(obj.hiddenPaths ?? [], "holdout.hiddenPaths"),
  }
}

function parseBudget(raw: unknown): Budget {
  const obj = asRecord(raw, "budget")
  return {
    maxIterations: asPositiveNumber(obj.maxIterations, "budget.maxIterations"),
    maxRuntimeSeconds: asPositiveNumber(obj.maxRuntimeSeconds, "budget.maxRuntimeSeconds"),
    iterationTimeoutSeconds: asPositiveNumber(
      obj.iterationTimeoutSeconds,
      "budget.iterationTimeoutSeconds",
    ),
  }
}

function parseDriver(raw: unknown): DriverConfig {
  const obj = asRecord(raw, "driver")
  const driver: DriverConfig = {
    provider: asEnum(obj.provider, "driver.provider", DRIVER_PROVIDERS),
  }
  if (obj.model !== undefined) driver.model = asString(obj.model, "driver.model")
  if (obj.extraArgs !== undefined) {
    driver.extraArgs = asStringArray(obj.extraArgs, "driver.extraArgs")
  }
  return driver
}

/**
 * Parse and validate a mission contract.
 *
 * Beyond field types this enforces two structural invariants that are easy to violate
 * by hand-editing and catastrophic in effect:
 *
 *   1. `protectedPaths` and `mutablePaths` may not overlap. An overlapping path means
 *      the agent can edit its own scorer, which makes every downstream number fiction.
 *   2. `protectedPaths` may not be empty. A mission with no cheat surface declared has
 *      not been thought about, and the loop would have nothing to hash.
 */
export function parseMission(raw: unknown): AutoMission {
  const obj = asRecord(raw, "<root>")

  const version = asNumber(obj.version, "version")
  if (version !== MISSION_VERSION) {
    fail("version", `must be ${MISSION_VERSION} (got ${version}).`)
  }

  const protectedPaths = asStringArray(obj.protectedPaths ?? [], "protectedPaths")
  const mutablePaths = asStringArray(obj.mutablePaths ?? [], "mutablePaths")

  if (protectedPaths.length === 0) {
    fail(
      "protectedPaths",
      "must list at least one path. The evaluator and any held-out data belong here — " +
        "if nothing is protected, the agent can rewrite its own scorer.",
    )
  }
  if (mutablePaths.length === 0) {
    fail("mutablePaths", "must list at least one path, or the agent has nothing to edit.")
  }

  const overlap = protectedPaths.filter((p) => mutablePaths.some((m) => pathsOverlap(p, m)))
  if (overlap.length > 0) {
    fail(
      "protectedPaths",
      `overlaps mutablePaths at: ${overlap.join(", ")}. A path cannot be both editable ` +
        "and trusted.",
    )
  }

  const mission: AutoMission = {
    version: MISSION_VERSION,
    slug: slugify(asString(obj.slug, "slug")),
    title: asString(obj.title, "title"),
    domain: asString(obj.domain, "domain"),
    metric: {
      name: asString(asRecord(obj.metric, "metric").name, "metric.name"),
      description: asString(asRecord(obj.metric, "metric").description, "metric.description"),
    },
    evaluator: parseEvaluator(obj.evaluator),
    gates: (Array.isArray(obj.gates) ? obj.gates : []).map((g, i) => parseGate(g, `gates[${i}]`)),
    holdout: parseHoldout(obj.holdout),
    protectedPaths,
    mutablePaths,
    budget: parseBudget(obj.budget),
    driver: parseDriver(obj.driver),
  }

  const nullControl = parseNullControl(obj.nullControl)
  if (nullControl) mission.nullControl = nullControl

  if (obj.generalisationGapMetric !== undefined) {
    mission.generalisationGapMetric = asString(
      obj.generalisationGapMetric,
      "generalisationGapMetric",
    )
  }

  return mission
}

/**
 * True when two declared paths refer to overlapping trees — either identical, or one a
 * directory prefix of the other. Compares normalised segments so `a/b` and `a/b/` and
 * `./a/b` are treated as the same path, and `a/b` does not spuriously match `a/bc`.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const segs = (p: string) => p.split("/").filter((s) => s !== "" && s !== ".")
  const left = segs(a)
  const right = segs(b)
  const shared = Math.min(left.length, right.length)
  if (shared === 0) return true // one side is the mission root; it contains everything
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "mission"
  )
}

/**
 * Parse evaluator stdout.
 *
 * Deliberately strict: `pass` must be a real boolean and `score` a real number. An
 * evaluator that prints `{"pass": "true"}` or `{"score": null}` is broken, and treating
 * that leniently would let a crashing measurement masquerade as a result.
 *
 * Tolerates surrounding noise (log lines, progress bars) by extracting the last balanced
 * top-level JSON object in the stream, so evaluators don't have to be silent to be valid.
 */
export function parseEvaluatorResult(raw: string): EvaluatorResult {
  const candidate = extractLastJsonObject(raw)
  if (candidate === null) {
    throw new ContractError(
      "Evaluator produced no JSON object on stdout. It must print " +
        '`{"pass": <bool>, "score": <number>, "metrics": {...}}`.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new ContractError(`Evaluator output is not valid JSON: ${truncate(candidate, 200)}`)
  }

  const obj = asRecord(parsed, "evaluator output")
  if (typeof obj.pass !== "boolean") {
    throw new ContractError("Evaluator output must include a boolean `pass`.")
  }
  if (obj.score !== undefined && (typeof obj.score !== "number" || !Number.isFinite(obj.score))) {
    throw new ContractError("Evaluator output `score` must be a finite number when present.")
  }

  const result: EvaluatorResult = { pass: obj.pass }
  if (typeof obj.score === "number") result.score = obj.score
  if (typeof obj.notes === "string") result.notes = obj.notes

  if (obj.metrics !== undefined) {
    const metricsObj = asRecord(obj.metrics, "evaluator output metrics")
    const metrics: Record<string, number> = {}
    for (const [key, value] of Object.entries(metricsObj)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ContractError(
          `Evaluator metric \`${key}\` must be a finite number (got ${JSON.stringify(value)}).`,
        )
      }
      metrics[key] = value
    }
    result.metrics = metrics
  }

  return result
}

/**
 * Scan for the last top-level `{...}` in a string, tracking string literals and escapes
 * so braces inside JSON strings don't throw off the depth count. Returns null if none.
 */
function extractLastJsonObject(raw: string): string | null {
  let depth = 0
  let start = -1
  let last: string | null = null
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === "}") {
      depth--
      if (depth === 0 && start >= 0) last = raw.slice(start, i + 1)
      if (depth < 0) depth = 0
    }
  }

  return last
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
