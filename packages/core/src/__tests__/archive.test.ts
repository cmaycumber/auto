import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArchiveEntry,
  appendEntry,
  champion,
  readArchive,
  selectParent,
  summarise,
} from "../archive.ts"

function entry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    iteration: 1,
    runId: "run-1",
    parent: 0,
    verdict: "keep",
    score: 1,
    pass: true,
    metrics: {},
    description: "a change",
    rationale: "improved",
    snapshot: "runs/run-1/snapshots/1",
    durationMs: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("readArchive / appendEntry", () => {
  let dir: string
  let archivePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auto-archive-"))
    archivePath = join(dir, "archive", "entries.jsonl")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("returns empty for a missing archive", async () => {
    expect(await readArchive(archivePath)).toEqual([])
  })

  test("round-trips entries in order", async () => {
    await appendEntry(archivePath, entry({ iteration: 1 }))
    await appendEntry(archivePath, entry({ iteration: 2 }))

    const entries = await readArchive(archivePath)
    expect(entries.map((e) => e.iteration)).toEqual([1, 2])
  })

  test("survives a truncated trailing line", async () => {
    // A process killed mid-append leaves a partial line. Refusing to read the other
    // good entries because of it would be the wrong trade.
    await appendEntry(archivePath, entry({ iteration: 1 }))
    await appendFile(archivePath, '{"iteration": 2, "verdi')

    const entries = await readArchive(archivePath)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.iteration).toBe(1)
  })
})

describe("champion", () => {
  test("returns undefined when nothing was kept", () => {
    expect(champion([entry({ verdict: "discard" })], true)).toBeUndefined()
  })

  test("picks the highest score when higher is better", () => {
    const entries = [
      entry({ iteration: 1, score: 5 }),
      entry({ iteration: 2, score: 9 }),
      entry({ iteration: 3, score: 7 }),
    ]
    expect(champion(entries, true)?.iteration).toBe(2)
  })

  test("picks the lowest score when lower is better", () => {
    const entries = [entry({ iteration: 1, score: 5 }), entry({ iteration: 2, score: 2 })]
    expect(champion(entries, false)?.iteration).toBe(2)
  })

  test("ignores discarded entries even if they scored better", () => {
    const entries = [
      entry({ iteration: 1, score: 5, verdict: "keep" }),
      entry({ iteration: 2, score: 100, verdict: "gated" }),
    ]
    expect(champion(entries, true)?.iteration).toBe(1)
  })
})

describe("selectParent", () => {
  const entries = [
    entry({ iteration: 1, score: 5 }),
    entry({ iteration: 2, score: 9 }),
    entry({ iteration: 3, score: 7 }),
  ]

  test("returns the champion when not exploring", () => {
    const parent = selectParent({
      entries,
      higherIsBetter: true,
      explorationRate: 0,
      random: () => 0.99,
    })
    expect(parent?.iteration).toBe(2)
  })

  test("returns a non-champion when exploring", () => {
    // Pure exploitation converges on a local optimum and stops finding anything.
    const parent = selectParent({
      entries,
      higherIsBetter: true,
      explorationRate: 1,
      random: () => 0,
    })
    expect(parent?.iteration).not.toBe(2)
  })

  test("returns undefined when nothing was kept", () => {
    expect(
      selectParent({
        entries: [entry({ verdict: "crash" })],
        higherIsBetter: true,
        explorationRate: 0.5,
      }),
    ).toBeUndefined()
  })

  test("falls back to the champion when it is the only kept entry", () => {
    const single = [entry({ iteration: 1, score: 5 })]
    const parent = selectParent({
      entries: single,
      higherIsBetter: true,
      explorationRate: 1,
      random: () => 0,
    })
    expect(parent?.iteration).toBe(1)
  })
})

describe("summarise", () => {
  test("counts every verdict, not just the wins", () => {
    // "best score 0.94" reads very differently next to "3 kept of 200, 140 crashed".
    const stats = summarise(
      [
        entry({ iteration: 1, verdict: "keep", score: 5 }),
        entry({ iteration: 2, verdict: "discard", score: 3 }),
        entry({ iteration: 3, verdict: "gated", score: 99 }),
        entry({ iteration: 4, verdict: "crash", score: null }),
      ],
      true,
    )

    expect(stats).toEqual({
      total: 4,
      kept: 1,
      discarded: 1,
      gated: 1,
      crashed: 1,
      bestScore: 5,
    })
  })

  test("reports a null best score when nothing was kept", () => {
    expect(summarise([entry({ verdict: "crash", score: null })], true).bestScore).toBeNull()
  })
})
