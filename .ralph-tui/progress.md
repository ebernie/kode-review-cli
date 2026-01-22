# Ralph Progress Log

This file tracks progress across iterations. It's automatically updated
after each iteration and included in agent prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---

## ✓ Iteration 1 - US-013: Create API endpoint for definition lookup
*2026-01-22T00:57:45.607Z (171s)*

**Status:** Completed

**Notes:**
plemented in `main.py:390-520` |\n| Query Postgres for chunks in symbol_names | ✅ Uses `symbol_names @> ARRAY[%s]::text[]` with GIN index |\n| Return file path, line number, chunk content | ✅ Returns `DefinitionLocation` with all fields |\n| Handle re-exports via import chains | ✅ Joins relationships table for 'imports'/'references' types |\n| bun run typecheck passes | ✅ |\n| bun run lint passes | ✅ |\n\nThe feature was already committed as `3eb1264`, and I added test coverage in `7e4709a`.\n\n

---
## ✓ Iteration 2 - US-014: Create API endpoint for usage lookup
*2026-01-22T01:01:17.676Z (211s)*

**Status:** Completed

**Notes:**
- Special character encoding\n   - Empty results\n   - Error handling\n   - Default limit behavior\n\n### Acceptance Criteria Met\n- ✅ Add GET /usages/{symbol} endpoint to indexer API\n- ✅ Query relationships table for 'calls' and 'imports' relationship types (also includes 'references')\n- ✅ Return list of files and line numbers where symbol is used\n- ✅ Handle dynamic imports and lazy loading (flag as uncertain via `is_dynamic`)\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
## ✓ Iteration 3 - US-015: Build import chain tracking
*2026-01-22T01:07:11.443Z (353s)*

**Status:** Completed

**Notes:**
dencies()`, `getHubFiles()`\n\n### Integration\n- Import graph is automatically built after indexing completes\n- Statistics (edges, cycles, hubs) are included in indexer output\n\nAll acceptance criteria have been met:\n- ✅ Build import graph during indexing (stored in `file_imports` table)\n- ✅ Compute 2-level import tree for modified files\n- ✅ Detect and highlight circular dependencies\n- ✅ Flag 'hub' files with import count > 10\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
## ✓ Iteration 4 - US-016: Build call graph for TypeScript/JavaScript
*2026-01-22T01:13:21.552Z (369s)*

**Status:** Completed

**Notes:**
s (`this.method()`, `obj.method()`)\n   - Tests for chained calls\n   - Tests for edge cases and error handling\n\n### Acceptance Criteria Met:\n- ✅ Uses tree-sitter to parse function calls from AST\n- ✅ Builds graph: function -> [called functions]\n- ✅ Stores in relationships table with `relationship_type='calls'`\n- ✅ Handles method calls on classes\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n### Commit:\n```\nfeat: US-016 - Build call graph for TypeScript/JavaScript\n```\n\n

---
## ✓ Iteration 5 - US-017: Extend call graph to Python
*2026-01-22T01:20:11.132Z (409s)*

**Status:** Completed

**Notes:**
nd MRO handling\n  - `TestPythonFunctionDefinitions` - function/method extraction\n  - `TestPythonAsyncCalls` - async/await patterns\n  - `TestPythonDecoratorPatterns` - decorated functions\n  - `TestPythonModuleCalls` - module-level calls\n  - `TestPythonLineNumbers` - line number accuracy\n  - `TestPythonEdgeCases` - lambdas, comprehensions, dynamic dispatch\n\n### Verification\n- `bun run typecheck` passes\n- `bun run lint` passes\n- Python syntax validation passes for both modified files\n\n

---
## ✓ Iteration 6 - US-018: Extend call graph to Go, Java, Rust
*2026-01-22T01:27:27.381Z (435s)*

**Status:** Completed

**Notes:**
ait method calls are supported\n- ✅ **Store in same relationships table format** - Uses existing `relationship_type='calls'` with metadata containing callee_name, line_number, and receiver\n- ✅ **bun run typecheck passes** - Verified\n- ✅ **bun run lint passes** - Verified\n\n### Key Files Modified:\n1. **src/indexer/docker/call_graph.py** - Added ~1000 lines of new language support\n2. **src/indexer/docker/test_call_graph.py** - Added ~300 lines of comprehensive tests for Go, Java, and Rust\n\n

---
## ✓ Iteration 7 - US-019: Create call graph query API endpoint
*2026-01-22T01:31:19.053Z (231s)*

**Status:** Completed

**Notes:**
vior**:\n  1. Finds chunks where the function is defined (root nodes at depth 0)\n  2. Uses BFS to traverse callers (chunks that call the function)\n  3. Uses BFS to traverse callees (functions called by the function)\n  4. Deduplicates nodes and edges across depth levels\n  5. Returns graph structure suitable for visualization\n\n### Quality Checks\n- ✅ `bun run typecheck` - passes\n- ✅ `bun run lint` - passes\n- ✅ `bun test src/indexer` - 154 tests pass\n- ✅ Python syntax validation passes\n\n

---
## ✓ Iteration 8 - US-020: Implement keyword search with BM25
*2026-01-22T01:35:57.079Z (277s)*

**Status:** Completed

**Notes:**
ile BM25 excels at exact matches (\"find the function named `authenticateUser`\"). Together they cover both use cases that LLM-powered code review needs.\n`─────────────────────────────────────────────────`\n\nAll acceptance criteria met:\n- ✅ BM25 scoring implemented via PostgreSQL ts_rank_cd\n- ✅ Full-text search index added (GIN on tsvector)  \n- ✅ Exact function name matches boosted 3x\n- ✅ camelCase/snake_case variations handled\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
## ✓ Iteration 9 - US-021: Implement hybrid search combining vector and keyword
*2026-01-22T01:41:47.165Z (349s)*

**Status:** Completed

**Notes:**
`HybridSearchOptions` types\n5. **`src/indexer/__tests__/hybrid-search.test.ts`** (new) - 9 comprehensive tests for the client\n\n### API Usage\n\n```typescript\n// Basic usage\nconst results = await client.hybridSearch('getUserById', repoUrl)\n\n// With quoted phrase for exact matching\nconst results = await client.hybridSearch('\"getUserById\" auth', repoUrl)\n\n// Custom weights (70% vector, 30% keyword)\nconst results = await client.hybridSearch(query, repoUrl, branch, 10, 0.7, 0.3)\n```\n\n

---
## ✓ Iteration 10 - US-022: Implement structured XML context format
*2026-01-22T01:46:17.000Z (269s)*

**Status:** Completed

**Notes:**
re=\"0.756\">\ndescribe('parseConfig', () =&gt; {\n  // ... test content ...\n})\n</context>\n</test>\n```\n\nAll acceptance criteria have been met:\n- ✅ Code sections wrapped in `<context type='...' path='...' relevance='...'>` tags\n- ✅ Metadata includes file path, line numbers, retrieval reason\n- ✅ Separate sections: `<modified>`, `<similar>`, `<definition>`, `<test>`, `<config>`\n- ✅ LLM prompt updated to reference XML structure\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
## ✓ Iteration 11 - US-023: Implement multi-stage retrieval pipeline
*2026-01-22T02:05:56.095Z (469s)*

**Status:** Completed

**Notes:**
stage adds results the previous stages might miss.\n\n3. **Early Termination**: When top results exceed a confidence threshold (0.9), later expensive stages can be skipped. This significantly reduces latency for obvious matches while still providing deep context when needed.\n\n4. **Multi-Source Boosting**: Results found by multiple retrieval methods receive a 15% score boost per additional source, making consensus results more prominent.\n`─────────────────────────────────────────────────`\n\n

---
## ✓ Iteration 12 - US-024: Implement result diversification
*2026-01-22T02:13:49.472Z (472s)*

**Status:** Completed

**Notes:**
logPipelineMetrics` for diversification logging\n\n2. **`src/indexer/index.ts`** - Exported diversification module\n\n### Acceptance Criteria Status\n- ✅ Limit results per file to 3 chunks max\n- ✅ Ensure representation from: modified files, test files, type definitions, similar code\n- ✅ Implement MMR (Maximal Marginal Relevance) to reduce redundancy\n- ✅ Configurable diversity factor (0 = pure relevance, 1 = max diversity, default 0.3)\n- ✅ bun run typecheck passes\n- ✅ bun run lint passes\n\n

---
## ✓ Iteration 13 - US-025: Implement embedding cache with content hash
*2026-01-22T02:18:56.460Z (306s)*

**Status:** Completed

**Notes:**
- `CachedSentenceTransformerEmbed` function spec and executor\n   - `text_to_embedding_cached()` transform flow\n   - `get_cache_table_stats()` for inspecting cache contents\n   - `--cache-stats` CLI option\n\n### Acceptance Criteria Met:\n- ✅ Cache embeddings with content hash (SHA-256) as key\n- ✅ Store cache in Postgres\n- ✅ Skip embedding generation if content hash matches cached entry\n- ✅ Cache hit rate logged for monitoring\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
## ✓ Iteration 14 - US-026: Implement incremental indexing on git diff
*2026-01-22T02:24:32.471Z (335s)*

**Status:** Completed

**Notes:**
pattern as full indexing, ensuring consistent environment\n2. **Dual detection methods**: Git diff for automatic detection, `CHANGED_FILES` env var for CI/CD pipelines where file lists are known\n3. **Cascade deletion**: Chunks are deleted first, triggering foreign key cascades to automatically clean up relationships\n4. **Cache preservation**: Embedding cache remains intact - unchanged code snippets in modified files still get cache hits\n`─────────────────────────────────────────────────`\n\n

---
## ✓ Iteration 15 - US-027: Add background re-indexing for large repos
*2026-01-22T02:31:43.170Z (430s)*

**Status:** Completed

**Notes:**
dex-queue`, `--index-queue-clear`\n- **`src/index.ts`** - Integrated auto-triggering in review flow + CLI handlers\n- **`src/indexer/index.ts`** - Exported new types and functions\n\n### Acceptance Criteria Met\n- ✅ Trigger background re-index when > 100 files changed\n- ✅ Show progress indicator during background indexing  \n- ✅ Reviews can proceed with stale index while background updates\n- ✅ Notify when background index completes\n- ✅ `bun run typecheck` passes\n- ✅ `bun run lint` passes\n\n

---
