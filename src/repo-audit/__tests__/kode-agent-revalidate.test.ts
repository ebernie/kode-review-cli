/**
 * Tests for engines/kode-agent-revalidate.ts.
 *
 * The wrapper's job is to:
 *   1. Build a revalidation prompt + persona system prompt.
 *   2. Invoke runAgenticReview.
 *   3. Parse the response.
 *   4. Filter to known findingIds; warn-and-drop hallucinated ones.
 *   5. Warn on duplicate verdicts within one block (last-wins).
 *
 * (1) and (2) are exercised end-to-end via the orchestrator test. Here we
 * focus on (3)/(4)/(5) — the filtering logic in the wrapper that mocks at
 * the orchestrator level cannot see.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runAgenticReview: vi.fn(),
}))

vi.mock('../../review/engine.js', () => ({
  runAgenticReview: mocks.runAgenticReview,
}))

import { revalidateFeatureGroupWithAgent } from '../engines/kode-agent-revalidate.js'
import { REVALIDATIONS_FENCE_TAG } from '../revalidation-schema.js'
import { resolveReviewer } from '../../reviewers/registry.js'
import type { FeatureRecord, RepoFindingRecord } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-engine-reval-'))
  mocks.runAgenticReview.mockReset()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: 'feat-a',
    title: 'feat-a',
    summary: 's',
    kind: 'unknown',
    source: 'heuristic',
    confidence: 'high',
    entrypoints: [],
    ownedFiles: [],
    contextFiles: [],
    tests: [],
    tags: [],
    trustBoundaries: [],
    status: 'pending',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

function makeRecord(overrides: Partial<RepoFindingRecord> = {}): RepoFindingRecord {
  return {
    schemaVersion: 1,
    findingId: 'fid-a',
    featureId: 'feat-a',
    persona: 'general',
    status: 'open',
    finding: {
      severity: 'HIGH',
      category: 'security',
      confidence: 'HIGH',
      title: 't',
      file: 'src/foo.ts',
      lineStart: 1,
      lineEnd: 1,
      evidence: 'e',
      problem: 'p',
      recommendation: 'r',
    },
    createdByRunId: 'run-original',
    createdAt: '2026-05-18T10:00:00.000Z',
    updatedAt: '2026-05-18T10:00:00.000Z',
    ...overrides,
  }
}

function buildAgenticResult(body: string) {
  return {
    content: '```' + REVALIDATIONS_FENCE_TAG + '\n' + body + '\n```',
    toolCallCount: 0,
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    findings: [],
  }
}

describe('revalidateFeatureGroupWithAgent — verdict filtering', () => {
  it('drops verdicts for findingIds the orchestrator did not ask about (hallucinated)', async () => {
    await writeFileAt('src/foo.ts', 'x\n')
    mocks.runAgenticReview.mockResolvedValue(
      buildAgenticResult(JSON.stringify({
        revalidations: [
          { findingId: 'fid-a', verdict: 'fixed' },
          { findingId: 'fid-hallucinated', verdict: 'fixed' },
        ],
      })),
    )

    const result = await revalidateFeatureGroupWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      openFindings: [makeRecord({ findingId: 'fid-a' })],
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
    })

    // Only the expected findingId survives.
    expect(Array.from(result.verdicts.keys())).toEqual(['fid-a'])
    expect(result.verdicts.get('fid-a')?.verdict).toBe('fixed')
    expect(result.blockParsed).toBe(true)
  })

  it('keeps the last verdict when the agent emits duplicates for the same findingId', async () => {
    await writeFileAt('src/foo.ts', 'x\n')
    mocks.runAgenticReview.mockResolvedValue(
      buildAgenticResult(JSON.stringify({
        revalidations: [
          { findingId: 'fid-a', verdict: 'still-present' },
          { findingId: 'fid-a', verdict: 'fixed' }, // duplicate — should win
        ],
      })),
    )

    const result = await revalidateFeatureGroupWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      openFindings: [makeRecord({ findingId: 'fid-a' })],
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
    })

    expect(result.verdicts.get('fid-a')?.verdict).toBe('fixed')
    expect(result.verdicts.size).toBe(1)
  })

  it('reports blockParsed=false when the agent emits no kode-revalidations block', async () => {
    await writeFileAt('src/foo.ts', 'x\n')
    mocks.runAgenticReview.mockResolvedValue({
      content: 'Agent narrative with no structured block.',
      toolCallCount: 0,
      truncated: false,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      findings: [],
    })

    const result = await revalidateFeatureGroupWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      openFindings: [makeRecord({ findingId: 'fid-a' })],
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
    })

    expect(result.blockParsed).toBe(false)
    expect(result.blockError).toBe('missing')
    expect(result.verdicts.size).toBe(0)
  })

  it('reports blockParsed=false when JSON is malformed', async () => {
    await writeFileAt('src/foo.ts', 'x\n')
    mocks.runAgenticReview.mockResolvedValue(buildAgenticResult('{ not valid json'))

    const result = await revalidateFeatureGroupWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      openFindings: [makeRecord({ findingId: 'fid-a' })],
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
    })

    expect(result.blockParsed).toBe(false)
    expect(result.blockError).toBe('invalid-json')
    expect(result.verdicts.size).toBe(0)
  })

  it('threads systemPrompt + userPromptOverride into runAgenticReview', async () => {
    await writeFileAt('src/foo.ts', 'x\n')
    mocks.runAgenticReview.mockResolvedValue(
      buildAgenticResult(JSON.stringify({ revalidations: [] })),
    )

    await revalidateFeatureGroupWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      openFindings: [makeRecord({ findingId: 'fid-a' })],
      repoRoot: tmp,
      repoUrl: 'https://x.test/r.git',
    })

    expect(mocks.runAgenticReview).toHaveBeenCalledOnce()
    const callArg = mocks.runAgenticReview.mock.calls[0][0]
    // Persona prompt + revalidation-mode suffix concatenated.
    expect(callArg.systemPrompt).toContain('REVALIDATION MODE')
    // User-prompt override carries the revalidation body (not the audit body).
    expect(callArg.userPromptOverride).toContain('## Revalidation Mode')
    expect(callArg.userPromptOverride).toContain('## Findings to Revalidate')
    // Override is set — caller controls the body entirely.
    expect(callArg.userPromptOverride).toBeDefined()
  })
})
