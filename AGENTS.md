# auto — agent guide

Read this before working in `auto/`. It generalises the Karpathy/DGM autoresearch loop:
the same propose→measure→gate→keep cycle, with the domain removed and the safeguards
made mandatory rather than aspirational.

## What this is

A CLI (later: Claude Code / Codex plugin, later still: cloud monitoring) that lets someone
stand up a Karpathy-style autoresearch agent for **any** domain in about two minutes. It
does not do the research. It builds the apparatus around the research and refuses to let
you start without a verifier.

## The load-bearing idea

**The evaluator interview is the product.** The loop is ~350 lines and unremarkable. What
makes `auto` worth anything is that `auto init` will not write a mission until the
operator has declared a holdout, a null control, and a cheat surface — the three things
that separate a real result from a night spent climbing a fake hill.

If you are adding a feature, ask whether it strengthens or weakens that. Convenience that
lets someone skip the interview is a regression, not a feature.

## Non-negotiable invariants

These are enforced in code and covered by tests. Changing any of them needs a real
argument, not a refactor:

1. **The evaluator is a subprocess, never an LLM call from `auto`.** The thing being
   optimised and the thing measuring must not share a brain. An LLM judge may live
   *inside* the evaluator command; `auto` only reads its exit code and JSON.
2. **Baseline before agency.** The harness scores the scaffold end-to-end before an agent
   is allowed to touch anything.
3. **Integrity is checked after the agent's turn and *before* the evaluator runs.**
   Reversing these means scoring a tampered harness and discovering it afterwards.
4. **Gates are checked before scores.** A hard constraint that a good score can outbid is
   decoration.
5. **A missing gate metric is a breach, not a pass.** Silently ignoring an absent metric
   is how a safety constraint quietly stops being enforced.
6. **A non-zero evaluator exit is a crash, not a score of zero.** A measurement that did
   not run carries no information about the candidate.
7. **Discards are reverted for real** — including files the candidate added.
8. **The agent's self-report is never trusted for what changed.** Hash the mutable tree
   before and after and diff it.
9. **The archive is append-only, and records crashes and discards.** A loop that can
   rewrite its history can delete the runs that contradict its conclusion.
10. **The null control runs on a schedule**, not when results look suspicious. A climbing
    score never looks suspicious from the inside.

## Layout

```
packages/core/src/
  contracts.ts    mission schema + validation + evaluator output parsing
  evaluator.ts    subprocess execution; every failure mode is a value, not a throw
  gates.ts        decide(): gates -> keep policy -> verdict + rationale
  integrity.ts    hash the protected tree; detect modified/deleted/ADDED
  workspace.ts    snapshot/restore the mutable tree; hash-diff to find real edits
  archive.ts      append-only JSONL, champion, parent selection
  prompt.ts       assemble the proposal prompt (includes failures, not just keeps)
  loop.ts         the engine — ordering here is the whole safety story
  mission.ts      load a mission dir; know where artifacts go
  log.ts          the human-readable decision log
  interview.ts    QUESTIONS + auditAnswers — the product
  scaffold.ts     interview answers -> files on disk
  templates.ts    runnable starter harnesses (python / node / shell)
  drivers/        AgentDriver interface + claude-cli, codex-cli, mock
packages/cli/src/ thin renderer over core; owns no logic worth testing twice
```

## Conventions

- Bun ≥ 1.3, TypeScript, biome (2-space, double quotes, no semicolons, width 100).
- **Zero runtime dependencies.** A CLI people install is easier to trust without a
  dependency tree. Keep it that way; hand-roll the small thing.
- `bun test` from the repo root. `bunx tsc -p tsconfig.json --noEmit` to typecheck.
- Tests exercise real files and real subprocesses. Only the agent is mocked — the
  safeguards are only meaningful as behaviour.

## Verifying a change

`bun test` is necessary and not sufficient. For anything touching the loop:

```bash
bun run packages/cli/src/index.ts init /tmp/check --yes
bun run packages/cli/src/index.ts doctor /tmp/check
bun run packages/cli/src/index.ts run /tmp/check --driver mock --max-iterations 3
```

with `AUTO_MOCK_COMMAND` set to something that edits `solution/`. If a change cannot be
demonstrated end-to-end, it is not verified.

## The biggest known gap

Every safeguard currently in `auto` protects against **the agent** gaming the measurement.
Nothing protects against **the loop** gaming it through repetition: 200 iterations of
hill-climbing against one holdout is 200 comparisons against the same data, and it will
eventually overfit. There is no DSR/PBO/walk-forward equivalent yet. See
`docs/roadmap.md`. If you are looking for the highest-value thing to build, it is that.

## Related

- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) — the loop's shape.
- [Hyperagents](https://arxiv.org/abs/2603.19461) — the editable meta layer `auto` lacks.
- [The Red Queen Gödel Machine](https://arxiv.org/abs/2606.26294) — co-evolving
  evaluators; reconciled with the immutable-evaluator rule in the README.
- The prime directive this tool encodes: **every surprising positive result is an artifact
  until proven otherwise, and you should be most skeptical of your own.**
