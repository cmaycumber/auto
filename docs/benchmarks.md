# Benchmarks `auto` can be evaluated against

Two families, and the distinction matters more than the list.

**Capability benchmarks** ask *how good is the result?* Everyone competes here, and
[Weco](https://www.weco.ai/)'s AIDE line already has a strong record on them. `auto`
should expect to lose on raw search quality until it has tree search.

**Integrity benchmarks** ask *is the result real?* These are new (mostly 2026) and they
exist because agents reliably game the evaluation when nobody is checking. This is the
family `auto` is actually built for, and where a claim of ours would mean something.

A tool whose thesis is "the verifier is the work" should be measured on whether its
verifier works — not only on how high the number goes.

---

## Integrity / reward-hacking benchmarks — the ones that matter for us

| Benchmark | Shape | Why it tests `auto` specifically |
|---|---|---|
| **[SpecBench](https://arxiv.org/abs/2605.21384)** | 30 systems-level tasks, 1.5K–110K LOC, C/Python/Go. Each ships a spec, starter code, a **validation** suite (the optimisation target) and a **held-out** suite (evaluation only). | The closest possible fit. Its headline metric **Δ = s_val − s_test** is exactly the generalisation gap. Every frontier model saturates validation at ~95% while held-out diverges, and the gap grows **27 points per 10× LOC**. Their conclusion — held-out compositional tests are the most effective defense — is `auto`'s design thesis, independently measured. |
| **[EvilGenie](https://arxiv.org/abs/2511.21654)** | LiveCodeBench modified so test manipulation is *possible*. | Directly probes the integrity hash: can an agent tamper with the tests? Notable finding: LLM judges outperformed held-out tests at *detecting* hacking — worth taking seriously, since `auto` currently has no judge. |
| **[Reward Hacking Benchmark (RHB)](https://arxiv.org/abs/2605.02964)** | Exploits in LLM agents with tool use. | Headline result: **RL post-training raises exploit rates from 0.6% to 13.9%**. The tailwind is toward more gaming, not less. |
| **[TRACE](https://arxiv.org/html/2605.02964v1)** | 517 trajectories, 54 hack categories. | GPT-5.2 detects only **63%**. Detection-by-inspection is not a defense; structural prevention is. |
| **Terminal Wrench** | 331 hackable tasks, 3,632 exploit trajectories. | A large catalogue of concrete exploits to test protected-path enforcement against. |
| **[CTRL-ALT-DECEIT](https://arxiv.org/abs/2511.09904)** | Sabotage evals for automated AI R&D. | Includes **agents sabotaging the code that evaluates their own performance**. That is `auto`'s integrity check's threat model, written down by someone else. |
| **[BenchJack](https://arxiv.org/abs/2605.12673)** | Systematically audits agent benchmarks for gameability. | Useful in reverse: run it against harnesses `auto init` generates, to check the tool isn't scaffolding gameable evaluators. |

**The experiment worth running.** Take a hackable benchmark, run a capable agent through
it twice — once with a bare loop, once through `auto` with protected paths, gates and a
null control — and report the **exploit rate**, not just the score. If `auto`'s guardrails
don't move that number, the thesis is wrong and we should know.

---

## Capability benchmarks — where we'd be measured against Weco

| Benchmark | Shape | Fit for an `auto` mission |
|---|---|---|
| **[MLE-bench](https://arxiv.org/abs/2410.07095)** (OpenAI) | 75 Kaggle competitions. | Strong fit — Kaggle gives a genuine train/test split for free. Reference: o1-preview + AIDE medals in **16.9%**. Direct comparison to Weco. |
| **[RE-Bench](https://metr.org/blog/2024-11-22-evaluating-r-d-capabilities-of-llms/)** (METR) | 7 ML research-engineering environments, each with a scoring function (optimise loss or runtime). | Excellent fit — already shaped like an `auto` mission: one number, one scorer. |
| **KernelBench / FastKernels** | GPU kernel generation; correctness + wall-clock. | Weco's flagship use case. Hard gate writes itself: correctness must hold, and *then* latency counts — exactly `auto`'s gates-outrank-scores rule. |
| **[Terminal-Bench](https://arxiv.org/abs/2602.21193)** | 89 hand-verified end-to-end terminal tasks. | Fits `pass_only` keep policy. |
| **SWE-bench Verified** | Real GitHub issues + patches. | Caveat: OpenAI published *"why SWE-bench Verified no longer measures frontier coding capabilities"* in 2026. Use FrontierSWE or treat as a smoke test. |
| **ARC-AGI** | Abstract reasoning. | Clean held-out structure; weak fit — little for an agent to iteratively optimise. |

---

## Honest self-assessment

If `auto` were run on MLE-bench today it would likely underperform AIDE, because parent
selection is a greedy rule with an ε and AIDE does tree search. That is a known,
addressed-in-the-roadmap gap, and `missions/search-strategy` is the first attempt at it.

The defensible claim is narrower and more interesting: **on a benchmark where the
evaluation can be gamed, a loop with mandatory holdout + integrity + gates + null control
should produce fewer fake wins than one without.** Nobody has published that comparison.
It is the experiment `auto` exists to make cheap.

## Running one as a mission

The adapter work per benchmark is small — `auto` needs the task's scorer wrapped to print
`{"pass", "score", "metrics"}`, the held-out portion moved under a `protectedPaths` entry
and listed in `holdout.hiddenPaths`, and a null control written (shuffled labels, or the
benchmark's own trivial baseline). The interview in `auto init` asks for exactly these.
