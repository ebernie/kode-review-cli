"""
Code indexer API server for kode-review-cli.

This API provides:
- Semantic code search using vector similarity
- Statistics about indexed repositories
- Repository listing
- Index deletion

Note: Indexing is handled by ephemeral containers running indexer.py.
This server stays running and handles queries only.
"""

import os
import functools
import hashlib
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pydantic_settings import BaseSettings
from sentence_transformers import SentenceTransformer
from psycopg_pool import ConnectionPool
from pgvector.psycopg import register_vector


class Settings(BaseSettings):
    """Application settings from environment variables."""
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    class Config:
        env_prefix = ""


settings = Settings()


def generate_repo_id(repo_url: str) -> str:
    """Generate a short unique identifier for a repository URL."""
    return hashlib.sha256(repo_url.encode()).hexdigest()[:16]


# -----------------------------------------------------------------------------
# Database and Embedding Model
# -----------------------------------------------------------------------------

@functools.cache
def get_connection_pool() -> ConnectionPool:
    """Get or create database connection pool."""
    pool = ConnectionPool(os.environ["COCOINDEX_DATABASE_URL"])
    return pool


@functools.cache
def get_embedding_model() -> SentenceTransformer:
    """Get or create embedding model (cached)."""
    print(f"Loading embedding model: {settings.embedding_model}")
    return SentenceTransformer(settings.embedding_model)


def compute_embedding(text: str) -> list[float]:
    """Compute embedding for a text query."""
    model = get_embedding_model()
    embedding = model.encode(text)
    return embedding.tolist()


# -----------------------------------------------------------------------------
# FastAPI Application
# -----------------------------------------------------------------------------

app = FastAPI(title="kode-review Indexer API", version="2.0.0")


# Request/Response Models

class SearchRequest(BaseModel):
    """Request to search the index."""
    query: str
    repo_url: Optional[str] = None  # Optional for cross-repo search
    branch: Optional[str] = None    # Optional branch filter
    limit: int = 5


class CodeChunk(BaseModel):
    """A chunk of code from the index."""
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    filename: str
    code: str
    score: float
    start_line: int
    end_line: int


class SearchResponse(BaseModel):
    """Response from a search request."""
    query: str
    chunks: list[CodeChunk]


class IndexStats(BaseModel):
    """Statistics about an indexed repository."""
    repo_url: str
    repo_id: str
    branch: str
    chunk_count: int
    file_count: int
    last_indexed: Optional[str]
    status: str


class RepoInfo(BaseModel):
    """Information about an indexed repository."""
    repo_url: str
    repo_id: str
    branches: list[str]
    total_chunks: int
    total_files: int


class ReposResponse(BaseModel):
    """Response listing all indexed repositories."""
    repos: list[RepoInfo]


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    database: str
    embedding_model: str


# Endpoints

@app.on_event("startup")
async def startup_event():
    """Initialize on application startup."""
    load_dotenv()

    # Run schema migration to ensure tables exist
    print("Running schema migration...")
    try:
        from migrate import ensure_schema
        ensure_schema()
    except Exception as e:
        print(f"Warning: Could not run migration: {e}")
        print("Tables may need to be created manually or by the indexer")

    # Pre-load the embedding model
    print("Pre-loading embedding model...")
    get_embedding_model()
    print("API server ready")


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    db_status = "unknown"
    try:
        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                db_status = "connected"
    except Exception as e:
        db_status = f"error: {e}"

    return HealthResponse(
        status="healthy" if db_status == "connected" else "degraded",
        database=db_status,
        embedding_model=settings.embedding_model,
    )


@app.post("/search", response_model=SearchResponse)
async def search(request: SearchRequest):
    """Search the index for similar code."""
    try:
        # Compute query embedding
        query_embedding = compute_embedding(request.query)

        # Build WHERE clause based on filters
        where_conditions = []
        where_params: list = []

        if request.repo_url:
            repo_id = generate_repo_id(request.repo_url)
            where_conditions.append("repo_id = %s")
            where_params.append(repo_id)

        if request.branch:
            where_conditions.append("branch = %s")
            where_params.append(request.branch)

        where_clause = ""
        if where_conditions:
            where_clause = "WHERE " + " AND ".join(where_conditions)

        # Build params in SQL order: score embedding, WHERE params, ORDER BY embedding, LIMIT
        params: list = [query_embedding] + where_params + [query_embedding, request.limit]

        # Execute similarity search
        with get_connection_pool().connection() as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT repo_url, branch, filename, code, start_line, end_line,
                           1 - (embedding <=> %s::vector) AS score
                    FROM code_embeddings
                    {where_clause}
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                    """,
                    tuple(params)
                )

                chunks = []
                for row in cur.fetchall():
                    chunks.append(CodeChunk(
                        repo_url=row[0],
                        branch=row[1],
                        filename=row[2],
                        code=row[3],
                        start_line=row[4],
                        end_line=row[5],
                        score=float(row[6]) if row[6] else 0.0,
                    ))

                return SearchResponse(query=request.query, chunks=chunks)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats", response_model=IndexStats)
async def get_stats(repo_url: str, branch: Optional[str] = None):
    """Get statistics for an indexed repository and optional branch."""
    effective_branch = branch or "main"
    repo_id = generate_repo_id(repo_url)

    # Query database for counts
    chunk_count = 0
    file_count = 0

    try:
        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COUNT(*), COUNT(DISTINCT filename)
                    FROM code_embeddings
                    WHERE repo_id = %s AND branch = %s
                    """,
                    (repo_id, effective_branch)
                )
                result = cur.fetchone()
                chunk_count = result[0] if result else 0
                file_count = result[1] if result else 0
    except Exception:
        pass

    status = "indexed" if chunk_count > 0 else "not_indexed"

    return IndexStats(
        repo_url=repo_url,
        repo_id=repo_id,
        branch=effective_branch,
        chunk_count=chunk_count,
        file_count=file_count,
        last_indexed=None,  # We don't track this currently
        status=status,
    )


@app.delete("/index/{repo_url:path}")
async def delete_index(repo_url: str, branch: Optional[str] = None):
    """Delete the index for a repository."""
    try:
        repo_id = generate_repo_id(repo_url)

        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                if branch:
                    # Delete only specific branch
                    cur.execute(
                        "DELETE FROM code_embeddings WHERE repo_id = %s AND branch = %s",
                        (repo_id, branch)
                    )
                    deleted_count = cur.rowcount
                    conn.commit()

                    return {
                        "message": f"Index deleted for {repo_url}@{branch}",
                        "deleted_chunks": deleted_count
                    }
                else:
                    # Delete all branches for this repo
                    cur.execute(
                        "DELETE FROM code_embeddings WHERE repo_id = %s",
                        (repo_id,)
                    )
                    deleted_count = cur.rowcount
                    conn.commit()

                    return {
                        "message": f"Index deleted for {repo_url} (all branches)",
                        "deleted_chunks": deleted_count
                    }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/repos", response_model=ReposResponse)
async def list_repos():
    """List all indexed repositories with their branches and stats."""
    try:
        repos_map: dict[str, dict] = {}

        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                # Get aggregated stats per repo/branch
                cur.execute(
                    """
                    SELECT repo_id, repo_url, branch,
                           COUNT(*) as chunk_count,
                           COUNT(DISTINCT filename) as file_count
                    FROM code_embeddings
                    GROUP BY repo_id, repo_url, branch
                    ORDER BY repo_url, branch
                    """
                )

                for row in cur.fetchall():
                    repo_id, repo_url, branch, chunk_count, file_count = row

                    if repo_url not in repos_map:
                        repos_map[repo_url] = {
                            "repo_id": repo_id,
                            "repo_url": repo_url,
                            "branches": [],
                            "total_chunks": 0,
                            "total_files": 0,
                        }

                    repos_map[repo_url]["branches"].append(branch)
                    repos_map[repo_url]["total_chunks"] += chunk_count
                    repos_map[repo_url]["total_files"] += file_count

        repos = [
            RepoInfo(
                repo_url=data["repo_url"],
                repo_id=data["repo_id"],
                branches=data["branches"],
                total_chunks=data["total_chunks"],
                total_files=data["total_files"],
            )
            for data in repos_map.values()
        ]

        return ReposResponse(repos=repos)

    except Exception as e:
        # If table doesn't exist yet, return empty list
        if "does not exist" in str(e).lower():
            return ReposResponse(repos=[])
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
