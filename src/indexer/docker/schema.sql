-- Schema migration for kode-review semantic indexer
-- This script creates the enhanced schema for storing code chunks,
-- file metadata, and relationships with pgvector support.
--
-- Run this migration with:
--   psql $DATABASE_URL -f schema.sql
--
-- Or it will be auto-applied by the indexer on startup.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Files Table
-- ============================================================================
-- Tracks file-level metadata for incremental updates and complexity analysis.
-- This table helps determine which files need re-indexing when content changes.

-- File identity is repo-scoped: the same file_path can exist on multiple
-- (repo_id, branch) combinations. The composite PK below replaces an older
-- single-column PK on file_path; existing databases are migrated by the
-- DO block further down this file.
CREATE TABLE IF NOT EXISTS files (
    file_path TEXT NOT NULL,
    last_modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    size INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    complexity_score REAL,
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_path, repo_id, branch)
);

-- Index for finding files by repository and branch
CREATE INDEX IF NOT EXISTS files_repo_branch_idx ON files (repo_id, branch);

-- ============================================================================
-- Chunks Table
-- ============================================================================
-- Stores code fragments with their vector embeddings and rich metadata.
-- Each chunk represents a semantically meaningful unit of code.

CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),
    language TEXT,
    chunk_type TEXT,
    symbol_names TEXT[] DEFAULT '{}',
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    imports TEXT[] DEFAULT '{}',
    exports TEXT[] DEFAULT '{}',
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chunks_files_fk FOREIGN KEY (file_path, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE
);

-- GIN index on symbol_names for fast lookup of functions, classes, etc.
-- This enables efficient queries like "find all chunks defining function X"
CREATE INDEX IF NOT EXISTS chunks_symbol_names_idx ON chunks USING GIN (symbol_names);

-- pgvector index on embedding column for efficient similarity search
-- Using IVFFlat with cosine distance for semantic search
-- lists=100 provides good balance between speed and recall for medium datasets
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Index for finding chunks by file (useful when re-indexing a single file)
CREATE INDEX IF NOT EXISTS chunks_file_path_idx ON chunks (file_path);

-- Composite index covering the (file_path, repo_id, branch) FK on chunks.
-- Without this, cascade deletes on files trigger a full table scan.
CREATE INDEX IF NOT EXISTS chunks_file_repo_branch_idx ON chunks (file_path, repo_id, branch);

-- Index for filtering by repository and branch
CREATE INDEX IF NOT EXISTS chunks_repo_branch_idx ON chunks (repo_id, branch);

-- Index on imports for finding dependency relationships
CREATE INDEX IF NOT EXISTS chunks_imports_idx ON chunks USING GIN (imports);

-- Index on exports for finding what a file provides
CREATE INDEX IF NOT EXISTS chunks_exports_idx ON chunks USING GIN (exports);

-- ============================================================================
-- Full-Text Search Support (for BM25-style keyword search)
-- ============================================================================
-- tsvector column for efficient full-text search on code content
-- This enables keyword search with ranking alongside vector similarity search

-- Add tsvector column for full-text search if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'chunks' AND column_name = 'content_tsv'
    ) THEN
        ALTER TABLE chunks ADD COLUMN content_tsv tsvector;
    END IF;
END $$;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS chunks_content_tsv_idx ON chunks USING GIN (content_tsv);

-- Function to generate tsvector from code content with identifier handling
-- Handles camelCase, snake_case, and preserves code identifiers
-- Truncates content to avoid exceeding PostgreSQL's tsvector size limit (~1MB)
CREATE OR REPLACE FUNCTION code_to_tsvector(content TEXT)
RETURNS tsvector AS $$
DECLARE
    normalized TEXT;
    truncated_content TEXT;
    result tsvector;
    max_content_length CONSTANT INTEGER := 400000;  -- ~400KB to stay safely under 1MB after expansion
BEGIN
    -- Truncate content if too large to avoid tsvector size limit
    IF length(content) > max_content_length THEN
        truncated_content := left(content, max_content_length);
    ELSE
        truncated_content := content;
    END IF;

    -- Start with the truncated content
    normalized := truncated_content;

    -- Split camelCase into separate words (e.g., "getUserName" -> "get User Name get_user_name")
    -- This regex inserts spaces before uppercase letters that follow lowercase letters
    normalized := regexp_replace(normalized, '([a-z])([A-Z])', '\1 \2', 'g');

    -- Also add snake_case version of camelCase identifiers
    -- Convert remaining camelCase to snake_case for additional matching
    normalized := normalized || ' ' || regexp_replace(
        regexp_replace(truncated_content, '([a-z])([A-Z])', '\1_\2', 'g'),
        '([A-Z]+)([A-Z][a-z])', '\1_\2', 'g'
    );

    -- Convert snake_case underscores to spaces for word splitting
    normalized := regexp_replace(normalized, '_', ' ', 'g');

    -- Use 'simple' configuration to preserve code identifiers exactly
    -- (no stemming, which could mangle variable names)
    result := to_tsvector('simple', lower(normalized));

    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger to automatically update tsvector when content changes
CREATE OR REPLACE FUNCTION update_chunks_tsv()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content_tsv := code_to_tsvector(NEW.content);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_tsv_trigger ON chunks;
CREATE TRIGGER chunks_tsv_trigger
    BEFORE INSERT OR UPDATE OF content ON chunks
    FOR EACH ROW
    EXECUTE FUNCTION update_chunks_tsv();

-- Backfill existing rows (run once during migration)
-- This is idempotent - only updates rows with null content_tsv
UPDATE chunks SET content_tsv = code_to_tsvector(content)
WHERE content_tsv IS NULL;

-- ============================================================================
-- Relationships Table
-- ============================================================================
-- Captures relationships between code chunks such as:
-- - imports: chunk A imports from chunk B
-- - calls: chunk A calls a function defined in chunk B
-- - extends: chunk A extends/inherits from chunk B
-- - implements: chunk A implements interface from chunk B

CREATE TABLE IF NOT EXISTS relationships (
    source_chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    target_chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_chunk_id, target_chunk_id, relationship_type)
);

-- Index for finding all relationships from a chunk
CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships (source_chunk_id);

-- Index for finding all relationships to a chunk (reverse lookup)
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships (target_chunk_id);

-- Index for filtering by relationship type
CREATE INDEX IF NOT EXISTS relationships_type_idx ON relationships (relationship_type);

-- ============================================================================
-- File Imports Table (for import chain tracking)
-- ============================================================================
-- Tracks file-level import relationships for building import graphs.
-- This enables:
-- - 2-level import tree computation (what imports it, what it imports)
-- - Circular dependency detection
-- - Hub file identification (files with many dependents)

CREATE TABLE IF NOT EXISTS file_imports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_file TEXT NOT NULL,
    target_file TEXT NOT NULL,
    import_type TEXT NOT NULL DEFAULT 'static',  -- 'static', 'dynamic', 're-export'
    imported_symbols TEXT[] DEFAULT '{}',  -- Specific symbols imported
    repo_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_file, target_file, repo_id, branch),
    CONSTRAINT file_imports_source_fk FOREIGN KEY (source_file, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE,
    CONSTRAINT file_imports_target_fk FOREIGN KEY (target_file, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE
);

-- Index for finding what a file imports (outgoing edges)
CREATE INDEX IF NOT EXISTS file_imports_source_idx ON file_imports (source_file, repo_id, branch);

-- Index for finding what imports a file (incoming edges)
CREATE INDEX IF NOT EXISTS file_imports_target_idx ON file_imports (target_file, repo_id, branch);

-- Index for filtering by repository and branch
CREATE INDEX IF NOT EXISTS file_imports_repo_branch_idx ON file_imports (repo_id, branch);

-- ============================================================================
-- Embedding Cache Table
-- ============================================================================
-- Caches embeddings by content hash to avoid re-embedding unchanged content.
-- Uses SHA-256 hash of the content as the cache key, combined with the model name
-- to ensure embeddings are invalidated when the model changes.

CREATE TABLE IF NOT EXISTS embedding_cache (
    content_hash TEXT NOT NULL,           -- SHA-256 hash of the content
    model_name TEXT NOT NULL,             -- Embedding model used (e.g., 'sentence-transformers/all-MiniLM-L6-v2')
    embedding VECTOR(1536) NOT NULL,      -- The cached embedding (padded to 1536 dims)
    embedding_dim INTEGER NOT NULL,       -- Original embedding dimension before padding
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    hit_count INTEGER NOT NULL DEFAULT 0, -- Number of times this cache entry was used
    PRIMARY KEY (content_hash, model_name)
);

-- Index for cleanup queries (find old/unused cache entries)
CREATE INDEX IF NOT EXISTS embedding_cache_last_used_idx ON embedding_cache (last_used_at);

-- Index for statistics queries
CREATE INDEX IF NOT EXISTS embedding_cache_model_idx ON embedding_cache (model_name);

-- ============================================================================
-- Legacy Table (for backward compatibility during migration)
-- ============================================================================
-- Keep the old code_embeddings table for gradual migration.
-- New code should use the chunks/files/relationships tables.

CREATE TABLE IF NOT EXISTS code_embeddings (
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    filename TEXT NOT NULL,
    location TEXT NOT NULL,
    code TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    embedding vector(384),
    PRIMARY KEY (repo_id, branch, filename, location)
);

CREATE INDEX IF NOT EXISTS code_embeddings_embedding_idx
    ON code_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ============================================================================
-- Composite-Key Migration (idempotent upgrade for existing databases)
-- ============================================================================
-- Fresh databases get the composite (file_path, repo_id, branch) PK and FKs
-- directly from the CREATE TABLE statements above. Databases created under
-- the prior schema have a single-column PRIMARY KEY (file_path) on `files`
-- and single-column FOREIGN KEYs on `chunks.file_path` /
-- `file_imports.source_file` / `file_imports.target_file`. This block detects
-- that legacy shape and upgrades in place. The block is a no-op after the
-- first successful run.

DO $$
DECLARE
    files_pk_columns INTEGER;
    files_pk_name TEXT;
    chunks_fk_name TEXT;
    fi_source_fk_name TEXT;
    fi_target_fk_name TEXT;
    orphan_chunks INTEGER;
    orphan_imports_source INTEGER;
    orphan_imports_target INTEGER;
BEGIN
    -- Count PK columns on `files`. Three columns means the migration already
    -- ran. Scope to current_schema() so the count is not inflated by a
    -- same-named table in another schema on a shared Postgres instance.
    SELECT COUNT(*) INTO files_pk_columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'files'
      AND tc.table_schema = current_schema()
      AND tc.constraint_type = 'PRIMARY KEY';

    IF files_pk_columns >= 3 THEN
        RAISE NOTICE 'files PK already composite (% columns), skipping migration', files_pk_columns;
        RETURN;
    END IF;

    IF files_pk_columns = 0 THEN
        -- Reachable only if `files` was created without a PK at all (manual
        -- DDL); the CREATE TABLE above always declares one, so a fresh-run
        -- DB never lands here.
        RAISE NOTICE 'files table has no PK yet; skipping composite-key migration';
        RETURN;
    END IF;

    -- Look up existing constraint names. Postgres auto-names them
    -- consistently, but we look them up dynamically so the block tolerates
    -- databases that were patched manually. All lookups are scoped to the
    -- current schema.
    SELECT constraint_name INTO files_pk_name
    FROM information_schema.table_constraints
    WHERE table_name = 'files'
      AND table_schema = current_schema()
      AND constraint_type = 'PRIMARY KEY'
    LIMIT 1;

    SELECT tc.constraint_name INTO chunks_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.table_name = 'chunks'
      AND tc.table_schema = current_schema()
      AND tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'files'
    LIMIT 1;

    SELECT tc.constraint_name INTO fi_source_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'file_imports'
      AND tc.table_schema = current_schema()
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'source_file'
    LIMIT 1;

    SELECT tc.constraint_name INTO fi_target_fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'file_imports'
      AND tc.table_schema = current_schema()
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'target_file'
    LIMIT 1;

    -- Clean up orphan rows that the legacy single-column FKs would have
    -- allowed (e.g. a chunk whose file_path matches a row in `files` but
    -- whose repo_id/branch do not). Without this, VALIDATE CONSTRAINT below
    -- can fail on live data.
    DELETE FROM chunks c
    WHERE NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.file_path = c.file_path
          AND f.repo_id = c.repo_id
          AND f.branch = c.branch
    );
    GET DIAGNOSTICS orphan_chunks = ROW_COUNT;
    IF orphan_chunks > 0 THEN
        RAISE NOTICE 'Removed % orphan chunks during composite-key migration', orphan_chunks;
    END IF;

    DELETE FROM file_imports fi
    WHERE NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.file_path = fi.source_file
          AND f.repo_id = fi.repo_id
          AND f.branch = fi.branch
    );
    GET DIAGNOSTICS orphan_imports_source = ROW_COUNT;

    DELETE FROM file_imports fi
    WHERE NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.file_path = fi.target_file
          AND f.repo_id = fi.repo_id
          AND f.branch = fi.branch
    );
    GET DIAGNOSTICS orphan_imports_target = ROW_COUNT;
    IF orphan_imports_source + orphan_imports_target > 0 THEN
        RAISE NOTICE 'Removed % orphan file_imports (% source, % target) during composite-key migration',
            orphan_imports_source + orphan_imports_target,
            orphan_imports_source,
            orphan_imports_target;
    END IF;

    -- Drop old FKs first (Postgres rejects dropping a PK while FKs depend on it).
    IF chunks_fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE chunks DROP CONSTRAINT %I', chunks_fk_name);
    END IF;
    IF fi_source_fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE file_imports DROP CONSTRAINT %I', fi_source_fk_name);
    END IF;
    IF fi_target_fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE file_imports DROP CONSTRAINT %I', fi_target_fk_name);
    END IF;

    -- Also defensively drop the NEW constraint names if a prior partial
    -- patch left them around without finishing the PK swap. Without this,
    -- the ADD CONSTRAINT below would fail with `duplicate_object`.
    ALTER TABLE chunks       DROP CONSTRAINT IF EXISTS chunks_files_fk;
    ALTER TABLE file_imports DROP CONSTRAINT IF EXISTS file_imports_source_fk;
    ALTER TABLE file_imports DROP CONSTRAINT IF EXISTS file_imports_target_fk;

    -- Drop old single-column PK and replace with composite.
    IF files_pk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE files DROP CONSTRAINT %I', files_pk_name);
    END IF;
    ALTER TABLE files ADD CONSTRAINT files_pkey
        PRIMARY KEY (file_path, repo_id, branch);

    -- Recreate FKs as composite. NOT VALID skips the full-table scan for
    -- existing rows so the ALTER takes a short ACCESS EXCLUSIVE; the
    -- subsequent VALIDATE only needs SHARE UPDATE EXCLUSIVE so reads/writes
    -- continue during validation.
    ALTER TABLE chunks ADD CONSTRAINT chunks_files_fk
        FOREIGN KEY (file_path, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE NOT VALID;
    ALTER TABLE chunks VALIDATE CONSTRAINT chunks_files_fk;

    ALTER TABLE file_imports ADD CONSTRAINT file_imports_source_fk
        FOREIGN KEY (source_file, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE NOT VALID;
    ALTER TABLE file_imports VALIDATE CONSTRAINT file_imports_source_fk;

    ALTER TABLE file_imports ADD CONSTRAINT file_imports_target_fk
        FOREIGN KEY (target_file, repo_id, branch)
        REFERENCES files(file_path, repo_id, branch) ON DELETE CASCADE NOT VALID;
    ALTER TABLE file_imports VALIDATE CONSTRAINT file_imports_target_fk;

    RAISE NOTICE 'Composite-key migration complete';
END $$;

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function to update the updated_at timestamp on files table
CREATE OR REPLACE FUNCTION update_files_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at on files table
DROP TRIGGER IF EXISTS files_updated_at_trigger ON files;
CREATE TRIGGER files_updated_at_trigger
    BEFORE UPDATE ON files
    FOR EACH ROW
    EXECUTE FUNCTION update_files_updated_at();
