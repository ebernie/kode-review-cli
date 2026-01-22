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

from import_graph import ImportGraphBuilder, generate_repo_id as graph_generate_repo_id


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


class DefinitionLocation(BaseModel):
    """A location where a symbol is defined."""
    file_path: str
    line_start: int
    line_end: int
    content: str
    chunk_type: Optional[str] = None
    is_reexport: bool = False
    reexport_source: Optional[str] = None


class DefinitionResponse(BaseModel):
    """Response from a symbol definition lookup."""
    symbol: str
    definitions: list[DefinitionLocation]
    total_count: int


class UsageLocation(BaseModel):
    """A location where a symbol is used (called, imported, or referenced)."""
    file_path: str
    line_start: int
    line_end: int
    content: str
    chunk_type: Optional[str] = None
    usage_type: str  # 'calls', 'imports', or 'references'
    is_dynamic: bool = False  # Flag for dynamic imports/lazy loading


class UsageResponse(BaseModel):
    """Response from a symbol usage lookup."""
    symbol: str
    usages: list[UsageLocation]
    total_count: int


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    database: str
    embedding_model: str


# Import Chain Tracking Models

class ImportTreeResponse(BaseModel):
    """2-level import tree for a file."""
    target_file: str
    direct_imports: list[str]  # What this file imports
    direct_importers: list[str]  # What imports this file
    indirect_imports: list[str]  # What direct imports import (level 2)
    indirect_importers: list[str]  # What imports direct importers (level 2)


class CircularDependencyInfo(BaseModel):
    """Information about a circular dependency."""
    cycle: list[str]  # Files in the cycle, in order
    cycle_type: str  # 'direct' (A->B->A) or 'indirect' (A->B->C->A)


class CircularDependenciesResponse(BaseModel):
    """Response listing circular dependencies in the codebase."""
    repo_url: str
    branch: str
    circular_dependencies: list[CircularDependencyInfo]
    total_count: int


class HubFileInfo(BaseModel):
    """Information about a hub file (imported by many others)."""
    file_path: str
    import_count: int  # Number of files that import this file
    importers: list[str]  # Sample of importing files (up to 10)


class HubFilesResponse(BaseModel):
    """Response listing hub files in the codebase."""
    repo_url: str
    branch: str
    hub_files: list[HubFileInfo]
    total_count: int
    threshold: int  # The threshold used for hub detection


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


@app.get("/definitions/{symbol}", response_model=DefinitionResponse)
async def get_definitions(
    symbol: str,
    repo_url: Optional[str] = None,
    branch: Optional[str] = None,
    include_reexports: bool = True,
    limit: int = 20,
):
    """
    Look up where a symbol is defined in the indexed codebase.

    This endpoint helps catch breaking changes by finding all locations where
    a symbol (function, class, variable, etc.) is defined or re-exported.

    Args:
        symbol: The symbol name to look up (e.g., 'MyClass', 'handleRequest')
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search
        include_reexports: Whether to follow import chains for re-exports (default: True)
        limit: Maximum number of results to return (default: 20)

    Returns:
        DefinitionResponse with all locations where the symbol is defined or re-exported
    """
    try:
        definitions: list[DefinitionLocation] = []

        # Build WHERE clause for filtering
        where_conditions = ["symbol_names @> ARRAY[%s]::text[]"]
        where_params: list = [symbol]

        if repo_url:
            repo_id = generate_repo_id(repo_url)
            where_conditions.append("repo_id = %s")
            where_params.append(repo_id)

        if branch:
            where_conditions.append("branch = %s")
            where_params.append(branch)

        where_clause = " AND ".join(where_conditions)

        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                # Query for direct definitions
                cur.execute(
                    f"""
                    SELECT file_path, line_start, line_end, content, chunk_type, id
                    FROM chunks
                    WHERE {where_clause}
                    ORDER BY file_path, line_start
                    LIMIT %s
                    """,
                    tuple(where_params + [limit])
                )

                direct_chunk_ids = []
                for row in cur.fetchall():
                    definitions.append(DefinitionLocation(
                        file_path=row[0],
                        line_start=row[1],
                        line_end=row[2],
                        content=row[3],
                        chunk_type=row[4],
                        is_reexport=False,
                        reexport_source=None,
                    ))
                    direct_chunk_ids.append(row[5])

                # If we want re-exports, follow the relationship chain
                if include_reexports and direct_chunk_ids:
                    # Find chunks that import from the chunks containing this symbol
                    # This catches re-exports like: export { MyClass } from './source'
                    placeholders = ",".join(["%s"] * len(direct_chunk_ids))
                    reexport_query_params: list = direct_chunk_ids.copy()

                    # Add repo/branch filters if specified
                    reexport_where = ""
                    if repo_url:
                        reexport_where += " AND c.repo_id = %s"
                        reexport_query_params.append(repo_id)
                    if branch:
                        reexport_where += " AND c.branch = %s"
                        reexport_query_params.append(branch)

                    # Calculate remaining limit for re-exports
                    remaining_limit = limit - len(definitions)
                    if remaining_limit > 0:
                        reexport_query_params.append(remaining_limit)

                        cur.execute(
                            f"""
                            SELECT c.file_path, c.line_start, c.line_end, c.content, c.chunk_type,
                                   src.file_path as source_file
                            FROM chunks c
                            JOIN relationships r ON r.source_chunk_id = c.id
                            JOIN chunks src ON src.id = r.target_chunk_id
                            WHERE r.target_chunk_id IN ({placeholders})
                              AND r.relationship_type IN ('imports', 'references')
                              AND c.exports @> ARRAY[%s]::text[]
                              {reexport_where}
                            ORDER BY c.file_path, c.line_start
                            LIMIT %s
                            """,
                            tuple(reexport_query_params[:len(direct_chunk_ids)] +
                                  [symbol] +
                                  reexport_query_params[len(direct_chunk_ids):])
                        )

                        for row in cur.fetchall():
                            definitions.append(DefinitionLocation(
                                file_path=row[0],
                                line_start=row[1],
                                line_end=row[2],
                                content=row[3],
                                chunk_type=row[4],
                                is_reexport=True,
                                reexport_source=row[5],
                            ))

        return DefinitionResponse(
            symbol=symbol,
            definitions=definitions,
            total_count=len(definitions),
        )

    except Exception as e:
        # If tables don't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return DefinitionResponse(symbol=symbol, definitions=[], total_count=0)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/usages/{symbol}", response_model=UsageResponse)
async def get_usages(
    symbol: str,
    repo_url: Optional[str] = None,
    branch: Optional[str] = None,
    limit: int = 50,
):
    """
    Look up all usages of a symbol in the indexed codebase.

    This endpoint helps assess the impact of changes by finding all locations where
    a symbol is called, imported, or referenced.

    Args:
        symbol: The symbol name to look up (e.g., 'MyClass', 'handleRequest')
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search
        limit: Maximum number of results to return (default: 50)

    Returns:
        UsageResponse with all locations where the symbol is used
    """
    try:
        usages: list[UsageLocation] = []

        # First, find all chunks where this symbol is defined
        # We need the chunk IDs to query the relationships table
        definition_where = ["symbol_names @> ARRAY[%s]::text[]"]
        definition_params: list = [symbol]

        repo_id = None
        if repo_url:
            repo_id = generate_repo_id(repo_url)
            definition_where.append("repo_id = %s")
            definition_params.append(repo_id)

        if branch:
            definition_where.append("branch = %s")
            definition_params.append(branch)

        definition_clause = " AND ".join(definition_where)

        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                # Find chunk IDs where the symbol is defined
                cur.execute(
                    f"""
                    SELECT id FROM chunks
                    WHERE {definition_clause}
                    """,
                    tuple(definition_params)
                )

                target_chunk_ids = [row[0] for row in cur.fetchall()]

                if not target_chunk_ids:
                    # No definitions found, return empty result
                    return UsageResponse(symbol=symbol, usages=[], total_count=0)

                # Query relationships table for chunks that call/import/reference this symbol
                placeholders = ",".join(["%s"] * len(target_chunk_ids))

                # Build query params
                usage_params: list = target_chunk_ids.copy()

                # Add repo/branch filters for the source chunks
                usage_where = ""
                if repo_url:
                    usage_where += " AND c.repo_id = %s"
                    usage_params.append(repo_id)
                if branch:
                    usage_where += " AND c.branch = %s"
                    usage_params.append(branch)

                usage_params.append(limit)

                cur.execute(
                    f"""
                    SELECT DISTINCT c.file_path, c.line_start, c.line_end, c.content,
                           c.chunk_type, r.relationship_type, r.metadata
                    FROM chunks c
                    JOIN relationships r ON r.source_chunk_id = c.id
                    WHERE r.target_chunk_id IN ({placeholders})
                      AND r.relationship_type IN ('calls', 'imports', 'references')
                      {usage_where}
                    ORDER BY c.file_path, c.line_start
                    LIMIT %s
                    """,
                    tuple(usage_params)
                )

                for row in cur.fetchall():
                    metadata = row[6] if row[6] else {}
                    # Check for dynamic import indicators in metadata
                    is_dynamic = metadata.get('is_dynamic', False) or \
                                 metadata.get('is_lazy', False) or \
                                 'dynamic' in str(metadata).lower()

                    usages.append(UsageLocation(
                        file_path=row[0],
                        line_start=row[1],
                        line_end=row[2],
                        content=row[3],
                        chunk_type=row[4],
                        usage_type=row[5],
                        is_dynamic=is_dynamic,
                    ))

        return UsageResponse(
            symbol=symbol,
            usages=usages,
            total_count=len(usages),
        )

    except Exception as e:
        # If tables don't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return UsageResponse(symbol=symbol, usages=[], total_count=0)
        raise HTTPException(status_code=500, detail=str(e))


# Import Chain Tracking Endpoints

@app.get("/import-tree/{file_path:path}", response_model=ImportTreeResponse)
async def get_import_tree(
    file_path: str,
    repo_url: Optional[str] = None,
    branch: Optional[str] = None,
):
    """
    Get the 2-level import tree for a file.

    Returns:
    - What the file directly imports (level 1)
    - What imports the file directly (level 1)
    - What the direct imports import (level 2)
    - What imports the direct importers (level 2)

    This helps understand how changes to a file propagate through the codebase.

    Args:
        file_path: The file path to get the import tree for
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search (defaults to 'main')
    """
    effective_branch = branch or "main"

    try:
        if not repo_url:
            raise HTTPException(status_code=400, detail="repo_url is required")

        repo_id = generate_repo_id(repo_url)

        with get_connection_pool().connection() as conn:
            builder = ImportGraphBuilder(conn, repo_id, effective_branch)
            tree = builder.get_import_tree(file_path)

            return ImportTreeResponse(
                target_file=tree.target_file,
                direct_imports=tree.direct_imports,
                direct_importers=tree.direct_importers,
                indirect_imports=tree.indirect_imports,
                indirect_importers=tree.indirect_importers,
            )

    except HTTPException:
        raise
    except Exception as e:
        # If table doesn't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return ImportTreeResponse(
                target_file=file_path,
                direct_imports=[],
                direct_importers=[],
                indirect_imports=[],
                indirect_importers=[],
            )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/circular-dependencies", response_model=CircularDependenciesResponse)
async def get_circular_dependencies(
    repo_url: str,
    branch: Optional[str] = None,
    max_cycle_length: int = 10,
):
    """
    Detect circular dependencies in the import graph.

    Circular dependencies can cause issues with:
    - Module initialization order
    - Code complexity and maintainability
    - Bundle size (in JavaScript/TypeScript)

    Args:
        repo_url: Repository URL to analyze
        branch: Optional branch (defaults to 'main')
        max_cycle_length: Maximum cycle length to detect (default: 10)

    Returns:
        List of circular dependency chains found
    """
    effective_branch = branch or "main"

    try:
        repo_id = generate_repo_id(repo_url)

        with get_connection_pool().connection() as conn:
            builder = ImportGraphBuilder(conn, repo_id, effective_branch)
            cycles = builder.detect_circular_dependencies(max_cycle_length)

            return CircularDependenciesResponse(
                repo_url=repo_url,
                branch=effective_branch,
                circular_dependencies=[
                    CircularDependencyInfo(
                        cycle=c.cycle,
                        cycle_type=c.cycle_type,
                    )
                    for c in cycles
                ],
                total_count=len(cycles),
            )

    except Exception as e:
        # If table doesn't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return CircularDependenciesResponse(
                repo_url=repo_url,
                branch=effective_branch,
                circular_dependencies=[],
                total_count=0,
            )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/hub-files", response_model=HubFilesResponse)
async def get_hub_files(
    repo_url: str,
    branch: Optional[str] = None,
    threshold: int = 10,
    limit: int = 50,
):
    """
    Find 'hub' files that are imported by many other files.

    Hub files are high-impact files where changes could affect many dependents.
    They may warrant extra scrutiny during code review.

    Args:
        repo_url: Repository URL to analyze
        branch: Optional branch (defaults to 'main')
        threshold: Minimum number of importers to be considered a hub (default: 10)
        limit: Maximum number of hub files to return (default: 50)

    Returns:
        List of hub files with their import counts and sample importers
    """
    effective_branch = branch or "main"

    try:
        repo_id = generate_repo_id(repo_url)

        with get_connection_pool().connection() as conn:
            builder = ImportGraphBuilder(conn, repo_id, effective_branch)
            hubs = builder.find_hub_files(threshold=threshold, limit=limit)

            return HubFilesResponse(
                repo_url=repo_url,
                branch=effective_branch,
                hub_files=[
                    HubFileInfo(
                        file_path=h.file_path,
                        import_count=h.import_count,
                        importers=h.importers,
                    )
                    for h in hubs
                ],
                total_count=len(hubs),
                threshold=threshold,
            )

    except Exception as e:
        # If table doesn't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return HubFilesResponse(
                repo_url=repo_url,
                branch=effective_branch,
                hub_files=[],
                total_count=0,
                threshold=threshold,
            )
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
