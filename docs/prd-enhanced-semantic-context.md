# Product Requirements Document: Enhanced Semantic Context for Code Review

## Overview

### Product Name
Kode Review Enhanced Semantic Context System

### Problem Statement
The current code review system uses pure vector similarity search to find relevant context for LLM-based reviews. While effective for finding "similar-looking" code, this approach has fundamental limitations:

1. **Misses structural relationships** — Cannot find callers of modified functions, type implementers, or test files
2. **No definition resolution** — When a function signature changes, can't locate all usage sites
3. **Lacks project awareness** — Ignores config files, project structure, and coding conventions
4. **Query extraction is naive** — Only extracts identifiers from diffs, missing broader semantic intent

### Solution
Implement a comprehensive semantic context enhancement system leveraging CocoIndex's multi-language tree-sitter integration to build structural relationships alongside vector embeddings, stored in Postgres for unified querying.

### Target Users
- Developers using `kode-review` CLI for PR/MR reviews
- CI/CD pipelines running automated code reviews
- Teams enforcing code quality and consistency standards

---

## User Stories

### Epic: Enhanced Semantic Context Retrieval

#### US-1: Include Modified Lines as High-Priority Context
**As a** reviewer, **I want** the actual modified lines weighted higher in context retrieval **so that** the LLM sees the exact changes being reviewed.

**Acceptance Criteria:**
- Modified lines from diff are embedded and ranked with 2x weight multiplier
- Context window prioritizes showing modified code before similar code
- Works for additions, deletions, and modifications

---

#### US-2: Automatic Test File Retrieval
**As a** reviewer, **I want** related test files automatically included in context **so that** the LLM can verify test coverage and suggest missing tests.

**Acceptance Criteria:**
- For `src/foo/bar.ts`, automatically find `test/foo/bar.test.ts`, `src/foo/__tests__/bar.spec.ts`, etc.
- Support common test naming conventions: `.test.`, `.spec.`, `_test.`, `test_`
- Support test directory patterns: `__tests__/`, `tests/`, `test/`, `spec/`
- Include test files in context with "TEST_FILE" metadata tag

---

#### US-3: Expanded Query Extraction from Diffs
**As a** reviewer, **I want** richer query extraction from diffs **so that** semantic search finds more relevant context.

**Acceptance Criteria:**
- Extract function/class names from modified lines
- Extract imported module names
- Extract type annotations and interface names
- Extract string literals that look like identifiers (e.g., event names, config keys)
- Generate multiple semantic queries per diff hunk

---

#### US-4: PR/MR Description Integration
**As a** reviewer, **I want** the PR description included in semantic queries **so that** context retrieval understands the intent behind changes.

**Acceptance Criteria:**
- Fetch PR/MR description via GitHub/GitLab CLI
- Extract key terms and intent from description
- Use description to bias context retrieval toward relevant subsystems
- Include description summary in LLM prompt header

---

#### US-5: Project Structure Context
**As a** reviewer, **I want** project structure included in context **so that** the LLM understands where files fit in the architecture.

**Acceptance Criteria:**
- Generate condensed directory tree (max 50 lines)
- Highlight path from root to modified files
- Include README.md summary if present
- Include ARCHITECTURE.md or similar if present

---

#### US-6: Config File Awareness
**As a** reviewer, **I want** relevant config files included in context **so that** the LLM understands project conventions.

**Acceptance Criteria:**
- Auto-include: `tsconfig.json`, `eslint.config.*`, `.prettierrc`, `package.json` (partial)
- Include language-specific configs: `pyproject.toml`, `go.mod`, `Cargo.toml`
- Extract and summarize key settings (strict mode, lint rules, dependencies)

---

#### US-7: File-Type Specific Retrieval Strategies
**As a** reviewer, **I want** context retrieval optimized per file type **so that** reviews are more accurate.

**Acceptance Criteria:**
- TypeScript/JavaScript: Prioritize type definitions, imported modules
- Python: Include `__init__.py`, base classes, decorators
- Go: Include interface definitions, package documentation
- CSS/SCSS: Include variable definitions, mixins
- Configurable strategy per file extension

---

#### US-8: Hybrid Search (Vector + Keyword)
**As a** reviewer, **I want** combined vector and keyword search **so that** exact identifier matches are found alongside semantic matches.

**Detailed Acceptance Criteria:**
- Implement BM25 or similar keyword scoring alongside vector similarity
- Configurable weighting: default 60% vector, 40% keyword
- Exact function name matches boost score by 3x
- Support quoted phrases for exact matching in queries
- Combine scores using reciprocal rank fusion (RRF)

**Edge Cases:**
- Handle camelCase/snake_case variations
- Handle abbreviated identifiers (e.g., `cfg` vs `config`)
- Fallback to pure vector if keyword search returns nothing

---

#### US-9: Structured Context Format (XML)
**As a** reviewer, **I want** context delivered to the LLM in structured XML **so that** it can better parse and reference code sections.

**Acceptance Criteria:**
- Wrap code sections in `<context type="..." path="..." relevance="...">` tags
- Include metadata: file path, line numbers, retrieval reason
- Separate sections: `<modified>`, `<similar>`, `<definitions>`, `<tests>`, `<config>`
- LLM prompt updated to reference XML structure

---

#### US-10: Definition and Usage Lookup
**As a** reviewer, **I want** automatic lookup of definitions and usages **so that** breaking changes are caught.

**Detailed Acceptance Criteria:**
- When function signature changes, find all call sites
- When type/interface changes, find all implementers
- When export changes, find all importers
- Store symbol table in Postgres with: name, kind, file, line, scope
- Query: "find all usages of symbol X in scope Y"

**Edge Cases:**
- Handle re-exports and barrel files
- Handle dynamic imports and lazy loading
- Handle monkey-patching in Python/JS

---

#### US-11: Import Chain Tracking
**As a** reviewer, **I want** import dependency chains included **so that** I understand how changes propagate.

**Acceptance Criteria:**
- Build import graph during indexing
- For modified file, show 2-level import tree (what imports it, what it imports)
- Highlight circular dependencies
- Flag "hub" files with high import count

---

#### US-12: Enhanced Metadata Storage in Postgres
**As a** reviewer, **I want** rich metadata stored alongside embeddings **so that** queries can filter and rank by structure.

**Detailed Acceptance Criteria:**
- Store per chunk: file_path, language, chunk_type (function/class/module), symbol_names[], line_start, line_end, imports[], exports[]
- Store per file: last_modified, size, language, complexity_score
- Store relationships: calls, imports, implements, extends
- Index on symbol_names for fast lookup

**Schema Design:**
```sql
CREATE TABLE chunks (
  id UUID PRIMARY KEY,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  language TEXT,
  chunk_type TEXT,
  symbol_names TEXT[],
  line_start INT,
  line_end INT,
  imports TEXT[],
  exports TEXT[],
  created_at TIMESTAMP
);

CREATE TABLE relationships (
  source_chunk_id UUID REFERENCES chunks(id),
  target_chunk_id UUID REFERENCES chunks(id),
  relationship_type TEXT, -- 'calls', 'imports', 'implements', 'extends'
  PRIMARY KEY (source_chunk_id, target_chunk_id, relationship_type)
);
```

---

#### US-13: Function-Boundary Chunking
**As a** reviewer, **I want** code chunked at function/class boundaries **so that** context is semantically coherent.

**Acceptance Criteria:**
- Use tree-sitter AST to identify function/class boundaries
- Never split a function across chunks
- Include docstrings/comments with their associated code
- Handle nested functions (include in parent or separate based on size)
- Fallback to line-based chunking for non-parseable files

---

#### US-14: Multi-Stage Retrieval Pipeline
**As a** reviewer, **I want** a multi-stage retrieval process **so that** context is progressively refined.

**Detailed Acceptance Criteria:**
- Stage 1: Fast keyword search for exact matches (100ms budget)
- Stage 2: Vector similarity on diff content (500ms budget)
- Stage 3: Structural lookup (definitions, callers) (500ms budget)
- Stage 4: Re-rank combined results by relevance (100ms budget)
- Configurable stage weights and budgets
- Early termination if high-confidence matches found

**Test Scenarios:**
- Diff modifies function signature → Stage 3 finds all callers
- Diff adds new feature → Stage 2 finds similar implementations
- Diff fixes typo → Stage 1 sufficient, skip expensive stages

---

#### US-15: Result Diversification
**As a** reviewer, **I want** diverse context results **so that** I see different aspects of the codebase.

**Acceptance Criteria:**
- Limit results per file to 3 chunks max
- Ensure representation from: modified files, test files, type definitions, similar code
- MMR (Maximal Marginal Relevance) to reduce redundancy
- Configurable diversity factor (0 = pure relevance, 1 = max diversity)

---

#### US-16: Caching and Incremental Updates
**As a** reviewer, **I want** fast incremental updates **so that** indexing doesn't slow down reviews.

**Acceptance Criteria:**
- Cache embeddings with content hash as key
- Only re-index changed files on git diff
- Invalidate relationship cache when imports change
- Background re-indexing for large repos
- Cache hit rate > 90% for typical PR reviews

---

#### US-17: Call Graph Construction
**As a** reviewer, **I want** a full call graph built during indexing **so that** impact analysis is accurate.

**Detailed Acceptance Criteria:**
- Use CocoIndex tree-sitter integration for multi-language support
- Build graph: function → [called functions]
- Support languages: TypeScript, JavaScript, Python, Go, Java, Rust
- Store in Postgres relationships table
- Query: "what functions are reachable from X within N hops"
- Update incrementally on file changes

**Edge Cases:**
- Handle dynamic dispatch (method calls on interfaces)
- Handle higher-order functions (callbacks, promises)
- Handle reflection/metaprogramming (best effort, flag as uncertain)
- Handle cross-language calls (e.g., JS calling Rust via WASM)

**Test Scenarios:**
- Modify utility function → Find all transitive callers
- Add new method to class → Verify no existing callers
- Change interface → Find all implementations

---

## Technical Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        kode-review CLI                          │
├─────────────────────────────────────────────────────────────────┤
│  src/indexer/context.ts     │  src/review/prompt.ts             │
│  - Query generation         │  - XML context formatting         │
│  - Multi-stage retrieval    │  - PR description integration     │
│  - Result diversification   │  - Project structure inclusion    │
└──────────────┬──────────────┴──────────────┬────────────────────┘
               │                             │
               ▼                             │
┌─────────────────────────────────────────────────────────────────┐
│                    Indexer API (FastAPI)                        │
│  - /query (hybrid search)                                       │
│  - /definitions/{symbol}                                        │
│  - /usages/{symbol}                                             │
│  - /callgraph/{function}                                        │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CocoIndex Pipeline                          │
│  - Tree-sitter parsing (28 lang)                                │
│  - Function-boundary chunking                                   │
│  - Symbol extraction                                            │
│  - Embedding generation                                         │
│  - Relationship extraction                                      │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Postgres                                │
│  - chunks (embeddings + meta)                                   │
│  - relationships (call graph)                                   │
│  - files (file-level metadata)                                  │
│  - pgvector for similarity                                      │
└─────────────────────────────────────────────────────────────────┘
```

### CocoIndex Flow Definition (Conceptual)

```python
@cocoindex.flow_def()
def code_indexing_flow():
    # Source: Git repository files
    files = cocoindex.sources.LocalFiles(path=".", extensions=[...])

    # Transform: Detect language
    files = files.transform(detect_language)

    # Transform: Tree-sitter parsing for symbol extraction
    parsed = files.transform(extract_symbols)  # Returns symbols, relationships

    # Transform: Function-boundary chunking
    chunks = parsed.transform(split_by_function_boundary)

    # Transform: Generate embeddings
    embedded = chunks.transform(generate_embeddings)

    # Export: Chunks with embeddings to Postgres
    embedded.export(
        cocoindex.exports.Postgres(
            table="chunks",
            primary_key=["file_path", "line_start"],
        )
    )

    # Export: Relationships to Postgres
    parsed.relationships.export(
        cocoindex.exports.Postgres(
            table="relationships",
            primary_key=["source_chunk_id", "target_chunk_id", "relationship_type"],
        )
    )
```

### New API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/query` | POST | Hybrid search (vector + keyword + structural) |
| `/definitions/{symbol}` | GET | Find definition location for symbol |
| `/usages/{symbol}` | GET | Find all usages of symbol |
| `/callgraph/{function}` | GET | Get call graph (callers/callees) |
| `/imports/{file}` | GET | Get import/export graph for file |
| `/structure` | GET | Get project structure summary |

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Context relevance score (human eval) | ~60% | >85% |
| False positive rate (hallucinated issues) | ~20% | <5% |
| Breaking change detection rate | ~40% | >90% |
| Average context retrieval time | 2s | <1.5s |
| Index update time (incremental) | N/A | <5s for typical PR |

---

## Dependencies

### External
- **CocoIndex** — Tree-sitter integration, flow orchestration, Postgres export
- **Postgres + pgvector** — Embedding storage and similarity search
- **Tree-sitter grammars** — Language parsers (bundled with CocoIndex)

### Internal
- `src/indexer/` — Existing indexer infrastructure
- `src/vcs/` — GitHub/GitLab CLI integration for PR descriptions
- `src/review/prompt.ts` — Prompt construction

---

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Tree-sitter parsing failures for edge cases | Medium | Medium | Fallback to line-based chunking, log failures for improvement |
| Postgres performance at scale | High | Low | Index optimization, query analysis, connection pooling |
| Call graph accuracy for dynamic languages | Medium | High | Flag uncertain relationships, combine with heuristics |
| CocoIndex learning curve | Medium | Medium | Leverage existing documentation, start with simple flows |

---

## Out of Scope

The following items from `suggestions1.md` "Other Low-Hanging Improvements" are explicitly excluded from this PRD:
- Diff size awareness (review depth adjustment)
- File type prioritization (review order)
- Pre-review static checks (tsc, eslint)
- Test summary (pass/fail status)
- Incremental review mode (commit-by-commit)
- Review templates by change type

These may be addressed in a future PRD focused on review orchestration.

---

## Release Plan

### Single Milestone Release

All 17 user stories will be delivered in a single release with the following implementation order:

**Phase 1: Foundation** (US-12, US-13, US-6)
- Set up Postgres schema with pgvector
- Implement function-boundary chunking via CocoIndex
- Add config file detection

**Phase 2: Basic Enhancements** (US-1, US-2, US-3, US-4, US-5, US-7)
- Modified lines weighting
- Test file retrieval
- Expanded query extraction
- PR description integration
- Project structure context
- File-type strategies

**Phase 3: Structural Analysis** (US-10, US-11, US-17)
- Definition/usage lookup
- Import chain tracking
- Call graph construction

**Phase 4: Advanced Retrieval** (US-8, US-9, US-14, US-15, US-16)
- Hybrid search implementation
- Structured XML context format
- Multi-stage retrieval pipeline
- Result diversification
- Caching and incremental updates

---

## Appendix

### Supported Languages (via CocoIndex Tree-sitter)

TypeScript, JavaScript, Python, Go, Java, Rust, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Haskell, Elixir, Erlang, Lua, R, Julia, Bash, SQL, HTML, CSS, JSON, YAML, TOML, Markdown

### Reference Documents
- `docs/suggestions1.md` — Original enhancement analysis
