# Code Review Enhancement Suggestions

## Overview

This document outlines opportunities to enhance the code review system with semantic context and related code retrieval.

## Current Semantic Context Implementation

The system extracts queries from the diff (function names, imports, code snippets) and uses vector similarity search to find related code. The context is then included in the review prompt with instructions to use it for consistency checking.

**Key Files:**
- `src/review/engine.ts` - Review execution
- `src/review/prompt.ts` - Prompt construction with context
- `src/indexer/context.ts` - Semantic context retrieval
- `src/indexer/client.ts` - Indexer API client
- `src/indexer/docker/indexer.py` - Indexer implementation
- `src/indexer/docker/main.py` - API server

## Enhancement Opportunities

### 1. Index for Related Code (Not Just Similar)

**Current Gap:** The indexer only stores embeddings, enabling similarity search but not structural relationships.

#### Solution A: Add Relationship Tracking to Indexer

Track relationships during indexing to enable structural queries:

```sql
-- Add to code_embeddings table:
caller_files TEXT[]        -- Files that import this chunk
imported_modules TEXT[]     -- Modules this chunk imports
test_files TEXT[]           -- Related test files
parent_module TEXT          -- Parent module/package
exported_symbols TEXT[]     -- Functions/classes exported by this chunk
```

Add new endpoints to `main.py`:

```python
@app.post("/related", response_model=RelatedCodeResponse)
async def get_related_code(request: RelatedCodeRequest):
    """Get related code by structure, not just similarity."""
    # Retrieve:
    # - Files imported by the target file
    # - Files that import the target file
    # - Related test files
    # - Parent/child modules
```

#### Solution B: Multi-Stage Retrieval

Implement in `src/indexer/context.ts`:

```typescript
export async function getSemanticContext(options: SemanticContextOptions): Promise<string | null> {
  // Stage 1: Semantic search for similar code (current implementation)
  const semanticResults = await client.search(query, repoUrl, topK, branch)
  
  // Stage 2: Retrieve structural relationships for top results
  const relatedResults = await client.getRelatedCode({
    repoUrl,
    branch,
    files: extractFilesFromDiff(diffContent)
  })
  
  // Stage 3: Combine and diversify results
  return combineResults(semanticResults, relatedResults, maxTokens)
}
```

### 2. Smarter Query Extraction

**Current:** Simple regex pattern matching on diff lines.

**Enhancement:** Use AST parsing and multi-query strategy:

```typescript
// Improved extractQueriesFromDiff()
// - Parse changed files with AST parsers
// - Extract exact function signatures, not just names
// - Generate related concept queries (e.g., "validateUser" → "user auth validation")
// - Extract import chains to find module boundaries
// - Identify changed types/interfaces separately
```

Implementation approach:
1. Use tree-sitter or similar AST parser for each language
2. Extract exact function signatures with parameter types
3. Generate concept variations (camelCase, snake_case, descriptive phrases)
4. Track import dependency chains
5. Separate queries by type (functions, classes, types, tests)

### 3. Diverse Context Selection

**Current:** Ranked by similarity score → top-K.

**Problem:** May return 5 chunks from the same file, missing broader context.

**Enhancement:** Ensure coverage across dimensions:

```typescript
function selectDiverseContext(chunks: CodeChunk[], maxTokens: number): CodeChunk[] {
  // Ensure:
  // - Different files (not all from same file)
  // - Different modules/packages
  // - Mix of: code using patterns, code defining patterns, tests
  // - Both callers and callees

  const seenFiles = new Set<string>()
  const seenModules = new Set<string>()
  const diverseChunks: CodeChunk[] = []

  for (const chunk of chunks) {
    const module = chunk.filename.split('/')[0]
    
    // Skip if we already have this file (unless we need more files)
    if (seenFiles.has(chunk.filename) && seenFiles.size < 5) {
      continue
    }
    
    // Skip if we already have this module (unless we need more modules)
    if (seenModules.has(module) && seenModules.size < 3) {
      continue
    }
    
    seenFiles.add(chunk.filename)
    seenModules.add(module)
    diverseChunks.push(chunk)
    
    if (estimateTotalTokens(diverseChunks) > maxTokens) {
      break
    }
  }

  return diverseChunks
}
```

### 4. Low-Hanging Fruit Improvements

#### A. Add Test File Context

Automatically discover and include related test files:

```typescript
async function getTestContext(files: string[]): Promise<CodeChunk[]> {
  const testChunks: CodeChunk[] = []
  
  for (const file of files) {
    // Find corresponding test files
    const testPatterns = [
      file.replace(/\.ts$/, '.test.ts'),
      file.replace(/\.ts$/, '.spec.ts'),
      file.replace(/\.ts$/, '.test.js'),
      `__tests__/${path.basename(file)}`,
      `tests/${file}`,
    ]
    
    for (const testFile of testPatterns) {
      const results = await client.search(
        testFile,
        repoUrl,
        topK,
        branch
      )
      testChunks.push(...results)
    }
  }
  
  return testChunks
}
```

#### B. Include Dependency Information

Show what modules/files depend on changed code to identify breaking changes:

```typescript
// Add to client.ts
async getCallersForFile(filename: string, repoUrl: string, branch?: string): Promise<string[]> {
  const response = await fetch(`${this.baseUrl}/callers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, repo_url: repoUrl, branch })
  })
  
  const data = await response.json()
  return data.callers
}
```

#### C. Pattern Consistency Checking

Extract patterns from related code and compare:

```typescript
interface CodePattern {
  errorHandling: 'throw' | 'return-error' | 'callback-error'
  asyncPattern: 'async-await' | 'callbacks' | 'promises'
  naming: 'camelCase' | 'snake_case' | 'PascalCase'
  imports: 'es6' | 'commonjs'
}

function analyzePatternConsistency(relatedChunks: CodeChunk[], diffContent: string): PatternReport {
  const patterns = extractPatterns(relatedChunks)
  const diffPatterns = extractPatterns([diffContent])
  
  const inconsistencies: string[] = []
  
  if (patterns.errorHandling !== diffPatterns.errorHandling) {
    inconsistencies.push(
      `Error handling pattern mismatch: related code uses ${patterns.errorHandling}, ` +
      `changes use ${diffPatterns.errorHandling}`
    )
  }
  
  return { inconsistencies, patterns, diffPatterns }
}
```

#### D. PR Description Integration

Use PR description to understand intent and adjust focus:

```typescript
function adjustReviewFocus(prInfo: PRInfo): ReviewCriteria {
  const title = prInfo.title.toLowerCase()
  const description = prInfo.body.toLowerCase()
  const text = `${title} ${description}`
  
  const criteria: Partial<ReviewCriteria> = {}
  
  if (text.includes('fix') || text.includes('bug')) {
    criteria.focus = ['security', 'bugs', 'edge-cases']
    criteria.severity = 'strict'
  } else if (text.includes('refactor')) {
    criteria.focus = ['code-quality', 'consistency', 'performance']
    criteria.severity = 'standard'
  } else if (text.includes('feature') || text.includes('add')) {
    criteria.focus = ['security', 'edge-cases', 'testing', 'documentation']
    criteria.severity = 'thorough'
  }
  
  return criteria
}
```

#### E. File-Type Specific Context

Apply different strategies based on file type:

```typescript
interface FileStrategy {
  includeTests: boolean
  includeCallers: boolean
  includeRelated: boolean
  chunkSizeMultiplier: number
}

function getFileStrategy(filename: string): FileStrategy {
  if (filename.endsWith('.test.ts') || filename.includes('.test.')) {
    return {
      includeTests: false,
      includeCallers: true,  // Get the code being tested
      includeRelated: true,
      chunkSizeMultiplier: 1.5  // Larger context for tests
    }
  }
  
  if (filename.endsWith('.config.ts') || filename.includes('config.')) {
    return {
      includeTests: false,
      includeCallers: true,  // Get code using this config
      includeRelated: false,
      chunkSizeMultiplier: 0.5  // Less context needed for config
    }
  }
  
  if (filename.endsWith('.d.ts') || filename.includes('types.')) {
    return {
      includeTests: false,
      includeCallers: true,  // Get implementations
      includeRelated: false,
      chunkSizeMultiplier: 0.8
    }
  }
  
  // Default: source code
  return {
    includeTests: true,
    includeCallers: true,
    includeRelated: true,
    chunkSizeMultiplier: 1.0
  }
}
```

## Recommended Priority

### High Impact, Low Effort

1. **Add test file discovery**
   - Look for `*.test.ts`, `*.spec.ts`, `__tests__/` patterns
   - Include test context to understand expected behavior
   - Implementation: Add to `src/indexer/context.ts`

2. **Include PR description in context**
   - Already available as `prMrInfo` parameter
   - Use to adjust review focus and severity
   - Implementation: Add to `src/review/prompt.ts`

3. **Diversify results across files**
   - Avoid 5 chunks from same file
   - Ensure broader context
   - Implementation: Modify `src/indexer/context.ts:199-224`

### Medium Effort

4. **Track import/export relationships in indexer**
   - Add columns to database schema
   - Update indexer to extract relationships
   - Implementation: Modify `src/indexer/docker/indexer.py`

5. **Multi-query strategy with concept expansion**
   - Generate variations of each query
   - Combine results intelligently
   - Implementation: Modify `src/indexer/context.ts`

6. **Caller/callee relationship queries**
   - Add `/callers` endpoint to API
   - Use to identify potential breaking changes
   - Implementation: Add to `src/indexer/docker/main.py` and `src/indexer/client.ts`

### Higher Effort

7. **AST-based query extraction**
   - Use tree-sitter for accurate parsing
   - Extract exact signatures and type information
   - Implementation: New module with language parsers

8. **Pattern consistency analysis**
   - Detect patterns in related code
   - Compare with changes
   - Implementation: Add to review engine

9. **Dependency graph tracking**
   - Build full dependency graph during indexing
   - Query for impact analysis
   - Implementation: Major indexer enhancement

## Quick Win Implementation

The simplest enhancement would be modifying `src/indexer/context.ts:199-224` to ensure diversity:

```typescript
// Replace the current selection logic with:

// Sort by relevance score first
allChunks.sort((a, b) => b.score - a.score)

// Ensure chunks come from different files
const seenFiles = new Set<string>()
const diverseChunks: CodeChunk[] = []
let totalTokens = 0

for (const chunk of allChunks) {
  // Skip if we already have this file (unless we have very few files)
  if (seenFiles.has(chunk.filename) && seenFiles.size < 5) {
    continue
  }
  
  const chunkTokens = estimateTokens(chunk.code) + 50
  if (totalTokens + chunkTokens > maxTokens) {
    break
  }
  
  seenFiles.add(chunk.filename)
  diverseChunks.push(chunk)
  totalTokens += chunkTokens
  
  if (diverseChunks.length >= topK * 2) {
    break
  }
}

logger.info(`Including ${diverseChunks.length} related code chunks from ${seenFiles.size} files (${totalTokens} estimated tokens)`)

return formatContext(diverseChunks)
```

This ensures the review sees code from multiple files, providing better pattern visibility than 5 chunks from a single file.

## Additional Ideas

### Cross-Repository Context

If teams work across multiple repos, enable searching across indexed repositories:

```typescript
// Search similar patterns in other repos
const crossRepoResults = await client.search(query, undefined, topK)
// Useful for: microservices, shared libraries, monorepos
```

### Historical Context

Track how code has changed over time:

```sql
-- Add to code_embeddings:
commit_hash TEXT,
commit_date TIMESTAMP,
change_type TEXT  -- 'add', 'modify', 'delete'
```

Use this to understand evolution and identify recurring patterns.

### Configuration-Based Context Strategies

Allow teams to define custom context strategies:

```typescript
// In config/schema.ts:
export interface IndexerConfig {
  contextStrategy: 'similarity' | 'diversity' | 'comprehensive'
  includeTests: boolean
  includeCallers: boolean
  maxFiles: number
  fileFilters: string[]
}
```

## Conclusion

The current semantic context implementation provides a solid foundation. The suggested enhancements prioritize quick wins that provide immediate value, while also outlining a path for more sophisticated improvements that could significantly enhance review quality.

Key insight: The best enhancement may not be more sophisticated retrieval algorithms, but rather smarter selection and diversity of the results we already have.
