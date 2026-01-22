#!/usr/bin/env python3
"""
CocoIndex flow for repository file ingestion, chunking, embedding, and export.

This module defines a CocoIndex flow that:
1. Reads source files from a local repository directory
2. Detects programming language from file extensions
3. Chunks code using AST-based function/class boundary detection
4. Generates embeddings using SentenceTransformer
5. Exports chunks with embeddings to Postgres (chunks table)
6. Exports relationships between chunks to Postgres (relationships table)

The flow uses CocoIndex's built-in LocalFile source and custom functions
for AST-based chunking and relationship extraction.

Environment variables:
- COCOINDEX_DATABASE_URL: PostgreSQL connection string (required)
- REPO_PATH: Path to repository to index (default: /repo)
- REPO_URL: Repository URL for identification
- REPO_BRANCH: Branch being indexed (default: main)
- EMBEDDING_MODEL: SentenceTransformer model (default: sentence-transformers/all-MiniLM-L6-v2)

Usage:
    # Setup database tables
    cocoindex setup cocoindex_flow.py

    # Run indexing
    cocoindex update cocoindex_flow.py

    # Run with live updates (watch mode)
    cocoindex update -L cocoindex_flow.py
"""

from __future__ import annotations

import os
import hashlib
import uuid
from dataclasses import dataclass, field
from typing import Any

import cocoindex
import numpy as np
import psycopg
from numpy.typing import NDArray
from pgvector.psycopg import register_vector

# Import AST-based chunking
from ast_chunker import chunk_code_ast, CodeChunk


# =============================================================================
# Embedding Cache Support
# =============================================================================


@dataclass
class CacheStats:
    """Statistics for embedding cache performance."""
    hits: int = 0
    misses: int = 0

    @property
    def total(self) -> int:
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        if self.total == 0:
            return 0.0
        return self.hits / self.total


# Global cache stats for the current flow execution
_cache_stats = CacheStats()


def get_cache_stats() -> CacheStats:
    """Get the current cache statistics."""
    return _cache_stats


def reset_cache_stats() -> None:
    """Reset cache statistics for a new flow execution."""
    global _cache_stats
    _cache_stats = CacheStats()


def compute_content_hash(content: str) -> str:
    """
    Compute SHA-256 hash of content for cache lookup.

    Args:
        content: The text content to hash

    Returns:
        Hexadecimal SHA-256 hash string
    """
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def lookup_cached_embedding(
    database_url: str,
    content_hash: str,
    model_name: str
) -> list[float] | None:
    """
    Look up a single cached embedding by content hash.

    Args:
        database_url: PostgreSQL connection string
        content_hash: SHA-256 content hash
        model_name: The embedding model name

    Returns:
        Embedding as list of floats, or None if not cached
    """
    try:
        conn = psycopg.connect(database_url)
        register_vector(conn)

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE embedding_cache
                SET last_used_at = NOW(), hit_count = hit_count + 1
                WHERE content_hash = %s AND model_name = %s
                RETURNING embedding
                """,
                (content_hash, model_name)
            )
            row = cur.fetchone()
            conn.commit()

        conn.close()

        if row and row[0] is not None:
            return list(row[0])
        return None
    except Exception:
        return None


def store_cached_embedding(
    database_url: str,
    content_hash: str,
    embedding: list[float],
    original_dim: int,
    model_name: str
) -> bool:
    """
    Store an embedding in the cache.

    Args:
        database_url: PostgreSQL connection string
        content_hash: SHA-256 content hash
        embedding: The embedding to cache (padded to 1536 dims)
        original_dim: Original embedding dimension before padding
        model_name: The embedding model name

    Returns:
        True if cached successfully, False otherwise
    """
    try:
        conn = psycopg.connect(database_url)
        register_vector(conn)

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO embedding_cache (content_hash, model_name, embedding, embedding_dim)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (content_hash, model_name) DO UPDATE SET
                    last_used_at = NOW(),
                    hit_count = embedding_cache.hit_count + 1
                """,
                (content_hash, model_name, embedding, original_dim)
            )
            conn.commit()

        conn.close()
        return True
    except Exception:
        return False


# Configuration from environment
REPO_PATH = os.environ.get("REPO_PATH", "/repo")
REPO_URL = os.environ.get("REPO_URL", "")
REPO_BRANCH = os.environ.get("REPO_BRANCH", "main")
EMBEDDING_MODEL = os.environ.get(
    "EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
)


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


def generate_chunk_id(
    repo_id: str, branch: str, filename: str, location: str
) -> str:
    """Generate a deterministic UUID for a chunk based on its identity."""
    identity = f"{repo_id}:{branch}:{filename}:{location}"
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, identity))


# File extensions to include for indexing
# These cover the most common programming languages used in codebases
INCLUDED_PATTERNS = [
    # TypeScript/JavaScript
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.mjs",
    "**/*.cjs",
    # Python
    "**/*.py",
    "**/*.pyi",
    # Systems languages
    "**/*.rs",
    "**/*.go",
    "**/*.c",
    "**/*.cpp",
    "**/*.h",
    "**/*.hpp",
    # JVM languages
    "**/*.java",
    "**/*.kt",
    "**/*.scala",
    # .NET languages
    "**/*.cs",
    "**/*.fs",
    # Other popular languages
    "**/*.rb",
    "**/*.php",
    "**/*.swift",
    # Shell and config
    "**/*.sh",
    "**/*.bash",
    # Markup and data (for context)
    "**/*.md",
    "**/*.json",
    "**/*.yaml",
    "**/*.yml",
    "**/*.toml",
    # ===== Configuration Files =====
    # TypeScript config
    "**/tsconfig.json",
    "**/tsconfig.*.json",
    "**/jsconfig.json",
    # ESLint config (various formats)
    "**/eslint.config.js",
    "**/eslint.config.mjs",
    "**/eslint.config.cjs",
    "**/eslint.config.ts",
    "**/.eslintrc",
    "**/.eslintrc.js",
    "**/.eslintrc.cjs",
    "**/.eslintrc.json",
    "**/.eslintrc.yml",
    "**/.eslintrc.yaml",
    # Prettier config
    "**/.prettierrc",
    "**/.prettierrc.json",
    "**/.prettierrc.yml",
    "**/.prettierrc.yaml",
    "**/.prettierrc.js",
    "**/.prettierrc.cjs",
    "**/.prettierrc.mjs",
    "**/prettier.config.js",
    "**/prettier.config.cjs",
    "**/prettier.config.mjs",
    # Package managers (partial extraction)
    "**/package.json",
    "**/composer.json",
    # Python project config
    "**/pyproject.toml",
    "**/setup.py",
    "**/setup.cfg",
    "**/requirements.txt",
    "**/Pipfile",
    "**/tox.ini",
    "**/.python-version",
    # Go config
    "**/go.mod",
    # Rust config
    "**/Cargo.toml",
    # Editor config
    "**/.editorconfig",
    # Docker config
    "**/Dockerfile",
    "**/dockerfile",
    "**/docker-compose.yml",
    "**/docker-compose.yaml",
    "**/compose.yml",
    "**/compose.yaml",
    # CI/CD config
    "**/.gitlab-ci.yml",
    "**/.travis.yml",
    "**/azure-pipelines.yml",
    "**/.github/workflows/*.yml",
    "**/.github/workflows/*.yaml",
    "**/.circleci/config.yml",
    "**/Jenkinsfile",
    # Build tool configs
    "**/babel.config.js",
    "**/babel.config.json",
    "**/.babelrc",
    "**/webpack.config.js",
    "**/webpack.config.ts",
    "**/vite.config.js",
    "**/vite.config.ts",
    "**/rollup.config.js",
    "**/rollup.config.ts",
    # Test configs
    "**/jest.config.js",
    "**/jest.config.ts",
    "**/vitest.config.ts",
    "**/vitest.config.js",
    "**/pytest.ini",
    # Other common configs
    "**/.npmrc",
    "**/.yarnrc",
    "**/.nvmrc",
    "**/.env.example",
    "**/.env.template",
]

# Directories and patterns to exclude from indexing
EXCLUDED_PATTERNS = [
    # Package managers and dependencies
    "**/node_modules/**",
    "**/vendor/**",
    "**/venv/**",
    "**/.venv/**",
    "**/env/**",
    "**/.env/**",
    "**/packages/**/node_modules/**",
    # Build outputs
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/target/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/coverage/**",
    "**/.nyc_output/**",
    # Version control
    "**/.git/**",
    "**/.svn/**",
    "**/.hg/**",
    # IDE and editor
    "**/.idea/**",
    "**/.vscode/**",
    "**/.vs/**",
    # Cache directories
    "**/__pycache__/**",
    "**/.pytest_cache/**",
    "**/.mypy_cache/**",
    "**/.ruff_cache/**",
    "**/.cache/**",
    # Test snapshots and fixtures (usually not needed for context)
    "**/__snapshots__/**",
    "**/fixtures/**",
    # Lock files (not useful for semantic understanding)
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lockb",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/Pipfile.lock",
    "**/composer.lock",
    "**/Gemfile.lock",
    # Minified/generated files
    "**/*.min.js",
    "**/*.min.css",
    "**/*.bundle.js",
    "**/*.map",
]

# Maximum file size to index (10MB) - skip very large files
MAX_FILE_SIZE = 10_000_000


# =============================================================================
# Custom CocoIndex Functions for AST Chunking
# =============================================================================


@dataclass
class ChunkInfo:
    """Serializable chunk information for CocoIndex data flow."""

    chunk_id: str
    filename: str
    location: str
    content: str
    language: str | None
    chunk_type: str
    symbol_names: list[str]
    imports: list[str]
    exports: list[str]
    line_start: int
    line_end: int
    repo_id: str
    repo_url: str
    branch: str


class ASTChunkCode(cocoindex.op.FunctionSpec):
    """
    Function spec for AST-based code chunking.

    Chunks source code using tree-sitter AST parsing to respect
    function/class boundaries. Falls back to line-based chunking
    for unsupported languages.
    """

    repo_id: str
    repo_url: str
    branch: str


@cocoindex.op.executor_class(cache=True, behavior_version=1)
class ASTChunkCodeExecutor:
    """Executor for AST-based code chunking."""

    spec: ASTChunkCode

    def __call__(
        self, filename: str, content: str, language: str | None
    ) -> list[ChunkInfo]:
        """
        Chunk code content using AST-based boundary detection.

        Args:
            filename: Relative path of the file
            content: Source code content
            language: Detected programming language (or None)

        Returns:
            List of ChunkInfo objects representing code chunks
        """
        if not content or not content.strip():
            return []

        # Use AST-based chunking
        chunks = chunk_code_ast(content, filename)

        result: list[ChunkInfo] = []
        for chunk in chunks:
            chunk_id = generate_chunk_id(
                self.spec.repo_id,
                self.spec.branch,
                chunk.filename,
                chunk.location,
            )

            result.append(
                ChunkInfo(
                    chunk_id=chunk_id,
                    filename=chunk.filename,
                    location=chunk.location,
                    content=chunk.code,
                    language=language,
                    chunk_type=chunk.chunk_type,
                    symbol_names=chunk.symbol_names or [],
                    imports=chunk.imports or [],
                    exports=chunk.exports or [],
                    line_start=chunk.start_line,
                    line_end=chunk.end_line,
                    repo_id=self.spec.repo_id,
                    repo_url=self.spec.repo_url,
                    branch=self.spec.branch,
                )
            )

        return result


# =============================================================================
# Relationship Extraction
# =============================================================================


@dataclass
class RelationshipInfo:
    """Represents a relationship between two chunks."""

    source_chunk_id: str
    target_chunk_id: str
    relationship_type: str
    metadata: dict[str, Any]


def extract_relationships(
    chunks: list[ChunkInfo],
) -> list[RelationshipInfo]:
    """
    Extract relationships between chunks based on imports/exports.

    This analyzes:
    - Import statements to find which chunks depend on others
    - Export/symbol_names to find what each chunk provides
    - Creates 'imports' relationships when a chunk imports a symbol
      that another chunk exports

    Args:
        chunks: List of ChunkInfo objects from the same repository

    Returns:
        List of RelationshipInfo objects representing inter-chunk relationships
    """
    relationships: list[RelationshipInfo] = []

    # Build a map of exported symbols to chunk IDs
    # symbol_name -> list of chunk_ids that export it
    export_map: dict[str, list[str]] = {}

    for chunk in chunks:
        # Symbols defined in a chunk (symbol_names) can be imported by others
        for symbol in chunk.symbol_names:
            if symbol not in export_map:
                export_map[symbol] = []
            export_map[symbol].append(chunk.chunk_id)

        # Explicitly exported symbols
        for export in chunk.exports:
            # Handle "* from ./module" re-exports
            if export.startswith("* from "):
                continue
            if export not in export_map:
                export_map[export] = []
            if chunk.chunk_id not in export_map[export]:
                export_map[export].append(chunk.chunk_id)

    # Now find import relationships
    for chunk in chunks:
        for imported in chunk.imports:
            # Check if any chunk exports this symbol
            # Note: imports are often module paths, not symbol names
            # We check both exact matches and partial matches

            # Try exact match first
            if imported in export_map:
                for target_chunk_id in export_map[imported]:
                    if target_chunk_id != chunk.chunk_id:
                        relationships.append(
                            RelationshipInfo(
                                source_chunk_id=chunk.chunk_id,
                                target_chunk_id=target_chunk_id,
                                relationship_type="imports",
                                metadata={"imported_symbol": imported},
                            )
                        )

    # Look for call relationships based on symbol usage
    # This is a heuristic: if chunk A's content contains a symbol name
    # that chunk B exports, and A imports from B's file, it's likely a call
    for chunk in chunks:
        # Check each exported symbol against other chunks' content
        for symbol in chunk.symbol_names:
            if not symbol or len(symbol) < 3:  # Skip very short symbols
                continue

            for other_chunk in chunks:
                if other_chunk.chunk_id == chunk.chunk_id:
                    continue

                # Skip if already have an imports relationship
                existing = any(
                    r.source_chunk_id == other_chunk.chunk_id
                    and r.target_chunk_id == chunk.chunk_id
                    and r.relationship_type == "imports"
                    for r in relationships
                )

                # Check if the symbol appears in the other chunk's content
                # Use word boundary check to avoid false positives
                if (
                    not existing
                    and f"{symbol}(" in other_chunk.content
                    or f"{symbol}." in other_chunk.content
                    or f" {symbol} " in other_chunk.content
                ):
                    # Don't create relationship to self
                    if other_chunk.chunk_id != chunk.chunk_id:
                        relationships.append(
                            RelationshipInfo(
                                source_chunk_id=other_chunk.chunk_id,
                                target_chunk_id=chunk.chunk_id,
                                relationship_type="references",
                                metadata={"symbol": symbol},
                            )
                        )

    # Deduplicate relationships
    seen: set[tuple[str, str, str]] = set()
    unique_relationships: list[RelationshipInfo] = []

    for rel in relationships:
        key = (rel.source_chunk_id, rel.target_chunk_id, rel.relationship_type)
        if key not in seen:
            seen.add(key)
            unique_relationships.append(rel)

    return unique_relationships


# =============================================================================
# Cached Embedding Function
# =============================================================================


class CachedSentenceTransformerEmbed(cocoindex.op.FunctionSpec):
    """
    Function spec for cached sentence transformer embedding.

    This wraps SentenceTransformerEmbed with a content-hash based cache
    to avoid re-embedding unchanged content.
    """

    model: str
    database_url: str


@cocoindex.op.executor_class(cache=True, behavior_version=1)
class CachedSentenceTransformerEmbedExecutor:
    """Executor for cached sentence transformer embedding."""

    spec: CachedSentenceTransformerEmbed
    _model: Any = None

    def __call__(self, text: str) -> NDArray[np.float32]:
        """
        Generate embedding for text, using cache when possible.

        Args:
            text: The text to embed

        Returns:
            Embedding as numpy array (padded to 1536 dimensions)
        """
        global _cache_stats

        # Compute content hash
        content_hash = compute_content_hash(text)

        # Try cache lookup
        cached = lookup_cached_embedding(
            self.spec.database_url,
            content_hash,
            self.spec.model
        )

        if cached is not None:
            _cache_stats.hits += 1
            return np.array(cached, dtype=np.float32)

        # Cache miss - generate embedding
        _cache_stats.misses += 1

        # Lazy load model
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.spec.model)

        # Generate embedding
        embedding = self._model.encode(text, show_progress_bar=False)
        embedding_list = embedding.tolist()
        original_dim = len(embedding_list)

        # Pad to 1536 dimensions
        if len(embedding_list) < 1536:
            embedding_list = embedding_list + [0.0] * (1536 - len(embedding_list))

        # Cache the embedding
        store_cached_embedding(
            self.spec.database_url,
            content_hash,
            embedding_list,
            original_dim,
            self.spec.model
        )

        return np.array(embedding_list, dtype=np.float32)


# =============================================================================
# Transform Flow for Reusable Embedding
# =============================================================================


@cocoindex.transform_flow()
def text_to_embedding(
    text: cocoindex.DataSlice[str],
) -> cocoindex.DataSlice[NDArray[np.float32]]:
    """
    Embed text using SentenceTransformer model.

    This is shared logic that can be used for both indexing and querying.
    """
    return text.transform(
        cocoindex.functions.SentenceTransformerEmbed(model=EMBEDDING_MODEL)
    )


@cocoindex.transform_flow()
def text_to_embedding_cached(
    text: cocoindex.DataSlice[str],
) -> cocoindex.DataSlice[NDArray[np.float32]]:
    """
    Embed text using SentenceTransformer model with caching.

    Uses content-hash based cache to skip embedding generation for
    unchanged content.
    """
    database_url = os.environ.get("COCOINDEX_DATABASE_URL", "")
    return text.transform(
        CachedSentenceTransformerEmbed(
            model=EMBEDDING_MODEL,
            database_url=database_url
        )
    )


# =============================================================================
# Main Flow Definition
# =============================================================================


@cocoindex.flow_def(name="CodeEmbedding")
def code_embedding_flow(
    flow_builder: cocoindex.FlowBuilder, data_scope: cocoindex.DataScope
) -> None:
    """
    CocoIndex flow for code embedding with AST-based chunking.

    This flow:
    1. Reads source files from a local repository
    2. Detects programming language
    3. Chunks code using AST-based boundary detection
    4. Generates embeddings for each chunk
    5. Exports to Postgres (chunks table with full metadata)

    Args:
        flow_builder: CocoIndex flow builder for constructing the pipeline
        data_scope: Data scope for managing flow data
    """
    # Pre-compute repo metadata
    repo_id = generate_repo_id(REPO_URL)

    # Reset cache stats for this flow execution
    reset_cache_stats()

    print(f"Initializing CodeEmbedding flow...")
    print(f"  Repository: {REPO_URL}")
    print(f"  Branch: {REPO_BRANCH}")
    print(f"  Repo ID: {repo_id}")
    print(f"  Path: {REPO_PATH}")
    print(f"  Embedding Model: {EMBEDDING_MODEL}")
    print(f"  Embedding Cache: enabled")

    # Add LocalFile source with pattern-based filtering
    data_scope["source_files"] = flow_builder.add_source(
        cocoindex.sources.LocalFile(
            path=REPO_PATH,
            binary=False,
            included_patterns=INCLUDED_PATTERNS,
            excluded_patterns=EXCLUDED_PATTERNS,
            max_file_size=MAX_FILE_SIZE,
        )
    )

    # Collector for file metadata
    files_collector = data_scope.add_collector()

    # Collector for chunks with embeddings
    chunks_collector = data_scope.add_collector()

    # Process each file from the source
    with data_scope["source_files"].row() as file:
        # Detect programming language from filename extension
        file["language"] = file["filename"].transform(
            cocoindex.functions.DetectProgrammingLanguage()
        )

        # Collect file metadata
        files_collector.collect(
            file_path=file["filename"],
            language=file["language"],
            repo_id=repo_id,
            repo_url=REPO_URL,
            branch=REPO_BRANCH,
        )

        # Chunk the code using AST-based boundary detection
        file["chunks"] = file["filename"].transform(
            ASTChunkCode(
                repo_id=repo_id,
                repo_url=REPO_URL,
                branch=REPO_BRANCH,
            ),
            content=file["content"],
            language=file["language"],
        )

        # Process each chunk
        with file["chunks"].row() as chunk:
            # Generate embedding for the chunk content (with caching)
            chunk["embedding"] = text_to_embedding_cached(chunk["content"])

            # Collect chunk with all metadata
            chunks_collector.collect(
                id=chunk["chunk_id"],
                file_path=chunk["filename"],
                content=chunk["content"],
                embedding=chunk["embedding"],
                language=chunk["language"],
                chunk_type=chunk["chunk_type"],
                symbol_names=chunk["symbol_names"],
                line_start=chunk["line_start"],
                line_end=chunk["line_end"],
                imports=chunk["imports"],
                exports=chunk["exports"],
                repo_id=chunk["repo_id"],
                repo_url=chunk["repo_url"],
                branch=chunk["branch"],
            )

    # Export files metadata to Postgres
    files_collector.export(
        "files",
        cocoindex.storages.Postgres(),
        primary_key_fields=["file_path"],
    )

    # Export chunks with embeddings to Postgres
    # This creates the vector index for similarity search
    chunks_collector.export(
        "chunks",
        cocoindex.storages.Postgres(),
        primary_key_fields=["id"],
        vector_indexes=[
            cocoindex.VectorIndexDef(
                field_name="embedding",
                metric=cocoindex.VectorSimilarityMetric.COSINE_SIMILARITY,
            )
        ],
    )


# =============================================================================
# Post-Processing: Relationship Extraction
# =============================================================================


def export_relationships_to_postgres(database_url: str) -> int:
    """
    Extract and export relationships between chunks.

    This runs after the main flow to analyze chunks and create
    relationship records in the relationships table.

    Args:
        database_url: PostgreSQL connection string

    Returns:
        Number of relationships created
    """
    import psycopg
    from pgvector.psycopg import register_vector

    repo_id = generate_repo_id(REPO_URL)

    print("Extracting relationships...")

    conn = psycopg.connect(database_url)
    register_vector(conn)

    # Fetch all chunks for this repo/branch
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, file_path, content, language, chunk_type,
                   symbol_names, imports, exports, line_start, line_end,
                   repo_id, repo_url, branch
            FROM chunks
            WHERE repo_id = %s AND branch = %s
            """,
            (repo_id, REPO_BRANCH),
        )
        rows = cur.fetchall()

    if not rows:
        print("  No chunks found for relationship extraction")
        conn.close()
        return 0

    # Convert rows to ChunkInfo objects
    chunks: list[ChunkInfo] = []
    for row in rows:
        chunks.append(
            ChunkInfo(
                chunk_id=str(row[0]),
                filename=row[1],
                location="",  # Not stored in DB, not needed for relationships
                content=row[2],
                language=row[3],
                chunk_type=row[4],
                symbol_names=row[5] or [],
                imports=row[6] or [],
                exports=row[7] or [],
                line_start=row[8],
                line_end=row[9],
                repo_id=row[10],
                repo_url=row[11],
                branch=row[12],
            )
        )

    print(f"  Analyzing {len(chunks)} chunks...")

    # Extract relationships
    relationships = extract_relationships(chunks)

    print(f"  Found {len(relationships)} relationships")

    if not relationships:
        conn.close()
        return 0

    # Delete existing relationships for this repo/branch
    with conn.cursor() as cur:
        # Get all chunk IDs for this repo/branch
        cur.execute(
            """
            DELETE FROM relationships
            WHERE source_chunk_id IN (
                SELECT id FROM chunks WHERE repo_id = %s AND branch = %s
            )
            """,
            (repo_id, REPO_BRANCH),
        )
        deleted = cur.rowcount
        if deleted > 0:
            print(f"  Deleted {deleted} existing relationships")

    # Insert new relationships
    inserted = 0
    with conn.cursor() as cur:
        for rel in relationships:
            try:
                # Validate that both chunk IDs exist
                cur.execute(
                    "SELECT COUNT(*) FROM chunks WHERE id = %s OR id = %s",
                    (rel.source_chunk_id, rel.target_chunk_id),
                )
                count = cur.fetchone()[0]
                if count < 2:
                    # One or both chunks don't exist, skip
                    continue

                cur.execute(
                    """
                    INSERT INTO relationships
                    (source_chunk_id, target_chunk_id, relationship_type, metadata)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (source_chunk_id, target_chunk_id, relationship_type)
                    DO UPDATE SET metadata = EXCLUDED.metadata
                    """,
                    (
                        rel.source_chunk_id,
                        rel.target_chunk_id,
                        rel.relationship_type,
                        psycopg.types.json.Json(rel.metadata),
                    ),
                )
                inserted += 1
            except Exception as e:
                print(f"  Warning: Failed to insert relationship: {e}")

        conn.commit()

    conn.close()

    print(f"  Inserted {inserted} relationships")
    return inserted


# =============================================================================
# Entry Point
# =============================================================================


def run_full_indexing() -> dict:
    """
    Run the complete indexing pipeline.

    This orchestrates:
    1. CocoIndex flow for file ingestion, chunking, and embedding
    2. Relationship extraction and export

    Returns:
        Dictionary with indexing statistics
    """
    import json

    database_url = os.environ.get("COCOINDEX_DATABASE_URL")
    if not database_url:
        raise ValueError("COCOINDEX_DATABASE_URL environment variable is required")

    repo_id = generate_repo_id(REPO_URL)

    print("=" * 60)
    print("CodeEmbedding Full Indexing Pipeline")
    print("=" * 60)
    print(f"Repository: {REPO_URL}")
    print(f"Branch: {REPO_BRANCH}")
    print(f"Repo ID: {repo_id}")
    print(f"Path: {REPO_PATH}")
    print(f"Model: {EMBEDDING_MODEL}")
    print(f"Embedding Cache: enabled")
    print("=" * 60)

    # Initialize CocoIndex
    cocoindex.init()

    # The flow will be run by cocoindex CLI or we can trigger it
    # For now, we print instructions
    print()
    print("To run the indexing flow:")
    print("  cocoindex setup cocoindex_flow.py    # Setup tables (first time)")
    print("  cocoindex update cocoindex_flow.py   # Run indexing")
    print()

    # After flow completes, extract relationships
    # Note: This would typically be called after `cocoindex update` completes
    # relationships_count = export_relationships_to_postgres(database_url)

    result = {
        "status": "initialized",
        "repo_url": REPO_URL,
        "repo_id": repo_id,
        "branch": REPO_BRANCH,
        "embedding_model": EMBEDDING_MODEL,
    }

    print(f"\n__RESULT__:{json.dumps(result)}")
    return result


def print_cache_stats() -> None:
    """Print current embedding cache statistics."""
    stats = get_cache_stats()
    print("Embedding Cache Statistics:")
    print(f"  Cache hits: {stats.hits}")
    print(f"  Cache misses: {stats.misses}")
    print(f"  Total requests: {stats.total}")
    print(f"  Hit rate: {stats.hit_rate:.1%}")


def get_cache_table_stats(database_url: str) -> dict:
    """
    Get statistics about the embedding cache table.

    Args:
        database_url: PostgreSQL connection string

    Returns:
        Dictionary with cache table statistics
    """
    try:
        conn = psycopg.connect(database_url)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*) as total_entries,
                    COUNT(DISTINCT model_name) as models,
                    SUM(hit_count) as total_hits,
                    MIN(created_at) as oldest_entry,
                    MAX(last_used_at) as most_recent_use
                FROM embedding_cache
            """)
            row = cur.fetchone()
        conn.close()

        if row:
            return {
                "total_entries": row[0] or 0,
                "models": row[1] or 0,
                "total_hits": row[2] or 0,
                "oldest_entry": str(row[3]) if row[3] else None,
                "most_recent_use": str(row[4]) if row[4] else None,
            }
    except Exception as e:
        return {"error": str(e)}

    return {"total_entries": 0}


# Entry point for CLI usage
if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--extract-relationships":
        # Run relationship extraction only
        database_url = os.environ.get("COCOINDEX_DATABASE_URL")
        if not database_url:
            print("Error: COCOINDEX_DATABASE_URL required", file=sys.stderr)
            sys.exit(1)
        count = export_relationships_to_postgres(database_url)
        print(f"Extracted {count} relationships")
    elif len(sys.argv) > 1 and sys.argv[1] == "--cache-stats":
        # Print cache table statistics
        database_url = os.environ.get("COCOINDEX_DATABASE_URL")
        if not database_url:
            print("Error: COCOINDEX_DATABASE_URL required", file=sys.stderr)
            sys.exit(1)
        stats = get_cache_table_stats(database_url)
        print("Embedding Cache Table Statistics:")
        for key, value in stats.items():
            print(f"  {key}: {value}")
    else:
        # Run full indexing info
        run_full_indexing()
