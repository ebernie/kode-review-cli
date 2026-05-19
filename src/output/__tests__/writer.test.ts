import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getFormattedContent, writeReviewOutput } from '../writer.js'
import type { ReviewOutput, StructuredReview } from '../types.js'

const mockStructuredReview: StructuredReview = {
  summary: 'Test review summary.',
  issues: [
    {
      severity: 'HIGH',
      category: 'Bug',
      title: 'Test issue',
      description: 'A test bug description.',
      confidence: 'HIGH',
    },
  ],
  positives: ['Good test coverage'],
  verdict: {
    recommendation: 'APPROVE',
    confidence: 'HIGH',
    mergeDecision: 'SAFE_TO_MERGE',
    rationale: 'No critical issues found.',
  },
  metadata: {
    timestamp: '2024-01-15T10:30:00Z',
    scope: 'local',
    agentic: false,
  },
}

const mockReviewOutput: ReviewOutput = {
  raw: '# Test Review\n\nRaw content here.',
  structured: mockStructuredReview,
}

describe('getFormattedContent', () => {
  it('returns JSON formatted content', () => {
    const content = getFormattedContent(mockReviewOutput, 'json')

    expect(() => JSON.parse(content)).not.toThrow()
    const parsed = JSON.parse(content)
    expect(parsed.summary).toBe('Test review summary.')
  })

  it('returns markdown formatted content', () => {
    const content = getFormattedContent(mockReviewOutput, 'markdown')

    expect(content).toContain('# Code Review Report')
    expect(content).toContain('Test review summary.')
  })

  it('returns text (raw) content', () => {
    const content = getFormattedContent(mockReviewOutput, 'text')

    expect(content).toBe(mockReviewOutput.raw)
  })

  it('defaults to text format for unknown format', () => {
    // @ts-expect-error - testing invalid format
    const content = getFormattedContent(mockReviewOutput, 'unknown')

    expect(content).toBe(mockReviewOutput.raw)
  })

  it('handles missing structured data for JSON', () => {
    const rawOnlyOutput: ReviewOutput = {
      raw: 'Raw content only',
    }

    const content = getFormattedContent(rawOnlyOutput, 'json')
    const parsed = JSON.parse(content)

    expect(parsed.parseError).toBe(true)
    expect(parsed.summary).toBeNull()
  })

  it('handles missing structured data for markdown', () => {
    const rawOnlyOutput: ReviewOutput = {
      raw: 'Raw content only',
    }

    const content = getFormattedContent(rawOnlyOutput, 'markdown')

    expect(content).toContain('# Code Review Report')
    expect(content).toContain('Raw content only')
  })
})

describe('writeReviewOutput', () => {
  let tempDir: string
  let originalConsoleLog: typeof console.log

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kode-review-test-'))
    originalConsoleLog = console.log
    console.log = vi.fn()
  })

  afterEach(() => {
    console.log = originalConsoleLog
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true })
    }
  })

  it('writes JSON output to file', async () => {
    const outputPath = join(tempDir, 'review.json')

    await writeReviewOutput(mockReviewOutput, {
      format: 'json',
      outputFile: outputPath,
    })

    expect(existsSync(outputPath)).toBe(true)
    const written = readFileSync(outputPath, 'utf-8')
    const parsed = JSON.parse(written)
    expect(parsed.summary).toBe(mockStructuredReview.summary)
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.verdict.recommendation).toBe('APPROVE')
  })

  it('writes markdown output to file', async () => {
    const outputPath = join(tempDir, 'review.md')

    await writeReviewOutput(mockReviewOutput, {
      format: 'markdown',
      outputFile: outputPath,
    })

    expect(existsSync(outputPath)).toBe(true)
    const written = readFileSync(outputPath, 'utf-8')
    expect(written).toContain('# Code Review Report')
    expect(written).toContain('Test review summary.')
    expect(written).toContain('## Verdict')
  })

  it('writes text output to file', async () => {
    const outputPath = join(tempDir, 'review.txt')

    await writeReviewOutput(mockReviewOutput, {
      format: 'text',
      outputFile: outputPath,
    })

    expect(existsSync(outputPath)).toBe(true)
    const written = readFileSync(outputPath, 'utf-8')
    expect(written).toBe(mockReviewOutput.raw)
  })

  it('writes to stdout when no outputFile specified and not quiet', async () => {
    await writeReviewOutput(mockReviewOutput, {
      format: 'text',
      quiet: false,
    })

    expect(console.log).toHaveBeenCalledWith(mockReviewOutput.raw)
  })

  it('does not write to stdout when quiet is true', async () => {
    await writeReviewOutput(mockReviewOutput, {
      format: 'text',
      quiet: true,
    })

    expect(console.log).not.toHaveBeenCalled()
  })

  it('writes to both file and stdout when outputFile specified and not quiet', async () => {
    const outputPath = join(tempDir, 'review-both.txt')

    await writeReviewOutput(mockReviewOutput, {
      format: 'text',
      outputFile: outputPath,
      quiet: false,
    })

    expect(existsSync(outputPath)).toBe(true)
    expect(console.log).toHaveBeenCalledWith(mockReviewOutput.raw)
  })

  it('creates parent directories if they do not exist', async () => {
    const nestedPath = join(tempDir, 'nested', 'dir', 'review.json')

    await writeReviewOutput(mockReviewOutput, {
      format: 'json',
      outputFile: nestedPath,
    })

    expect(existsSync(nestedPath)).toBe(true)
    const written = readFileSync(nestedPath, 'utf-8')
    expect(() => JSON.parse(written)).not.toThrow()
  })
})

describe('writeReviewOutput — terminal-control stripping (stdout)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('strips CSI escape sequences (e.g., screen-clear) from stdout', async () => {
    const review: ReviewOutput = {
      raw: 'Before \x1b[2J\x1b[H After',
      structured: { ...mockStructuredReview, summary: 'Before \x1b[2J\x1b[H After' },
    }
    await writeReviewOutput(review, { format: 'text' })
    const written = logSpy.mock.calls[0]?.[0] as string
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/\x1b\[/)
    expect(written).toContain('Before  After')
  })

  it('strips OSC escape sequences (e.g., set terminal title)', async () => {
    const review: ReviewOutput = {
      raw: 'A\x1b]0;PWNED\x07B',
      structured: { ...mockStructuredReview, summary: 'A\x1b]0;PWNED\x07B' },
    }
    await writeReviewOutput(review, { format: 'text' })
    const written = logSpy.mock.calls[0]?.[0] as string
    // eslint-disable-next-line no-control-regex
    expect(written).not.toMatch(/\x1b\]/)
    expect(written).not.toContain('PWNED')
  })

  it('strips bare BEL (0x07) but preserves \\t \\n \\r', async () => {
    const review: ReviewOutput = {
      raw: 'tab:\there\nnext\r\nline\x07bell',
      structured: { ...mockStructuredReview, summary: 'tab:\there\nnext\r\nline\x07bell' },
    }
    await writeReviewOutput(review, { format: 'text' })
    const written = logSpy.mock.calls[0]?.[0] as string
    expect(written).not.toContain('\x07')
    expect(written).toContain('\t')
    expect(written).toContain('\n')
  })

  it('preserves raw control chars in file output (no stripping)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'writer-raw-'))
    const outFile = join(dir, 'review.txt')
    try {
      const raw = 'preserve \x1b[2J these \x07 bytes'
      const review: ReviewOutput = {
        raw,
        structured: { ...mockStructuredReview, summary: raw },
      }
      await writeReviewOutput(review, {
        format: 'text',
        outputFile: outFile,
        quiet: true,
      })
      const onDisk = readFileSync(outFile, 'utf-8')
      expect(onDisk).toContain('\x1b[2J')
      expect(onDisk).toContain('\x07')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
