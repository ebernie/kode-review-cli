# Changelog

## [0.4.0](https://github.com/ebernie/kode-review-cli/compare/v0.3.0...v0.4.0) (2026-03-05)

### Features

* improve test coverage and add graceful provider failure handling ([40637e5](https://github.com/ebernie/kode-review-cli/commit/40637e5fb2e2f798cb79bef087e6f0ef7c288326))

### Bug Fixes

* regenerate changelog with correct version boundaries ([5bdee32](https://github.com/ebernie/kode-review-cli/commit/5bdee32ba2b476f1f437a57cea01175c72db5a34))
* revert manual version bump, use release-it workflow instead ([e8329ff](https://github.com/ebernie/kode-review-cli/commit/e8329ff0972105e68a9c5259634a32d34fe0a55e))
* use local origin remote for update checks instead of hardcoded URL ([07afbd0](https://github.com/ebernie/kode-review-cli/commit/07afbd081857e7c6a48bbf8f1c5975dcd00022a3))

## [0.3.0](https://github.com/kofikode/kode-review-cli/compare/v0.2.0...v0.3.0) (2026-03-04)

### Features

* add --update flag for CLI self-update with daily version check ([eedc42f](https://github.com/kofikode/kode-review-cli/commit/eedc42f635dfaf47c9c70d8edfd67e43a4cb0414))

## [0.2.0](https://github.com/kofikode/kode-review-cli/compare/v0.1.0...v0.2.0) (2026-03-04)

### Features

* add automated version bumping and changelog with release-it ([c5d8e7e](https://github.com/kofikode/kode-review-cli/commit/c5d8e7e1826c8d49e3999b1f779370a39fe828f5))
* replace hard-coded ANTIGRAVITY_MODELS with live plugin model fetching ([fb9849e](https://github.com/kofikode/kode-review-cli/commit/fb9849e0b08a236904300a279690a4eb49c2f78d))

## [0.1.0](https://github.com/kofikode/kode-review-cli/compare/1dc01bfdd910c8102664fc808bc74a2b60e67ca1...v0.1.0) (2026-03-04)

### Features

* Add agentic review mode with MCP tool access ([a1936ee](https://github.com/kofikode/kode-review-cli/commit/a1936eeebb3620a141744f3a7b8ae978efef0dcb))
* Add impact analysis to --with-context reviews ([f485cdf](https://github.com/kofikode/kode-review-cli/commit/f485cdfb26751e7cc4a722f891f7747cc511faaf))
* Add Phase 2 output formatting, PR posting, and git hooks ([3aaa7a1](https://github.com/kofikode/kode-review-cli/commit/3aaa7a1a58dfc4ae91baad4a77b7f61e7f1792cd))
* Filter gitignored files from agent read_file tool ([721198a](https://github.com/kofikode/kode-review-cli/commit/721198a7a0e59322c4e1b46c1a49812847acb862))
* Make indexer optional for agentic review mode ([4488423](https://github.com/kofikode/kode-review-cli/commit/4488423bebde1db027bb660171349a12ecf53f25))
* US-001 - Set up Postgres schema with pgvector ([1dc01bf](https://github.com/kofikode/kode-review-cli/commit/1dc01bfdd910c8102664fc808bc74a2b60e67ca1))
* US-002 - Create CocoIndex flow for file ingestion ([6926faa](https://github.com/kofikode/kode-review-cli/commit/6926faa1d2c5caef36a80f169f42d80013e31946))
* US-003 - Implement function-boundary chunking ([ba61d62](https://github.com/kofikode/kode-review-cli/commit/ba61d622ce86eb786e64f3fcd767664f735fc691))
* US-004 - Extract symbols and relationships from AST ([638b9a6](https://github.com/kofikode/kode-review-cli/commit/638b9a63dde75b74bfed08eaca5afecd29437a85))
* US-005 - Generate embeddings and export to Postgres ([dc888c5](https://github.com/kofikode/kode-review-cli/commit/dc888c5974ad99097489a84d9b4913af9a3e1b48))
* US-006 - Add config file detection ([66630a9](https://github.com/kofikode/kode-review-cli/commit/66630a9f9e53b5375bc91b74529dc8375d1e535d))
* US-007 - Include modified lines as high-priority context ([6a81766](https://github.com/kofikode/kode-review-cli/commit/6a81766559b828fe5a6ea01addf7a9cf6fb65f70))
* US-008 - Implement automatic test file retrieval ([f953950](https://github.com/kofikode/kode-review-cli/commit/f953950d79bbe3ff006a4e05f6f54c039a72d8e1))
* US-009 - Expand query extraction from diffs ([4b6b2d8](https://github.com/kofikode/kode-review-cli/commit/4b6b2d8946e90bc7094c2cb4d228901aa1b7b18f))
* US-010 - Integrate PR/MR description into context ([12c1f57](https://github.com/kofikode/kode-review-cli/commit/12c1f57ba34449f30e7a58488c720e54c3fd1071))
* US-011 - Add project structure context ([6318e39](https://github.com/kofikode/kode-review-cli/commit/6318e39c5b8bda40063f5cb557bae211ece1f771))
* US-012 - Implement file-type specific retrieval strategies ([2d87a8c](https://github.com/kofikode/kode-review-cli/commit/2d87a8cfc1e7cb8eed7b588818d7bde0eb144406))
* US-013 - Create API endpoint for definition lookup ([3eb1264](https://github.com/kofikode/kode-review-cli/commit/3eb1264a603b4efd5867a397786ca3c34ee13253))
* US-014 - Create API endpoint for usage lookup ([fb44ebb](https://github.com/kofikode/kode-review-cli/commit/fb44ebb71b4166602a494562cbe23d15fac18ed3))
* US-015 - Build import chain tracking ([9623d31](https://github.com/kofikode/kode-review-cli/commit/9623d31e519dd3acf1fa9693f963590b7c9063d3))
* US-016 - Build call graph for TypeScript/JavaScript ([c289070](https://github.com/kofikode/kode-review-cli/commit/c28907031e1b93531aff7fc6c43449082c03c45f))
* US-017 - Extend call graph to Python ([beeff71](https://github.com/kofikode/kode-review-cli/commit/beeff716c3d259a9b553c411e8c7de675942710e))
* US-018 - Extend call graph to Go, Java, Rust ([2e3e4ab](https://github.com/kofikode/kode-review-cli/commit/2e3e4ab33b07398a2f3b9358565cb7de0705995c))
* US-019 - Create call graph query API endpoint ([8ae183d](https://github.com/kofikode/kode-review-cli/commit/8ae183d657bd8070ea84a3e18d8650bdc7705b82))
* US-020 - Implement keyword search with BM25 ([3d49b3f](https://github.com/kofikode/kode-review-cli/commit/3d49b3f665eb6416b4ca491dbd47d685988a699a))
* US-021 - Implement hybrid search combining vector and keyword ([19ea2bd](https://github.com/kofikode/kode-review-cli/commit/19ea2bd0e8244e71dfabfc904448a0bb171c715c))
* US-022 - Implement structured XML context format ([8785046](https://github.com/kofikode/kode-review-cli/commit/87850466506d88d4f6b971a14c68e1613075a06a))
* US-023 - Implement multi-stage retrieval pipeline ([c19bd15](https://github.com/kofikode/kode-review-cli/commit/c19bd15a566df21e981d7b4d6834550686295a0d))
* US-024 - Implement result diversification ([2d1e022](https://github.com/kofikode/kode-review-cli/commit/2d1e022dd577ef9da478410bf599a47d976ca987))
* US-025 - Implement embedding cache with content hash ([909a978](https://github.com/kofikode/kode-review-cli/commit/909a978e4a23ab5cc1d35850effd2517b908361e))
* US-026 - Implement incremental indexing on git diff ([0447287](https://github.com/kofikode/kode-review-cli/commit/04472875e8b1e529193294e540b94e402796c351))
* US-027 - Add background re-indexing for large repos ([e05de59](https://github.com/kofikode/kode-review-cli/commit/e05de59feff78c158adbadb6678e00a3e5745212))

### Bug Fixes

* Prevent config.json from being created in target project directory ([f92d545](https://github.com/kofikode/kode-review-cli/commit/f92d5452d4b2d9b592cc8a33723057cdd85ccea8))
* Prevent Docker architecture mismatch on Apple Silicon ([e28f532](https://github.com/kofikode/kode-review-cli/commit/e28f53216009419807e812d9ce21d60639c3664b))
* Truncate large content in tsvector to avoid PostgreSQL limit ([558db6c](https://github.com/kofikode/kode-review-cli/commit/558db6c196632297d2479c3e8aa363b1d8775928))
