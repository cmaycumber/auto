# Roadmap

What is built, what is deliberately deferred, and where the seams are.

---

## Built and verified

**`packages/core`** — the mission contract, evaluator execution, gates, integrity hashing,
snapshot/restore, the archive, step/patch capture, and the loop. 161 tests. The loop's branches (keep,
discard, gate breach, crash, integrity halt, budget exhaustion, cancellation) are all
covered end-to-end against a real filesystem and real subprocesses, with only the agent
mocked.

**`packages/cli`** — `init`, `doctor`, `run`, `status`, `steps`, `diff`, `log`.
Zero runtime dependencies.

**Drivers** — `claude` and `codex` via their real headless CLIs, plus a `mock` driver that
runs an arbitrary script and doubles as a scripted-optimiser path.

**`missions/knapsack`** — a working example, scaffolded by `auto init --yes` and run
end-to-end with the real `claude` driver.

---

## Deferred: plugin surfaces

**Why deferred:** the loop's shape should stop moving before it gets three front doors.
Every interface added now is one to keep in sync through the changes that the first real
non-knapsack mission will force.

**The seam:** `@auto/core` is the whole product. The CLI is a thin renderer over
`runLoop()` and `planMission()`; nothing in `packages/core` knows a terminal exists. A
plugin is another caller.

**What it becomes** (`plugin/`):

- `.claude-plugin/plugin.json` with skills wrapping the same core calls —
  `/auto:init` running the interview as an `AskUserQuestion` flow rather than readline,
  `/auto:run`, `/auto:status`.
- A Codex prompt pack over the same surface.
- The interview is already declarative (`QUESTIONS` in `interview.ts`) precisely so it can
  drive a non-readline frontend without a rewrite.

**The one real design question:** a Claude Code session invoking `/auto:run` is an agent
supervising an agent. Whether the outer session should watch the loop (streaming events
back) or fire and detach (with `auto status` for check-ins) is not obvious, and picking
wrong means rebuilding the plugin. Detached is the better default guess — an
hours-long loop should not hold a session hostage — but that is a guess.

---

## Deferred: cloud monitoring

**Why deferred:** monitoring is worth building once there is something worth watching —
a long multi-day run whose results you care about. Building the dashboard before the first
real mission means guessing at what matters on it.

**The seam:** every artifact a monitor needs is already on disk in a stable, documented
format:

| Artifact | Path | Shape |
|---|---|---|
| Archive | `archive/entries.jsonl` | append-only JSONL, one `ArchiveEntry` per candidate |
| Decision log | `runs/<id>/decision-log.md` | markdown narrative |
| Evaluations | `runs/<id>/evaluations/iteration-NNNN.json` | raw evaluator output |
| Integrity | `runs/<id>/integrity.json` | the protected-tree manifest |
| Transcripts | `runs/<id>/transcripts/` | full agent output per iteration |
| Steps | `runs/<id>/steps/iteration-NNNN.patch` | unified diff of what each step changed |

Append-only JSONL was chosen partly for this: a sync agent tails the archive and ships
new lines. No schema migration, no database, no coupling to the loop.

**What it becomes** (`cloud/`, SST on AWS, matching `ore`/`sose`/`web`):

- A sync daemon (`auto push`) tailing `archive/entries.jsonl` → S3/DynamoDB.
- A run registry keyed by mission slug + run id.
- A Next.js dashboard: score-over-iteration, verdict breakdown, null-control history,
  live decision log.
- Push on integrity violation and on null-control breach — the two events an operator
  genuinely needs to know about while asleep.

**Deliberately not planned:** running the loop itself in the cloud. The loop drives a
locally authenticated coding agent; moving execution to a server means solving credential
delegation for someone else's Claude/Codex subscription, which is a product decision, not
an infrastructure one.

---

## Known gaps in what is built

Honest list of things the current implementation does not do:

- **No meta-layer.** The Hyperagents line of work (DGM-H) lets the agent edit its own
  proposal strategy, which is the part that compounds. `auto` has a
  fixed proposer and a fixed parent selector. Adding it means a second mutable tree and a
  second keep policy scored over N children — worth doing, and worth doing after the
  single-layer version has been used in anger.
- **Parent selection is recency-weighted random, not MAP-Elites.** No niching, so a run
  can still collapse toward one family of solutions. The `explorationRate` knob is a blunt
  instrument.
- **`memory.md` is read but never written.** The prompt includes it; nothing appends to
  it. A reflection step after each iteration is the obvious next addition and is where
  cross-iteration learning would come from.
- **No resume.** A killed run starts a new run id. The archive carries across (so the
  champion survives), but snapshots are per-run and gitignored, so the parent tree may not
  be restorable. `resolveParent` handles this by falling back, but it is a fallback, not
  a resume.
- **`maxRuntimeSeconds` is a soft ceiling.** It is checked at the top of each iteration,
  so an iteration already in flight when the deadline passes runs to completion — worst
  case `maxRuntime + iterationTimeout + evaluatorTimeout`. Deliberate (killing an agent
  mid-edit leaves the tree in a state nothing describes), but it means "stop after 8
  hours" can mean 8h20m. SIGINT aborts in-flight work if you need it sooner.
- **No multiplicity correction.** Partially addressed: `generalisationGapMetric` now tracks
  the SpecBench-style Δ across a run and flags a gap that widens while the score climbs
  (`generalisation.ts`). That catches overfitting *when the mission reports a gap metric*.
  Still missing is the statistical half — the DSR / PBO / walk-forward family used in
  quantitative finance, which corrects for the fact that 200 iterations of hill-climbing
  against one holdout is 200 comparisons against the same data. Also missing: an attempt
  registry with a binomial note (`P(≥passes | attempts, p₀)`) so search multiplicity is
  accounted in the open.
- **No LLM judge.** EvilGenie found LLM judges outperformed held-out tests at *detecting*
  reward hacking. `auto` permits a judge inside an evaluator command but ships none, and
  has no notion of a judge as a distinct, separately-validated component.

The multiplicity item deserves emphasis. `auto` now has one signal against the *loop*
gaming its own measurement (the gap trend) and none of the statistical machinery. Every
other safeguard protects against the *agent*.
