/**
 * Tests for engines/kode-agent.ts — the default repo-scope engine.
 *
 * We mock `runAgenticReview` (a sibling, not the SUT) so the test exercises
 * the orchestration logic without hitting pi. The SUT is `reviewFeatureWithAgent`:
 * its job is to build the right prompt + system prompt and pass them through,
 * then cap findings.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted to the top of the file; use vi.hoisted so the spy
// reference is available inside the factory.
const { runAgenticReviewMock } = vi.hoisted(() => ({
  runAgenticReviewMock: vi.fn(),
}))
vi.mock('../../review/engine.js', () => ({
  runAgenticReview: runAgenticReviewMock,
}))

import type { Finding } from '../../review/finding-schema.js'
import { resolveReviewer } from '../../reviewers/registry.js'
import { reviewFeatureWithAgent } from '../engines/kode-agent.js'
import { FEATURE_REVIEW_MODE_SUFFIX } from '../prompts.js'
import { REPO_AUDIT_DEFAULTS, type FeatureRecord } from '../types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kode-review-engine-'))
  runAgenticReviewMock.mockReset()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function makeFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: 'pkg-foo',
    title: 'foo',
    summary: 's',
    kind: 'library',
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

function mockFinding(title: string, file = 'src/foo.ts', line = 1): Finding {
  return {
    severity: 'MEDIUM',
    category: 'maintainability',
    confidence: 'MEDIUM',
    title,
    file,
    lineStart: line,
    lineEnd: line,
    evidence: 'x',
    problem: 'p',
    recommendation: 'r',
  }
}

async function writeFileAt(rel: string, body: string): Promise<void> {
  const abs = join(tmp, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body)
}

describe('reviewFeatureWithAgent — orchestration', () => {
  it('appends FEATURE_REVIEW_MODE_SUFFIX after the persona system prompt (order matters)', async () => {
    runAgenticReviewMock.mockResolvedValue({
      content: '...',
      findings: [],
      usage: {} as unknown,
      truncated: false,
      toolCallCount: 0,
    })
    const persona = resolveReviewer('general')
    // Independently load the persona template so the test does not depend on
    // the SUT's internal call to loadReviewerSystemPrompt — if the SUT used
    // the wrong persona's prompt, the prefix check below would fail.
    const personaText = (await import('node:fs')).readFileSync(persona.templatePath, 'utf-8').trim()

    await reviewFeatureWithAgent({
      feature: makeFeature(),
      persona,
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
    })
    expect(runAgenticReviewMock).toHaveBeenCalledOnce()
    const call = runAgenticReviewMock.mock.calls[0]?.[0]
    // Suffix MUST be at the end — guards against reversed concatenation.
    expect(call.systemPrompt.endsWith(FEATURE_REVIEW_MODE_SUFFIX)).toBe(true)
    // A known phrase from the persona template must appear before the suffix.
    const knownPhrase = personaText.slice(0, 60)
    const suffixStart = call.systemPrompt.indexOf(FEATURE_REVIEW_MODE_SUFFIX)
    const beforeSuffix = call.systemPrompt.slice(0, suffixStart)
    expect(beforeSuffix).toContain(knownPhrase)
  })

  it('uses the buildFeatureReviewPrompt output as userPromptOverride', async () => {
    await writeFileAt('src/foo.ts', 'export const x = 1\n')
    runAgenticReviewMock.mockResolvedValue({
      content: '',
      findings: [],
      usage: {} as unknown,
      truncated: false,
      toolCallCount: 0,
    })
    await reviewFeatureWithAgent({
      feature: makeFeature({
        ownedFiles: [{ path: 'src/foo.ts', reason: 'impl' }],
      }),
      persona: resolveReviewer('general'),
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
    })
    const call = runAgenticReviewMock.mock.calls[0]?.[0]
    expect(call.userPromptOverride).toContain('## Feature Under Review')
    expect(call.userPromptOverride).toContain('export const x = 1')
  })

  it('forwards repoRoot, repoUrl, branch, indexerUrl, and model unchanged', async () => {
    runAgenticReviewMock.mockResolvedValue({
      content: '',
      findings: [],
      usage: {} as unknown,
      truncated: false,
      toolCallCount: 0,
    })
    await reviewFeatureWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
      branch: 'feat/x',
      indexerUrl: 'http://localhost:8321',
      model: 'anthropic/claude-sonnet-4-6',
      maxIterations: 8,
      timeoutSec: 300,
    })
    const call = runAgenticReviewMock.mock.calls[0]?.[0]
    expect(call.repoRoot).toBe(tmp)
    expect(call.repoUrl).toBe('https://example.com/foo.git')
    expect(call.branch).toBe('feat/x')
    expect(call.indexerUrl).toBe('http://localhost:8321')
    expect(call.model).toBe('anthropic/claude-sonnet-4-6')
    expect(call.maxIterations).toBe(8)
    expect(call.timeout).toBe(300)
    // diffContent + context are required by AgenticReviewOptions; check the
    // placeholders the SUT documents are passed through.
    expect(call.diffContent).toBe('')
    expect(call.context).toContain('pkg-foo')
  })

  it('caps findings at MAX_FINDINGS_PER_FEATURE even if the model returns more', async () => {
    const tooMany = Array.from(
      { length: REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE + 5 },
      (_, i) => mockFinding(`t${i}`),
    )
    runAgenticReviewMock.mockResolvedValue({
      content: '',
      findings: tooMany,
      usage: {} as unknown,
      truncated: false,
      toolCallCount: 0,
    })
    const result = await reviewFeatureWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
    })
    expect(result.findings).toHaveLength(REPO_AUDIT_DEFAULTS.MAX_FINDINGS_PER_FEATURE)
    expect(result.findings[0]?.title).toBe('t0')
  })

  it('preserves truncation info from the underlying engine', async () => {
    runAgenticReviewMock.mockResolvedValue({
      content: '',
      findings: [],
      usage: {} as unknown,
      truncated: true,
      truncationReason: 'Max iterations reached',
      toolCallCount: 10,
    })
    const result = await reviewFeatureWithAgent({
      feature: makeFeature(),
      persona: resolveReviewer('general'),
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
    })
    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toBe('Max iterations reached')
  })

  it('returns the original feature and persona in the result for downstream rendering', async () => {
    runAgenticReviewMock.mockResolvedValue({
      content: '',
      findings: [],
      usage: {} as unknown,
      truncated: false,
      toolCallCount: 0,
    })
    const feature = makeFeature({ featureId: 'pkg-bar' })
    const persona = resolveReviewer('security')
    const result = await reviewFeatureWithAgent({
      feature,
      persona,
      repoRoot: tmp,
      repoUrl: 'https://example.com/foo.git',
    })
    expect(result.feature).toBe(feature)
    expect(result.persona).toBe(persona)
  })
})
