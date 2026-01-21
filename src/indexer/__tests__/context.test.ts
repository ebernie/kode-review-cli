import { describe, it, expect } from 'vitest'
import {
  extractQueriesFromDiff,
  parseDiffToModifiedLines,
  chunkOverlapsModifiedLines,
  applyModifiedLineWeighting,
} from '../context.js'
import type { CodeChunk, ParsedDiff } from '../types.js'

describe('extractQueriesFromDiff', () => {
  it('extracts function names from TypeScript/JavaScript function declarations', () => {
    const diff = `
diff --git a/src/utils.ts b/src/utils.ts
+++ b/src/utils.ts
+function calculateTotal(items: number[]): number {
+  return items.reduce((sum, item) => sum + item, 0)
+}
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('calculateTotal')
  })

  it('extracts const arrow function names', () => {
    const diff = `
diff --git a/src/utils.ts b/src/utils.ts
+++ b/src/utils.ts
+const processUser = async (userId: string) => {
+  const user = await fetchUser(userId)
+  return user
+}
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('processUser')
  })

  it('extracts class and interface names', () => {
    const diff = `
diff --git a/src/models.ts b/src/models.ts
+++ b/src/models.ts
+class UserService {
+  private db: Database
+}
+
+interface PaymentConfig {
+  apiKey: string
+}
+
+type UserRole = 'admin' | 'user'
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('UserService')
    expect(queries).toContain('PaymentConfig')
    expect(queries).toContain('UserRole')
  })

  it('extracts import paths', () => {
    const diff = `
diff --git a/src/app.ts b/src/app.ts
+++ b/src/app.ts
+import { something } from '@myapp/utils/helpers'
+import express from 'express'
`
    const queries = extractQueriesFromDiff(diff)
    // The import path is cleaned and spaces are added
    expect(queries.some((q) => q.includes('myapp'))).toBe(true)
    expect(queries.some((q) => q.includes('express'))).toBe(true)
  })

  it('extracts Python function and class names', () => {
    const diff = `
diff --git a/main.py b/main.py
+++ b/main.py
+def process_data(data):
+    return cleaned_data
+
+class DataProcessor:
+    def __init__(self):
+        pass
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('process_data')
    expect(queries).toContain('DataProcessor')
  })

  it('extracts Rust function and struct names', () => {
    const diff = `
diff --git a/src/lib.rs b/src/lib.rs
+++ b/src/lib.rs
+fn calculate_hash(data: &[u8]) -> u64 {
+    0
+}
+
+struct Configuration {
+    port: u16,
+}
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('calculate_hash')
    expect(queries).toContain('Configuration')
  })

  it('extracts Go function and type names', () => {
    const diff = `
diff --git a/main.go b/main.go
+++ b/main.go
+func HandleRequest(w http.ResponseWriter, r *http.Request) {
+}
+
+type Server struct {
+    port int
+}
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('HandleRequest')
    expect(queries).toContain('Server')
  })

  it('ignores lines that are not additions', () => {
    const diff = `
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
-function oldFunction() {
-  return 'old'
-}
 // context line with function keyword
+function newFunction() {
+  return 'new'
+}
`
    const queries = extractQueriesFromDiff(diff)
    // Should only extract the added function
    expect(queries).toContain('newFunction')
    expect(queries).not.toContain('oldFunction')
  })

  it('filters out common noise keywords', () => {
    const diff = `
diff --git a/src/app.ts b/src/app.ts
+++ b/src/app.ts
+if (condition) {
+  for (const item of items) {
+    while (processing) {
+      return new Error()
+    }
+  }
+}
`
    const queries = extractQueriesFromDiff(diff)
    // None of these should be extracted as meaningful queries
    expect(queries).not.toContain('if')
    expect(queries).not.toContain('for')
    expect(queries).not.toContain('while')
    expect(queries).not.toContain('return')
    expect(queries).not.toContain('new')
  })

  it('includes a code snippet from significant additions', () => {
    const diff = `
diff --git a/src/handler.ts b/src/handler.ts
+++ b/src/handler.ts
+// This is a complex piece of business logic
+// that should be included as context
+const result = processItems(items)
+  .filter(item => item.valid)
+  .map(item => transformItem(item))
+  .reduce((acc, item) => {
+    acc.push(item)
+    return acc
+  }, [])
`
    const queries = extractQueriesFromDiff(diff)
    // Should have a query that contains the code snippet or function references
    expect(queries.length).toBeGreaterThan(0)
  })

  it('returns empty array for empty diff', () => {
    const emptyDiff = ''
    expect(extractQueriesFromDiff(emptyDiff)).toEqual([])
  })

  it('returns empty array for header-only diff', () => {
    const headerOnlyDiff = `
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
`
    expect(extractQueriesFromDiff(headerOnlyDiff)).toEqual([])
  })

  it('limits the number of queries returned', () => {
    // Create a diff with many additions
    const manyFunctions = Array.from({ length: 20 }, (_, i) => `+function func${i}() {}`).join('\n')
    const diff = `
diff --git a/src/many.ts b/src/many.ts
+++ b/src/many.ts
${manyFunctions}
`
    const queries = extractQueriesFromDiff(diff)
    // Should be limited to 10 queries max
    expect(queries.length).toBeLessThanOrEqual(10)
  })

  it('deduplicates identical queries', () => {
    const diff = `
diff --git a/src/app.ts b/src/app.ts
+++ b/src/app.ts
+function processData() {}
+
+// Later in the file
+function processData() {}
`
    const queries = extractQueriesFromDiff(diff)
    const processDataCount = queries.filter((q) => q === 'processData').length
    // Should only appear once due to deduplication
    expect(processDataCount).toBeLessThanOrEqual(1)
  })

  it('extracts Java method names with access modifiers', () => {
    const diff = `
diff --git a/src/UserService.java b/src/UserService.java
+++ b/src/UserService.java
+public void handleRequest(HttpRequest req) {
+}
+
+private String formatUser(User user) {
+  return user.toString();
+}
`
    const queries = extractQueriesFromDiff(diff)
    expect(queries).toContain('handleRequest')
    expect(queries).toContain('formatUser')
  })
})

describe('parseDiffToModifiedLines', () => {
  it('parses simple additions correctly', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,6 +10,8 @@ function existing() {
   return true
 }

+function newFunction() {
+  return 'added'
+}
`
    const result = parseDiffToModifiedLines(diff)

    expect(result.modifiedLines.length).toBeGreaterThan(0)
    expect(result.fileChanges.has('src/utils.ts')).toBe(true)

    const fileEntry = result.fileChanges.get('src/utils.ts')!
    expect(fileEntry.additions.length).toBeGreaterThan(0)
  })

  it('parses simple deletions correctly', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,8 +10,6 @@ function existing() {
   return true
 }

-function removedFunction() {
-  return 'deleted'
-}
`
    const result = parseDiffToModifiedLines(diff)

    expect(result.modifiedLines.length).toBeGreaterThan(0)
    const deletions = result.modifiedLines.filter(l => l.changeType === 'deletion')
    expect(deletions.length).toBeGreaterThan(0)
  })

  it('detects modifications (adjacent deletion and addition)', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -10,7 +10,7 @@ function existing() {
   return true
 }

-const oldValue = 'old'
+const newValue = 'new'
`
    const result = parseDiffToModifiedLines(diff)

    const modifications = result.modifiedLines.filter(l => l.changeType === 'modification')
    expect(modifications.length).toBeGreaterThan(0)

    const fileEntry = result.fileChanges.get('src/utils.ts')!
    expect(fileEntry.modifications.length).toBeGreaterThan(0)
  })

  it('handles multiple files in one diff', () => {
    const diff = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,4 @@
 const a = 1
+const b = 2
 export { a }
diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -5,6 +5,7 @@ import { a } from './file1'
 function process() {
   console.log(a)
+  console.log('new line')
 }
`
    const result = parseDiffToModifiedLines(diff)

    expect(result.fileChanges.has('src/file1.ts')).toBe(true)
    expect(result.fileChanges.has('src/file2.ts')).toBe(true)
  })

  it('tracks correct line numbers from hunk headers', () => {
    // Note: In unified diff format, context lines have a leading space
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -50,6 +50,7 @@ function existingAtLine50() {
   return true
 }

+function addedAtLine53() {}
`
    const result = parseDiffToModifiedLines(diff)

    const additions = result.modifiedLines.filter(l => l.changeType === 'addition')
    // The addition should be at line 53 (50 + 3 context lines)
    expect(additions.some(l => l.lineNumber === 53)).toBe(true)
  })

  it('handles empty diff', () => {
    const result = parseDiffToModifiedLines('')
    expect(result.modifiedLines).toEqual([])
    expect(result.fileChanges.size).toBe(0)
  })

  it('extracts line content without +/- prefix', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
+const added = 'value'
`
    const result = parseDiffToModifiedLines(diff)

    const additions = result.modifiedLines.filter(l => l.changeType === 'addition')
    expect(additions[0].content).toBe("const added = 'value'")
    expect(additions[0].content).not.toContain('+')
  })
})

describe('chunkOverlapsModifiedLines', () => {
  const createParsedDiff = (filename: string, lines: { additions?: number[]; deletions?: number[]; modifications?: number[] }): ParsedDiff => ({
    modifiedLines: [],
    fileChanges: new Map([[filename, {
      additions: lines.additions || [],
      deletions: lines.deletions || [],
      modifications: lines.modifications || []
    }]])
  })

  it('returns true when chunk contains modified lines', () => {
    const chunk: CodeChunk = {
      filename: 'src/utils.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    const parsedDiff = createParsedDiff('src/utils.ts', { additions: [15] })

    expect(chunkOverlapsModifiedLines(chunk, parsedDiff)).toBe(true)
  })

  it('returns false when chunk does not overlap', () => {
    const chunk: CodeChunk = {
      filename: 'src/utils.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    const parsedDiff = createParsedDiff('src/utils.ts', { additions: [25, 30] })

    expect(chunkOverlapsModifiedLines(chunk, parsedDiff)).toBe(false)
  })

  it('returns false when file is not in diff', () => {
    const chunk: CodeChunk = {
      filename: 'src/other.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    const parsedDiff = createParsedDiff('src/utils.ts', { additions: [15] })

    expect(chunkOverlapsModifiedLines(chunk, parsedDiff)).toBe(false)
  })

  it('handles edge case at chunk boundaries', () => {
    const chunk: CodeChunk = {
      filename: 'src/utils.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    // Line exactly at start boundary
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { additions: [10] }))).toBe(true)
    // Line exactly at end boundary
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { additions: [20] }))).toBe(true)
    // Line just outside boundaries
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { additions: [9] }))).toBe(false)
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { additions: [21] }))).toBe(false)
  })

  it('matches files with path suffix matching', () => {
    const chunk: CodeChunk = {
      filename: '/home/user/project/src/utils.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    // Diff might use relative paths
    const parsedDiff = createParsedDiff('src/utils.ts', { additions: [15] })

    expect(chunkOverlapsModifiedLines(chunk, parsedDiff)).toBe(true)
  })

  it('checks all change types (additions, deletions, modifications)', () => {
    const chunk: CodeChunk = {
      filename: 'src/utils.ts',
      code: 'function test() {}',
      score: 0.8,
      startLine: 10,
      endLine: 20
    }

    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { additions: [15] }))).toBe(true)
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { deletions: [15] }))).toBe(true)
    expect(chunkOverlapsModifiedLines(chunk, createParsedDiff('src/utils.ts', { modifications: [15] }))).toBe(true)
  })
})

describe('applyModifiedLineWeighting', () => {
  const createParsedDiff = (filename: string, additions: number[]): ParsedDiff => ({
    modifiedLines: [],
    fileChanges: new Map([[filename, { additions, deletions: [], modifications: [] }]])
  })

  it('applies 2x weight to chunks overlapping modified lines', () => {
    const chunks: CodeChunk[] = [
      { filename: 'src/utils.ts', code: 'overlapping', score: 0.5, startLine: 10, endLine: 20 }
    ]

    const parsedDiff = createParsedDiff('src/utils.ts', [15])
    const weighted = applyModifiedLineWeighting(chunks, parsedDiff)

    expect(weighted[0].originalScore).toBe(0.5)
    expect(weighted[0].score).toBe(1.0) // 0.5 * 2
    expect(weighted[0].weightMultiplier).toBe(2.0)
    expect(weighted[0].isModifiedContext).toBe(true)
  })

  it('does not weight chunks that do not overlap', () => {
    const chunks: CodeChunk[] = [
      { filename: 'src/utils.ts', code: 'not overlapping', score: 0.5, startLine: 100, endLine: 110 }
    ]

    const parsedDiff = createParsedDiff('src/utils.ts', [15])
    const weighted = applyModifiedLineWeighting(chunks, parsedDiff)

    expect(weighted[0].originalScore).toBe(0.5)
    expect(weighted[0].score).toBe(0.5) // unchanged
    expect(weighted[0].weightMultiplier).toBe(1.0)
    expect(weighted[0].isModifiedContext).toBe(false)
  })

  it('weighted sorting prioritizes modified chunks', () => {
    const chunks: CodeChunk[] = [
      { filename: 'src/utils.ts', code: 'not modified, high score', score: 0.9, startLine: 100, endLine: 110 },
      { filename: 'src/utils.ts', code: 'modified, lower score', score: 0.5, startLine: 10, endLine: 20 }
    ]

    const parsedDiff = createParsedDiff('src/utils.ts', [15])
    const weighted = applyModifiedLineWeighting(chunks, parsedDiff)

    // Sort by weighted score descending
    weighted.sort((a, b) => b.score - a.score)

    // The modified chunk (0.5 * 2 = 1.0) should rank higher than non-modified (0.9 * 1 = 0.9)
    expect(weighted[0].isModifiedContext).toBe(true)
    expect(weighted[0].originalScore).toBe(0.5)
    expect(weighted[0].score).toBe(1.0)
  })

  it('preserves original chunk properties', () => {
    const chunks: CodeChunk[] = [
      {
        filename: 'src/utils.ts',
        code: 'test code',
        score: 0.8,
        startLine: 10,
        endLine: 20,
        repoUrl: 'https://github.com/test/repo',
        branch: 'main'
      }
    ]

    const parsedDiff = createParsedDiff('src/utils.ts', [15])
    const weighted = applyModifiedLineWeighting(chunks, parsedDiff)

    expect(weighted[0].filename).toBe('src/utils.ts')
    expect(weighted[0].code).toBe('test code')
    expect(weighted[0].startLine).toBe(10)
    expect(weighted[0].endLine).toBe(20)
    expect(weighted[0].repoUrl).toBe('https://github.com/test/repo')
    expect(weighted[0].branch).toBe('main')
  })

  it('handles empty chunks array', () => {
    const parsedDiff = createParsedDiff('src/utils.ts', [15])
    const weighted = applyModifiedLineWeighting([], parsedDiff)
    expect(weighted).toEqual([])
  })

  it('handles empty parsed diff', () => {
    const chunks: CodeChunk[] = [
      { filename: 'src/utils.ts', code: 'code', score: 0.8, startLine: 10, endLine: 20 }
    ]

    const emptyDiff: ParsedDiff = { modifiedLines: [], fileChanges: new Map() }
    const weighted = applyModifiedLineWeighting(chunks, emptyDiff)

    expect(weighted[0].isModifiedContext).toBe(false)
    expect(weighted[0].weightMultiplier).toBe(1.0)
  })
})
