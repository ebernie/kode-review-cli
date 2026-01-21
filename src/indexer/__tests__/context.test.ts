import { describe, it, expect } from 'vitest'
import { extractQueriesFromDiff } from '../context.js'

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
