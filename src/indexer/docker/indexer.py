#!/usr/bin/env python3
"""
Standalone indexer for ephemeral container execution.

This script:
1. Reads source files from /repo (mounted volume)
2. Chunks the code using AST-based function/class boundary detection
3. Generates embeddings using sentence-transformers
4. Writes directly to PostgreSQL

Environment variables:
- COCOINDEX_DATABASE_URL: PostgreSQL connection string
- REPO_URL: Repository URL for identification
- REPO_BRANCH: Branch being indexed
- EMBEDDING_MODEL: Model to use (default: sentence-transformers/all-MiniLM-L6-v2)
- CHUNK_SIZE: Maximum chunk size (default: 1000) - used for fallback
- CHUNK_OVERLAP: Overlap between chunks (default: 300) - used for fallback
- NESTED_FUNCTION_THRESHOLD: Size threshold for separating nested functions (default: 50)
- FALLBACK_MAX_LINES: Max lines per chunk in fallback mode (default: 500)
"""

import os
import sys
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Generator

import numpy as np
import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

# Import AST-based chunking
from ast_chunker import chunk_code_ast, CodeChunk
from import_graph import build_and_store_import_graph


# =============================================================================
# Embedding Cache
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


def compute_content_hash(content: str) -> str:
    """
    Compute SHA-256 hash of content for cache lookup.

    Args:
        content: The text content to hash

    Returns:
        Hexadecimal SHA-256 hash string
    """
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def lookup_cached_embeddings(
    conn: psycopg.Connection,
    content_hashes: list[str],
    model_name: str
) -> dict[str, list[float]]:
    """
    Look up cached embeddings by content hash.

    Args:
        conn: Database connection
        content_hashes: List of SHA-256 content hashes to look up
        model_name: The embedding model name

    Returns:
        Dictionary mapping content_hash -> embedding (as list of floats)
    """
    if not content_hashes:
        return {}

    with conn.cursor() as cur:
        # Batch lookup for efficiency
        cur.execute(
            """
            UPDATE embedding_cache
            SET last_used_at = NOW(), hit_count = hit_count + 1
            WHERE content_hash = ANY(%s) AND model_name = %s
            RETURNING content_hash, embedding
            """,
            (content_hashes, model_name)
        )
        rows = cur.fetchall()
        conn.commit()

    result: dict[str, list[float]] = {}
    for content_hash, embedding in rows:
        # Convert pgvector array to list
        if embedding is not None:
            result[content_hash] = list(embedding)

    return result


def store_cached_embeddings(
    conn: psycopg.Connection,
    embeddings_to_cache: list[tuple[str, list[float], int]],
    model_name: str
) -> int:
    """
    Store embeddings in the cache.

    Args:
        conn: Database connection
        embeddings_to_cache: List of (content_hash, embedding, original_dim) tuples
        model_name: The embedding model name

    Returns:
        Number of embeddings stored
    """
    if not embeddings_to_cache:
        return 0

    stored = 0
    with conn.cursor() as cur:
        for content_hash, embedding, original_dim in embeddings_to_cache:
            try:
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
                stored += 1
            except Exception as e:
                print(f"  Warning: Failed to cache embedding for {content_hash[:8]}...: {e}", file=sys.stderr)

        conn.commit()

    return stored


# Configuration from environment
REPO_PATH = os.environ.get("REPO_PATH", "/repo")
REPO_URL = os.environ.get("REPO_URL", "")
REPO_BRANCH = os.environ.get("REPO_BRANCH", "main")
DATABASE_URL = os.environ["COCOINDEX_DATABASE_URL"]
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "1000"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "300"))

# File patterns to include
INCLUDE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx",
    ".py", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp",
    ".rb", ".php", ".cs", ".md"
}

# Directories to exclude
EXCLUDE_DIRS = {
    "node_modules", "dist", "build", ".git", "target",
    "__pycache__", "venv", ".venv", "vendor", ".next",
    "coverage", ".nyc_output", ".pytest_cache"
}


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


# Mapping of file extensions to language names
EXTENSION_TO_LANGUAGE = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".md": "markdown",
}


def _get_language_from_extension(ext: str) -> str | None:
    """Get the programming language from a file extension."""
    return EXTENSION_TO_LANGUAGE.get(ext.lower())


def should_include_file(path: Path) -> bool:
    """Check if a file should be included in indexing."""
    # Check extension
    if path.suffix.lower() not in INCLUDE_EXTENSIONS:
        return False

    # Check for excluded directories in path
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return False

    return True


def find_files(repo_path: str) -> Generator[Path, None, None]:
    """Find all source files to index."""
    root = Path(repo_path)

    for path in root.rglob("*"):
        if path.is_file() and should_include_file(path):
            yield path


def chunk_code(content: str, filename: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[CodeChunk]:
    """
    Split code into semantically coherent chunks using AST-based boundary detection.

    Uses tree-sitter to identify function/class boundaries and never splits
    a function across chunks. Falls back to line-based chunking for
    non-parseable files.

    The chunk_size and overlap parameters are kept for backward compatibility
    but are primarily used in the fallback line-based chunking.
    """
    return chunk_code_ast(content, filename)


def ensure_table_exists(conn: psycopg.Connection) -> None:
    """Create the embeddings table if it doesn't exist.

    This runs the full schema migration which creates:
    - files table: file metadata and tracking
    - chunks table: code chunks with embeddings and rich metadata
    - relationships table: links between chunks (imports, calls, etc.)
    - code_embeddings table: legacy table for backward compatibility
    """
    from migrate import run_migration
    run_migration(conn)


def delete_existing_index(conn: psycopg.Connection, repo_id: str, branch: str) -> int:
    """Delete existing index for this repo/branch before re-indexing."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM code_embeddings WHERE repo_id = %s AND branch = %s",
            (repo_id, branch)
        )
        deleted = cur.rowcount
        conn.commit()
        return deleted


def index_repository() -> dict:
    """Main indexing function with embedding cache support."""
    repo_id = generate_repo_id(REPO_URL)

    print(f"Starting indexing...")
    print(f"  Repository: {REPO_URL}")
    print(f"  Branch: {REPO_BRANCH}")
    print(f"  Repo ID: {repo_id}")
    print(f"  Path: {REPO_PATH}")
    print(f"  Model: {EMBEDDING_MODEL}")

    # Connect to database first (needed for cache lookup)
    print("Connecting to database...")
    conn = psycopg.connect(DATABASE_URL)
    register_vector(conn)

    # Ensure table exists (including embedding_cache table)
    ensure_table_exists(conn)

    # Delete existing index for this repo/branch
    deleted = delete_existing_index(conn, repo_id, REPO_BRANCH)
    if deleted > 0:
        print(f"Deleted {deleted} existing chunks for {REPO_URL}@{REPO_BRANCH}")

    # Find and process files
    files_processed = 0
    chunks_indexed = 0

    # Collect all chunks first for batch embedding
    all_chunks: list[CodeChunk] = []

    print("Scanning files...")
    for file_path in find_files(REPO_PATH):
        try:
            # Get relative path from repo root
            rel_path = file_path.relative_to(REPO_PATH)

            # Read file content
            content = file_path.read_text(encoding="utf-8", errors="ignore")

            if not content.strip():
                continue

            # Chunk the content
            chunks = chunk_code(content, str(rel_path))
            all_chunks.extend(chunks)
            files_processed += 1

            if files_processed % 50 == 0:
                print(f"  Scanned {files_processed} files, {len(all_chunks)} chunks...")

        except Exception as e:
            print(f"  Warning: Could not process {file_path}: {e}", file=sys.stderr)

    print(f"Found {len(all_chunks)} chunks from {files_processed} files")

    if not all_chunks:
        print("No content to index")
        conn.close()
        return {"files": 0, "chunks": 0}

    # Compute content hashes for all chunks
    print("Computing content hashes...")
    chunk_hashes = [compute_content_hash(chunk.code) for chunk in all_chunks]

    # Look up cached embeddings
    print("Checking embedding cache...")
    cached_embeddings = lookup_cached_embeddings(conn, chunk_hashes, EMBEDDING_MODEL)

    # Track cache statistics
    cache_stats = CacheStats()

    # Identify chunks that need new embeddings
    chunks_to_embed: list[tuple[int, CodeChunk]] = []  # (index, chunk)
    all_embeddings: list[list[float]] = [[] for _ in all_chunks]  # Pre-allocate

    for i, (chunk, content_hash) in enumerate(zip(all_chunks, chunk_hashes)):
        if content_hash in cached_embeddings:
            # Cache hit - use cached embedding
            all_embeddings[i] = cached_embeddings[content_hash]
            cache_stats.hits += 1
        else:
            # Cache miss - need to generate embedding
            chunks_to_embed.append((i, chunk))
            cache_stats.misses += 1

    print(f"  Cache hits: {cache_stats.hits}, misses: {cache_stats.misses}")
    print(f"  Cache hit rate: {cache_stats.hit_rate:.1%}")

    # Generate embeddings for cache misses
    model = None
    embeddings_to_cache: list[tuple[str, list[float], int]] = []

    if chunks_to_embed:
        print(f"Generating embeddings for {len(chunks_to_embed)} uncached chunks...")
        print("Loading embedding model...")
        model = SentenceTransformer(EMBEDDING_MODEL)

        batch_size = 64
        for batch_start in range(0, len(chunks_to_embed), batch_size):
            batch = chunks_to_embed[batch_start:batch_start + batch_size]
            texts = [chunk.code for _, chunk in batch]

            embeddings = model.encode(texts, show_progress_bar=False)

            for j, (original_idx, chunk) in enumerate(batch):
                embedding = embeddings[j]
                embedding_list = embedding.tolist()
                original_dim = len(embedding_list)

                # Pad to 1536 dimensions if needed
                if len(embedding_list) < 1536:
                    embedding_list = embedding_list + [0.0] * (1536 - len(embedding_list))

                all_embeddings[original_idx] = embedding_list

                # Queue for caching
                content_hash = chunk_hashes[original_idx]
                embeddings_to_cache.append((content_hash, embedding_list, original_dim))

            if (batch_start + batch_size) % 256 == 0:
                print(f"  Generated embeddings for {min(batch_start + batch_size, len(chunks_to_embed))}/{len(chunks_to_embed)} chunks...")

        # Store new embeddings in cache
        if embeddings_to_cache:
            print(f"Caching {len(embeddings_to_cache)} new embeddings...")
            cached_count = store_cached_embeddings(conn, embeddings_to_cache, EMBEDDING_MODEL)
            print(f"  Cached {cached_count} embeddings")
    else:
        print("All embeddings retrieved from cache - skipping model load")

    # Insert into database
    print("Writing to database...")
    with conn.cursor() as cur:
        for chunk, embedding_list in zip(all_chunks, all_embeddings):
            # Embeddings are already lists (from cache or newly generated)
            # For legacy table, use only first 384 dimensions
            legacy_embedding = embedding_list[:384] if len(embedding_list) >= 384 else embedding_list

            # Insert into legacy code_embeddings table for backward compatibility
            cur.execute(
                """
                INSERT INTO code_embeddings
                (repo_id, repo_url, branch, filename, location, code, start_line, end_line, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (repo_id, branch, filename, location)
                DO UPDATE SET
                    code = EXCLUDED.code,
                    start_line = EXCLUDED.start_line,
                    end_line = EXCLUDED.end_line,
                    embedding = EXCLUDED.embedding
                """,
                (
                    repo_id,
                    REPO_URL,
                    REPO_BRANCH,
                    chunk.filename,
                    chunk.location,
                    chunk.code,
                    chunk.start_line,
                    chunk.end_line,
                    legacy_embedding
                )
            )

            # Also insert into the new chunks table with full metadata
            # First, ensure the file exists in the files table
            ext = Path(chunk.filename).suffix.lower()
            language = _get_language_from_extension(ext)

            cur.execute(
                """
                INSERT INTO files (file_path, repo_id, repo_url, branch, language)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (file_path) DO UPDATE SET
                    repo_id = EXCLUDED.repo_id,
                    repo_url = EXCLUDED.repo_url,
                    branch = EXCLUDED.branch,
                    language = EXCLUDED.language,
                    updated_at = NOW()
                """,
                (chunk.filename, repo_id, REPO_URL, REPO_BRANCH, language)
            )

            # Now insert the chunk with all metadata
            # Get symbol_names, imports, exports from the chunk (with defaults for backward compat)
            symbol_names = getattr(chunk, 'symbol_names', [])
            imports = getattr(chunk, 'imports', [])
            exports = getattr(chunk, 'exports', [])

            # embedding_list is already padded to 1536 dimensions from cache or generation
            cur.execute(
                """
                INSERT INTO chunks
                (file_path, content, embedding, language, chunk_type, symbol_names,
                 line_start, line_end, imports, exports, repo_id, repo_url, branch)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    chunk.filename,
                    chunk.code,
                    embedding_list,
                    language,
                    chunk.chunk_type,
                    symbol_names,
                    chunk.start_line,
                    chunk.end_line,
                    imports,
                    exports,
                    repo_id,
                    REPO_URL,
                    REPO_BRANCH,
                )
            )
            chunks_indexed += 1

        conn.commit()

    # Build import graph after indexing
    print("Building import graph...")
    try:
        import_stats = build_and_store_import_graph(conn, REPO_URL, REPO_BRANCH)
        print(f"  Import edges: {import_stats['edges']}")
        print(f"  Circular dependencies: {import_stats['circular_dependencies']}")
        print(f"  Hub files (>10 imports): {import_stats['hub_files']}")
    except Exception as e:
        print(f"  Warning: Could not build import graph: {e}")
        import_stats = {"edges": 0, "circular_dependencies": 0, "hub_files": 0}

    conn.close()

    print(f"Indexing complete!")
    print(f"  Files: {files_processed}")
    print(f"  Chunks: {chunks_indexed}")
    print(f"  Cache hits: {cache_stats.hits}")
    print(f"  Cache misses: {cache_stats.misses}")
    print(f"  Cache hit rate: {cache_stats.hit_rate:.1%}")

    # Output result as JSON for CLI to parse
    result = {
        "status": "success",
        "repo_url": REPO_URL,
        "repo_id": repo_id,
        "branch": REPO_BRANCH,
        "files": files_processed,
        "chunks": chunks_indexed,
        "import_edges": import_stats.get("edges", 0),
        "circular_dependencies": import_stats.get("circular_dependencies", 0),
        "hub_files": import_stats.get("hub_files", 0),
        "cache_hits": cache_stats.hits,
        "cache_misses": cache_stats.misses,
        "cache_hit_rate": round(cache_stats.hit_rate, 4),
    }

    print(f"\n__RESULT__:{json.dumps(result)}")

    return result


if __name__ == "__main__":
    try:
        index_repository()
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        result = {"status": "error", "error": str(e)}
        print(f"\n__RESULT__:{json.dumps(result)}")
        sys.exit(1)
