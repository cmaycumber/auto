import { describe, expect, test } from "bun:test"
import type { ArchiveEntry } from "../archive.ts"
import { analyseGapTrend } from "../generalisation.ts"

function entry(
  iteration: number,
  score: number | null,
  gap: number | undefined,
  verdict: ArchiveEntry["verdict"] = "keep",
): ArchiveEntry {
  return {
    iteration,
    runId: "run-1",
    parent: iteration === 0 ? null : iteration - 1,
    verdict,
    score,
    pass: true,
    metrics: gap === undefined ? {} : { gen_gap: gap },
    description: "",
    rationale: "",
    snapshot: null,
    durationMs: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("analyseGapTrend", () => {
  test("flags a gap that opens while the score climbs", () => {
    // The exact failure no per-iteration check catches: every step looked fine, the
    // score went up every time, and the loop was learning the holdout.
    const entries = [entry(0, 0.5, 0.001), entry(1, 0.6, 0.01), entry(2, 0.7, 0.06)]

    const trend = analyseGapTrend(entries, "gen_gap", true)
    expect(trend.suspicious).toBe(true)
    expect(trend.drift).toBeCloseTo(0.059, 3)
    expect(trend.message).toContain("fitting the holdout")
  })

  test("stays quiet when the gap holds steady", () => {
    const entries = [entry(0, 0.5, 0.01), entry(1, 0.7, 0.012)]
    const trend = analyseGapTrend(entries, "gen_gap", true)

    expect(trend.suspicious).toBe(false)
    expect(trend.message).toContain("held steady")
  })

  test("does not flag a widening gap when the score did not improve", () => {
    // A gap that moves without the score moving is noise, not overfitting — there is
    // no improvement being explained away.
    const entries = [entry(0, 0.9, 0.001), entry(1, 0.5, 0.09)]
    expect(analyseGapTrend(entries, "gen_gap", true).suspicious).toBe(false)
  })

  test("tolerates small drift without crying wolf", () => {
    // A warning that fires every run is a warning nobody reads.
    const entries = [entry(0, 0.5, 0.01), entry(1, 0.8, 0.025)]
    expect(analyseGapTrend(entries, "gen_gap", true).suspicious).toBe(false)
  })

  test("respects lower-is-better when picking the champion", () => {
    const entries = [entry(0, 0.9, 0.001), entry(1, 0.2, 0.08)]
    const trend = analyseGapTrend(entries, "gen_gap", false)
    expect(trend.champion?.iteration).toBe(1)
    expect(trend.suspicious).toBe(true)
  })

  test("ignores discarded and crashed candidates", () => {
    const entries = [entry(0, 0.5, 0.001), entry(1, 0.99, 0.5, "discard"), entry(2, 0.6, 0.005)]
    const trend = analyseGapTrend(entries, "gen_gap", true)
    expect(trend.champion?.iteration).toBe(2)
    expect(trend.suspicious).toBe(false)
  })

  test("reports clearly when the metric is absent", () => {
    const trend = analyseGapTrend([entry(0, 0.5, undefined)], "gen_gap", true)
    expect(trend.suspicious).toBe(false)
    expect(trend.message).toContain("could not be tracked")
  })

  test("handles an empty archive", () => {
    expect(analyseGapTrend([], "gen_gap", true).baseline).toBeNull()
  })
})
