/**
 * Tracking the generalisation gap across a run.
 *
 * Every other safeguard in `auto` is per-iteration: gates, integrity, the null control.
 * They catch a *candidate* that is wrong. None of them catches the loop itself slowly
 * fitting the holdout over two hundred iterations, because every individual iteration
 * looks fine — the score went up, no gate was breached, nothing was tampered with.
 *
 * The signal that does catch it is the trend in the gap between the data the loop
 * optimised against and data it did not. SpecBench (arXiv:2605.21384) formalises this as
 * Δ = s_val − s_test and finds it the most effective available reward-hacking detector:
 * frontier agents saturate visible tests at ~95% while held-out performance diverges.
 *
 * A gap that is flat across a run is evidence the improvements are real. A gap that opens
 * as the score climbs is the signature of a loop learning the holdout — and it is
 * invisible to everything else `auto` does.
 */

import type { ArchiveEntry } from "./archive.ts"

export interface GapReading {
  iteration: number
  score: number | null
  gap: number
}

export interface GapTrend {
  metric: string
  baseline: GapReading | null
  champion: GapReading | null
  /** Widest gap seen in any kept candidate. */
  worst: GapReading | null
  /** champion.gap − baseline.gap. Positive means the gap opened over the run. */
  drift: number | null
  /** True when the gap opened materially while the score was climbing. */
  suspicious: boolean
  message: string
}

/**
 * How much the gap may widen before it is worth calling out.
 *
 * Deliberately not zero: a gap wanders a little from sampling noise alone, and a warning
 * that fires on every run is a warning nobody reads. This is a heuristic threshold on an
 * absolute metric difference, so a mission whose gap metric lives on a different scale
 * should gate on it directly rather than rely on this.
 */
const DRIFT_THRESHOLD = 0.02

export function analyseGapTrend(
  entries: ArchiveEntry[],
  metric: string,
  higherIsBetter: boolean,
): GapTrend {
  const read = (entry: ArchiveEntry): GapReading | null => {
    const gap = entry.metrics?.[metric]
    return gap === undefined ? null : { iteration: entry.iteration, score: entry.score, gap }
  }

  const kept = entries.filter((entry) => entry.verdict === "keep")
  const readings = kept.map(read).filter((r): r is GapReading => r !== null)

  if (readings.length === 0) {
    return {
      metric,
      baseline: null,
      champion: null,
      worst: null,
      drift: null,
      suspicious: false,
      message: `No kept candidate reported \`${metric}\`, so the generalisation gap could not be tracked.`,
    }
  }

  const baseline = readings[0] as GapReading
  const best = kept.reduce(
    (acc, entry) => {
      if (entry.score === null) return acc
      if (acc === null || acc.score === null) return entry
      return (higherIsBetter ? entry.score > acc.score : entry.score < acc.score) ? entry : acc
    },
    null as ArchiveEntry | null,
  )

  const champion = best ? read(best) : null
  const worst = readings.reduce((acc, r) => (r.gap > acc.gap ? r : acc), readings[0] as GapReading)
  const drift = champion === null ? null : champion.gap - baseline.gap

  const scoreImproved =
    champion?.score != null &&
    baseline.score != null &&
    (higherIsBetter ? champion.score > baseline.score : champion.score < baseline.score)

  const suspicious = drift !== null && drift > DRIFT_THRESHOLD && Boolean(scoreImproved)

  return {
    metric,
    baseline,
    champion,
    worst,
    drift,
    suspicious,
    message: suspicious
      ? `The generalisation gap (\`${metric}\`) widened from ${fmt(baseline.gap)} at baseline ` +
        `to ${fmt(champion?.gap ?? 0)} at the champion while the score improved. That is the ` +
        "signature of a loop fitting the holdout rather than solving the problem: each " +
        "iteration looked fine, and the set of them did not. Re-score the champion on data " +
        "no iteration has touched before believing this run."
      : drift === null
        ? `Generalisation gap at baseline: ${fmt(baseline.gap)}. No champion gap to compare.`
        : `Generalisation gap held steady (${fmt(baseline.gap)} → ${fmt(champion?.gap ?? 0)}, ` +
          `drift ${drift >= 0 ? "+" : ""}${fmt(drift)}). The improvement is not explained by ` +
          "the loop learning the holdout.",
  }
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}
