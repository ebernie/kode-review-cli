#!/usr/bin/env python3
"""
Standalone indexer for ephemeral container execution.

This script:
1. Reads source files from /repo (mounted volume)
2. Chunks the code using language-aware splitting
3. Generates embeddings using sentence-transformers
4. Writes directly to PostgreSQL

Environment variables:
- COCOINDEX_DATABASE_URL: PostgreSQL connection string
- REPO_URL: Repository URL for identification
- REPO_BRANCH: Branch being indexed
- EMBEDDING_MODEL: Model to use (default: sentence-transformers/all-MiniLM-L6-v2)
- CHUNK_SIZE: Maximum chunk size (default: 1000)
- CHUNK_OVERLAP: Overlap between chunks (default: 300)
"""

import os
import sys
import hashlib
import json
from pathlib import Path
from typing import Generator
from dataclasses import dataclass

import psycopg
from pgvector.psycopg import register_vector
from sentence_transformers import SentenceTransformer


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


@dataclass
class CodeChunk:
    """A chunk of code with metadata."""
    filename: str
    location: str
    code: str
    start_line: int
    end_line: int


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
    """Split code into overlapping chunks."""
    lines = content.split("\n")
    chunks = []

    if not lines:
        return chunks

    current_chunk_lines = []
    current_start = 1
    current_size = 0

    for i, line in enumerate(lines, 1):
        line_size = len(line) + 1  # +1 for newline

        if current_size + line_size > chunk_size and current_chunk_lines:
            # Save current chunk
            chunk_text = "\n".join(current_chunk_lines)
            chunks.append(CodeChunk(
                filename=filename,
                location=f"{current_start}-{i-1}",
                code=chunk_text,
                start_line=current_start,
                end_line=i - 1
            ))

            # Calculate overlap - keep last N characters worth of lines
            overlap_lines = []
            overlap_size = 0
            for prev_line in reversed(current_chunk_lines):
                if overlap_size + len(prev_line) + 1 > overlap:
                    break
                overlap_lines.insert(0, prev_line)
                overlap_size += len(prev_line) + 1

            current_chunk_lines = overlap_lines
            current_start = i - len(overlap_lines)
            current_size = overlap_size

        current_chunk_lines.append(line)
        current_size += line_size

    # Don't forget the last chunk
    if current_chunk_lines:
        chunk_text = "\n".join(current_chunk_lines)
        chunks.append(CodeChunk(
            filename=filename,
            location=f"{current_start}-{len(lines)}",
            code=chunk_text,
            start_line=current_start,
            end_line=len(lines)
        ))

    return chunks


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
    """Main indexing function."""
    repo_id = generate_repo_id(REPO_URL)

    print(f"Starting indexing...")
    print(f"  Repository: {REPO_URL}")
    print(f"  Branch: {REPO_BRANCH}")
    print(f"  Repo ID: {repo_id}")
    print(f"  Path: {REPO_PATH}")
    print(f"  Model: {EMBEDDING_MODEL}")

    # Load embedding model
    print("Loading embedding model...")
    model = SentenceTransformer(EMBEDDING_MODEL)

    # Connect to database
    print("Connecting to database...")
    conn = psycopg.connect(DATABASE_URL)
    register_vector(conn)

    # Ensure table exists
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

    # Generate embeddings in batches
    print("Generating embeddings...")
    batch_size = 64
    all_embeddings = []

    for i in range(0, len(all_chunks), batch_size):
        batch = all_chunks[i:i + batch_size]
        texts = [chunk.code for chunk in batch]
        embeddings = model.encode(texts, show_progress_bar=False)
        all_embeddings.extend(embeddings)

        if (i + batch_size) % 256 == 0:
            print(f"  Generated embeddings for {min(i + batch_size, len(all_chunks))}/{len(all_chunks)} chunks...")

    # Insert into database
    print("Writing to database...")
    with conn.cursor() as cur:
        for chunk, embedding in zip(all_chunks, all_embeddings):
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
                    embedding.tolist()
                )
            )
            chunks_indexed += 1

        conn.commit()

    conn.close()

    print(f"Indexing complete!")
    print(f"  Files: {files_processed}")
    print(f"  Chunks: {chunks_indexed}")

    # Output result as JSON for CLI to parse
    result = {
        "status": "success",
        "repo_url": REPO_URL,
        "repo_id": repo_id,
        "branch": REPO_BRANCH,
        "files": files_processed,
        "chunks": chunks_indexed
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
