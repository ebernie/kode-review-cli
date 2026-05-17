# Clawpatch Quality Borrows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt seven review-quality levers from clawpatch into kode-review-cli's prompt/output pipeline and watch mode — schema-strict findings with required evidence (3), fixed category enum (5), severity × confidence two-axis (6), inline tests as a falsification signal (1), explicit owned-vs-context scoping (2), path-based trust-boundary hints (4), and a revalidation pass when a watched PR head moves (7).

**Architecture:** All changes are additive to existing modules; no new subsystems. Group A (tasks 1–4) introduces a Zod-validated `Finding` schema, parses it out of LLM output alongside the existing markdown, and threads parsed findings through the engine return type. Group B (tasks 5–6) is two prompt-instruction additions. Group C (tasks 7–8) is a small path-pattern classifier injected as a prompt section. Group D (tasks 9–11) extends watch-mode state with parsed findings + head SHA, builds a revalidation prompt, and short-circuits the watcher when a previously reviewed PR has moved instead of doing a fresh full review.

**Tech Stack:** TypeScript (ESM, strict), Zod for schemas (already a project dep via `src/config/schema.ts` and `src/watch/state.ts`), Vitest for tests (`bun run test`), Conf for persisted state, existing pi-coding-agent + buildReviewPrompt pipeline.

**Out of scope:** No retrieval-side changes — `src/indexer/context.ts` already weights test chunks at 1.5x and caps at 3 per source (`MODIFIED_LINE_WEIGHT_MULTIPLIER`, `TEST_FILE_WEIGHT_MULTIPLIER`, `MAX_TEST_CHUNKS_PER_SOURCE`), so item 1 is delivered through the prompt instruction alone. No fix-loop / patch generation (deliberately omitted per discussion — the orchestrating LLM owns fixes).

---

## File Structure

**New files:**
- `src/review/finding-schema.ts` — Zod schemas for `Finding`, severity, category, confidence
- `src/review/__tests__/finding-schema.test.ts` — schema validation tests
- `src/review/finding-parser.ts` — extract & validate `Finding[]` from raw LLM output
- `src/review/__tests__/finding-parser.test.ts` — parser tests
- `src/review/trust-boundaries.ts` — path → trust-boundary classifier
- `src/review/__tests__/trust-boundaries.test.ts` — classifier tests
- `src/review/revalidate-prompt.ts` — builder for the revalidation-pass prompt + response schema
- `src/review/__tests__/revalidate-prompt.test.ts` — revalidation prompt + schema tests

**Modified files:**
- `src/review/prompt.ts` — add output-format JSON block, category enum guidance, two-axis confidence text, tests-as-ground-truth instruction, owned-vs-context scoping, trust-boundary injection
- `src/review/__tests__/prompt.test.ts` — **new**, verify each prompt section is emitted (didn't exist before; add it)
- `src/review/engine.ts` — `ReviewResult` and `AgenticReviewResult` gain optional `findings: Finding[]`; engine parses output via `finding-parser.ts`
- `src/review/index.ts` — export the new types/helpers
- `src/watch/types.ts` — `ReviewOutcome` gains `headRef?: string` and `findings?: Finding[]`
- `src/watch/state.ts` — Zod schema updated; existing `Conf` reads tolerate new optional fields
- `src/watch/watcher.ts` — on poll, if a known key returns with a changed head SHA, run revalidation flow instead of full review

---

## Task 1: Finding schema (Zod)

**Files:**
- Create: `src/review/finding-schema.ts`
- Test: `src/review/__tests__/finding-schema.test.ts`

This is the foundation for items 3, 5, 6. Severity stays compatible with the existing prompt vocabulary (CRITICAL / HIGH / MEDIUM / LOW). Category is a fixed enum (suppress free-form labels). Confidence is its own axis. Evidence is required and structured.

- [ ] **Step 1: Write the failing test**

Create `src/review/__tests__/finding-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  FindingSchema,
  FindingsBlockSchema,
  type Finding,
  SEVERITIES,
  CATEGORIES,
  CONFIDENCES,
} from '../finding-schema.js'

describe('FindingSchema', () => {
  const valid: Finding = {
    severity: 'HIGH',
    category: 'security',
    confidence: 'HIGH',
    title: 'SQL injection in user query',
    file: 'src/db/users.ts',
    lineStart: 42,
    lineEnd: 48,
    evidence: 'const q = `SELECT * FROM users WHERE id = ${id}`',
    problem: 'Untrusted input concatenated into a SQL string.',
    recommendation: 'Use a parameterised query.',
  }

  it('accepts a fully-populated finding', () => {
    expect(FindingSchema.parse(valid)).toEqual(valid)
  })

  it('rejects missing evidence', () => {
    const bad: any = { ...valid }
    delete bad.evidence
    expect(() => FindingSchema.parse(bad)).toThrow()
  })

  it('rejects empty evidence string', () => {
    expect(() => FindingSchema.parse({ ...valid, evidence: '   ' })).toThrow()
  })

  it('rejects unknown severity', () => {
    expect(() => FindingSchema.parse({ ...valid, severity: 'NIT' })).toThrow()
  })

  it('rejects unknown category', () => {
    expect(() => FindingSchema.parse({ ...valid, category: 'vibes' })).toThrow()
  })

  it('rejects lineEnd before lineStart', () => {
    expect(() => FindingSchema.parse({ ...valid, lineStart: 50, lineEnd: 42 })).toThrow()
  })

  it('rejects non-positive line numbers', () => {
    expect(() => FindingSchema.parse({ ...valid, lineStart: 0 })).toThrow()
  })

  it('exposes the canonical severity/category/confidence sets', () => {
    expect(SEVERITIES).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
    expect(CATEGORIES).toContain('security')
    expect(CATEGORIES).toContain('correctness')
    expect(CONFIDENCES).toEqual(['HIGH', 'MEDIUM', 'LOW'])
  })

  it('FindingsBlockSchema parses an array', () => {
    const parsed = FindingsBlockSchema.parse({ findings: [valid] })
    expect(parsed.findings).toHaveLength(1)
  })

  it('FindingsBlockSchema accepts empty findings list', () => {
    expect(FindingsBlockSchema.parse({ findings: [] }).findings).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review/__tests__/finding-schema.test.ts`
Expected: FAIL with "Cannot find module '../finding-schema.js'"

- [ ] **Step 3: Write the schema module**

Create `src/review/finding-schema.ts`:

```typescript
/**
 * Schema for structured findings emitted alongside the human-readable review.
 *
 * Inspired by clawpatch's review output discipline: required evidence,
 * fixed category enum, and a confidence axis distinct from severity so
 * downstream consumers can triage on (severity × confidence) instead of
 * a single noisy axis.
 */
import { z } from 'zod'

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export const CATEGORIES = [
  'security',
  'correctness',
  'performance',
  'maintainability',
  'concurrency',
  'api-contract',
  'error-handling',
  'testing',
  'documentation',
  'other',
] as const
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const

export const FindingSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    confidence: z.enum(CONFIDENCES),
    title: z.string().trim().min(1).max(200),
    file: z.string().trim().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    evidence: z.string().trim().min(1),
    problem: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
  })
  .refine((f) => f.lineEnd >= f.lineStart, {
    message: 'lineEnd must be >= lineStart',
    path: ['lineEnd'],
  })

export type Finding = z.infer<typeof FindingSchema>

export const FindingsBlockSchema = z.object({
  findings: z.array(FindingSchema),
})

export type FindingsBlock = z.infer<typeof FindingsBlockSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/review/__tests__/finding-schema.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/finding-schema.ts src/review/__tests__/finding-schema.test.ts
git commit -m "feat(review): add Finding zod schema with evidence + two-axis ranking"
```

---

## Task 2: Finding parser

**Files:**
- Create: `src/review/finding-parser.ts`
- Test: `src/review/__tests__/finding-parser.test.ts`

The LLM is asked to emit a fenced ```json block tagged `kode-findings` at the end of its review. The parser extracts and validates it. Failure to find/parse is non-fatal (we still return the markdown), but is logged at warn level so prompt regressions are visible.

- [ ] **Step 1: Write the failing test**

Create `src/review/__tests__/finding-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parseFindingsBlock, FINDINGS_FENCE_TAG } from '../finding-parser.js'

const sampleFinding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 'SQLi',
  file: 'src/db.ts',
  lineStart: 10,
  lineEnd: 12,
  evidence: 'query',
  problem: 'p',
  recommendation: 'r',
}

function wrap(body: string): string {
  return [
    '### Summary',
    'some markdown',
    '',
    '```' + FINDINGS_FENCE_TAG,
    body,
    '```',
    '',
    '### Final Verdict',
  ].join('\n')
}

describe('parseFindingsBlock', () => {
  it('extracts findings from a well-formed block', () => {
    const out = parseFindingsBlock(wrap(JSON.stringify({ findings: [sampleFinding] })))
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0].title).toBe('SQLi')
    expect(out.error).toBeUndefined()
  })

  it('returns an empty list when block is missing', () => {
    const out = parseFindingsBlock('### Summary\nno block here\n')
    expect(out.findings).toEqual([])
    expect(out.error).toBe('missing')
  })

  it('reports parse failure when JSON is malformed', () => {
    const out = parseFindingsBlock(wrap('{ not json'))
    expect(out.findings).toEqual([])
    expect(out.error).toBe('invalid-json')
  })

  it('reports schema failure when findings do not validate', () => {
    const bad = { findings: [{ ...sampleFinding, severity: 'NIT' }] }
    const out = parseFindingsBlock(wrap(JSON.stringify(bad)))
    expect(out.findings).toEqual([])
    expect(out.error).toBe('schema')
    expect(out.detail).toMatch(/severity/)
  })

  it('uses the LAST findings block when several are present', () => {
    const first = { findings: [{ ...sampleFinding, title: 'first' }] }
    const second = { findings: [{ ...sampleFinding, title: 'second' }] }
    const body = [wrap(JSON.stringify(first)), wrap(JSON.stringify(second))].join('\n')
    const out = parseFindingsBlock(body)
    expect(out.findings[0].title).toBe('second')
  })

  it('does not match the fence tag inside another code block', () => {
    const body = [
      '```ts',
      '// fake: ```' + FINDINGS_FENCE_TAG,
      '```',
    ].join('\n')
    const out = parseFindingsBlock(body)
    expect(out.error).toBe('missing')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review/__tests__/finding-parser.test.ts`
Expected: FAIL with "Cannot find module '../finding-parser.js'"

- [ ] **Step 3: Write the parser module**

Create `src/review/finding-parser.ts`:

```typescript
/**
 * Extracts the fenced findings block from raw LLM output and validates
 * it against FindingsBlockSchema. Tolerates absence of the block — the
 * markdown review remains the source of truth for humans.
 */
import { FindingsBlockSchema, type Finding } from './finding-schema.js'

export const FINDINGS_FENCE_TAG = 'kode-findings'

export type FindingsParseError = 'missing' | 'invalid-json' | 'schema'

export interface ParseFindingsResult {
  findings: Finding[]
  error?: FindingsParseError
  /** Human-readable detail when error is set. */
  detail?: string
}

/**
 * Match fenced blocks tagged with the FINDINGS_FENCE_TAG language hint.
 * The fence must start at column 0 and uses three backticks.
 */
const FENCE_RE = new RegExp(
  '^```' + FINDINGS_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function parseFindingsBlock(rawReview: string): ParseFindingsResult {
  const blocks: string[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(rawReview)) !== null) {
    blocks.push(m[1])
  }
  if (blocks.length === 0) {
    return { findings: [], error: 'missing' }
  }
  const body = blocks[blocks.length - 1]

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    return { findings: [], error: 'invalid-json', detail: String(err) }
  }

  const result = FindingsBlockSchema.safeParse(parsed)
  if (!result.success) {
    return { findings: [], error: 'schema', detail: result.error.message }
  }
  return { findings: result.data.findings }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/review/__tests__/finding-parser.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/review/finding-parser.ts src/review/__tests__/finding-parser.test.ts
git commit -m "feat(review): parse fenced kode-findings JSON block from review output"
```

---

## Task 3: Prompt — schema-strict output, category enum, two-axis confidence

**Files:**
- Modify: `src/review/prompt.ts:139-221` (REVIEW_SCOPE + CONFIDENCE_GUIDELINES_BASE + CONFIDENCE_GUIDELINES_WITH_CONTEXT)
- Create: `src/review/__tests__/prompt.test.ts`

Replace the freeform Output Format with a hybrid: keep the human-readable markdown (it's load-bearing for terminal UX), and *append* a required fenced JSON block whose schema matches Task 1.

- [ ] **Step 1: Write the failing test**

Create `src/review/__tests__/prompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from '../prompt.js'
import { FINDINGS_FENCE_TAG } from '../finding-parser.js'
import { CATEGORIES } from '../finding-schema.js'

const baseOptions = {
  context: 'ctx',
  diffContent: 'diff --git a/x b/x',
}

describe('buildReviewPrompt — schema-strict output', () => {
  it('demands a fenced kode-findings JSON block in the output format', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toContain('```' + FINDINGS_FENCE_TAG)
    expect(p).toMatch(/REQUIRED.*kode-findings/i)
  })

  it('lists the canonical category enum verbatim', () => {
    const p = buildReviewPrompt(baseOptions)
    for (const c of CATEGORIES) {
      expect(p).toContain(c)
    }
  })

  it('explains the two-axis severity × confidence model', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toMatch(/severity.*confidence/i)
    expect(p).toMatch(/independent|separate|two axes/i)
  })

  it('requires evidence for every finding', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).toMatch(/evidence.*required/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: FAIL — current prompt has none of these strings.

- [ ] **Step 3: Modify `src/review/prompt.ts`**

Replace the constant `REVIEW_SCOPE` (lines 139-181) with the version below — keep the constant name and export shape so callers don't change:

```typescript
const REVIEW_SCOPE = `
## Review Scope

**Be exhaustive.** Report ALL issues you find, not just the top few. A thorough review should typically find 5-15 issues in a medium-sized diff. If you find fewer than 3 issues in a non-trivial diff, double-check that you haven't missed anything.

Focus primarily on **changed lines** (+ lines in the diff). Only flag issues in context lines if they are directly affected by or related to the changes.

## Output Format

Provide your review in TWO parts:

### Part 1 — Human-readable markdown

#### Summary
A brief 2-3 sentence overview of the changes and overall code quality.

#### Issues Found

Report ALL issues found. For each issue:

\`\`\`
**[SEVERITY: CRITICAL|HIGH|MEDIUM|LOW]** - Category: Brief title

File: <filename>:<line_number>

Problem:
<description of the issue>

Problematic Code:
\`\`\`<language>
<the problematic code snippet>
\`\`\`

Suggested Fix:
\`\`\`<language>
<the corrected code>
\`\`\`

Confidence: HIGH|MEDIUM|LOW
\`\`\`

**Severity and Confidence are independent axes — do not collapse them.**
- *Severity* describes the impact IF the issue is real.
- *Confidence* describes how certain you are the issue IS real given the visible code.
- A CRITICAL-severity / LOW-confidence finding is valid and useful — emit it; the downstream consumer triages on both axes.

**Confidence Guidelines:**
- **HIGH**: You are certain this is an issue based on visible code
- **MEDIUM**: Likely an issue, but depends on context you can't fully see
- **LOW**: Possible issue, but could be intentional or handled elsewhere

### Part 2 — Structured findings (REQUIRED)

After the markdown section, you MUST emit a fenced code block tagged \`kode-findings\` containing a JSON object that mirrors the issues above. Downstream tooling parses this block; without it the review is incomplete.

\`\`\`kode-findings
{
  "findings": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "security" | "correctness" | "performance" | "maintainability" | "concurrency" | "api-contract" | "error-handling" | "testing" | "documentation" | "other",
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "title": "Short one-line title",
      "file": "path/relative/to/repo.ts",
      "lineStart": 42,
      "lineEnd": 48,
      "evidence": "The exact code or quoted text that demonstrates the issue. REQUIRED. Empty strings are rejected.",
      "problem": "Why this is wrong.",
      "recommendation": "What to do instead."
    }
  ]
}
\`\`\`

Rules for the structured block:
- Every finding must include \`evidence\` quoting the actual code that proves the issue. No evidence = no finding.
- \`category\` must be one of the listed values — do not invent new categories ("style", "nit", "readability" → use \`maintainability\`).
- \`severity\` and \`confidence\` must each be one of the listed values, treated as independent axes.
- If there are no issues, emit \`{ "findings": [] }\`.
- Emit exactly ONE \`kode-findings\` block, after the markdown.
`
```

Also remove the now-redundant `CONFIDENCE_GUIDELINES_BASE` markdown tail (lines 197-221) that re-states confidence rules and the verdict block, **except** for the Final Verdict section, which moves to its own constant appended after Part 1. Replace the constant `CONFIDENCE_GUIDELINES_BASE` (lines 197-221) with:

```typescript
const CONFIDENCE_GUIDELINES_BASE = `

**Formatting note:** For large reviews with more than 5 HIGH/CRITICAL issues, you may abbreviate MEDIUM/LOW issues to just the title and one-line description in the markdown — but every finding (full or abbreviated) MUST appear in the structured kode-findings block with complete fields.

### Positive Observations
Note 2-3 things done well (good patterns, security practices, clean code, etc.).

### Final Verdict

\`\`\`
RECOMMENDATION: [APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION]

Confidence Level: [HIGH | MEDIUM | LOW]

Merge Decision: [SAFE_TO_MERGE | DO_NOT_MERGE | CONDITIONAL_MERGE]

Rationale: <1-2 sentence explanation>

Issues Summary: X CRITICAL, Y HIGH, Z MEDIUM, W LOW
\`\`\`

If CONDITIONAL_MERGE, specify what must be addressed before merging.

---
`
```

`CONFIDENCE_GUIDELINES_WITH_CONTEXT` (lines 186-192) stays as-is — it appends optional sharpening when semantic context exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full review test suite to ensure nothing else regressed**

Run: `npx vitest run src/review`
Expected: PASS (all existing tests still green; if any snapshot of the prompt exists it will need updating — update by regenerating).

- [ ] **Step 6: Commit**

```bash
git add src/review/prompt.ts src/review/__tests__/prompt.test.ts
git commit -m "feat(review): require structured kode-findings block, fixed categories, two-axis confidence"
```

---

## Task 4: Wire parser into the engine

**Files:**
- Modify: `src/review/engine.ts:84-95` (`ReviewResult`, `AgenticReviewResult`)
- Modify: `src/review/engine.ts:244-318` (`runReview`, `runAgenticReview`)
- Modify: `src/review/index.ts` (export new types)
- Modify: `src/review/__tests__/engine.test.ts` (extend existing tests)

`ReviewResult` and `AgenticReviewResult` gain `findings: Finding[]`. Parse the markdown via `parseFindingsBlock`; on missing/invalid emit a `logger.warn` and continue with an empty array. The markdown remains the primary review text.

- [ ] **Step 1: Add a failing test to `src/review/__tests__/engine.test.ts`**

Locate the existing `describe('runReview', ...)` (or equivalent) and add the test below. If the file's mock harness is complex, place this in a new sibling describe that reuses the same setup. The intent: when the fake pi session returns a message containing a `kode-findings` block, `runReview` returns the parsed findings.

```typescript
import { FINDINGS_FENCE_TAG } from '../finding-parser.js'

it('returns parsed findings when output contains a kode-findings block', async () => {
  const fenced = [
    '### Summary',
    'sum',
    '',
    '```' + FINDINGS_FENCE_TAG,
    JSON.stringify({
      findings: [{
        severity: 'HIGH',
        category: 'security',
        confidence: 'HIGH',
        title: 't',
        file: 'a.ts',
        lineStart: 1,
        lineEnd: 2,
        evidence: 'e',
        problem: 'p',
        recommendation: 'r',
      }],
    }),
    '```',
  ].join('\n')

  // Drive the mocked session to return `fenced` as the assistant text.
  // (Reuse the existing helper in this test file — the harness exposes a
  // way to seed assistant content; if the helper is named differently in
  // your branch, swap it in here.)
  sessionState.messages = [
    { role: 'assistant', stopReason: 'end', content: [{ type: 'text', text: fenced }] },
  ]

  const promise = runReview({ diffContent: 'd', context: 'c' })
  captured.resolvePrompt()
  const result = await promise

  expect(result.findings).toHaveLength(1)
  expect(result.findings[0].category).toBe('security')
})

it('returns empty findings when no kode-findings block is present', async () => {
  sessionState.messages = [
    { role: 'assistant', stopReason: 'end', content: [{ type: 'text', text: '### Summary\nno block' }] },
  ]
  const promise = runReview({ diffContent: 'd', context: 'c' })
  captured.resolvePrompt()
  const result = await promise
  expect(result.findings).toEqual([])
})
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/review/__tests__/engine.test.ts`
Expected: FAIL — `result.findings` is undefined.

- [ ] **Step 3: Update `src/review/engine.ts`**

Add import near the top:

```typescript
import { parseFindingsBlock } from './finding-parser.js'
import type { Finding } from './finding-schema.js'
```

Extend `ReviewResult` (around line 84-87):

```typescript
export interface ReviewResult {
  content: string
  usage: UsageTotals
  findings: Finding[]
}
```

Extend `AgenticReviewResult` (around line 89-95):

```typescript
export interface AgenticReviewResult {
  content: string
  toolCallCount: number
  truncated: boolean
  truncationReason?: string
  usage: UsageTotals
  findings: Finding[]
}
```

Add a small helper near the bottom of the file (before the exports):

```typescript
function extractFindings(content: string): Finding[] {
  const parsed = parseFindingsBlock(content)
  if (parsed.error === 'missing') {
    logger.warn('Review output missing kode-findings block; downstream consumers will see zero structured findings.')
  } else if (parsed.error) {
    logger.warn(`Review output kode-findings block failed validation (${parsed.error}): ${parsed.detail ?? ''}`)
  }
  return parsed.findings
}
```

Update `runReview` return (around line 269):

```typescript
return { content: outcome.content, usage: outcome.usage, findings: extractFindings(outcome.content) }
```

Update `runAgenticReview` return (around line 309-317):

```typescript
return {
  content: outcome.content,
  toolCallCount: outcome.toolCallCount,
  truncated: outcome.truncated,
  truncationReason: outcome.truncated
    ? `Maximum iteration limit (${maxIterations}) reached`
    : undefined,
  usage: outcome.usage,
  findings: extractFindings(outcome.content),
}
```

- [ ] **Step 4: Update `src/review/index.ts` to export the new types**

Append to the file:

```typescript
export {
  FindingSchema,
  FindingsBlockSchema,
  SEVERITIES,
  CATEGORIES,
  CONFIDENCES,
  type Finding,
  type FindingsBlock,
} from './finding-schema.js'

export {
  parseFindingsBlock,
  FINDINGS_FENCE_TAG,
  type ParseFindingsResult,
  type FindingsParseError,
} from './finding-parser.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/review`
Expected: PASS (the two new engine tests plus all existing).

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: no errors. (Callers in `src/watch/watcher.ts` and `src/index.ts` that destructure `runReview()` result still work because `content` and `usage` are unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/review/engine.ts src/review/index.ts src/review/__tests__/engine.test.ts
git commit -m "feat(review): thread parsed Finding[] through engine return types"
```

---

## Task 5: Tests-as-ground-truth instruction

**Files:**
- Modify: `src/review/prompt.ts` — add a new section, only when semantic context is available
- Modify: `src/review/__tests__/prompt.test.ts`

The retrieval pipeline already preferentially surfaces test chunks (see `src/indexer/context.ts:31-42`, `TEST_FILE_WEIGHT_MULTIPLIER = 1.5`, `MAX_TEST_CHUNKS_PER_SOURCE = 3`). The missing piece is the explicit instruction: when a `<test>` section in `<related_code>` demonstrates the behavior is exercised correctly, downgrade or omit the finding.

- [ ] **Step 1: Add failing tests**

Append to `src/review/__tests__/prompt.test.ts`:

```typescript
describe('buildReviewPrompt — tests as ground truth', () => {
  it('emits the tests-as-ground-truth section when semantic context is present', () => {
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: '<context type="test" path="x" lines="1-2">x</context>' })
    expect(p).toMatch(/tests as ground truth/i)
    expect(p).toMatch(/downgrade.*confidence|skip the finding/i)
    expect(p).toContain('<test>')
  })

  it('does NOT emit the tests-as-ground-truth section without semantic context', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/tests as ground truth/i)
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: FAIL on the two new cases.

- [ ] **Step 3: Modify `src/review/prompt.ts`**

Add a new constant near the other constants:

```typescript
const TESTS_AS_GROUND_TRUTH = `
## Tests as Ground Truth

The \`<test>\` sections in \`<related_code>\` are not just signals of test coverage — they are evidence of intended behavior. Before emitting a finding, check whether the behavior you're about to flag is exercised by visible test code.

Apply these rules in order:
1. If a \`<test>\` section explicitly asserts the behavior is correct as written, **skip the finding**.
2. If a \`<test>\` section exercises the code path but does not directly assert the disputed behavior, **downgrade confidence to LOW** and say so in the finding's \`problem\` field (e.g., "tests exercise this path but do not assert the boundary condition").
3. If no \`<test>\` section covers the code path at all, proceed with your original confidence — and consider whether "missing test coverage" is itself a \`testing\`-category finding.

Cite the test by path:lines when you skip or downgrade (e.g., "downgraded — \`src/foo/__tests__/bar.test.ts:45-60\` asserts this behavior").
`
```

Update `buildReviewTemplate` (around line 291-321) to include this section only when `hasSemanticContext` is true. After the existing `if (hasSemanticContext) { parts.push(REVIEW_CRITERIA_WITH_CONTEXT) }`, add:

```typescript
if (hasSemanticContext) {
  parts.push(TESTS_AS_GROUND_TRUTH)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/prompt.ts src/review/__tests__/prompt.test.ts
git commit -m "feat(review): instruct LLM to downgrade findings contradicted by visible tests"
```

---

## Task 6: Owned-vs-context scoping instruction

**Files:**
- Modify: `src/review/prompt.ts`
- Modify: `src/review/__tests__/prompt.test.ts`

Kill the drive-by-finding failure mode where the LLM flags issues against retrieved context chunks instead of diff lines.

- [ ] **Step 1: Add failing test**

Append to `src/review/__tests__/prompt.test.ts`:

```typescript
describe('buildReviewPrompt — findings scope', () => {
  it('forbids findings against retrieved context', () => {
    const p = buildReviewPrompt({ ...baseOptions, semanticContext: 'ctx' })
    expect(p).toMatch(/findings.*only.*diff|may not.*context.*findings/i)
    expect(p).toMatch(/<related_code>.*read-only|read-only.*<related_code>/i)
  })

  it('omits the scope section when there is no semantic context', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/Findings Scope/i)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify `src/review/prompt.ts`**

Add a new constant:

```typescript
const FINDINGS_SCOPE = `
## Findings Scope

You may issue findings ONLY against lines that appear in \`<diff_content>\` (added \`+\` or modified context lines directly adjacent to changes). The \`<related_code>\` section is read-only: use it to understand the surrounding system, verify patterns, and judge confidence — but DO NOT emit findings whose \`file\`/\`lineStart\` point at code that only appears in \`<related_code>\` and not in \`<diff_content>\`.

If you spot a problem in retrieved context that is not in the diff, note it in the \`### Positive Observations\` or \`### Summary\` section as an aside, not as a finding.
`
```

Add to `buildReviewTemplate` after the tests-as-ground-truth block (so both fire only when context is present):

```typescript
if (hasSemanticContext) {
  parts.push(FINDINGS_SCOPE)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/prompt.ts src/review/__tests__/prompt.test.ts
git commit -m "feat(review): scope findings to diff lines, keep retrieved context read-only"
```

---

## Task 7: Trust-boundary classifier

**Files:**
- Create: `src/review/trust-boundaries.ts`
- Test: `src/review/__tests__/trust-boundaries.test.ts`

A short path-pattern classifier. Returns boundary tags per file path. Deliberately heuristic — covers the common cases (routes, auth, db, secrets, exec, fs, serialization) without trying to reach clawpatch's 19-mapper coverage.

- [ ] **Step 1: Write the failing test**

Create `src/review/__tests__/trust-boundaries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { classifyTrustBoundaries, summarizeBoundariesForFiles, TRUST_BOUNDARIES } from '../trust-boundaries.js'

describe('classifyTrustBoundaries', () => {
  it('flags routes and api handlers as network + user-input', () => {
    expect(classifyTrustBoundaries('src/routes/users.ts')).toEqual(
      expect.arrayContaining(['network', 'user-input']),
    )
    expect(classifyTrustBoundaries('app/api/login/route.ts')).toEqual(
      expect.arrayContaining(['network', 'user-input']),
    )
    expect(classifyTrustBoundaries('internal/handlers/webhook.go')).toEqual(
      expect.arrayContaining(['network']),
    )
  })

  it('flags auth/session/crypto as auth + secrets', () => {
    expect(classifyTrustBoundaries('src/auth/session.ts')).toEqual(
      expect.arrayContaining(['auth', 'secrets']),
    )
    expect(classifyTrustBoundaries('lib/crypto/jwt.ts')).toEqual(
      expect.arrayContaining(['secrets']),
    )
  })

  it('flags db/migration/model as database', () => {
    expect(classifyTrustBoundaries('src/db/users.ts')).toEqual(
      expect.arrayContaining(['database']),
    )
    expect(classifyTrustBoundaries('migrations/001_users.sql')).toEqual(
      expect.arrayContaining(['database']),
    )
    expect(classifyTrustBoundaries('app/models/user.rb')).toEqual(
      expect.arrayContaining(['database']),
    )
  })

  it('flags shell/exec/spawn paths as process-exec', () => {
    expect(classifyTrustBoundaries('src/utils/exec.ts')).toEqual(
      expect.arrayContaining(['process-exec']),
    )
  })

  it('flags filesystem helpers as filesystem', () => {
    expect(classifyTrustBoundaries('src/utils/fs.ts')).toEqual(
      expect.arrayContaining(['filesystem']),
    )
  })

  it('returns empty for unremarkable paths', () => {
    expect(classifyTrustBoundaries('src/cli/colors.ts')).toEqual([])
    expect(classifyTrustBoundaries('README.md')).toEqual([])
  })

  it('deduplicates when multiple patterns hit', () => {
    const out = classifyTrustBoundaries('src/auth/db/sessions.ts')
    expect(new Set(out).size).toBe(out.length)
  })

  it('exposes the full boundary set', () => {
    expect(TRUST_BOUNDARIES).toContain('network')
    expect(TRUST_BOUNDARIES).toContain('user-input')
    expect(TRUST_BOUNDARIES).toContain('database')
    expect(TRUST_BOUNDARIES).toContain('secrets')
    expect(TRUST_BOUNDARIES).toContain('auth')
    expect(TRUST_BOUNDARIES).toContain('process-exec')
    expect(TRUST_BOUNDARIES).toContain('filesystem')
    expect(TRUST_BOUNDARIES).toContain('serialization')
    expect(TRUST_BOUNDARIES).toContain('external-api')
  })
})

describe('summarizeBoundariesForFiles', () => {
  it('groups files by boundary', () => {
    const summary = summarizeBoundariesForFiles([
      'src/routes/users.ts',
      'src/auth/session.ts',
      'src/utils/colors.ts',
    ])
    expect(summary.get('network')).toContain('src/routes/users.ts')
    expect(summary.get('auth')).toContain('src/auth/session.ts')
    expect(summary.has('filesystem')).toBe(false)
  })

  it('returns an empty map when no files match', () => {
    expect(summarizeBoundariesForFiles(['README.md']).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/review/__tests__/trust-boundaries.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the classifier**

Create `src/review/trust-boundaries.ts`:

```typescript
/**
 * Lightweight path-based trust-boundary classifier.
 *
 * Inspired by clawpatch's per-feature trustBoundaries field but implemented
 * as a path-pattern heuristic (no AST, no framework parsing). The output is
 * injected into the review prompt so the LLM knows which boundaries the
 * changed files cross, and scopes findings accordingly.
 */

export const TRUST_BOUNDARIES = [
  'network',
  'user-input',
  'database',
  'secrets',
  'auth',
  'permissions',
  'process-exec',
  'filesystem',
  'serialization',
  'external-api',
] as const

export type TrustBoundary = (typeof TRUST_BOUNDARIES)[number]

interface Rule {
  re: RegExp
  boundaries: TrustBoundary[]
}

const RULES: Rule[] = [
  // Network entrypoints — routes/controllers/handlers/api → network + user-input
  { re: /(^|\/)(routes?|controllers?|handlers?|api|endpoints?)\//i, boundaries: ['network', 'user-input'] },
  { re: /\/route\.(t|j)sx?$/i, boundaries: ['network', 'user-input'] },
  { re: /\/(webhook|callback)s?\//i, boundaries: ['network', 'user-input'] },
  // Auth / session / crypto / secrets
  { re: /(^|\/)(auth|session|oauth|saml|sso)(\/|\.)/i, boundaries: ['auth', 'secrets'] },
  { re: /(^|\/)(crypto|jwt|token|secret|password|credential)s?(\/|\.)/i, boundaries: ['secrets'] },
  { re: /(^|\/)permissions?(\/|\.)/i, boundaries: ['permissions', 'auth'] },
  // Database
  { re: /(^|\/)(db|database|models?|repositor(y|ies)|migrations?|schema)(\/|\.)/i, boundaries: ['database'] },
  { re: /\.(sql|prisma)$/i, boundaries: ['database'] },
  // Process exec
  { re: /(^|\/)(exec|shell|subprocess|spawn)(\/|\.)/i, boundaries: ['process-exec'] },
  // Filesystem helpers
  { re: /(^|\/)(fs|filesystem|storage|uploads?)(\/|\.)/i, boundaries: ['filesystem'] },
  // Serialization / parsers
  { re: /(^|\/)(serializ|deserializ|parser|marshal|unmarshal)/i, boundaries: ['serialization'] },
  // External API / clients
  { re: /(^|\/)(client|sdk|integration)s?\//i, boundaries: ['external-api'] },
]

export function classifyTrustBoundaries(path: string): TrustBoundary[] {
  const hits = new Set<TrustBoundary>()
  for (const rule of RULES) {
    if (rule.re.test(path)) {
      for (const b of rule.boundaries) hits.add(b)
    }
  }
  return [...hits]
}

export function summarizeBoundariesForFiles(paths: string[]): Map<TrustBoundary, string[]> {
  const summary = new Map<TrustBoundary, string[]>()
  for (const p of paths) {
    for (const b of classifyTrustBoundaries(p)) {
      const existing = summary.get(b) ?? []
      existing.push(p)
      summary.set(b, existing)
    }
  }
  return summary
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/review/__tests__/trust-boundaries.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review/trust-boundaries.ts src/review/__tests__/trust-boundaries.test.ts
git commit -m "feat(review): add path-based trust-boundary classifier"
```

---

## Task 8: Wire trust boundaries into the prompt + engine

**Files:**
- Modify: `src/review/prompt.ts` — add a "Trust Boundary Signals" section and a new `ReviewPromptOptions.trustBoundarySummary` field
- Modify: `src/review/engine.ts` — derive boundaries from diff file paths, pass to prompt
- Modify: `src/review/__tests__/prompt.test.ts`
- Modify: `src/review/index.ts` — export new helpers

The engine extracts file paths from the diff (there's no existing helper for "list files in diff"; reuse the regex `^diff --git a/(\S+) b/\S+` against `diffContent` — keep it local to the engine to avoid spreading diff parsing).

- [ ] **Step 1: Add failing tests**

Append to `src/review/__tests__/prompt.test.ts`:

```typescript
describe('buildReviewPrompt — trust boundaries', () => {
  it('emits a Trust Boundary Signals section when provided', () => {
    const p = buildReviewPrompt({
      ...baseOptions,
      trustBoundarySummary: 'network: src/routes/users.ts\ndatabase: src/db/users.ts',
    })
    expect(p).toMatch(/Trust Boundary Signals/i)
    expect(p).toContain('network: src/routes/users.ts')
    expect(p).toContain('database: src/db/users.ts')
  })

  it('omits the section when not provided', () => {
    const p = buildReviewPrompt(baseOptions)
    expect(p).not.toMatch(/Trust Boundary Signals/i)
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `npx vitest run src/review/__tests__/prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/review/prompt.ts`**

Extend `ReviewPromptOptions`:

```typescript
export interface ReviewPromptOptions {
  context: string
  diffContent: string
  prMrInfo?: string
  semanticContext?: string
  prDescriptionSummary?: string
  projectStructureContext?: string
  /** Path-based trust-boundary summary, e.g. "network: src/routes/x.ts\nauth: src/auth/y.ts". */
  trustBoundarySummary?: string
}
```

In `buildReviewPrompt`, after the `projectStructureContext` block and before `prMrInfo`, insert:

```typescript
if (options.trustBoundarySummary) {
  parts.push('## Trust Boundary Signals')
  parts.push('')
  parts.push('The following files in this diff touch sensitive trust boundaries. Use these signals to scope your findings — security/correctness issues in these areas should be weighed more heavily. Do NOT introduce findings just because a boundary is present; flag concrete issues.')
  parts.push('')
  parts.push('<trust_boundaries>')
  parts.push(sanitizeXmlContent(options.trustBoundarySummary, 'trust_boundaries'))
  parts.push('</trust_boundaries>')
  parts.push('')
}
```

Also add `'trust_boundaries'` to the `STRUCTURAL_TAGS` array so it's escapable.

- [ ] **Step 4: Update `src/review/engine.ts`**

Add import:

```typescript
import { summarizeBoundariesForFiles } from './trust-boundaries.js'
```

Add helpers near the bottom of the file:

```typescript
const DIFF_FILE_RE = /^diff --git a\/(\S+) b\/\S+/gm

function filesInDiff(diff: string): string[] {
  const seen = new Set<string>()
  DIFF_FILE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DIFF_FILE_RE.exec(diff)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

// Used by the non-agentic runReview path only; agentic reviews infer boundaries
// from the codebase via tool calls.
function buildTrustBoundarySummary(diff: string): string | undefined {
  const files = filesInDiff(diff)
  if (files.length === 0) return undefined
  const summary = summarizeBoundariesForFiles(files)
  if (summary.size === 0) return undefined
  const lines: string[] = []
  for (const [boundary, paths] of summary) {
    lines.push(`${boundary}: ${paths.join(', ')}`)
  }
  return lines.join('\n')
}
```

In `runReview`, update the `promptOptions` construction (~line 249-257):

```typescript
const promptOptions: ReviewPromptOptions = {
  context: options.context,
  diffContent: options.diffContent,
  prMrInfo: options.prMrInfo,
  semanticContext: options.semanticContext,
  prDescriptionSummary: options.prDescriptionSummary,
  projectStructureContext: options.projectStructureContext,
  trustBoundarySummary: buildTrustBoundarySummary(options.diffContent),
}
```

`runAgenticReview` uses `buildAgenticPrompt` which has its own options type — leave the agentic prompt out of scope for this task. The agent has tool access to read paths and infer boundaries itself; injecting redundant signals would just bloat context.

- [ ] **Step 5: Update `src/review/index.ts`**

Append:

```typescript
export {
  classifyTrustBoundaries,
  summarizeBoundariesForFiles,
  TRUST_BOUNDARIES,
  type TrustBoundary,
} from './trust-boundaries.js'
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/review`
Expected: PASS (new and existing).

- [ ] **Step 7: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/review/prompt.ts src/review/engine.ts src/review/index.ts src/review/__tests__/prompt.test.ts
git commit -m "feat(review): inject path-derived trust-boundary signals into the prompt"
```

---

## Task 9: Persist findings + head ref in watch state

**Files:**
- Modify: `src/watch/types.ts:35-44` (`ReviewOutcome`)
- Modify: `src/watch/state.ts:8-13` (Zod schema)
- Modify: `src/watch/watcher.ts:308-315, 327-336` (mark-reviewed call sites)

The watcher currently stores only `key`, `success`, `reviewedAt`, `error`. To revalidate on head changes we need the head SHA at review time and the parsed findings.

- [ ] **Step 1: Add a failing test**

Create `src/watch/__tests__/state.test.ts` (the watch module currently has no tests folder — create it):

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { WatchStateManager } from '../state.js'
import type { Finding } from '../../review/finding-schema.js'

const finding: Finding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 't',
  file: 'a.ts',
  lineStart: 1,
  lineEnd: 2,
  evidence: 'e',
  problem: 'p',
  recommendation: 'r',
}

describe('WatchStateManager (extended)', () => {
  let mgr: WatchStateManager

  beforeEach(() => {
    mgr = new WatchStateManager('kode-review-watch-test-' + Math.random().toString(36).slice(2))
    mgr.clear()
  })

  it('persists headRef and findings when marking reviewed', () => {
    mgr.markReviewed({
      key: 'github:o/r:1',
      success: true,
      reviewedAt: new Date().toISOString(),
      headRef: 'abc123',
      findings: [finding],
    })
    const out = mgr.getOutcome('github:o/r:1')
    expect(out?.headRef).toBe('abc123')
    expect(out?.findings).toHaveLength(1)
  })

  it('reads back outcomes without headRef/findings (back-compat)', () => {
    mgr.markReviewed({
      key: 'github:o/r:2',
      success: true,
      reviewedAt: new Date().toISOString(),
    })
    const out = mgr.getOutcome('github:o/r:2')
    expect(out?.headRef).toBeUndefined()
    expect(out?.findings).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/watch/__tests__/state.test.ts`
Expected: FAIL — `ReviewOutcome` lacks `headRef`/`findings`.

- [ ] **Step 3: Update `src/watch/types.ts`**

```typescript
import type { Finding } from '../review/finding-schema.js'

export interface ReviewOutcome {
  key: ReviewRequestKey
  success: boolean
  reviewedAt: string
  error?: string
  /** Head commit SHA at review time. Enables revalidation when the PR head moves. */
  headRef?: string
  /** Parsed structured findings from the review. */
  findings?: Finding[]
}
```

- [ ] **Step 4: Update `src/watch/state.ts`**

Import the finding schema and extend the persisted outcome schema:

```typescript
import { FindingSchema } from '../review/finding-schema.js'

const ReviewOutcomeSchema = z.object({
  key: z.string(),
  success: z.boolean(),
  reviewedAt: z.string(),
  error: z.string().optional(),
  headRef: z.string().optional(),
  findings: z.array(FindingSchema).optional(),
})
```

`Conf` does not enforce the Zod schema on read by default — it's only declared here for type inference and future runtime validation. Existing persisted state without the new fields remains valid because both are optional.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/watch/__tests__/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/watch/types.ts src/watch/state.ts src/watch/__tests__/state.test.ts
git commit -m "feat(watch): persist parsed findings and head SHA per reviewed PR/MR"
```

---

## Task 10: Revalidation prompt + response schema

**Files:**
- Create: `src/review/revalidate-prompt.ts`
- Test: `src/review/__tests__/revalidate-prompt.test.ts`

Builds the prompt sent when a watched PR has moved. Input: prior findings, new diff. Output: per-finding status (`still-present` / `resolved` / `unverifiable`).

- [ ] **Step 1: Write the failing test**

Create `src/review/__tests__/revalidate-prompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  buildRevalidatePrompt,
  RevalidationOutcomeSchema,
  parseRevalidationBlock,
  REVALIDATION_FENCE_TAG,
} from '../revalidate-prompt.js'
import type { Finding } from '../finding-schema.js'

const f: Finding = {
  severity: 'HIGH',
  category: 'security',
  confidence: 'HIGH',
  title: 'SQLi',
  file: 'src/db.ts',
  lineStart: 10,
  lineEnd: 12,
  evidence: 'q',
  problem: 'p',
  recommendation: 'r',
}

describe('buildRevalidatePrompt', () => {
  it('includes prior findings and the new diff', () => {
    const p = buildRevalidatePrompt({ priorFindings: [f], newDiff: 'diff --git a/x b/x' })
    expect(p).toContain('SQLi')
    expect(p).toContain('diff --git')
    expect(p).toMatch(/still present|resolved|unverifiable/i)
    expect(p).toContain('```' + REVALIDATION_FENCE_TAG)
  })

  it('explains how to classify each prior finding', () => {
    const p = buildRevalidatePrompt({ priorFindings: [f], newDiff: 'd' })
    expect(p).toMatch(/still-present/)
    expect(p).toMatch(/resolved/)
    expect(p).toMatch(/unverifiable/)
  })
})

describe('parseRevalidationBlock', () => {
  it('parses a well-formed revalidation block', () => {
    const body = JSON.stringify({
      outcomes: [
        { findingTitle: 'SQLi', status: 'resolved', rationale: 'parameterised now' },
      ],
    })
    const out = parseRevalidationBlock([
      '```' + REVALIDATION_FENCE_TAG,
      body,
      '```',
    ].join('\n'))
    expect(out.outcomes).toHaveLength(1)
    expect(out.outcomes[0].status).toBe('resolved')
  })

  it('returns missing when the block is absent', () => {
    expect(parseRevalidationBlock('nothing').error).toBe('missing')
  })

  it('rejects unknown statuses', () => {
    const body = JSON.stringify({
      outcomes: [{ findingTitle: 't', status: 'maybe', rationale: 'r' }],
    })
    const out = parseRevalidationBlock([
      '```' + REVALIDATION_FENCE_TAG,
      body,
      '```',
    ].join('\n'))
    expect(out.error).toBe('schema')
  })
})

describe('RevalidationOutcomeSchema', () => {
  it('accepts the three canonical statuses', () => {
    for (const s of ['still-present', 'resolved', 'unverifiable'] as const) {
      RevalidationOutcomeSchema.parse({ findingTitle: 't', status: s, rationale: 'r' })
    }
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run src/review/__tests__/revalidate-prompt.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Create `src/review/revalidate-prompt.ts`**

```typescript
/**
 * Revalidation prompt — used when a watched PR/MR has moved since its last
 * review. We don't run a full review again; we ask the model to triage the
 * prior findings against the new diff.
 *
 * Inspired by clawpatch's revalidate pass — "is the evidence still present?" —
 * adapted for kode-review's diff-scoped review unit.
 */
import { z } from 'zod'
import type { Finding } from './finding-schema.js'

export const REVALIDATION_FENCE_TAG = 'kode-revalidation'

export const RevalidationOutcomeSchema = z.object({
  findingTitle: z.string().min(1),
  status: z.enum(['still-present', 'resolved', 'unverifiable']),
  rationale: z.string().min(1),
})

export type RevalidationOutcome = z.infer<typeof RevalidationOutcomeSchema>

export const RevalidationBlockSchema = z.object({
  outcomes: z.array(RevalidationOutcomeSchema),
})

export interface RevalidatePromptOptions {
  priorFindings: Finding[]
  newDiff: string
  prMrInfo?: string
}

export function buildRevalidatePrompt(opts: RevalidatePromptOptions): string {
  const findingsJson = JSON.stringify({ findings: opts.priorFindings }, null, 2)
  return [
    'You are reviewing an updated version of a PR you previously reviewed.',
    '',
    'Your job is NOT to do a fresh review. Your job is to triage the PRIOR FINDINGS against the NEW DIFF and report which ones are still present, which have been resolved, and which can no longer be verified from the visible diff.',
    '',
    '## Prior findings (from the previous review)',
    '',
    '```json',
    findingsJson,
    '```',
    '',
    opts.prMrInfo ? '## PR/MR Information\n\n```\n' + opts.prMrInfo + '\n```\n' : '',
    '## New diff (current state of the PR)',
    '',
    '<diff_content>',
    opts.newDiff,
    '</diff_content>',
    '',
    '## Output Format',
    '',
    'For each prior finding, classify its status:',
    '- **still-present** — the issue described in the prior finding is unchanged or only superficially edited.',
    '- **resolved** — the new diff fixes the issue. Cite the line(s) that resolve it.',
    '- **unverifiable** — the code path is no longer in the diff (file removed, function deleted, refactored beyond recognition). Do NOT guess; mark unverifiable.',
    '',
    'Emit exactly ONE fenced block tagged `' + REVALIDATION_FENCE_TAG + '`:',
    '',
    '```' + REVALIDATION_FENCE_TAG,
    '{',
    '  "outcomes": [',
    '    {',
    '      "findingTitle": "exact title from the prior finding",',
    '      "status": "still-present" | "resolved" | "unverifiable",',
    '      "rationale": "1-2 sentence explanation; cite path:lines where relevant"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Include one outcome per prior finding, matching by title. Do NOT introduce new findings in this pass — that\'s for the next full review.',
  ].join('\n')
}

export type RevalidationParseError = 'missing' | 'invalid-json' | 'schema'

export interface ParseRevalidationResult {
  outcomes: RevalidationOutcome[]
  error?: RevalidationParseError
  detail?: string
}

const FENCE_RE = new RegExp(
  '^```' + REVALIDATION_FENCE_TAG + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```',
  'gm',
)

export function parseRevalidationBlock(raw: string): ParseRevalidationResult {
  const blocks: string[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(raw)) !== null) blocks.push(m[1])
  if (blocks.length === 0) return { outcomes: [], error: 'missing' }

  let parsed: unknown
  try {
    parsed = JSON.parse(blocks[blocks.length - 1])
  } catch (err) {
    return { outcomes: [], error: 'invalid-json', detail: String(err) }
  }
  const result = RevalidationBlockSchema.safeParse(parsed)
  if (!result.success) return { outcomes: [], error: 'schema', detail: result.error.message }
  return { outcomes: result.data.outcomes }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/review/__tests__/revalidate-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the new helpers from `src/review/index.ts`**

Append:

```typescript
export {
  buildRevalidatePrompt,
  parseRevalidationBlock,
  RevalidationOutcomeSchema,
  RevalidationBlockSchema,
  REVALIDATION_FENCE_TAG,
  type RevalidationOutcome,
  type RevalidatePromptOptions,
  type ParseRevalidationResult,
  type RevalidationParseError,
} from './revalidate-prompt.js'
```

- [ ] **Step 6: Commit**

```bash
git add src/review/revalidate-prompt.ts src/review/__tests__/revalidate-prompt.test.ts src/review/index.ts
git commit -m "feat(review): add revalidation prompt + parser for prior-findings triage"
```

---

## Task 11: Watcher integration — revalidate on head change

**Files:**
- Modify: `src/watch/watcher.ts:147-149, 222-338` (filter logic + new `revalidateRequest` flow + mark-reviewed call sites)

Currently the watcher filters out any key that has been reviewed (line 147-149). We change the filter to *only* skip keys reviewed at the SAME head SHA — keys whose head has moved enter a revalidation flow that produces a focused diff-of-findings output instead of a full review.

This task does the real user-facing wiring. The detector + GitHub/GitLab clients already expose head refs via `getGitHubPRInfo` / `getGitLabMRInfo` — we plumb that through.

- [ ] **Step 1: Identify the head-SHA fields**

Run: `grep -n "head" src/vcs/github.ts src/vcs/gitlab.ts | head -20`
Expected: GitHub returns `headRefOid` (or `head.sha` depending on the gh JSON fields); GitLab returns `sha` on the MR. Confirm the exact field name before writing code. If unclear, run the existing tests in `src/vcs/__tests__/` to see what's mocked.

- [ ] **Step 2: Add a small helper to extract head SHA from the parsed info object**

In `src/watch/watcher.ts`, near the top-level helpers (above `reviewRequest`):

```typescript
export function extractHeadRef(platform: 'github' | 'gitlab', info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const obj = info as Record<string, unknown>
  if (platform === 'github') {
    // gh pr view --json headRefOid → { headRefOid: "abc..." }
    return typeof obj.headRefOid === 'string' ? obj.headRefOid : undefined
  }
  // glab mr view → { sha: "abc..." } or { diff_refs: { head_sha } }
  if (typeof obj.sha === 'string') return obj.sha
  const refs = obj.diff_refs
  if (refs && typeof refs === 'object' && typeof (refs as Record<string, unknown>).head_sha === 'string') {
    return (refs as Record<string, unknown>).head_sha as string
  }
  return undefined
}
```

(If the actual field names differ on your branch, adjust to match — the test in Step 6 will catch mismatches.)

- [ ] **Step 3: Change the filter in `runPollCycle` (around line 147-149)**

Replace:

```typescript
const newRequests = detection.found.filter(
  (req) => !stateManager.hasBeenReviewed(makeReviewRequestKey(req))
)
```

with:

```typescript
// A request is "new" if we have never reviewed it, OR its head SHA has moved
// since the last review. We can't tell head SHA from the detector summary, so
// we admit all keys with EITHER no prior outcome OR a recorded headRef, and
// branch inside reviewRequest after fetching info.
const newRequests = detection.found.filter((req) => {
  const key = makeReviewRequestKey(req)
  const prior = stateManager.getOutcome(key)
  if (!prior) return true
  // Legacy state with no recorded head → re-review once.
  if (!prior.headRef) return true
  // Otherwise admit and let reviewRequest skip if head matches.
  return true
})
```

Then inside `reviewRequest`, after the info object has been fetched (around line 247-260), branch on the head SHA. The existing code parses `info` then immediately stringifies it for `prMrInfo` — refactor those lines so the parsed object stays available:

```typescript
// Existing code parses info into a local variable then stringifies it.
// Keep both: the object (for head extraction) and the string (for the prompt).
let infoObj: unknown
let diffContent: string | null

if (request.platform === 'github') {
  const [diff, info] = await Promise.all([
    getGitHubPRDiff(request.id),
    getGitHubPRInfo(request.id),
  ])
  diffContent = diff
  infoObj = info
} else {
  const [diff, info] = await Promise.all([
    getGitLabMRDiff(request.id),
    getGitLabMRInfo(request.id),
  ])
  diffContent = diff
  infoObj = info
}

const prMrInfo = infoObj ? JSON.stringify(infoObj, null, 2) : undefined

if (!diffContent) {
  throw new Error('Failed to fetch diff')
}

const headRef = extractHeadRef(request.platform, infoObj)
const prior = stateManager.getOutcome(key)

if (prior?.headRef && headRef && prior.headRef === headRef) {
  spinner?.succeed('Diff fetched')
  logger.info(`Skipping ${label}: head unchanged since last review (${headRef.slice(0, 7)})`)
  return
}

if (prior?.headRef && prior.findings && prior.findings.length > 0 && headRef) {
  spinner?.succeed('Diff fetched')
  await revalidateRequest(request, prior.findings, diffContent, prMrInfo, headRef, cliOptions, ctx, stateManager)
  return
}
```

- [ ] **Step 4: Implement `revalidateRequest`**

Add after `reviewRequest` in `src/watch/watcher.ts`:

```typescript
async function revalidateRequest(
  request: ReviewRequest,
  priorFindings: Finding[],
  newDiff: string,
  prMrInfo: string | undefined,
  headRef: string,
  cliOptions: CliOptions,
  ctx: CliContext,
  stateManager: WatchStateManager,
): Promise<void> {
  const key = makeReviewRequestKey(request)
  const label = formatReviewRequest(request)

  console.log('')
  console.log(cyan('========================================'))
  console.log(cyan(`Revalidating: ${request.repository} #${request.id}`))
  console.log(cyan(`Prior findings: ${priorFindings.length}`))
  console.log(cyan('========================================'))

  const userPrompt = buildRevalidatePrompt({ priorFindings, newDiff, prMrInfo })

  const spinner = ctx.quiet ? null : ora('Re-checking prior findings against new diff...').start()
  try {
    const result = await runReview({
      diffContent: newDiff,
      context: `Revalidating prior findings on ${request.platform} #${request.id}`,
      prMrInfo,
      model: cliOptions.model,
      userPromptOverride: userPrompt,
    })
    spinner?.stop()

    const parsed = parseRevalidationBlock(result.content)
    const resolved = parsed.outcomes.filter((o) => o.status === 'resolved')
    const still = parsed.outcomes.filter((o) => o.status === 'still-present')
    const unverifiable = parsed.outcomes.filter((o) => o.status === 'unverifiable')

    console.log('')
    console.log(green(`Resolved (${resolved.length}):`))
    for (const o of resolved) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    console.log('')
    console.log(yellow(`Still present (${still.length}):`))
    for (const o of still) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    if (unverifiable.length > 0) {
      console.log('')
      console.log(`Unverifiable (${unverifiable.length}):`)
      for (const o of unverifiable) console.log(`  - ${o.findingTitle} — ${o.rationale}`)
    }

    // Persist: keep only still-present findings as the new baseline.
    const survivingTitles = new Set(still.map((o) => o.findingTitle))
    const survivingFindings = priorFindings.filter((f) => survivingTitles.has(f.title))

    stateManager.markReviewed({
      key,
      success: true,
      reviewedAt: new Date().toISOString(),
      headRef,
      findings: survivingFindings,
    })

    logger.success(`Revalidation complete: ${label} (${resolved.length} resolved, ${still.length} remaining)`)
  } catch (error) {
    spinner?.fail('Revalidation failed')
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to revalidate ${label}: ${errorMessage}`)
    // Fall through without marking — next poll will retry.
  }
}
```

Add the needed imports at the top of the file:

```typescript
import { buildRevalidatePrompt, parseRevalidationBlock } from '../review/revalidate-prompt.js'
import type { Finding } from '../review/finding-schema.js'
```

- [ ] **Step 5: Update the `markReviewed` call in `reviewRequest` to include head + findings**

Find (around line 310-315 and 327-336) the existing two `stateManager.markReviewed({ ... })` calls and add the new fields:

```typescript
// success branch
const outcome: ReviewOutcome = {
  key,
  success: true,
  reviewedAt: new Date().toISOString(),
  headRef,
  findings: result.findings,
}
stateManager.markReviewed(outcome)

// failure branch — leave headRef/findings unset so a retry runs a full review
```

(`headRef` is already in scope from Step 3; `result.findings` exists because of Task 4.)

- [ ] **Step 6: Add a watcher integration test**

Create `src/watch/__tests__/watcher-revalidation.test.ts` — a focused test for `extractHeadRef`. Full watcher loop testing is beyond scope (it touches network); we cover the pure helper.

```typescript
import { describe, it, expect } from 'vitest'
import { extractHeadRef } from '../watcher.js'

describe('extractHeadRef', () => {
  it('reads GitHub headRefOid', () => {
    expect(extractHeadRef('github', { headRefOid: 'abc123' })).toBe('abc123')
  })

  it('reads GitLab sha', () => {
    expect(extractHeadRef('gitlab', { sha: 'def456' })).toBe('def456')
  })

  it('falls back to GitLab diff_refs.head_sha', () => {
    expect(extractHeadRef('gitlab', { diff_refs: { head_sha: 'ghi789' } })).toBe('ghi789')
  })

  it('returns undefined for missing data', () => {
    expect(extractHeadRef('github', null)).toBeUndefined()
    expect(extractHeadRef('github', {})).toBeUndefined()
    expect(extractHeadRef('gitlab', { wrong: 'field' })).toBeUndefined()
  })
})
```

- [ ] **Step 7: Run all tests**

Run: `bun run test`
Expected: PASS for all new and pre-existing tests.

- [ ] **Step 8: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Exercise the change manually**

The watcher hits real VCS APIs, so end-to-end requires a live PR. Minimum smoke test:

```bash
bun run build
# Pick a watchable PR you've already reviewed once.
# Push a follow-up commit to that PR's branch.
# Then:
node dist/index.js --watch --interactive
```

Expected: when the watcher polls and finds the PR with a new head SHA, the terminal prints the "Revalidating" banner and emits the resolved/still-present summary, not a full review. If no live PR is available, raise a request for waiver of Step 7 of the per-CLAUDE.md workflow rather than self-skipping.

- [ ] **Step 10: Commit**

```bash
git add src/watch/watcher.ts src/watch/__tests__/watcher-revalidation.test.ts
git commit -m "feat(watch): revalidate prior findings when a watched PR/MR head moves"
```

---

## Self-Review

**Spec coverage:**
- Item 1 (tests as ground truth) → Task 5; retrieval bias preserved (1.5x test multiplier + cap of 3 in `src/indexer/context.ts:37,42` is already in place).
- Item 2 (owned-vs-context scoping) → Task 6.
- Item 3 (strict Zod schema with required evidence) → Tasks 1, 2, 3, 4.
- Item 4 (path-based trust-boundary hints) → Tasks 7, 8.
- Item 5 (fixed category enum) → Task 1 (CATEGORIES).
- Item 6 (severity × confidence two-axis) → Task 1 (separate fields) + Task 3 (prompt language).
- Item 7 (revalidation prompt in watch mode) → Tasks 9, 10, 11.

**Type consistency:** `Finding` is defined in Task 1 and consumed identically in Tasks 2 (parser return), 4 (engine return), 9 (watch state), 10 (revalidate input), 11 (watcher branching). `TrustBoundary` is internal to tasks 7–8. `RevalidationOutcome` is internal to tasks 10–11. `extractHeadRef` is exported from Task 11 Step 2 (added `export`) so the test in Step 6 can import it.

**Placeholder scan:** every code block above contains complete, runnable TypeScript. No "TBD", no "add appropriate error handling", no "similar to Task N." File:line references at the top of each task identify the modification target. Task 11 step 1 (`grep` for head SHA fields) is the one exploratory step — it is necessary because the exact gh/glab JSON field names depend on the repo's installed `gh`/`glab` versions; the test in Task 11 step 6 fails if the wrong field is used, so misidentification is caught immediately.

**Open assumption flagged:** Task 11 assumes the parsed `info` object from `getGitHubPRInfo` / `getGitLabMRInfo` is currently being stringified into `prMrInfo` and not retained. The watcher code at lines 252 and 258 shows `JSON.stringify(info, null, 2)` — the parsed `info` is dropped after stringification. Task 11 Step 3 explicitly says to retain it.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-clawpatch-quality-borrows.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
