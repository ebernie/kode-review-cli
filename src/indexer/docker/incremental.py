#!/usr/bin/env python3
"""
Incremental indexer for fast updates based on git diff.

This module provides incremental indexing capabilities that:
1. Use git diff to identify changed files since the last index
2. Only re-index changed files
3. Invalidate relationship entries when source files change
4. Update file metadata (last_modified) on change

Performance target: < 5s for typical PR with 10 changed files.

Environment variables:
- COCOINDEX_DATABASE_URL: PostgreSQL connection string
- REPO_URL: Repository URL for identification
- REPO_BRANCH: Branch being indexed
- REPO_PATH: Path to the repository (default: /repo)
- EMBEDDING_MODEL: Model to use (default: sentence-transformers/all-MiniLM-L6-v2)
- BASE_REF: Git reference to diff against (default: HEAD~1)
- CHANGED_FILES: Comma-separated list of changed files (alternative to git diff)
"""

import os
import sys
import hashlib
import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator, Optional

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer

# Import from the main indexer
from ast_chunker import chunk_code_ast, CodeChunk
from import_graph import build_and_store_import_graph


# =============================================================================
# Configuration
# =============================================================================

REPO_PATH = os.environ.get("REPO_PATH", "/repo")
REPO_URL = os.environ.get("REPO_URL", "")
REPO_BRANCH = os.environ.get("REPO_BRANCH", "main")
DATABASE_URL = os.environ["COCOINDEX_DATABASE_URL"]
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
BASE_REF = os.environ.get("BASE_REF", "HEAD~1")
CHANGED_FILES_ENV = os.environ.get("CHANGED_FILES", "")

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


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class IncrementalResult:
    """Result of incremental indexing operation."""
    status: str
    repo_url: str
    repo_id: str
    branch: str
    changed_files: int
    added_files: int
    modified_files: int
    deleted_files: int
    chunks_added: int
    chunks_removed: int
    relationships_invalidated: int
    cache_hits: int
    cache_misses: int
    elapsed_seconds: float
    error: Optional[str] = None


@dataclass
class FileChange:
    """Represents a changed file from git diff."""
    path: str
    change_type: str  # 'A' (added), 'M' (modified), 'D' (deleted), 'R' (renamed)
    old_path: Optional[str] = None  # For renamed files


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


# =============================================================================
# Helper Functions
# =============================================================================

def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


def compute_content_hash(content: str) -> str:
    """Compute SHA-256 hash of content for cache lookup."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def get_language_from_extension(ext: str) -> Optional[str]:
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


# =============================================================================
# Git Diff Detection
# =============================================================================

def get_changed_files_from_git(repo_path: str, base_ref: str) -> list[FileChange]:
    """
    Get list of changed files using git diff.

    Args:
        repo_path: Path to the git repository
        base_ref: Git reference to diff against (e.g., 'HEAD~1', 'main', commit SHA)

    Returns:
        List of FileChange objects representing changed files
    """
    try:
        # Use git diff with name-status to get change types
        result = subprocess.run(
            ["git", "diff", "--name-status", base_ref],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            print(f"Warning: git diff failed: {result.stderr}", file=sys.stderr)
            return []

        changes: list[FileChange] = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue

            parts = line.split("\t")
            if len(parts) < 2:
                continue

            change_type = parts[0][0]  # First character: A, M, D, R

            if change_type == "R":
                # Renamed file: R100 old_path new_path
                if len(parts) >= 3:
                    changes.append(FileChange(
                        path=parts[2],
                        change_type="R",
                        old_path=parts[1],
                    ))
            else:
                changes.append(FileChange(
                    path=parts[1],
                    change_type=change_type,
                ))

        return changes

    except subprocess.TimeoutExpired:
        print("Warning: git diff timed out", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Warning: Could not run git diff: {e}", file=sys.stderr)
        return []


def get_changed_files_from_env() -> list[FileChange]:
    """
    Get list of changed files from CHANGED_FILES environment variable.

    This is an alternative to git diff for cases where the changed files
    are known ahead of time (e.g., from a CI/CD pipeline).

    Format: comma-separated list of file paths with optional change type prefix.
    Examples:
        - "src/foo.ts,src/bar.ts" (assumes all modified)
        - "A:src/new.ts,M:src/changed.ts,D:src/deleted.ts"
    """
    if not CHANGED_FILES_ENV:
        return []

    changes: list[FileChange] = []
    for entry in CHANGED_FILES_ENV.split(","):
        entry = entry.strip()
        if not entry:
            continue

        if ":" in entry and len(entry.split(":")[0]) == 1:
            # Has change type prefix
            change_type, path = entry.split(":", 1)
            changes.append(FileChange(path=path, change_type=change_type.upper()))
        else:
            # No prefix, assume modified
            changes.append(FileChange(path=entry, change_type="M"))

    return changes


def detect_changed_files() -> list[FileChange]:
    """
    Detect changed files using available methods.

    Priority:
    1. CHANGED_FILES environment variable (explicit list)
    2. git diff against BASE_REF
    """
    # Try environment variable first
    env_changes = get_changed_files_from_env()
    if env_changes:
        print(f"Using {len(env_changes)} changed files from CHANGED_FILES env")
        return env_changes

    # Fall back to git diff
    git_changes = get_changed_files_from_git(REPO_PATH, BASE_REF)
    if git_changes:
        print(f"Detected {len(git_changes)} changed files via git diff against {BASE_REF}")
        return git_changes

    print("No changes detected")
    return []


# =============================================================================
# Database Operations
# =============================================================================

def lookup_cached_embeddings(
    conn: psycopg.Connection,
    content_hashes: list[str],
    model_name: str
) -> dict[str, list[float]]:
    """Look up cached embeddings by content hash."""
    if not content_hashes:
        return {}

    with conn.cursor() as cur:
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
        if embedding is not None:
            result[content_hash] = list(embedding)

    return result


def store_cached_embeddings(
    conn: psycopg.Connection,
    embeddings_to_cache: list[tuple[str, list[float], int]],
    model_name: str
) -> int:
    """Store embeddings in the cache."""
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
                print(f"Warning: Failed to cache embedding: {e}", file=sys.stderr)

        conn.commit()

    return stored


def delete_file_chunks(
    conn: psycopg.Connection,
    file_paths: list[str],
    repo_id: str,
    branch: str
) -> tuple[int, int]:
    """
    Delete chunks and invalidate relationships for specified files.

    Returns:
        Tuple of (chunks_deleted, relationships_invalidated)
    """
    if not file_paths:
        return 0, 0

    chunks_deleted = 0
    relationships_invalidated = 0

    with conn.cursor() as cur:
        # First, get the chunk IDs for the files we're deleting
        cur.execute(
            """
            SELECT id FROM chunks
            WHERE file_path = ANY(%s) AND repo_id = %s AND branch = %s
            """,
            (file_paths, repo_id, branch)
        )
        chunk_ids = [row[0] for row in cur.fetchall()]

        if chunk_ids:
            # Delete relationships involving these chunks
            cur.execute(
                """
                DELETE FROM relationships
                WHERE source_chunk_id = ANY(%s) OR target_chunk_id = ANY(%s)
                """,
                (chunk_ids, chunk_ids)
            )
            relationships_invalidated = cur.rowcount

        # Delete chunks for these files
        cur.execute(
            """
            DELETE FROM chunks
            WHERE file_path = ANY(%s) AND repo_id = %s AND branch = %s
            """,
            (file_paths, repo_id, branch)
        )
        chunks_deleted = cur.rowcount

        # Delete from legacy table too
        cur.execute(
            """
            DELETE FROM code_embeddings
            WHERE filename = ANY(%s) AND repo_id = %s AND branch = %s
            """,
            (file_paths, repo_id, branch)
        )

        conn.commit()

    return chunks_deleted, relationships_invalidated


def delete_file_metadata(
    conn: psycopg.Connection,
    file_paths: list[str],
    repo_id: str,
    branch: str
) -> int:
    """Delete file metadata for specified files."""
    if not file_paths:
        return 0

    with conn.cursor() as cur:
        # First delete from file_imports
        cur.execute(
            """
            DELETE FROM file_imports
            WHERE (source_file = ANY(%s) OR target_file = ANY(%s))
              AND repo_id = %s AND branch = %s
            """,
            (file_paths, file_paths, repo_id, branch)
        )

        # Then delete from files
        cur.execute(
            """
            DELETE FROM files
            WHERE file_path = ANY(%s) AND repo_id = %s AND branch = %s
            """,
            (file_paths, repo_id, branch)
        )
        deleted = cur.rowcount
        conn.commit()

    return deleted


def update_file_metadata(
    conn: psycopg.Connection,
    file_path: str,
    repo_id: str,
    repo_url: str,
    branch: str,
    language: Optional[str],
    size: int,
) -> None:
    """Insert or update file metadata."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO files (file_path, repo_id, repo_url, branch, language, size, last_modified)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (file_path) DO UPDATE SET
                repo_id = EXCLUDED.repo_id,
                repo_url = EXCLUDED.repo_url,
                branch = EXCLUDED.branch,
                language = EXCLUDED.language,
                size = EXCLUDED.size,
                last_modified = NOW(),
                updated_at = NOW()
            """,
            (file_path, repo_id, repo_url, branch, language, size)
        )
        conn.commit()


# =============================================================================
# Main Incremental Indexing Logic
# =============================================================================

def index_files_incrementally(
    conn: psycopg.Connection,
    files_to_index: list[Path],
    repo_id: str,
    repo_url: str,
    branch: str,
    model: Optional[SentenceTransformer],
) -> tuple[int, CacheStats]:
    """
    Index a list of files, using the embedding cache for efficiency.

    Returns:
        Tuple of (chunks_indexed, cache_stats)
    """
    cache_stats = CacheStats()
    chunks_indexed = 0

    all_chunks: list[CodeChunk] = []

    # Collect chunks from all files
    for file_path in files_to_index:
        try:
            rel_path = file_path.relative_to(REPO_PATH)
            content = file_path.read_text(encoding="utf-8", errors="ignore")

            if not content.strip():
                continue

            # Update file metadata
            ext = file_path.suffix.lower()
            language = get_language_from_extension(ext)
            update_file_metadata(
                conn, str(rel_path), repo_id, repo_url, branch, language, len(content)
            )

            # Chunk the content
            chunks = chunk_code_ast(content, str(rel_path))
            all_chunks.extend(chunks)

        except Exception as e:
            print(f"Warning: Could not process {file_path}: {e}", file=sys.stderr)

    if not all_chunks:
        return 0, cache_stats

    # Compute content hashes
    chunk_hashes = [compute_content_hash(chunk.code) for chunk in all_chunks]

    # Look up cached embeddings
    cached_embeddings = lookup_cached_embeddings(conn, chunk_hashes, EMBEDDING_MODEL)

    # Separate cached vs uncached chunks
    chunks_to_embed: list[tuple[int, CodeChunk]] = []
    all_embeddings: list[list[float]] = [[] for _ in all_chunks]

    for i, (chunk, content_hash) in enumerate(zip(all_chunks, chunk_hashes)):
        if content_hash in cached_embeddings:
            all_embeddings[i] = cached_embeddings[content_hash]
            cache_stats.hits += 1
        else:
            chunks_to_embed.append((i, chunk))
            cache_stats.misses += 1

    # Generate embeddings for cache misses
    embeddings_to_cache: list[tuple[str, list[float], int]] = []

    if chunks_to_embed and model is not None:
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

    # Store new embeddings in cache
    if embeddings_to_cache:
        store_cached_embeddings(conn, embeddings_to_cache, EMBEDDING_MODEL)

    # Insert chunks into database
    with conn.cursor() as cur:
        for chunk, embedding_list in zip(all_chunks, all_embeddings):
            if not embedding_list:
                continue

            # Legacy table
            legacy_embedding = embedding_list[:384] if len(embedding_list) >= 384 else embedding_list
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
                    repo_id, repo_url, branch, chunk.filename, chunk.location,
                    chunk.code, chunk.start_line, chunk.end_line, legacy_embedding
                )
            )

            # Get symbol info
            ext = Path(chunk.filename).suffix.lower()
            language = get_language_from_extension(ext)
            symbol_names = getattr(chunk, 'symbol_names', [])
            imports = getattr(chunk, 'imports', [])
            exports = getattr(chunk, 'exports', [])

            # New chunks table
            cur.execute(
                """
                INSERT INTO chunks
                (file_path, content, embedding, language, chunk_type, symbol_names,
                 line_start, line_end, imports, exports, repo_id, repo_url, branch)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    chunk.filename, chunk.code, embedding_list, language,
                    chunk.chunk_type, symbol_names, chunk.start_line, chunk.end_line,
                    imports, exports, repo_id, repo_url, branch,
                )
            )
            chunks_indexed += 1

        conn.commit()

    return chunks_indexed, cache_stats


def run_incremental_indexing() -> IncrementalResult:
    """
    Main entry point for incremental indexing.

    This function:
    1. Detects changed files using git diff or environment variable
    2. Removes old chunks for changed/deleted files
    3. Re-indexes added/modified files
    4. Updates the import graph
    """
    start_time = time.time()
    repo_id = generate_repo_id(REPO_URL)

    print(f"Starting incremental indexing...")
    print(f"  Repository: {REPO_URL}")
    print(f"  Branch: {REPO_BRANCH}")
    print(f"  Repo ID: {repo_id}")
    print(f"  Path: {REPO_PATH}")
    print(f"  Model: {EMBEDDING_MODEL}")

    # Detect changed files
    changes = detect_changed_files()

    if not changes:
        elapsed = time.time() - start_time
        return IncrementalResult(
            status="success",
            repo_url=REPO_URL,
            repo_id=repo_id,
            branch=REPO_BRANCH,
            changed_files=0,
            added_files=0,
            modified_files=0,
            deleted_files=0,
            chunks_added=0,
            chunks_removed=0,
            relationships_invalidated=0,
            cache_hits=0,
            cache_misses=0,
            elapsed_seconds=elapsed,
        )

    # Categorize changes
    added_files: list[str] = []
    modified_files: list[str] = []
    deleted_files: list[str] = []

    for change in changes:
        if change.change_type == "A":
            added_files.append(change.path)
        elif change.change_type == "M":
            modified_files.append(change.path)
        elif change.change_type == "D":
            deleted_files.append(change.path)
        elif change.change_type == "R":
            # Renamed: treat old path as deleted, new path as added
            if change.old_path:
                deleted_files.append(change.old_path)
            added_files.append(change.path)

    print(f"  Added: {len(added_files)}, Modified: {len(modified_files)}, Deleted: {len(deleted_files)}")

    # Filter to only include indexable files
    def filter_indexable(files: list[str]) -> list[str]:
        return [f for f in files if should_include_file(Path(f))]

    added_files = filter_indexable(added_files)
    modified_files = filter_indexable(modified_files)
    deleted_files = filter_indexable(deleted_files)

    files_to_reindex = added_files + modified_files
    files_to_delete = deleted_files + modified_files  # Modified files need their old chunks removed

    print(f"  Files to re-index: {len(files_to_reindex)}")
    print(f"  Files to clean up: {len(files_to_delete)}")

    # Connect to database
    print("Connecting to database...")
    conn = psycopg.connect(DATABASE_URL)
    register_vector(conn)

    # Ensure schema exists
    from migrate import run_migration
    run_migration(conn)

    chunks_removed = 0
    relationships_invalidated = 0

    # Delete old chunks for changed/deleted files
    if files_to_delete:
        print(f"Removing old chunks for {len(files_to_delete)} files...")
        chunks_removed, relationships_invalidated = delete_file_chunks(
            conn, files_to_delete, repo_id, REPO_BRANCH
        )
        print(f"  Removed {chunks_removed} chunks, invalidated {relationships_invalidated} relationships")

    # Delete file metadata for deleted files only
    if deleted_files:
        print(f"Removing metadata for {len(deleted_files)} deleted files...")
        delete_file_metadata(conn, deleted_files, repo_id, REPO_BRANCH)

    # Index new/modified files
    chunks_added = 0
    cache_stats = CacheStats()

    if files_to_reindex:
        print(f"Indexing {len(files_to_reindex)} files...")

        # Load model only if we have files to index
        model = None
        if files_to_reindex:
            print("Loading embedding model...")
            model = SentenceTransformer(EMBEDDING_MODEL)

        # Convert to Path objects
        file_paths = [Path(REPO_PATH) / f for f in files_to_reindex if (Path(REPO_PATH) / f).exists()]

        chunks_added, cache_stats = index_files_incrementally(
            conn, file_paths, repo_id, REPO_URL, REPO_BRANCH, model
        )

        print(f"  Indexed {chunks_added} chunks")
        print(f"  Cache hits: {cache_stats.hits}, misses: {cache_stats.misses}")

    # Rebuild import graph for changed files
    if files_to_reindex:
        print("Updating import graph...")
        try:
            import_stats = build_and_store_import_graph(conn, REPO_URL, REPO_BRANCH)
            print(f"  Import edges: {import_stats.get('edges', 0)}")
        except Exception as e:
            print(f"  Warning: Could not update import graph: {e}", file=sys.stderr)

    conn.close()

    elapsed = time.time() - start_time

    result = IncrementalResult(
        status="success",
        repo_url=REPO_URL,
        repo_id=repo_id,
        branch=REPO_BRANCH,
        changed_files=len(changes),
        added_files=len(added_files),
        modified_files=len(modified_files),
        deleted_files=len(deleted_files),
        chunks_added=chunks_added,
        chunks_removed=chunks_removed,
        relationships_invalidated=relationships_invalidated,
        cache_hits=cache_stats.hits,
        cache_misses=cache_stats.misses,
        elapsed_seconds=elapsed,
    )

    print(f"\nIncremental indexing complete in {elapsed:.2f}s")
    print(f"  Changed files: {result.changed_files}")
    print(f"  Chunks added: {result.chunks_added}")
    print(f"  Chunks removed: {result.chunks_removed}")
    print(f"  Relationships invalidated: {result.relationships_invalidated}")
    print(f"  Cache hit rate: {cache_stats.hit_rate:.1%}")

    return result


if __name__ == "__main__":
    try:
        result = run_incremental_indexing()

        # Output result as JSON for CLI to parse
        result_dict = {
            "status": result.status,
            "repo_url": result.repo_url,
            "repo_id": result.repo_id,
            "branch": result.branch,
            "changed_files": result.changed_files,
            "added_files": result.added_files,
            "modified_files": result.modified_files,
            "deleted_files": result.deleted_files,
            "chunks_added": result.chunks_added,
            "chunks_removed": result.chunks_removed,
            "relationships_invalidated": result.relationships_invalidated,
            "cache_hits": result.cache_hits,
            "cache_misses": result.cache_misses,
            "elapsed_seconds": round(result.elapsed_seconds, 2),
        }

        print(f"\n__RESULT__:{json.dumps(result_dict)}")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        result = {"status": "error", "error": str(e)}
        print(f"\n__RESULT__:{json.dumps(result)}")
        sys.exit(1)
