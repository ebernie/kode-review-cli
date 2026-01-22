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

CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    last_modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    size INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    complexity_score REAL,
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    file_path TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

-- Index for filtering by repository and branch
CREATE INDEX IF NOT EXISTS chunks_repo_branch_idx ON chunks (repo_id, branch);

-- Index on imports for finding dependency relationships
CREATE INDEX IF NOT EXISTS chunks_imports_idx ON chunks USING GIN (imports);

-- Index on exports for finding what a file provides
CREATE INDEX IF NOT EXISTS chunks_exports_idx ON chunks USING GIN (exports);

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
    source_file TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
    target_file TEXT NOT NULL REFERENCES files(file_path) ON DELETE CASCADE,
    import_type TEXT NOT NULL DEFAULT 'static',  -- 'static', 'dynamic', 're-export'
    imported_symbols TEXT[] DEFAULT '{}',  -- Specific symbols imported
    repo_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_file, target_file, repo_id, branch)
);

-- Index for finding what a file imports (outgoing edges)
CREATE INDEX IF NOT EXISTS file_imports_source_idx ON file_imports (source_file, repo_id, branch);

-- Index for finding what imports a file (incoming edges)
CREATE INDEX IF NOT EXISTS file_imports_target_idx ON file_imports (target_file, repo_id, branch);

-- Index for filtering by repository and branch
CREATE INDEX IF NOT EXISTS file_imports_repo_branch_idx ON file_imports (repo_id, branch);

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
