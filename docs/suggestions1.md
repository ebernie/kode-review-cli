# Enhancing Code Review with Semantic Context

This document analyzes the current semantic context implementation and provides suggestions for improvement.

## Current State

The current implementation provides **similarity-based** context using vector embeddings:

1. Extract function names/imports from the diff via regex
2. Embed those as queries
3. Cosine similarity search returns chunks that "look similar"
4. Format and include in prompt with extra review criteria

### Architecture Flow

```
Diff → extractQueriesFromDiff() → [queries] → IndexerClient.search() → [chunks] → formatContext() → prompt
```

### Key Files

| File | Purpose |
|------|---------|
| `src/indexer/context.ts` | Query extraction and context retrieval |
| `src/indexer/docker/indexer.py` | Code chunking and embedding generation |
| `src/indexer/docker/main.py` | FastAPI search endpoint |
| `src/review/prompt.ts` | Prompt construction with context |

---

## Can the Index Find "Related" (Not Just "Similar") Code?

**Currently: No.** The index only stores:
- Code text chunks
- 384-dimensional embeddings (semantic similarity)
- File/line metadata

### What's Missing for "Related" Code

| Relationship Type | Example | Current Support |
|------------------|---------|-----------------|
| Callers/Callees | `authService.login()` → who calls `login()`? | ❌ No call graph |
| Type implementers | `interface User` → classes implementing it? | ❌ No type graph |
| Test ↔ Implementation | `user.ts` → `user.test.ts` | ❌ No file association |
| Module imports | `import { foo }` → what uses `foo`? | ❌ No import graph |
| Definitions | `User` type used in diff → where is it defined? | ❌ No symbol lookup |
| Similar patterns | Functions that handle errors the same way | ✅ Works well |

---

## Enhancement Opportunities

### 1. Low-Hanging Fruit (Quick Wins)

#### A. Include Modified Lines (Not Just Additions)

**Current limitation** (`context.ts:56-59`):
```typescript
// Only look at added lines
if (!line.startsWith('+') || line.startsWith('+++')) {
  continue
}
```

**Problem**: Misses context from modified lines (lines with both `-` and `+`).

**Fix**: Also extract queries from removed lines to find where the old code was used:
```typescript
// Include both + and - lines (but not headers)
if (!line.startsWith('+') && !line.startsWith('-')) continue
if (line.startsWith('+++') || line.startsWith('---')) continue
```

#### B. Hybrid Search (Vector + Keyword)

Currently pure vector search. Add BM25/keyword matching for exact identifier matches:

```sql
-- Current: only vector
ORDER BY embedding <=> query_vector

-- Better: combine vector similarity with exact matches
ORDER BY
  0.7 * (1 - (embedding <=> query_vector)) +  -- semantic
  0.3 * ts_rank(to_tsvector(code), query)      -- keyword
```

#### C. File-Based Retrieval for Test Files

Simple heuristic: if diff touches `auth.ts`, also search for `auth.test.ts` or `auth.spec.ts`:

```typescript
function getTestFilePatterns(filename: string): string[] {
  const base = filename.replace(/\.[^.]+$/, '')
  return [`${base}.test.*`, `${base}.spec.*`, `__tests__/${base}.*`]
}
```

#### D. Expand Query Extraction

Current regex patterns miss common cases. Add:
- Method calls: `this.methodName(` → extract `methodName`
- Property access: `obj.propertyName` → for tracking API usage
- Constants/enums: `STATUS_CODE.OK` → find other usages

#### E. Project Structure Context

Include a simplified ASCII tree of the project structure to help the LLM understand architectural intent:

```typescript
function getProjectStructure(rootPath: string, maxDepth: number = 2): string {
  // Generate tree like:
  // src/
  //   components/
  //   utils/
  //   services/
  // tests/
  return generateTree(rootPath, maxDepth)
}
```

*Why*: Enables architectural critiques like "Why is a UI component in `src/utils`?"

#### F. Configuration Context

Automatically include key config files if not already in the diff:
- `package.json` (dependencies)
- `tsconfig.json` (TypeScript rules)
- `.eslintrc` (lint rules)

*Why*: Helps answer "Do we have lodash installed?" or "Are we allowing `any`?"

#### G. PR Description Integration

Use PR title/description to adjust review focus and severity:

```typescript
function adjustReviewFocus(prInfo: PRInfo): ReviewCriteria {
  const text = `${prInfo.title} ${prInfo.body}`.toLowerCase()

  if (text.includes('fix') || text.includes('bug')) {
    return { focus: ['security', 'bugs', 'edge-cases'], severity: 'strict' }
  } else if (text.includes('refactor')) {
    return { focus: ['code-quality', 'consistency'], severity: 'standard' }
  } else if (text.includes('feature')) {
    return { focus: ['security', 'edge-cases', 'testing'], severity: 'thorough' }
  }
  return { focus: ['all'], severity: 'standard' }
}
```

*Why*: Already have `prMrInfo` parameter; use it to guide the review.

#### H. File-Type Specific Context Strategy

Apply different context retrieval strategies based on file type:

```typescript
interface FileStrategy {
  includeTests: boolean
  includeCallers: boolean
  contextMultiplier: number
}

function getFileStrategy(filename: string): FileStrategy {
  if (filename.includes('.test.') || filename.includes('.spec.')) {
    return { includeTests: false, includeCallers: true, contextMultiplier: 1.5 }
  }
  if (filename.includes('config.') || filename.endsWith('.config.ts')) {
    return { includeTests: false, includeCallers: true, contextMultiplier: 0.5 }
  }
  if (filename.endsWith('.d.ts') || filename.includes('types.')) {
    return { includeTests: false, includeCallers: true, contextMultiplier: 0.8 }
  }
  // Default: source code
  return { includeTests: true, includeCallers: true, contextMultiplier: 1.0 }
}
```

---

### 2. Medium Effort (Significant Value)

#### A. Store Metadata During Indexing

Enhance `indexer.py` to extract and store:

```python
@dataclass
class CodeChunk:
    filename: str
    code: str
    # NEW fields:
    chunk_type: str        # "function", "class", "module", "block"
    identifiers: list[str] # names defined in this chunk
    imports: list[str]     # what this chunk imports
    exports: list[str]     # what this chunk exports
```

Then enable queries like:
```sql
-- Find code that imports a specific module
SELECT * FROM code_embeddings
WHERE 'authService' = ANY(imports)
```

#### B. Function-Boundary Chunking

Current chunking is character-based (1000 chars). Better: AST-aware chunking that splits at function/class boundaries:

```python
# Instead of:
chunk_code(content, filename, chunk_size=1000)

# Do:
chunks = extract_functions_and_classes(content, filename, language)
# Returns complete functions as single chunks
```

Benefits:
- Each chunk is a complete semantic unit
- Embeddings capture full function context
- No split functions in results

#### C. Track What Changed vs What's Nearby

Separate "chunks in the diff" from "chunks near the diff":
- **Direct match**: code chunk overlaps with diff lines
- **Nearby**: code chunk is in the same file, near the diff
- **Similar**: semantically similar from other files

Present them differently in the prompt:
```markdown
## Direct Context (same file as changes)
...

## Similar Patterns (from other files)
...
```

#### D. Definition Lookups (Go-to-Definition)

If the diff modifies code using a type `User` or function `calculateTotal()`, include their **definitions** from other files:

```typescript
async function getDefinitions(identifiers: string[], repoUrl: string): Promise<CodeChunk[]> {
  // For each identifier used in the diff:
  // 1. Search for "export function/class/type <identifier>"
  // 2. Return the defining chunk
  const definitions: CodeChunk[] = []
  for (const id of identifiers) {
    const results = await client.search(`export ${id}`, repoUrl, 3)
    definitions.push(...results.filter(r => r.code.includes(`export`)))
  }
  return definitions
}
```

*Why*: Vector search often misses this; symbol-based lookup is needed for breaking change detection.

#### E. Usage Lookups (Find References)

When a function signature changes, find examples of where it's called:

```typescript
async function getCallers(functionName: string, repoUrl: string): Promise<CodeChunk[]> {
  // Search for code that calls this function
  return client.search(`${functionName}(`, repoUrl, 5)
}
```

*Why*: Critical for detecting breaking changes when signatures change.

#### F. Import Chains (Shallow Depth)

Include content of files imported by the modified file:

```typescript
async function getImportContext(diffContent: string, repoUrl: string): Promise<CodeChunk[]> {
  const imports = extractImports(diffContent)
  const chunks: CodeChunk[] = []

  for (const importPath of imports.slice(0, 3)) { // Limit depth
    const results = await client.search(importPath, repoUrl, 2)
    chunks.push(...results)
  }
  return chunks
}
```

*Why*: Provides immediate execution context without full call graph complexity.

#### G. Structured Context Format

Format semantic context with detailed sections rather than a single blob:

```xml
<related_code>
  <similar_patterns>
    <!-- Code that looks similar -->
  </similar_patterns>
  <definitions>
    <!-- Type/function definitions used in diff -->
  </definitions>
  <callers>
    <!-- Code that calls modified functions -->
  </callers>
</related_code>
```

*Why*: Better organization for LLM parsing and targeted review criteria.

#### H. Multi-Stage Retrieval

Implement a three-stage retrieval approach:

```typescript
export async function getSemanticContext(options: SemanticContextOptions): Promise<string | null> {
  // Stage 1: Semantic search for similar code (current)
  const semanticResults = await client.search(query, repoUrl, topK, branch)

  // Stage 2: Structural relationship retrieval
  const relatedResults = await client.getRelatedCode({
    repoUrl,
    branch,
    files: extractFilesFromDiff(diffContent)
  })

  // Stage 3: Combine and diversify results
  return combineResults(semanticResults, relatedResults, maxTokens)
}
```

---

### 3. Higher Effort (Structural Relationships)

#### A. Build a Call Graph

During indexing, extract function calls:
```python
# New table
CREATE TABLE code_relations (
    source_chunk_id INT,
    target_identifier TEXT,
    relation_type TEXT,  -- 'calls', 'imports', 'extends', 'implements'
    PRIMARY KEY (source_chunk_id, target_identifier, relation_type)
);
```

Then query both ways:
```sql
-- Find callers of function X
SELECT * FROM code_embeddings ce
JOIN code_relations cr ON ce.id = cr.source_chunk_id
WHERE cr.target_identifier = 'myFunction' AND cr.relation_type = 'calls'
```

#### B. Cross-File Impact Analysis

When reviewing a change to `function X`:
1. Find all chunks that call `X` (callers)
2. Find all chunks that `X` calls (dependencies)
3. Include both in context with labels

This lets the reviewer see: "This change affects 5 callers across 3 files"

---

## Other Low-Hanging Improvements (Beyond Semantic Context)

### 1. Smarter Prompt Construction

#### A. Diff Size Awareness

Adjust review depth based on diff size:
```typescript
const diffLines = diff.split('\n').length
const reviewIntensity = diffLines < 50 ? 'detailed' :
                        diffLines < 200 ? 'standard' : 'focused'
```

For large diffs, prioritize critical files (e.g., security-related, core logic).

#### B. File Type Prioritization

Review order matters. Suggest reviewing:
1. API contracts / interfaces first
2. Business logic second
3. Tests third (to verify coverage)
4. Utilities/helpers last

### 2. Pre-Review Checks

Before LLM review, run fast static checks:
- TypeScript: `tsc --noEmit` errors
- Lint errors
- Known vulnerability patterns (regex-based)

Include results in prompt:
```markdown
## Pre-Review Findings
- 2 TypeScript errors detected
- 1 ESLint warning
```

#### Test Summary (Pass/Fail)

If tests exist for modified files, run them and report status:
```markdown
## Test Results
- src/auth/login.test.ts: PASS (12 tests)
- src/auth/logout.test.ts: FAIL (2 of 5 tests failed)
```

*Why*: If tests pass, LLM can focus on maintainability rather than "does this work?"

### 3. Incremental Review Mode

For PRs with many commits, allow reviewing commit-by-commit:
```bash
kode-review --incremental  # Review each commit separately
```

Each commit is smaller and more focused → better reviews.

### 4. Review Templates by Change Type

Detect the type of change and use specialized prompts:
- **Dependency update**: Focus on breaking changes, security advisories
- **Refactoring**: Focus on behavioral equivalence
- **New feature**: Focus on edge cases, security, testing
- **Bug fix**: Focus on root cause, regression potential

---

## Future Extensibility

### Configuration-Based Context Strategies

Allow teams to define custom context strategies via config:

```typescript
interface IndexerConfig {
  contextStrategy: 'similarity' | 'diversity' | 'comprehensive'
  includeTests: boolean
  includeCallers: boolean
  maxFiles: number
  fileFilters: string[]
}
```

### Cross-Repository Context

For microservices/monorepos, enable searching across multiple indexed repositories:

```typescript
// Search similar patterns in other repos
const crossRepoResults = await client.search(query, undefined, topK)
```

---

## Recommended Implementation Order

| Priority | Enhancement | Effort | Impact |
|----------|-------------|--------|--------|
| 1 | Include modified lines (not just additions) | Low | Medium |
| 2 | File-based test retrieval | Low | Medium |
| 3 | Expand query extraction patterns | Low | Medium |
| 4 | PR description integration | Low | Medium-High |
| 5 | Project structure context | Low | Medium |
| 6 | Configuration context files | Low | Medium |
| 7 | File-type specific strategies | Low-Medium | Medium-High |
| 8 | Hybrid search (vector + keyword) | Medium | High |
| 9 | Pre-review static checks + test summary | Medium | High |
| 10 | Structured context format (XML sections) | Medium | Medium |
| 11 | Definition lookups | Medium | High |
| 12 | Usage lookups (find references) | Medium | High |
| 13 | Import chains (shallow depth) | Medium | Medium-High |
| 14 | Store identifiers/imports metadata | Medium | High |
| 15 | Function-boundary chunking | Medium | High |
| 16 | Multi-stage retrieval | Medium | High |
| 17 | Call graph construction | High | Very High |

---

## Summary

The current semantic context system provides value through similarity-based retrieval, but it cannot find **structurally related** code (callers, implementers, tests, definitions).

**Quick wins** (items 1-7) focus on:
- Expanding what we extract from diffs
- Adding simple heuristics (test file association, file-type strategies)
- Leveraging existing data (PR description, config files)

**Medium-term** improvements (items 8-16) add:
- Hybrid search for better precision
- Symbol-based lookups (definitions, references)
- Structured context presentation
- Multi-stage retrieval architecture

**Long-term** building a proper call graph would enable true impact analysis, showing reviewers exactly what code depends on the changes.

### Key Insight

The best enhancement may not be more sophisticated retrieval algorithms, but rather **smarter selection and presentation** of the results we already have—combined with ground-truth data from linters/compilers to reduce hallucinated issues.
