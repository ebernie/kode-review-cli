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
from bm25 import normalize_identifier, build_tsquery, calculate_exact_match_boost
from hybrid import (
    HybridSearchConfig,
    HybridMatch,
    combine_results,
    extract_quoted_phrases,
    build_exact_phrase_query,
    DEFAULT_VECTOR_WEIGHT,
    DEFAULT_KEYWORD_WEIGHT,
)


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


class KeywordSearchRequest(BaseModel):
    """Request for BM25 keyword search."""
    query: str
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    limit: int = 10
    exact_match_boost: float = 3.0  # Multiplier for exact function/class name matches


class KeywordMatch(BaseModel):
    """A code chunk matched by keyword search."""
    file_path: str
    content: str
    line_start: int
    line_end: int
    chunk_type: Optional[str] = None
    symbol_names: list[str] = []
    bm25_score: float
    exact_match_boost: float
    final_score: float
    repo_url: Optional[str] = None
    branch: Optional[str] = None


class KeywordSearchResponse(BaseModel):
    """Response from a keyword search request."""
    query: str
    normalized_query: str  # Shows how the query was processed
    matches: list[KeywordMatch]
    total_count: int


class HybridSearchRequest(BaseModel):
    """Request for hybrid search combining vector and keyword."""
    query: str
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    limit: int = 10
    vector_weight: float = DEFAULT_VECTOR_WEIGHT  # Weight for vector search (default: 0.6)
    keyword_weight: float = DEFAULT_KEYWORD_WEIGHT  # Weight for keyword search (default: 0.4)
    exact_match_boost: float = 3.0  # Multiplier for exact symbol matches in keyword search


class HybridMatchResponse(BaseModel):
    """A code chunk from hybrid search with combined scoring."""
    file_path: str
    content: str
    line_start: int
    line_end: int
    chunk_type: Optional[str] = None
    symbol_names: list[str] = []
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    # Scoring breakdown
    vector_score: float  # Original cosine similarity (0-1)
    vector_rank: Optional[int] = None  # Rank in vector results (1-indexed)
    keyword_score: float  # BM25 score with exact match boost
    keyword_rank: Optional[int] = None  # Rank in keyword results (1-indexed)
    rrf_score: float  # Combined RRF score
    sources: list[str]  # Which searches contributed: ['vector', 'keyword']


class HybridSearchResponse(BaseModel):
    """Response from a hybrid search request."""
    query: str
    quoted_phrases: list[str]  # Phrases extracted for exact matching
    matches: list[HybridMatchResponse]
    total_count: int
    vector_weight: float  # Actual weight used
    keyword_weight: float  # Actual weight used
    fallback_used: bool  # True if fell back to pure vector search


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


# Call Graph Query Models

class CallGraphNode(BaseModel):
    """A node in the call graph representing a function/method."""
    id: str  # Chunk ID
    name: str  # Function/method name
    file_path: str
    line_start: int
    line_end: int
    depth: int  # Distance from the queried function (0 = the function itself)


class CallGraphEdge(BaseModel):
    """An edge in the call graph representing a call relationship."""
    source_id: str  # Caller chunk ID
    target_id: str  # Callee chunk ID
    callee_name: str  # Name of the called function
    line_number: Optional[int] = None  # Line where the call occurs
    receiver: Optional[str] = None  # Object receiver for method calls


class CallGraphResponse(BaseModel):
    """Response from a call graph query."""
    function: str
    direction: str  # 'callers', 'callees', or 'both'
    depth: int
    nodes: list[CallGraphNode]
    edges: list[CallGraphEdge]
    total_nodes: int
    total_edges: int


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


@app.post("/keyword-search", response_model=KeywordSearchResponse)
async def keyword_search(request: KeywordSearchRequest):
    """
    Search the index using BM25 keyword matching.

    This endpoint provides keyword-based search using PostgreSQL full-text search
    with BM25-style ranking. It complements vector similarity search by excelling at:
    - Exact identifier matches (function names, class names, variables)
    - Technical terms that embedding models may not capture well
    - Rare but important keywords in code

    Features:
    - Handles camelCase and snake_case variations automatically
    - Boosts exact function/class name matches by the specified multiplier (default: 3x)
    - Uses PostgreSQL ts_rank_cd for document ranking

    Args:
        query: Search query (identifier or keywords)
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search
        limit: Maximum number of results (default: 10)
        exact_match_boost: Multiplier for exact symbol matches (default: 3.0)

    Returns:
        KeywordSearchResponse with matched chunks and their scores
    """
    try:
        # Build the normalized query for full-text search
        normalized_query = build_tsquery(request.query)

        # Build WHERE clause
        where_conditions = ["content_tsv @@ query"]
        where_params: list = []

        if request.repo_url:
            repo_id = generate_repo_id(request.repo_url)
            where_conditions.append("repo_id = %s")
            where_params.append(repo_id)

        if request.branch:
            where_conditions.append("branch = %s")
            where_params.append(request.branch)

        where_clause = " AND ".join(where_conditions)

        # Execute keyword search with BM25-style ranking
        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                # Build the query with ts_rank_cd for BM25-style scoring
                # Normalization option 1 divides rank by 1 + log(doc length)
                query_sql = f"""
                    WITH query AS (
                        SELECT to_tsquery('simple', %s) AS q
                    )
                    SELECT
                        c.id,
                        c.file_path,
                        c.content,
                        c.line_start,
                        c.line_end,
                        c.chunk_type,
                        c.symbol_names,
                        c.repo_url,
                        c.branch,
                        ts_rank_cd(c.content_tsv, query.q, 1) AS bm25_score
                    FROM chunks c, query
                    WHERE c.content_tsv @@ query.q
                      {"AND " + " AND ".join(where_conditions[1:]) if len(where_conditions) > 1 else ""}
                    ORDER BY bm25_score DESC
                    LIMIT %s
                """

                params = [normalized_query] + where_params + [request.limit * 2]  # Fetch extra for re-ranking
                cur.execute(query_sql, tuple(params))

                matches = []
                for row in cur.fetchall():
                    symbol_names = row[6] or []
                    bm25_score = float(row[9]) if row[9] else 0.0

                    # Calculate exact match boost
                    exact_boost = calculate_exact_match_boost(
                        request.query,
                        symbol_names,
                        request.exact_match_boost
                    )

                    final_score = bm25_score * exact_boost

                    matches.append({
                        "file_path": row[1],
                        "content": row[2],
                        "line_start": row[3],
                        "line_end": row[4],
                        "chunk_type": row[5],
                        "symbol_names": symbol_names,
                        "repo_url": row[7],
                        "branch": row[8],
                        "bm25_score": bm25_score,
                        "exact_match_boost": exact_boost,
                        "final_score": final_score,
                    })

                # Sort by final score and limit
                matches.sort(key=lambda x: x["final_score"], reverse=True)
                matches = matches[:request.limit]

                return KeywordSearchResponse(
                    query=request.query,
                    normalized_query=normalized_query,
                    matches=[KeywordMatch(**m) for m in matches],
                    total_count=len(matches),
                )

    except Exception as e:
        # If full-text search column doesn't exist, return helpful error
        if "content_tsv" in str(e).lower() or "does not exist" in str(e).lower():
            raise HTTPException(
                status_code=500,
                detail="Full-text search index not available. Please re-run schema migration."
            )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/hybrid-search", response_model=HybridSearchResponse)
async def hybrid_search(request: HybridSearchRequest):
    """
    Search the index using hybrid vector + keyword search with Reciprocal Rank Fusion.

    This endpoint combines the strengths of both search methods:
    - Vector search: Semantic understanding, conceptual similarity
    - Keyword search: Exact identifier matches, technical terms

    The results are combined using Reciprocal Rank Fusion (RRF), which:
    - Ranks each result by position in both search results
    - Applies configurable weights (default: 60% vector, 40% keyword)
    - Returns a unified, deduplicated result set

    Features:
    - Quoted phrases (e.g., "getUserById") trigger exact matching
    - Automatic fallback to pure vector search if keyword returns no results
    - Handles camelCase and snake_case variations in keyword search

    Args:
        query: Search query (may contain quoted phrases for exact matching)
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search
        limit: Maximum number of results (default: 10)
        vector_weight: Weight for vector similarity (default: 0.6)
        keyword_weight: Weight for keyword matching (default: 0.4)
        exact_match_boost: Multiplier for exact symbol matches in keyword search (default: 3.0)

    Returns:
        HybridSearchResponse with combined results and scoring breakdown
    """
    try:
        # Extract quoted phrases for exact matching
        quoted_phrases, remaining_query = extract_quoted_phrases(request.query)

        # Use the full query for vector search, but note quoted phrases
        vector_query = request.query.replace('"', '').replace("'", "")

        # Build keyword query - prioritize quoted phrases for exact matching
        if quoted_phrases:
            # For quoted phrases, we want exact phrase matching
            keyword_query = ' '.join(quoted_phrases)
        else:
            keyword_query = request.query

        # Configure hybrid search
        config = HybridSearchConfig(
            vector_weight=request.vector_weight,
            keyword_weight=request.keyword_weight,
        )

        # Build WHERE clause for filtering
        repo_id = None
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
            where_clause = " AND ".join(where_conditions)

        vector_results: list[dict] = []
        keyword_results: list[dict] = []
        fallback_used = False

        with get_connection_pool().connection() as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                # Step 1: Vector similarity search
                query_embedding = compute_embedding(vector_query)

                # Build vector search SQL
                vector_params: list = [query_embedding]
                vector_where = ""
                if where_conditions:
                    vector_where = "WHERE " + where_clause
                    vector_params.extend(where_params)
                vector_params.extend([query_embedding, request.limit * 2])

                cur.execute(
                    f"""
                    SELECT c.id, c.file_path, c.content, c.line_start, c.line_end,
                           c.chunk_type, c.symbol_names, c.repo_url, c.branch,
                           1 - (embedding <=> %s::vector) AS score
                    FROM chunks c
                    {vector_where}
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                    """,
                    tuple(vector_params)
                )

                for row in cur.fetchall():
                    vector_results.append({
                        "id": str(row[0]),
                        "file_path": row[1],
                        "content": row[2],
                        "line_start": row[3],
                        "line_end": row[4],
                        "chunk_type": row[5],
                        "symbol_names": row[6] or [],
                        "repo_url": row[7],
                        "branch": row[8],
                        "score": float(row[9]) if row[9] else 0.0,
                    })

                # Step 2: BM25 keyword search
                try:
                    normalized_query = build_tsquery(keyword_query)

                    keyword_where_conditions = ["content_tsv @@ query"]
                    if repo_id:
                        keyword_where_conditions.append("c.repo_id = %s")
                    if request.branch:
                        keyword_where_conditions.append("c.branch = %s")

                    keyword_sql = f"""
                        WITH query AS (
                            SELECT to_tsquery('simple', %s) AS q
                        )
                        SELECT
                            c.id,
                            c.file_path,
                            c.content,
                            c.line_start,
                            c.line_end,
                            c.chunk_type,
                            c.symbol_names,
                            c.repo_url,
                            c.branch,
                            ts_rank_cd(c.content_tsv, query.q, 1) AS bm25_score
                        FROM chunks c, query
                        WHERE c.content_tsv @@ query.q
                          {"AND " + " AND ".join(keyword_where_conditions[1:]) if len(keyword_where_conditions) > 1 else ""}
                        ORDER BY bm25_score DESC
                        LIMIT %s
                    """

                    keyword_params = [normalized_query] + where_params + [request.limit * 2]
                    cur.execute(keyword_sql, tuple(keyword_params))

                    for row in cur.fetchall():
                        symbol_names = row[6] or []
                        bm25_score = float(row[9]) if row[9] else 0.0

                        # Calculate exact match boost
                        exact_boost = calculate_exact_match_boost(
                            request.query,
                            symbol_names,
                            request.exact_match_boost
                        )

                        keyword_results.append({
                            "id": str(row[0]),
                            "file_path": row[1],
                            "content": row[2],
                            "line_start": row[3],
                            "line_end": row[4],
                            "chunk_type": row[5],
                            "symbol_names": symbol_names,
                            "repo_url": row[7],
                            "branch": row[8],
                            "bm25_score": bm25_score,
                            "exact_match_boost": exact_boost,
                            "final_score": bm25_score * exact_boost,
                        })

                except Exception:
                    # Keyword search failed (e.g., invalid query), continue with vector only
                    pass

        # Step 3: Combine results using RRF
        if not keyword_results and config.fallback_to_vector:
            # Fallback: use pure vector results
            fallback_used = True
            combined_matches = []
            for rank, result in enumerate(vector_results[:request.limit], start=1):
                combined_matches.append(HybridMatch(
                    chunk_id=result["id"],
                    file_path=result["file_path"],
                    content=result["content"],
                    line_start=result["line_start"],
                    line_end=result["line_end"],
                    chunk_type=result["chunk_type"],
                    symbol_names=result["symbol_names"],
                    repo_url=result["repo_url"],
                    branch=result["branch"],
                    vector_score=result["score"],
                    vector_rank=rank,
                    keyword_score=0.0,
                    keyword_rank=None,
                    rrf_score=result["score"],  # Use vector score directly
                    sources=["vector"],
                ))
        else:
            # Normal: combine using RRF
            combined_matches = combine_results(
                vector_results,
                keyword_results,
                config,
                request.limit
            )

        # Build response
        return HybridSearchResponse(
            query=request.query,
            quoted_phrases=quoted_phrases,
            matches=[
                HybridMatchResponse(
                    file_path=m.file_path,
                    content=m.content,
                    line_start=m.line_start,
                    line_end=m.line_end,
                    chunk_type=m.chunk_type,
                    symbol_names=m.symbol_names,
                    repo_url=m.repo_url,
                    branch=m.branch,
                    vector_score=m.vector_score,
                    vector_rank=m.vector_rank,
                    keyword_score=m.keyword_score,
                    keyword_rank=m.keyword_rank,
                    rrf_score=m.rrf_score,
                    sources=m.sources,
                )
                for m in combined_matches
            ],
            total_count=len(combined_matches),
            vector_weight=config.vector_weight,
            keyword_weight=config.keyword_weight,
            fallback_used=fallback_used,
        )

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


# Call Graph Query Endpoint

@app.get("/callgraph/{function}", response_model=CallGraphResponse)
async def get_callgraph(
    function: str,
    direction: str = "both",
    depth: int = 2,
    repo_url: Optional[str] = None,
    branch: Optional[str] = None,
    limit: int = 100,
):
    """
    Query the call graph to find callers and/or callees of a function.

    This endpoint enables impact analysis by traversing the call graph to find:
    - Functions that call the specified function (callers)
    - Functions that the specified function calls (callees)
    - Or both directions

    The depth parameter controls how many levels of transitive relationships
    to include (e.g., depth=2 includes direct callers and their callers).

    Args:
        function: The function name to query (e.g., 'handleRequest', 'MyClass.method')
        direction: 'callers' (who calls this), 'callees' (what this calls), or 'both'
        depth: How many levels deep to traverse (default: 2, max: 5)
        repo_url: Optional repository URL to scope the search
        branch: Optional branch to scope the search (defaults to 'main')
        limit: Maximum number of nodes to return (default: 100)

    Returns:
        CallGraphResponse with nodes and edges representing the call graph
    """
    effective_branch = branch or "main"

    # Validate direction parameter
    if direction not in ("callers", "callees", "both"):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid direction '{direction}'. Must be 'callers', 'callees', or 'both'."
        )

    # Clamp depth to reasonable bounds
    depth = max(1, min(depth, 5))

    try:
        if not repo_url:
            raise HTTPException(status_code=400, detail="repo_url is required")

        repo_id = generate_repo_id(repo_url)

        nodes: list[CallGraphNode] = []
        edges: list[CallGraphEdge] = []
        seen_node_ids: set[str] = set()
        seen_edge_keys: set[tuple[str, str]] = set()

        with get_connection_pool().connection() as conn:
            with conn.cursor() as cur:
                # Step 1: Find chunks where the function is defined
                cur.execute(
                    """
                    SELECT id, file_path, line_start, line_end, symbol_names
                    FROM chunks
                    WHERE repo_id = %s
                      AND branch = %s
                      AND symbol_names @> ARRAY[%s]::text[]
                    """,
                    (repo_id, effective_branch, function)
                )

                root_chunks = cur.fetchall()

                if not root_chunks:
                    # Function not found in the index
                    return CallGraphResponse(
                        function=function,
                        direction=direction,
                        depth=depth,
                        nodes=[],
                        edges=[],
                        total_nodes=0,
                        total_edges=0,
                    )

                # Add root nodes (the function itself at depth 0)
                for row in root_chunks:
                    chunk_id = str(row[0])
                    if chunk_id not in seen_node_ids:
                        seen_node_ids.add(chunk_id)
                        nodes.append(CallGraphNode(
                            id=chunk_id,
                            name=function,
                            file_path=row[1],
                            line_start=row[2],
                            line_end=row[3],
                            depth=0,
                        ))

                root_chunk_ids = [str(row[0]) for row in root_chunks]

                # Step 2: BFS traversal for callers
                if direction in ("callers", "both"):
                    current_level_ids = root_chunk_ids.copy()

                    for current_depth in range(1, depth + 1):
                        if not current_level_ids or len(nodes) >= limit:
                            break

                        # Find all callers of the current level
                        placeholders = ",".join(["%s"] * len(current_level_ids))
                        cur.execute(
                            f"""
                            SELECT DISTINCT
                                r.source_chunk_id,
                                r.target_chunk_id,
                                c.file_path,
                                c.line_start,
                                c.line_end,
                                c.symbol_names,
                                r.metadata
                            FROM relationships r
                            JOIN chunks c ON c.id = r.source_chunk_id
                            WHERE r.relationship_type = 'calls'
                              AND r.target_chunk_id IN ({placeholders})
                              AND c.repo_id = %s
                              AND c.branch = %s
                            ORDER BY c.file_path, c.line_start
                            """,
                            tuple(current_level_ids) + (repo_id, effective_branch)
                        )

                        next_level_ids = []
                        for row in cur.fetchall():
                            source_id = str(row[0])
                            target_id = str(row[1])
                            metadata = row[6] if row[6] else {}

                            # Add edge if not seen
                            edge_key = (source_id, target_id)
                            if edge_key not in seen_edge_keys:
                                seen_edge_keys.add(edge_key)
                                edges.append(CallGraphEdge(
                                    source_id=source_id,
                                    target_id=target_id,
                                    callee_name=metadata.get("callee_name", function),
                                    line_number=metadata.get("line_number"),
                                    receiver=metadata.get("receiver"),
                                ))

                            # Add node if not seen
                            if source_id not in seen_node_ids and len(nodes) < limit:
                                seen_node_ids.add(source_id)
                                symbol_names = row[5] or []
                                # Use first symbol name or a generic label
                                node_name = symbol_names[0] if symbol_names else f"<chunk:{source_id[:8]}>"
                                nodes.append(CallGraphNode(
                                    id=source_id,
                                    name=node_name,
                                    file_path=row[2],
                                    line_start=row[3],
                                    line_end=row[4],
                                    depth=current_depth,
                                ))
                                next_level_ids.append(source_id)

                        current_level_ids = next_level_ids

                # Step 3: BFS traversal for callees
                if direction in ("callees", "both"):
                    current_level_ids = root_chunk_ids.copy()

                    for current_depth in range(1, depth + 1):
                        if not current_level_ids or len(nodes) >= limit:
                            break

                        # Find all callees of the current level
                        placeholders = ",".join(["%s"] * len(current_level_ids))
                        cur.execute(
                            f"""
                            SELECT DISTINCT
                                r.source_chunk_id,
                                r.target_chunk_id,
                                t.file_path,
                                t.line_start,
                                t.line_end,
                                t.symbol_names,
                                r.metadata
                            FROM relationships r
                            JOIN chunks t ON t.id = r.target_chunk_id
                            WHERE r.relationship_type = 'calls'
                              AND r.source_chunk_id IN ({placeholders})
                              AND t.repo_id = %s
                              AND t.branch = %s
                            ORDER BY t.file_path, t.line_start
                            """,
                            tuple(current_level_ids) + (repo_id, effective_branch)
                        )

                        next_level_ids = []
                        for row in cur.fetchall():
                            source_id = str(row[0])
                            target_id = str(row[1])
                            metadata = row[6] if row[6] else {}

                            # Add edge if not seen
                            edge_key = (source_id, target_id)
                            if edge_key not in seen_edge_keys:
                                seen_edge_keys.add(edge_key)
                                edges.append(CallGraphEdge(
                                    source_id=source_id,
                                    target_id=target_id,
                                    callee_name=metadata.get("callee_name", ""),
                                    line_number=metadata.get("line_number"),
                                    receiver=metadata.get("receiver"),
                                ))

                            # Add node if not seen
                            if target_id not in seen_node_ids and len(nodes) < limit:
                                seen_node_ids.add(target_id)
                                symbol_names = row[5] or []
                                # Use callee_name from metadata or first symbol
                                node_name = metadata.get("callee_name") or (
                                    symbol_names[0] if symbol_names else f"<chunk:{target_id[:8]}>"
                                )
                                nodes.append(CallGraphNode(
                                    id=target_id,
                                    name=node_name,
                                    file_path=row[2],
                                    line_start=row[3],
                                    line_end=row[4],
                                    depth=current_depth,
                                ))
                                next_level_ids.append(target_id)

                        current_level_ids = next_level_ids

        return CallGraphResponse(
            function=function,
            direction=direction,
            depth=depth,
            nodes=nodes,
            edges=edges,
            total_nodes=len(nodes),
            total_edges=len(edges),
        )

    except HTTPException:
        raise
    except Exception as e:
        # If table doesn't exist yet, return empty result
        if "does not exist" in str(e).lower():
            return CallGraphResponse(
                function=function,
                direction=direction,
                depth=depth,
                nodes=[],
                edges=[],
                total_nodes=0,
                total_edges=0,
            )
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
