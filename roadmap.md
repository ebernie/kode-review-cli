# Kode-Review CLI Roadmap

This document outlines planned improvements to transform kode-review from a personal CLI tool into a complete team-ready code review product.

---

## Phase 1: Foundation (Quick Wins) ✅ COMPLETE

**Goal:** Improve daily usability and reliability without major architectural changes.

### CLI/UX Improvements

- [x] **Config inspection command** - Add `--show-config` to display current configuration without editing files
- [x] **Diagnostics command** - Add `--doctor` to check setup (OpenCode installed, VCS configured, indexer running)
- [ ] **Help text examples** - Add usage examples to `--help` for major flags
- [ ] **Shell completion** - Support `eval "$(kode-review --completion bash/zsh/fish)"`

### Performance

- [x] **Query result caching** - LRU cache for semantic search results (30-40% faster PR iterations)
- [ ] **Batch search queries** - Combine 35+ individual API calls into batched requests (20-30% latency reduction)
- [ ] **Diff parsing cache** - Memoize parsed diffs for repeated reviews on same PR

### Reliability

- [x] **Retry logic** - Exponential backoff for network failures with transient/permanent error classification
- [x] **HTTP timeouts** - Add timeouts to all HTTP operations (search calls, GitHub/GitLab CLI)
- [x] **Main entry error handling** - Wrap `src/index.ts` with try-catch for user-friendly error messages

---

## Phase 2: Team Adoption (Partial)

**Goal:** Enable team workflows with VCS integration and CI/CD support.

### VCS Integration

- [x] **PR/MR comment posting** - Add `--post-to-pr` flag to post review results as PR/MR comments
- [x] **Inline code comments** - Post comments on specific lines where issues are found
- [x] **PR status updates** - Set approval/request-changes status based on review verdict
- [ ] **Bitbucket support** - Add Bitbucket CLI integration following existing GitHub/GitLab patterns

### CI/CD Integration

- [ ] **GitHub Actions** - Create marketplace action for automatic PR reviews
  ```yaml
  - uses: kofikode/kode-review@v1
    with:
      scope: pr
      post-comment: true
  ```
- [ ] **GitLab CI template** - Provide `.gitlab-ci.yml` template with MR integration
- [x] **Pre-commit hook generator** - Add `--init-hooks` to set up git hooks

### Output Formats

- [x] **JSON output** - `--format json` for machine-readable structured reviews
- [ ] **SARIF format** - `--format sarif` for GitHub security tab integration
- [x] **Markdown reports** - `--format markdown` with file output support
- [ ] **HTML reports** - `--format html` for dashboards and archives
- [x] **File output** - `--output-file <path>` to save results

### Notifications

- [ ] **Slack integration** - Webhook notifications on review completion
- [ ] **Microsoft Teams** - Teams webhook support
- [ ] **Email notifications** - SMTP support for review alerts

---

## Phase 3: Simplified Setup

**Goal:** Lower the barrier to entry with alternative backends and better onboarding.

### SQLite Indexer Backend

- [ ] **SQLite with vector extension** - Single-file database alternative to Docker + PostgreSQL
  - No Docker required
  - ~200MB overhead for 100K chunks
  - Instant setup: `kode-review --setup-indexer --backend sqlite`
- [ ] **Auto-select backend** - Use SQLite by default, Docker for advanced features
- [ ] **Migration path** - Allow upgrading from SQLite to PostgreSQL

### Onboarding Improvements

- [ ] **Progress indicators** - Stream Docker output during indexing (no 10-min silence)
- [ ] **Resource documentation** - Document minimum requirements (RAM, disk, CPU)
- [ ] **State recovery** - Resume interrupted onboarding instead of restarting
- [ ] **Verification step** - Test provider connectivity after setup
- [ ] **Quick-start templates** - Pre-configured settings for common project types

### Configuration

- [ ] **Project-level config** - `.kode-review.yml` in repository root
- [ ] **Config hierarchy** - Project config overrides user config
- [ ] **Team config sharing** - Shareable rule sets and policies

---

## Phase 4: Architecture Refactoring

**Goal:** Enable extensibility and third-party integrations.

### Provider Abstraction

- [ ] **IProvider interface** - Abstract AI provider interactions
  ```typescript
  interface IProvider {
    health(): Promise<boolean>
    createSession(): Promise<string>
    sendPrompt(sessionId: string, prompt: string): Promise<ReviewResult>
  }
  ```
- [ ] **Provider registry** - Dynamic provider discovery and registration
- [ ] **Alternative backends** - Support Ollama, OpenRouter, local LLMs

### Output Formatter Interface

- [ ] **OutputFormatter abstraction** - Pluggable output formatting
  ```typescript
  interface OutputFormatter {
    format(review: StructuredReview): string
    getExtension(): string
  }
  ```
- [ ] **Review result parser** - Extract structured data from AI responses
- [ ] **Custom formatters** - User-defined output templates

### VCS Adapter Pattern

- [ ] **VcsAdapter interface** - Unified VCS operations
- [ ] **Adapter registry** - Drop-in support for new platforms
- [ ] **Azure DevOps adapter** - Enterprise VCS support

### CLI Restructuring

- [ ] **Subcommand structure** - Organize by feature area
  ```bash
  kode-review review --scope local
  kode-review config show
  kode-review indexer status
  kode-review setup provider
  ```

---

## Phase 5: Enterprise Features

**Goal:** Support enterprise workflows and compliance requirements.

### IDE Integration

- [ ] **VSCode extension** - Inline reviews while editing
- [ ] **LSP server** - Language Server Protocol for generic editor support
- [ ] **JetBrains plugin** - IntelliJ/WebStorm integration

### Dashboard & Analytics

- [ ] **Web dashboard** - Review history and metrics visualization
- [ ] **Trend analysis** - Track issues found over time
- [ ] **Team statistics** - Aggregate metrics per developer/repository
- [ ] **Export analytics** - CSV/JSON export of historical data

### Review History

- [ ] **Database backend** - SQLite/PostgreSQL for review persistence
- [ ] **Query interface** - Search past reviews by date, severity, file
- [ ] **Audit trail** - Track all reviews for compliance
- [ ] **Deduplication** - Avoid re-reviewing unchanged code

### Enforcement

- [ ] **Branch protection** - Block merges with critical issues
- [ ] **Required reviewers** - Auto-assign based on changed files
- [ ] **Policy rules** - Configurable thresholds per severity level
- [ ] **Approval workflows** - Multi-stage review processes

### API Server Mode

- [ ] **REST API** - HTTP server for programmatic access
  ```
  POST /api/reviews - Submit review request
  GET /api/reviews/{id} - Get review results
  GET /api/health - Server health check
  ```
- [ ] **Webhook triggers** - Accept GitHub/GitLab webhooks for event-driven reviews
- [ ] **Rate limiting** - Protect against abuse
- [ ] **Authentication** - API key and OAuth support

---

## Test Coverage Goals

Current coverage: ~19% of modules tested

### Priority Test Targets

| Module | Current | Target | Priority |
|--------|---------|--------|----------|
| `src/index.ts` | 0% | 80% | P1 |
| `src/review/engine.ts` | 0% | 90% | P1 |
| `src/watch/watcher.ts` | 0% | 85% | P1 |
| `src/vcs/github.ts` | 0% | 90% | P1 |
| `src/vcs/gitlab.ts` | 0% | 90% | P1 |
| `src/indexer/docker.ts` | 0% | 75% | P2 |
| `src/onboarding/*` | 0% | 70% | P2 |
| `src/config/*` | 0% | 80% | P2 |

### CI/CD Pipeline

- [ ] **GitHub Actions workflow** - Run tests on every PR
- [ ] **Code coverage reporting** - Codecov or similar integration
- [ ] **Pre-commit hooks** - Lint and type-check before commit
- [ ] **Cross-platform testing** - Linux, macOS, Windows

---

## Performance Targets

| Operation | Current | Target | Improvement |
|-----------|---------|--------|-------------|
| Full repo index (500 files) | 3-5 min | 1-2 min | 50% |
| Incremental index (10 files) | 2-5 sec | 1-2 sec | 50% |
| Semantic search (single) | 100-200ms | 50-100ms | 50% |
| Multi-stage pipeline | 1.5-2s | <1s | 40% |
| Test file discovery | 5-10 sec | 1-2 sec | 70% |
| Full review + context | 15-25 sec | 8-12 sec | 40% |

---

## Timeline Estimates

| Phase | Scope | Estimated Effort |
|-------|-------|------------------|
| Phase 1 | Quick Wins | 1-2 weeks |
| Phase 2 | Team Adoption | 3-4 weeks |
| Phase 3 | Simplified Setup | 2-3 weeks |
| Phase 4 | Architecture | 4-6 weeks |
| Phase 5 | Enterprise | 8-12 weeks |

---

## Contributing

Contributions welcome! When picking up items from this roadmap:

1. Comment on the related issue (or create one) to avoid duplicate work
2. Follow existing patterns in the codebase
3. Add tests for new functionality
4. Update documentation as needed

## Feedback

Have suggestions for the roadmap? Open an issue or discussion on GitHub.
